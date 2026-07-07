# Devtools — 设计与未来方向

> 实现地图——输出格式、架构、动作目录、代码生成以及消费者侧：见 [implementation.md](./implementation.md)。

## 概述

Rolldown devtools 是一个基于 tracing 的系统，它会将结构化的构建期数据（模块图、chunk 图、插件 hook 调用、生成的资源）输出到磁盘，以便外部工具（例如 Vite devtools）消费这些数据，提供调试、性能分析和可视化体验。

## 未来方向

### 插件提供的元数据

消费者并不总能判断一个虚拟模块是什么，或者某个插件来自哪个包。Rolldown 允许插件同时为这两者附加描述性元数据，这样 devtools 输出就能呈现更丰富、更贴近人工编写的上下文。该元数据仅用于信息展示，不会影响打包。参见 vitejs/devtools [#171](https://github.com/vitejs/devtools/issues/171)（模块描述）和 [#172](https://github.com/vitejs/devtools/issues/172)（插件包名）。

**面向作者的契约（已在 `packages/rolldown` 中完成类型定义）：**

- **模块描述** —— 插件从 `resolveId`/`load`/`transform` 钩子返回顶层 `description`。它是 `ModuleOptions` 上一个直接的可选字段（因此也可通过 `this.getModuleInfo` 读取），并且适用于动态生成的虚拟模块。
- **插件元数据** —— 插件在插件对象上设置 `meta.packageName`、`meta.version` 和 `meta.description`（`PluginMeta`）。

这些字段都不是必需的，并且对打包没有任何影响。它们是通用的描述性元数据；tracing 层只是其中一个消费者，它会把这些信息转发给诸如 Vite devtools 之类的工具。

**发射侧（尚未接通）：** trace action 需要携带这些值，这样消费者才能真正接收到它们。

- `SessionMeta.plugins[]`（`rolldown_devtools_action` 中的 `PluginItem`）应增加 `package_name: Option<String>`、`version: Option<String>` 和 `description: Option<String>`，并在发射 session meta 时读取每个插件的 `meta` 来填充。
- 模块描述应附加在按模块输出数据的位置（例如 `HookLoadCallEnd` / `ModuleGraphReady`），从模块解析后的 `description` 中读取。

在这套管线落地之前，设置这些字段除了类型检查之外不会产生任何效果；先定义契约，是为了让插件作者和消费者能够就数据形状达成一致。

### 性能

最初的实现优先解决的是“可消费性”——把结构化数据输出到磁盘，这样外部工具就可以开始基于它进行开发。当时性能显式地不是优先级。

现在系统已经投入使用，性能成了一个大问题。在大型项目中，启用 devtools 会让构建变得非常慢。主要瓶颈如下：

- **热路径上的同步 JSON 序列化。** 每次 `trace_action!` 调用都会通过 `serde_json::to_string` 将 action 结构体序列化为 JSON，然后格式化器再把它解析回 `serde_json::Value`，用于注入上下文和写文件。这个双重序列化是在构建过程中同步执行的。
- **hook 事件中包含完整模块内容。** `HookLoadCallEnd`、`HookTransformCallStart/End` 和 `HookRenderChunkStart/End` 都包含每个模块的完整源码文本。对于大型代码库来说，这意味着每次构建都要序列化并写入数 MB 的源码。
- **用于去重的 blake3 哈希。** 每个大于 5 KB 的字符串都会被哈希，而每个大于 10 KB 的字符串都会触发一次哈希查找和 `$ref` 替换。这会带来与总源码大小成正比的 CPU 开销。
- **同步文件 I/O。** `DevtoolsFormatter::format_event` 直接通过 `std::fs::File` 写入文件，阻塞当前线程。

可行方案：

- **异步/缓冲写入。** 将文件 I/O 从构建线程移走——把事件缓存在内存中，在后台线程或构建边界处刷新。
- **延迟内容发射。** 默认不要在 hook 事件中包含完整源码。改为输出内容哈希或偏移引用；让消费者按需请求完整内容（或者把内容写到单独的 sidecar 文件中）。
- **避免双重序列化。** 直接序列化为目标输出格式，而不是先经过 `serde_json::Value` 作为中间表示。
- **分级详细程度。** 让用户选择不同的细节级别（例如仅图数据 vs. 完整 hook 跟踪），这样轻量级消费者就不会为不需要的数据付出代价。

### 存储后端

当前的存储模型——把 JSON 行追加到单个 `logs.json` 文件中——无法扩展。在大型项目中，单次构建可能产生约 3 GB 的 devtools 数据。在这个规模下：

- **消费者无法加载文件。** 将 3 GB 的 JSON 解析进内存，对于基于浏览器的 UI 甚至 Node.js 进程来说都不现实。输出这些数据的目的就是为了让工具消费，而当前格式在大规模场景下让这件事变得不可能。
- **没有随机访问。** 要查找某个模块的 transform 历史，消费者必须线性扫描整个文件。无法在不读取全部内容的情况下查询“模块 X 的所有 HookTransformCall 事件”。
- **无法增量消费。** 在 watch 模式下，文件会跨多次重建持续增长，但没有结构来区分边界。已经处理过构建 N 的消费者，没有高效方式只读取构建 N+1 的事件。

#### 基于数据库的存储

真正的数据库后端可以解决所有这些问题，并开启新的能力：

**本地嵌入式 DB（例如 SQLite）：**

- 按动作类型分表——消费者只查询自己需要的数据
- 按模块 ID、插件名、构建 ID、时间戳建立索引——无需全表扫描即可快速查找
- WAL 模式支持并发读写——消费者可以在构建运行时持续尾随事件
- 单文件部署，不需要外部进程
- 非常契合现有的 `node_modules/.rolldown/<session_id>/` 布局（一个 `.db` 文件替代多个 `.json` 文件）

**远程 DB：**

- 为 CI/CD 解锁集中式 devtools——来自 CI 流水线的构建数据流入共享存储，开发者可通过仪表盘查询
- 团队级的构建性能回归可见性
- 历史分析——比较模块图演化、插件耗时趋势、chunk 大小随时间的增长
- 可通过 `devtools: { backend: 'remote', endpoint: '...' }` 进行可选启用

#### Schema 考量

这些 action 类型已经有明确的结构（`SessionMeta`、`ModuleGraphReady`、`ChunkGraphReady` 等），很自然地可以映射到关系型表。示意如下：

```
sessions(session_id, cwd, platform, format, dir, file, created_at)
builds(build_id, session_id, started_at, ended_at)
modules(build_id, module_id, is_external)
module_imports(build_id, module_id, imported_module_id, kind, module_request)
chunks(build_id, chunk_id, name, reason, is_user_defined_entry, is_async_entry, entry_module)
chunk_imports(build_id, chunk_id, imported_chunk_id, kind)
sources(source_id, content)  -- 将大 payload/源码只存一份
hook_calls(build_id, call_id, hook_type, plugin_name, plugin_id, module_id, started_at, ended_at, input_source_id, output_source_id)
assets(build_id, filename, chunk_id, size, content_source_id)
```

将大内容与元数据分离，意味着查询插件耗时的消费者不会接触多 GB 的源码文本。对于基于数据库的设计，源代码类 payload 应该放在独立的字段/行中（例如 `sources.content`），而 action 应通过 ID（`input_source_id`、`output_source_id`、`content_source_id`）引用它们，而不是在各处内联同一份源码。这是当前 `StringRef` 去重模式的关系型等价实现，但拥有真正的查询支持。

#### 迁移路径

可以通过一个 trait 将存储后端抽象出来，让 formatter 写入 `DevtoolsWriter`，而不是直接写文件：

```rust
trait DevtoolsWriter: Send + Sync {
    fn write_action(&self, session_id: &str, build_id: &str, action: &serde_json::Value);
}
```

这样，JSON 行文件写入器可以继续作为默认方案（零新增依赖），同时可通过配置接入 SQLite 或远程后端。`@rolldown/debug` 消费者包也会获得相应的 `DevtoolsReader` 抽象。

### 按构建作用域隔离（vs. 全局激活）

当前实现使用的是进程全局的 `tracing_subscriber` 注册表，由 `DebugTracer::init()` 通过一个 `AtomicBool` 单例守卫初始化。这意味着：

- 在**一个** rolldown 配置中设置 `devtools: {}`，会导致**同一进程中所有** bundler 实例都输出 devtools 数据，即使它们自己并未选择启用。
- 无法在同一进程内对一个构建启用 devtools、对另一个构建禁用 devtools（例如一个 monorepo 工具同时运行多个 rolldown 构建）。

根本原因是 `tracing_subscriber::registry().init()` 安装的是全局 subscriber。一旦安装，进程中每个 `tracing::trace!` 事件都会流经 devtools 层。

#### `tracing` 的作用域 subscriber 机制

`tracing` crate 提供了若干作用域原语：

**`set_default` / `with_default`** —— 设置线程局部 subscriber，返回一个 `DefaultGuard`，在 drop 时恢复先前的 subscriber。**仅线程局部有效**——在多线程 tokio 运行时中不会跨 `.await` 保持。当任务在一个 await 点之后迁移到另一个 worker 线程时，它会失去这个作用域 subscriber，并回退到全局默认值。

**`.with_subscriber()`（`WithDispatch`）** —— 最有希望的原语。它会把一个 async future 包装起来，使 subscriber 在**每次 poll** 时重新安装到线程局部存储中。它是 async-safe 的：无论由哪个线程 poll 这个 future，正确的 subscriber 都会处于激活状态。

其内部实现方式是，`WithDispatch` 在每次 `poll` 之前调用 `set_default`：

```rust
// 简化自 tracing 的 instrument.rs
impl<T: Future> Future for WithDispatch<T> {
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.project();
        let _default = dispatcher::set_default(this.dispatcher); // 每次 poll 都设置 TLS
        this.inner.poll(cx)
    }
}
```

按 bundler 作用域隔离的用法大致如下：

```rust
use tracing::Instrument; // 也会带入 WithSubscriber trait

let devtools_subscriber = tracing_subscriber::registry()
    .with(DevtoolsLayer)
    .with(fmt::layer().event_format(DevtoolsFormatter));

// 每个 bundler 的顶层 future 都有自己的 subscriber
let build_future = bundle.write().with_subscriber(devtools_subscriber);
tokio::spawn(build_future);
```

**关键注意：`tokio::spawn` 不会继承。** 如果被包装的 future 内部调用了 `tokio::spawn(sub_task)`，那么子任务会回退到全局默认 subscriber。每一次内部 spawn 都必须显式包装：

```rust
// 在会 spawn 子任务的 bundler 代码内部：
let sub_task = do_work().with_current_subscriber(); // 捕获当前线程局部 subscriber
tokio::spawn(sub_task);
```

漏掉一个 `.with_current_subscriber()` 就会悄悄丢失该任务的 subscriber 上下文。这是 rolldown 的主要风险点，因为它在 scan 阶段及其他地方内部会 spawn 任务。

**在全局注册表上做按层过滤** —— 通过 `.init()` 保留一个全局 subscriber，然后为各层附加 `FilterFn`，根据 span 字段（例如 session ID）路由事件。由于 subscriber 是全局的，因此不会有传播问题；复杂度转移到了过滤逻辑和动态层管理上。

#### 对 Rolldown 的适用性

| 方案                                         | async-safe？ | `tokio::spawn` 传播？                               | 复杂度 | 适合 rolldown 吗？                                                                                      |
| -------------------------------------------- | ----------- | ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| **按 bundler future 使用 `.with_subscriber()`** | **是**      | 手动（每次 spawn 都要 `.with_current_subscriber()`） | 中等   | **最佳语义匹配**——真正的按 bundler 隔离。需要审计所有内部 `tokio::spawn` 位置 |
| 在全局注册表上做按层过滤                     | 是          | 免费（全局）                                         | 中等   | 很合适——session ID 已在 span 上下文中，无需 spawn 传播                                             |
| 每个 bundler 用 `set_default` + `current_thread` | 是          | 免费（单线程）                                       | 高     | 不现实——会改变运行时模型                                                                                 |
| 在 `trace_action!` 中进行 session-aware 检查  | 是          | N/A（emit 前）                                       | 低     | 互补方案——无论上面选择哪种方式，禁用的 session 都能零成本跳过序列化            |

**`.with_subscriber()` 是实现真正按构建隔离的最强候选方案**——它能为每个 bundler 实例提供独立的 subscriber，并实现清晰隔离。`tokio::spawn` 的传播缺口是主要采用成本：它要求审计所有内部 spawn 位置，并用 `.with_current_subscriber()` 包裹。不过，这是一项一次性的审计，同时也能让代码库中的 subscriber 作用域正确性变得显式。未来可以通过 lint 或包装辅助函数（例如自动包装的 `devtools_spawn(future)`）来强制执行这一点。

无论最终选择哪种 subscriber 作用域方案，`trace_action!` 中都应该增加一个**发射前检查**作为互补优化，这样被禁用的 session 可以完全跳过序列化。

## 未解决的问题

- **输出位置：** 目前硬编码为相对于真实 `process.cwd()` 的 `node_modules/.rolldown/`，而不是 `InputOptions.cwd`。这意味着如果 cwd 不同，devtools 输出可能不会落在预期位置。
- **增量/监听模式：** devtools 系统同时适用于 `ClassicBundler`（一次性）和核心 `Bundler`（增量），但在同一会话中的连续构建会追加到同一个 `logs.json`。目前还没有明确的“重建边界”动作。
- **开发引擎集成：** `BindingDevEngine` 会创建一个 session，但使用的是 `Session::dummy()` —— devtools 目前还没有接入 dev/HMR 引擎。

## 相关内容

- [implementation.md](./implementation.md) — devtools 实现映射
- [rust-classic-bundler](../rust-classic-bundler/implementation.md) — ClassicBundler 设计，引用了 devtools 的 session/tracer 字段
- [rust-bundler](../rust-bundler/implementation.md) — 核心 Bundler 设计，引用了 session 字段
