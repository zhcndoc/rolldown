# 测试

## 快速指南

:::tip TLDR
运行 `just test-update` 来运行所有 rust 和 node.js 测试，并自动更新快照
:::

我们有两组测试套件：一组用于 Rust，另一组用于 Node.js。

:::warning 你应该遵守的测试原则

1. 当添加带选项的新功能时，如果可能，请始终确保在 JavaScript 侧添加相关测试。

这里有一些关于如何选择测试技术的细节 [details](#how-to-choose-test-technique)
:::

- `just test` 用于运行所有测试。
- `just test-update` 用于运行所有测试并自动更新快照
- `just test-rust` 用于运行所有 Rust 测试。
- `just test-node` 用于运行所有 Node.js 测试。
- `just test-node-rolldown` 用于仅运行 Rolldown 的 Node.js 测试。
- `just test-node-rollup` 用于仅运行 Rollup 的测试。

## 概念

测试是 Rolldown 开发过程中的关键部分。随着我们添加新功能和进行更改，它帮助我们确保打包器的正确性、稳定性和性能。

由于 Rolldown 的本质是一个 **bundler**，我们更倾向于使用覆盖端到端场景的集成测试，而不是测试单个组件的单元测试。这使我们能够验证整个打包过程是否按预期工作，从输入文件到输出包。

通常，我们使用两种类型的测试：

- 数据驱动测试：测试运行器会查找符合特定约定（例如文件夹结构、文件命名）的测试用例并自动运行它们。这是我们添加新测试的主要方式。
- 手动测试：对于无法轻松用数据驱动方式表达的更复杂场景，我们会编写手动测试代码来设置测试环境、使用特定选项运行打包器，并以程序方式验证输出。

## Rust

我们使用 Rust 内置的测试框架来编写和运行测试。测试用例存放在 `crates/rolldown/tests` 文件夹中。

### 数据驱动测试

数据驱动测试用例是一个包含 `_config.json` 文件的文件夹。测试运行器会从 `_config.json` 读取配置，打包输入文件，并执行输出文件以验证行为。

`_config.json` 包含测试套件的配置。如果一切正常，你在编辑 `_config.json` 时应该能够获得自动补全，这得益于 [config](https://github.com/rolldown/rolldown/blob/main/.vscode/settings.json#L36-L40)。

对于所有可用选项，你可以参考

- [Bundler Options](https://github.com/rolldown/rolldown/blob/100c6ee13cef9c50529b8d6425292378ea99eae9/crates/rolldown_common/src/inner_bundler_options/mod.rs#L53)
- [JSON Schema file](https://github.com/rolldown/rolldown/blob/main/crates/rolldown_testing/_config.schema.json)

#### 数据驱动测试做什么？

- 它会生成构建产物的快照，包括：
  - 打包后的输出文件
  - 打包过程中发出的警告和错误

- 如果 `_test.mjs` 不存在，则在 Node.js 环境中运行输出文件以验证运行时行为。你可以把它理解为运行 `node --import ./dist/entry1.mjs --import ./dist/entry2.mjs --import ./dist/entry3.mjs --eval ""`。

- 如果存在 `_test.mjs`，则运行它以验证更复杂的行为。

#### 提示

- 当你运行 Rust 测试时，快照会自动更新。不需要额外命令。

#### 功能完整的数据驱动测试

`_config.json` 有其局限性，因此我们也支持直接使用 Rust 编写测试。你可以参考

[`crates/rolldown/tests/rolldown/errors/plugin_error`](https://github.com/rolldown/rolldown/blob/86c7aa6557a2bb7eef03133b148b1703f4e21167/crates/rolldown/tests/rolldown/errors/plugin_error)

它本质上只是用 Rust 代码替换 `_config.json`，由 Rust 代码直接配置打包器。其余部分的工作方式与数据驱动测试相同。

#### esbuild

Rolldown 也会运行源自 esbuild 打包器测试套件的测试，以验证兼容性。这些测试位于 `crates/rolldown/tests/esbuild`。

`scripts` 目录包含用于管理 esbuild 测试的工具：

- **`gen-esbuild-tests`** - 从 esbuild 的 Go 测试文件生成测试用例。
- **`esbuild-snap-diff`** - 将 Rolldown 的输出快照与 esbuild 的预期输出进行比较。它会生成差异报告和兼容性统计信息，帮助跟踪 Rolldown 的行为与 esbuild 的接近程度。

  该脚本会在 `scripts/src/esbuild-tests/snap-diff/summary/` 中生成汇总 markdown 文件，并在 `scripts/src/esbuild-tests/snap-diff/stats/stats.md` 中生成整体统计信息。

可以通过在文件夹名前加上 `.` 来跳过测试用例（例如 `.test_case_name`）。被跳过的测试必须在 `scripts/src/esbuild-tests/reasons.ts` 中记录原因。

#### HMR 测试

如果测试用例文件夹包含任何名为 `*.hmr-*.js` 的文件，则该测试将以启用 HMR 的模式运行。

##### HMR 编辑文件

- 匹配 `*.hmr-*.js` 模式的文件称为 **HMR 编辑文件**。
- 这些文件表示对现有源文件的更改。
- `hmr-` 后面的部分表示更改的**步骤编号**。例如，`main.hmr-1.js` 表示在**步骤 1** 中应用的更改。

##### 测试如何工作

1. 所有非 HMR 文件都会被复制到一个临时目录。
2. 基于这些文件生成初始构建。
3. 然后开始 HMR 步骤 1：使用 `.hmr-1.js` 文件覆盖临时目录中对应的文件，并生成一个 HMR 补丁。
4. 这个过程会在步骤 2、3 等中重复。像 `*.hmr-2.js`、`*.hmr-3.js` 等文件会按步骤依次应用。

:::details 示例

如果测试文件夹包含这些文件：

- `main.js`
- `sub.js`
- `main.hmr-1.js`
- `sub.hmr-1.js`
- `sub2.hmr-2.js`

测试将按以下步骤进行：

1. **初始构建**：`main.js`、`sub.js`
2. **步骤 1**：
   - `main.js` 被 `main.hmr-1.js` 替换
   - `sub.js` 被 `sub.hmr-1.js` 替换
3. **步骤 2**：
   - `main.js` 和 `sub.js` 保持与步骤 1 相同
   - 使用 `sub2.hmr-2.js` 的内容添加 `sub2.js`

:::

### 手动测试

对于无法轻松用数据驱动方式表达的更复杂场景，我们会编写手动测试代码来设置测试环境、使用特定选项运行打包器，并以程序方式验证输出。

这里没什么特别的，基本上就是编写正常的 Rust 测试代码，使用 Rolldown 来执行打包和验证。

### test262 集成测试

Rolldown 集成了 [test262](https://github.com/tc39/test262) 测试套件，以验证 ECMAScript 规范符合性。只运行 `test/language/module-code` 下的测试用例，因为其他测试用例应由 Oxc 侧覆盖。

在设置项目时，运行 `just setup` 后应该已经初始化了 git 子模块，但你还应该在运行集成测试之前执行 `just update-submodule` 来更新该子模块。

你可以使用以下命令运行 test262 集成测试：

```shell
TEST262_FILTER="attribute" cargo test --test integration test262_module_code -- --no-capture
```

- `TEST262_FILTER` 允许你按名称过滤测试（例如 `"attribute"`）。如果省略此环境变量，将运行所有测试用例。注意，如果设置了该环境变量，将不会更新结果快照。
- `--no-capture` 选项会显示所有测试输出。

预期会失败的测试用例列在 [`crates/rolldown/tests/test262_failures.json`](https://github.com/rolldown/rolldown/blob/main/crates/rolldown/tests/test262_failures.json) 中。

## Node.js

Rolldown 使用 [Vitest](https://vitest.dev/) 来测试 Node.js 侧代码。

位于 `packages/rolldown/tests` 的测试用于测试 Rolldown 的 Node.js API（即 NPM 上发布的 `rolldown` 包的 API）。

- `just test-node-rolldown` 将运行 rolldown 测试。
- `just test-node-rolldown --update` 将运行测试并更新快照。

### 数据驱动测试

数据驱动测试位于 `packages/rolldown/tests/fixtures`。

数据驱动测试用例是一个包含 `_config.ts` 文件的文件夹。测试运行器会从 `_config.ts` 读取配置，打包输入文件，并将输出与预期结果进行验证。

### 手动测试

这里也没什么特别的，基本上就是编写正常的 JavaScript/TypeScript 测试代码，使用 Rolldown 来执行打包和验证。

### 运行特定文件的测试

要运行特定文件的测试，你可以使用

```shell
just test-node-rolldown test-file-name
```

例如，要运行 `fixture.test.ts` 中的测试，你可以使用 `just test-node-rolldown fixture`。

### 提示

#### 运行特定测试

要运行特定测试，你可以使用

```shell
just test-node-rolldown -t test-name
```

`fixture.test.ts` 中的测试名称按其文件夹名称定义。`tests/fixtures/resolve/alias` 的测试名称将是 `resolve/alias`。

要运行 `tests/fixtures/resolve/alias` 测试，你可以使用 `just test-node-rolldown -t resolve/alias`。

:::info

- `just test-node-rolldown -t aaa bbb` 与 `just test-node-rolldown -t "aaa bbb"` 不同。前者将运行名称包含 `aaa` 或 `bbb` 的测试，而后者将运行名称包含 `aaa bbb` 的测试。

- 如需更高级的用法，请参考 https://vitest.dev/guide/filtering。

:::

## Rollup 行为对齐测试

我们也通过将 Rollup 自身的测试运行在 Rolldown 上，来实现与 Rollup 的行为对齐。

为此，`packages/rollup-tests/test` 中的每个测试用例都会代理到项目根目录中 `rollup` git 子模块里的对应测试。

在设置项目时，运行 `just setup` 后应该已经初始化了 git 子模块，但你还应该在运行 Rollup 测试之前执行 `just update-submodule` 来更新该子模块。

在 `/packages/rollup-tests` 中：

- `just test-node-rollup` 将运行 rollup 测试。
- `just test-node-rollup --update` 将运行并更新测试状态。

要运行特定测试，请在 `just test-node-rollup` 中使用 `--grep` 选项：

```shell
just test-node-rollup --grep "function"
```

这将只运行名称匹配 "function" 的测试。有关更多过滤选项，请参阅 [Mocha 的 grep 文档](https://mochajs.org/#grep)。

> [!NOTE]
> 某些 Rollup 测试需要特定版本的 Node.js 才能运行。测试会在其 `_config.js` 文件中指定 `minNodeVersion`，当运行的 Node 版本低于所需版本时会自动跳过。除非你的 Node 版本是 24 或更高，否则通过的测试数量会不同。

## 如何选择测试技术

我们的 Rust 测试基础设施已经强大到足以覆盖 JavaScript 的大多数情况（插件、在配置中传入函数）。
但由于 JavaScript 侧用户仍然是我们的第一类用户，如果可能的话，尽量把测试放在 JavaScript 侧。
以下是一些关于你应该使用哪种测试技术的经验。
:::tip TLDR
如果你不想把时间浪费在决定该用哪种方式上，就在 JavaScript 侧添加测试。
:::

#### 优先使用 Rust

1. 测试由 rolldown core 发出的 warning 或 error。
   - [error](https://github.com/rolldown/rolldown/blob/568197a06444809bf44642d88509313ee2735594/crates/rolldown/tests/rolldown/errors/assign_to_import/artifacts.snap?plain=1#L2-L54)
   - [warning](https://github.com/rolldown/rolldown/blob/568197a06444809bf44642d88509313ee2735594/crates/rolldown/tests/rolldown/warnings/eval/artifacts.snap?plain=1#L1-L28)
2. 矩阵测试，假设你想测试一组不同的 [format](https://github.com/rolldown/rolldown/blob/568197a06444809bf44642d88509313ee2735594/crates/rolldown/tests/rolldown/topics/bundler_esm_cjs_tests/4/_config.json?plain=1#L1-L21)，使用 `configVariants` 你只需一个测试就能做到。
3. 与链接算法相关的测试（tree shaking、chunk splitting）。这些测试可能需要大量调试，在 Rust 侧添加测试可以减少编码-调试-编码循环的时间。

#### 优先使用 JavaScript

以上未提到的任何类别，都应放在 JavaScript 侧。
