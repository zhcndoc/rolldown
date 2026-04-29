# 跟踪/日志记录

Rolldown 的代码库中有很多 [`tracing::debug!`]（或 `tracing::trace!`）调用，它们会在很多地方输出日志信息。这些信息非常有助于至少缩小 bug 的位置范围，即使不能完全定位，也能帮助你理解编译器为什么会做某些特定的事情。

[`tracing::debug!`]: https://docs.rs/tracing/0.1/tracing/macro.debug.html

要查看日志，你需要将 `RD_LOG` 环境变量设置为你的日志过滤器。日志过滤器的完整语法可以在 [tracing-subscriber 的 rustdoc](https://docs.rs/tracing-subscriber/0.2.24/tracing_subscriber/filter/struct.EnvFilter.html#directives) 中找到。

## 用法

```
RD_LOG=debug [执行 rolldown]
RD_LOG=debug RD_LOG_OUTPUT=chrome-json [执行 rolldown]
```

## 添加日志

在你的 PR 中添加 `tracing::debug!` 或 `tracing::trace!` 调用是可以的。不过，为了避免日志噪音，你应该谨慎选择使用 `tracing::debug!` 还是 `tracing::trace!`。

有一些规则可以帮助你选择正确的日志级别：

- 如果你不知道该选哪个级别，就使用 `tracing::trace!`。
- 如果这条日志在打包过程中只会打印一次，使用 `tracing::debug!`。
- 如果这条日志在打包过程中只会打印一次，但内容大小与输入规模有关，使用 `tracing::trace!`。
- 如果这条日志在打包过程中会打印多次但次数有限，使用 `tracing::debug!`。
- 如果这条日志会因为输入规模而打印多次，使用 `tracing::trace!`。

这些规则也适用于 `#[tracing::instrument]` 属性。

- 如果函数在打包过程中只会被调用一次，使用 `#[tracing::instrument(level = "debug", skip_all)]`。
- 如果函数会因为输入规模而被调用多次，使用 `#[tracing::instrument(level = "trace", skip_all]`。

::: info
应该跟踪哪些信息可能带有主观性，因此审阅者会决定是否允许你保留这些 tracing 语句，或者要求你在合并前将它们移除。
:::

## 函数级过滤器

rolldown 中的许多函数都标注了

```
#[instrument(level = "debug", skip(self))]
fn foo(&self, bar: Type) {}

#[instrument(level = "debug", skip_all)]
fn baz(&self, bar: Type) {}
```

这使你可以使用

```
RUSTC_LOG=[foo]
```

一次完成以下操作

- 记录所有对 `foo` 的函数调用
- 记录参数（除了 `skip` 列表中的那些）
- 记录直到函数返回为止的所有日志（来自编译器其他任何地方）

注意事项：

我们通常建议使用 `skip_all`，除非你有充分理由需要记录参数。

## 跟踪模块解析

Rolldown 使用 [oxc-resolver](https://github.com/oxc-project/oxc-resolver)，它会暴露用于调试目的的跟踪信息。

```bash
RD_LOG='oxc_resolver' rolldown
```

这会输出 `oxc_resolver::resolve` 函数的跟踪信息，例如：

```
2024-06-11T07:12:20.003537Z DEBUG oxc_resolver: options: ResolveOptions { ... }, path: "...", specifier: "...", ret: "..."
    at /path/to/oxc_resolver-1.8.1/src/lib.rs:212
    in oxc_resolver::resolve with path: "...", specifier: "..."
```

输入值是 `options`、`path` 和 `specifier`，返回值是 `ret`。
