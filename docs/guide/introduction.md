# 介绍

## 什么是打包器

在 JavaScript 开发中，打包器负责将小块代码（ESM 或 CommonJS 模块）编译成更大、更复杂的内容，例如库或应用程序。

对于 Web 应用程序，这会让你的应用加载和运行速度显著更快（即使使用 HTTP/2）。对于库而言，这可以避免你的使用方应用再次对源码进行打包，同时也能提升运行时执行性能。

如果你想了解更多细节，我们写了一篇关于[为什么仍然需要打包器](/in-depth/why-bundlers)的深入分析。

## 为什么选择 Rolldown

Rolldown 主要是为了在 [Vite](https://vite.dev/) 中充当底层打包器而设计的，目标是用一个统一的构建工具替换 [esbuild](https://esbuild.github.io/) 和 [Rollup](https://rollupjs.org/)（它们目前作为依赖被 Vite 使用）。以下是我们从头实现一个新打包器的原因：

- **性能**：Rolldown 使用 Rust 编写。它的性能与 esbuild 处于同一水平，并且比 [Rollup 快 10~30 倍](https://github.com/rolldown/benchmarks)。它的 WASM 构建版本也比 [esbuild 的显著更快](https://x.com/youyuxi/status/1869608132386922720)（这是由于 Go 的 WASM 编译优化不够理想）。

- **生态兼容性**：Rolldown 支持与 Rollup / Vite 相同的插件 API，确保与 Vite 现有生态兼容。

- **附加特性**：Rolldown 提供了一些 Vite 所需但 esbuild 和 Rollup 很可能不会实现的重要特性（如下所述）。

尽管 Rolldown 是为 Vite 设计的，但它也完全可以作为独立的通用打包器使用。在大多数情况下，它可以直接替代 Rollup；当需要更好的分包控制时，也可以作为 esbuild 的替代方案。

## Rolldown 的特性范围

Rolldown 提供了与 Rollup 大体兼容的 API（尤其是插件接口），并且具备类似的 tree-shaking 能力，用于优化包体积。

不过，Rolldown 的特性范围更接近 esbuild，内置提供以下[附加特性](./notable-features)：

- 平台预设
- TypeScript / JSX / 语法降级转换
- 与 Node.js 兼容的模块解析
- ESM / CJS 模块互操作
- `define`
- `inject`
- CSS 打包（实验性）
- 压缩（进行中）

Rolldown 还有一些概念在 esbuild 中有对应实现，但在 Rollup 中不存在：

- [模块类型](./notable-features#module-types)（实验性）
- [插件钩子过滤器](/apis/plugin-api/hook-filters)

最后，Rolldown 还提供了一些 esbuild 和 Rollup 没有实现（也可能无意实现）的特性：

- [手动代码拆分](./notable-features#manual-code-splitting)
- HMR 支持（进行中）

## 致谢

如果没有我们从其他打包器如 [esbuild](https://esbuild.github.io/)、[Rollup](https://rollupjs.org/)、[webpack](https://webpack.js.org/) 和 [Parcel](https://parceljs.org/) 中学到的经验，Rolldown 就不会存在。我们对这些重要项目的作者和维护者怀有最大的敬意与感激。
