# 自动代码分割

自动代码分割是从模块创建 chunk 的过程。本章描述它的行为及其背后的原理。

自动代码分割不可手动控制。它会按照某些规则运行。因此，我们也将其与[手动代码分割](./manual-code-splitting.md)区分开来，前者是自动代码分割，后者是手动代码分割。

自动代码分割会生成两种类型的 chunk。

## **入口 chunk**

**入口 chunk** 是通过将静态连接的模块合并到一个 chunk 中而生成的。"静态"指的是静态 `import ... from '...'` 或 `require(...)`。

**入口 chunk** 有两种类型。

第一种是**初始 chunk**。**初始 chunk** 是由于用户配置而生成的。例如，`input: ['./a.js', './b.js']` 定义了两个**初始 chunk**。

第二种是**动态 chunk**。**动态 chunk** 是由于动态导入而生成的。动态导入用于按需加载代码，因此我们不会把被导入的代码与导入者放在一起。

对于以下代码，将生成两个 chunk：

```js
// entry.js（包含在 `input` 选项中）
import foo from './foo.js';
import('./dyn-entry.js');

// dyn-entry.js
require('./bar.js');

// foo.js
export default 'foo';

// bar.js
module.exports = 'bar';
```

在这种情况下，存在两组静态连接的模块。

```dot
digraph {
    bgcolor="transparent";
    rankdir=LR;
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [fontname="Arial", fontsize=10, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];

    subgraph cluster_group1 {
        label="组 1（初始 chunk）";
        labeljust="l";
        fontname="Arial";
        fontsize=11;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#d44803|#ff712a}";

        entry [label="entry.js", fillcolor="${#fff0e0|#4a2a0a}"];
        foo [label="foo.js", fillcolor="${#fff0e0|#4a2a0a}"];
        entry -> foo [label="静态导入"];
    }

    subgraph cluster_group2 {
        label="组 2（动态 chunk）";
        labeljust="l";
        fontname="Arial";
        fontsize=11;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#0366d6|#58a6ff}";

        dyn [label="dyn-entry.js", fillcolor="${#dbeafe|#1e3a5f}"];
        bar [label="bar.js", fillcolor="${#dbeafe|#1e3a5f}"];
        dyn -> bar [label="require()"];
    }

    entry -> dyn [label="import()", style=dashed];
}
```

由于存在两组，最终自动代码分割会生成两个 chunk。

## **公共 chunk**

当某个模块被至少两个不同的入口静态导入时，就会生成**公共 chunk**。这些模块会被放入一个单独的 chunk 中。

这种行为的目的是：

- 确保最终 bundle 输出中的每个 JavaScript 模块都是单例。
- 当一个入口执行时，只应执行被导入的模块。

需要注意的是，某个模块是否可以被放入同一个公共 chunk，取决于它是否被相同的入口导入。

对于以下代码，将生成六个 chunk：

```js
// entry-a.js (包含在 `input` 选项中)
import 'shared-by-ab.js';
import 'shared-by-abc.js';
console.log(globalThis.value);

// entry-b.js (包含在 `input` 选项中)
import 'shared-by-ab.js';
import 'shared-by-bc.js';
import 'shared-by-abc.js';
console.log(globalThis.value);

// entry-c.js (包含在 `input` 选项中)
import 'shared-by-bc.js';
import 'shared-by-abc.js';
console.log(globalThis.value);

// shared-by-ab.js
globalThis.value = globalThis.value || [];
globalThis.value.push('ab');

// shared-by-bc.js
globalThis.value = globalThis.value || [];
globalThis.value.push('bc');

// shared-by-abc.js
globalThis.value = globalThis.value || [];
globalThis.value.push('abc');
```

这些 chunk 将按如下方式生成：

::: code-group

```js [entry-a.js]
import './common-ab.js';
import './common-abc.js';
```

```js [entry-b.js]
import './common-ab.js';
import './common-bc.js';
import './common-abc.js';
```

```js [entry-c.js]
import './common-bc.js';
import './common-abc.js';
```

```js [common-ab.js]
globalThis.value = globalThis.value || [];
globalThis.value.push('ab');
```

```js [common-bc.js]
globalThis.value = globalThis.value || [];
globalThis.value.push('bc');
```

```js [common-abc.js]
globalThis.value = globalThis.value || [];
globalThis.value.push('abc');
```

:::

下面的图展示了入口如何共享依赖，以及模块如何被分组到 chunk 中：

```dot
digraph {
    bgcolor="transparent";
    rankdir=TB;
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [fontname="Arial", fontsize=10, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    newrank=true;

    // 入口节点
    entry_a [label="entry-a.js", fillcolor="${#fff0e0|#4a2a0a}"];
    entry_b [label="entry-b.js", fillcolor="${#fff0e0|#4a2a0a}"];
    entry_c [label="entry-c.js", fillcolor="${#fff0e0|#4a2a0a}"];

    // 共享模块节点
    shared_ab [label="shared-by-ab.js", fillcolor="${#dbeafe|#1e3a5f}"];
    shared_bc [label="shared-by-bc.js", fillcolor="${#dbeafe|#1e3a5f}"];
    shared_abc [label="shared-by-abc.js", fillcolor="${#e0e7ff|#2e1065}"];

    // 边
    entry_a -> shared_ab;
    entry_a -> shared_abc;
    entry_b -> shared_ab;
    entry_b -> shared_bc;
    entry_b -> shared_abc;
    entry_c -> shared_bc;
    entry_c -> shared_abc;

    // chunk 分组
    subgraph cluster_chunk_a {
        label="entry-a.js chunk";
        labeljust="l";
        fontname="Arial";
        fontsize=11;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#d44803|#ff712a}";
        entry_a;
    }
    subgraph cluster_chunk_b {
        label="entry-b.js chunk";
        labeljust="l";
        fontname="Arial";
        fontsize=11;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#d44803|#ff712a}";
        entry_b;
    }
    subgraph cluster_chunk_c {
        label="entry-c.js chunk";
        labeljust="l";
        fontname="Arial";
        fontsize=11;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#d44803|#ff712a}";
        entry_c;
    }
    subgraph cluster_common_ab {
        label="common-ab.js chunk";
        labeljust="l";
        fontname="Arial";
        fontsize=11;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#0366d6|#58a6ff}";
        shared_ab;
    }
    subgraph cluster_common_bc {
        label="common-bc.js chunk";
        labeljust="l";
        fontname="Arial";
        fontsize=11;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#0366d6|#58a6ff}";
        shared_bc;
    }
    subgraph cluster_common_abc {
        label="common-abc.js chunk";
        labeljust="l";
        fontname="Arial";
        fontsize=11;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#0366d6|#58a6ff}";
        shared_abc;
    }
}
```

`entry-*.js` chunks 是根据上面讨论的原因生成的。`common-*.js` chunks 是**公共 chunk**。它们之所以被创建，是因为：

- `common-ab.js`：`shared-by-ab.js` 被 `entry-a.js` 和 `entry-b.js` 同时导入。
- `common-bc.js`：`shared-by-bc.js` 被 `entry-b.js` 和 `entry-c.js` 同时导入。
- `common-abc.js`：`shared-by-abc.js` 被全部 3 个入口导入。

你可能会问，为什么自动代码分割不把 `shared-by-*.js` 文件放入单个公共 chunk。原因是这样做会违背原始代码的意图。

对于上面的示例，如果创建一个单独的公共 chunk，它将类似于：

```js [common-all.js]
globalThis.value = globalThis.value || [];
globalThis.value.push('ab');
globalThis.value = globalThis.value || [];
globalThis.value.push('bc');
globalThis.value = globalThis.value || [];
globalThis.value.push('abc');
```

对于这个输出，执行每个入口都会输出 `['ab', 'bc', 'abc']`。然而，原始代码对每个入口输出的结果不同：

- `entry-a.js`：`['ab', 'abc']`
- `entry-b.js`：`['ab', 'bc', 'abc']`
- `entry-c.js`：`['bc', 'abc']`

关于如何解决这个问题，有一些讨论。一种方法是在原始顺序会被破坏时，将模块移动到额外的公共 chunk 中，但这可能会使输出碎片化。Rolldown 则提供了 [`strictExecutionOrder`](/reference/OutputOptions.strictExecutionOrder)，它会包装 ESM 模块主体，使它们能够按照源码顺序运行，同时仍然保持 ESM 输出。当一个被包装的动态入口最终与其他代码共享其实现 chunk 时，重写后的 `import()` 会触发实现本身。严格模式只在仍然需要真实文件的地方发出一个很小的入口 facade —— 例如当另一个 chunk 静态加载该入口的 chunk 时，或者对于插件发出的 chunk —— 因此输出 chunk 的形状仍然可能发生变化。默认情况下，严格模式会包装每个符合条件的模块；实验性的 `onDemandWrapping` 模式则根据预测的 chunk 执行风险推导出一个保守的子集。
