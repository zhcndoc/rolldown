# 非 ESM 输出格式

Rolldown 支持非 ESM 输出格式。ESM 中的一些特性在非 ESM 格式中不受支持，Rolldown 会为这些特性发出消息或提供 polyfill。

## 顶层 Await

顶层 await 在非 ESM 格式中不受支持。当输出格式不是 ESM 时，如果 Rolldown 遇到顶层 await，会输出错误。

## `import.meta`

`import.meta` 在非 ESM 格式中是语法错误。为避免这种情况发生，Rolldown 会用其他值替换 `import.meta`。

### 已知的 `import.meta` 属性

Rolldown 支持以下已知的 `import.meta` 属性：

- `import.meta.url`
- `import.meta.dirname`
- `import.meta.filename`

这些属性在输出格式为 CJS 时会进行 polyfill。在其他格式中，其处理方式与其他属性相同。

:::: tip 在 IIFE 和 UMD 中为 `import.meta.url` 提供 polyfill

Rollup 支持在 IIFE 和 UMD 格式中为 `import.meta.url` 提供 polyfill。但是，Rolldown 不支持此功能。如果你需要为其提供 polyfill，可以使用以下配置：

::: code-group

```ts [rolldown.config.ts (IIFE)]
import { defineConfig } from 'rolldown';

const importMetaUrlPolyfillVariableName = '__import_meta_url__';

export default defineConfig({
  transform: {
    define: {
      'import.meta.url': importMetaUrlPolyfillVariableName,
    },
  },
  output: {
    format: 'iife',
    intro:
      "var _documentCurrentScript = typeof document !== 'undefined' ? document.currentScript : null;" +
      `var ${importMetaUrlPolyfillVariableName} = (_documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === 'SCRIPT' && _documentCurrentScript.src || new URL('main.js', document.baseURI).href)`,
  },
});
```

```ts [rolldown.config.ts (UMD)]
import { defineConfig } from 'rolldown';

const importMetaUrlPolyfillVariableName = '__import_meta_url__';

export default defineConfig({
  transform: {
    define: {
      'import.meta.url': importMetaUrlPolyfillVariableName,
    },
  },
  output: {
    format: 'umd',
    intro:
      "var _documentCurrentScript = typeof document !== 'undefined' ? document.currentScript : null;" +
      `var ${importMetaUrlPolyfillVariableName} = (typeof document === 'undefined' && typeof location === 'undefined' ? require('u' + 'rl').pathToFileURL(__filename).href : typeof document === 'undefined' ? location.href : (_documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === 'SCRIPT' && _documentCurrentScript.src || new URL('main.js', document.baseURI).href))`,
  },
});
```

:::

::::

### 其他属性以及 `import.meta` 对象本身

其他属性以及 `import.meta` 对象本身会被替换为 `{}`。由于这不会保留原始值，Rolldown 在这种情况下会发出警告。

<a id="import-attributes"></a>
## 导入属性

对[外部模块](/in-depth/external-modules)的导入可以带有[导入属性](/in-depth/import-attributes)，例如 `with { type: 'json' }`。在非 ESM 格式中：

- 静态导入会变成 `require()` 或全局变量，两者都无法携带属性，因此 Rolldown 会直接丢弃这些属性，不发出警告。
- 带选项的动态 `import()` 会保留为 `import()`，并保留其选项。即使设置了 [`dynamicImportInCjs: false`](/reference/OutputOptions.dynamicImportInCjs)，Rolldown 也不会将其转换为 `require()`，因为 `require()` 无法携带属性。
