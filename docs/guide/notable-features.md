# 显著特性

本页记录了 Rolldown 中一些在 Rollup 中没有内置对应项的显著特性。

## 平台预设

- 可通过 [`platform`](/reference/InputOptions.platform) 选项配置。
- 默认值：`cjs` 输出时为 `'node'`，否则为 `'browser'`
- 可能的值：`browser | node | neutral`

类似于 [esbuild 的 `platform` 选项](https://esbuild.github.io/api/#platform)，此选项在模块解析以及如何处理 `process.env.NODE_ENV` 方面提供了一些合理的默认值。

**与 esbuild 的显著差异：**

- 无论平台如何，默认输出格式始终为 `esm`。

:::tip
当目标为浏览器时，Rolldown 不会为 Node 内置模块提供 polyfill。你可以通过 [rolldown-plugin-node-polyfills](https://github.com/rolldown/rolldown-plugin-node-polyfills) 选择启用它。
:::

## 内置转换

Rolldown 默认支持以下转换，由 [Oxc](https://oxc.rs/docs/guide/usage/transformer) 提供支持。
该转换可通过 [`transform`](/reference/InputOptions.transform) 选项配置。
支持以下转换：

- TypeScript
  - 当提供了 [`tsconfig`](/reference/InputOptions.tsconfig) 选项时，会根据 `tsconfig.json` 设置配置。
  - 支持旧版装饰器和装饰器元数据。
- JSX
- 语法降级
  - 自动将现代语法转换为与你定义的目标兼容的形式。
  - 支持 [降级到 ES2015](https://oxc.rs/docs/guide/usage/transformer/lowering#transformations)。

## CJS 支持

Rolldown 默认支持混合的 ESM / CJS 模块图，无需 `@rollup/plugin-commonjs`。它在很大程度上遵循 esbuild 的语义，并且 [通过了所有 esbuild ESM / CJS 互操作测试](https://github.com/rolldown/bundler-esm-cjs-tests)。

更多详情请参见 [打包 CJS](/in-depth/bundling-cjs)。

## 模块解析

- 可通过 [`resolve`](/reference/InputOptions.resolve) 选项配置
- 由 [oxc-resolver](https://github.com/oxc-project/oxc-resolver) 提供支持，与 webpack 的 [enhanced-resolve](https://github.com/webpack/enhanced-resolve) 保持一致

默认情况下，Rolldown 会根据 TypeScript 和 Node.js 的行为解析模块，无需 `@rollup/plugin-node-resolve`。

当提供顶层 [`tsconfig`](/reference/InputOptions.tsconfig) 选项时，Rolldown 会遵循指定 `tsconfig.json` 中的 `compilerOptions.paths`。

## Define

- 可通过 [`transform.define`](/reference/InputOptions.transform#define) 选项配置。

此功能提供了一种用常量表达式替换全局标识符的方法。与 [Vite](https://vite.dev/config/shared-options.html#define) 和 [esbuild](https://esbuild.github.io/api/#define) 中相应的选项保持一致。

::: tip `@rollup/plugin-replace` 行为不同

请注意，它与 [`@rollup/plugin-replace`](https://github.com/rollup/plugins/tree/master/packages/replace) 的行为不同，因为替换是基于 AST 的，因此要被替换的值必须是一个有效的标识符或成员表达式。为此请使用内置的 [`replacePlugin`](/builtin-plugins/replace)。

:::

## Inject

- 可通过 [`transform.inject`](/reference/InputOptions.transform#inject) 选项配置。

此功能提供了一种用从模块导出的特定值来模拟全局变量的方法。该功能等同于 [`@rollup/plugin-inject`](https://github.com/rollup/plugins/tree/master/packages/inject)，在概念上类似于 [esbuild 的 `inject` 选项](https://esbuild.github.io/api/#inject)。

## CSS 打包

- ⚠️ 实验性

Rolldown 默认支持打包从 JS 中导入的 CSS。请注意，此功能目前不支持 CSS Modules 和压缩。

## 手动代码拆分

- 可通过 [`output.codeSplitting`](/reference/OutputOptions.codeSplitting) 选项配置。

Rolldown 允许更细粒度地控制 chunk 划分行为，类似于 webpack 的 [`optimization.splitChunks`](https://webpack.js.org/plugins/split-chunks-plugin/#optimizationsplitchunks) 功能。

更多详情请参见 [手动代码拆分](/in-depth/manual-code-splitting)。

## 模块类型

- ⚠️ 实验性

这在概念上类似于 [esbuild 的 `loader` 选项](https://esbuild.github.io/api/#loader)，允许用户通过 [`moduleTypes`](/reference/InputOptions.moduleTypes) 选项将文件扩展名全局关联到内置模块类型，或者在插件钩子中指定特定模块的模块类型。更多细节请见 [这里](/in-depth/module-types)。

## 压缩

- 可通过 [`output.minify`](/reference/OutputOptions.minify) 选项配置。

压缩由 [Oxc Minifier](https://oxc.rs/docs/guide/usage/minifier) 提供支持。更多详情请参见其文档。
