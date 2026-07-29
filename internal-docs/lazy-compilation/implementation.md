# 懒编译 — 实现

> 目标、范围和关键设计决策见 [design.md](./design.md)。

## 数据生命周期

### 概览

懒编译涉及两个作用域下的数据：

1. **会话作用域** - 由所有浏览器标签页共享，贯穿整个开发服务器生命周期
2. **客户端作用域** - 每个浏览器标签页各自拥有，通过 `clientId` 标识

### 会话作用域

所有已连接浏览器标签页共享的数据：

| 数据              | 描述                                                             |
| ----------------- | ---------------------------------------------------------------- |
| Module Graph      | 所有已解析并编译的模块                                           |
| `lazy_entries`    | 在解析过程中发现的代理模块 ID 集合                                  |
| `fetched_entries` | 通过 `/@vite/lazy` 请求获取过的代理模块集合                        |
| Build Output      | 磁盘/内存中的打包 JS 文件                                         |
| Watched Files     | 受监控以检测变更的文件                                             |

**关键行为**：一旦某个懒模块被任意客户端获取，后续所有客户端都会收到已获取的模板（该模板会直接导入真实模块）。在懒编译之后，构建输出会被刷新，因此未来的页面加载会直接拿到已获取的模板，而无需再发起 `/lazy` 请求。

### 客户端作用域

每个浏览器标签页特有的数据：

| 数据               | 描述                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `clientId`         | 浏览器标签页的唯一标识符                                                                        |
| `executed_modules` | 浏览器实际已经执行过的模块（用于 HMR 边界计算和懒补丁裁剪）                                     |

会话生命周期：

- 客户端会话在 `SharedClients` 中的形式是 `clientId → ClientSession { executed_modules }`，位于 `DevEngine` 上
- 在该 `clientId` 的第一条 `hmr:module-registered` 消息到来时**隐式**创建（dev server → `registerModules` → napi `register_modules`）；当客户端的 websocket 断开时通过 `removeClient` 移除
- `executed_modules` 是一个**只增不减**的 **stable ids** 集合——它包含像 `src/foo.js?rolldown-lazy=1` 这样的代理 id，因为懒 chunk 会以其 stable id 重新注册该代理
- 在运行时侧，`registerModule` 会喂给一个去抖批处理器，将多个 id 合并成一条 `hmr:module-registered` 消息；messenger 会在 websocket 打开前排队消息
- 特殊客户端 id `"rolldown-tests"` 被视为已经执行了全部内容（Rust 层测试绕过了按客户端的门控；只有浏览器 E2E playground 会走 `executed_modules` 路径）

### 已获取 vs 已执行

这两个概念属于不同作用域，且彼此不同：

- **已获取**（会话级）：浏览器为这个代理模块发送了 `/lazy` 请求。服务器已编译真实模块及其依赖。此后所有客户端都会收到已获取的模板。

- **已执行**（客户端级）：浏览器实际运行了该模块的代码。用于为特定客户端裁剪懒补丁，并控制 HMR 传播。

一个模块可以被某个客户端获取，但不一定被该客户端执行（例如：客户端 A 获取了它，而客户端 B 还没有导航到那个路由）。

当一个已获取的懒模块之后被编辑时，各客户端的结果如下（参见“编辑一个已获取的懒模块”）：

- 已执行过它的客户端 → 一个真实的 `Patch`，如果没有 HMR 边界接受该变更，则为 `FullReload`
- 从未执行过它的客户端 → 一个实际上为空的 `Patch`，其代码仅为 `__rolldown_runtime__.applyUpdates([]);`（**不是** `Noop`——`Noop` 只会在变更文件根本不映射到任何图中的模块时产生，例如一个未获取的懒文件）

### 构建输出刷新

在懒编译成功后：

1. `DevEngine` 通过 `ModuleChanged` 通知协调器（携带**原始代理 id**，包含 `?rolldown-lazy=1`）
2. 协调器首先调用 `update_watch_paths()`——在懒编译期间发现的监视文件，否则会在重建任务开始时被丢弃；这一步正是让后续对懒模块的编辑能够触发重建的原因
3. 协调器以代理 id 作为变更文件排队一个 `Rebuild` 任务，并将输出标记为过期
4. 重建会把构建输出中的 stub 替换为已获取的模板；未来的页面加载会直接得到它（无需 `/lazy` 请求）

原始代理 id 被刻意**不做归一化**：在局部重建期间，它会解析回自身（resolver 会保留 query），字符串匹配会命中增量缓存中代理模块的 key，并强制代理的 `load` 钩子重新执行——此时它会返回已获取的模板。如果将其归一化为真实模块 id，就会使错误的模块失效，并让缓存中的 stub 代理保持原样。

成功的后台重建对已连接客户端是**静默**的：输出会原地替换，不会发送 websocket 消息（运行中的页面会继续使用它从 `/lazy` 获得的代码）。只有在 `FullReload` 已经处于待处理状态，或者服务器正在从先前广播过的构建错误中恢复时，才会触发重新加载。`Rebuild` 任务从不生成 HMR 更新，并且只与其他 `Rebuild` 合并，因此 `?rolldown-lazy=1` 这个伪路径绝不会泄漏到 HMR 更新计算中——不过插件会通过 `watch_change` 钩子观察到它一次。

## 已知限制

### 共享模块去重

当多个懒加载入口共享公共依赖时，有两层协作机制来防止重复执行：

```
Entry
├── import('./lazy-a')  ← 懒加载边界
│   └── shared.js (sync dep)
└── import('./lazy-b')  ← 懒加载边界
    └── shared.js (sync dep)
```

1. **服务端剪枝**：在收集某个懒加载补丁的同步依赖时，服务端会跳过那些其稳定 id 已经存在于请求客户端 `executed_modules` 中的模块（该列表通过 `hmr:module-registered` 填充）
2. **运行时去重标志**：懒加载 chunk 渲染时会设置 `dedup_module_initializer: true`，这会给每个模块包装器追加一个真值第三参数 —— `__rolldown_runtime__.createEsmInitializer(stableId, factory, 1)` / `createCjsInitializer(...)` —— 如果 id 已经注册，运行时就会跳过该工厂函数

服务端侧仍然存在竞态窗口（两个 `/lazy` 请求在极短时间内连续到达，且第一个补丁的 `hmr:module-registered` 还未到达时，会生成重叠的 chunk——`hmr_stage.rs` 中的 TODO），但运行时去重标志使其无害：`shared.js` 会同时出现在两个 chunk 中，但只会执行一次。

**HMR 补丁刻意省略去重标志**（`dedup_module_initializer: false`）：补丁的目的就是重新执行模块体并发布新的导出，因此去重会悄悄丢失更新。代码注释将该标志标记为在运行时提供 dispose/re-execute API 之前的权宜之计。

### 链接阶段合成的导出（JSON、text、base64、dataurl）

那些在链接时合成导出的模块在**懒加载 chunk 内部是坏掉的**（以及 HMR 补丁中也是如此）：JSON/text/base64/dataurl 模块会被扫描为一个裸表达式语句，`ExportsKind::None`，而 `export default` 仅由链接阶段的 `generate_lazy_export` 生成——但懒加载/HMR 渲染路径从不会执行这一步（它们渲染的是原始的扫描期 AST 克隆）。懒加载 chunk 会将它们注册为 `registerModule(id, {})`，因此导入者在**首次懒加载时会看到空导出**；而在后台重新构建 + 刷新页面之后，完整构建会应用该转换，同样的导入就能正常工作。目前还没有 playground fixture 覆盖这一点。

### CSS

rolldown 中的 CSS 打包已被移除（#4271），而懒加载边界是在不加载目标模块的情况下创建的——因此 `import('./style.css')` 构建时不会报错，真正的硬错误（`Bundling CSS is no longer supported`）会**延迟到第一次 `/lazy` 请求时才出现**：HTTP 500，且可在消费者的 `await import()` 处捕获拒绝。

### 资源

Rolldown core 没有内建的资源处理：默认 `module_types` 映射之外的扩展名会被当作 UTF-8 读取并按 JS 解析，因此在懒加载子树中静态导入的二进制文件会在请求时导致懒加载编译失败。只有当插件在其 `load` 钩子里将资源转换为 JS 时，懒加载子树中的资源导入才可工作（dev server 移植过来的 `vite:asset` 插件就是这样做的——见“已发出的资源”）。

### Sourcemap

只有 `sourcemap: 'inline'` 对懒加载 chunk 有效。`/lazy` 载荷在整个链路中都是一个普通 `String`（`HmrStage` → `DevEngine` → napi → middleware），没有单独 map 文件的字段：当使用 `'file'`/`true` 时，代码会增加一条 `//# sourceMappingURL=lazy_compile_{n}.js.map` 注释，但 map 资源会在服务端被丢弃（于是这条注释悬空）；`'hidden'` 则会静默丢弃 map。相比之下，HMR 补丁会通过 `HmrPatch { sourcemap, sourcemap_filename }` 携带其 map，且 dev server 会从内存文件存储中同时提供补丁和 map——因此相同的 `sourcemap: 'file'` 配置对 HMR 编辑有效，却会在懒加载 chunk 上静默失效。该路径目前没有测试覆盖。

## Implementation Details

### Module ID Format

**Important**: All runtime module lookups use a **stable ID** (`stable_id`), that is, the relative path to the current working directory (cwd) (for example, `src/module.js`), computed by capturing the cwd in the `build_start` hook and then calling `ModuleId::new(id).stabilize(cwd)`.

This ensures consistency between the following:

- stub `delete __rolldown_runtime__.modules[stableProxyId]` / `loadExports(stableProxyId)` calls
- compiled module wrapper: `createEsmInitializer("src/module.js", ...)` (inside the wrapper body, `registerModule` / `createModuleHotContext` receive this id through the `__rolldown_module_id__` parameter)
- `import.meta.hot.accept("src/dep.js", ...)` import specifier
- `applyUpdates([["src/boundary.js", "src/acceptedVia.js"]])` boundary

Absolute paths are only preserved in two places: the `/@vite/lazy?id=` query value (proxy id) and `import($MODULE_ID)` in the fetched template (for resolution).

The template is rendered using **four placeholders**, and each placeholder is replaced with a serde_json-quoted JS string literal (so the template contains bare `$PLACEHOLDER` markers, and Windows backslash paths are escaped correctly, #9102):

| Placeholder              | Value                              | Used for                                  |
| ------------------------ | ----------------------------------- | ----------------------------------------- |
| `$PROXY_MODULE_ID`       | absolute path + `?rolldown-lazy=1`  | stub — `/@vite/lazy?id=` request          |
| `$STABLE_PROXY_MODULE_ID` | stable id + `?rolldown-lazy=1`      | stub — module map deletion + `loadExports` |
| `$MODULE_ID`             | absolute path (without query params) | fetched — `import($MODULE_ID)`            |
| `$STABLE_MODULE_ID`      | stable id                            | fetched — `loadExports($STABLE_MODULE_ID)` |

`render_proxy_template` replaces `$MODULE_ID` last, because the other three placeholder names all contain `MODULE_ID` as a substring.

### Fetched State Tracking

`LazyCompilationPlugin` maintains two sets in `LazyCompilationContext` (shared with `DevEngine` via `plugin.context()`):

- `lazy_entries` - all proxy module IDs created during resolution
- `fetched_entries` - proxy module IDs that have already been fetched (via `/lazy` requests at runtime)

When `resolve_id` is called for a dynamic import:

1. If the importer is an **already fetched proxy** (`?rolldown-lazy=1` + present in `fetched_entries`) → return `None` (skip proxy creation, resolve to the real module)
2. Otherwise → resolve the specifier via `ctx.resolve` (`skip_self: true`, passing through `args.custom`), and append `?rolldown-lazy=1`. This append is **idempotent** (#9439): `ctx.resolve` may re-enter other plugins’ resolve hooks (for example, alias plugins), so if the resolved id already ends with that marker, it will be reused — duplicating the suffix would desynchronize the proxy id from the runtime invalidation key in the stub template (regression from vitejs/vite#22454, fixed by the alias import specifier)

When `load` is called for a proxy module:

1. Only ids present in `lazy_entries` are served at all — any other `?rolldown-lazy=1` id falls through to `Ok(None)`
2. If in `fetched_entries` → return fetched template; otherwise → return stub template
3. User-land build hooks are skipped for proxy ids (`?rolldown-lazy=1`) so plugins only see real modules; the lazy plugin itself still runs to serve the stub/fetched template.

**Security gate — reject unknown modules (#9969)**: ids passed to `compileEntry` / `compile_lazy_entry` are treated only as lookup keys in the build cache and are never resolved as filesystem paths. If an id was not present in the previous build, it is rejected in `HmrStage::compile_lazy_entry` with `Lazy entry module not found in cache` — so a malicious `/@vite/lazy` request cannot bundle arbitrary files (similar to Vite’s `server.fs.strict`; fixed by `packages/rolldown/tests/dev/dev-lazy-compile.test.ts`). Note the order: `DevEngine::compile_lazy_entry` calls `mark_as_fetched` unconditionally before validation, so unknown ids still enter `fetched_entries` (harmless, but worth knowing when debugging).

### Lazy Chunk Rendering

`Bundler::compile_lazy_entry(module_id, client_id, executed_modules, next_patch_id)` → `HmrStage::compile_lazy_entry` (this layer does not use the `client_id` parameter — client-specific trimming depends entirely on `executed_modules`):

1. Look up the proxy in the module cache (the #9969 gate), then run `ScanMode::Partial([proxy's resolved id])`
2. `collect_sync_dependencies_for_client` walks the proxy’s static dependencies and the proxy’s own dynamic imports, **stopping** at any module whose stable id is present in that client’s `executed_modules`; external modules are dropped, and the rest are sorted by id
3. Each module is rendered by `HmrAstFinalizer` into an initializer wrapper:

   ```js
   var init_foo = __rolldown_runtime__.createEsmInitializer(
     'src/foo.js',
     function (__rolldown_module_id__) {
       try {
         // registerModule/createModuleHotContext use __rolldown_module_id__;
         // ESM exports are published as:
         // var __rolldown_exports__ = __rolldown_runtime__.__exportAll({ ... })
       } finally {
       }
     },
     1,
   ); // trailing `1` = dedupe flag, used only for lazy chunks
   ```

   (CJS modules use `createCjsInitializer`, with `__rolldown_exports__` / `__rolldown_module__`.)

4. Dynamic imports in the rendered modules are rewritten:
   - Imported module id contains `?rolldown-lazy=1` (nested lazy proxy) → ``import(`/@vite/lazy?id=${encodeURIComponent(absProxyId)}&clientId=${__rolldown_runtime__.clientId}`).then(() => __rolldown_runtime__.loadExports("<stableProxyId>"))`` — a partial bundle does not have a separately bundled proxy chunk, so the proxy’s top-level `'rolldown:exports'` export is lost in the init wrapper; reading it back via `loadExports` preserves the surface expected by `__unwrap_lazy_compilation_entry` (fixed by the nested dynamic import spec)
   - Ordinary `import()` → `Promise.resolve().then(() => __rolldown_runtime__.loadExports("<stableId>"))`, and if the imported module is in the same patch, the module’s `init_x()` call is prepended
5. The chunk ends with the proxy entry’s `init_xxx()` call (this re-registers the proxy id with the real initializer — i.e. the thing the stub’s step 3 is waiting for)
6. The result is post-processed with the synthetic name `lazy_compile_{n}.js` (`n` comes from the dev engine’s `next_invalidate_patch_id` counter, shared with the `hmr.invalidate` patch — **not** the coordinator’s `hmr_patch_{n}.js` counter), and returned as a plain JS string

### Emitted Assets (#9815)

Lazy compilation (like HMR patches) never runs the generate stage, so assets emitted during compilation have no `onOutput` path. Instead, on success, `DevEngine::compile_lazy_entry` drains `file_emitter.add_additional_files` into a `BundleOutput` and triggers the `onAdditionalAssets` dev callback **before** returning the code — this lets consumers register/provide the assets before the browser requests them (test-dev-server puts them into `memoryFiles`); this fixes vitejs/vite#22596 and is fixed by the emitted assets spec.

Design constraint for consumers: asset URLs must be resolved **early** during the `load` phase (`emitFile` + `getFileName`, just like Vite-style asset plugins in the dev server) — a placeholder scheme in `renderChunk` would leak because the lazy rendering path does not run `renderChunk` at all.

### Build Output Refresh

After a successful lazy compile, the dev engine success branch does two things in order:

```rust
// In DevEngine::compile_lazy_entry
if result.is_ok() {
  // 1. Deliver assets emitted during compilation (before code returns)
  if let Some(on_additional_assets) = ... { ... }
  // 2. Queue a background rebuild
  self.notify_module_changed(proxy_module_id);
}
```

The coordinator handles `ModuleChanged`:

1. Call `update_watch_paths()` first (see “Data Lifecycle → Build Output Refresh” for why)
2. Queue a `TaskInput::Rebuild` using the original proxy id as the changed file
3. Set `has_stale_bundle_output = true`
4. Schedule a build if the output is stale (runs immediately only when the coordinator is Idle/Failed; otherwise waits in the queue)

On **failure**, neither of these steps happens: a failed lazy compile does not queue a rebuild, and the stub template remains in the bundle output (but the proxy is still marked as fetched). If the background rebuild itself fails, consumers cache the error, broadcast an error overlay to every client, and cancel any pending full-page reload, so the page never reloads on a broken bundle (#9903); the coordinator enters `Failed { Rebuild }` with stale output and recovers on the next file change or page visit.

### Error Handling

Error contract (no longer “POC — either Err or panic is fine”):

- **Unknown module id** → `HmrStage::compile_lazy_entry` returns `Err("Lazy entry module not found in cache. module_id=...")`; the napi binding exposes this as a rejected promise prefixed with `Failed to compile lazy entry: ...`; the dev-server middleware returns HTTP 500 (missing `id`/`clientId` parameters fall through to `next()`; on success it sets `Content-Type: application/javascript`)
- **Initializer errors are catchable (#9981)**: errors thrown while initializing a lazy module reject the re-registered proxy’s `'rolldown:exports'` promise, which in turn rejects the stub’s `lazyExports`, and then rejects the consumer’s `await import(...)` — `try/catch` works normally, and without a handler it only triggers a single `unhandledrejection`. This behavior is fixed by the lazy-init-error spec in both the **cold path** (first `/lazy` compile) and the **hot path** (after rebuild + refresh, for already fetched proxies) (#9975 added the original failure spec; #9981 rewrote and split it)
- **Runtime `loadExports` miss** does not throw — it only warns and returns `{}`
- The only remaining panic: calling `compile_lazy_entry` before any bundle has been built

### ClientId

- Generated by the HMR runtime during initialization via `crypto.randomUUID()` (before any lazy import runs), appended to the websocket URL (`?clientId=...` — the dev server closes sockets missing clientId with code 1008), and interpolated into every `/@vite/lazy` request through `__rolldown_runtime__.clientId`
- Its only role in lazy compilation is **client-specific patch trimming**: the engine looks up that client’s `executed_modules`, so the returned chunk omits modules the client has already run. There is no “routing” — the compiled code is returned synchronously in the HTTP response
- An unknown `clientId` silently degrades to an empty executed set (it returns the full dependency closure)

### Editing Fetched Lazy Modules

After `/lazy`, the real module and its synchronous dependencies become ordinary watched-graph modules (thanks to `update_watch_paths()`), and an edit flows through the standard watch → client-specific HMR path:

- A fetched proxy participates as a normal **non-accepting** importer (`hmr_info.deps` comes only from `import.meta.hot.accept`, never from dynamic imports). Therefore, editing a lazy module that does not self-accept propagates along proxy → dynamic importer → `NoBoundary` → `FullReload` to all clients that executed it; the dev task upgrades itself to `HmrRebuild`, and the dev server delays refresh until the rebuilt output arrives (if the rebuild fails, refresh is canceled, #9903). This is fixed by the shared-module spec’s watch/auto-reload tests
- If the lazy module self-accepts (`import.meta.hot.accept()`), clients that executed it receive a normal client-specific `Patch`
- Clients that never executed the module receive an effectively empty `applyUpdates([])` patch (see “fetched vs executed”)

## 端到端流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. 初始构建                                                             │
├─────────────────────────────────────────────────────────────────────────┤
│  - 入口 + 同步依赖正常编译                                              │
│  - 动态导入（import()）→ 替换为代理模块                                 │
│  - 代理模块 ID: /abs/path/module.js?rolldown-lazy=1                    │
│  - 代理包含 STUB 模板（通过 /@vite/lazy 端点获取）                     │
│  - 代理导出 'rolldown:exports' promise                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. 浏览器加载初始 bundle                                               │
├─────────────────────────────────────────────────────────────────────────┤
│  - 运行时初始化；clientId = crypto.randomUUID()                         │
│  - 代理以其稳定 ID 注册：                                                │
│      registerModule("src/module.js?rolldown-lazy=1", { exports })      │
│  - Stub 模板已准备好按需拉取                                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. 用户代码触发：import('./lazy-module')                               │
├─────────────────────────────────────────────────────────────────────────┤
│  - 代理模块执行（stub 模板）                                            │
│  - 删除自身的运行时注册（这样 chunk 才能重新注册）                      │
│  - 获取：/@vite/lazy?id=/abs/path/lazy-module.js?rolldown-lazy=1&clientId=xxx
│  - 浏览器等待该 promise                                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. 开发服务器接收 /lazy 请求                                           │
├─────────────────────────────────────────────────────────────────────────┤
│  - 调用 DevEngine.compileEntry(proxyModuleId, clientId)                │
│  - 引擎查找该客户端的 executed_modules                                  │
│  - 在 LazyCompilationContext 中将代理标记为 FETCHED                    │
│  - 拒绝不在模块缓存中的 id（安全校验，#9969）                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. 部分扫描 + 渲染                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  - ScanMode::Partial([proxyModuleId])                                   │
│  - 插件的 load 钩子看到代理已被拉取 → 返回 FETCHED 模板                 │
│  - 已拉取模板：import("/abs/path/lazy-module.js")                       │
│  - resolve_id 看到 importer 是已拉取的代理 → 返回 None                 │
│  - 实际模块 + 同步依赖被编译 —— 减去该客户端                            │
│    已经执行过的模块                                                     │
│  - 模块渲染为 createEsm/CjsInitializer(stableId, fn, 1)                │
│    （去重标志）；chunk 以代理入口的 init 调用结束                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 6. 将编译后的 JS 返回给浏览器                                          │
├─────────────────────────────────────────────────────────────────────────┤
│  - 编译期间生成的资源已通过                                              │
│    onAdditionalAssets（#9815）提前交付                                  │
│  - 响应是单个 JS 字符串（仅代码——没有 sourcemap 通道）                 │
│  - 浏览器将其作为 ES 模块加载；初始化器注册每个模块                     │
│  - 入口 init 调用使用真实初始化器重新注册代理 id                        │
│  - Stub 解析：loadExports(stableProxyId)['rolldown:exports']           │
│  - 原始 import() promise 解析（或可捕获地拒绝，#9981）                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 7. 构建输出刷新（后台）                                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  - DevEngine 发送 CoordinatorMsg::ModuleChanged { proxyModuleId }      │
│  - Coordinator：update_watch_paths() → 排队 Rebuild → 标记 stale       │
│  - Rebuild 使用已拉取模板更新构建输出                                   │
│  - 对已连接客户端静默；未来的页面加载将跳过 /lazy                      │
└─────────────────────────────────────────────────────────────────────────┘
```

## 经验总结

### 问题 1：模块 ID 一致性至关重要

**问题**：代理模块、编译后的模块以及 HMR 运行时必须使用相同的 ID 格式，模块查找才能生效。

**解决方案**：在运行时始终使用 **稳定 ID**（`stable_id`，即相对于 cwd 的路径）：

- `createEsmInitializer(stableId, factory[, dedup])` / `createCjsInitializer(...)` —— 在包装器内部，`registerModule(__rolldown_module_id__, { exports })` 和 `createModuleHotContext(__rolldown_module_id__)` 通过包装器参数接收 id（主 bundle 路径仍然输出稳定 id 的字符串字面量）
- `loadExports(stableId)`
- `import.meta.hot.accept(stableId, callback)`
- `applyUpdates([[boundaryStableId, acceptedViaStableId]])`

懒编译插件会在其 `load` 钩子中，使用从 `build_start` 钩子获取的 `cwd` 计算稳定 ID。

### 问题 2：获取后代理内容必须变化

**问题**：首次懒加载工作正常，但页面刷新后：

- 构建输出仍然包含 stub 模板
- stub 仍会尝试重新请求 `/lazy`
- 但实际模块从未包含在返回的代码中

**根本原因**：代理模块内容在被获取后从未改变。插件始终返回同一个 stub 模板。

**解决方案**：实现双状态代理模块：

1. 向 `LazyCompilationContext` 添加 `fetched_entries` 集合
2. 在编译前将代理标记为已获取：`lazy_ctx.mark_as_fetched(&proxy_module_id)`
3. 在 `load` 钩子中检查状态并返回对应模板：
   ```rust
   let template = if self.fetched_entries.contains(args.id) {
     include_str!("./proxy-module-template-fetched.js")
   } else {
     include_str!("./proxy-module-template.js")
   };
   ```

### 问题 3：已获取的代理不能创建自引用代理

**问题**：在将代理标记为已获取后，已获取模板中的 `import($MODULE_ID)` 会被 `resolve_id` 钩子拦截，从而为同一个模块创建另一个代理，导致无限递归。

**解决方案**：在 `resolve_id` 中，当导入者是已获取代理时，跳过代理创建：

```rust
if let Some(importer) = args.importer {
  if importer.contains("?rolldown-lazy=1") && self.fetched_entries.contains(importer) {
    return Ok(None);  // 让正常解析继续
  }
}
```

这样已获取模板中的动态导入就能解析到实际模块。

### 问题 4：懒编译后构建输出必须更新

**问题**：第一次懒加载后，磁盘上的构建输出仍然是 stub 模板。页面刷新时又会显示 stub，需要再次请求 `/lazy`。

**解决方案**：在懒编译成功后通知协调器触发重建：

```rust
// 在 DevEngine::compile_lazy_entry 中
if result.is_ok() {
  //（资源先通过 on_additional_assets 送达——见“发出的资源”）
  self.notify_module_changed(proxy_module_id);
}
```

该通知故意携带原始代理 id（包含 `?rolldown-lazy=1`）——这是正确的增量缓存失效键，因为内容发生变化的模块是 _代理_（stub → 已获取模板），而不是真实模块。见“构建输出刷新”。

### 问题 5：非标识符导出名需要使用计算属性语法

**问题**：HMR 收尾器生成了无效的 JavaScript：

```js
// 无效 - 标识符中包含冒号
var __rolldown_exports__ = __rolldown_runtime__.__exportAll({ rolldown:exports: () => lazyExports });
```

**解决方案**：使用 `is_validate_identifier_name()` 检测非标识符导出名，并使用计算属性语法：

```rust
let computed = !is_validate_identifier_name(exported.as_str());
self.ast_factory.make_lazy_export_property(exported, expr, computed)
```

这会生成有效的 JavaScript：

```js
// 有效 - 计算属性
var __rolldown_exports__ = __rolldown_runtime__.__exportAll({
  ['rolldown:exports']: () => lazyExports,
});
```

### 问题 6：需要更新多个代码路径

**问题**：`rewrite_hot_accept_call_deps` 有两个实现：

1. `HmrAstFinalizer`（用于 HMR 补丁）
2. `ScopeHoistingFinalizer`（用于 dev 模式下的常规构建）

只更新其中一个会导致另一个仍然使用 `stable_id`。

**解决方案**：修改行为时，务必搜索所有实现。使用 `grep` 找出所有出现位置。

### 问题 7：代理 ID 与真实模块 ID 不同

懒编译插件会创建两个不同的模块 ID：

- **代理模块**：`/abs/path/module.js?rolldown-lazy=1`（初始加载，包含 stub/已获取代码；运行时以其稳定 id `src/module.js?rolldown-lazy=1` 注册）
- **实际模块**：`/abs/path/module.js`（按需编译，包含真实代码；以 `src/module.js` 注册）

流程如下：

1. 初始构建使用 stub 模板创建 `module.js?rolldown-lazy=1` 代理
2. 用户触发懒加载 → `/@vite/lazy?id=...?rolldown-lazy=1`
3. DevEngine 将代理标记为已获取
4. 从代理执行部分扫描 → 插件返回已获取模板
5. 已获取模板导入实际模块 → 触发编译
6. 懒块重新以真实初始化器注册代理 id，stub 通过 `loadExports("src/module.js?rolldown-lazy=1")['rolldown:exports']` 解析
7. 后台重建后，输出中同时包含代理（已获取）和实际模块

### 问题 8：代理 ID 的创建必须是幂等的（#9439）

**问题**：在存在别名插件时，`ctx.resolve` 重新进入懒插件的 `resolve_id`，导致 `?rolldown-lazy=1` 被追加了两次。重复后缀使代理 id 与 stub 模板中的 `delete modules[$STABLE_PROXY_MODULE_ID]` 失效键不同步，因此真实模块的导出从未注册（`mod.foo` 变成 `undefined`——回归 vitejs/vite#22454）。

**解决方案**：在追加标记前，检查解析后的 id 是否已经以 `?rolldown-lazy=1` 结尾，如果是则复用它。由别名导入规范固定。

### 问题 9：已获取模板必须从注册表读取导出（#9132）

**问题**：最初，已获取模板返回的是动态导入的命名空间对象。当共享懒模块进入公共 chunk 时，chunk 级重命名会压缩导出名，命名空间查找会得到 `undefined`。

**解决方案**：`await import($MODULE_ID)` 仅用于副作用，然后 `return __rolldown_runtime__.loadExports($STABLE_MODULE_ID)` —— 运行时注册表会保留原始导出名。由共享模块规范固定。

### 问题 10：初始化错误必须拒绝消费者的 Promise（#9981）

**问题**：当懒编译模块初始化时抛出错误，该错误会作为未处理的 rejection 泄漏，而不是在消费者的 `await import(...)` 处暴露。

**解决方案**：stub 模板等待的是**重新注册后的代理自身的 `'rolldown:exports'` Promise**（`return await loadExports($STABLE_PROXY_MODULE_ID)['rolldown:exports']`），而不是直接返回命名空间——因此链路中任意一处的 rejection 都会拒绝 `lazyExports` 和消费者的导入 Promise。由两个 lazy-init-error 规范（冷路径和热路径）固定。

### 问题 11：`export * as ns from` 不是 `export * from`

**问题**：`export * as ns from './dep'` 和 `export * from './dep'` 是同一个 oxc AST 节点（`ExportAllDeclaration`），仅通过 `exported` 是否设置来区分。HMR 收尾器忽略了该字段，并将两者都渲染为星号重导出——`__reExport(__rolldown_exports__, import_dep)`——因此重导出模块的命名空间对象从未携带 `ns`，每个消费者都读到了 `undefined`。只有模块包装器受到了影响（懒块和 HMR 补丁）；scope-hoisted 构建会正确解析相同源码。

**解决方案**：当 `exported` 存在时，将被导入模块的 `loadExports` 结果以该单一名称绑定到命名空间对象中（`{ ns: () => import_dep }`，当名称不是有效标识符时使用计算属性），并且不要输出 `__reExport`。由 `crates/rolldown/tests/rolldown/topics/hmr/export_star_as/` 固化。

## 实现说明

### 注入辅助函数的命名约定

懒编译插件注入的辅助函数使用双下划线前缀（例如，`__unwrap_lazy_compilation_entry`）。这是 JavaScript 打包器中内部/保留标识符的标准约定，不应与用户代码冲突。

### 指令前导语句处理

注入的辅助函数会被插入到任何指令前导语句（例如，`"use strict"`）**之后**，以保持其语义。该插件会统计前置的字符串字面量表达式语句，并在它们之后插入辅助函数。只有当模块中至少有一个动态导入实际上被包装时，才会注入该辅助函数。

## 测试覆盖范围

E2E playground：`packages/test-dev-server/tests/playground/lazy-compilation/`（一个 dev server 配置，`experimental.devMode.lazy: true` + 一个别名插件）：

| 规范                        | 关联问题                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| `basic`                     | 懒加载模块会以两个独立的 JS 请求到达（代理 chunk + 真实 chunk）        |
| `aliased-import`            | 在别名重入情况下保持幂等的代理 id 创建（vite#22454）                 |
| `emitted-asset`             | 懒编译期间发出的资源在首次加载时可被正常提供（vite#22596）        |
| `lazy-init-error`           | 可通过 try/catch 捕获初始化错误——冷路径和热路径（#9975/#9981）          |
| `lazy-init-error-unhandled` | 在没有处理器的情况下，恰好触发一次 `unhandledrejection`——冷路径和热路径          |
| `nested-dynamic-import`     | 懒 chunk 内部嵌套的懒 `import()` 会在第一次点击时解析                |
| `shared-module`             | 共享 chunk 中的导出名保留（#9132）+ fetch 后的 watch/自动重载 |

多个规范使用 `retry: 0`，因为这些 bug 只会在新启动的服务器上首次交互时复现。单元测试：`packages/rolldown/tests/dev/dev-lazy-compile.test.ts` 固定了未知 id 拒绝（#9969）。

## 已更改的文件（参考）

为便于后续调试，这些文件负责懒编译：

### 核心插件

1. **`crates/rolldown_plugin_lazy_compilation/src/lazy_compilation_plugin.rs`** - 包含 `resolve_id`、`load` 和 `transform_ast` 钩子的插件；具有已获取状态跟踪的 `LazyCompilationContext`；`render_proxy_template`
2. **`crates/rolldown_plugin_lazy_compilation/src/runtime_injector.rs`** - 用于包装动态导入并生成 `__unwrap_lazy_compilation_entry` 的 AST 访问器
3. **`crates/rolldown_plugin_lazy_compilation/src/proxy-module-template.js`** - 代理模板骨架（未获取）
4. **`crates/rolldown_plugin_lazy_compilation/src/proxy-module-template-fetched.js`** - 已获取的模板
5. **`crates/rolldown/src/utils/apply_inner_plugins.rs`** - 在 `experimental.dev_mode.lazy == true` 时注册该插件

### 开发引擎

6. **`crates/rolldown_dev/src/dev_engine.rs`** - `compile_lazy_entry()`（已执行模块查找、标记为已获取、资源交付、`notify_module_changed()`），客户端会话
7. **`crates/rolldown_dev/src/types/coordinator_msg.rs`** - `ModuleChanged` 消息变体
8. **`crates/rolldown_dev/src/bundle_coordinator.rs`** - 处理 `ModuleChanged`（`update_watch_paths` + 重建）、状态机
9. **`crates/rolldown_binding/src/binding_dev_engine.rs`** - napi 接口（`compile_entry`、`register_modules`、`remove_client`）

### HMR/构建

10. **`crates/rolldown/src/hmr/hmr_stage.rs`** - `compile_lazy_entry()`：缓存门控、部分扫描、按客户端的依赖收集、chunk 渲染
11. **`crates/rolldown/src/hmr/hmr_ast_finalizer.rs`** + **`impl_traverse_for_hmr_ast_finalizer.rs`** - 初始化器包装器、去重标志、动态导入重写（包括 `/@vite/lazy` 重写）、计算属性导出
12. **`crates/rolldown/src/hmr/utils.rs`** - register-module / hot-context 语句构建器（`__rolldown_module_id__` 参数）
13. **`crates/rolldown/src/bundler/impl_bundler_hmr.rs`** - `Bundler::compile_lazy_entry` 入口点
14. **`crates/rolldown_plugin_hmr/src/runtime/runtime-extra-dev-common.js`** - 浏览器运行时：`createEsm/CjsInitializer`（去重门控）、`registerModule`、`loadExports`、模块已注册批处理

### Reference Dev Server（Vite full bundle mode，位于 `vite/`（仓库根目录））

15. **`packages/vite/src/node/server/middlewares/triggerLazyBundling.ts`** - `/@vite/lazy` 中间件（出错时返回 500，成功时返回 `application/javascript`）
16. **`packages/vite/src/node/server/bundledDev.ts`** - `triggerLazyBundling`（`devEngine.compileEntry`）、`onAdditionalAssets` 存储、重建/重载处理
17. **`packages/vite/src/node/plugins/asset.ts`** - bundled-dev 分支在 `load` 时会提前解析资源导入

## 参考资料

- [design.md](./design.md) — 目标、范围和关键设计决策
- 当前实现：`crates/rolldown_plugin_lazy_compilation/`
- 开发引擎：`crates/rolldown_dev/`（另见 `internal-docs/dev-engine/`）
- 示例：`examples/lazy-compilation/`
