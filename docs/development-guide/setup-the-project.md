<script setup lang="ts">
  import { data } from '../data-loading/node-version.data.js'
</script>

# 设置项目

## 前置条件

构建和运行 Rolldown 只需要少量工具。你需要：

- 通过 [rustup](https://www.rust-lang.org/tools/install) 安装 Rust
- 安装 `just`

你可以通过运行以下命令快速安装 `just`，或者按照官方 [指南](https://github.com/casey/just?tab=readme-ov-file#installation) 进行安装：

::: code-group

```sh [Npm]
npm install --global just-install
```

```sh [Pnpm]
pnpm --global add just-install
```

```sh [Yarn]
yarn global add just-install
```

```sh [Homebrew]
brew install just
```

```sh [Cargo]
cargo install just
```

:::

- 安装 `cmake`

你可以按照官方 [下载](https://cmake.org/download/) 页面进行安装。

- 安装 Node.js >= {{ data.nodeVersion }} / 21.2.0

## `just setup`

在你第一次检出仓库后，你只需要在仓库根目录运行 `just setup`。

如果最后看到 `✅✅✅ Setup complete!`，这意味着你已经拥有构建和运行 rolldown 所需的一切。

你可以运行 `just roll` 来验证一切是否正常工作。

::: tip

- `just roll` 可能需要一段时间才能运行，因为它会从零开始构建 rolldown 并运行所有测试。
- 如果你想了解 `just setup` 的内部工作原理，可以查看仓库根目录中的 [`justfile`](https://github.com/rolldown/rolldown/blob/main/justfile)。

:::

现在，你可以前往下一章 [构建与运行](./building-and-running.md)。如果你想深入了解设置过程，请继续阅读。

## 深入了解

本节将更详细地介绍构建和运行 Rolldown 所需安装的工具与依赖项。

### 设置 Rust

Rolldown 基于 Rust 构建，并且要求你的环境中存在 `rustup` 和 `cargo`。你可以[从官方网站安装 Rust](https://www.rust-lang.org/tools/install)。

### 设置 Node.js

Rolldown 是一个使用 [NAPI-RS](https://napi.rs/) 构建并发布到 npm 注册表的 npm 包，因此需要 Node.js 和 pnpm（用于依赖管理）。

我们建议使用版本管理器安装 Node.js，例如 [nvm](https://github.com/nvm-sh/nvm) 或 [fnm](https://github.com/Schniz/fnm)。请确保安装并使用 Node.js 版本 {{ data.nodeVersion }}+，这是本项目的最低要求。如果你已经在使用自己选择的 Node.js 版本管理器，并且 Node.js 版本满足要求，则可以跳过这一步。

#### 设置 pnpm

我们建议通过 [corepack](https://nodejs.org/api/corepack.html) 启用 pnpm，这样在本项目中工作时就可以自动使用正确版本的 pnpm：

```shell
corepack enable
```

以验证一切是否已正确设置。
