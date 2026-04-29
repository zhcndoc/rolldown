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
