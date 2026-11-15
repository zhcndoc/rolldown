# 构建报告

使用 `devtools: { mode: 'report' }` 时，Rolldown 会生成一份构建报告，其中包含关于每次构建的 Markdown 和 JSON 文件。报告展示构建耗时分布、输出内容，以及与上一次构建相比的变化。你可以将该文件夹交给代码代理、自己阅读，或在脚本中使用其中的数据。

::: warning 实验性
`devtools` 选项目前处于实验阶段。报告格式在后续版本中可能会变化。生成报告需要 Rolldown 1.3.0 或更高版本。
:::

## 为什么需要构建报告

默认的 `'full'` 模式会将每个构建事件及各模块的源文本写入日志，供 Vite DevTools 等可视化工具使用。代码代理不需要可视化界面。只有这份日志时，代理必须编写脚本，从大型应用中可能达到数 GB 的文件里提取数据。这会占用 token 和上下文窗口空间。

这份报告是为代码代理设计的。Rolldown 会计算插件耗时、构建变化和保留大小等数据，由代理读取结果。代理会先查看 `entry.md`（下方构建中为 1.6 KB），只在需要时再打开其他文件。用户和脚本也可以使用这份报告。

下表展示了基准测试仓库中 [`apps/10000`](https://github.com/rolldown/benchmarks/tree/main/apps/10000) 的一次构建：

| `devtools`       | 写入数据 | 构建耗时 |
| ---------------- | -------- | -------- |
| 关闭             | 无       | 1.18 s   |
| `mode: 'report'` | 4.5 MB   | 1.59 s   |
| `mode: 'full'`   | 185 MB   | 1.59 s   |

构建耗时是在 Apple M3 Max 上构建 5 次所得的中位数，其中包含 Node.js 启动耗时。两种模式收集相同的事件，因此都会拖慢构建。只在调查构建情况时启用报告。

4.5 MB 中的大部分是 `module-graph.json`。代码代理和脚本会查询该文件，而不会完整读取它。所有 Markdown 文件加起来只有 14 KB，因为大多数列表只保留前 20 项。

## 用法

::: code-group

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';

export default defineConfig({
  input: 'src/main.js',
  devtools: { mode: 'report' },
});
```

```js [vite.config.js]
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rolldownOptions: {
      devtools: { mode: 'report' },
    },
  },
});
```

```sh [CLI]
$ rolldown src/main.js -d dist --devtools.mode report
```

:::

Vite 8 使用 Rolldown。要查看项目使用的 Rolldown 版本，请运行 `npm ls rolldown`。

## 报告位置

Rolldown 会将报告写入相对于 [`cwd`](/reference/InputOptions.cwd) 的 `node_modules/.rolldown/report/<output dir>/`。`<output dir>` 是相对于 `cwd` 的输出目录（`output.dir`、`output.file` 所在目录或 `dist`）。其中每个 `..` 都会替换为 `__`：

| 输出目录 | 报告目录                                  |
| -------- | ----------------------------------------- |
| `dist`        | `node_modules/.rolldown/report/dist/`   |
| `../out`      | `node_modules/.rolldown/report/__/out/` |

每个输出目录都有自己的报告。

bundle 关闭时，Rolldown 才会写入报告。`build()`、CLI 和 `vite build` 都会关闭 bundle。使用 [`rolldown()`](/reference/Function.rolldown) API 时，请调用 `bundle.close()`：

```js
import { rolldown } from 'rolldown';

const bundle = await rolldown({
  input: 'src/main.js',
  devtools: { mode: 'report' },
});
await bundle.write({ dir: 'dist' });
await bundle.close(); // Rolldown writes the report here
```

## 阅读构建报告

本例为 `apps/10000` 添加了一个插件。该插件只处理 `.css` 文件，但没有[钩子过滤器](/apis/plugin-api/hook-filters)，因此 Rolldown 会对每个模块都运行它。

```js [rolldown.config.js]
export default defineConfig({
  // ... the config of the app
  devtools: { mode: 'report' },
  plugins: [
    {
      name: 'my-css-plugin',
      transform(code, id) {
        if (!id.endsWith('.css')) return;
        // ... transform CSS
      },
    },
  ],
});
```

### 从 `entry.md` 开始

摘要会展示主要数据，以及接下来要打开的文件：

```text [entry.md]
Build 843.6 ms · output 1.8 MB · 20014 modules (10002 external) / 1 chunk / 1 asset / 4 packages · browser / es · build #1

9 plugin hooks did no work in any call — a hook filter would skip those calls (`timing.md`, "Hooks that did no work")
```

### 在 `timing.md` 中查找原因

以下是 hook 表格的前几行：

| 插件                  | Hook      | 调用次数 | 无操作次数   | 耗时     |
| --------------------- | --------- | ----- | ------------ | -------- |
| `my-css-plugin`       | transform | 10012 | 10012 (100%) | 307.99 s |
| `builtin:data-url`    | resolveId | 50013 | 50013 (100%) | 812.4 ms |
| `builtin:oxc-runtime` | resolveId | 50013 | 50013 (100%) | 763.7 ms |

`my-css-plugin` 的 10012 次调用都没有执行任何工作，因此应优先处理这个 hook。需要注意两点：

- 307.99 s 远大于 843.6 ms 的构建耗时。该列是所有调用的耗时总和，每次调用还包含等待 JavaScript 线程的时间。不要将这一列当作构建耗时。
- `builtin:*` hook 在 Rust 中运行，因此它们的无操作调用开销很小。

### 在 `delta.md` 中查看结果

添加过滤器后重新构建。过滤器为何有帮助，请参阅[为什么需要插件 Hook 过滤器？](/in-depth/why-plugin-hook-filter)。

```js
transform: {
  filter: { id: /\.css$/ },
  handler(code, id) {
    // ... transform CSS
  },
},
```

`delta.md` 会将本次构建与上一次构建进行比较：

| 指标                      | 上一次   | 当前     | Δ         | Δ%     |
| ------------------------- | -------- | -------- | --------- | ------ |
| `build.scan_ms`           | 452.5 ms | 427.9 ms | -24.5 ms  | -5.4%  |
| `build.total_ms`          | 843.6 ms | 810.6 ms | -33.0 ms  | -3.9%  |
| `plugins.hook_call_count` | 190086   | 180074   | -10012    | -5.3%  |
| `plugins.hook_time_ms`    | 310.71 s | 2.64 s   | -308.07 s | -99.2% |

要衡量这项变化，请看 `build.total_ms`，而不是 `plugins.hook_time_ms`。hook 耗时虽然下降了 99%，但大部分时间都花在等待上。

一组构建也会受到噪声影响。在这类构建的 5 组对比中，耗时降幅为 3.9% 到 6.7%。要验证改动，请[固定基线](#compare-builds)，然后运行多次构建。

## Rolldown 如何生成报告

构建期间，Rolldown 会在内存中将事件转换为数量、大小、图表和耗时数据，不会保留模块源文本。bundle 关闭时，Rolldown 会将文件写入磁盘。

```dot
digraph {
    bgcolor="transparent";
    rankdir=LR;
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [fontname="Arial", fontsize=10, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];

    build [label="Build\nscan, generate", fillcolor="${#fff0e0|#4a2a0a}"];
    memory [label="Memory\ncounts, sizes,\ngraphs, timings", fillcolor="${#dbeafe|#1e3a5f}"];
    folder [label="Report folder\nentry.md, metrics.json,\n.state.json, ...", fillcolor="${#dcfce7|#14532d}"];
    next [label="Next build", fillcolor="${#fff0e0|#4a2a0a}"];

    build -> memory [label="events"];
    memory -> folder [label="bundle closes"];
    folder -> next [label="compare with\n.state.json", style=dashed];
}
```

- `metrics.json` 保存各项数据，Markdown 文件展示其中一部分。
- `module-graph.json` 和 `chunk-graph.json` 保存完整图表，数据量太大，无法放进 Markdown 列表。
- `.state.json` 保存本次构建的数据。Rolldown 会将下一次构建与此文件比较，并生成 `delta.md`。

<a id="files"></a>
## 文件

先查看 `entry.md`。它会概述构建情况，并告诉你接下来要打开哪个文件。

| 文件                | 内容                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| `entry.md`          | 构建耗时、输出大小、模块、chunk 和 package 数量，以及与上一次构建相比的变化。         |
| `timing.md`         | 扫描与生成耗时、各 hook 的插件耗时、未执行工作的 hook，以及插件 `transform` hook 中最慢的模块。 |
| `chunks.md`         | 最大的 chunk、每个 chunk 存在的原因，以及出现在多个 chunk 中的模块。                  |
| `modules.md`        | 导入类型、导入次数最多的模块，以及多个入口共享的模块。                               |
| `packages.md`       | 最大的 package、直接和传递依赖，以及存在多个版本的 package。                         |
| `graph.md`          | 入口点、chunk 导入图、各入口的初始加载内容，以及保留大小。                           |
| `delta.md`          | 与上一次构建和固定基线相比的变化。Rolldown 从第二次构建起生成此文件。                |
| `metrics.json`      | 本次构建的数据，包含 `output.total_bytes`、`build.total_ms` 等稳定的指标 id。可在脚本中使用。 |
| `module-graph.json` | 完整模块图：每个模块的大小、导入项和保留大小。                                       |
| `chunk-graph.json`  | 每个输出 chunk 的文件名、大小、入口标记和导入项。                                   |
| `history.jsonl`     | 每次构建对应一行摘要。                                                               |
| `AGENTS.md`         | 提供给读取此文件夹的代码代理的指令。                                                 |
| `.state.json`       | 本次构建的数据。Rolldown 会将下一次构建与此文件比较。                               |

## 如何理解数据

- `build.total_ms` 包含 scan 和 generate 阶段，数值小于 CLI 显示的总耗时。
- 报告中 1 kB 等于 1024 字节，CLI 中 1 kB 等于 1000 字节。因此，同一个 chunk 在 CLI 中可能显示为 `271.50 kB`，在报告中则显示为 `265.1 kB`。
- Rolldown 会在 `generateBundle` hook 运行前、压缩前测量 chunk 和资源大小。这些大小不包含 sourcemap 文件，也不包含 `generateBundle` 或 `writeBundle` hook 添加或编辑的文件。
- 模块和 package 的大小包含 tree shaking 后、`renderChunk` hook 和 chunk 压缩前的渲染代码。如果一个模块出现在多个 chunk 中，其大小会计入每个副本。
- 入口的初始加载内容包括其 chunk，以及它直接或间接静态导入的所有 chunk。
- 直接依赖是指由 `cwd` 下、`node_modules` 外的模块导入的 package。其他 package 都是传递依赖。Rolldown 根据导入图判断依赖关系，而不是读取 `package.json` 中的依赖字段。
- 大多数列表只保留前 20 项。`module-graph.json` 包含所有模块，`chunk-graph.json` 包含所有 chunk。
- 插件耗时包括 `resolveId`、`load`、`transform` 和 `renderChunk`。每项耗时是同时运行的调用耗时之和，因此可能远大于构建耗时。`timing.md` 中的 `Transform hotspots` 表不包含 Rolldown 核心中的 TypeScript 和 JSX 转换。
- 无操作调用是指未执行工作的 hook 调用：`resolveId`、`load` 或 `renderChunk` 未返回结果，或者 `transform` 未返回结果或返回了相同代码。对于 JavaScript 插件，每次无操作调用仍会从 Rust 跨到 JavaScript。[Hook 过滤器](/apis/plugin-api/hook-filters)会跳过这些调用，因此报告中不会包含它们。内置插件（`builtin:*`）在 Rust 中运行，所以其无操作调用开销很小。

### 保留大小

模块的保留大小是该模块自身大小加上仅由它引入的模块大小。它估算将该模块的所有静态导入改为 `import()` 后，可以从静态初始加载中移除的渲染代码字节数。Rolldown 会根据所有用户定义的入口计算该值，但它无法预测压缩后的下载量或加载耗时。

在此示例中，`a.js` 和 `b.js` 都导入 `shared.js`，只有 `a.js` 导入 `heavy.js`：

```dot
digraph {
    bgcolor="transparent";
    rankdir=TB;
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [fontname="Arial", fontsize=10, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];

    main [label="main.js", fillcolor="${#fff0e0|#4a2a0a}"];
    b [label="b.js\n5.0 kB", fillcolor="${#dbeafe|#1e3a5f}"];
    shared [label="shared.js\n50.0 kB", fillcolor="${#dbeafe|#1e3a5f}"];

    subgraph cluster_retained {
        label="Retained by a.js: 210.1 kB";
        labeljust="l";
        labelloc="b";
        fontname="Arial";
        fontsize=11;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#d44803|#ff712a}";

        a [label="a.js\n10.0 kB", fillcolor="${#dcfce7|#14532d}"];
        heavy [label="heavy.js\n200.0 kB", fillcolor="${#dcfce7|#14532d}"];
    }

    main -> a;
    main -> b;
    a -> heavy;
    a -> shared;
    b -> shared;
}
```

`graph.md` 展示了结果：

| 模块            | 自身     | 保留大小     | 模块数  | 经由          |
| --------------- | -------- | ------------ | ------- | ------------- |
| `src/a.js`      | 10.0 kB  | **210.1 kB** | 2       | `src/main.js` |
| `src/heavy.js`  | 200.0 kB | **200.0 kB** | 1       | `src/a.js`    |
| `src/shared.js` | 50.0 kB  | **50.0 kB**  | 1       | `src/main.js` |
| `src/b.js`      | 5.0 kB   | **5.0 kB**   | 1       | `src/main.js` |

`a.js` 的保留大小不包含 `shared.js`，因为 `b.js` 也会导入它。`via` 指所有导入路径到达该模块前都会经过的最后一个模块。

要验证该数据，请将 `main.js` 对 `a.js` 的导入替换为 `import()`。随后，`delta.md` 中的 `Per-entry initial load` 表会显示变化：

| 入口          | 上一次   | 当前    | Δ         | Δ%     |
| ------------- | -------- | ------- | --------- | ------ |
| `src/main.js` | 265.1 kB | 55.2 kB | -210.0 kB | -79.2% |

请查看此表，而不要看 `output.max_initial_load_bytes`。该指标采用最大的入口；此时 `src/a.js` 也成为入口，其初始加载大小为 265.3 kB。要同时计算多个模块移出初始加载后的变化，请使用 [perf-kit 命令](/in-depth/perf-kit#find-code-that-can-load-later)。

<a id="compare-builds"></a>
## 比较构建

Rolldown 会将每次构建与同一输出目录的上一次构建进行比较。要与某次指定的构建比较，请将该构建固定为基线：

```sh
$ cd node_modules/.rolldown/report/dist
$ cp .state.json baseline.json
```

之后，Rolldown 还会在 `delta.md` 和 `metrics.json`（`baselineDelta`）中，将后续每次构建与该基线进行比较。要取消固定基线，请删除 `baseline.json`。

## 在脚本中使用数据

`metrics.json` 中的 `metrics` 是一个扁平映射，包含稳定的指标 id。id 后缀表示单位：`_ms` 表示毫秒，`_bytes` 表示字节，没有后缀则表示数量。报告文件夹中的 `AGENTS.md` 列出了所有 id。

```sh
$ cd node_modules/.rolldown/report/dist

# Read one number
$ jq '.metrics["output.total_bytes"]' metrics.json
1887396

# Fail a CI step when the output is too large (`-e` exits with 1 on false)
$ jq -e '.metrics["output.total_bytes"] < 2000000' metrics.json
true

# Show the JavaScript plugin hooks in the top no-op hooks
$ jq -r '.noopHooks[] | select(.plugin | startswith("builtin:") | not) | "\(.plugin) \(.hook) \(.noopCalls)/\(.calls)"' metrics.json
my-css-plugin transform 10012/10012
```

其他 JSON 数据包含以下字段：

| 数据                                                | 字段                                                                                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `delta.metrics` 和 `baselineDelta.metrics`，每个 id | `prev`、`curr`、`delta`、`pct`                                                                                                                  |
| `modules` in `module-graph.json`                    | `id`, `bytes`, `retainedBytes`, `retainedModuleCount`, `idom`, `staticReachable`, `dynamicOnly`, `imports` (each is `[targetIndex, isDynamic]`) |
| `chunks` in `chunk-graph.json`                      | `fileName`, `name`, `bytes`, `isEntry`, `facadeModuleId`, `imports`, `dynamicImports`                                                           |

## 限制

- [`watch()`](/reference/Function.watch)、`rolldown --watch` 和开发引擎（`experimental.devMode`）不会生成报告。
- 一次构建会生成报告或 devtools 日志（默认的 `mode: 'full'`），不会同时生成两者。
- 报告位于 `node_modules` 中，因此全新安装会将其与固定基线一起删除。
- 一个 bundle 只会生成一份报告：当 bundle 写入多个输出时，第一个输出决定报告目录，报告描述最后一个输出。

## 相关工具

- 默认的 `'full'` 模式会写入完整的 devtools 事件日志。需要查看 `@rolldown/debug` 或 Vite DevTools 中的所有事件时，请使用此模式。
- [`bundleAnalyzerPlugin`](/builtin-plugins/bundle-analyzer) 会在输出目录中生成一份 chunk 和模块分析文件。构建报告还会提供构建与插件耗时、package 数据和构建间的变化。Rolldown 会将报告写在输出目录之外。
- [`@rolldown/perf-kit`](/in-depth/perf-kit) 可测量页面加载、服务器启动和 Cloudflare Worker 启动耗时，帮助代码代理加快应用启动。它会读取 `module-graph.json` 以[查找可延后加载的代码](/in-depth/perf-kit#find-code-that-can-load-later)，并读取 `chunk-graph.json` 以[查找启动较晚的 chunk](/in-depth/perf-kit#configure-the-build)。
