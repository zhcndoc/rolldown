# 快速上手

:::tip 你在寻找特定的使用场景吗？
对于大多数应用，推荐通过 [Vite 使用 Rolldown](https://vite.dev/guide/rolldown.html#how-to-try-rolldown)，因为它提供了完整的开发体验，包括开发服务器、HMR 和经过优化的生产构建。

对于库打包，请查看 [tsdown](https://tsdown.dev/)。
:::

## 安装

::: code-group

```sh [vp]
$ vp add -D rolldown
```

```sh [npm]
$ npm install -D rolldown
```

```sh [pnpm]
$ pnpm add -D rolldown
```

```sh [yarn]
$ yarn add -D rolldown
```

```sh [bun]
$ bun add -D rolldown
```

:::

::: details 使用较小的平台（CPU 架构、操作系统）？

预构建二进制文件针对以下平台提供（按 [Node.js v24 平台支持等级](https://github.com/nodejs/node/blob/v24.x/BUILDING.md#platform-list) 分组）：

- 一级
  - Linux x64 glibc (`x86_64-unknown-linux-gnu`)
  - Linux arm64 glibc (`aarch64-unknown-linux-gnu`)
  - Windows x64 (`x86_64-pc-windows-msvc`)
  - Apple x64 (`x86_64-apple-darwin`)
  - Apple arm64 (`aarch64-apple-darwin`)
- 二级
  - Windows arm64 (`aarch64-pc-windows-msvc`)
  - Linux s390x glibc (`s390x-unknown-linux-gnu`)
  - Linux ppc64le glibc (`powerpc64le-unknown-linux-gnu`)
- 实验性
  - Linux x64 musl (`x86_64-unknown-linux-musl`)
  - Linux armv7 (`armv7-unknown-linux-gnueabihf`)
  - FreeBSD x64 (`x86_64-unknown-freebsd`)
  - OpenHarmony arm64 (`aarch64-unknown-linux-ohos`)
- 其他
  - Linux arm64 musl (`aarch64-unknown-linux-musl`)
  - Android arm64 (`aarch64-linux-android`)
  - Wasm + Wasi (`wasm32-wasip1-threads`)

如果你正在使用一个没有提供预构建二进制文件的平台，你有以下选项：

- 使用 Wasm 构建
  1. 下载 Wasm 构建。
     - 对于 npm，你可以运行 `npm install --cpu wasm32 --os wasip1-threads`。
     - 对于 yarn 或 pnpm，你需要将以下内容添加到你的 `.yarnrc.yaml` 或 `pnpm-workspace.yaml` 中：
       ```yaml
       supportedArchitectures:
         os:
           - wasip1-threads
         cpu:
           - wasm32
       ```
  2. 让 Rolldown 加载 Wasm 构建。
     - 如果预构建二进制文件不可用，Rolldown 将自动回退到 Wasm 二进制文件。
     - 如果你需要强制 Rolldown 使用 Wasm 构建，可以设置环境变量 `NAPI_RS_FORCE_WASI=error`。
- 从源码构建
  1. 克隆仓库。
  2. 按照 [安装说明](/development-guide/setup-the-project) 配置项目。
  3. 按照 [构建说明](/development-guide/building-and-running) 构建项目。
  4. 将 `NAPI_RS_NATIVE_LIBRARY_PATH` 环境变量设置为克隆仓库中 `packages/rolldown` 的路径。

:::

### 发布渠道

- [latest](https://npmx.dev/package/rolldown#versions)：当前为 `1.x.x`。
- [pkg.pr.new](https://pkg.pr.new/~/rolldown/rolldown)：持续从 `main` 分支发布。使用 `npm i https://pkg.pr.new/rolldown@sha` 安装，其中 `sha` 是 [pkg.pr.new](https://pkg.pr.new/~/rolldown/rolldown) 上列出的一个成功构建。

## 使用 CLI

要验证 Rolldown 是否已正确安装，请在安装它的目录中运行以下命令：

```sh
$ ./node_modules/.bin/rolldown --version
```

你也可以使用以下命令查看 CLI 选项和示例：

```sh
$ ./node_modules/.bin/rolldown --help
```

### 你的第一个打包文件

让我们创建两个源 JavaScript 文件：

```js [src/main.js]
import { hello } from './hello.js';

hello();
```

```js [src/hello.js]
export function hello() {
  console.log('Hello Rolldown!');
}
```

然后在命令行中运行以下命令：

```sh
$ ./node_modules/.bin/rolldown src/main.js --file bundle.js
```

你应该会看到内容被写入当前目录中的 `bundle.js`。让我们运行它来验证是否正常工作：

```sh
$ node bundle.js
```

你应该会看到 `Hello Rolldown!` 被打印出来。

### 添加 package.json 构建脚本

为了避免输入很长的命令，我们可以把它放到 `package.json` 的脚本中：

```json{5} [package.json]
{
  "name": "my-rolldown-project",
  "type": "module",
  "scripts": {
    "build": "rolldown src/main.js --file bundle.js"
  },
  "devDependencies": {
    "rolldown": "^1.0.0"
  }
}
```

现在我们只需运行以下命令即可构建：

::: code-group

```sh [vp]
$ vp run build
```

```sh [npm]
$ npm run build
```

```sh [pnpm]
$ pnpm run build
```

```sh [yarn]
$ yarn build
```

```sh [bun]
$ bun run build
```

:::

## 使用配置文件

当需要更多选项时，建议使用配置文件以获得更高的灵活性。配置文件可以使用 `.js`、`.cjs`、`.mjs`、`.ts`、`.mts` 或 `.cts` 格式编写。让我们创建以下配置文件：

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';

export default defineConfig({
  input: 'src/main.js',
  output: {
    file: 'bundle.js',
  },
});
```

Rolldown 支持大多数 [Rollup 配置选项](https://rollupjs.org/configuration-options)，并提供一些 [值得注意的附加功能](./notable-features)。完整选项列表请参见 [参考文档](/reference/)。

虽然直接导出普通对象也能工作，但建议使用 [`defineConfig`](/reference/Function.defineConfig) 辅助方法，以获得选项智能提示和自动补全。这个辅助方法纯粹用于类型，原样返回这些选项。

接下来，在 npm 脚本中，我们可以通过 `--config` CLI 选项（简称 `-c`）告诉 Rolldown 使用配置文件：

```json{5} [package.json]
{
  "name": "my-rolldown-project",
  "type": "module",
  "scripts": {
    "build": "rolldown -c"
  },
  "devDependencies": {
    "rolldown": "^1.0.0"
  }
}
```

### 在同一个配置中进行多个构建

你也可以将多个配置指定为数组，Rolldown 会并行打包它们。

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';

export default defineConfig([
  {
    input: 'src/main.js',
    output: {
      format: 'esm',
    },
  },
  {
    input: 'src/worker.js',
    output: {
      format: 'iife',
      dir: 'dist/worker',
    },
  },
]);
```

## 使用插件

Rolldown 的插件 API 与 Rollup 的完全一致，因此在使用 Rolldown 时，你可以复用大多数现有的 Rollup 插件。话虽如此，Rolldown 提供了许多 [内置功能](./notable-features)，使得使用插件变得没有必要。

此外，Rolldown 还提供了一些可用于特定用例的内置插件。有关更多信息，请参见 [内置插件](/builtin-plugins/)。

发布到 npm 的社区插件列在 [Vite 插件注册表](https://registry.vite.dev/plugins) 中。

## 使用 API

Rolldown 提供了一个与 [Rollup 的](https://rollupjs.org/javascript-api/)兼容的 JavaScript API，它将 `input` 和 `output` 选项分开：

```js
import { rolldown } from 'rolldown';

const bundle = await rolldown({
  // 输入选项
  input: 'src/main.js',
});

// 使用不同的输出选项在内存中生成 bundle
await bundle.generate({
  // 输出选项
  format: 'esm',
});
await bundle.generate({
  // 输出选项
  format: 'cjs',
});

// 或者直接写入磁盘
await bundle.write({
  file: 'bundle.js',
});
```

或者，你也可以使用更简洁的 `build` API，它接受的选项与配置文件导出完全相同：

```js
import { build } from 'rolldown';

// build 默认写入磁盘
await build({
  input: 'src/main.js',
  output: {
    file: 'bundle.js',
  },
});
```

## 使用监听器

rolldown watcher api 与 rollup 的 [watch](https://rollupjs.org/javascript-api/#rollup-watch) 兼容。

```js
import { watch } from 'rolldown';

const watcher = watch({
  /* 选项 */
}); // 或 watch([/* 多个选项 */])

watcher.on('event', () => {});

await watcher.close(); // 这与 rollup 不同：rolldown 在这里返回一个 Promise。
```
