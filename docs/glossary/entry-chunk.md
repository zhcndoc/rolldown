# 入口块

入口块会被创建，因为我们需要为以下目的输出一个 JavaScript 文件：

- 导出入口模块的导出内容
- 表示对应 [入口](./entry.md) 的执行点
- 存储入口模块及其依赖的代码（如果没有被拆分到单独的块中）

假设你有一个应用，它既可以单独运行，也可以被其他应用作为库使用。

文件结构：

```js
// component.js
export function component() {
  return 'Hello World';
}

// render.js
export function render(component) {
  console.log(component());
}

// app.js
import { component } from './component.js';
import { render } from './render.js';

render(component);

// lib.js
export { component } from './component.js';
```

配置：

```js
export default defineConfig({
  input: {
    app: './app.js',
    lib: './lib.js',
  },
});
```

Rolldown 会生成如下输出：

::: code-group

```js [app.js]
import { component } from './common.js';

function render(component) {
  console.log(component());
}

render(component);
```

```js [lib.js]
export { component } from './common.js';
```

```js [common.js]
export function component() {
  return 'Hello World';
}
```

:::

- 创建 `lib.js` 是因为我们需要创建导出签名 `export { component }`，并在 `lib.js` 中导出它。
- 对于 `app.js`，虽然它没有导出任何内容，我们仍然需要创建 `app.js` 作为应用的执行点。
- 你还会注意到，从执行点 `app.js` 出发，只有被导入的模块（例如 `render.js`）会被执行。这也是执行点的另一个原因和承诺。
