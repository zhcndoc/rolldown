# 手动代码拆分

手动代码拆分是一项强大的功能，它允许你进行手动代码拆分，以补充[自动代码拆分](./automatic-code-splitting.md)。当你希望通过将应用拆分为更小、更易管理的部分来优化其加载性能时，这非常有用。

在阅读本指南之前，你应先了解 Rolldown 的[自动代码拆分](./automatic-code-splitting.md)功能。本指南将解释手动代码拆分的工作原理，以及如何有效地使用它。

在深入细节之前，我们先澄清一些事情。

- 自动代码拆分和手动代码拆分并不矛盾。使用手动代码拆分并不意味着禁用自动代码拆分。
  一个模块会根据你的配置，要么被自动代码拆分捕获，要么被手动代码拆分捕获，但不会同时被两者捕获。如果某个模块没有被手动代码拆分捕获，它仍然会被放入由自动代码拆分创建的 chunk 中，同时遵守我们在[自动代码拆分](./automatic-code-splitting.md)指南中解释的规则。

## 为什么使用手动代码拆分？

自动代码拆分不会考虑加载性能或缓存失效。它只是根据模块的静态导入来分组。这可能会导致不理想的 chunk 划分，生成的大 chunk 在加载性能上可能不佳，或者在每次部署时都会导致缓存失效。

## 如何使用手动代码拆分？

让我们看一下下面这个示例：

```jsx
// index.jsx
import * as ReactDom from 'react-dom';
import App from './App.jsx';

ReactDom.createRoot(document.getElementById('root')).render(<App />);

// App.jsx
import * as React from 'react';
import { Button } from 'ui-lib';

export default function App() {
  return <Button onClick={() => alert('Button clicked!')} />;
}
```

你会得到如下输出：

```js [output-hash0.js]
// node_modules/react/index.js
'React 库代码';

// node_modules/ui-lib/index.js
'UI 库代码';

// node_modules/react-dom/index.js
'ReactDOM 库代码';

// App.js
function App() {
  return <Button onClick={() => alert('Button clicked!')} />;
}

// index.js

ReactDom.createRoot(document.getElementById('root')).render(<App />);
```

在这个例子中，

- 我们使用了 3 个库：`react`、`react-dom` 和 `ui-lib`。
- `output-hash0.js` 是 Rolldown 生成的输出文件。
- `hash0` 是输出文件的哈希值，如果文件内容发生变化，它也会改变。

### 减少缓存失效

我们先来谈谈缓存失效。这里的缓存失效是指，当你部署应用的新版本时，浏览器需要下载该文件的新版本。如果文件很大，就会导致较差的用户体验。

例如，如果你修改了 `app.jsx` 文件：

```jsx [app.jsx]
function App() {
  return <Button onClick={() => alert('Button clicked!')} />; // [!code --]
  return <Button onClick={() => alert('Button clicked!!!')} />; // [!code ++]
}
```

那么自然会得到一个与 `output-hash0.js` 内容相同、只是 `App` 函数发生变化的 `output-hash1.js` 文件。

现在，如果你部署这个应用的新版本，浏览器将需要下载整个 `output-hash1.js` 文件，尽管其中只有一小部分发生了变化。这是因为文件的哈希值已经改变，浏览器会将其视为一个新文件。

为了解决这个问题，我们可以使用 codeSplitting 选项将输出中的库拆分为单独的 chunk，因为与应用代码相比，它们不太频繁发生变化。

```js [rolldown.config.js]
export default {
  // ... 其他配置
  output: {
    codeSplitting: {
      groups: [
        {
          test: /node_modules/,
          name: 'libs',
        },
      ],
    },
  },
};
```

使用上面的 codeSplitting 选项后，输出将如下所示：

:::code-group

```js [output-hash0.js]
import ... from './libs-hash0.js';
// App.js
function App() {
  return <Button onClick={() => alert("Button clicked!")} />;
}

// index.js

ReactDom.createRoot(document.getElementById("root")).render(<App />);
```

```js [libs-hash0.js]
// node_modules/react/index.js
"React 库代码";

// node_modules/ui-lib/index.js
"UI 库代码";

// node_modules/react-dom/index.js
"ReactDOM 库代码";

export { ... };
```

:::

例如，在你修改了 `app.jsx` 文件之后

```jsx [app.jsx]
function App() {
  return <Button onClick={() => alert('Button clicked!')} />; // [!code --]
  return <Button onClick={() => alert('Button clicked!!!')} />; // [!code ++]
}
```

你会得到如下输出：

:::code-group

```js [output-hash1.js]
import ... from './libs-hash0.js';
// App.js
function App() {
  return <Button onClick={() => alert("Button clicked!!!")} />;
}

// index.js

ReactDom.createRoot(document.getElementById("root")).render(<App />);
```

```js [libs-hash0.js]
// node_modules/react/index.js
"React 库代码";

// node_modules/ui-lib/index.js
"UI 库代码";

// node_modules/react-dom/index.js
"ReactDOM 库代码";

export { ... };
```

:::

- `libs-hash0.js` 文件没有变化，因此浏览器可以使用该文件的缓存版本。
- `output-hash1.js` 文件发生了变化，因此浏览器将下载该文件的新版本。

### 提升加载性能

手动代码拆分还可以通过将应用拆分为合适数量的 chunk，并利用浏览器的并行加载能力，来提升应用的加载性能。

在前面的例子中，我们把所有库都放进了一个单独的 chunk 中，这对加载性能来说并不是最优的。如果库太大，浏览器会花很长时间下载这个 chunk，从而导致较差的用户体验。

为了解决这个问题，我们可以使用 codeSplitting 选项将这些库拆分为单独的 chunk，以便浏览器可以并行下载它们。

```js [rolldown.config.js]
export default {
  // ... 其他配置
  output: {
    codeSplitting: {
      groups: [
        {
          test: /node_modules\/react/,
          name: 'react',
        },
        {
          test: /node_modules\/react-dom/,
          name: 'react-dom',
        },
        {
          test: /node_modules\/ui-lib/,
          name: 'ui-lib',
        },
      ],
    },
  },
};
```

使用上面的 codeSplitting 选项后，输出将如下所示：
:::code-group

```js [output-hash0.js]
import ... from './react-hash0.js';
import ... from './react-dom-hash0.js';
import ... from './ui-lib-hash0.js';

// App.js
function App() {
  return <Button onClick={() => alert("Button clicked!")} />;
}
// index.js
ReactDom.createRoot(document.getElementById("root")).render(<App />);
```

```js [react-hash0.js]
"React 库代码";
export { ... };
```

```js [react-dom-hash0.js]
"ReactDOM 库代码";
export { ... };
```

```js [ui-lib-hash0.js]
"UI 库代码";
export { ... };
```

:::
现在，这些库被拆分为多个独立的 chunk，浏览器可以并行下载它们。这可以显著提升应用的加载性能，尤其是在这些库体积较大的情况下。

## 限制

### 为什么总会有一个 `runtime.js` chunk？

```dot
digraph {
    bgcolor="transparent";
    rankdir=TB;
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [fontname="Arial", fontsize=10, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    compound=true;

    subgraph cluster_problem {
        label="没有 runtime.js";
        labeljust="l";
        fontname="Arial";
        fontsize=12;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#cb2431|#f85149}";

        p_main [label="main.js", fillcolor="${#fff0e0|#4a2a0a}"];
        p_first [label="first.js", fillcolor="${#dbeafe|#1e3a5f}"];
        p_second [label="second.js\n(__esm, __export defined here)", fillcolor="${#dbeafe|#1e3a5f}"];

        p_main -> p_first [label="imports"];
        p_main -> p_second [label="imports __esm"];
        p_first -> p_second [label="imports"];
        p_second -> p_first [label="imports", color="${#cb2431|#f85149}", fontcolor="${#cb2431|#f85149}", style=dashed];
    }

    subgraph cluster_solution {
        label="有 runtime.js";
        labeljust="l";
        fontname="Arial";
        fontsize=12;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#22863a|#3fb950}";

        s_runtime [label="runtime.js\n(__esm, __export)", fillcolor="${#dcfce7|#14532d}"];
        s_main [label="main.js", fillcolor="${#fff0e0|#4a2a0a}"];
        s_first [label="first.js", fillcolor="${#dbeafe|#1e3a5f}"];
        s_second [label="second.js", fillcolor="${#dbeafe|#1e3a5f}"];

        s_main -> s_runtime [label="imports"];
        s_main -> s_first [label="imports"];
        s_first -> s_runtime [label="imports"];
        s_first -> s_second [label="imports"];
        s_second -> s_runtime [label="imports"];
        s_second -> s_first [label="imports"];
    }
}
```

简而言之：如果你使用了带有 groups 的手动代码拆分，rolldown 会强制生成一个 `runtime.js` chunk，以确保运行时代码总是在任何其他 chunk 之前执行。

`runtime.js` chunk 是一个特殊的 chunk，它**只**包含加载和执行应用所需的运行时代码。它由打包器强制生成，以确保运行时代码总是在任何其他 chunk 之前执行。

由于手动代码拆分允许你在 chunk 之间移动模块，因此很容易在输出代码中创建循环导入。这可能导致运行时代码在其他 chunk 之前没有执行，从而在应用中引发错误。

下面是一个包含循环导入的示例输出代码：

```js
// first.js
import { __esm, __export, init_second, value$1 as value } from './second.js';
var first_exports = {};
__export(first_exports, { value: () => value$1 });
var value$1;
var init_first = __esm({
  'first.js'() {
    init_second();
    // ...
  },
});
export { first_exports, init_first, value$1 as value };

// main.js
import { first_exports, init_first } from './first.js';
import { __esm, init_second, second_exports } from './second.js';

var init_main = __esm({
  'main.js'() {
    init_first();
    init_second();
    // ...
  },
});

init_main();

// second.js
import { init_first, value } from './first.js';
var __esm = '...';
var __export = '...';

var second_exports = {};
__export(second_exports, { value: () => value$1 });
var value$1;
var init_second = __esm({
  'second.js'() {
    init_first();
    // ...
  },
});

export { __esm, __export, init_second, second_exports, value$1 };
```

当我们运行 `node ./main.js` 时，模块的遍历顺序将是 `main.js` -> `first.js` -> `second.js`。模块的执行顺序将是 `second.js` -> `first.js` -> `main.js`。

`second.js` 会尝试在 `__esm` 函数初始化之前调用它。这将导致一个运行时错误，即试图将 `undefined` 当作函数调用。

通过强制生成 `runtime.js`，打包器可以确保任何依赖运行时代码的 chunk 都会先加载 `runtime.js`，然后再执行自身。这保证了运行时代码总是在任何其他 chunk 之前执行，从而避免循环导入问题。

### 为什么 group 包含了不满足约束的模块？

当某个模块被一个 group 捕获时，Rolldown 会尝试递归地捕获它的依赖，而不考虑约束。这是因为默认情况下 Rolldown 只允许对非入口 chunk 的导出进行改写。

例如，如果你有以下代码：

```js
// entry.js
import { value } from './a.js';

console.log(value);

export const foo = 'foo';

// a.js
import { value as valueB } from './b.js';
export const value = 'a' + valueB;

// b.js
export const value = 'b';
```

假设我们想把 `a.js` 模块移动到一个单独的 chunk 中，同时让 `b.js` 模块保留在与 `entry.js` 相同的 chunk 中。我们得到

:::code-group

```js [entry.js]
import { value } from './a.js';

// b.js
const value = 'b';

// entry.js
const foo = 'foo';
console.log(value);

export { foo, value };
```

```js [a.js]
import { value } from './entry.js';

// a.js
export const value = 'a' + value;
```

:::

你可以看到，为了让 `a.js` 正常工作，我们不得不更改入口 chunk `entry.js` 的导出签名，并额外添加一个 `value` 导出。这完全违背了最初的意图，即 `entry.js` 只导出 `foo`。

如果你不希望出现这种行为，可以使用 [`codeSplitting.includeDependenciesRecursively: false`](/reference/OutputOptions.codeSplitting#includedependenciesrecursively) 来禁用它。

:::warning 注意事项

当 `includeDependenciesRecursively: false` 时，group 所依赖的模块可能会留在入口 chunks 中。从入口 chunk 导出非入口模块是无效的。为避免这一点，如果你没有显式设置，Rolldown 会隐式将 `preserveEntrySignatures` 设为 `'allow-extension'`。

- [`InputOptions.preserveEntrySignatures: false | 'allow-extension'`](/reference/InputOptions.preserveEntrySignatures)

`includeDependenciesRecursively: false` 会增加生成无效输出代码的概率。如果你遇到由执行顺序或循环依赖引起的问题，可以考虑启用：

- [`strictExecutionOrder: true`](/reference/OutputOptions.strictExecutionOrder)

:::

### 为什么 chunk 大小超过了 `maxSize`？

`maxSize` 更像是一个目标值，而不是严格限制。chunk 在以下场景中可能会超过这个值：

- 如果单个模块本身就大于 `maxSize`，那么生成的 chunk 也会超过这个限制。Rolldown 目前不支持将单个模块拆分到多个 chunk 中。
- Rolldown 会优先考虑 `minSize` 配置。如果拆分一个大的 chunk 会导致新生成的 chunk 小于 `minSize` 阈值，Rolldown 会保持原 chunk 不拆分，以避免生成过小的文件。
