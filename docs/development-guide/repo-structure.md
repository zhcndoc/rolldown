# 仓库结构

本文档概述了仓库的结构以及每个目录的用途。

# `/crates`

我们将所有 Rust crates 存放在这个目录中。

- `/bench` 项目 Rust 侧的基准测试程序。
- `/rolldown` rolldown 打包器的核心逻辑。
- `/rolldown_binding` 将核心逻辑绑定到 Node.js 的胶水代码。

# `/packages`

我们将所有 Node.js 包存放在这个目录中。

- `/rolldown` 该项目的 Node.js 包。
- `/bench` 项目 Node.js 侧的基准测试程序。
- `/rollup-tests` 用于在 rolldown 中运行 rollup 测试的适配器。
- `/vite-tests` 用于在本地 rolldown 中运行 rolldown-vite 仓库测试的脚本。

# `/examples`

该目录包含在 Node.js 中针对各种场景使用 `rolldown` 的示例。

# `/scripts`

该目录包含用于自动化项目各类任务的脚本。

# `/web`

该目录包含一些与项目相关的网站。

- `/docs` 项目的文档。
