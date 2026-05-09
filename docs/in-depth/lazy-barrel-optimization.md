# Lazy Barrel 优化

Lazy barrel 是一种优化功能，通过避免编译无副作用的 [barrel 模块](/glossary/barrel-module) 中未使用的重新导出模块来提升构建性能。

## 为什么使用 Lazy Barrel

像 [Ant Design](https://ant.design/) 这样的大型组件库会大量使用 barrel 模块。即使你只导入一个组件，打包器传统上也会编译成千上万个模块，其中大多数都未被使用。

下面是一个只从 antd 导入 `Button` 的真实示例：

```js
import { Button } from 'antd';
Button;
```

| 指标                | 不使用 lazy barrel | 使用 lazy barrel |
| ------------------- | ------------------ | ---------------- |
| 编译的模块数        | 2986               | 250              |
| 构建时间（macOS）   | ~65ms              | ~28ms            |
| 构建时间（Windows） | ~210ms             | ~50ms            |

启用 lazy barrel 后，Rolldown 将编译模块数量减少 **92%**，并将构建速度提升 **2-4 倍**。

::: tip
你可以使用 [lazy-barrel 示例](https://github.com/rolldown/benchmarks/tree/main/examples/lazy-barrel) 复现这个基准测试。
:::

## Lazy Barrel 的工作原理

启用后，Rolldown 会分析哪些导出实际被使用，并且只编译这些模块。未使用的重新导出模块会被跳过，从而显著提升包含大量 barrel 模块的大型代码库的构建性能。

### 基本示例

```js
// barrel/index.js
export { a } from './a';
export { b } from './b';

// main.js
import { a } from './barrel';
console.log(a);
```

启用 lazy barrel 优化后：

- `barrel/index.js` 会被加载并分析
- 由于导入了 `a`，因此只会编译 `a.js`
- 由于未使用 `b`，因此 `b.js` **不会** 被编译

## 支持的导出模式

Lazy barrel 优化支持多种导出模式：

### 星号重新导出

```js
export * from './components';
```

### 命名重新导出

```js
export { Component } from './Component';
export { helper as utils } from './helper';
export { default as Button } from './Button';
export { Button as default } from './Button';
```

### 命名空间重新导出

```js
export * as ns from './module';
```

### 先导入再导出模式

```js
// 等价于 `export { a } from './a'`
import { a } from './a';
export { a };

// 等价于 `export { a as default } from './a'`
import { a } from './a';
export { a as default };

// 等价于 `export * as ns from './module'`
import * as ns from './module';
export { ns };

// 等价于 `export { default as b } from './b'`
import b from './b';
export { b };
```

### 混合导出

```js
export { a } from './a';
export * as ns from './b';
export * from './others';
export * from './more';
```

当某个导入能在命名导出中找到时，就不会再搜索星号导出，从而避免不必要的模块加载。

但是，如果在命名导出中找不到该导入，则会加载所有星号重新导出以解析它。如果这些被星号重新导出的模块本身也是 barrel 模块，那么只会从它们中加载该特定导入说明符。

:::: warning 重新导出 vs 自有导出：default
`export { Button as default } from './Button.js'` 和 `import { Button } from './Button.js'; export default Button` **并不等价**。

在前一种情况下，导出的值会与 `Button.js` 中的值保持同步，因为它指向同一个变量。

在后一种情况下，导出的值不会与 `Button.js` 中的值保持同步，因为 `export default ...` 会创建一个新变量。

下面的示例展示了这种区别：

::: code-group

```js [main.js]
import { Button, increment } from './Button.js';
import ExportDefaultButton, { ReExportedButton } from './re-exporter.js';

console.log(Button); // 1
console.log(ReExportedButton); // 1
console.log(ExportDefaultButton); // 1

increment();

console.log(Button); // 2
console.log(ReExportedButton); // 2
console.log(ExportDefaultButton); // 1
```

```js [re-exporter.js]
import { Button } from './Button.js';
export default Button;

export { Button as ReExportedButton } from './Button.js';
```

```js [Button.js]
export let Button = 1;
export const increment = () => {
  Button++;
};
```

:::

因此，`export default ...` 被视为自有导出，可能会阻止该优化（参见 [自有导出](#own-exports-non-pure-re-export-barrels)）。
::::

## 高级场景

### 自我重新导出

Lazy barrel 能正确处理从自身重新导出的 barrel 模块：

```js
// barrel/index.js
export { a } from './a';
export { a as b } from './index'; // 自我重新导出
```

### 循环导出

Lazy barrel 能正确处理 barrel 模块之间的循环导出关系：

```js
// barrel-a/index.js
export { a } from './a';
export * from '../barrel-b';

// barrel-b/index.js
export { b } from './b';
export { a as c } from '../barrel-a'; // 循环引用
```

### 动态导入入口

当某个 barrel 模块被动态导入时，它会成为入口点，并且其所有导出都必须可用：

```js
// barrel/a.js
export const a = 'a';
import('./index.js'); // 使 barrel 成为入口点

// barrel/index.js
export { a } from './a';
export { b } from './b'; // 将加载 b.js
```

不过，如果 `b.js` 也是一个 barrel 模块，那么它未使用的导出仍然会被优化掉。

### 未使用的导入说明符

默认情况下，即使某个被导入的说明符未被使用，其对应的模块仍然会被加载：

```js
// barrel/index.js
export { a } from './a';
export { b } from './b';

// main.js
import { a } from './barrel'; // 即使 `a` 从未被使用，a.js 仍会被加载
```

### 自有导出（非纯重新导出 barrel）

当某个 barrel 模块包含自有导出（不仅仅是重新导出）时，只要使用了任何自有导出，就必须加载它的所有导入记录：

```js
// barrel/index.js
import './a';
import { b } from './b';
import { e } from './e';
export { c } from './c';
export { d } from './d';
export { e };

console.log(b);

export const index = 'index'; // 自有导出
export default b; // `default` 是自有导出

// main.js
import { index, c } from './barrel';
// 或者 import b, { c } from './barrel';
```

在这种情况下，当导入 `index` 时：`a.js`、`b.js`、`c.js`、`d.js` 和 `e.js` 都会被加载：

- `import './a'` - `a.js` 会在未请求任何说明符的情况下被加载
- `import { b } from './b'` - `b.js` 会在请求 `b` 的情况下被加载（被 barrel 自身代码使用）
- `import { e } from './e'; export { e }`（先导入再导出）- `e.js` 会在请求 `e` 的情况下被加载，因为 Rolldown 无法静态判断 barrel 自身代码是否也会使用 `e`
- `export { c } from './c'`（专用重新导出）- `c.js` 会在请求 `c` 的情况下被加载（因为 main.js 导入了 `c`）
- `export { d } from './d'`（专用重新导出）- `d.js` 会在未请求任何说明符的情况下被加载（类似于 `import './d'`，因为 main.js 中没有导入 `d`）

请注意专用重新导出记录（`export { .. } from '..'`、`export * as ns from '..'`）与由先导入再导出模式生成的共享导入记录之间的区别。当 barrel 的自有导出被 main.js 加载且 barrel 必须执行时，如果某个绑定未被 main.js 请求，专用重新导出记录仍然可以退回到空的说明符集合。相比之下，共享导入记录始终会保留其完整说明符，因为它们的绑定可能会被 barrel 自身代码引用。

之所以会这样，是因为 `moduleSideEffects` 只能在 transform 钩子之后确定，而 lazy barrel 的决策是在 load 阶段做出的。当 barrel 必须执行时（因为使用了自有导出），就必须加载它的所有导入，以确保行为正确。

如果被加载的模块（`a.js`、`b.js` 等）本身也是 barrel 模块，那么 lazy barrel 优化仍会根据是否请求了说明符，递归地应用到它们上。

## 配置

在你的 Rolldown 配置中启用 lazy barrel 优化：

```js
// rolldown.config.js
export default {
  experimental: {
    lazyBarrel: true,
  },
};
```

## 要求

要让 lazy barrel 优化生效，barrel 模块需要被显式标记为无副作用：

1. **包声明**：在 `package.json` 中添加 `"sideEffects": false`

2. **Rolldown 插件钩子**：在 `resolveId`、`load` 或 `transform` 钩子中返回 `moduleSideEffects: false`

```js
// rolldown.config.js
export default {
  plugins: [
    {
      name: 'mark-barrel-side-effect-free',
      transform(code, id) {
        if (id.includes('/barrel/')) {
          return { moduleSideEffects: false };
        }
      },
    },
  ],
};
```

3. **Rolldown 配置**：使用 `treeshake.moduleSideEffects` 选项

```js
// rolldown.config.js
export default {
  treeshake: {
    moduleSideEffects: [
      // 使用正则将 barrel 模块标记为无副作用
      { test: /\/barrel\//, sideEffects: false },
      // 或者标记特定路径
      { test: /\/components\/index\.js$/, sideEffects: false },
    ],
  },
};
```

你也可以使用函数来实现更复杂的逻辑：

```js
// rolldown.config.js
export default {
  treeshake: {
    moduleSideEffects: (id) => {
      // 将所有 index.js 文件标记为无副作用
      if (id.endsWith('/index.js')) return false;
      return true;
    },
  },
};
```

## 何时使用

在以下情况下，Lazy barrel 优化尤其有益：

- 你的代码库有很多 barrel 模块（在组件库中很常见）
- Barrel 模块重新导出了很多模块，但使用者通常只会用到其中少数几个

## 局限性

- 带有副作用的 barrel 模块无法优化
- 未匹配的命名导入需要加载所有星号重新导出才能解析
- 入口文件、`import * as ns`、`import('..')`、`require('..')` 等都会导致 barrel 模块加载其所有导出
- 当某个 barrel 具有自有导出（不仅仅是重新导出）时，使用任何自有导出都会导致其所有导入记录被加载
