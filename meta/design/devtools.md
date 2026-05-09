# Devtools

## 概述

Rolldown devtools 是一个基于追踪的系统，它会将结构化的构建期数据（模块图、chunk 图、插件钩子调用、生成的资源）输出到磁盘，以便外部工具（例如 Vite devtools）消费这些数据，从而提供调试、性能分析和可视化体验。

## 用户面向 API

```ts
import { rolldown } from 'rolldown';

const bundle = await rolldown({
  input: 'src/index.js',
  devtools: {
    sessionId?: string,  // 可选覆盖；若省略则自动生成
  },
});
await bundle.generate();
```

`devtools` 选项是 `@experimental`。设置 `devtools: {}` 就足以启用追踪。该选项通过绑定层传递为 `BindingDevtoolsOptions`，并在 Rust 端规范化为 `DevtoolsOptions { session_id: Option<String> }`。

CLI 等价项：`--devtools.session-id <id>`。

## 输出

启用 devtools 后，rolldown 会将 JSON 行文件写入：

```
<CWD>/node_modules/.rolldown/<session_id>/
  meta.json    # SessionMeta 动作（每次构建一个 JSON 对象；在 watch/rebuild 中会追加）
  logs.json    # 所有其他动作，每行一个 JSON 对象
```

每一行都是一个自包含的 JSON 对象，并带有一个 `action` 判别字段。动作事件还会携带 `timestamp`、`session_id` 和 `build_id` 字段。`StringRef` 条目只包含 `action`、`id` 和 `content`（没有 timestamp）。消费者读取文件并按换行符拆分。

### 关闭后读取契约

只有在 `await bundle.close()` 完成之后，才能保证 `meta.json` 和 `logs.json` 已经完整且可读。内部上，事件会通过通道流向后台写线程，并通过 `BufWriter` 缓冲，因此在 `generate()`/`write()` 之后立即读取文件可能会得到空内容或被截断的内容。`bundle.close()` 会发送带有 ack 通道的 `CloseSession` 命令，并等待写线程的信号，从而建立消费者所依赖的 happens-before 边。

### 大字符串去重

大于 5 KB 的顶层字符串字段会按 blake3 哈希进行缓存。一个 `StringRef` 记录会在引用它的动作之前发出：

```json
{ "action": "StringRef", "id": "<blake3-hash>", "content": "<完整字符串>" }
```

大于 10 KB 的顶层字符串字段还会在动作本身中被替换为 `$ref:<hash>` 占位符，指回 `StringRef` 条目。这样可以让动作记录保持紧凑，同时为需要完整内容的消费者保留全部信息。注意：嵌套字符串（例如 `AssetsReady.assets[].content`）不会被 ref——只考虑顶层字段。

## 架构

### Crate 布局

| Crate                      | 作用                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `rolldown_devtools`        | 核心追踪机制：`DebugTracer`、`Session`、格式化器、层        |
| `rolldown_devtools_action` | 动作类型定义（带有 `ts-rs` 用于 TS 代码生成的 Rust 结构体） |
| `@rolldown/debug`          | TypeScript 包：重新导出生成的类型 + `parseToEvents()` 工具  |

### 关键类型

- **`DebugTracer`** — 使用 devtools 专用的层和格式化器初始化一个 `tracing_subscriber` registry。通过 `AtomicBool` 进行单例初始化。析构时，会向写线程发送一个尽力而为的（无 ack）`CloseSession` 作为清理兜底；权威的刷新路径是 `ClassicBundler::close()`，它会使用 `rolldown_devtools::flush_session(session_id)` 并在返回前等待 ack。
- **`Session`** — 保存会话 `id`（例如 `sid_0_1710000000000`）和一个父级 `tracing::Span`。所有构建 span 都是会话 span 的子 span。禁用 devtools 时会使用 `Session::dummy()`（无操作 span）。
- **`DevtoolsLayer`** — 一个 `tracing_subscriber::Layer`，用于从 span 中提取以 `CONTEXT_*` 为前缀的字段，并将它们作为 `ContextData` 存入 span extensions。
- **`DevtoolsFormatter`** — 一个 `FormatEvent` 实现，它将带有 `devtoolsAction` 标签的事件序列化为 JSON 行，注入上下文变量，并写入相应文件。

### 追踪机制

该系统基于 `tracing` crate 构建。核心思想是：**span 隐式携带上下文，事件显式携带数据**。

```
<SessionSpan CONTEXT_session_id="sid_0_...">
  <BuildSpan CONTEXT_build_id="bid_0_count_0" CONTEXT_hook_resolve_id_trigger="automatic">
    {trace_action!(BuildStart { action: "BuildStart" })}
    <HookResolveIdCallSpan CONTEXT_call_id="uuid-v4">
      {trace_action!(HookResolveIdCallStart { ..., trigger: "${hook_resolve_id_trigger}", call_id: "${call_id}" })}
      ...
      {trace_action!(HookResolveIdCallEnd { ... })}
    </HookResolveIdCallSpan>
    {trace_action!(ModuleGraphReady { ... })}
    {trace_action!(ChunkGraphReady { ... })}
    {trace_action!(BuildEnd { action: "BuildEnd" })}
  </BuildSpan>
</SessionSpan>
```

**为什么使用 span？**

- 无需手动传递即可注入上下文——`session_id`、`build_id`、`call_id` 都会在发出时通过 `${variable_name}` 占位符替换，从祖先 span 中解析出来。
- 自动异步上下文跟踪——span 会跨越 `.await` 边界继续传递。

**事件过滤：** `rolldown_devtools` 和 `rolldown_tracing` 都会根据是否存在 `devtoolsAction` 字段来过滤事件。devtools 层只处理带有该字段的事件；普通 tracing 层（chrome/console）会把它们过滤掉，因此 devtools 事件不会污染标准 trace 输出。

### ID 生成

- **Session ID：** `sid_{atomic_seed}_{unix_ms}` — 对每个 `ClassicBundler` / `Bundler` 实例都是唯一的。
- **Build ID：** `bid_{atomic_seed}_count_{build_count}` — 对会话中的每个 `Bundle` 都是唯一的。`build_count` 在同一个 `BundleFactory` 中每次构建都会递增。

### 生命周期集成

**`ClassicBundler`**（绑定层，兼容 Rollup 的 API）：

1. `new()` — 生成 `session_id`，创建 dummy session
2. `enable_debug_tracing_if_needed()` — 在第一次带有 `devtools` 选项的构建中，初始化 `DebugTracer` 并创建真实的 session span
3. 在每次 `create_bundle()` 调用时，将 `Session` 传递给 `BundleFactory`

**`BundleFactory`**（核心）：

1. 存储 session，通过 `generate_unique_bundle_span()` 生成唯一的 build span
2. 每个 span 都是 `session.span` 的子 span，并带有 `CONTEXT_build_id` 和 `CONTEXT_hook_resolve_id_trigger` 字段

**`Bundle`**（按构建）：

1. `trace_action_session_meta()` — 发出包含 inputs、plugins、cwd、platform、format、output dir/file 的 `SessionMeta`
2. `BuildStart` / `BuildEnd` — 在外层 `write()`/`generate()` 调用前后以及 `scan_modules()` 内部都会发出，因此消费者每次构建可能会看到嵌套的成对事件
3. `trace_action_module_graph_ready()` — 在扫描阶段结束后发出，包含所有模块及其导入关系
4. `trace_action_chunks_infos()` — 在 generate 阶段构建 chunk 图后发出

**`PluginDriver`**（插件钩子）：

- `resolve_id` — 在带有 `CONTEXT_call_id` 的 `HookResolveIdCall` span 中包裹 `HookResolveIdCallStart` / `HookResolveIdCallEnd`
- `load` — 同样包裹 `HookLoadCallStart` / `HookLoadCallEnd`
- `transform` — `HookTransformCallStart` / `HookTransformCallEnd`
- `render_chunk` — `HookRenderChunkStart` / `HookRenderChunkEnd`

每一对钩子调用都会通过其外层 span 获得一个唯一的 `call_id`（UUID v4）。

## 动作目录

| 动作                         | 发出时机                              | 关键字段                                                                                                    |
| ---------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `SessionMeta`                | 构建开始时（写入 `meta.json`）        | inputs、plugins、cwd、platform、format、dir、file                                                           |
| `BuildStart`                 | 扫描阶段之前 + 围绕 write/generate    | —                                                                                                           |
| `HookResolveIdCallStart/End` | 每个插件每次 resolve 调用             | module_request、importer、plugin_name、plugin_id、trigger、call_id、resolved_id                             |
| `HookLoadCallStart/End`      | 每个插件每次 load 调用                | module_id、plugin_name、plugin_id、call_id、content                                                         |
| `HookTransformCallStart/End` | 每个插件每次 transform 调用           | module_id、content、plugin_name、plugin_id、call_id                                                         |
| `ModuleGraphReady`           | 扫描 + 规范化之后                     | modules[]{id, is_external, imports[]{module_id, kind, module_request}, importers[]}                         |
| `BuildEnd`                   | 扫描阶段之后 + 在 write/generate 之后 | —                                                                                                           |
| `ChunkGraphReady`            | chunk 图构建完成后                    | chunks[]{chunk_id, name, reason, modules[], imports[], is_user_defined_entry, is_async_entry, entry_module} |
| `HookRenderChunkStart/End`   | 每个插件每次 renderChunk 调用         | chunk_id、plugin_name、plugin_id、call_id、content                                                          |
| `AssetsReady`                | 最终资源生成之后                      | assets[]{chunk_id, content, size, filename}                                                                 |
| `StringRef`                  | 任何带有大字符串的动作之前            | id（blake3 hash）、content                                                                                  |

除 `StringRef` 之外，所有动作都会携带注入的 `session_id`、`build_id` 和 `timestamp` 字段。`StringRef` 条目只包含 `action`、`id` 和 `content`。

## TypeScript 代码生成

动作类型定义为带有 `#[derive(ts_rs::TS, serde::Serialize)]` 的 Rust 结构体。代码生成流水线如下：

1. `cargo test -p rolldown_devtools_action export_bindings` — ts-rs 在 `crates/rolldown_devtools_action/bindings/` 中生成 `.ts` 文件
2. `scripts/src/gen-debug-action-types.ts` — 复制到 `packages/debug/src/generated/`，创建 barrel `index.ts`
3. `packages/debug` 以 `@rolldown/debug` 发布 — 导出所有动作类型以及 `parseToEvents()` / `parseToEvent()` 工具

运行：`pnpm --filter @rolldown/debug run gen-action-types`

## 静态数据管理

文件句柄和哈希缓存存储在进程全局的 `LazyLock<DashMap>` 静态变量中：

- `OPENED_FILE_HANDLES` — 每个输出文件路径对应一个文件句柄，防止重复写入
- `OPENED_FILES_BY_SESSION` — 跟踪哪些文件属于哪个会话（用于清理）
- `EXIST_HASH_BY_SESSION` — 跟踪每个会话中已经发出的 `StringRef` 哈希（用于去重）

当后台写入线程处理 `CloseSession` 命令时，这些数据会被清理——该命令要么通过 `ClassicBundler::close()` 中同步调用 `flush_session(...)` 发送（基于 ack，先于 `close()` 返回发生），要么通过 `DebugTracer::drop` 尽力发送。

## 消费端

`@rolldown/debug` 包提供了：

```ts
import { parseToEvents, type Event, type StringRef } from '@rolldown/debug';

const data = fs.readFileSync('node_modules/.rolldown/<sid>/logs.json', 'utf8');
const events = parseToEvents(data.trim());
// 事件：Array<StringRef | { timestamp, session_id, action: "BuildStart" | "ModuleGraphReady" | ... }>
```

消费者（如 Vite 开发者工具）读取 JSON 行文件，将 `$ref:<hash>` 占位符解析为 `StringRef` 条目，并重建完整的构建时间线。

## 未来方向

### 性能

最初的实现优先考虑的是打通可用性——把结构化数据落盘，这样外部工具就可以基于它开始构建能力。当时性能并不是明确的优先事项。

现在系统已经在使用中，性能成了一个重大问题。在大型项目中，启用开发者工具会让构建变得非常慢。主要瓶颈如下：

- **热路径上的同步 JSON 序列化。** 每次 `trace_action!` 调用都会通过 `serde_json::to_string` 将动作结构体序列化为 JSON，然后格式化器再把它解析回 `serde_json::Value`，用于注入上下文和写入文件。这个双重序列化在构建期间是同步发生的。
- **hook 事件中包含完整模块内容。** `HookLoadCallEnd`、`HookTransformCallStart/End` 和 `HookRenderChunkStart/End` 都包含每个模块的完整源文本。对于大型代码库，这意味着每次构建都要序列化并写入数 MB 的源代码。
- **用于去重的 blake3 哈希。** 每个大于 5 KB 的字符串都会被哈希，而每个大于 10 KB 的字符串都会触发一次哈希查找和 `$ref` 替换。这会带来与总源代码大小成正比的 CPU 开销。
- **同步文件 I/O。** `DevtoolsFormatter::format_event` 通过 `std::fs::File` 直接写入文件，会阻塞线程。

可行方案：

- **异步/缓冲写入。** 将文件 I/O 从构建线程移走——在内存中缓冲事件，并在后台线程或构建边界处刷新。
- **延迟内容发出。** 默认不要在 hook 事件中包含完整源代码。改为发出内容哈希或偏移引用；让消费者按需请求完整内容（或者把内容写入单独的 sidecar 文件）。
- **避免双重序列化。** 直接序列化为输出格式，而不是把 `serde_json::Value` 作为中间层。
- **分级详细度。** 让用户选择详细程度（例如仅图结构 vs. 完整 hook 跟踪），这样轻量消费者就不必为不需要的数据付费。

### 存储后端

当前的存储模型——把 JSON 行追加到单个 `logs.json` 文件——无法扩展。在大型项目中，一次构建就可能产生约 3 GB 的开发者工具数据。在这个规模下：

- **消费者无法加载文件。** 将 3 GB 的 JSON 解析到内存中，对于浏览器端 UI 甚至 Node.js 进程来说都不现实。发出数据的初衷就是让工具去消费，而当前格式在规模上做不到这一点。
- **没有随机访问。** 想找某个模块的 transform 历史，消费者必须线性扫描整个文件。无法在不读取全部内容的情况下查询“模块 X 的所有 `HookTransformCall` 事件”。
- **无法增量消费。** 在 watch 模式下，文件会跨多次重建持续增长，却没有结构来区分边界。已经处理过构建 N 的消费者，没有高效办法只读取构建 N+1 的事件。

#### 基于数据库的存储

一个真正的数据库后端可以解决所有这些问题，并解锁新的能力：

**本地嵌入式数据库（例如 SQLite）：**

- 按动作类型建立结构化表——消费者只查询自己需要的内容
- 按模块 ID、插件名、构建 ID、时间戳建索引——无需全表扫描即可快速查找
- WAL 模式支持并发读写——消费者可以在构建运行时持续尾随事件
- 单文件部署，无需外部进程
- 很适合现有的 `node_modules/.rolldown/<session_id>/` 布局（使用一个 `.db` 文件代替 `.json` 文件）

**远程数据库：**

- 为 CI/CD 解锁集中式开发者工具——来自 CI 流水线的构建数据流入共享存储，开发者可以通过仪表盘查询
- 团队范围内观察构建性能回归
- 历史分析——比较模块图演化、插件耗时趋势、chunk 大小随时间的增长
- 可以通过 `devtools: { backend: 'remote', endpoint: '...' }` 选择启用

#### 模式设计考虑

这些动作类型已经有清晰定义的结构（`SessionMeta`、`ModuleGraphReady`、`ChunkGraphReady` 等），它们很自然地映射到关系型表。一个草图如下：

```
sessions(session_id, cwd, platform, format, dir, file, created_at)
builds(build_id, session_id, started_at, ended_at)
modules(build_id, module_id, is_external)
module_imports(build_id, module_id, imported_module_id, kind, module_request)
chunks(build_id, chunk_id, name, reason, is_user_defined_entry, is_async_entry, entry_module)
chunk_imports(build_id, chunk_id, imported_chunk_id, kind)
sources(source_id, content)  -- 只存一次大型负载/源文本
hook_calls(build_id, call_id, hook_type, plugin_name, plugin_id, module_id, started_at, ended_at, input_source_id, output_source_id)
assets(build_id, filename, chunk_id, size, content_source_id)
```

将大体积内容与元数据分离后，查询插件耗时的消费者就不会碰到多 GB 的源文本。对于数据库后端设计，类似源代码的负载应该放在独立字段/行中（例如 `sources.content`），并且动作应通过 ID（`input_source_id`、`output_source_id`、`content_source_id`）引用它们，而不是把同一份源代码内联到各处。这相当于当前 `StringRef` 去重模式在关系型数据库中的对应实现，只是具备了正确的查询支持。

#### 迁移路径

可以通过一个 trait 把存储后端抽象起来，这样格式化器就会写入 `DevtoolsWriter`，而不是直接写文件：

```rust
trait DevtoolsWriter: Send + Sync {
    fn write_action(&self, session_id: &str, build_id: &str, action: &serde_json::Value);
}
```

这样 JSON 行文件写入器就可以继续作为默认实现（零新增依赖），而 SQLite 或远程后端则可以通过配置接入。`@rolldown/debug` 消费端包也会获得一个对应的 `DevtoolsReader` 抽象。

### 按构建作用域隔离（对比全局激活）

当前实现使用的是进程全局的 `tracing_subscriber` 注册表，通过 `DebugTracer::init()` 和一个 `AtomicBool` 单例守卫初始化。这意味着：

- 在**一个** rolldown 配置里设置 `devtools: {}`，会让**同一进程中的所有** bundler 实例都输出开发者工具数据，即使它们没有显式选择启用。
- 在同一进程中，无法对一个构建启用开发者工具、对另一个构建禁用它（例如一个 monorepo 工具同时运行多个 rolldown 构建）。

根本原因是 `tracing_subscriber::registry().init()` 安装的是全局 subscriber。一旦安装，进程中的每个 `tracing::trace!` 事件都会流经开发者工具层。

#### `tracing` 的作用域 subscriber 机制

`tracing` crate 提供了若干作用域原语：

**`set_default` / `with_default`** — 设置线程局部 subscriber，返回一个 `DefaultGuard`，在 drop 时恢复先前的 subscriber。**仅限线程局部**——在多线程 tokio 运行时中，`.await` 之后不会保持。任务在 await 点后迁移到其他工作线程时，会丢失作用域 subscriber，并回退到全局默认值。

**`.with_subscriber()`（`WithDispatch`）** — 最有希望的原语。它会把异步 future 包装起来，使 subscriber 在**每次 poll** 时都重新安装到线程局部存储中。这对异步是安全的：无论 future 由哪个线程 poll，正确的 subscriber 都会处于激活状态。

在底层，`WithDispatch` 通过在每次 `poll` 之前调用 `set_default` 来实现 `Future`：

```rust
// tracing 的 instrument.rs 简化版
impl<T: Future> Future for WithDispatch<T> {
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.project();
        let _default = dispatcher::set_default(this.dispatcher); // 每次 poll 都设置 TLS
        this.inner.poll(cx)
    }
}
```

用于按 bundler 作用域隔离的写法如下：

```rust
use tracing::Instrument; // 同时引入 WithSubscriber trait

let devtools_subscriber = tracing_subscriber::registry()
    .with(DevtoolsLayer)
    .with(fmt::layer().event_format(DevtoolsFormatter));

// 每个 bundler 的顶层 future 都拥有自己的 subscriber
let build_future = bundle.write().with_subscriber(devtools_subscriber);
tokio::spawn(build_future);
```

**关键注意事项：`tokio::spawn` 不会继承。** 如果包装后的 future 内部调用了 `tokio::spawn(sub_task)`，那么这个子任务会回退到全局默认 subscriber。每一次内部 spawn 都必须显式包装：

```rust
// 在会 spawn 子任务的 bundler 代码中：
let sub_task = do_work().with_current_subscriber(); // 捕获当前线程局部 subscriber
tokio::spawn(sub_task);
```

漏掉任意一个 `.with_current_subscriber()`，都会悄无声息地让该任务丢失 subscriber 上下文。这是 rolldown 面临的主要风险，因为它会在 scan 阶段及其他地方内部 spawn 任务。

**在全局注册表上进行按层过滤** — 通过 `.init()` 只安装一个全局 subscriber，但为每一层附加 `FilterFn`，根据 span 字段（例如 session ID）路由事件。由于 subscriber 是全局的，因此没有传播问题；复杂性转移到了过滤逻辑和动态层管理上。

#### 对 rolldown 的适用性

| 方案                                               | 是否异步安全？ | `tokio::spawn` 传播？                                        | 复杂度 | 适合 rolldown？                                                                     |
| -------------------------------------------------- | -------------- | ------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------- |
| **按 bundler future 使用 `.with_subscriber()`**    | **是**         | 需要手动处理（每次 spawn 都用 `.with_current_subscriber()`） | 中等   | **语义上最匹配**——真正做到按 bundler 隔离。需要审计所有内部 `tokio::spawn` 调用位置 |
| 在全局注册表上做按层过滤                           | 是             | 免费（全局）                                                 | 中等   | 很适合——session ID 已经在 span 上下文中，不需要 spawn 传播                          |
| `set_default` + 每个 bundler 使用 `current_thread` | 是             | 免费（单线程）                                               | 高     | 不切实际——会改变运行时模型                                                          |
| 在 `trace_action!` 中做 session 感知检查           | 是             | 不适用（发出前）                                             | 低     | 互补方案——无论采用上面哪种方式，对已禁用 session 都能零成本跳过                     |

**`.with_subscriber()` 是实现真正按构建隔离的最强候选方案**——它能让每个 bundler 实例拥有自己独立的 subscriber，并保持清晰分离。`tokio::spawn` 的传播缺口是主要采用成本：它要求审计所有内部 spawn 点，并用 `.with_current_subscriber()` 包装。不过，这是一项一次性的审计，也会让代码库中 subscriber 作用域的正确性更加显式。未来还可以通过 lint 或包装辅助函数（例如自动包装 future 的 `devtools_spawn(future)`）来强制执行这一点。

无论最终选择哪种 subscriber 作用域方案，都应当增加一个 **在 `trace_action!` 中的发出前检查** 作为补充优化，这样被禁用的 session 就可以完全跳过序列化。

## 未解决的问题

- **输出位置：** 目前相对于真实的 `process.cwd()` 硬编码为 `node_modules/.rolldown/`，而不是 `InputOptions.cwd`。这意味着如果 cwd 不同，devtools 输出可能不会落在预期位置。
- **增量/监听模式：** devtools 系统同时适用于 `ClassicBundler`（一次性）和核心 `Bundler`（增量），但同一会话中的连续构建会追加到同一个 `logs.json`。目前还没有明确的“重新构建边界”操作。
- **开发引擎集成：** `BindingDevEngine` 会创建一个会话，但使用的是 `Session::dummy()` —— devtools 目前还没有接入 dev/HMR 引擎。

## 相关

- [rust-classic-bundler](./rust-classic-bundler.md) — ClassicBundler 设计，引用 devtools 的 session/tracer 字段
- [rust-bundler](./rust-bundler.md) — 核心 Bundler 设计，引用 session 字段
