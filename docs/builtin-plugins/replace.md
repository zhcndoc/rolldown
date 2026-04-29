# 替换插件

`replacePlugin` 是 Rolldown 内置的插件，它通过字符串替换来修改代码。这相当于 `@rollup/plugin-replace`。

## 用法

从 Rolldown 的插件导出中导入并使用该插件：

```js
import { defineConfig } from 'rolldown';
import { replacePlugin } from 'rolldown/plugins';

export default defineConfig({
  input: 'src/index.js',
  output: {
    dir: 'dist',
    format: 'esm',
  },
  plugins: [
    replacePlugin(
      {
        'process.env.NODE_ENV': JSON.stringify('production'),
        __buildVersion: 15,
      },
      {
        preventAssignment: false,
      },
    ),
  ],
});
```

## 选项

### `delimiters`

- **类型:** `[string, string]`
- **默认值:** `["\\b", "\\b(?!\\.)"]`

自定义字符串的匹配方式。默认值会确保单词边界，并防止替换属性访问（例如，不会在 `process.env` 中替换 `process`）。

### `preventAssignment`

- **类型:** `boolean`
- **默认值:** `false`

防止在变量声明中替换字符串。

```js
replacePlugin({ DEBUG: 'false' }, { preventAssignment: true });

// const DEBUG = true;  // 不会被替换（赋值）
// console.log(DEBUG);  // 替换为 `false`
```

### `objectGuards`

- **类型:** `boolean`
- **默认值:** `false`

自动替换对象路径的 `typeof` 检查。

```js
replacePlugin({ 'process.env.NODE_ENV': JSON.stringify('production') }, { objectGuards: true });

// 还会替换：
// typeof process → "object"
// typeof process.env → "object"
```

### `sourcemap`

- **类型:** `boolean`
- **默认值:** `false`

为替换生成 source map。

## 重要说明

### 替换顺序

键会按长度降序排序，以防止部分替换。当你有重叠的替换键时，这一点非常重要。

**为什么顺序很重要：**

```js
// 输入代码：
const apiV2 = API_URL_V2;
const api = API_URL;

replacePlugin({
  API_URL: '"https://api.example.com"',
  API_URL_V2: '"https://api.example.com/v2"',
});

// 不按长度排序（❌ 错误）：
/* const apiV2 = "https://api.example.com"_V2;  // 不正确！
const api = "https://api.example.com"; */

// 按长度排序（✅ 正确）：
/* const apiV2 = "https://api.example.com/v2";  // API_URL_V2 先匹配
const api = "https://api.example.com";       // 然后匹配 API_URL */
```

该插件通过优先处理更长的键来自动处理这一点，因此你不需要担心定义替换项的顺序。

### 单词边界

默认情况下，替换只会在单词边界处发生，以避免意外的子字符串替换。

**示例：**

```js
// 输入代码：
const currentEnv = env;
const environment = getEnvironment();
const config = process.env.NODE_ENV;

replacePlugin({ env: '"production"' });

// 输出：
// const currentEnv = "production";           ✅ 'env' 作为独立单词
// const environment = getEnvironment();      ✅ 'env' 是 'environment' 的一部分
// const config = process.env.NODE_ENV;       ✅ 'env' 在 '.' 之后（属性访问）
```

这种行为可确保替换 `env` 时不会意外破坏 `environment` 或像 `process.env` 这样的属性访问。如果需要，你可以通过 `delimiters` 选项进行自定义。

## 从 @rollup/plugin-replace 迁移

### 功能对比

| 功能     | @rollup/plugin-replace       | rolldown                        |
| -------- | ---------------------------- | ------------------------------- |
| API      | `replace({ values: {...} })` | `replacePlugin({...}, options)` |
| 函数值   | ✅ `() => value`             | ❌ 仅支持静态值                 |
| 文件过滤 | ✅ include/exclude           | ❌ 所有文件                     |
| 性能     | JavaScript                   | Rust（更快）                    |

### 迁移示例

```js
// 之前（@rollup/plugin-replace）
replace({
  values: { __VERSION__: () => getVersion() },
  include: ['src/**/*.js'],
});

// 之后（rolldown）
replacePlugin({
  __VERSION__: JSON.stringify(getVersion()),
});
```
