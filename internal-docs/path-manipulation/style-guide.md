# 路径操作

Rolldown 模块 / 解析器路径是**已知的 UTF-8**。优先使用 `rolldown_std_utils`，而不是手动编写 sugar_path 链。

实现：`crates/rolldown_std_utils/src/path_ext.rs`。模块 ID 标识： [module-id/implementation.md](../module-id/implementation.md)。

## 使用这些

| Helper                                        | 用途                                    |
| --------------------------------------------- | --------------------------------------- |
| `absolutize_path_buf(path)`                   | 确保拥有的路径是绝对路径                 |
| `relative_path_to_slash(target, base)`        | 返回以 `/` 分隔的相对 `String`          |
| `relative_path_as_js_specifier(target, base)` | 相同，JS 形式：`.` / `./…` / `../…`     |
| `absolute_path_to_relative_slash(path, cwd)`  | 绝对路径 → 相对于 cwd 的斜杠字符串      |
| `path_buf_to_slash(path)`                     | 拥有的 `PathBuf` → 斜杠 `String`        |
| `PathExt::expect_to_slash`                    | 借用的路径 → 斜杠 `String`              |

sugar_path 3：`relative` 返回 `Cow<Path>`（相等时为空）；`normalize` 保留尾部分隔符；默认情况下斜杠转换是严格的。显式的 cwd 参数必须是绝对路径。保留 workspace 特性 `cached_current_dir`。

当目标类型是 `ArcStr` 时，直接传递 `to_slash()`，不要先调用 `into_owned()`；`ArcStr` 会将字符串复制到自己的分配空间中。

## 不要

```rust
target.relative(base).to_slash_lossy().into_owned()  // 已知为 UTF-8 时会丢失信息
path.to_slash().unwrap()                             // 2.x API
target.relative(base).as_path().expect_to_slash()    // 跳过 into_slash 复用
let p: PathBuf = target.relative(base);              // 不再是 PathBuf
path.to_string_lossy().replace('\\', "/")            // 手工编写的策略
```

模块 **ids** 保持原生分隔符；斜杠形式仅用于输出 / 稳定字符串。
