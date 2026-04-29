# 代码风格

我们建议在编写 rolldown 代码时遵循以下指南。它们并不是非常严格的规则，因为我们希望保持灵活性，并且我们理解在某些情况下，其中一些规则可能会适得其反。只需尽可能多地遵循它们即可：

## Rust

### 通用 API 设计

我们倾向于遵循 [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/) 中的建议。它们主要由 Rust 库团队根据在构建 Rust 标准库和 Rust 生态系统中其他 crate 的经验编写。

我们理解有些情况下这些规则并不适用，但你应该尽可能遵循它们。

### 规则：文件名应与该文件中的主要结构体、trait、枚举或函数名称相匹配

示例：

- 如果某个文件实现了一个结构体，例如 `Resolver` 和 `ResolverConfig`，那么该文件应命名为 `resolver.rs`，因为 `Resolver` 是该文件中实现的主要结构体。
- 如果某个文件只包含一个结构体，例如 `ResolverConfig`，那么该文件应命名为 `resolver_config.rs`，而不是 `config.rs`。
- 如果某个结构体复杂到需要自己的文件夹，仍然优先将该结构体放入一个与结构体同名的独立文件中。例如，将 `bundler.rs` 移动到 `bundler/bundler.rs`，而不是 `bundler/mod.rs`。

动机：

当你理解 rolldown 的代码库时，你通常会从结构体、函数和 trait 的角度来思考。如果文件名与结构体名称直接对应，就会更容易快速定位相关代码。这在像 rolldown 这样的大型代码库中尤其有帮助，因为你可能会有许多文件和模块。

## 杂项

### 添加测试

一般来说，我们有两个环境用于运行不同目的的测试。更多信息请参见 [Testing](./testing.md)。

我们要求你应首先考虑在 Rust 端添加测试，因为

- 它在不考虑 Rust 和 JavaScript 之间桥接的情况下，提供了更好的调试支持。
- 由于无需编译绑定 crate 并运行 Node.js，它具有更快的开发周期。

你可以基于以下原因考虑在 Node.js 中添加测试：

- 该测试是关于 JavaScript API 行为的。
- 该测试是关于 `rolldown` 包本身的行为的。
- 端到端测试。
