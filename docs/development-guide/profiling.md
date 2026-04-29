# 性能分析

## CPU 性能分析（samply）

### 设置

首先，你需要安装 [`samply`](https://github.com/mstange/samply)。你可以使用以下命令安装：

```bash
cargo binstall samply
```

::: warning

Samply 在 macOS 上效果不佳。我们建议改用 Xcode Instruments。

:::

### 构建

要使用 `samply` 所需的信息构建 Rolldown，你需要使用以下命令构建：

```shell
just build-rolldown-profile
```

### 性能分析

构建完成后，你可以使用以下命令运行 Rolldown 以分析 CPU 使用情况：

```shell
samply record node ./path/to/script-rolldown-is-used.js
```

如果你也想分析 JavaScript 部分，可以向 Node 传递 [所需的标志](https://github.com/nodejs/node/pull/58010)：

```shell
samply record node --perf-prof --perf-basic-prof --perf-prof-unwinding-info --interpreted-frames-native-stack ./path/to/script-rolldown-is-used.js
```

## CPU 性能分析（Xcode Instruments）

### 设置

首先，确保你已经安装了 Xcode。

### 构建

要使用 Xcode Instruments 所需的信息构建 Rolldown，你需要使用以下命令构建：

```shell
just build-rolldown-profile
```

### 性能分析

构建完成后，你可以使用以下命令运行 Rolldown 以分析 CPU 使用情况：

```shell
xctrace record --template "Time Profile" --output . --launch -- node ./path/to/script-rolldown-is-used.js
```

然后会打印输出文件路径。你可以使用以下命令打开该文件：

```shell
open ./Launch_node_yyyy-mm-dd_hh.mm.ss_hash.trace
```

## 内存性能分析

要分析内存使用情况，你可以使用 [`heaptrack`](https://github.com/KDE/heaptrack)。

### 设置

首先，你需要安装 `heaptrack` 和 `heaptrack-gui`。如果你使用的是 Ubuntu，可以使用以下命令安装：

```bash
sudo apt install heaptrack heaptrack-gui
```

::: warning

`heaptrack` 仅支持 Linux。它在 WSL 上运行良好。

:::

### 构建

要使用 `heaptrack` 所需的信息构建 Rolldown，你需要使用以下命令构建：

```shell
just build-rolldown-memory-profile
```

### 性能分析

构建完成后，你可以使用以下命令运行 Rolldown 以分析内存使用情况：

```shell
heaptrack node ./path/to/script-rolldown-is-used.js
```

::: tip 使用 asdf 或其他使用 shim 的版本管理器？

在这种情况下，你可能需要使用 Node 二进制文件的实际路径。例如，如果你使用的是 asdf，可以使用以下命令运行：

```shell
heaptrack $(asdf which node) ./path/to/script-rolldown-is-used.js
```

:::

脚本运行结束后，heaptrack GUI 将自动打开。

![heaptrack-gui screenshot](./heaptrack-gui.png)
