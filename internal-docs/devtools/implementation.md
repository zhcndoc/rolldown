# Devtools — 实现

> 前瞻性设计（未来方向）和未决问题见 [design.md](./design.md)。

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

只有在 `await bundle.close()` 完成之后，才能保证 `meta.json` 和 `logs.json` 已经完整且可读。内部上，事件会通过通道流向后台写线程，并通过 `BufWriter` 缓冲，因此在 `generate()`/`write()` 之后立即读取文件可能会得到空内容或被截断的内容。`bundle.close()` 会发送带有 ack 通道的 `CloseSession` 命令，并等待写线程的信号，从而建立消费者所依赖的先行发生边。

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
    {trace_action!(PackageGraphReady { ... })}
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
2. `BuildStart` / `BuildEnd` — 分别在外层 `write()`/`generate()` 调用周围以及 `scan_modules()` 内部发出，因此消费者可能会在每次构建中看到嵌套的成对事件
3. `trace_action_module_graph_ready()` — 在扫描阶段后发出，包含所有模块及其导入关系
4. `trace_action_chunks_infos()` — 在 generate 阶段构建 chunk 图之后发出
5. `trace_action_package_graph_ready()` — 在 chunk 实例化之后发出，包含从已解析的 package.json 文件中发现的包元数据

**`PluginDriver`**（插件钩子）：

- `resolve_id` — 在带有 `CONTEXT_call_id` 的 `HookResolveIdCall` span 中包裹 `HookResolveIdCallStart` / `HookResolveIdCallEnd`
- `load` — 同样包裹 `HookLoadCallStart` / `HookLoadCallEnd`
- `transform` — `HookTransformCallStart` / `HookTransformCallEnd`
- `render_chunk` — `HookRenderChunkStart` / `HookRenderChunkEnd`

每一对钩子调用都会通过其外层 span 获得一个唯一的 `call_id`（UUID v4）。

## 动作目录

| Action                       | 何时发出                                  | 关键字段                                                                                                                     |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SessionMeta`                | 构建开始时（写入 `meta.json`）            | inputs, plugins, cwd, platform, format, dir, file                                                                            |
| `BuildStart`                 | 扫描阶段之前 + 围绕 write/generate 调用   | —                                                                                                                            |
| `HookResolveIdCallStart/End` | 每个插件的每次 resolve 调用               | module_request, importer, plugin_name, plugin_id, trigger, call_id, resolved_id                                              |
| `HookLoadCallStart/End`      | 每个插件的每次 load 调用                  | module_id, plugin_name, plugin_id, call_id, content                                                                          |
| `HookTransformCallStart/End` | 每个插件的每次 transform 调用             | module_id, content, plugin_name, plugin_id, call_id                                                                          |
| `ModuleGraphReady`           | 扫描 + 规范化之后                         | modules[]{id, is_external, imports[]{module_id, kind, module_request}, importers[]}                                          |
| `BuildEnd`                   | 扫描阶段之后 + write/generate 之后         | —                                                                                                                            |
| `ChunkGraphReady`            | chunk 图构建之后                           | chunks[]{chunk_id, name, reason, modules[], imports[], is_user_defined_entry, is_async_entry, entry_module}                  |
| `PackageGraphReady`          | chunk 实例化之后                           | packages[]{package_id, name, version, package_json_path, package_root, is_used, dependency_type, size, modules[], chunk_ids[]} |
| `HookRenderChunkStart/End`   | 每个插件的每次 renderChunk 调用            | chunk_id, plugin_name, plugin_id, call_id, content                                                                           |
| `AssetsReady`                | 最终资源生成之后                           | assets[]{chunk_id, content, size, filename}                                                                                  |
| `StringRef`                  | 任何带有大字符串的动作之前                 | id (blake3 hash), content                                                                                                    |

除 `StringRef` 之外，所有动作都会携带注入的 `session_id`、`build_id` 和 `timestamp` 字段。`StringRef` 条目只包含 `action`、`id` 和 `content`。

`PackageGraphReady.packages` 包含从已解析模块 `package.json` 文件中发现的包。当该包至少有一个模块出现在生成的 chunk 中时，`is_used` 为 true；当该包的所有已解析模块都被 tree-shake 掉时，`is_used` 为 false。`dependency_type` 在包中的任意模块被构建 `cwd` 下且位于 `node_modules` 之外的源码模块导入时为 `direct`；否则为 `transitive`。这里使用的是 importer 图，而不会检查 `package.json` 的依赖字段。`size` 是该包在 tree-shaking/codegen 之后、chunk 级 `renderChunk`、压缩、banner 和最终资源输出之前，其渲染后模块代码字节数的总和。`modules` 包含该包生成的 chunk 模块 ID，`chunk_ids` 包含匹配的 `ChunkGraphReady` chunk ID；对于未使用的包，这两个数组都为空。包会按照包名、版本、包根目录和包 id 排序。Rolldown 不会发出重复标志；消费者可以通过对非空包名分组，并检查某个组是否包含多个版本或包根目录，来识别重复包。

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
// events: Array<StringRef | { timestamp, session_id, action: "BuildStart" | "ModuleGraphReady" | "PackageGraphReady" | ... }>
```

消费者（如 Vite 开发者工具）读取 JSON 行文件，将 `$ref:<hash>` 占位符解析为 `StringRef` 条目，并重建完整的构建时间线。

## 相关

- [design.md](./design.md) — devtools 的未来方向和未决问题
- [rust-classic-bundler](../rust-classic-bundler/implementation.md) — ClassicBundler 设计，引用 devtools session/tracer 字段
- [rust-bundler](../rust-bundler/implementation.md) — Core Bundler 设计，引用 session 字段
