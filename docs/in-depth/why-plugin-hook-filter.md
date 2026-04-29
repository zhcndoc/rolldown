# 为什么需要插件 Hook 过滤器？

## 问题

尽管 Rolldown 的核心是用 Rust 编写的，并且具备并行处理能力，**添加 JavaScript 插件仍然会显著拖慢构建速度**。为什么？因为每个插件 hook 都会针对 _每个_ 模块被调用一次，即使插件并不关心其中大多数模块。

例如，如果你有一个只处理 `.css` 文件的 CSS 插件，它仍然会对项目中的每个 `.js`、`.ts`、`.jsx` 以及其他文件被调用。随着插件数量增加到 10 个，这种开销会成倍增长，导致构建时间增加 **3-4 倍**。

插件 hook 过滤器通过让 Rolldown 在 Rust 层跳过不必要的插件调用来解决这个问题，即使有很多插件，也能保持构建速度。

## 真实影响

让我们通过一个使用 [apps/10000](https://github.com/rolldown/benchmarks/tree/main/apps/10000) 的基准测试来看实际的性能差异：
分支：https://github.com/rolldown/benchmarks/pull/3

```diff
diff --git a/apps/10000/rolldown.config.mjs b/apps/10000/rolldown.config.mjs
--- a/apps/10000/rolldown.config.mjs
+++ b/apps/10000/rolldown.config.mjs
@@ -1,8 +1,25 @@
 import { defineConfig } from "rolldown";
-import { minify } from "rollup-plugin-esbuild";
+// import { minify } from "rollup-plugin-esbuild";
 const sourceMap = !!process.env.SOURCE_MAP;
 const m = !!process.env.MINIFY;
+const transformPluginCount = process.env.PLUGIN_COUNT || 0;

+let transformCssPlugin = Array.from({ length: transformPluginCount }, (_, i) => {
+  let index = i + 1;
+  return {
+    name: `transform-css-${index}`,
+    transform(code, id) {
+      if (id.endsWith(`foo${index}.css`)) {
+        return {
+          code: `.index-${index} {
+  color: red;
+}`,
+          map: null,
+        };
+      }
+    }
+  }
+})
 export default defineConfig({
 	input: {
 		main: "./src/index.jsx",
@@ -11,13 +28,7 @@ export default defineConfig({
 		"process.env.NODE_ENV": JSON.stringify("production"),
 	},
 	plugins: [
-		m
-			? minify({
-					minify: true,
-					legalComments: "none",
-					target: "es2022",
-				})
-			: null,
+    ...transformCssPlugin,
 	].filter(Boolean),
 	profilerNames: !m,
 	output: {
diff --git a/apps/10000/src/index.css b/apps/10000/src/index.css
deleted file mode 100644
diff --git a/apps/10000/src/index.jsx b/apps/10000/src/index.jsx
--- a/apps/10000/src/index.jsx
+++ b/apps/10000/src/index.jsx
@@ -1,7 +1,16 @@
 import React from "react";
 import ReactDom from "react-dom/client";
 import App1 from "./f0";
-import './index.css'
+import './foo1.css'
+import './foo2.css'
+import './foo3.css'
+import './foo4.css'
+import './foo5.css'
+import './foo6.css'
+import './foo7.css'
+import './foo8.css'
+import './foo9.css'
+import './foo10.css'

 ReactDom.createRoot(document.getElementById("root")).render(
 	<React.StrictMode>
```

**设置：**

- 10 个 CSS 文件（`foo1.css` 到 `foo10.css`）
- 每个插件只转换一个特定的 CSS 文件（例如，插件 1 只关心 `foo1.css`）
- 通过 `PLUGIN_COUNT` 控制插件数量
- 插件使用标准模式：检查文件是否匹配，不匹配则提前返回

### 不使用过滤器（传统方式）

```bash
Benchmark 1: PLUGIN_COUNT=0 node --run build:rolldown
  Time (mean ± σ):     745.6 ms ±  11.8 ms    [User: 2298.0 ms, System: 1161.3 ms]
  Range (min … max):   732.1 ms … 753.6 ms    3 runs

Benchmark 2: PLUGIN_COUNT=1 node --run build:rolldown
  Time (mean ± σ):     862.6 ms ±  61.3 ms    [User: 2714.1 ms, System: 1192.6 ms]
  Range (min … max):   808.3 ms … 929.2 ms    3 runs

Benchmark 3: PLUGIN_COUNT=2 node --run build:rolldown
  Time (mean ± σ):      1.106 s ±  0.020 s    [User: 3.287 s, System: 1.382 s]
  Range (min … max):    1.091 s …  1.130 s    3 runs

Benchmark 4: PLUGIN_COUNT=5 node --run build:rolldown
  Time (mean ± σ):      1.848 s ±  0.022 s    [User: 4.398 s, System: 1.728 s]
  Range (min … max):    1.825 s …  1.869 s    3 runs

Benchmark 5: PLUGIN_COUNT=10 node --run build:rolldown
  Time (mean ± σ):      2.792 s ±  0.065 s    [User: 6.013 s, System: 2.198 s]
  Range (min … max):    2.722 s … 2.850 s    3 runs

Summary
 'PLUGIN_COUNT=0 node --run build:rolldown' ran
    1.16 ± 0.08 times faster than 'PLUGIN_COUNT=1 node --run build:rolldown'
    1.48 ± 0.04 times faster than 'PLUGIN_COUNT=2 node --run build:rolldown'
    2.48 ± 0.05 times faster than 'PLUGIN_COUNT=5 node --run build:rolldown'
    3.74 ± 0.10 times faster than 'PLUGIN_COUNT=10 node --run build:rolldown'
```

**关键结论：** 构建时间会随着插件数量线性增长——10 个插件会慢 **3.74 倍**（2.8s 对比 745ms）。

## 解决方案：插件 Hook 过滤器

不要对每个模块都调用每个插件，而是使用 `filter` 告诉 Rolldown 每个插件关心哪些文件。方法如下：

```diff
diff --git a/apps/10000/rolldown.config.mjs b/apps/10000/rolldown.config.mjs
index 822af995..dee07e68 100644
--- a/apps/10000/rolldown.config.mjs
+++ b/apps/10000/rolldown.config.mjs
@@ -8,14 +8,21 @@ let transformCssPlugin = Array.from({ length: transformPluginCount }, (_, i) =>
   let index = i + 1;
   return {
     name: `transform-css-${index}`,
-    transform(code, id) {
-      if (id.endsWith(`foo${index}.css`)) {
-        return {
-          code: `.index-${index} {
+    transform: {
+      filter: {
+        id: {
+          include: new RegExp(`foo${index}.css$`),
+        }
+      },
+      handler(code, id) {
+        if (id.endsWith(`foo${index}.css`)) {
+          return {
+            code: `.index-${index} {
   color: red;
 }`,
-          map: null,
-        };
+            map: null,
+          };
+        }
       }
     }
   }
```

**发生了什么变化：**

- 将 `transform` 函数包装到一个带有 `handler` 和 `filter` 属性的对象中
- 添加了 `filter.id.include`，使用正则表达式匹配该插件关心的文件
- Rolldown 现在会在进入 JavaScript 之前，先在 Rust 中检查过滤器

### 使用过滤器（优化后）

```bash
Benchmark 1: PLUGIN_COUNT=0 node --run build:rolldown
  Time (mean ± σ):     739.1 ms ±   6.8 ms    [User: 2312.5 ms, System: 1153.0 ms]
  Range (min … max):   733.0 ms … 746.5 ms    3 runs

Benchmark 2: PLUGIN_COUNT=1 node --run build:rolldown
  Time (mean ± σ):     760.6 ms ±  18.3 ms    [User: 2422.1 ms, System: 1107.4 ms]
  Range (min … max):   739.7 ms … 773.6 ms    3 runs

Benchmark 3: PLUGIN_COUNT=2 node --run build:rolldown
  Time (mean ± σ):     731.2 ms ±  11.1 ms    [User: 2461.3 ms, System: 1141.4 ms]
  Range (min … max):   723.9 ms … 744.0 ms    3 runs

Benchmark 4: PLUGIN_COUNT=5 node --run build:rolldown
  Time (mean ± σ):     741.5 ms ±   9.3 ms    [User: 2621.6 ms, System: 1111.3 ms]
  Range (min … max):   734.0 ms … 751.9 ms    3 runs

Benchmark 5: PLUGIN_COUNT=10 node --run build:rolldown
  Time (mean ± σ):     747.3 ms ±   2.1 ms    [User: 2900.9 ms, System: 1120.0 ms]
  Range (min … max):   745.0 ms … 749.2 ms    3 runs

Summary
  'PLUGIN_COUNT=2 node --run build:rolldown' ran
    1.01 ± 0.02 times faster than 'PLUGIN_COUNT=0 node --run build:rolldown'
    1.01 ± 0.02 times faster than 'PLUGIN_COUNT=5 node --run build:rolldown'
    1.02 ± 0.02 times faster than 'PLUGIN_COUNT=10 node --run build:rolldown'
    1.04 ± 0.03 times faster than 'PLUGIN_COUNT=1 node --run build:rolldown'
```

**关键结论：** 使用过滤器后，所有插件数量的性能几乎一致（约 740ms）。开销已经被**消除**了。

### 性能对比

| 插件数量  | 不使用过滤器 | 使用过滤器 | 加速比    |
| --------- | ------------ | ---------- | --------- |
| 0 个插件  | 745ms        | 739ms      | 1.0x      |
| 1 个插件  | 863ms        | 761ms      | 1.13x     |
| 2 个插件  | 1,106ms      | 731ms      | 1.51x     |
| 5 个插件  | 1,848ms      | 742ms      | 2.49x     |
| 10 个插件 | 2,792ms      | 747ms      | **3.74x** |

**一句话总结：** 当你的插件只关心特定文件时，请使用过滤器，以便在增加插件数量时仍能保持快速构建。

## 底层工作原理

要理解为什么过滤器如此有效，你需要了解 Rolldown 如何使用 JavaScript 插件处理模块。

Rolldown 使用并行处理（类似于 [生产者-消费者问题](https://en.wikipedia.org/wiki/Producer%E2%80%93consumer_problem)）来高效构建模块图。下面是一个简单的依赖图来说明：

**依赖图**

```dot [Dependency Graph]
digraph {
    bgcolor="transparent";
    rankdir=TB;
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [fontname="Arial", fontsize=10, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];

    a [label="a.js", fillcolor="${#fff0e0|#4a2a0a}"];
    b [label="b.js", fillcolor="${#dbeafe|#1e3a5f}"];
    c [label="c.js", fillcolor="${#dbeafe|#1e3a5f}"];
    d [label="d.js", fillcolor="${#dbeafe|#1e3a5f}"];
    e [label="e.js", fillcolor="${#dbeafe|#1e3a5f}"];
    f [label="f.js", fillcolor="${#dbeafe|#1e3a5f}"];

    a -> b;
    a -> c;
    b -> d;
    b -> e;
    c -> f;
}
```

### 没有 JavaScript 插件

![没有 JavaScript 插件时的打包](https://github.com/user-attachments/assets/ad071cf9-6a34-4a7d-a669-02efec342d45)

所有任务都在 Rust 中并行运行。多个 CPU 核心同时处理模块，最大化吞吐量。

> [!NOTE]
> 这些图展示的是概念性算法，而不是精确的实现细节。为便于说明，有些时间片被夸大了——`fetch_module` 实际上运行速度是微秒级的。

### 有 JavaScript 插件（无过滤器）

![有 JavaScript 插件时的打包](https://github.com/user-attachments/assets/7e95fb60-d345-4d23-a35e-c7d062fa2b70)

瓶颈在这里：**JavaScript 插件在单线程中运行**。尽管 Rolldown 的 Rust 核心是并行的，但每个模块都必须：

1. 在“菱形”处停下来（hook 调用阶段）
2. 跨越 Rust → JavaScript 的 FFI 边界
3. 等待 _所有_ 插件串行执行
4. 再从 JavaScript → Rust 返回

这个串行化点会成为一个主要瓶颈。注意随着插件数量增加，菱形区域会变得更宽，而 CPU 核心则在等待 JavaScript 时处于空闲状态。

### 使用过滤器（优化后）

添加过滤器后，Rolldown 会在跨入 JavaScript 之前，先在 **Rust 中** 计算过滤条件：

```
对于每个模块：
  对于每个插件：
    ✓ 在 Rust 中检查过滤器（微秒级）
    ✗ 如果不匹配则跳过
    → 只为匹配的插件调用 JavaScript
```

这消除了大部分 FFI 开销和 JavaScript 执行时间。在基准测试中，大多数插件并不匹配大多数文件，因此几乎所有调用都被跳过了。菱形区域缩小了，CPU 利用率保持在高位，构建时间依然很快。

## 何时使用过滤器

**在以下情况下使用过滤器：**

- ✅ 你的插件只处理特定文件类型（例如 `.css`、`.svg`、`.md`）
- ✅ 你的插件针对特定目录（例如 `src/**`、`node_modules/**`）
- ✅ 你的构建中有多个插件
- ✅ 你关注构建性能

## 快速参考

```js
// ❌ 没有过滤器 - 对每个模块都会调用
export default {
  name: 'my-plugin',
  transform(code, id) {
    if (!id.endsWith('.css')) return;
    // ... 转换 CSS
  },
};

// ✅ 使用过滤器 - 仅对 CSS 文件调用
export default {
  name: 'my-plugin',
  transform: {
    filter: {
      id: { include: /\.css$/ },
    },
    handler(code, id) {
      // ... 转换 CSS
    },
  },
};
```

查看 [插件钩子过滤器用法](/apis/plugin-api/hook-filters) 以获取完整的过滤器 API 和选项。
