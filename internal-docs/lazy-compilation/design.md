# 懒加载编译 — 设计

> 实现细节——数据生命周期、模块 ID 处理、端到端流程以及经验总结：参见 [implementation.md](./implementation.md)。

## 关键要点（TL;DR）

1. **透明的用户体验** - `import('./module')` 直接可用，无需用户代码改动（未来目标）
2. **仅支持动态导入** - 静态导入始终会立即编译
3. **`rolldown:exports` 协议** - 代理模块导出该内容；POC 使用 `lazyMagic` 辅助函数，之后 Rolldown 运行时会自动解包
4. **编译粒度** - 懒加载模块 + 所有同步依赖；嵌套的 `import()` 会成为新的懒加载边界
5. **开发服务器直接返回 JS** - `/lazy` 请求返回编译后的代码，浏览器将其作为 ES 模块加载
6. **模块 ID** - 在运行时全程一致使用**绝对路径**（`module.id`）
7. **代理模块状态** - 代理模块有两种状态：**未获取**（stub 模板）和**已获取**（导入真实模块）
8. **构建输出刷新** - 懒加载编译后，开发引擎会触发重新构建以更新构建输出
9. **缓存** - AST 在内部缓存；POC 允许不同入口之间重复执行
10. **错误处理** - 对 POC 来说，`Err` 或 panic 都可以
11. **ClientId** - 跟踪多个浏览器标签页/客户端

## 什么是懒加载编译？

懒加载编译是一种**开发期优化**，它会将动态导入模块的编译推迟到运行时真正请求它们的时候。

### 目标

1. **更快的冷启动** - 启动时只编译入口点及其同步依赖
2. **按需编译** - `import()` 后面的代码会在浏览器执行到它时即时编译
3. **对用户透明** - 无需修改代码；`import('./foo')` 应该直接可用

## 范围

- **仅支持动态导入**（`import()`）- 静态导入始终会被编译
- **独立特性** - 复用 HMR 运行时/渲染路径来输出模块，但不发出 HMR 更新

## 编译粒度

当请求一个懒加载模块时：

- 编译**该模块 + 它所有的同步依赖**
- 嵌套的动态导入（懒加载模块中的 `import()`）**不会**被编译 - 它们会成为各自独立的懒加载边界
- 这会在每个动态导入处形成自然的“懒加载边界”

```
Entry
├── sync-dep-1 (立即编译)
├── sync-dep-2 (立即编译)
└── import('./lazy-a')  ← 懒加载边界
    ├── sync-dep-3 (在请求 lazy-a 时编译)
    ├── sync-dep-4 (在请求 lazy-a 时编译)
    └── import('./lazy-b')  ← 另一个懒加载边界（尚未编译）
```

## 关键设计决策

### 1. 透明的用户体验

用户不应该需要修改代码。`import('./module')` 直接可用。

### 2. `rolldown:exports` 协议

代理模块导出一个特殊的命名导出 `'rolldown:exports'`：

```js
// 用于懒加载 ./foo.js 的代理模块（未执行状态）
const lazyExports = (async () => {
  await import(`/@vite/lazy?id=${encodeURIComponent($PROXY_MODULE_ID)}&clientId=...`);
  return __rolldown_runtime__.loadExports($MODULE_ID);
})();

export { lazyExports as 'rolldown:exports' };
```

- `'rolldown:exports'` 是一个会解析为真实模块导出的 Promise
- Rolldown 的 `transform_ast` 钩子会自动用解包辅助函数包装所有动态导入：

  ```js
  // 用户代码（未改动）
  const mod = await import('./lazy.js');

  // 由懒加载编译插件转换后
  const mod = await import('./lazy.js').then(__unwrap_lazy_compilation_entry);
  ```

- 这对**所有**动态导入都是安全的：懒加载模块返回 Promise，非懒加载模块则保持不变

- 辅助函数会注入到每个包含动态导入的模块中：

  ```js
  function __unwrap_lazy_compilation_entry(m) {
    var e = m['rolldown:exports'];
    return e ? e : m;
  }
  ```

### 3. 代理模块状态

代理模块有两种状态，用于决定 `LazyCompilationPlugin` 返回什么内容：

#### 未执行（初始状态）

返回通过 `/lazy` 端点获取的 **stub 模板**：

```js
// proxy-module-template.js
const lazyExports = (async () => {
  await import(
    `/@vite/lazy?id=${encodeURIComponent($PROXY_MODULE_ID)}&clientId=${__rolldown_runtime__.clientId}`
  );
  return __rolldown_runtime__.loadExports($MODULE_ID);
})();

export { lazyExports as 'rolldown:exports' };
```

#### 已获取（第一次请求后）

返回直接导入真实模块的 **fetched 模板**：

```js
// proxy-module-template-fetched.js
const lazyExports = (async () => {
  const mod = await import($MODULE_ID);
  return mod;
})();

export { lazyExports as 'rolldown:exports' };
```

状态迁移由 `LazyCompilationContext.mark_as_fetched()` 管理。

### 4. 开发服务器集成

开发服务器处理 `/@vite/lazy?id=...&clientId=...` 请求：

1. 接收带有**代理模块 ID**的请求（例如 `/abs/path/foo.js?rolldown-lazy=1`）
2. 调用 `DevEngine.compile_lazy_entry(proxyModuleId, clientId)`（Rust）/ `DevEngine.compileEntry(moduleId, clientId)`（TS）
3. DevEngine 将该代理标记为已获取
4. 从代理模块进行部分扫描 - 插件返回 fetched 模板
5. fetched 模板中的 `import($MODULE_ID)` 触发真实模块的编译
6. **直接返回编译后的 JS** - 浏览器将其作为 ES 模块加载
7. **通知协调器** - 触发重新构建以更新未来页面加载时的构建输出

## 相关内容

- [implementation.md](./implementation.md) — 懒加载编译实现
