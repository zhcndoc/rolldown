# 导入属性

## 概览

导入属性是导入语句中的 `with { ... }` 子句：

```js
import config from './config.json' with { type: 'json' };
const data = await import('./data.json', { with: { type: 'json' } });
```

Node.js 和浏览器都要求使用 `with { type: 'json' }` 导入 JSON；浏览器还要求在 CSS 模块脚本中使用 `with { type: 'css' }`。为这些运行时编写的代码（包括依赖项）经常会使用这类导入。

启用 `experimental.importAttributes` 后，Rolldown 会将带有不同属性导入的同一文件视为不同模块。插件可以在 `resolveId`、`load` 和 `transform` 中读取属性，并在 `resolveId` 中修改属性。设计背景请参阅 [RFC](https://github.com/rolldown/rolldown/discussions/11217)。

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';

export default defineConfig({
  experimental: {
    importAttributes: true,
  },
});
```

::: warning 实验性
`experimental.importAttributes` 默认关闭。启用后，带属性导入的模块 id 会发生变化。如果项目使用了自定义插件，请先阅读[迁移插件](#migrating-plugins)，并查看[限制](#limitations)。
:::

## 支持的语法

Rolldown 会读取静态导入、重新导出，以及带静态 `with` 对象的动态导入中的属性：

| 语法                                                    | `attributes`       |
| ------------------------------------------------------- | ------------------ |
| `import x from 'a' with { type: 'json' }`               | `{ type: 'json' }` |
| `export * from 'a' with { type: 'json' }`               | `{ type: 'json' }` |
| `import('a', { with: { type: 'json' } })`               | `{ type: 'json' }` |
| `import x from 'a' assert { type: 'json' }`             | `{ type: 'json' }` |
| `import('a', options)` where `options` is not a literal | `{}`               |
| `require()`, `new URL()`, CSS `@import`                 | `{}`               |

Rolldown 会在构建时读取属性，因此 `import()` 选项必须直接写在调用中。如果选项来自变量（例如 `import('./data.json', options)`），Rolldown 就不会提取属性。

出于兼容性考虑，Rolldown 会将已移除的 `assert` 关键字视为 `with`，但未来会移除此语法支持。

## 工作原理

<a id="module-ids"></a>
### 模块 id

启用该选项后，导入属性会成为模块 id 的一部分。插件会为每个模块看到以下三个值：

| 值            | 说明                                                                 |
| ------------- | -------------------------------------------------------------------- |
| `rawId`       | 不含属性的已解析 id，即要读取和监听的文件。                          |
| `attributes`  | `Record<string, string>` 类型的导入属性。`{}` 表示没有属性。         |
| `id`          | 由 `rawId` 和 `attributes` 组成的模块 id；没有属性时与 `rawId` 相同。 |

id 的格式为 `rawId?attributes=<encoded attributes>`。Rolldown 会按键名对属性排序，使用 `JSON.stringify` 序列化，再通过 `encodeURIComponent` 编码结果。如果 `rawId` 已经包含 `?`，则使用 `&` 作为分隔符。

```js
import config from './config.json' with { type: 'json' };
import small from './logo.png' with { size: '100' };
import large from './logo.png' with { size: '400' };
import original from './logo.png';
```

| Import                               | `rawId`            | `attributes`       | `id`                                                        |
| ------------------------------------ | ------------------ | ------------------ | ----------------------------------------------------------- |
| `'./config.json'` `{ type: 'json' }` | `/src/config.json` | `{ type: 'json' }` | `/src/config.json?attributes=%7B%22type%22%3A%22json%22%7D` |
| `'./logo.png'` `{ size: '100' }`     | `/src/logo.png`    | `{ size: '100' }`  | `/src/logo.png?attributes=%7B%22size%22%3A%22100%22%7D`     |
| `'./logo.png'` `{ size: '400' }`     | `/src/logo.png`    | `{ size: '400' }`  | `/src/logo.png?attributes=%7B%22size%22%3A%22400%22%7D`     |
| `'./logo.png'` (no attributes)       | `/src/logo.png`    | `{}`               | `/src/logo.png` (unchanged)                                 |

::: warning 避免使用 `?attributes`
不要在自定义 id 中将查询参数命名为 `attributes`。如果它的值恰好符合此格式，Rolldown 和 `parseModuleId` 就会将其解析为导入属性。
:::

### 外部模块

在 ESM 输出中，[外部模块](/in-depth/external-modules)的导入会保留其属性，包括动态 `import()`。无论是否启用 `experimental.importAttributes`，这一点都成立。未启用该选项时，带属性导入的外部模块仍会在其[模块 id](#module-ids) 中保留这些属性，例如通过 `this.getModuleIds()` 获取时。

启用该选项后，`resolveId` hook 可以修改输出中的属性。如果 [`external`](/reference/InputOptions.external) 选项在解析前就将导入标记为外部模块，则不会运行 `resolveId` hook，导入会保留源代码中写入的属性。

关于 `cjs`、`iife` 和 `umd` 输出，请参阅[非 ESM 输出格式](/in-depth/non-esm-output-formats#import-attributes)。

### 内置的 `type` 属性

启用该选项后，`type` 属性可以指定 Rolldown 的[模块类型](/in-depth/module-types)。常见情况无需插件即可处理：

| 属性             | 模块类型  | 默认导出       |
| ---------------- | --------- | -------------- |
| `type: 'json'`   | `json`    | 解析后的 JSON  |
| `type: 'text'`   | `text`    | `string`       |
| `type: 'bytes'`  | `binary`  | `Uint8Array`   |

```js
import config from './config.json' with { type: 'json' };
import shader from './shader.glsl' with { type: 'text' };
import wasm from './module.wasm' with { type: 'bytes' };
import data from './data.txt' with { type: 'json' };
```

Rolldown 按以下优先级（从高到低）确定模块类型：

1. `load` hook 返回的 `moduleType`。
2. `type` 属性，其值为 `json`、`text` 或 `bytes` 时生效。
3. 文件扩展名，包括 [`moduleTypes`](/reference/InputOptions.moduleTypes) 选项中的映射。

其他 `type` 值（例如 `'css'`）没有内置含义，会原样传递给插件。插件可以在 `load` hook 中处理这些值。

## 插件 API

未启用该选项时，以下字段仍然存在，但 `attributes` 始终为 `{}`，且 `resolveId` 返回的 `attributes` 会被忽略。唯一的例外是对外部模块调用 `this.resolve`，它会返回该导入的属性。

### `resolveId`

```ts
resolveId(
  source: string,
  importer: string | undefined,
  extraOptions: {
    // ...
    // new: attributes of this import
    attributes: Record<string, string>;
    // new: `importer` without its attributes
    importerRawId: string | undefined;
    // new: attributes of the importer
    importerAttributes: Record<string, string>;
  },
): string | false | null | undefined | PartialResolvedId;

interface PartialResolvedId {
  // ...
  // new: replaces the attributes of the import
  attributes?: Record<string, string>;
}
```

由于 `importer` 包含导入方的属性，请使用 `importerRawId` 获取其文件路径。

返回 `attributes` 可以替换该导入的属性，返回 `{}` 则会移除属性。`load` 和 `transform` 无法修改这些属性。

例如，为外部 JSON 导入添加 Node.js 要求的属性：

```js
resolveId(source) {
  if (source.endsWith('.json')) {
    return { id: source, external: true, attributes: { type: 'json' } };
  }
},
// input:  import pkg from '../package.json'
// output: import pkg from '../package.json' with { type: "json" };
```

::: info 注意
`resolveDynamicImport` hook 也会收到相同的新选项，并且同样可以返回 `attributes`。
:::

### `load`

```ts
load(
  id: string,
  // new
  options: {
    // `id` without attributes
    rawId: string;
    // attributes of the module
    attributes: Record<string, string>;
  },
): LoadResult;
```

### `transform`

```ts
transform(
  code: string,
  id: string,
  meta: {
    // ...
    // new: `id` without attributes
    rawId: string;
    // new: attributes of the module
    attributes: Record<string, string>;
  },
): TransformResult;
```

### `this.resolve`

```ts
this.resolve(
  source: string,
  // changed: also accepts `{ rawId, attributes }`
  importer?: string | { rawId: string; attributes?: Record<string, string> },
  options?: {
    // ...
    // new: attributes of the simulated import
    attributes?: Record<string, string>;
  },
): Promise<ResolvedId | null>;

interface ResolvedId {
  // ...
  // without attributes
  id: string;
  // new: final attributes
  attributes: Record<string, string>;
}
```

### `this.load`

```ts
this.load(options: {
  // ...
  // changed: also accepts `{ rawId, attributes }`
  id: string | { rawId: string; attributes?: Record<string, string> };
}): Promise<ModuleInfo>;
```

属性只会从 `id` 获取。要加载带有属性的 `this.resolve` 结果，请将 `{ rawId: resolved.id, attributes: resolved.attributes }` 作为 `id` 传入。

## 辅助函数

只有 `resolveId`、`load`、`transform`、`this.resolve` 和 `this.load` 会提供 `rawId` 和 `attributes`。在其他位置，插件拿到的都是组合 id：

| 位置                                                                                               | 字段                                                 |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `this.getModuleInfo()`, `moduleParsed`                                                            | `id`, `importedIds`, `importers`, `dynamicImporters` |
| `this.getModuleIds()`                                                                             | 返回的每个 id 都包含导入属性                         |
| Output chunks in `renderChunk`, `generateBundle`                                                  | `facadeModuleId`, `moduleIds`, the keys of `modules` |
| `onLog`, `onwarn`                                                                                 | `log.id`                                             |
| 选项回调，例如[代码分割组](/in-depth/manual-code-splitting)的 `test`                               | 模块 id                                              |

可以使用 `rolldown/utils` 中的 `parseModuleId` 和 `stringifyModuleId` 处理这些 id：

```ts
function parseModuleId(id: string): { rawId: string; attributes: Record<string, string> };
function stringifyModuleId(rawId: string, attributes?: Record<string, string>): string;
```

```js
import { parseModuleId, stringifyModuleId } from 'rolldown/utils';

parseModuleId('/src/a.json?attributes=%7B%22type%22%3A%22json%22%7D');
// → { rawId: '/src/a.json', attributes: { type: 'json' } }

stringifyModuleId('/src/a.json', { type: 'json' });
// → '/src/a.json?attributes=%7B%22type%22%3A%22json%22%7D'

// warn about JSON files imported without `type: 'json'`
moduleParsed(info) {
  const { rawId, attributes } = parseModuleId(info.id);
  if (rawId.endsWith('.json') && attributes.type !== 'json') {
    this.warn(`${rawId} is imported without { type: 'json' }`);
  }
},
```

::: info 注意
[`output.paths`](/reference/OutputOptions.paths)、[`output.globals`](/reference/OutputOptions.globals) 和 [`treeshake.moduleSideEffects`](/reference/InputOptions.treeshake) 接收的是 `rawId`，而不是组合 id。
:::

<a id="migrating-plugins"></a>
## 迁移插件

启用该选项后，将模块 id 当作文件路径处理的插件可能会失效。以下内容介绍常见情况及其修复方法。实际项目中，最常见的触发情况是在兼容 Node.js 的代码中导入 JSON，例如 `import pkg from './package.json' with { type: 'json' }`。

### 使用 `rawId` 读取文件

`id` 末尾可能带有属性后缀，因此它不一定是文件路径。请使用 `rawId` 读取文件：

```js
// before: fails with ENOENT for a module with attributes
load(id) {
  return fs.readFile(id, 'utf8');
}

// after
load(id, { rawId }) {
  return fs.readFile(rawId, 'utf8');
}
```

任何将 id 当作路径使用的代码都需要遵循同样的规则。`path.extname(id)` 会返回 `.json?attributes=%7B...%7D`，而 `this.addWatchFile(id)` 会监听一个并不存在的文件。由于属性中的 `/` 会被编码，`path.dirname(id)` 仍然可用。

<a id="match-the-extension"></a>
### 匹配扩展名

检查 `id` 的结尾永远无法匹配带属性的模块。请改为检查 `rawId`：

```js
// before: never matches a module with attributes
transform(code, id) {
  if (!id.endsWith('.json')) return;
}

// after
transform(code, id, { rawId }) {
  if (!rawId.endsWith('.json')) return;
}
```

Hook 过滤器会匹配组合 id，因此将扩展名锚定在 id 末尾的过滤器将不再匹配。请允许出现查询后缀：

```js
import { id, include, makeIdFiltersToMatchWithQuery } from '@rolldown/pluginutils';

// allow a query suffix by hand
filter: { id: /\.json($|\?)/ },

// `@rolldown/pluginutils` turns `/\.json$/` into `/\.json(?:\?.*)?$/`
filter: { id: makeIdFiltersToMatchWithQuery(/\.json$/) },

// composable filters: match the id with its query removed
filter: [include(id(/\.json$/, { cleanUrl: true }))],
```

对于 `json` 和 `text`，也可以改为按 `moduleType` 过滤。模块类型会在 `transform` 运行前确定，因此带有 `type: 'json'` 的导入此时模块类型已经是 `json`：

```js
transform: {
  filter: { moduleType: 'json' },
  handler(code, id, { rawId, attributes }) {
    // ...
  },
}
```

这对 `bytes` 不适用。它的模块类型是 `binary`，而 `transform` 不会针对二进制模块运行。

### 使用 `importerRawId` 比较导入方

如果导入方模块本身也是带属性导入的，`importer` 就是它的组合 id。例如，通过 `with { type: 'css' }` 导入的 CSS 文件中可以包含 `@import`。请使用 `importerRawId` 获取文件路径：

```js
// before: `importer` may be `/src/style.css?attributes=...`
resolveId(source, importer) {
  if (!importer?.endsWith('.css')) return;
  // resolve `@import` and `url()` in CSS
}

// after
resolveId(source, importer, { importerRawId }) {
  if (!importerRawId?.endsWith('.css')) return;
  // ...
}
```

### 使用模块 id 作为状态键

插件通常会从 `resolveId` 返回一个 id，并以它为键存储数据供 `load` 使用。如果导入带有属性，`load` 收到的 id 末尾会附带这些属性。由于带属性和不带属性的模块是不同模块，因此应使用完整模块 id 存储数据：

```js
import { stringifyModuleId } from 'rolldown/utils';

const sources = new Map();

resolveId(source, importer, { attributes }) {
  if (source.startsWith('virtual:')) {
    const id = '\0' + source;
    sources.set(stringifyModuleId(id, attributes), buildSource(source, attributes));
    return id;
  }
},
load(id) {
  return sources.get(id);
},
```

### 转发 `this.resolve` 和 `this.load` 调用

如果 `resolveId` hook 会将参数传递给 `this.resolve`，则无需修改。Rolldown 会自动从 `importer` 中读取属性：

```js
resolveId(source, importer, options) {
  // importer: '/src/style.css?attributes=%7B%22type%22%3A%22css%22%7D'
  return this.resolve(source, importer, { ...options, skipSelf: true });
},
```

`this.resolve` 会在 `attributes` 字段中返回属性。`this.load` 只会从 `id` 中读取属性。因此，要加载带属性的模块，请将 `{ rawId, attributes }` 作为 `id` 传入：

```js
const resolved = await this.resolve('./data.js', importer, { attributes: { type: 'foo' } });
// resolved: { id: '/src/data.js', attributes: { type: 'foo' }, ... }
const info = await this.load({
  ...resolved,
  id: { rawId: resolved.id, attributes: resolved.attributes },
});
// info.id: '/src/data.js?attributes=%7B%22type%22%3A%22foo%22%7D'
```

未启用该选项时，`resolved.attributes` 为 `{}`，`info.id` 为 `/src/data.js`。同一段代码在两种情况下都能正常工作。

### 检查魔法查询参数

Vite 的 `?raw`、`?url` 和 `?inline` 等魔法查询参数会与属性共用查询字符串。同时使用两者的导入会在 id 中保留两者，因此将查询参数锚定在 id 末尾的检查将不再匹配：

```js
// import svg from './icon.svg?raw' with { type: 'text' }
// id: '/src/icon.svg?raw&attributes=%7B%22type%22%3A%22text%22%7D'
id.endsWith('?raw'); // false
/[?&]raw\b/.test(id); // true
```

## 与 Rollup 5 的兼容性

Rolldown 遵循 [Rollup 5](https://github.com/rollup/rollup/pull/6266) 的导入属性设计。本节假设已启用 `experimental.importAttributes`。模块 id 格式相同，因此同一模块在两个打包器中会获得相同的 id。新增 hook 字段、`this.resolve` 和 `this.load` 的行为一致，`INVALID_IMPORT_ATTRIBUTE` 也会在相同情况下报告。

差异：

- Rolldown 为 `type: 'json'`、`type: 'text'` 和 `type: 'bytes'` 提供内置模块类型。Rollup 5 不会为任何属性赋予内置含义。
- Rolldown 始终使用 `with` 渲染外部导入的属性。Rollup 5 可以通过 `output.externalImportAttributes` 丢弃这些属性，或通过已弃用的 `output.importAttributesKey` 使用 `assert`。
- 对外部模块使用 `import()` 时，除非 `resolveId` hook 修改了属性，否则 Rolldown 会保留原样的选项。Rollup 5 则始终根据属性重新生成选项，因此会丢弃值来自变量的条目。
- Rolldown 不支持 `this.resolve()` 中已弃用的 `importerAttributes` 选项。请改为将 `importer` 设为 `{ rawId, attributes }`。

尚不支持：

- `ModuleInfo` 和 `RenderedModule` 中的 `rawId` 与 `attributes`
- chunk 中的 `facadeModuleRawId` 和 `facadeModuleAttributes`
- `external` 函数的第四个参数，以及 `output.globals` 和 `output.paths` 函数中的 `{ attributes }`
- 当 `output.globals` 的对象形式为同一外部模块的多个属性变体指定相同全局名称时发出的 `AMBIGUOUS_GLOBAL_NAME` 警告
- 使用 `{ rawId, attributes }` 对象调用 `this.getModuleInfo()`，以及带属性的 `this.emitFile()` chunk
- `resolveFileUrl` hook 中的 `moduleRawId` 和 `moduleAttributes`

<a id="limitations"></a>
## 限制

- Rolldown 的开发模式目前尚不支持。
- Hook 过滤器目前无法匹配属性。请改为在 hook 中检查 `attributes`。
- Vite 目前尚不支持此选项，其开发服务器和内置插件仍需更新。
