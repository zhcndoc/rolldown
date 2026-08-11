# 源代码转换

如果插件转换了源代码，它应该自动生成 sourcemap，除非有特定的 `sourceMap: false` 选项。Rolldown 只关心 `mappings` 属性（其他部分都会自动处理）。[magic-string](https://github.com/Rich-Harris/magic-string) 为诸如添加或删除代码片段之类的基础转换提供了一种简单的方法来生成这样的映射。

如果生成 sourcemap 没有意义，请返回一个空的 sourcemap：

```js
return {
  code: transformedCode,
  map: { mappings: '' },
};
```

如果转换没有移动代码，你可以通过返回 `null` 来保留现有的 sourcemap：

```js
return {
  code: transformedCode,
  map: null,
};
```

## 转换代码块

要转换代码块，可以使用 [`renderChunk`](/reference/Interface.Plugin#renderchunk)。如果返回所应用转换的源映射，Rolldown 会将该映射与之前的转换组合起来，并根据以下选项重新构建 `x_google_ignoreList` 字段：

```js
import MagicString from 'magic-string';

export default function myPlugin() {
  return {
    name: 'example',
    renderChunk(code) {
      const s = new MagicString(code);
      s.prepend('/* banner */\n');
      return { code: s.toString(), map: s.generateMap({ hires: 'boundary' }) };
    },
  };
}
```

我们不建议在 [`generateBundle`](/reference/Interface.Plugin#generatebundle) 中进行转换。它在哈希处理之后运行，因此输出文件名会保留未转换代码的哈希值。它也在构建 `.map` 资源之后运行，因此编辑 `chunk.map` 不会更改该文件。话虽如此，如果必须在那里进行转换，请组合源映射并自行写入资源：

```js
import remapping from '@jridgewell/remapping';
import MagicString from 'magic-string';

export default function myPlugin() {
  return {
    name: 'example',
    generateBundle(options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;

        const s = new MagicString(chunk.code);
        // ...你的转换...
        if (!s.hasChanged()) continue;

        // 低分辨率映射可能会组合为空，因此请保留边界处的映射。
        const step = s.generateMap({ source: chunk.fileName, hires: 'boundary' });
        chunk.code = s.toString();

        if (chunk.map) {
          // 组合源映射
          chunk.map = remapping([step, chunk.map], () => null);

          // 输出文件来自此资源，而不是来自 `chunk.map`。
          const asset = bundle[`${chunk.fileName}.map`];
          if (asset) asset.source = chunk.map.toString();
        }
      }
    },
  };
}
```
