# 内联公共 chunk

内联公共 chunk 可以减少[自动代码分割](./automatic-code-splitting.md)生成的小型公共 chunk 数量。Rolldown 会将这些 chunk 中的代码复制到使用它们的 chunk 中，并移除独立的公共 chunk 文件。共享运行时会让这些副本使用相同的模块状态和导出。

## 用法

```js [rolldown.config.mjs]
import { defineConfig } from 'rolldown';

export default defineConfig({
  input: ['src/a.js', 'src/b.js', 'src/c.js'],
  preserveEntrySignatures: false,
  output: {
    dir: 'dist',
    format: 'es',
    codeSplitting: {
      experimentalInlineCommonChunks: {
        maxSize: 10 * 1024, // < 10 KiB
      },
    },
  },
});
```

`maxSize` 使用转换后的源代码大小，并在渲染、代码压缩和传输压缩前按 chunk 求和。默认值为 `0`（禁用）；`Infinity` 表示取消大小限制。

入口、动态导入目标和手动 chunk 不会被内联。只要 [`exclude`](/reference/TypeAlias.ExperimentalInlineCommonChunksOptions#exclude) 与任一模块匹配，整个公共 chunk 都不会被内联。

内联需要满足以下条件：

- ESM 输出（[`output.format: 'es'`](/reference/OutputOptions.format)）。
- [`preserveEntrySignatures: false`](/reference/InputOptions.preserveEntrySignatures)，以允许移除未使用的入口导出。
- 启用 [`strictExecutionOrder`](/reference/OutputOptions.strictExecutionOrder)。未指定时，Rolldown 会自动启用它。

## 工作原理

自动代码分割遵循从 Rollup 输出模型继承的两条规则：

1. 一个模块的代码只会出现在一个输出 chunk 中。
2. 一个入口只会加载从该入口可达的应用模块。

[用法](#用法)中的配置定义了三个入口：A、B 和 C。三个入口都会导入一个大型库；A 和 B 还会导入一个带计数器的小型辅助模块：

::: code-group

```js [src/a.js and src/b.js]
import './library.js';
import { inc } from './helper.js';

console.log(inc());
```

```js [src/c.js]
import './library.js';
```

```js [src/helper.js]
console.log('helper initialized');
let count = 0;
export function inc() {
  return ++count;
}
```

:::

无论大小如何，库和辅助模块都会进入不同的公共 chunk，因为导入它们的入口集合不同。动态导入目标也会被视为入口，因此惰性加载的路由之间也会出现相同的情况。

[手动代码分割](./manual-code-splitting.md)可以将它们合并，但这样 C 也会加载辅助模块。内联会把辅助模块复制到 A 和 B 中。假设辅助模块小于 `maxSize`，而库大于该值：

```dot
digraph {
    bgcolor="transparent";
    rankdir=TB;
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [color="${#3c3c43|#dfdfd6}"];

    subgraph cluster_before {
        label="Separate common chunks";
        fontname="Arial";
        fontcolor="${#3c3c43|#dfdfd6}";
        color="${#3c3c43|#dfdfd6}";
        a [label="A", fillcolor="${#fff0e0|#4a2a0a}"];
        b [label="B", fillcolor="${#fff0e0|#4a2a0a}"];
        c [label="C", fillcolor="${#fff0e0|#4a2a0a}"];
        helper [label="helper", fillcolor="${#dcfce7|#14532d}"];
        library [label="library", fillcolor="${#dbeafe|#1e3a5f}"];
        a -> helper;
        b -> helper;
        { a b c } -> library;
    }

    subgraph cluster_after {
        label="Helper inlined";
        fontname="Arial";
        fontcolor="${#3c3c43|#dfdfd6}";
        color="${#3c3c43|#dfdfd6}";
        a_inline [label="A + helper", fillcolor="${#fff0e0|#4a2a0a}"];
        b_inline [label="B + helper", fillcolor="${#fff0e0|#4a2a0a}"];
        c_inline [label="C", fillcolor="${#fff0e0|#4a2a0a}"];
        library_inline [label="library", fillcolor="${#dbeafe|#1e3a5f}"];
        { a_inline b_inline c_inline } -> library_inline;
    }
}
```

箭头表示导入；图中省略了共享运行时。

### 在副本之间共享状态

在同一个 JavaScript 环境中先加载 A 再加载 B，会得到以下输出：

```text
helper initialized
1
2
```

如果将辅助模块的代码分别粘贴到两个文件中，就会创建两个计数器，且初始值都是 `0`。每个文件都会输出 `helper initialized` 和 `1`。导出的对象和函数也会具有不同的身份。

Rolldown 会用一个 _工厂函数_ 包装公共 chunk，并通过共享运行时注册每个副本。A 和 B 中都包含以下代码（名称已简化；省略了库导入和入口包装代码）：

<!-- prettier-ignore -->
```js
import {
  __share,
  __share_require,
  __share_export,
  __esmMin,
} from './rolldown-runtime.js';

__share('helper', (exports) => {
  let count;
  function inc() {
    return ++count;
  }
  const init_helper = __esmMin(() => {
    console.log('helper initialized');
    count = 0;
  });
  __share_export(exports, {
    inc: () => inc,
    init_helper: () => init_helper,
  });
});

const helper = __share_require('helper');
helper.init_helper();
console.log((0, helper.inc)());
```

| 运行时辅助函数    | 行为                                                   |
| ----------------- | ------------------------------------------------------ |
| `__share`         | 注册工厂函数，但不调用它。同一标识符的首次注册会生效。 |
| `__share_require` | 首次使用时运行工厂函数，并缓存其导出对象。             |
| `__esmMin`        | 确保模块初始化函数只运行一次。                         |
| `__share_export`  | 通过 getter 暴露导出，从而保留实时绑定。               |

A 调用 `init_helper` 初始化共享的 `count`，`inc()` 返回 `1`。B 会取得相同的函数：它的初始化函数不执行任何操作，而 `inc()` 返回 `2`。

将注册与模块初始化分开，可以在使用方运行之前提供工厂函数；`strictExecutionOrder` 则控制模块顶层代码的执行时机。

所有副本都必须导入同一个运行时 chunk，才能共享状态。

### 加载与缓存

A 注册了辅助模块，并不会移除 B 文件中内嵌的副本；获取 B 时仍会传输这段代码。

| 加载场景                               | 独立的辅助 chunk       | 内联到 A 和 B 中的辅助模块    |
| -------------------------------------- | ---------------------- | ----------------------------- |
| 首次加载 A                             | 单独获取辅助模块。     | 在 A 中获取辅助模块。         |
| 随后加载 B                             | 复用已加载的辅助模块。 | 在 B 中获取另一个副本。       |
| 加载已更新的 A，未变更的辅助模块已缓存 | 复用缓存的辅助模块。   | 在新的 A 中再次获取辅助模块。 |

少一次请求可能足以抵消复制小型辅助模块的成本。使用 `maxSize: Infinity` 时，A、B 和 C 共享的大型库也会面临同样的权衡：如果该库符合内联条件，加载三个入口就会传输三份库代码。运行时也会增加一个共享文件和执行开销。

`maxSize` 检查的是 chunk 的源代码大小，而不是副本为用户会话增加的总字节数。因此，chunk 数量减少并不保证加载更快。决定是否启用内联或提高阈值之前，请比较应用首次加载和后续导航时启用与未启用内联的加载时间，并考虑缓存复用。

## 优化

### 避免不必要的副本

A 和 B 都需要包含工厂函数，因为任一入口都可能先加载。现在假设两者都可以动态导入同样使用该辅助模块的 `detail.js`。动态导入开始时，A 或 B 已经注册了工厂函数，因此 `detail.js` 不需要再包含一个副本：

```dot
digraph {
    bgcolor="transparent";
    rankdir=TB;
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [fontname="Arial", fontsize=10, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];

    a [label="A + helper factory", fillcolor="${#fff0e0|#4a2a0a}"];
    b [label="B + helper factory", fillcolor="${#fff0e0|#4a2a0a}"];
    detail [label="detail.js\nuses the registered factory", fillcolor="${#dcfce7|#14532d}"];
    { rank=same; a; b; }
    a -> detail [label="import()"];
    b -> detail [label="import()"];
}
```

```js [detail.js]
import { __share_require } from './rolldown-runtime.js';

const helper = __share_require('helper');
helper.init_helper();
console.log((0, helper.inc)());
```

只有当从已配置入口或插件生成的入口出发的每条已知路径都会先提供工厂函数时，Rolldown 才会省略副本。更早加载的静态依赖也可以提供它。

### 让模块保持在同一作用域中

Rolldown 会用一个工厂函数包装整个公共 chunk，因此其中的模块可以直接相互引用。压缩器可以在该作用域内重命名并内联代码。来自工厂函数外部的引用需要经过它的导出对象，这会限制跨越边界的优化。

## 兼容性

### chunk 选择

即使公共 chunk 小于 `maxSize`，在以下情况下也不会内联：

- 包含顶层 await，或静态依赖包含顶层 await 的模块。
- 包含 tree shaking 后仍保留的 `import.meta`。
- 包含尚未解析的动态导入，或导入外部模块。
- 另一个输出 chunk 重新导出了它的某个绑定。
- 包含声明模块或内置的 `asset`、`copy` 模块。

涉及未内联 chunk 的直接 `eval` 和静态循环也可能阻止内联。

### 插件

- 一个内联模块会出现在每个包含其副本的 chunk 的 [`moduleIds`](/reference/Interface.RenderedChunk#moduleids) 和 [`modules`](/reference/Interface.RenderedChunk#modules) 中。CSS 提取和 SSR 清单插件必须考虑到一个模块可能属于多个 chunk。

  ::: info Vite
  对于 Vite 构建，请将此 `exclude` 匹配器添加到 `experimentalInlineCommonChunks`，以避免 CSS 在多个输出样式表中重复：

  ```js
  exclude: /\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)(\?|$)/,
  ```

  :::

- 如果 `renderChunk` hook 为不同副本提供了不同的值，则所有使用方都会采用第一个已注册副本的值。对于受影响的模块，请使用 [`exclude`](/reference/TypeAlias.ExperimentalInlineCommonChunksOptions#exclude)。

更多背景信息请参阅[设计 RFC](https://github.com/rolldown/rolldown/discussions/10693)。欢迎在[反馈 issue](https://github.com/rolldown/rolldown/issues/11040)中分享应用效果和问题报告。
