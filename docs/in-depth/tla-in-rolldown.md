# Rolldown 中的顶层 await（TLA）

背景知识：

- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await#top_level_await
- https://github.com/tc39/proposal-top-level-await

## Rolldown 如何处理 TLA

目前，rolldown 支持 TLA 的原则是：我们会在打包后让它可用，但不会 100% 保留与原始代码完全一致的语义。

当前规则是：

- 如果你的输入包含 TLA，那么它只能以 `esm` 格式打包和输出。
- 禁止 `require` TLA 模块。

## 从并发到顺序

rolldown 中 TLA 的一个缺点是，它会把原始代码的行为从并发改为顺序。它仍然能保证相对顺序，但确实会降低执行速度，并且如果原始代码依赖并发，可能会导致执行失败。

```dot
digraph {
    bgcolor="transparent";
    rankdir=LR;
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [fontname="Arial", fontsize=10, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    compound=true;

    subgraph cluster_before {
        label="打包前（并发）";
        labeljust="l";
        fontname="Arial";
        fontsize=12;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#22863a|#3fb950}";

        b_main [label="main.js\nimport tla1, tla2", fillcolor="${#fff0e0|#4a2a0a}"];
        b_all [label="Promise.all([\n  tla1,\n  tla2\n])", fillcolor="${#dcfce7|#14532d}"];
        b_tla1 [label="tla1.js\nawait ...", fillcolor="${#dbeafe|#1e3a5f}"];
        b_tla2 [label="tla2.js\nawait ...", fillcolor="${#dbeafe|#1e3a5f}"];
        b_done [label="均已解析", fillcolor="${#dcfce7|#14532d}"];

        b_main -> b_all;
        b_all -> b_tla1;
        b_all -> b_tla2;
        b_tla1 -> b_done;
        b_tla2 -> b_done;
    }

    subgraph cluster_after {
        label="打包后（顺序）";
        labeljust="l";
        fontname="Arial";
        fontsize=12;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#d44803|#ff712a}";

        a_tla1 [label="await tla1", fillcolor="${#dbeafe|#1e3a5f}"];
        a_tla2 [label="await tla2", fillcolor="${#dbeafe|#1e3a5f}"];
        a_main [label="console.log(\n  foo1, foo2\n)", fillcolor="${#fff0e0|#4a2a0a}"];

        a_tla1 -> a_tla2 [label="then"];
        a_tla2 -> a_main [label="then"];
    }
}
```

一个真实世界中的例子可能如下所示

```js
// main.js
import { bar } from './sync.js';
import { foo1 } from './tla1.js';
import { foo2 } from './tla2.js';
console.log(foo1, foo2, bar);

// tla1.js

export const foo1 = await Promise.resolve('foo1');

// tla2.js

export const foo2 = await Promise.resolve('foo2');

// sync.js

export const bar = 'bar';
```

打包之后，它会变成

```js
// tla1.js
const foo1 = await Promise.resolve('foo1');

// tla2.js
const foo2 = await Promise.resolve('foo2');

// sync.js
const bar = 'bar';

// main.js
console.log(foo1, foo2, bar);
```

你可以看到，在打包后的代码中，promise `foo1` 和 `foo2` 是顺序解析的，而在原始代码中，它们是并发解析的。

TLA 规范仓库里有一个非常 [好的例子](https://github.com/tc39/proposal-top-level-await?tab=readme-ov-file#semantics-as-desugaring)，它解释了 TLA 的工作心理模型

```js
import { a } from './a.mjs';
import { b } from './b.mjs';
import { c } from './c.mjs';

console.log(a, b, c);
```

可以被认为在反糖化后等同于如下代码：

```js
import { a, promise as aPromise } from './a.mjs';
import { b, promise as bPromise } from './b.mjs';
import { c, promise as cPromise } from './c.mjs';

export const promise = Promise.all([aPromise, bPromise, cPromise]).then(() => {
  console.log(a, b, c);
});
```

然而，在 rolldown 中，打包后它看起来会像这样：

```js
import { a, promise as aPromise } from './a.mjs';
import { b, promise as bPromise } from './b.mjs';
import { c, promise as cPromise } from './c.mjs';

await aPromise;
await bPromise;
await cPromise;

console.log(a, b, c);
```
