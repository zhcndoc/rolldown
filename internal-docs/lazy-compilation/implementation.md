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
| 模块图            | 所有已解析并编译的模块                                           |
| `lazy_entries`    | 在解析过程中发现的代理模块 ID 集合                                  |
| `fetched_entries` | 通过 `/@vite/lazy` 请求获取过的代理模块集合                        |
| 构建输出          | 磁盘/内存中的打包 JS 文件                                         |
| 监视文件          | 受监控以检测变更的文件                                             |

**关键行为**：一旦某个懒模块被任意客户端获取，后续所有客户端都会收到已获取的模板（该模板会直接导入真实模块）。在懒编译之后，构建输出会被刷新，因此未来的页面加载会直接拿到已获取的模板，而无需再发起 `/lazy` 请求。

### 客户端作用域

每个浏览器标签页特有的数据：

| 数据               | 描述                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `clientId`         | 浏览器标签页的唯一标识符                                                                        |
| `executed_modules` | 浏览器实际已经执行过的模块（用于 HMR 边界计算和懒补丁裁剪）                                     |

会话生命周期：

- 客户端会话在 `SharedClients` 中的形式是 `clientId → ClientSession { executed_modules }`，位于 `DevEngine` 上
- 在该 `clientId` 的第一条 `hmr:module-registered` 消息到来时**隐式**创建（开发服务器 → `registerModules` → napi `register_modules`）；当客户端的 websocket 断开时通过 `removeClient` 移除
- `executed_modules` 是一个**只增不减**的**稳定 ID**集合——它包含像 `src/foo.js?rolldown-lazy=1` 这样的代理 ID，因为懒 chunk 会以其稳定 ID 重新注册该代理
- 在运行时侧，`registerModule` 会喂给一个去抖批处理器，将多个 ID 合并成一条 `hmr:module-registered` 消息；消息传递器会在 websocket 打开前排队消息
- 特殊客户端 ID `"rolldown-tests"` 被视为已经执行了全部内容（Rust 层测试绕过了按客户端的门控；只有浏览器 E2E playground 会走 `executed_modules` 路径）

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

1. `DevEngine` 通过 `ModuleChanged` 通知协调器（携带**原始代理 ID**，包含 `?rolldown-lazy=1`）
2. 协调器首先调用 `update_watch_paths()`——在懒编译期间发现的监视文件，否则会在重建任务开始时被丢弃；这一步正是让后续对懒模块的编辑能够触发重建的原因
3. 协调器以代理 ID 作为变更文件排队一个 `Rebuild` 任务，并将输出标记为过期
4. 重建会把构建输出中的 stub 替换为已获取的模板；未来的页面加载会直接得到它（无需 `/lazy` 请求）

原始代理 ID 被刻意**不做归一化**：在局部重建期间，它会解析回自身（解析器会保留 query），字符串匹配会命中增量缓存中代理模块的 key，并强制代理的 `load` 钩子重新执行——此时它会返回已获取的模板。如果将其归一化为真实模块 ID，就会使错误的模块失效，并让缓存中的 stub 代理保持原样。

成功的后台重建对已连接客户端是**静默的**：输出会原地替换，不会发送 websocket 消息（运行中的页面会继续使用它从 `/lazy` 获得的代码）。只有在 `FullReload` 已经处于待处理状态，或者服务器正在从先前广播过的构建错误中恢复时，才会触发重新加载。`Rebuild` 任务从不生成 HMR 更新，并且只与其他 `Rebuild` 合并，因此 `?rolldown-lazy=1` 这个伪路径绝不会泄漏到 HMR 更新计算中——不过插件会通过 `watch_change` 钩子观察到它一次。

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

## 实现细节

### 模块 ID 格式

**重要**：所有运行时模块查找都使用**稳定 ID**（`stable_id`），即相对于当前工作目录（cwd）的路径（例如 `src/module.js`）。该 ID 通过在 `build_start` hook 中捕获 cwd，然后调用 `ModuleId::new(id).stabilize(cwd)` 计算得到。

这确保了以下内容之间的一致性：

- 存根中的 `delete __rolldown_runtime__.modules[stableProxyId]` / `loadExports(stableProxyId)` 调用
- 编译后的模块包装器：`createEsmInitializer("src/module.js", ...)`（在包装器主体内部，`registerModule` / `createModuleHotContext` 通过 `__rolldown_module_id__` 参数接收此 ID）
- `import.meta.hot.accept("src/dep.js", ...)` 导入说明符
- `applyUpdates([["src/boundary.js", "src/acceptedVia.js"]])` 边界

绝对路径只在两个地方保留：`/@vite/lazy?id=` 查询值（代理 ID）以及所获取模板中的 `import($MODULE_ID)`（用于解析）。

模板使用**四个占位符**进行渲染，并且每个占位符都会被替换为一个 serde_json 引用的 JS 字符串字面量（因此模板包含不带引号的 `$PLACEHOLDER` 标记，并且 Windows 反斜杠路径能够被正确转义，#9102）：

| 占位符                     | 值                                  | 用于                                      |
| -------------------------- | ----------------------------------- | ----------------------------------------- |
| `$PROXY_MODULE_ID`         | 绝对路径 + `?rolldown-lazy=1`       | 存根 — `/@vite/lazy?id=` 请求             |
| `$STABLE_PROXY_MODULE_ID`  | 稳定 ID + `?rolldown-lazy=1`         | 存根 — 模块映射删除 + `loadExports`       |
| `$MODULE_ID`               | 绝对路径（不含查询参数）            | 所获取内容 — `import($MODULE_ID)`         |
| `$STABLE_MODULE_ID`        | 稳定 ID                              | 所获取内容 — `loadExports($STABLE_MODULE_ID)` |

`render_proxy_template` 最后替换 `$MODULE_ID`，因为其他三个占位符名称都包含 `MODULE_ID` 这一子字符串。

### 已获取状态跟踪

`LazyCompilationPlugin` 在 `LazyCompilationContext` 中维护两个集合（通过 `plugin.context()` 与 `DevEngine` 共享）：

- `lazy_entries` - 解析期间创建的所有代理模块 ID
- `fetched_entries` - 已经获取过的代理模块 ID（通过运行时的 `/lazy` 请求）

当动态导入调用 `resolve_id` 时：

1. 如果导入方是一个**已获取的代理**（`?rolldown-lazy=1` + 存在于 `fetched_entries` 中）→ 返回 `None`（跳过代理创建，解析到真实模块）
2. 否则 → 通过 `ctx.resolve` 解析说明符（`skip_self: true`，透传 `args.custom`），并追加 `?rolldown-lazy=1`。此追加操作具有**幂等性**（#9439）：`ctx.resolve` 可能会重新进入其他插件的解析钩子（例如别名插件），因此如果解析后的 ID 已经以该标记结尾，就会直接复用——重复追加后缀会使代理 ID 与存根模板中的运行时失效键不同步（该问题源自 vitejs/vite#22454，已通过别名导入说明符修复）

对已知代理 ID 的重新解析（任何导入类型——例如开发服务器将存根 ID 作为入口进行解析，以服务延迟编译请求）由延迟插件自身处理：如果说明符以 `?rolldown-lazy=1` 结尾且存在于 `lazy_entries` 中，则将其解析为自身。未知代理 ID 会继续向下传递并保持不可解析状态（参见下方的 #9969 闸门）。用户代码中的 `resolve_id` 钩子完全不会看到代理 ID——对于 `?rolldown-lazy=1` 说明符，`PluginDriver` 会跳过这些钩子——因为虚拟模块插件无法识别追加了查询参数的自身 ID，而其他任何插件也无法解析虚拟 ID（该问题源自 vitejs/vite#23124，由 `packages/rolldown/tests/dev/dev-lazy-compile.test.ts` 固定覆盖）。

当代理模块调用 `load` 时：

1. 只有存在于 `lazy_entries` 中的 ID 才会被提供服务——任何其他 `?rolldown-lazy=1` ID 都会继续向下传递并返回 `Ok(None)`
2. 如果存在于 `fetched_entries` 中 → 返回已获取模板；否则 → 返回存根模板
3. 用户代码中的构建钩子（`resolve_id`、`load`、`transform`、`transform_ast`、`module_parsed`）会跳过代理 ID（`?rolldown-lazy=1`），因此插件只会看到真实模块；延迟插件自身仍会运行，以提供存根/已获取模板。

**安全闸门——拒绝未知模块（#9969）**：传递给 `compileEntry` / `compile_lazy_entry` 的 ID 仅作为构建缓存中的查找键使用，绝不会被解析为文件系统路径。如果某个 ID 不存在于之前的构建中，它会在 `HmrStage::compile_lazy_entry` 中被拒绝，并显示 `Lazy entry module not found in cache`——因此恶意的 `/@vite/lazy` 请求无法打包任意文件（类似于 Vite 的 `server.fs.strict`；由 `packages/rolldown/tests/dev/dev-lazy-compile.test.ts` 修复）。请注意顺序：`DevEngine::compile_lazy_entry` 会在验证前无条件调用 `mark_as_fetched`，因此未知 ID 仍会进入 `fetched_entries`（无害，但在调试时值得注意）。

### 延迟 Chunk 渲染

`Bundler::compile_lazy_entry(module_id, client_id, executed_modules, next_patch_id)` → `HmrStage::compile_lazy_entry`（此层不使用 `client_id` 参数——客户端特定的裁剪完全取决于 `executed_modules`）：

1. 在模块缓存中查找代理（#9969 gate），然后运行 `ScanMode::Partial([proxy's resolved id])`
2. `collect_sync_dependencies_for_client` 遍历代理的静态依赖和代理自身的动态导入，在遇到稳定 id 存在于该客户端 `executed_modules` 中的模块时停止；外部模块会被丢弃，其余模块按 id 排序
3. 每个模块都会由 `HmrAstFinalizer` 渲染为一个初始化器包装器：

   ```js
   var init_foo = __rolldown_runtime__.createEsmInitializer(
     'src/foo.js',
     function (__rolldown_module_id__) {
       try {
         // registerModule/createModuleHotContext 使用 __rolldown_module_id__；
         // ESM 导出内容发布为：
         // var __rolldown_exports__ = __rolldown_runtime__.__exportAll({ ... })
       } finally {
       }
     },
     1,
   ); // 末尾的 `1` = 去重标志，仅用于延迟 chunk
   ```

   （CJS 模块使用 `createCjsInitializer`，以及 `__rolldown_exports__` / `__rolldown_module__`。）

4. 渲染模块中的动态导入会被重写：
   - 导入的模块 id 包含 `?rolldown-lazy=1`（嵌套延迟代理）→ ``import(`/@vite/lazy?id=${encodeURIComponent(absProxyId)}&clientId=${__rolldown_runtime__.clientId}`).then(() => __rolldown_runtime__.loadExports("<stableProxyId>"))`` ——部分 bundle 不会为代理单独打包 chunk，因此代理顶层的 `'rolldown:exports'` 导出会在初始化器包装器中丢失；通过 `loadExports` 将其读取回来，可以保留 `__unwrap_lazy_compilation_entry` 所需的导出表面（由嵌套动态导入规范修复）
   - 普通的 `import()` → `Promise.resolve().then(() => __rolldown_runtime__.loadExports("<stableId>"))`；如果被导入模块位于同一个 patch 中，则会在前面添加该模块的 `init_x()` 调用
5. chunk 以代理入口的 `init_xxx()` 调用结尾（这会使用真正的初始化器重新注册代理 id——也就是 stub 的第 3 步所等待的内容）
6. 结果会使用合成名称 `lazy_compile_{n}.js` 进行后处理（`n` 来自开发引擎的 `next_invalidate_patch_id` 计数器，该计数器与 `hmr.invalidate` patch 共享——**不是**协调器的 `hmr_patch_{n}.js` 计数器），然后以普通 JS 字符串返回

### 已发出的资源 (#9815)

延迟编译（类似 HMR 补丁）不会运行生成阶段，因此编译期间发出的资源没有 `onOutput` 路径。相反，成功时，`DevEngine::compile_lazy_entry` 会将 `file_emitter.add_additional_files` 中的内容排空到 `BundleOutput`，并在返回代码**之前**触发 `onAdditionalAssets` 开发回调——这使消费者能够在浏览器请求这些资源之前注册/提供它们（test-dev-server 会将它们放入 `memoryFiles`）；这修复了 vitejs/vite#22596，并由已发出资源规范解决。

消费者的设计约束：资源 URL 必须在 `load` 阶段尽早解析（`emitFile` + `getFileName`，就像开发服务器中 Vite 风格的资源插件一样）——在 `renderChunk` 中使用占位符方案会泄漏，因为延迟渲染路径根本不会运行 `renderChunk`。

### 构建输出刷新

延迟编译成功后，开发引擎的成功分支会依次执行两件事：

```rust
// 在 DevEngine::compile_lazy_entry 中
if result.is_ok() {
  // 1. 交付编译期间生成的资源（在代码返回之前）
  if let Some(on_additional_assets) = ... { ... }
  // 2. 将后台重建加入队列
  self.notify_module_changed(proxy_module_id);
}
```

协调器处理 `ModuleChanged`：

1. 首先调用 `update_watch_paths()`（原因请参见“数据生命周期 → 构建输出刷新”）
2. 使用原始代理 id 作为发生变更的文件，加入一个 `TaskInput::Rebuild`
3. 设置 `has_stale_bundle_output = true`
4. 如果输出已过期，则安排一次构建（仅当协调器处于 Idle/Failed 状态时立即运行；否则等待在队列中）

在**失败**时，这两个步骤都不会发生：失败的延迟编译不会将重建加入队列，存根模板会保留在构建输出中（但代理仍会被标记为已获取）。如果后台重建本身失败，消费者会缓存该错误，向每个客户端广播错误覆盖层，并取消任何待处理的整页重新加载，因此页面永远不会在构建包损坏时重新加载（#9903）；协调器进入带有过期输出的 `Failed { Rebuild }` 状态，并在下一次文件变更或页面访问时恢复。

### 错误处理

错误契约（不再是“POC — 返回 Err 或 panic 均可”）：

- **未知模块 id** → `HmrStage::compile_lazy_entry` 返回 `Err("Lazy entry module not found in cache. module_id=...")`；napi 绑定将其暴露为以 `Failed to compile lazy entry: ...` 为前缀的 rejected promise；开发服务器中间件返回 HTTP 500（缺少 `id`/`clientId` 参数时会继续调用 `next()`；成功时会设置 `Content-Type: application/javascript`）
- **初始化器错误可捕获（#9981）**：初始化 lazy 模块时抛出的错误会使重新注册的代理的 `'rolldown:exports'` promise rejected，继而使存根的 `lazyExports` rejected，最终使消费者的 `await import(...)` rejected —— `try/catch` 可正常工作；如果没有处理程序，则只会触发一次 `unhandledrejection`。此行为由 lazy-init-error 规范在**冷路径**（首次 `/lazy` 编译）和**热路径**（重建并刷新后，针对已获取的代理）中修复（#9975 添加了原始失败规范；#9981 对其进行了重写和拆分）
- **运行时 `loadExports` 未命中**不会抛出异常——它只会发出警告并返回 `{}`
- 唯一剩余的 panic：在任何 bundle 构建之前调用 `compile_lazy_entry`

### 客户端 ID

- 由 HMR 运行时在初始化期间通过 `crypto.randomUUID()` 生成（在任何惰性导入运行之前），并追加到 websocket URL（`?clientId=...` —— dev server 会以代码 1008 关闭缺少 clientId 的 socket），同时通过 `__rolldown_runtime__.clientId` 插入每个 `/@vite/lazy` 请求中
- 它在惰性编译中的唯一作用是**针对客户端裁剪补丁**：引擎会查找该客户端的 `executed_modules`，因此返回的 chunk 会省略客户端已经运行过的模块。不存在“路由”——编译后的代码会同步返回在 HTTP 响应中
- 未知的 `clientId` 会静默退化为空的已执行集合（返回完整的依赖闭包）

### 编辑已获取的懒加载模块

在 `/lazy` 之后，实际模块及其同步依赖会成为普通的受监视图模块（得益于 `update_watch_paths()`），编辑操作会经过标准的 watch → 面向客户端的 HMR 路径：

- 已获取的代理会作为普通的**不接受更新**的导入方参与其中（`hmr_info.deps` 只来自 `import.meta.hot.accept`，从不来自动态导入）。因此，编辑一个不自行接受更新的懒加载模块时，更新会沿着代理 → 动态导入方 → `NoBoundary` → `FullReload` 传播到所有执行过该模块的客户端；开发任务会将自身升级为 `HmrRebuild`，开发服务器会延迟刷新，直到重建输出到达（如果重建失败，则取消刷新，#9903）。共享模块规范中的 watch/自动重新加载测试修复了这一问题
- 如果懒加载模块自行接受更新（`import.meta.hot.accept()`），执行过该模块的客户端会收到普通的、面向客户端的 `Patch`
- 从未执行过该模块的客户端会收到一个实际上为空的 `applyUpdates([])` 补丁（参见“已获取与已执行”）

## 端到端流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. 初始构建                                                             │
├─────────────────────────────────────────────────────────────────────────┤
│  - 入口 + 同步依赖正常编译                                              │
│  - 动态导入（import()）→ 替换为代理模块                                 │
│  - 代理模块 ID: /abs/path/module.js?rolldown-lazy=1                    │
│  - 代理包含存根模板（通过 /@vite/lazy 端点获取）                       │
│  - 代理导出 'rolldown:exports' Promise                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. 浏览器加载初始 bundle                                               │
├─────────────────────────────────────────────────────────────────────────┤
│  - 运行时初始化；clientId = crypto.randomUUID()                         │
│  - 代理以其稳定 ID 注册：                                                │
│      registerModule("src/module.js?rolldown-lazy=1", { exports })      │
│  - 存根模板已准备好按需拉取                                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. 用户代码触发：import('./lazy-module')                               │
├─────────────────────────────────────────────────────────────────────────┤
│  - 代理模块执行（存根模板）                                             │
│  - 删除自身的运行时注册（这样 chunk 才能重新注册）                      │
│  - 获取：/@vite/lazy?id=/abs/path/lazy-module.js?rolldown-lazy=1&clientId=xxx
│  - 浏览器等待该 Promise                                                │
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
│  - 存根解析：loadExports(stableProxyId)['rolldown:exports']             │
│  - 原始 import() Promise 解析（或可捕获地拒绝，#9981）                  │
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

### 问题 12：来自外部模块的重导出必须保留真实导入（#10478）

**问题**：dev 运行时注册表只保存由本次构建包装的模块，因此外部模块不会出现在其中——`loadExports('<external id>')` 会警告 `Module <id> not found` 并返回 `{}`。HMR 收尾器的普通导入分支了解这一点，并生成了一个真实的 `import * as X from 'ext'`，将其提升到包装器之外；但三个重导出分支（`export * from`、`export * as ns from`、`export { x } from`）没有这样做，而是改为从注册表读取。每个重导出的名称都会静默地解析为 `undefined`。当同一个模块还导入了该外部模块时，两个分支都会通过 `ensure_static_import_info` 为绑定命名，但会分别针对不同的集合进行去重，因此两个声明会使用同一个名称生成——由于真实导入位于 chunk 顶层，而 `var` 位于工厂函数内部，`var` 会合法地遮蔽真实导入，模块自身对该外部模块的使用也会因此出错。

**解决方案**：让四个分支统一通过一个 `create_importee_binding_stmt`，由它为普通模块选择 `loadExports`，为外部模块选择真实的 import 语句。这样每种类型的去重集合会从设计上保持互斥，因此不会生成造成遮蔽的 `var`。由 `crates/rolldown/tests/rolldown/topics/hmr/reexport_external/`（HMR 补丁、执行场景）以及 `dev-lazy-compile.test.ts` 中的一个测试用例（懒块）固定。

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
| `lazy-init-error`            | 可通过 try/catch 捕获初始化错误——冷路径和热路径（#9975/#9981）          |
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
12. **`crates/rolldown/src/hmr/utils.rs`** - 注册模块 / 热上下文语句构建器（`__rolldown_module_id__` 参数）
13. **`crates/rolldown/src/bundler/impl_bundler_hmr.rs`** - `Bundler::compile_lazy_entry` 入口点
14. **`crates/rolldown_plugin_hmr/src/runtime/runtime-extra-dev-common.js`** - 浏览器运行时：`createEsm/CjsInitializer`（去重门控）、`registerModule`、`loadExports`、模块已注册批处理

### 参考开发服务器（Vite 完整打包模式，位于 `vite/`（仓库根目录））

15. **`packages/vite/src/node/server/middlewares/triggerLazyBundling.ts`** - `/@vite/lazy` 中间件（出错时返回 500，成功时返回 `application/javascript`）
16. **`packages/vite/src/node/server/bundledDev.ts`** - `triggerLazyBundling`（`devEngine.compileEntry`）、`onAdditionalAssets` 存储、重建/重载处理
17. **`packages/vite/src/node/plugins/asset.ts`** - bundled-dev 分支在 `load` 时会提前解析资源导入。

## 参考资料

- [design.md](./design.md) — 目标、范围和关键设计决策
- 当前实现：`crates/rolldown_plugin_lazy_compilation/`
- 开发引擎：`crates/rolldown_dev/`（另见 `internal-docs/dev-engine/`）
- 示例：`examples/lazy-compilation/`。
