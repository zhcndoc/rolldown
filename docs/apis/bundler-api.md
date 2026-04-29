# Bundler API

Rolldown 提供三个主要的 API 函数，用于以编程方式打包你的代码。

## `rolldown()`

`rolldown()` 是与 Rollup 的 `rollup` 函数兼容的 API。

```js
import { rolldown } from 'rolldown';

let bundle,
  failed = false;
try {
  bundle = await rolldown({
    input: 'src/main.js',
  });
  await bundle.write({
    format: 'esm',
  });
} catch (e) {
  console.error(e);
  failed = true;
}
if (bundle) {
  await bundle.close();
}
process.exitCode = failed ? 1 : 0;
```

更多详情请参见 [其参考文档](/reference/Function.rolldown)。

## `watch()`

`watch()` 是与 Rollup 的 `watch` 函数兼容的 API。

```js
import { watch } from 'rolldown';

const watcher = watch({
  /* ... */
});
watcher.on('event', (event) => {
  if (event.code === 'BUNDLE_END') {
    console.log(event.duration);
    event.result.close();
  }
});

// 停止监听
watcher.close();
```

更多详情请参见 [其参考文档](/reference/Function.watch)。

## `build()`

::: warning Experimental

此 API 处于实验阶段，可能会在补丁版本中发生变更。

:::

`build()` 对于大多数使用场景来说是最简单的选择。该 API 与 esbuild 的 `build` 函数类似。它会在一次调用中完成打包和写入，并自动清理。

```js
import { build } from 'rolldown';

const result = await build({
  input: 'src/main.js',
  output: {
    file: 'bundle.js',
  },
});
console.log(result);
```

更多详情请参见 [其参考文档](/reference/Function.build)。
