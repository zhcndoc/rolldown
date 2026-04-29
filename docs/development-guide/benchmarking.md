# 基准测试

## 设置

在运行基准测试之前，请使用以下命令设置必要的测试环境：

```shell
# 在项目根目录中
just setup-bench
```

## 在 Rust 中进行基准测试

`bench-rust` 会自动构建 Rust 代码，因此你无需手动构建。

```shell
# 在项目根目录中
just bench-rust
```

## 在 Node.js 中进行基准测试

请确保以 release 模式构建 Node.js 绑定：

```shell
just build-rolldown-release
```

然后运行

```sh
just bench-node
```
