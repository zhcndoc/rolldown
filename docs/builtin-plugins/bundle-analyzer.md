# Bundle Analyzer 插件

`bundleAnalyzerPlugin` 是一个内置的 Rolldown 插件，它会生成一份详细报告，描述你的 bundle 的 chunks、modules、dependencies 和可达性信息。该报告可供可视化工具、自定义脚本或基于 LLM 的编码代理使用。

:::tip EXPERIMENTAL
此插件目前处于实验阶段，并且从 `rolldown/experimental` 中导出。它的 API 未来版本可能会发生变化。
:::

## 使用

从 Rolldown 的实验性导出中导入并使用该插件：

```js
import { defineConfig } from 'rolldown';
import { bundleAnalyzerPlugin } from 'rolldown/experimental';

export default defineConfig({
  input: 'src/main.js',
  output: {
    dir: 'dist',
    format: 'esm',
  },
  plugins: [bundleAnalyzerPlugin()],
});
```

运行构建后，该插件会在你的打包输出旁边生成一个分析文件（默认情况下为 `dist/analyze-data.json`）。

## 选项

### `fileName`

- **类型：** `string`
- **默认值：** 当 `format` 为 `'json'` 时为 `'analyze-data.json'`，当 `format` 为 `'md'` 时为 `'analyze-data.md'`

用于输出分析资源的文件名。该文件会被输出到与其余 bundle 相同的输出目录中。

```js
bundleAnalyzerPlugin({
  fileName: 'bundle-analysis.json',
});
```

### `format`

- **类型：** `'json' | 'md'`
- **默认值：** `'json'`

选择输出格式。

- `'json'` 生成适合程序化分析或第三方可视化工具使用的结构化数据文件。
- `'md'` 生成面向 LLM 使用的 markdown 报告（见下方 [Markdown 格式](#markdown-format)）。

```js
bundleAnalyzerPlugin({
  format: 'md',
});
```

## JSON 格式

当 `format` 为 `'json'`（默认值）时，输出文件会包含一个如下结构的对象。`timestamp` 字段表示自 Unix 纪元以来的毫秒数。

```jsonc
{
  "meta": {
    "bundler": "rolldown",
    "version": "1.0.0",
    "timestamp": 1705314645123,
  },
  "chunks": [
    {
      "id": "chunk-main",
      "name": "main-abc123.js",
      "size": 45230,
      "type": "static-entry", // 或 "dynamic-entry" 或 "common"
      "moduleIndices": [0, 1, 2],
      "entryModule": 0,
      "imports": [
        {
          "targetChunkIndex": 1,
          "type": "static", // 或 "dynamic"
        },
      ],
      "reachableModuleIndices": [0, 1, 2, 3, 4],
    },
  ],
  "modules": [
    {
      "id": "mod-0",
      "path": "src/main.js",
      "size": 3450,
      "importers": [1, 2],
    },
  ],
}
```

JSON 输出可以上传到社区可视化工具，例如 [chunk-visualize](https://iwanabethatguy.github.io/chunk-visualize/)，也可以通过自定义脚本进行处理，以便随时间跟踪 bundle 指标。

## Markdown 格式

当设置了 `format: 'md'` 时，插件会输出结构化的 markdown 报告，而不是 JSON。该报告专为基于 LLM 的编码代理设计，因此你可以直接将其通过管道传入提示词中，用于审查和重构建议。

报告组织为以下几个部分：

| 部分                         | 描述                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **快速摘要**                 | 总输出大小、输入模块数量、入口点数量，以及代码拆分（common）chunks 的数量。                                       |
| **按输出贡献排序的最大模块** | 按大小排序的所有模块，以及每个模块占总输出的百分比。                                                              |
| **入口点分析**               | 对每个入口：其输出文件名、bundle 大小、加载的 chunks，以及打包进去的模块。                                        |
| **依赖链**                   | 被多个文件导入的模块，有助于理解为什么某个模块最终会进入 bundle。                                                 |
| **优化建议**                 | 带有严重级别的可执行建议（见下文）。                                                                              |
| **完整模块图**               | 完整的逐模块依赖信息（imports、imported-by、size）。                                                              |
| **用于搜索的原始数据**       | 适合 grep 的行，使用 `[MODULE:]`、`[OUTPUT_BYTES:]`、`[IMPORT:]`、`[IMPORTED_BY:]`、`[ENTRY:]`、`[CHUNK:]` 标签。 |

### 优化建议

建议部分会识别出那些位于**共享 common chunks**中、但只从**单个静态入口**可达的模块。这些模块被不必要地共享了，可以通过在你的 [`output.codeSplitting`](../reference/OutputOptions.codeSplitting.md) 分组上启用 [`entriesAware: true`](../reference/TypeAlias.CodeSplittingGroup.md#entriesaware)，将它们更靠近入口点；这也是报告自身优化提示所推荐的修复方式。

每条建议都会根据 common chunk 中单入口可达模块大小所占比例标记一个严重级别：

- `[HIGH]`：大于 50%
- `[MEDIUM]`：介于 30% 和 50% 之间
- `[LOW]`：小于 30%

### 将报告通过管道传入 LLM

由于该报告是纯 markdown，你可以直接把它提供给 AI 助手进行审查：

```bash
# 在运行构建之后
cat dist/analyze-data.md | your-cli-coding-agent "review this bundle and suggest improvements"
```

## 示例

在 Rolldown 仓库的 [`examples/bundle-analyzer-demo`](https://github.com/rolldown/rolldown/tree/main/examples/bundle-analyzer-demo) 目录中可以找到一个可运行示例。它演示了一个多入口项目，在使用 `format: 'md'` 分析时会产生有趣的优化建议。
