# 外部模块

当一个模块被标记为 external 时，Rolldown 不会将其打包。相反，`import` 或 `require` 语句会保留在输出中，并且预期该模块在运行时可用。

```js
// 输入
import lodash from 'lodash';
console.log(lodash);

// 输出（lodash 为 external）
import lodash from 'lodash';
console.log(lodash);
```

本页将端到端解释 externals 的工作方式：一个模块如何变为 external、它的导入路径如何在输出中确定，以及相关选项和插件钩子如何交互。

## 模块如何变为 External

一个模块可以通过三种方式被标记为 external：

1. **[`external`](/reference/InputOptions.external) 选项** — 一个配置级模式（字符串、正则、数组或函数），用于测试每个 import specifier。有关模式语法、示例和注意事项，请参见 [选项参考](/reference/InputOptions.external)。

2. **插件的 `resolveId` 钩子** — 插件可以返回 `{ id, external: true }`（或 `"relative"` / `"absolute"`）来显式地将模块标记为 external。插件也可以 `return false`，以与 `external` 选项相同的规范化方式将原始 specifier 标记为 external。

3. **未解析的模块** — 如果没有插件或内部解析器能找到某个模块，并且 `external` 选项匹配该 specifier，Rolldown 会将其视为 external，而不是抛出错误。

## 完整的解析流程

下面是 Rolldown 遇到一个 import 时所遵循的分步过程：

### 1. 首次 `external` 检查

原始 import specifier（例如 `'./utils'`、`'lodash'`）会使用 `isResolved: false` 与 [`external`](/reference/InputOptions.external) 选项进行测试。如果匹配，则该模块会立即被标记为 external——**插件和内部解析器会被完全跳过**。

### 2. 插件 `resolveId`

如果第一次检查未匹配，插件就有机会解析该 import：

| 插件返回值                            | 影响                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| `return false`                        | External。使用原始 specifier 作为模块 ID（与步骤 1 的规范化相同）。 |
| `return { id, external: true }`       | External。使用 `id` 作为模块 ID。                                   |
| `return { id, external: "relative" }` | External。路径**始终**相对化（覆盖配置）。                          |
| `return { id, external: "absolute" }` | External。路径**始终**保持原样（覆盖配置）。                        |
| `return { id }`（没有 `external`）    | 已解析，带着解析后的 ID 继续到步骤 3。                              |
| `return null`                         | 没有插件处理它，继续到步骤 3。                                      |

### 3. 内部解析器

Rolldown 内置的解析器会尝试在磁盘上找到该模块。

### 4. 第二次 `external` 检查

解析后的 ID（例如 `'/project/node_modules/vue/dist/vue.runtime.esm-bundler.js'`）会使用 `isResolved: true` 与 [`external`](/reference/InputOptions.external) 选项进行测试。如果匹配，则该 specifier 会被标记为 external。

### 5. 输出路径确定

无论是哪个步骤将模块标记为 external（首次检查、插件或第二次检查），[`makeAbsoluteExternalsRelative`](/reference/InputOptions.makeAbsoluteExternalsRelative) 都会统一应用，以确定输出中的导入路径：

- **裸 specifier**（例如 `'lodash'`、`'node:fs'`）——如果在第一次检查中匹配，则会原样出现。如果在第二次检查中匹配（已解析路径），则会显示完整的解析路径（参见关于 `/node_modules/` 的 [注意事项](/reference/InputOptions.external#avoid-node-modules-for-npm-packages)）。

- **相对和绝对 specifier** —— 会发生两件事：
  1. **解析时规范化** — 对于第一次检查和 `return false`，当启用 `makeAbsoluteExternalsRelative` 时（默认就是启用的），相对 specifier（**原始 import specifier**）会通过相对于导入者目录进行解析而被规范化为绝对路径。这可确保从不同目录导入的 `'./utils'` 能正确映射到不同的 external 模块。对于第二次检查和 `return { id, external: true }`，**解析后的模块 ID** 已经是绝对路径。

  2. **渲染时输出** — 绝对的已解析模块 ID 可能会从输出 chunk 的位置重新转换为相对路径（例如 `'/project/src/utils.js'` → `'./utils.js'`）。是否发生取决于 `makeAbsoluteExternalsRelative` 的值，以及原始 import specifier 是否为相对路径。

插件覆盖（`external: "relative"` / `"absolute"`）会完全绕过这套逻辑。有关每个值如何控制此行为及示例，请参见 [`makeAbsoluteExternalsRelative` 参考](/reference/InputOptions.makeAbsoluteExternalsRelative)。

## 特殊情况

### Data URLs

带有有效 `data:` URL 的 specifier（例如 `data:text/javascript,export default 42`），且文件格式受支持时，会由 Rolldown 的内部 dataurl 插件处理，该插件会**打包内联内容**。它们不会自动被视为 external。

不过，其他 `data:` URLs 会自动被视为 external，除非由自定义插件处理。

### HTTP URLs

以 `http://`、`https://` 或 `//` 开头的 specifier 会**自动被视为 external**，无论 `external` 选项如何，除非由自定义插件处理。这些 ID 会原样输出，不受 `makeAbsoluteExternalsRelative` 影响。

```js
import lib from 'https://cdn.example.com/lib.js';
// 始终为 external，原样输出
```
