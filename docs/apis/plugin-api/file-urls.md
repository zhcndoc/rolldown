# 文件 URL

要在 JS 代码中引用文件 URL，请使用 `import.meta.ROLLDOWN_FILE_URL_referenceId` 替换项。这将生成一段代码，该代码会相对于 `import.meta.url` 解析已发出的文件，并假定全局可用 `URL` 对象。这在 `esm` 格式下可直接使用；在 `node` 平台上的 `cjs` 格式下也适用，此时 `import.meta.url` 已被 [polyfill](/in-depth/non-esm-output-formats#well-known-import-meta-properties)。对于 `iife` 和 `umd` 格式，需要对 `import.meta.url` 进行 polyfill，或者实现 [`resolveFileUrl`](/reference/Interface.Plugin#resolvefileurl) 钩子，以返回不依赖 `import.meta.url` 的代码。相同的钩子也可用于自定义其他格式的 URL 解析方式。

> [!TIP]
> 为了兼容 Rollup，Rolldown 也接受 `import.meta.ROLLUP_FILE_URL_referenceId` 作为 `import.meta.ROLLDOWN_FILE_URL_referenceId` 的别名。

下面的示例将检测 `.svg` 文件的导入，将导入的文件作为资源发出，并返回它们的 URL，以便例如用作 `img` 标签的 `src` 属性：

::: code-group

```js [rolldown-plugin-svg-asset.js]
import path from 'node:path';
import fs from 'node:fs';

function svgResolverPlugin() {
  return {
    name: 'svg-resolver',
    resolveId: {
      filter: { id: /\.svg$/ },
      handler(source, importer) {
        return path.resolve(path.dirname(importer), source);
      },
    },
    load: {
      filter: { id: /\.svg$/ },
      handler(id) {
        const referenceId = this.emitFile({
          type: 'asset',
          name: path.basename(id),
          source: fs.readFileSync(id),
        });
        return `export default import.meta.ROLLDOWN_FILE_URL_${referenceId};`;
      },
    },
  };
}
```

```js [main.js (usage)]
import logo from '../images/logo.svg';
const image = document.createElement('img');
image.src = logo;
document.body.appendChild(image);
```

:::

与资源类似，发出的 chunk 也可以通过 `import.meta.ROLLDOWN_FILE_URL_referenceId` 在 JS 代码中引用。

下面的示例将检测以前缀 `register-paint-worklet:` 的导入，并生成所需的代码和单独的 chunk，以生成一个 CSS paint worklet。请注意，这仅适用于现代浏览器，并且只有在输出格式设置为 `es` 时才有效。

::: code-group

```js [rolldown-plugin-paint-worklet.js]
import { prefixRegex } from '@rolldown/pluginutils';
const REGISTER_WORKLET = 'register-paint-worklet:';

function registerPaintWorkletPlugin() {
  return {
    name: 'register-paint-worklet',
    load: {
      filter: { id: prefixRegex(REGISTER_WORKLET) },
      handler(id) {
        return `CSS.paintWorklet.addModule(
          import.meta.ROLLDOWN_FILE_URL_${this.emitFile({
            type: 'chunk',
            id: id.slice(REGISTER_WORKLET.length),
          })}
        );`;
      },
    },
    resolveId: {
      filter: { id: prefixRegex(REGISTER_WORKLET) },
      handler(source, importer) {
        // 我们移除前缀，将所有内容解析为绝对 id，然后
        // 再加回前缀。这确保你可以使用
        // 相对导入来定义 worklet
        return this.resolve(source.slice(REGISTER_WORKLET.length), importer).then(
          (resolvedId) => REGISTER_WORKLET + resolvedId.id,
        );
      },
    },
  };
}
```

```js [main.js (usage)]
import 'register-paint-worklet:./worklet.js';
import { color, size } from './config.js';
document.body.innerHTML += `<h1 style="background-image: paint(vertical-lines);">color: ${color}, size: ${size}</h1>`;
```

```js [worklet.js (usage)]
import { color, size } from './config.js';
registerPaint(
  'vertical-lines',
  class {
    paint(ctx, geom) {
      for (let x = 0; x < geom.width / size; x++) {
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.rect(x * size, 0, 2, geom.height);
        ctx.fill();
      }
    }
  },
);
```

```js [config.js (usage)]
export const color = 'greenyellow';
export const size = 6;
```

:::

如果你构建这段代码，主 chunk 和 worklet 都会通过一个共享 chunk 共享来自 `config.js` 的代码。这使我们能够利用浏览器缓存来减少传输数据并加快 worklet 的加载。

## 传递一个 `urlId`

::: warning Experimental

`urlId` API 是实验性的，可能会在次要版本中发生变更。

:::

Rolldown 扩展了语法，增加了一个可选的 `urlId`（`import.meta.ROLLDOWN_FILE_URL_referenceId_urlId`）。`urlId` 是一个任意标识符，它会作为 `args.urlId` 传递给 [`resolveFileUrl`](/reference/Interface.Plugin#resolvefileurl) 钩子，因此单个插件可以根据引用来源的不同，以不同方式解析同一个已发出的文件：

```js [rolldown-plugin-svg-resolver.js]
import path from 'node:path';
import fs from 'node:fs';

function svgResolverPlugin() {
  return {
    name: 'svg-resolver',
    load: {
      filter: { id: /\.svg$/ },
      handler(id) {
        const referenceId = this.emitFile({
          type: 'asset',
          name: path.basename(id),
          source: fs.readFileSync(id),
        });
        // 追加一个 `urlId`，这样 `resolveFileUrl` 就可以对这个引用进行特殊处理。
        return `export default import.meta.ROLLDOWN_FILE_URL_${referenceId}_inline;`;
      },
    },
    resolveFileUrl({ referenceId, relativePath, urlId }) {
      if (urlId === 'inline') {
        // 对内联引用采用不同的解析方式
      }
      // ...
    },
  };
}
```

`urlId` 仅在 rolldown 特有的 `ROLLDOWN_FILE_URL_` 前缀上被识别。与 Rollup 兼容的 `ROLLUP_FILE_URL_` 别名永远不会携带它。默认解析（即没有插件处理该引用时）会忽略 `urlId`。

`urlId` 只能包含 ASCII 标识符字符：字母（`a`-`z`、`A`-`Z`）、数字（`0`-`9`）、`_` 和 `$`。
