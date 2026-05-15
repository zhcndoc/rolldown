# 死代码消除

死代码消除（DCE）是一种优化技术，它会从你的包中移除未使用的代码，使其体积更小、加载更快。

Rolldown 会移除同时满足以下两个条件的代码：

1. **未被使用** - 该值从未被使用
2. **没有副作用** - 移除该代码不会改变程序行为

下面是一个简单示例：

```js
// math.js
export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}

// main.js
import { add } from './math.js';
console.log(add(2, 3));
```

在这个示例中，`multiply` 从未被导入，并且没有副作用，因此 Rolldown 会将它从最终 bundle 中移除。

::: tip Tree-Shaking
Tree-shaking 是一个相关术语，[由 Rollup 推广](https://rollupjs.org/faqs/#what-is-tree-shaking)。它指的是一种通过“摇动”语法树来移除未使用代码的特定死代码消除技术。
:::

## 什么是副作用？

副作用是指任何会影响自身作用域之外内容的操作。常见的副作用包括：

- 修改全局变量或 DOM
- 导入 CSS 文件（会将样式应用到页面）
- 修改原型或全局对象的 polyfill

```js
// 副作用：应用样式
import './styles.css';
// 副作用：修改全局变量
window.API_URL = '/api';
// 副作用：修改原型
Array.prototype.first = function () {
  return this[0];
};
```

## Rolldown 如何检测副作用

Rolldown 会通过分析以下内容自动检测你的代码是否有副作用：

- 模块是否包含在导入时执行的顶层代码
- 函数调用是否可能修改外部状态
- 属性访问是否可能触发带有副作用的 getter

不过，静态分析有其局限性。有些模式过于动态，无法分析，因此当 Rolldown 不确定时，可能会保守地保留代码。你可以通过 [`treeshake.unknownGlobalSideEffects`](/reference/InputOptions.treeshake#unknownglobalsideeffects) 和 [`treeshake.propertyReadSideEffects`](/reference/InputOptions.treeshake#propertyreadsideeffects) 来调整这一行为。

你也可以通过显式标记代码为无副作用，帮助 Rolldown 执行更激进的死代码消除。

## 将代码标记为无副作用

你可以使用注释标记告诉 Rolldown 某段代码是无副作用的。这些注释默认启用，可通过 [`treeshake.annotations`](/reference/InputOptions.treeshake#annotations) 关闭。

### `@__PURE__`

`@__PURE__` 注释告诉 bundler，函数调用或 `new` 表达式没有副作用。如果结果未被使用，整个调用都可以被移除。

```js
const button = /* @__PURE__ */ createButton();
const widget = /* @__PURE__ */ new Widget();
```

如果 `button` 和 `widget` 从未被使用，Rolldown 会将这两个调用完全移除。如果没有这些注释，Rolldown 会保留它们，因为它无法确定 `createButton()` 和 `new Widget()` 没有副作用。

该注释必须**紧邻**调用或 `new` 表达式之前才能生效。如果放在其他位置，Rolldown 会发出 `INVALID_ANNOTATION` 警告。

::: warning 常见的无效位置

```js
// 放在非调用表达式之前
/* @__PURE__ */ globalThis.createElement;

// 放在声明之前
/* @__PURE__ */ function foo() {}

// 放在变量声明中标识符和 `=` 之间
const foo /* @__PURE__ */ = bar();
```

:::

::: tip
为了兼容其他工具，这个注释也可以写成 `/* #__PURE__ */`（使用 `#` 而不是 `@`）。
:::

### `@__NO_SIDE_EFFECTS__`

`@__NO_SIDE_EFFECTS__` 注释告诉 bundler，该函数声明的任何调用都没有副作用。

```js
/* @__NO_SIDE_EFFECTS__ */
function createComponent(name) {
  return {
    name,
    render() {
      return `<${name}></${name}>`;
    },
  };
}

// 如果 `button` 未使用，这个调用将被移除
const button = createComponent('button');
// 如果 `input` 未使用，这个调用也将被移除
const input = createComponent('input');
```

当你知道函数本身始终是纯函数时，这种方式可能比在每个调用点都添加 `@__PURE__` 更方便。

## 将整个模块标记为无副作用

虽然你可以标记单个表达式或函数，但你也可以将整个模块标记为无副作用。如果你将某个模块标记为无副作用，那么当它的导出都没有被使用时，Rolldown 会将该模块中的每条语句都视为无副作用。

::: details “它的导出都没有被使用”是什么意思？

这里指的是**在模块自身中定义**的导出，而不是从其他模块重新导出的内容。

```js [utils.js]
// 假设此文件被标记为无副作用
window.loaded = true; // 副作用

// 在此文件中定义 - 计入“它的导出”
export function add(a, b) {
  return a + b;
}

// 从另一个文件重新导出 - 这些不计入
export { multiply } from './math.js';
export * from './math2.js';
import { divide } from './math3.js';
export { divide };
```

在这个示例中：

- 如果你 `import { add } from './utils.js'`，则该模块被视为“已使用”，因为 `add` 是在 `utils.js` 中定义的
- 如果你只 `import { multiply } from './utils.js'`，则该模块被视为“未使用”，因为 `multiply` 只是重新导出，并不是在这里定义的

:::

例如，考虑以下情况：

```js
// math.js
window.myGlobal = 'hello'; // 副作用：修改全局变量

export function add(a, b) {
  return a + b;
}

// main.js
import './math.js';
console.log('main');
```

如果 `math.js` 被标记为无副作用，则输出将会是：

```js
console.log('main');
```

:::: warning 这是有条件的

只有当模块的导出都没有被使用时，这些语句才会被视为无副作用。如果任何导出被使用，副作用就会被保留。

::: details 示例

例如，考虑以下情况：

```js
// math.js（标记为无副作用）
window.myGlobal = 'hello'; // 副作用：修改全局变量

export function add(a, b) {
  return a + b;
}

// main.js
import { add } from './math.js';
console.log('main', add(2, 3));
```

输出将会是：

```js
window.myGlobal = 'hello';

function add(a, b) {
  return a + b;
}

console.log('main', add(2, 3));
```

另一方面，如果你将 `math.js` 中的每条语句都标记为无副作用，则输出将会是：

```js
function add(a, b) {
  return a + b;
}

console.log('main', add(2, 3));
```

:::

::::

#### `package.json` 中的 `sideEffects`

`package.json` 中的 `sideEffects` 字段会告诉 bundler 你包里的哪些文件具有副作用：

```json [package.json]
{
  "name": "my-library",
  "sideEffects": false
}
```

将 `sideEffects: false` 会把包中的所有文件都标记为无副作用，这在工具库中很常见。

你也可以指定一个包含具有副作用文件的数组：

```json [package.json]
{
  "name": "my-library",
  "sideEffects": ["./src/polyfill.js", "**/*.css"]
}
```

这会告诉 Rolldown，大多数文件都没有副作用，在未使用时可以被移除，但 `polyfill.js` 和 CSS 文件必须保留。

该数组支持 glob 模式（支持 `*`、`**`、`{a,b}`、`[a-z]`）。像 `*.css` 这样不包含 `/` 的模式会被视为 `**/*.css`。

::: warning CSS 文件
如果你的库导入了 CSS 文件，请务必将它们包含在 `sideEffects` 数组中。否则，CSS 导入可能会被移除：

```json [package.json]
{
  "name": "my-component-library",
  "sideEffects": ["**/*.css", "**/*.scss"]
}
```

:::

#### 插件钩子：`moduleSideEffects`

插件可以在 `resolveId`、`load` 或 `transform` 钩子中返回 [`moduleSideEffects`](/reference/Interface.SourceDescription#modulesideeffects)，以覆盖特定模块的副作用检测：

```js [rolldown.config.js]
export default {
  plugins: [
    {
      name: 'my-plugin',
      resolveId(source) {
        if (source === 'my-pure-module') {
          return {
            id: source,
            moduleSideEffects: false,
          };
        }
        return null;
      },
    },
  ],
};
```

用于判断模块副作用的优先级顺序为：

1. `transform` 钩子返回的 `moduleSideEffects`
2. `load` 钩子返回的 `moduleSideEffects`
3. `resolveId` 钩子返回的 `moduleSideEffects`
4. [`treeshake.moduleSideEffects`](/reference/InputOptions.treeshake#modulesideeffects) 选项
5. `package.json` 中的 `sideEffects` 字段

## 示例：优化组件库

考虑一个具有如下结构的组件库：

```
my-component-lib/
├── package.json
└── src/
     ├── index.js
     └── components/
         ├── Button.js
         ├── Button.css
         ├── Modal.js
         └── Modal.css
```

::: code-group

```js [src/index.js]
export { Button } from './components/Button.js';
export { Modal } from './components/Modal.js';
```

```js [src/components/Button.js]
import './Button.css';
export function Button(props) {
  /* ... */
}
```

:::

为了确保未使用的组件可以被移除，只将 CSS 文件标记为有副作用：

```json [package.json]
{
  "name": "my-component-lib",
  "sideEffects": ["**/*.css"]
}
```

现在，当使用者只导入 `Button` 时：

```js
import { Button } from 'my-component-lib';

render(<Button />);
```

Rolldown 将会：

1. 包含 `components/Button.js`（因为使用了 `Button`）
2. 包含 `components/Button.css`（因为它被 `components/Button.js` 导入，并且被标记为有副作用）
3. 排除 `components/Modal.js`（因为没有使用 `Modal`）
4. 排除 `components/Modal.css`（因为 `components/Modal.js` 被排除）
