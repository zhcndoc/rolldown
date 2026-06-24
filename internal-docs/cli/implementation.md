# CLI 设计

CLI 使用 [cac](https://github.com/cacjs/cac)（v6.7.14）进行参数解析。cac 与 Vite 和 tsdown 使用的是同一个库。

## 流程

```
bin/cli.mjs
  → src/cli/index.ts（入口）
    → checkNodeVersion()
    → parseCliArguments()
      → arguments/index.ts
        → getCliSchemaInfo()                 — 将 valibot schema 扁平化为 { key: { type, description } }
        → build `options` export             — 供 help.ts 使用（camelCase keys，与 Rollup/Vite 的帮助显示保持一致）
        → build knownKeys / shortAliases     — 用于后处理
        → register options with cac          — 遍历 schemaInfo + alias，构建 rawName 字符串
        → cli.parse(process.argv, { run: true })
        → 后处理：
          → 删除 `--` key 和短别名重复项
          → 原型污染防护
          → 未知选项检测 + 警告
          → rawArgs 快照
          → 移除未知 key
          → 类型强制转换（重复项过滤 + 数组包装）
          → 对象选项解析（key:val,key:val）
      → arguments/normalize.ts
        → 通过 valibot 进行 validateCliOptions()
        → 根据 schema keys 分成 input/output
        → 将 positionals 合并到 input.input
    → 处理 --environment（KEY:VALUE → process.env）
    → 如果 --help：显示 showHelp()
    → 如果 --version：打印版本
    → 如果 --config：bundleWithConfig(configPath, cliOptions, rawArgs)
    → 如果指定了 input：bundleWithCliOptions(cliOptions)
    → 否则：显示帮助
```

## 关键文件

| 文件                              | 作用                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `cli/index.ts`                    | 入口文件 — 协调整个流程                                                            |
| `cli/arguments/index.ts`          | 核心解析 — cac 初始化、选项注册、后处理                                              |
| `cli/arguments/normalize.ts`      | 将扁平选项拆分为 `input`/`output`，并用 valibot 校验                                  |
| `cli/arguments/alias.ts`          | 短标志、`reverse`、`requireValue`、`hint` 配置                                      |
| `cli/arguments/utils.ts`          | `setNestedProperty`、`camelCaseToKebabCase`                                       |
| `cli/commands/help.ts`            | 自定义帮助文本生成（读取 `options` export）                                           |
| `cli/commands/bundle.ts`          | `bundleWithConfig`、`bundleWithCliOptions`、watch 模式                              |
| `cli/logger.ts`                   | consola logger，在 `ROLLDOWN_TEST=1` 时替换为普通 `console.log`                    |
| `utils/validator.ts`              | 所有 CLI 选项的 valibot schemas、`getCliSchemaInfo()`、input/output key 列表         |
| `utils/flatten-valibot-schema.ts` | 递归将 valibot object schemas 扁平化为 `{ key: { type, description } }`             |

## `parseCliArguments()` 的返回值

```ts
interface NormalizedCliOptions {
  input: InputOptions;
  output: OutputOptions;
  help: boolean;
  config: string;
  version: boolean;
  watch: boolean;
  environment?: string | string[];
}

// 另外还有 rawArgs: Record<string, any> — 包含所有已解析参数，包括未知参数
```

## cac 配置

### 选项注册

遍历 `schemaInfo` + `alias`，并向 cac 注册每个选项。schema keys 采用 camelCase（例如 `moduleTypes`）；cac 内部的 `camelcaseOptionName` 负责 kebab↔camel 转换，因此我们直接用 camelCase key 注册。cac 会同时匹配 argv 中的 `--moduleTypes` 和 `--module-types`。

```ts
for (const [key, info] of Object.entries(schemaInfo)) {
  const config = alias[key as keyof typeof alias];

  let rawName = '';
  if (config?.abbreviation) rawName += `-${config.abbreviation}, `;

  if (config?.reverse) {
    rawName += `--no-${key}`;
  } else {
    rawName += `--${key}`;
  }

  // 方括号语法决定 cac 如何处理该选项：
  // - 不带方括号 → boolean（注册到 mri 的 boolean 列表中）
  // - <required>  → string，如果缺少值则 checkOptionValue 抛出 CACError
  // - [optional]  → string，如果后面没有值则返回 true
  if (info.type !== 'boolean' && !config?.reverse) {
    if (config?.requireValue) {
      rawName += ` <${config?.hint ?? key}>`;
    } else {
      rawName += ` [${config?.hint ?? key}]`;
    }
  }

  cli.option(rawName, info.description ?? config?.description ?? '');
}
```

### 默认命令

```ts
const cmd = cli.command('[...input]', '');
cmd.allowUnknownOptions();    // 抑制 cac 的未知选项错误——我们自己发出警告
cmd.ignoreOptionDefaultValue(); // 防止 cac 注入 --no-* 默认值
cmd.action((input, opts) => { ... });
cli.parse(process.argv, { run: true });
```

### cac 提供给我们的能力

- camelCase/kebab-case 可互换匹配（修复 [#8410]）
- `--no-*` 布尔取反
- 通过 `checkOptionValue()` 进行 `<required>` 值校验——抛出 `CACError`
- `[optional]` 值解析——修复 `-s inline` 的位置限制（[#3248]）
- 通过 `setDotProp` 实现点号嵌套（`--transform.define X=Y` → `{ transform: { define: 'X=Y' } }`）
- 短标志别名与堆叠（`-ms` = `--minify --sourcemap`）
- 对重复标志自动累积为数组

### 我们自行实现的部分

- **对象解析** — `--module-types .a=text,.b=json`：先按 `,` 再按 `=` 拆分。支持单个 flag 逗号分隔以及重复 flags。
- **未知选项警告** — `allowUnknownOptions()` 会抑制 cac 的错误；我们用自己的消息格式检测并警告。
- **原型污染防护** — cac 的 `setDotProp` 不会防护 `__proto__`、`constructor`、`prototype`。
- **input/output 拆分** — `normalize.ts` 中 rolldown 特有的逻辑，将扁平选项拆分为 `InputOptions` 和 `OutputOptions`。
- **自定义帮助文本** — 不使用 `cli.help()`；保留我们自己的生成器，包含排序、对齐、示例、说明。
- **重复选项过滤** — 非数组类型取最后一个值；`external` 和 `input` 保留数组。
- **rawArgs 组装** — 所有已解析参数（包括未知参数）的快照，用于 config 函数透传。
- **短别名 key 清理** — mri 会同时保留短名和长名（例如 `{ s: true, sourcemap: true }`）；我们会删除短名 key。

## 后处理顺序

1. 删除 `parsedOptions['--']`（cac 特有产物）
2. 删除短别名重复 key
3. 原型污染防护
4. 未知选项检测 + 警告
5. 快照 `rawArgs`（包含未知 key）
6. 从 `parsedOptions` 中移除未知 key
7. 类型强制转换 — 重复项过滤 + 数组包装（合并为单次循环）
8. 对象选项解析（`key:val,key:val`）
9. `normalizeCliOptions()` — valibot 校验 + input/output 拆分

## 实现说明

### `CACError` 未导出

cac 只导出 `cac`、`CAC` 和 `Command`。`CACError` 在 `utils.ts` 中，但没有重新导出。我们通过检查 `err.name === 'CACError'` 来捕获。

### `ignoreOptionDefaultValue()`

cac 会为 `--no-*` 选项自动注入 `default: true`。如果不调用 `ignoreOptionDefaultValue()`，cac 会在每次解析结果中都注入这些默认值，即使没有传入该标志也会如此。这会破坏 valibot 校验——例如 `preserveEntrySignatures` 只接受 `false`，而 cac 注入的 `true` 会导致校验错误。我们完全禁用 cac 的默认值，让 bundler 自己处理默认值。

### 短别名 key 重复

mri 会同时返回短名和长名作为独立 key（例如 `-s` → `{ s: true, sourcemap: true }`）。我们在启动时收集所有短别名，并在解析后的选项中删除它们。

### 嵌套选项的父级 key

cac 的 `setDotProp` 会把 `--transform.define value` 转换为 `{ transform: { define: 'value' } }`。在检查未知选项时，顶层 key `transform` 不在扁平化的 `schemaInfo` 中（只有 `transform.define`、`transform.target` 等）。我们会从点分 schema keys 预先计算父级 key，并将其纳入已知集合。

### 对象选项解析遍历

在 cac 的 `setDotProp` 之后，解析出的选项已经是嵌套结构。对象解析步骤会沿着点路径遍历以查找并解析字符串值，而不是遍历顶层条目。

### 带可选值的 `--config`

`-c` 注册为 `[optional]` 时，如果后面没有值，会返回 `config: true`。`normalize.ts` 会将 `config: true` 映射为 `config: ''`，以保留自动检测行为。

### `--environment` 不是对象选项

`--environment` 使用 `:` 和 `,` 分隔符（与 Rollup 兼容），在 `cli/index.ts` 中单独处理，写入 `process.env`。其 schema 类型是 `string | string[]`，不是 object。这与对象选项解析无关。

### `--` 分隔符

`parseArgs` 会将 `--` 之后的参数视为 positionals。cac 会把它们收集到 `options['--']` 数组中。我们会在后处理中删除这个 key，因为下游代码不会使用它。

## 边界情况

### `--sourcemap` 双重行为

单独 `-s` → `true`。`-s inline` → `"inline"`。`--sourcemap hidden` → `"hidden"`。

注册方式为 `-s, --sourcemap [type]`。`[optional]` 方括号意味着 mri 不会把 `-s` 当作 boolean——它会把下一个非 flag 参数作为值，若后面没有则返回 `true`。

### `--no-preserve-entry-signatures`

传入时，cac 设置 `preserveEntrySignatures: false`。未传入时，其值为 `undefined`，由 bundler 应用自己的默认值（`ExportsOnly`）。

### 值中包含逗号的对象选项

`--transform.define __A__=A,__B__=B` — cac 返回单个字符串 `"__A__=A,__B__=B"`。我们的后处理会将其拆分为 `{ __A__: 'A', __B__: 'B' }`。

### 原型污染

cac 的 `setDotProp` 不会防护 `__proto__`、`constructor` 或 `prototype`。我们会在归一化之前的后处理中删除任何此类 key。

## 测试用例

测试位于 `packages/rolldown/tests/cli/cli-e2e.test.ts`。运行命令：`cd packages/rolldown/tests && pnpm test:cli`。

| #   | 功能                     | 示例                                                                            |
| --- | ------------------------ | ------------------------------------------------------------------------------- |
| 1   | `--version` / `-v`        | `rolldown --version`                                                            |
| 2   | `--help` / `-h`           | `rolldown --help`                                                               |
| 3   | 空参数时显示帮助         | `rolldown`                                                                      |
| 4   | 帮助优先级 ([#8523])      | `rolldown lib -o dist/lib.js --help`                                            |
| 5   | 布尔选项                 | `rolldown index.ts --minify -d dist`                                            |
| 6   | 字符串选项               | `rolldown index.ts --format cjs -d dist`                                        |
| 7   | 短标志                   | `rolldown index.ts -d dist -s`                                                  |
| 8   | 数组（重复 flags）        | `rolldown index.ts --external node:path --external node:url -d dist`            |
| 9   | 对象（重复 flags）        | `rolldown index.ts --module-types .123=text --module-types .b64=base64 -d dist` |
| 9a  | 对象（逗号分隔）          | `rolldown index.ts --module-types .123=text,notjson=json,.b64=base64 -d dist`   |
| 10  | `--no-*` 布尔取反         | `rolldown index.ts --no-external-live-bindings ...`                             |
| 11  | 嵌套点号表示法           | `rolldown index.js --transform.define __DEFINE__=defined`                       |
| 12  | positionals 作为 input   | `rolldown 1.ts --input ./2.js`                                                  |
| 13  | 配置加载（`-c`）          | `rolldown -c rolldown.config.ts`                                                |
| 14  | 配置函数 + rawArgs       | `rolldown -c rolldown.config.js --customArg=customValue`                        |
| 15  | CLI 覆盖配置              | `rolldown -c rolldown.config.js --format cjs`                                   |
| 16  | `--environment`           | `rolldown -c --environment PRODUCTION,FOO:bar`                                  |
| 17  | `requireValue` 校验       | `rolldown 1.ts -d`（错误：需要值）                                               |
| 18  | 无效选项值               | `rolldown index.ts --format INCORRECT`                                          |
| 19  | 未知选项警告             | `rolldown index.ts --someRandomFlag -d dist`                                    |
| 20  | watch 模式               | `rolldown index.ts -d dist -w -s`                                               |
| 21  | camelCase input ([#8410]) | `rolldown index.ts --moduleTypes .png=dataurl -d dist`                          |

[#8410]: https://github.com/rolldown/rolldown/issues/8410
[#3248]: https://github.com/rolldown/rolldown/issues/3248
[#8523]: https://github.com/rolldown/rolldown/issues/8523

## 相关

- [#8410 — CLI 静默误处理 camelCase 选项](https://github.com/rolldown/rolldown/issues/8410)
- [#3248 — `-s inline` 位置限制](https://github.com/rolldown/rolldown/issues/3248)
- [#8523 — `--help` 对其他选项的优先级](https://github.com/rolldown/rolldown/issues/8523)
- [Vite CLI 源码](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/cli.ts) — cac 使用模式的参考

---

<details>
<summary>迁移背景（已归档）</summary>

## 迁移：`parseArgs` → cac

之前的实现使用的是 Node.js 内置的 `parseArgs`，并带有 16 个手写的 workaround。#8410 的根本原因是 `parseArgs` 会把 `--moduleTypes` 视为未知的布尔值（因为它只识别 `--module-types`），并且会悄悄把该值丢进位置参数中。

### 变更内容

| 文件                         | 操作       | 详情                                         |
| ---------------------------- | ---------- | ----------------------------------------------- |
| `cli/arguments/index.ts`     | 重写       | 用 cac 替换 parseArgs，并添加后处理            |
| `cli/arguments/normalize.ts` | 简化       | 移除 unflattening 循环 + 原型保护              |
| `cli/arguments/alias.ts`     | 简化       | 移除 `default` 字段（死代码）                 |
| `cli/arguments/utils.ts`     | 简化       | 移除 `kebabCaseToCamelCase`                   |
| `cli/commands/help.ts`       | 小幅更新   | 适配新的 `options` 导出形状                  |
| `cli/index.ts`               | 无变化     | 相同接口                                      |
| `cli/commands/bundle.ts`     | 无变化     | 相同接口                                      |

### 行为差异

| 变更                      | 之前                                               | 之后                                                 |
| ------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| 数字字符串强制转换        | `--code-splitting.min-size 1000` → 字符串 `"1000"` | → 数字 `1000`（mri 会强制转换看起来像数字的值）      |
| 未知选项上的 `--no-*`     | 警告 "foo is unrecognized"                         | 警告相同，但值变为 `false` 而不是缺失                |
| `--` 分隔符              | `--` 之后的参数变为位置参数                         | 收集到 `options['--']` 中，并在后处理时删除         |
| 短旗标堆叠               | 不支持                                              | `-ms` = `--minify --sourcemap`                       |

### 为什么从 `alias.ts` 中移除 `default`

三个 `reverse: true` 选项（`treeshake`、`externalLiveBindings`、`preserveEntrySignatures`）的 `default` 值在主分支上属于死代码——token 循环只会在没有传值时，对 `string`/`union` 类型使用 `default`，而这些全都是 `boolean`/`reverse` 选项。使用 `ignoreOptionDefaultValue()` 后，cac 也不会应用默认值。

</details>
