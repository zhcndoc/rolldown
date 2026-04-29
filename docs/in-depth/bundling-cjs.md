# Bundling CJS

Rolldown 为 CommonJS 模块提供一等支持。本文档解释了 Rolldown 如何处理 CJS 模块，以及它们与 ES 模块之间的互操作性。

## 关键特性

### 原生 CJS 支持

Rolldown 会自动识别并处理 CommonJS 模块，无需任何额外的插件或包。这种原生支持意味着：

- 无需安装额外依赖
- 与基于插件的方案相比性能更好

### 按需执行

Rolldown 保留了 CommonJS 模块的按需执行语义，这是 CommonJS 模块系统的一项关键特性。这意味着模块只有在真正被 require 时才会执行。

下面是一个示例：

```js
// index.js
import { value } from './foo.js';

const getFooExports = () => require('./foo.js');

// foo.js
module.exports = { value: 'foo' };
```

打包后会生成：

```js
// #region \0rolldown/runtime.js
// ...运行时代码
// #endregion

// #region foo.js
var require_foo = __commonJS({
  'foo.js'(exports, module) {
    module.exports = { value: 'foo' };
  },
});

// #endregion
// #region index.js
const getFooExports = () => require_foo();
// #endregion
```

在这个示例中，`foo.js` 模块在调用 `getFooExports()` 之前不会执行，从而保持了 CommonJS 的懒加载行为。

### ESM/CJS 互操作性

Rolldown 提供了 ES 模块与 CommonJS 模块之间的无缝互操作。

ESM 从 CJS 导入的示例：

```js
// index.js
import { value } from './foo.js';

console.log(value);

// foo.js
module.exports = { value: 'foo' };
```

打包输出：

```js
// #region \0rolldown/runtime.js
// ...运行时代码
// #endregion

// #region foo.js
var require_foo = __commonJS({
  'foo.js'(exports, module) {
    module.exports = { value: 'foo' };
  },
});

// #endregion
// #region index.js
var import_foo = __toESM(require_foo());
console.log(import_foo.value);

// #endregion
```

`__toESM` 辅助函数确保 CommonJS 导出会被正确转换为 ES 模块格式，从而可以无缝访问导出的值。

## 注意事项

### `require` 外部模块

默认情况下，Rolldown 会尽量保持 `require` 的语义，不会把针对外部模块的 `require` 转换为 `import`。这是因为 `require` 的语义与 ES 模块中的 `import` 不同。例如，`require` 是延迟求值的，而 `import` 会在代码执行之前求值。

::: tip 仍然想把 `require` 转换为 `import`？

如果你想把 `require` 调用转换为 `import` 语句，可以使用 [内置的 `esmExternalRequirePlugin`](/builtin-plugins/esm-external-require)。

:::

对于 [`platform: 'node'`](../guide/notable-features.md#platform-presets)，Rolldown 会基于 [`module.createRequire`](https://nodejs.org/docs/latest/api/module.html#modulecreaterequirefilename) 生成一个 `require` 函数。这会完全保留 `require` 的语义。需要注意的是，与转换为 `import` 相比，这种方式有两个缺点：

1. 运行时需要支持 `module.createRequire`，在某些部分兼容 Node 的环境中可能不可用
2. 不适合期望以被打包形式发布的库，因为 `require` 函数会成为一个局部变量，这会让打包器更难静态分析代码

对于其他平台，Rolldown 会保持原样不变，允许运行环境提供一个 `require` 函数，或者手动注入一个。例如，你可以使用 [`inject` 功能](../guide/notable-features.md#inject) 注入一个返回通过 `import` 获取的值的 `require` 函数。

::: code-group

```js [rolldown.config.js]
import path from 'node:path';
export default {
  inject: {
    require: path.resolve('./require.js'),
  },
};
```

```js [require.js]
import fs from 'node:fs';

export default (id) => {
  if (id === 'node:fs') {
    return fs;
  }
  throw new Error(`不允许 require ${JSON.stringify(id)}。`);
};
```

:::

### 来自 CJS 模块的歧义 `default` 导入

在生态系统中，处理来自 CJS 模块的导入有两种常见方式。虽然 Rolldown 会尝试自动支持这两种解释，但它们对于 `default` 导入来说是**不兼容**的。在这种情况下，Rolldown 会使用类似 [Webpack](https://webpack.js.org/) 和 [esbuild](https://esbuild.github.io/) 的启发式规则来确定 `default` 导入的值。

如果满足下面任一条件，那么 `default` 导入就是被导入的 CJS 模块的 `module.exports` 值。否则，`default` 导入就是被导入的 CJS 模块的 `module.exports.default` 值。

- 导入方是 `.mjs` 或 `.mts`
- （当它是动态导入时）导入方是 `.cjs` 或 `.cts`
- 导入方最近的 `package.json` 中 `type` 字段设置为 `module`
- （当它是动态导入时）导入方最近的 `package.json` 中 `type` 字段设置为 `commonjs`
- 被导入的 CJS 模块的 `module.exports.__esModule` 值未设置为 `true`

:::: details 详细行为

假设有如下 ESM 导入方模块和 CJS 被导入方模块：

::: code-group

```js [index.js]
import foo from './importee.cjs';
console.log(foo);
```

```js [importee.cjs]
Object.defineProperty(module.exports, '__esModule', {
  value: true,
});
module.exports.default = 'foo';
```

:::

在第一种解释中，也就是 [Babel](https://babel.dev/) 的解释方式，这段代码会打印 `foo`。在这种解释下，行为会根据 `__esModule` 标志而改变。`__esModule` 通常由转换器设置，用于表示该模块原本是用 ESM 语法编写的（例如这里的 `export default 'foo'`），并已被转换为 CJS 语法。这样处理的原因是，转换后的模块应当与未经转换时表现一致。[`@rollup/plugin-commonjs`](https://github.com/rollup/plugins/tree/master/packages/commonjs) 默认使用这种解释方式。

在第二种解释中，也就是 Node.js 的解释方式，这段代码会打印 `{ default: 'foo' }`。这样处理的原因是，CJS 模块可以动态设置导出键，而 ESM 要求导出键在静态上已知，因此为了允许访问所有导出，整个 `module.exports` 会作为默认导出暴露出来。`@rollup/plugin-commonjs` 在设置了 `defaultIsModuleExports: false` 时使用这种解释方式。

这两种解释对于 `default` 导入期望不同的值，而 Rolldown 必须决定使用哪一种。

::::

:::: details 这种启发式规则的依据是什么？

Rolldown 的启发式规则基于这样一个假设：受 Node.js 模块判定概念影响的文件，应当能够在 Node.js 中运行。对于 ESM 文件而言，要能在 Node.js 中运行，它们需要使用 `.mjs`，或者其最近的 `package.json` 中 `type` 字段被设置为 `module`（[这样才会使用 ESM 加载器](https://nodejs.org/api/packages.html#determining-module-system)），并且代码应当以符合 Node.js 解释方式的形式编写。另一方面，对于使用 ESM 语法编写、但在 Node.js 的模块判定概念中未被标记为 ESM 的文件，这些代码很可能会被其他工具转换，而这些工具通常遵循 Babel 的解释方式。

::::

#### 给库作者的建议

如果你正在编写新代码，我们强烈建议你**以 ESM 语法发布你的代码**。随着 Node.js 中已提供 [require(ESM) 功能](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require)，这样做不会有太大的障碍。
如果你仍然需要以 CJS 语法发布代码，我们强烈建议你**避免使用 `default` 导出**。

当从 CJS 模块导入默认导出时，我们建议编写能够同时处理这两种解释的代码。例如，你可以使用下面的代码同时兼容两种解释：

```js
import rawFoo from './importee.cjs';
const foo =
  typeof rawFoo === 'object' && rawFoo !== null && rawFoo.__esModule ? rawFoo.default : rawFoo;
console.log(foo);
```

这段代码在两种解释下都会打印 `foo`。需要注意的是，TypeScript 在使用这段代码时可能会报类型错误；这是因为 [TypeScript 不支持这种行为](https://github.com/microsoft/TypeScript/issues/54102)，但可以安全地忽略该错误。

#### 给库使用者的建议

如果你发现的问题似乎是由这种不兼容引起的，可以先使用 [publint](https://publint.dev/) 检查该包。它有 [一条可检测这种不兼容的规则](https://publint.dev/rules#cjs_with_esmodule_default_export)（注意，它只检查包中的部分文件，而不是全部文件）。

如果这种启发式规则对你不起作用，你可以使用上面那段同时处理两种解释的代码。如果导入来自某个依赖，我们建议向该依赖提 issue。与此同时，你也可以使用 [`patch-package`](https://github.com/ds300/patch-package)、[`pnpm patch`](https://pnpm.io/cli/patch) 或其他替代方案作为临时解决办法。

### `.js` 文件应用严格模式

对于以 `.js` 结尾的文件，Rolldown 会将其作为 ESM 解析（[#7009](https://github.com/rolldown/rolldown/issues/7009)），而不会回退到 CJS。这意味着只有非严格模式（sloppy mode）下才允许的语法会被拒绝。

目前，你可以临时将文件扩展名改为 `.cjs` 作为变通方法。

## 未来计划

Rolldown 对 CommonJS 模块的一等支持带来了若干潜在优化：

- 针对 CommonJS 模块的高级 tree-shaking 能力
- 更好的死代码消除
