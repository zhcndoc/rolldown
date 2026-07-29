#### 深入说明（`type: 'chunk'`）

如果 `type` 是 `'chunk'`，这将以给定的模块 `id` 作为入口点发出一个新的 chunk。这不会导致图中出现重复模块；相反，必要时，现有 chunk 会被拆分，或者会创建一个带有 reexports 的 facade chunk。指定了 [`fileName`](/reference/Interface.EmittedChunk#filename) 的 chunk 将始终生成独立的 chunk，而其他已发出的 chunk 即使名称不匹配，也可能与现有 chunk 去重。如果这样的 chunk 没有被去重，则会使用 [`output.chunkFileNames`](/reference/OutputOptions.chunkFileNames) 模式。

你可以通过 `import.meta.ROLLDOWN_FILE_URL_referenceId`（返回一个字符串）在 [`load`](/reference/Interface.Plugin#load) 或 [`transform`](/reference/Interface.Plugin#transform) 插件钩子返回的任何代码中引用已发出文件的 URL。更多细节和示例请参见 [文件 URL](/apis/plugin-api/file-urls)。

你可以使用 [`this.getFileName(referenceId)`](/reference/Interface.PluginContext#getfilename) 在文件名可用后立即确定它。若文件名未显式设置，则：

- 资源文件名可从 [`renderStart`](/reference/Interface.Plugin#renderstart) 钩子开始获取。对于更晚发出的资源，文件名会在发出资源后立即可用。
- 不包含 hash 的 chunk 文件名，在 [`renderStart`](/reference/Interface.Plugin#renderstart) 钩子之后 chunk 被创建时即可获取。
- 如果某个 chunk 文件名会包含 hash，那么在 [`generateBundle`](/reference/Interface.Plugin#generatebundle) 之前的任何钩子中使用 [`getFileName`](/reference/Interface.PluginContext#getfilename) 都会返回一个包含占位符而不是实际名称的文件名。如果你在 [`renderChunk`](/reference/Interface.Plugin#renderchunk) 中转换的 chunk 里使用了这个文件名或其部分内容，Rolldown 会在 [`generateBundle`](/reference/Interface.Plugin#generatebundle) 之前将占位符替换为实际 hash，确保该 hash 反映最终生成的 chunk 的实际内容，包括所有引用的文件 hash。

#### 深入说明（`type: 'prebuilt-chunk'`）

如果 `type` 是 `'prebuilt-chunk'`，这将发出一个内容固定、由 [`code`](/reference/Interface.EmittedPrebuiltChunk#code) 属性提供的 chunk。

要在 imports 中引用预构建 chunk，我们需要在 [`resolveId`](/reference/Interface.Plugin#resolveid) 钩子中将“模块”标记为 external，因为预构建 chunk 不属于模块图。相反，它们的行为更像带有 chunk 元数据的资产：

```js
function emitPrebuiltChunkPlugin() {
  return {
    name: 'emit-prebuilt-chunk',
    resolveId: {
      filter: { id: /^\.\/my-prebuilt-chunk\.js$/ },
      handler(source) {
        return {
          id: source,
          external: true,
        };
      },
    },
    buildStart() {
      this.emitFile({
        type: 'prebuilt-chunk',
        fileName: 'my-prebuilt-chunk.js',
        code: 'export const foo = "foo"',
        exports: ['foo'],
      });
    },
  };
}
```

然后你就可以通过 `import { foo } from './my-prebuilt-chunk.js';` 在代码中引用这个预构建 chunk。

#### 深入说明（`type: 'asset'`）

如果 `type` 是 `'asset'`，这将发出一个任意的新文件，其内容为给定的 source。指定了 [`fileName`](/reference/Interface.EmittedAsset#filename) 的资源将始终生成独立文件，而其他已发出的资源即使名称不匹配，如果它们具有相同的 source，也可能与现有资源去重。如果一个没有 [`fileName`](/reference/Interface.EmittedAsset#filename) 的资源没有被去重，则会使用 [`output.assetFileNames`](/reference/OutputOptions.assetFileNames) 模式。
