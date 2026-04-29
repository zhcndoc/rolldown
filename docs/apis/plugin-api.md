# 插件 API

## 概述

Rolldown 的插件接口几乎与 Rollup 的完全兼容（详细跟踪 [见此](https://github.com/rolldown/rolldown/issues/819)），所以如果你以前写过 Rollup 插件，你已经知道如何编写 Rolldown 插件了！

Rolldown 插件是一个满足下面所述 [插件接口](#plugin-interface) 的对象。
插件应当以包的形式发布，并导出一个可用插件特定选项调用的函数，该函数返回这样一个对象。

插件允许你自定义 Rolldown 的行为，例如，在打包之前转译代码，或者为一个不可用的内置模块提供 shim。

<!-- TODO: 添加一个关于如何使用插件以及如何查找插件的指南链接 -->

### 示例

下面的示例展示了一个 Rolldown 插件，它会拦截对 `example-virtual-module` 的导入请求，并为其返回自定义内容。

::: code-group

```js [rolldown-plugin-example.js]
const id = 'example-virtual-module';
const resolvedId = '\0' + id;

export default function examplePlugin() {
  return {
    name: 'example-plugin', // 这个名称会显示在日志和错误中
    resolveId(source) {
      if (source === id) {
        // 这会向 Rolldown 表示该导入应解析为名为 `\0example-virtual-module` 的模块
        return resolvedId;
      }
      return null; // 其他 id 应按常规方式处理
    },
    load(id) {
      if (id === resolvedId) {
        // `\0example-virtual-module` 的源代码
        return `export default 'Hello from ${id}';`;
      }
      return null; // 其他 id 应按常规方式处理
    },
  };
}
```

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';
import examplePlugin from './rolldown-plugin-example.js';

export default defineConfig({
  plugins: [examplePlugin()],
});
```

:::

::: tip 虚拟模块 {#virtual-modules}

此插件实现了一种通常称为“虚拟模块”的模式。
虚拟模块是文件系统中不存在的模块，而是由插件解析并提供。
在上面的示例中，`example-virtual-module` 从未从磁盘读取，因为插件在 `resolveId` 中拦截了导入，并在 `load` 中提供了该模块的源代码。
这种模式适用于注入辅助函数。

:::

::: warning Hook Filters

为了简单起见，这个示例插件没有使用 [Hook Filters](/apis/plugin-api/hook-filters)。
为了提升性能，建议在可能时使用它们。

:::

## 约定

- 插件应具有清晰的名称，并带有 `rolldown-plugin-` 前缀。
- 在 package.json 的 `keywords` 字段中包含 `rolldown-plugin` 关键字。
- 确保你的插件在适当情况下输出正确的源映射。
- 如果你的插件使用了 ["virtual modules"](#virtual-modules)，请在模块 ID 前加上 `\0` 前缀。这可以防止其他插件尝试处理它。
- （推荐）插件应进行测试。
- （推荐）插件应使用英文文档。

<!-- TODO: 添加一个如何测试插件的指南 -->

## 插件接口

[`Plugin`](/reference/Interface.Plugin) 接口具有一个必需的 `name` 属性以及多个可选属性和钩子。

钩子是定义在插件上的方法，可用于与构建过程交互。它们会在构建的各个阶段被调用。钩子可以影响构建的运行方式，提供构建信息，或者在构建完成后修改构建结果。钩子有不同类型：

- `async`：该钩子也可以返回一个 Promise，解析为同类型的值；否则，该钩子标记为 `sync`。
- `first`：如果有多个插件实现了此钩子，这些钩子会按顺序运行，直到某个钩子返回非 `null` 或 `undefined` 的值。
- `sequential`：如果有多个插件实现了此钩子，它们都会按照指定的插件顺序运行。如果某个钩子是 `async`，后续同类钩子会等待当前钩子解析完成。
- `parallel`：如果有多个插件实现了此钩子，它们都会按照指定的插件顺序运行。如果某个钩子是 `async`，后续同类钩子会并行运行，不会等待当前钩子。

钩子除了可以是方法，也可以是带有 `handler` 属性的对象。在这种情况下，`handler` 属性才是实际的钩子方法。这使你可以提供额外的可选属性来控制钩子的行为。更多信息请参见 [`ObjectHook`](/reference/TypeAlias.ObjectHook) 类型。

钩子分为两类：[构建钩子](#build-hooks) 和 [输出生成钩子](#output-generation-hooks)。

### 构建钩子

构建钩子在构建阶段运行。它们主要负责在输入文件被 Rolldown 处理之前定位、提供和转换输入文件。

构建阶段的第一个钩子是 [`options`](/reference/Interface.Plugin#options)，最后一个总是 [`buildEnd`](/reference/Interface.Plugin#buildend)。如果发生构建错误，之后会调用 [`closeBundle`](/reference/Interface.Plugin#closebundle)。

```dot+hooks-graph
# styles
sequential: fillcolor="#ffe8cc", dark$fillcolor="#9d4f1a"
parallel: fillcolor="#ffcccc", dark$fillcolor="#8a2a2a"
first: fillcolor="#fff4cc", dark$fillcolor="#9d7a1a"
internal: fillcolor="#f0f0f0", dark$fillcolor="#3a3a3a"
sync: color="#3c3c43", dark$color="#dfdfd6"
async: color="#ff7e17", dark$color="#cc5f1a", penwidth=1

# nodes
watchChange(/reference/Interface.Plugin#watchchange): parallel, async
closeWatcher(/reference/Interface.Plugin#closewatcher): parallel, async
options(/reference/Interface.Plugin#options): sequential, async
outputOptions(/reference/Interface.Plugin#outputoptions): sequential, async
buildStart(/reference/Interface.Plugin#buildstart): parallel, async
resolveId(/reference/Interface.Plugin#resolveid): first, async
load(/reference/Interface.Plugin#load): first, async
transform(/reference/Interface.Plugin#transform): sequential, async
moduleParsed(/reference/Interface.Plugin#moduleparsed): parallel, async
internalTransform: internal
resolveDynamicImport(/reference/Interface.Plugin#resolvedynamicimport): first, async
buildEnd(/reference/Interface.Plugin#buildend): parallel, async

# edges
options -> outputOptions
outputOptions -> buildStart
buildStart -> resolveId: each entry
resolveId .-> buildEnd: external
resolveId -> load: non-external
load -> transform
transform -> internalTransform
internalTransform -> moduleParsed
moduleParsed .-> buildEnd: no imports
moduleParsed -> resolveDynamicImport: each import()
resolveDynamicImport -> load: non-external
moduleParsed -> resolveId: each import
resolveDynamicImport .-> buildEnd: external
resolveDynamicImport -> resolveId: unresolved
```

请注意，上图中的 `internalTransform` 不是插件钩子，它是 Rolldown 将非 JS 代码转换为 JS 的步骤。

此外，在 watch 模式下，[`watchChange`](/reference/Interface.Plugin#watchchange) 钩子可以在任何时候被触发，以通知在当前运行生成输出后将触发一次新的运行。同时，当 watcher 关闭时，[`closeWatcher`](/reference/Interface.Plugin#closewatcher) 钩子将被触发。

::: warning 不支持的钩子

Rollup 支持但 Rolldown 不支持的构建钩子如下：

- `shouldTransformCachedModule` ([#4389](https://github.com/rolldown/rolldown/issues/4389))

:::

### 输出生成钩子

输出生成钩子可以提供有关已生成 bundle 的信息，并在完成后修改构建结果。仅使用输出生成钩子的插件也可以通过输出选项传入，因此只会对某些输出运行。

输出生成阶段的第一个钩子是 [`renderStart`](/reference/Interface.Plugin#renderstart)，最后一个要么是 [`generateBundle`](/reference/Interface.Plugin#generatebundle)，前提是输出已通过 [`bundle.generate(...)`](/reference/Interface.RolldownBuild#generate) 成功生成；要么是 [`writeBundle`](/reference/Interface.Plugin#writebundle)，前提是输出已通过 [`bundle.write(...)`](/reference/Interface.RolldownBuild#write) 成功生成；或者是在输出生成期间任何时候发生错误时的 [`renderError`](/reference/Interface.Plugin#rendererror)。

此外，[`closeBundle`](/reference/Interface.Plugin#closebundle) 也可以作为最后一个钩子被调用，但这需要用户手动调用 [`bundle.close()`](/reference/Interface.RolldownBuild#close) 来触发。CLI 会始终确保这一点。

```dot+hooks-graph
# config
margin=150,0

# styles
sequential: fillcolor="#ffe8cc", dark$fillcolor="#9d4f1a"
parallel: fillcolor="#ffcccc", dark$fillcolor="#8a2a2a"
first: fillcolor="#fff4cc", dark$fillcolor="#9d7a1a"
internal: fillcolor="#f0f0f0", dark$fillcolor="#3a3a3a"
sync: color="#3c3c43", dark$color="#dfdfd6"
async: color="#ff7e17", dark$color="#cc5f1a", penwidth=1
!option: fillcolor="transparent"
!invisible: label="", shape=circle, fixedsize=true, width=0.2, height=0.2, style=filled, fillcolor="#ffffff"

# nodes
renderStart(/reference/Interface.Plugin#renderstart): parallel, sync
banner(/reference/Interface.Plugin#banner): sequential, sync
footer(/reference/Interface.Plugin#footer): sequential, sync
intro(/reference/Interface.Plugin#intro): sequential, sync
outro(/reference/Interface.Plugin#outro): sequential, sync
renderChunk(/reference/Interface.Plugin#renderchunk): sequential, sync
minify: internal
postBanner: option, sync
postFooter: option, sync
augmentChunkHash(/reference/Interface.Plugin#augmentchunkhash): sequential, async
generateBundle(/reference/Interface.Plugin#generatebundle): sequential, sync
writeBundle(/reference/Interface.Plugin#writebundle): parallel, sync
renderError(/reference/Interface.Plugin#rendererror): parallel, sync
closeBundle(/reference/Interface.Plugin#closebundle): parallel, sync
beforeAddons: invisible
afterAddons: invisible

# groups
generateChunks: beforeAddons, banner, footer, intro, outro, afterAddons

# edges
renderStart -> beforeAddons: each chunk
augmentChunkHash -> generateBundle
generateBundle -> writeBundle
writeBundle .-> closeBundle
beforeAddons -> banner
beforeAddons -> footer
beforeAddons -> intro
beforeAddons -> outro
banner -> afterAddons
footer -> afterAddons
intro -> afterAddons
outro -> afterAddons
afterAddons .-> beforeAddons: next chunk, constraint=false
afterAddons -> renderChunk: each chunk
renderChunk -> minify
minify -> postBanner
minify -> postFooter
postBanner -> augmentChunkHash
postFooter -> augmentChunkHash
augmentChunkHash .-> renderChunk: next chunk, constraint=false
renderError .-> closeBundle
```

请注意，上图中的 `minify` 不是插件钩子，它是 Rolldown 运行压缩器的步骤。另请注意，`postBanner` 和 `postFooter` 不是插件钩子，这些是输出选项，并且不像 `banner` 和 `footer` 那样有对应的钩子。

::: warning 不支持的钩子

Rollup 支持但 Rolldown 不支持的输出生成钩子如下：

- `resolveImportMeta` ([#1010](https://github.com/rolldown/rolldown/issues/1010))
- `resolveFileUrl`
- `renderDynamicImport` ([#4532](https://github.com/rolldown/rolldown/issues/4532))

:::

## 插件上下文

大多数钩子中都可以通过 `this` 访问一些实用函数和信息片段。有关更多信息，请参阅 [`PluginContext`](/reference/Interface.PluginContext) 类型。

## 支持 TypeScript 和 JSX

为了实现最佳性能，Rolldown 会在调用 [`transform`](/reference/Interface.Plugin#transform) 钩子后运行内部转换，将 TypeScript 和 JSX 转换为 JavaScript。这意味着使用 `transform` 钩子的插件需要支持 TypeScript 和 JSX。基本上，实现这一点有两种方式。

### 处理 TypeScript 和 JSX 语法

[`this.parse`](/reference/Interface.PluginContext#parse) 支持通过传递 `lang` 选项来解析 TypeScript 和 JSX。这应当能够让插件轻松处理 TypeScript 和 JSX。

### 预先转换 TypeScript 和 JSX

如果处理 TypeScript 和 JSX AST 不是一个选项，你仍然可以使用从 `rolldown/utils` 暴露的 `transform` 函数将它们转换为 JavaScript。请注意，这会带来额外开销。

## 与 Rollup 的显著差异

尽管 Rolldown 的插件接口与 Rollup 的大体兼容，但仍有一些重要的行为差异需要注意：

### 输出生成处理

在 Rollup 中，所有输出会在单个进程中一起生成。然而，Rolldown 会分别处理每个输出的生成。这意味着如果你有多个输出配置，Rolldown 将独立处理每个输出，这可能会影响某些插件的行为，尤其是那些在整个构建过程中维护状态的插件。

具体差异如下：

- [`outputOptions`](/reference/Interface.FunctionPluginHooks#outputoptions) 钩子在 Rolldown 中会在构建钩子之前调用，而 Rollup 会在构建钩子之后调用
- 构建钩子会针对每个输出分别调用，而 Rollup 会对所有输出只调用一次
- [`closeBundle`](/reference/Interface.FunctionPluginHooks#closebundle) 钩子仅在你至少调用过一次 [`generate()`](/reference/Interface.RolldownBuild#generate) 或 [`write()`](/reference/Interface.RolldownBuild#write) 时才会调用，而 Rollup 无论你是否调用过 `generate()` 或 `write()` 都会调用它

### 监听模式下的钩子行为

在 Rollup 中，[`options`](/reference/Interface.Plugin#options) 钩子会在监听模式下的每次重新构建时调用。在 Rolldown 中，`options` 钩子仅在创建监听器时调用一次，后续的重新构建不会再次调用。

### 顺序执行钩子

在 Rollup 中，某些钩子如 [`writeBundle`](/reference/Interface.FunctionPluginHooks#writebundle) 默认是“并行”的，这意味着它们会在多个插件之间并发运行。如果插件需要按顺序逐个执行这些钩子，就必须显式设置 `sequential: true`。

在 Rolldown 中，[`writeBundle`](/reference/Interface.FunctionPluginHooks#writebundle) 钩子默认已经是顺序执行的，因此插件不需要为此钩子指定 `sequential: true`。
