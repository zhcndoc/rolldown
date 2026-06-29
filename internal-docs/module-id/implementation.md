# 模块 ID

## 概述

模块 ID 是整个打包器的主键——模块图、缓存、插件 API、HMR、监听文件都依赖它。在 Rolldown 中，它们基于字符串（`ArcStr`），因此路径是否相同取决于字符串是否完全相等。本文档描述了路径如何在系统中流转、哪里可能发生不匹配，以及 Rollup 如何处理同样的问题。

## Rollup 的做法

Rollup 采用的是**单一归一化点**设计。`resolveId` 钩子（以及通过 `path.resolve()` 的默认实现）是唯一进行路径归一化的地方。解析后的路径会成为到处使用的模块 ID——模块图、缓存、`graph.watchFiles`、插件钩子等。

**模块 ID 使用原生操作系统分隔符。** 在 Windows 上，模块 ID 包含 `\` 分隔符（例如 `D:\project\src\main.js`）。`path.resolve()` 输出会按原样存储——不会对模块 ID 应用分隔符归一化。（[已在 Windows CI 上验证](https://github.com/hyf0-agent/rollup-win-test/actions/runs/22542074808)）

Rollup 确实有一个 `normalize` 函数，用于将 `\` 转换为 `/`：

```javascript
// rollup/src/utils/path.ts
const BACKSLASH_REGEX = /\\/g;
export function normalize(path) {
  return path.replace(BACKSLASH_REGEX, '/');
}
```

不过，这**仅用于下游/输出场景**，而不在核心模块 ID 管道中使用：

- `pluginFilter.ts` — 在匹配包含/排除模式之前规范化 ID
- `Chunk.ts` — 生成 preserveModules 块文件名
- `renderChunks.ts` — 源映射源路径
- `relativeId.ts` — 计算相对导入路径
- `MetaProperty.ts` — import.meta 相对路径

像 `addWatchFile()` 这样的插件 API **不会进行规范化**——它们信任调用方提供一个与模块 ID 约定一致的路径。

## Rolldown 目前如何处理

### ModuleId

`ModuleId` 由 `ArcStr` 支持，并在构造时被归类为三种类型之一，因此路径操作只会在那些实际上是路径的 ID 上运行：

```rust
// rolldown_common/src/types/module_id.rs
pub struct ModuleId { repr: Repr }

enum Repr {
  Path(ArcStr),    // absolute filesystem path — path operations are meaningful
  Virtual(ArcStr), // virtual id, prefixed with `\0` (Rollup convention)
  Bare(ArcStr),    // bare specifier (`react`), URL, data URI, relative specifier, …
}
```

等价性、排序和哈希仍然只是针对 `as_str()` 的原始字符串比较（会忽略种类判别），因此路径身份仍然依赖于精确的字符串相等性，而且 `ModuleId` 的哈希与其字符串完全相同——对 `&str` 到 `HashMap<ModuleId, _>` 的查找仍然可用。该分类只会限制 _路径_ 逻辑：`as_path()` 仅在 `Path` 种类下返回 `Some(&Path)`，而像 `is_in_node_modules()` / `representative_name()` 这样的辅助函数也是建立在此之上，所以虚拟 id 和裸说明符不再通过 `Path` / `to_string_lossy` 进行往返转换。

解析器（`oxc_resolver`）返回一个 `PathBuf`。Rolldown 通过 `full_path().to_str()` 将其转换为字符串，并按原样存储——不会做分隔符归一化。在 Windows 上，模块 ID 包含原生的 `\` 分隔符，这类 id 会被归类为 `Path`。

### 与 Rollup 的对比

|                      | Rollup                           | Rolldown                         |
| -------------------- | -------------------------------- | -------------------------------- |
| Windows 上的模块 ID | `C:\Users\project\src\file.js`   | `C:\Users\project\src\file.js`   |
| Linux 上的模块 ID   | `/home/user/project/src/file.js` | `/home/user/project/src/file.js` |
| 归一化        | 无（使用原生操作系统分隔符）      | 无（使用原生操作系统分隔符）      |
| 是否依赖平台？  | 前缀 **和** 分隔符        | 前缀 **和** 分隔符        |

Rollup 和 Rolldown 在这里是**一致**的——两者都会按原样存储 `path.resolve()` / 解析器输出，并使用原生操作系统分隔符。Rollup 中的 `normalize` 函数只会应用于下游/输出场景（见上文），不会作用于模块 ID。

注意：某些插件在对模块 ID 进行字符串匹配时，可能会在内部假设使用 `/` 分隔符。这是插件层面的关注点，而不是 Rollup 与 Rolldown 之间的差异。

### StableModuleId

`StableModuleId` 是 `ModuleId` 的一个相对于 cwd、并以正斜杠规范化的版本。用于跨机器稳定性（源映射、HMR 客户端侧引用）。

```rust
// Absolute → relative from cwd, forward slashes
// "\0foo" → "\\0foo" (virtual module escape)
// "fs" → "fs" (non-path specifiers unchanged)
```

### 路径标识重要的地方

| 子系统                  | 关键类型                  | 规范化                        | 风险                                              |
| -------------------------- | ------------------------- | ------------------------------------ | ------------------------------------------------- |
| 模块图查找        | `ModuleId` (ArcStr)       | 无                                 | 解析器输出必须保持一致                |
| 扫描阶段缓存           | `ModuleId` → `VisitState` | 无                                 | 同一路径以不同方式解析 = 重复模块 |
| `module_idx_by_abs_path`   | `ArcStr`                  | 插入时进行 `to_slash()`            | HMR 变更文件路径必须匹配                 |
| 插件 `get_module_info()` | `&str` 查找             | 无                                 | 插件必须使用精确的模块 ID                   |
| 插件 `add_watch_file()`  | `ArcStr` 到 `FxDashSet` 中 | 无                                 | 监听集使用原始字符串                        |
| 监听文件比较      | `ArcStr` 相等               | `#[cfg(windows)]` 反斜杠回退 | 脆弱                                           |
| 解析器包缓存     | `PathBuf`                 | 路径缓冲区组件比较         | 处理分隔符差异                     |

### 现有的规范化工具

- `PathExt::expect_to_slash()` — 将 `\` 转换为 `/`（仅在非 Unix 平台上）。用于 `StableModuleId`、HMR、源映射。
- `SugarPath::relative()` — 生成相对路径。用于 `StableModuleId`。
- `stabilize_id()` — 绝对路径 → 基于当前工作目录的相对路径，并使用正斜杠。旧版工具，现功能已并入 `StableModuleId`。

## 核心问题

模块 ID 是字符串，而系统的不同部分会以不同方式生成路径字符串：

1. **解析器** 生成绝对路径（使用平台原生分隔符）
2. **插件** 通过 `addWatchFile()` 提供路径（不保证已规范化）
3. **notify crate** 报告带有操作系统原生路径的文件变更事件
4. **HMR client** 发送稳定的 ID（相对路径，使用正斜杠）

如果这四者中任意两个对同一个文件的表示方式不一致，查找就会悄无声息地失败——模块找不到、缓存未命中、监视文件不匹配、HMR 更新被丢弃。

目前之所以大体可用，是因为解析器对自身输出保持一致，而且大多数查找在两侧都使用了解析器的输出。真正脆弱的地方在 **边界**——也就是外部生成的路径（notify 事件、插件输入、HMR client）被拿去与解析器生成的模块 ID 比较的时候。

## `PathBuf` 比较行为

`Path`/`PathBuf` 比较是通过比较 [组件](https://doc.rust-lang.org/std/path/struct.Components.html) 来进行的，而不是比较原始字节。根据 [官方文档](https://doc.rust-lang.org/std/path/index.html)：规范化在迭代、检查和比较时会忽略“重复的分隔符、非开头的 `.` 组件，以及结尾的分隔符”。在 Windows 上，`/` 和 `\` 都被视为分隔符。

| 场景                               | `str` 相等 | `PathBuf` 相等           |
| -------------------------------------- | -------- | ---------------------- |
| `/foo/bar` 与 `/foo/bar/`              | false    | **true**               |
| `/foo//bar` 与 `/foo/bar`              | false    | **true**               |
| `/foo/./bar` 与 `/foo/bar`             | false    | **true**               |
| `/foo/../foo/bar` 与 `/foo/bar`        | false    | false                  |
| （Windows）`C:\foo\bar` 与 `C:/foo/bar` | false    | **true**               |
| `/foo/Bar` 与 `/foo/bar`               | false    | false（区分大小写） |

哈希与相等性一致——可安全用于 `HashSet`/`HashMap`。

**限制：** `PathBuf` 不会解析 `..` 或符号链接。对此你需要 `fs::canonicalize()`，但它也有自己的缺点（会解析符号链接，且对不存在的路径可能失败）。

## 未解决的问题

- **模块 ID 是否应在创建时标准化？** Rollup 不会对模块 ID 分隔符进行 **标准化** —— 在 Windows 上，插件会在模块 ID 中看到 `\`。Rolldown 目前与此行为一致。Rolldown 是否应当有所不同，在 `/` 中将其标准化为 `ModuleId::new()`，以便实现更简单的跨平台逻辑？这会改变 Windows 上可观察到的模块 ID，但可能会简化插件过滤匹配和内部比较。

- **监听文件集合是否应使用 `PathBuf` 而不是 `ArcStr`？** `PathBuf` 可以处理末尾斜杠、双斜杠、`.` 段以及 Windows 分隔符。缺点是会失去廉价的 `ArcStr` 克隆和 `&str` 查找。有关监听模式的专门讨论，请参见 [watch-mode.md](../watch-mode/implementation.md)。

- **`..` 段和符号链接** —— 无论是 `PathBuf` 比较还是字符串比较，都无法处理这些情况。实际上，`..` 不应出现在解析器输出中（解析器会进行规范化），而符号链接是一个少见的边缘情况。Rolldown 是否应在这里作出任何保证？

## 相关内容

- [watch-mode](../watch-mode/implementation.md) — 监听文件集合路径匹配
- `crates/rolldown_common/src/types/module_id.rs` — `ModuleId` 类型
- `crates/rolldown_common/src/types/stable_module_id.rs` — `StableModuleId` 类型
- `crates/rolldown_std_utils/src/path_ext.rs` — `expect_to_slash()` 工具
