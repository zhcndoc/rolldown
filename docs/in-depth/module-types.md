# 模块类型

作为一个 web 打包器，JavaScript 并不是 Rolldown 唯一内置支持的文件类型。例如，Rolldown 可以直接处理 TypeScript 和 JSX 文件，在打包之前先将它们解析并转换为 JavaScript。我们将 Rolldown 中这些具有一等支持的文件类型称为 **模块类型**。

## 模块类型如何影响用户

最终用户通常不需要关心模块类型，因为 Rolldown 会自动识别并处理已知的模块类型。

默认情况下，Rolldown 会根据模块的文件扩展名来确定其模块类型。然而，在某些情况下这可能不够。例如，假设有一个包含 JSON 数据的文件，但它的扩展名是 `.data`。Rolldown 无法将其识别为 JSON 文件，因为该扩展名不是 `.json`。

在这种情况下，用户需要显式告诉 Rolldown，带有 `.data` 扩展名的文件应当被视为 JSON 模块类型。这可以通过配置中的 `moduleTypes` 选项来实现：

```js [rolldown.config.js]
export default {
  moduleTypes: {
    '.data': 'json',
  },
};
```

## 模块类型与插件

插件可以通过 `load` 钩子和 `transform` 钩子为特定文件指定模块类型：

```js
const myPlugin = {
  load(id) {
    if (id.endsWith('.data')) {
      return {
        code: '...',
        moduleType: 'json',
      };
    }
  },
};
```

模块类型的主要意义在于，它为受支持的类型提供了一种统一约定，使得需要对同一种模块类型进行处理的多个插件更容易串联起来。

例如，`@vitejs/plugin-vue` 目前会为 `.vue` 文件中的 style 块创建虚拟 css 模块，并在虚拟模块的 id 后追加 `?lang=css`，从而让 vue 插件能够将这些模块识别为 css。然而，这只是 vue 插件的一种约定——其他插件可能会忽略该查询字符串，因此无法识别这一约定。

有了模块类型，`@vitejs/plugin-vue` 就可以显式地将虚拟 css 模块的模块类型指定为 `css`，而诸如 postcss 插件之类的其他插件则可以在不了解 vue 插件的情况下处理这些 css 模块。

另一个例子：为了支持 `.jsonc` 文件，一个插件只需在 `load` 钩子中去除 `.jsonc` 文件的注释，并返回 `moduleType: 'json'`。剩下的部分由 Rolldown 处理。
