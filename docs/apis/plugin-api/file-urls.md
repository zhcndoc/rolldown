# 文件 URL

要从 JS 代码中引用文件 URL，请使用 `import.meta.ROLLUP_FILE_URL_referenceId` 替换。这将生成依赖于输出格式的代码，并生成一个指向目标环境中已发出文件的 URL。请注意，该转换假设 `URL` 可用，并且 `import.meta.url` 已被 polyfill，除了 CJS 和 ESM 输出格式之外。

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
        return `export default import.meta.ROLLUP_FILE_URL_${referenceId};`;
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

与资源类似，发出的 chunk 也可以在 JS 代码中通过 `import.meta.ROLLUP_FILE_URL_referenceId` 引用。

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
          import.meta.ROLLUP_FILE_URL_${this.emitFile({
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

如果你构建这段代码，主 chunk 和 worklet 都会通过一个共享 chunk 共享来自 `config.js` 的代码。这使我们能够利用浏览器缓存来减少传输的数据量，并加快 worklet 的加载速度。
