允许自定义 Rolldown 如何解析通过 [`this.emitFile`](/reference/Interface.PluginContext#emitfile) 由插件发出的文件的 URL。默认情况下，Rolldown 会为 `import.meta.ROLLDOWN_FILE_URL_referenceId` 生成代码，该代码会将发出的文件相对于 `import.meta.url` 进行解析。这会为 `esm` 格式生成正确的绝对 URL，并且在 `node` 平台上的 `cjs` 格式中也适用，因为此时 `import.meta.url` 已被 [polyfill](/in-depth/non-esm-output-formats#well-known-import-meta-properties)。对于 `iife` 和 `umd` 格式，`import.meta.url` 不可用，生成的代码将无法工作——在这种情况下 Rolldown 会发出警告。为了支持这些格式，需要实现此钩子，返回不依赖 `import.meta.url` 的代码。更多细节和示例请参见 [文件 URL](/apis/plugin-api/file-urls)。

此钩子可用于自定义 `import.meta.ROLLDOWN_FILE_URL_referenceId` 的行为。

返回的字符串必须是单个 JavaScript 表达式。此外，返回的表达式必须是无副作用的。如果代码中未使用该 URL，Rolldown 将会移除它。

Rolldown 还接受 `import.meta.ROLLDOWN_FILE_URL_referenceId_urlId`，其中 `urlId` 是你自定义的任意标识符。它会作为 `args.urlId` 传递给此钩子，从而允许单个插件根据引用以不同方式解析同一个已发出的文件。`urlId` API 仍处于实验阶段，并可能在次要版本中发生变化。`ROLLUP_FILE_URL_` 这个与 Rollup 兼容的别名不支持 `urlId`。在 `urlId` 中仅使用 ASCII 标识符字符：字母、数字、`_` 和 `$`。

::: tip 返回字符串中的 `import.meta.url`

如果返回的字符串包含 `import.meta.url`，对于非 ESM 格式，它会像 [在代码中直接使用 `import.meta.url` 时](/in-depth/non-esm-output-formats#well-known-import-meta-properties) 那样被重写。与 Rolldown 不同，Rollup 会原样输出 `import.meta.url`。

:::

#### 示例

下面这个插件将始终把所有文件解析为相对于当前文档：

```js
function resolveToDocumentPlugin() {
  return {
    name: 'resolve-to-document',
    resolveFileUrl({ fileName }) {
      return `new URL(${JSON.stringify(fileName)}, document.baseURI).href`;
    },
  };
}
```
