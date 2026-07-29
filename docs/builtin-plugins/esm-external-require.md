# ESM 外部依赖 Require 插件

`esmExternalRequirePlugin` 是 Rolldown 内置的插件，它会将外部依赖的 CommonJS `require()` 调用转换为 ESM `import` 语句，从而确保在不支持 Node.js 模块 API 的环境中也能兼容。

:::tip 注意
该插件会将 `resolveId.meta.order` 设置为 `'pre'`，以确保外部 `require` 先于其他插件解析。此外，为了兼容 Vite，它默认还会设置 `enforce: 'pre'`。
:::

## 为什么需要它

在使用 Rolldown 打包代码时，为了保留 `require()` 的语义，外部依赖的 `require()` 调用不会自动转换为 ESM 导入。虽然当设置了 `platform: 'node'` 时，Rolldown 会注入 `require` 函数，但它的方式是生成类似下面的代码：

```js
import { createRequire } from 'node:module';
var __require = createRequire(import.meta.url);
```

不过，这种方式依赖于 Node.js 模块 API，而某些环境并不支持它。对于那些预计之后还会被再次打包的库来说，这种方式也有问题，因为这段代码很难被打包器分析和转换。

## 用法

从 Rolldown 的实验性导出中导入并使用该插件：

```js
import { defineConfig } from 'rolldown';
import { esmExternalRequirePlugin } from 'rolldown/plugins';

export default defineConfig({
  input: 'src/index.js',
  output: {
    dir: 'dist',
    format: 'esm',
  },
  plugins: [
    esmExternalRequirePlugin({
      external: ['react', 'vue', /^node:/],
    }),
  ],
});
```

:::warning 该插件必须独占其外部依赖
将每个模块只列在此插件的 `external` 选项中，或只列在顶层的 `external` 选项中，切勿两者同时列出。顶层 `external` 会在解析时生效，因此插件会完全跳过重复的模块。构建会带着警告成功，但输出仍会在运行时继续对外部模块调用 `require()`。
:::

## 选项

### `external`

类型：`(string | RegExp)[]`

定义哪些依赖应被视为外部依赖。当输出格式为 ESM 时，它们的 `require()` 调用将被转换为 `import` 语句。对于非 ESM 输出格式，这些依赖仍会被标记为外部依赖，但 `require()` 调用将保持不变。

### `skipDuplicateCheck`

类型：`boolean`
默认值：`false`

启用后，将跳过检查此插件与顶层 `external` 选项之间是否存在重复外部依赖。当你确信不存在重复项时，这可以提升构建性能。

```javascript
esmExternalRequirePlugin({
  external: ['react', 'vue'],
  skipDuplicateCheck: true, // 跳过重复检查以获得更好的性能
});
```

## 重复外部依赖检测

默认情况下，插件会检查你指定的外部依赖是否也配置在顶层 `external` 选项中。如果发现重复项，你会看到一条警告：

```
Found 2 duplicate external: `react`, `vue`. Remove them from top-level `external` as they're already handled by 'builtin:esm-external-require' plugin.
```

将此警告视为正确性信号。插件会保留重复的模块不做处理：顶层 `external` 选项具有优先级，因此输出中仍然包含该插件本应转换的原始 `require()` 调用。请从顶层 `external` 中移除这些重复项。不会有任何损失：插件本身无论如何都会将其自己的模块标记为外部依赖。

`skipDuplicateCheck: true` 并不会让重复项正常工作。它只会静默掉警告，因此只有在你确定没有模块同时出现在这两个位置时才启用它。

## 限制

由于该插件会将 `require()` 调用改为 `import` 语句，因此打包后会存在一些语义差异：

- 解析现在基于 `import` 行为，而不是 `require` 行为
  - 例如，会使用 `import` 条件而不是 `require` 条件
- 返回值可能与原始的 `require()` 调用不同，尤其是对于具有默认导出的模块。

## 工作原理

该插件会拦截选项中指定的依赖的 `require()` 调用，并创建虚拟门面模块，这些模块会：

1. 使用 ESM `import * as m from '...'` 导入依赖
2. 使用 `module.exports = m` 将其重新导出，以兼容 CommonJS
3. 用虚拟模块引用替换原始的 `require()`

对于非外部的 `require()` 调用，Rolldown 会自动包裹它们并将其转换为 ESM 导入。

```js
// 输入代码
const react = require('react');

// 转换后的输出
const react = require('builtin:esm-external-require-react');

// 虚拟模块：builtin:esm-external-require-react
import * as m from 'react';
module.exports = m;
```
