# 插件 Hook 过滤器

Hook 过滤器允许 Rolldown 在调用你的插件之前，先在 Rust 端评估过滤条件，从而跳过不必要的 Rust 到 JS 调用。这提升了性能，并支持更好的并行化。更多详情请参见 [为什么需要插件 Hook 过滤器](/in-depth/why-plugin-hook-filter)。

## 基本用法

不要在你的 hook 内部检查条件：

```js{5}
export default function myPlugin() {
  return {
    name: 'example',
    transform(code, id) {
      if (!id.endsWith('.data')) {
        // 提前返回
        return
      }
      // 执行实际转换
      return transformedCode
    },
  }
}
```

改用带有 `filter` 属性的对象 hook 格式：

```js{5-7}
export default function myPlugin() {
  return {
    name: 'example',
    transform: {
      filter: {
        id: /\.data$/
      },
      handler(code) {
        // 执行实际转换
        return transformedCode
      },
    }
  }
}
```

Rolldown 会在 Rust 端评估过滤器，并且只有在过滤器匹配时才调用你的 handler。

::: tip
[`@rolldown/pluginutils`](https://npmx.dev/package/@rolldown/pluginutils) 导出了一些用于 hook 过滤器的工具，例如 `exactRegex` 和 `prefixRegex`。
:::

## 过滤器属性

除了 `id` 之外，你还可以基于 `moduleType` 和模块源码进行过滤。`filter` 属性的工作方式与 [`@rollup/pluginutils` 中的 `createFilter`](https://github.com/rollup/plugins/blob/master/packages/pluginutils/README.md#createfilter) 类似。

- 如果向 `include` 传入多个值，只要其中 **任意一个** 匹配，过滤器就算匹配。
- 如果过滤器同时具有 `include` 和 `exclude`，则 `exclude` 优先。
- 如果指定了多个过滤器属性，只有当所有指定属性都匹配时，过滤器才算匹配。换句话说，即使有一个属性未匹配，也会被排除，而不管其他属性如何。例如，下面的过滤器只有在模块文件名以 `.js` 结尾、源码包含 `foo` 且不包含 `bar` 时才会匹配：
  ```js
  {
    id: {
      include: /\.js$/,
      exclude: /\.ts$/
    },
    code: {
      include: 'foo',
      exclude: 'bar'
    }
  }
  ```

以下属性受每个 hook 支持：

- `resolveId` hook：`id`
- `load` hook：`id`
- `transform` hook：`id`、`moduleType`、`code`

另请参见 [`HookFilter`](/reference/Interface.HookFilter)。

> [!NOTE]
> 当你传入 `string` 时，`id` 会被视为 glob 模式；当你传入 `RegExp` 时，`id` 会被视为正则表达式。
> 在 `resolve` hook 中，`id` 必须是 `RegExp`，不允许使用 `string`。
> 这是因为 `resolveId` 中的 `id` 值是导入语句中写入的精确文本，通常不是绝对路径，而 glob 模式是用来匹配绝对路径的。

## 可组合过滤器

对于更复杂的过滤逻辑，Rolldown 通过 [`@rolldown/pluginutils`](https://github.com/rolldown/rolldown/tree/main/packages/pluginutils) 包提供了可组合的过滤表达式。这些表达式允许你使用 `and`、`or` 和 `not` 等逻辑运算符来构建过滤器。

> [!WARNING]
> 可组合过滤器尚未在 Vite 或 unplugin 中支持。它们只能用于 Rolldown 插件。

### 示例

```js
import { and, id, include, moduleType } from '@rolldown/pluginutils';

export default function myPlugin() {
  return {
    name: 'my-plugin',
    transform: {
      filter: [include(and(id(/\.ts$/), moduleType('ts')))],
      handler(code, id) {
        // 仅在 moduleType 为 'ts' 的 .ts 文件上调用
        return transformedCode;
      },
    },
  };
}
```

### 可用的过滤器函数

- `and(...exprs)` / `or(...exprs)` / `not(expr)` — 过滤表达式的逻辑组合。
- `id(pattern, params?)` — 按 id 过滤。`string` 模式按完全相等匹配（不是 glob）；`RegExp` 会针对 id 进行测试。
- `importerId(pattern, params?)` — 按导入者 id 过滤。`string` 模式按完全相等匹配；`RegExp` 会针对导入者 id 进行测试。仅可用于 `resolveId` hook。
- `moduleType(type)` — 按模块类型过滤（例如 'js'、'tsx' 或 'json'）。
- `code(pattern)` — 按代码内容过滤。
- `query(key, pattern)` — 按查询参数过滤。
- `include(expr)` / `exclude(expr)` — 顶层 include/exclude 包装器。
- `queries(obj)` — 组合多个查询过滤器。

完整 API 参考请参见 [`@rolldown/pluginutils` README](https://github.com/rolldown/rolldown/tree/main/packages/pluginutils#readme)。

## 互操作性

Rollup 4.38.0+、Vite 6.3.0+ 以及所有版本的 Rolldown 都支持插件 hook 过滤器。

### 支持旧版本

如果你正在编写一个需要同时支持旧版本 Rollup（< 4.38.0）或 Vite（< 6.3.0）的插件，你可以提供一个在两种环境下都能工作的回退实现。

策略是：在可用时使用带过滤器的对象 hook 格式，而在旧版本中回退到一个在内部检查条件的普通函数：

```js
const idFilter = /\.data$/;

export default function myPlugin() {
  return {
    name: 'my-plugin',
    transform: {
      // Rolldown 和新版 Rollup/Vite 会使用该过滤器
      filter: { id: idFilter },
      // 当过滤器匹配时调用 handler
      handler(code, id) {
        // 为了兼容旧版本，在 handler 中再次检查
        // 只有在你支持旧版本时才需要这样做
        if (!idFilter.test(id)) {
          return null;
        }
        // 执行实际转换
        return transformedCode;
      },
    },
  };
}
```

这种方式可以确保你的插件：

- 在 Rolldown 和新版 Rollup/Vite 中使用过滤器以获得最佳性能
- 在旧版本中仍能正常工作（它们会对所有文件调用 handler，但内部检查可确保行为正确）

> [!TIP]
> 在支持旧版本时，请保持过滤器模式和内部检查同步，以避免混淆。

### `moduleType` 过滤器

[模块类型概念](/in-depth/module-types)在 Rollup / Vite 7 及以下版本中不存在。因此，这些工具不支持 `moduleType` 过滤器，并且会忽略它。
