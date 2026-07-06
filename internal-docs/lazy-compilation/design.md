# 懒加载编译 — 设计

> 实现细节——数据生命周期、模块 ID 处理、端到端流程以及经验总结：参见 [implementation.md](./implementation.md)。

## 关键要点（TL;DR）

1. **透明的 UX** - `import('./module')` 直接可用；插件会自动重写动态导入并解包代理导出
2. **仅动态导入** - 静态导入总是会立即编译。边界创建与模块类型无关（见 Scope）
3. **`rolldown:exports` 契约** - 代理模块导出这个命名导出；插件的 `transform_ast` 会在非代理模块中的每个动态导入后链式追加 `.then(__unwrap_lazy_compilation_entry)`
4. **编译粒度** - 惰性模块 + 请求客户端尚未执行的同步依赖；嵌套的 `import()` 会变成新的惰性边界
5. **开发服务器直接返回 JS** - `/@vite/lazy` 返回编译后的代码，作为单个 JS 字符串；浏览器将其作为 ES 模块加载（只有内联 sourcemap 会保留——见 implementation.md）
6. **模块 ID** - 运行时模块映射查询使用**稳定 ID**（相对于 cwd）；绝对路径仅出现在 `/@vite/lazy?id=` 参数以及获取到的模板里的 `import($MODULE_ID)`
7. **代理模块状态** - 代理有两种状态：**未获取**（stub 模板）和 **已获取**（导入真实模块）
8. **构建输出刷新** - 在惰性编译后，开发引擎会触发后台重建以更新构建输出；该重建对已连接客户端是静默的
9. **去重** - 服务器会从惰性补丁中剔除客户端已经执行过的模块，且惰性 chunk 初始化器携带运行时去重标志 —— 共享模块绝不会执行两次
10. **错误处理** - 未知模块 id 会被拒绝（安全门，#9969）；惰性模块中的初始化错误会让消费者的 `await import()` 以可捕获的方式拒绝（#9981）
11. **ClientId** - 浏览器为每个标签页生成的 UUID；用于选择每个客户端的 `executed_modules` 集合，以便对惰性补丁进行裁剪

## 什么是懒加载编译？

懒加载编译是一种**开发期优化**，它会将动态导入模块的编译推迟到运行时真正请求它们的时候。

### 目标

1. **更快的冷启动** - 启动时只编译入口点及其同步依赖
2. **按需编译** - `import()` 后面的代码会在浏览器执行到它时即时编译
3. **对用户透明** - 无需修改代码；`import('./foo')` 应该直接可用

## 启用

懒加载编译是可选启用的，嵌套在开发模式中：

```js
export default {
  experimental: {
    devMode: { lazy: true },
  },
};
```

- 仅 `devMode` 就会启用 dev/HMR 机制（`HmrPlugin`）；`lazy: true` 会在用户插件之前额外前置 `LazyCompilationPlugin`（`crates/rolldown/src/utils/apply_inner_plugins.rs`）。
- 该插件的 `context()` 会将共享的 `lazy_entries` / `fetched_entries` 集合暴露为 `LazyCompilationContext`，并传递给 `DevEngine`，以便它在每次懒加载编译之前调用 `mark_as_fetched`。
- rolldown-vite 的打包开发模式默认启用 `lazy: true`。

## 范围

- **仅动态导入**（`import()`）- 静态导入始终会被编译
- **独立特性** - 复用 HMR 运行时/渲染路径来输出模块。`/@vite/lazy` 请求本身不会触发任何 HMR 更新——但一旦获取到，懒加载模块就会成为一个普通的、受监视的图模块，之后对它的编辑会通过正常的按客户端 HMR 管道流动（参见 implementation.md“编辑已获取的懒加载模块”）
- **对模块类型不敏感的边界** - `resolve_id` 会代理 _每一个_ 动态导入，没有扩展名或模块类型过滤，因此真实目标直到第一次 `/@vite/lazy` 请求时才会被加载。编译单元中的所有内容都必须渲染为 ECMAScript AST：
  - **CSS** - 在 rolldown 中不受支持（已移除，#4271）；懒加载编译会将这一硬错误从服务器启动时延后到第一次 `/lazy` 请求时（HTTP 500，在消费者的 `await import()` 处表现为可捕获的拒绝）
  - **JSON / text / base64 / dataurl** - 目前在懒加载 chunk 中有问题：它们的导出是在链接时合成的，而懒加载渲染路径会跳过这一步，所以它们会注册为空导出，直到重新构建 + 页面刷新（参见 implementation.md 已知限制）
  - **二进制资源** - 仅当插件在其 `load` 钩子中将它们转换为 JS 时才可用（例如 dev server 的 Vite 风格资源插件）；发出的字节通过 `onAdditionalAssets` 传递（#9815）
- 编译单元包含懒加载模块的所有静态依赖，而 `new URL(...)` 引用也算作静态依赖

## 编译粒度

当请求一个懒加载模块时：

- 编译 **该模块 + 其同步依赖** —— 不包括请求方客户端已经执行过的任何模块（通过 `executed_modules` 进行按客户端裁剪）
- 嵌套动态导入（懒加载模块中的 `import()`）**不会**被编译——它们会成为各自独立的懒加载边界
- 这会在每个动态导入处形成一个自然的“懒加载边界”

```
Entry
├── sync-dep-1 (立即编译)
├── sync-dep-2 (立即编译)
└── import('./lazy-a')  ← 懒加载边界
    ├── sync-dep-3 (在请求 lazy-a 时编译)
    ├── sync-dep-4 (在请求 lazy-a 时编译)
    └── import('./lazy-b')  ← 另一个懒加载边界（尚未编译）
```

在已渲染的懒加载 chunk（或 HMR patch）内部，另一个懒代理的嵌套 `import()` 会被 HMR finalizer 重写为获取 `/@vite/lazy?...`，然后通过 `loadExports(stableProxyId)` 读取该代理注册的导出——部分包没有单独打包的代理 chunk，因此否则代理的顶层导出会丢失（参见 implementation.md 中的 “Lazy chunk rendering”）。

## 关键设计决策

### 1. 透明的用户体验

用户不应该需要修改代码。`import('./module')` 直接可用。

### 2. `rolldown:exports` 协议

代理模块导出一个特殊的命名导出 `'rolldown:exports'`——一个会解析为真实模块导出的 promise（如果真实模块在初始化过程中抛错，则会**拒绝**，这也是为什么初始化错误可以在消费者的 `await import()` 处被捕获，#9981）。

Rolldown 的 `transform_ast` 钩子会自动用一个解包辅助函数包装动态导入：

```js
// 用户代码（未改动）
const mod = await import('./lazy.js');

// 由 lazy compilation 插件转换后
const mod = await import('./lazy.js').then(__unwrap_lazy_compilation_entry);
```

- 该辅助函数会被注入到每个至少有一个动态导入被包装的模块中（在任何 directive prologues 之后）：

  ```js
  function __unwrap_lazy_compilation_entry(m) {
    var e = m['rolldown:exports'];
    return e ? e : m;
  }
  ```

- 这对所有动态导入都是安全的：lazy 代理会返回 promise，非 lazy 模块则原样透传
- 代理模块本身（id 包含 `?rolldown-lazy=1`）是**例外**：`transform_ast` 会跳过它们，因此 stub 中的 `import('/@vite/lazy?...')` 和 fetched template 中的 `import($MODULE_ID)` 都不会被包装

代理模块有两种状态，用于决定 `LazyCompilationPlugin` 返回什么内容：

#### 未获取（初始状态）

#### Not Fetched (Initial State)

返回 **stub 模板**（`proxy-module-template.js`），它通过 `/@vite/lazy` 端点进行拉取：

```js
const lazyExports = (async () => {
  // 从运行时模块映射中移除当前模块的缓存。
  // 这个键为 $STABLE_PROXY_MODULE_ID 的模块会在懒加载 chunk 中再次被替换为带有真实模块的版本。
  delete __rolldown_runtime__.modules[$STABLE_PROXY_MODULE_ID];
  // 开发服务器会拦截这个 import 并提供实际的模块代码。
  // 我们发送代理模块 ID（带 ?rolldown-lazy=1），以便服务器可以将其标记为已获取。
  await import(
    /* @vite-ignore */ `/@vite/lazy?id=${encodeURIComponent($PROXY_MODULE_ID)}&clientId=${__rolldown_runtime__.clientId}`
  );
  // 加载 chunk 会重新注册这个代理 id，并将真实模块的
  // 初始化器作为它自己的 `rolldown:exports` promise 暴露出来。等待该 promise（不要
  // 只把命名空间直接返回），这样如果真实模块在
  // 初始化时抛错，`lazyExports` 也会被拒绝，从而在消费者的
  // `await import(...)` 处暴露为可捕获错误，而不是以未处理的 rejection 形式逃逸。
  return await __rolldown_runtime__.loadExports($STABLE_PROXY_MODULE_ID)['rolldown:exports'];
})();

export { lazyExports as 'rolldown:exports' };
```

三个步骤：(1) 清除代理在运行时中陈旧的注册，以便 lazy chunk 可以用真实的初始化器重新注册相同的稳定代理 id；(2) 拉取 lazy chunk；(3) 通过**重新注册的代理自身的 `'rolldown:exports'` promise** 进行解析——这是一个两级 promise 链，其拒绝语义使初始化错误可被捕获。

#### 已获取（首次请求后）

返回 **fetched 模板**（`proxy-module-template-fetched.js`），它会导入真实模块：

```js
const lazyExports = (async () => {
  await import($MODULE_ID);
  return __rolldown_runtime__.loadExports($STABLE_MODULE_ID);
})();

export { lazyExports as 'rolldown:exports' };
```

导入结果（命名空间）会被刻意丢弃：导出会通过稳定 id 从运行时注册表中读取，因为当共享的 lazy 模块落入公共 chunk 时，chunk 级别的重命名可能会将导出名压缩掉（#9132）。`$MODULE_ID` 是绝对路径（仅用于解析）；`$STABLE_MODULE_ID` 是相对于当前工作目录的稳定 id。

状态转换由 `LazyCompilationContext.mark_as_fetched()` 管理。

### 4. 开发服务器集成

开发服务器处理 `/@vite/lazy?id=...&clientId=...` 请求：

1. 接收带有**代理模块 ID**（带 `?rolldown-lazy=1` 的绝对路径）以及客户端 UUID 的请求
2. 调用 `DevEngine.compileEntry(moduleId, clientId)`（TS）/ `DevEngine::compile_lazy_entry`（Rust）
3. DevEngine 查找该客户端的 `executed_modules` 并将该代理标记为已获取
4. **安全门控**：该 id 只是构建缓存中的一个查找键——不在模块图中的 id 会被拒绝，并返回 `Lazy entry module not found in cache`（不会从文件系统解析，因此恶意请求无法打包任意文件；这与 Vite 的 `server.fs.strict` 类似，并由测试固定，#9969）
5. 从代理模块进行部分扫描 - 插件返回 fetched 模板，而其中的 `import($MODULE_ID)` 会触发实际模块的编译
6. 编译过程中生成的资源会在代码返回之前通过 `onAdditionalAssets` 回调交付，因此当 chunk 执行时它们已经可以被提供（#9815）
7. **直接返回已编译的 JS**（`Content-Type: application/javascript`）——浏览器将其作为 ES module 加载；编译失败则返回 HTTP 500
8. **通知协调器** - 触发后台重建，使未来的页面加载无需 `/lazy` 请求即可获得 fetched 模板

## 相关内容

- [implementation.md](./implementation.md) — 懒加载编译实现
