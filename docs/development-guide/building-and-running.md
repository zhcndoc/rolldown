# 构建和运行

在继续之前，请确保你已经完成了 [设置流程](./setup-the-project.md)。

## 什么是 `just`？

`just` 是 `rolldown` 仓库的命令运行器。它可以用一条命令构建、测试和检查项目。

### 用法

你只需运行 `just` 命令，就可以获取可用命令列表。

### 重要命令

- `just roll` - 从头构建 rolldown，并运行所有测试和检查。
- `just test` - 运行所有测试。
- `just lint` - 格式化并检查代码库。
- `just fix` - 修复格式化和检查问题。
- `just build` - 构建 `rolldown` node 包（以及 `@rolldown/pluginutils` node 包）。
- `just run` - 使用 node 运行 `rolldown` cli。

> 大多数命令都会同时运行 Rust 和 Node.js 脚本。若只想针对其中之一，可在 just 命令后附加 `-rust` 或 `-node`。例如，`just lint-rust` 或 `just test-node`。

::: tip
`just roll` 会是你开发工作流中最常用的命令。它会帮你不费脑筋地检查你所做的任何修改是否都能正常工作。

它能帮助你在本地捕获错误，而不是把更改推送到 GitHub 后再等待 CI。

- `just roll-rust` - 仅运行 Rust 检查。
- `just roll-node` - 仅运行 Node.js 检查。
- `just roll-repo` - 检查与代码无关的问题，例如文件名。

:::

## 构建

Rolldown 基于 Rust 和 Node.js 构建，因此构建过程包括构建 Rust crate、Node.js 包，以及将它们连接起来的胶水层。胶水层本身也是一个 Node.js 包，但构建它也会触发 Rust crate 的构建。

幸运的是，NAPI-RS 已经封装了构建胶水层的过程，我们不需要关心细节。

### `rolldown`

要构建 `rolldown` 包，有两个命令：

- `just build`/`just build-rolldown`
- `just build-rolldown-release`（**如果运行基准测试，这一点很重要**）

它们会自动构建 Rust crate 和 Node.js 包。因此，无论你做了什么修改，都可以随时运行这些命令来构建最新的 `rolldown` 包。

### WASI

Rolldown 通过将 WASI 视为一个特殊平台来支持它。因此，我们仍然使用 `rolldown` 包来分发 Rolldown 的 WASI 版本。

要构建 WASI 版本，你可以运行以下命令：

- `just build-browser`
- `just build-browser-release`（**如果运行基准测试，这一点很重要**）

构建 WASI 版本会移除 Rolldown 的原生版本。我们有意这样设计本地构建流程，也就是说，你要么构建原生版本，要么构建 WASI 版本。虽然 NAPI-RS 支持混合构建，但你不能把它们混在一起。

## 运行

你可以使用 `just run` 通过 node 运行 `rolldown` cli。

`rolldown` 包会通过 pnpm workspace 自动链接到 `node_modules`，因此你可以使用以下命令运行它：

```sh
pnpm rolldown
```

`just run` 只是上面命令的别名。

::: warning
在运行之前，请确保你已经使用 `just build` 构建了 `rolldown` 包。
:::
