# 确定模块导出类型

## 摘要

`determine_module_exports_kind` 在 `LinkStage` 中较早运行，并决定两个会影响后续所有流程的事项：每个模块最终的 `ExportsKind`（有一个特别注明的例外，见 §“不变量”）以及哪些模块在最终化时需要 `WrapKind::Esm` / `WrapKind::Cjs` 包装器。它是打包器停止“观察”源代码所述内容、开始“决定”每个模块将如何输出的地方。包装决策只取决于 `(importer, importee, ImportKind)` 三元组的“语法”，而不取决于使用方式，因此它们会在符号绑定和树摇之前就确定下来——而这两者都需要知道某个 importee 是被包装的 CJS 还是原始 ESM，才能正确计算重新导出的可见性。

来源：`crates/rolldown/src/stages/link_stage/determine_module_exports_kind.rs`。

相关代码：

- `crates/rolldown/src/stages/link_stage/generate_lazy_export.rs` —— 唯一允许在此步骤之后修改 `exports_kind` 的阶段（见 §“不变量”）。
- `crates/rolldown/src/stages/link_stage/wrapping.rs` —— 消费这里做出的 `WrapKind` 决策。
- `LinkingMetadata::set_wrap_kind` —— 用于写入包装状态的写入器。

## 管道位置

`LinkStage::link()`（在 `mod.rs` 中）的相关前缀大致按以下顺序运行：

```
sort_modules
compute_tla
determine_module_exports_kind   <- this file
determine_safely_merge_cjs_ns
wrap_modules
generate_lazy_export
determine_side_effects
bind_imports_and_exports
create_exports_for_ecma_modules
reference_needed_symbols
include_statements
```

位置至关重要：`wrap_modules` 会使用此处设置的 `WrapKind` 作为根，在图中递归传播包装需求，而 `bind_imports_and_exports` 会读取此处设置的 `exports_kind`，以决定如何通过 CJS 命名空间绑定来传递重新导出。

## 本次传递涉及的状态

`determine_module_exports_kind` 会写入：

- 某些普通模块的 `module.exports_kind`（通过 `addr_of!` 强制转换原地写入——见 §“The unsafe block”）。
- 通过 `LinkingMetadata::set_wrap_kind` 写入 `self.metas[idx].wrap_kind`。**这不是幂等的**——最后一次写入者获胜，因此调用顺序是契约的一部分。

它不会触及符号表、tree-shaking 标志或 chunk graph。

## 提升 + 包装规则

对于每个 `(importer, importee, rec.kind)`：

| `rec.kind`                 | `importee.exports_kind` | 影响                                                                                 |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `Import`                   | `None`（非 lazy）       | 提升为 `Esm`。                                                                       |
| `Import`                   | `Esm` / `CommonJs`      | 无操作。（由 ESM 导入的 CJS 的包装工作由 `wrap_modules` 处理。）                     |
| `Require`                  | `Esm`                   | 标记 importee 为 `WrapKind::Esm`（以满足对 ESM 模块的 `require()`）。                |
| `Require`                  | `CommonJs`              | 标记 importee 为 `WrapKind::Cjs`。                                                   |
| `Require`                  | `None`                  | 标记为 `WrapKind::Cjs`，并将 `exports_kind` 提升为 `CommonJs`。                      |
| `DynamicImport`（split）   | 任意                    | 无操作。代码分割会原生处理动态导入。                                                 |
| `DynamicImport`（no split）| `Esm`                   | 标记为 `WrapKind::Esm`。`import()` 降级为 `require + Promise.resolve(__toESM(...))`。 |
| `DynamicImport`（no split）| `CommonJs`              | 标记为 `WrapKind::Cjs`。                                                             |
| `DynamicImport`（no split）| `None`                  | 标记为 `WrapKind::Cjs`，并提升为 `CommonJs`。                                        |
| `AtImport` / `UrlImport`   | —                       | `unreachable!` — 参见 §“为什么 CSS 导入种类是 `unreachable!`”。                      |
| `NewUrl` / `HotAccept`     | —                       | 无操作（资源引用 / HMR 元数据，不是模块形状信号）。                                   |

在处理完所有导入记录后，当满足以下条件时，importer 自身会被包装为 CJS：

- `importer.exports_kind == CommonJs`，并且
- 它 _不是_ 入口模块，**或** 输出格式是 `Esm`，**或** 输出是 `Iife`/`Umd` 且 importer 触及了 `module`/`exports`。

“是入口 + Esm 输出”这一分支，允许 `module.exports = ...` 在以 CJS 形式输出为 ESM 的场景中继续工作；`Iife`/`Umd` 分支则防止 `module`/`exports` 泄漏到 IIFE 包装器的外层作用域。

> **为什么在 `Import` + `None` 分支中排除“lazy export”：**
> lazy-export 模块是延迟执行的 ESM 外壳；如果在这里提升它们，会提前截断后面运行的专用 lazy-export 处理流程（`generate_lazy_export`），而该流程会进行额外的重构，这些重构会被简单的 `None → Esm` 提升所跳过。

## 不变量（下游阶段的契约）

在此阶段完成后：

1. **非懒加载模块具有其最终的 `exports_kind`。** 每个 `Module::Normal`，只要其 meta **不** 具有 `has_lazy_export()`，就已经被分类——如果剩余的 `ExportsKind::None`，表示“没有任何 JS 导入方触碰过它；把它当作仅有副作用的脚本处理。”
2. **懒导出模块在这里有意不做最终定型。** `generate_lazy_export` 会在后面运行，并且可能将懒模块的 `exports_kind` 改为 `Esm`（`generate_lazy_export.rs:88`, `:287`），甚至为 JSON-lazy 路径将其 `wrap_kind` 修订为 `WrapKind::None`（`:296`）。在未审查该阶段之前，不要扩大不变量 (1) 的范围。
3. **对于每个需要包装的非懒 `(importer, importee)` 对，`metas[importee.idx].wrap_kind` 都已设置。** `wrap_modules` 可能会从那里传递性地传播包装，但它绝不会引入本阶段遗漏的包装。

任何破坏 (1) 或 (3) 的情况，都是这里的 bug，而不是使用方的 bug。

## `addr_of!(*importee).cast_mut()` 技巧

循环体通过迭代器持有 `self.module_table.modules` 的共享借用，同时又希望写入 `importee.exports_kind`。由于 `importee` 是正在遍历的同一个 `Vec` 中的一个元素，这里向借用检查器申请 `&mut` 是徒劳的；通过原始指针进行转换是本地的“逃生舱口”。

安全性论证（源码中也有注释）：

- 在所有符合预期的情况下，`importer` 和 `importee` 都是 _不同_ 的模块（一次导入总是解析到另一个模块）。
- 在自导入的边界情况（`importee == importer`）中，唯一被写入的字段是 `exports_kind`，它与周围 `match` 分支中读取的任何字段都相互独立。因此，这种别名是无害的。
- 没有任何可重入遍历会观察到半写入状态；变更发生在读取 `importee.exports_kind` 之后，而且这次写入不会改变迭代器。

这是一种 _负载关键型 unsafe_。更清晰的替代方案是两遍处理：

1. 遍历模块，收集一个 `Vec<(ModuleIdx, ExportsKind)>`，存放计划中的提升操作。
2. 通过 `module_table.modules[idx].as_normal_mut()` 逐个应用。
3. 重新遍历以设置 `wrap_kind`（或者将第 3 步并入第 1 步的收集中）。

这个重构之前已经合并，后来又因为一个难以复现的回归问题被回滚（#9237）。在该回归问题拥有最小复现之前，这种 unsafe 形式会继续保留。若你修改这段循环，请保持这样一个性质：**只有 `exports_kind` 会被修改**，并且只在一个在写入期间除此之外没有别名的 `&NormalModule` 上修改。

## 为什么 CSS import 类型是 `unreachable!`

`Module::as_normal` 在这个 pass 看到之前，就已经过滤掉了 `Module::External`、`Module::CssModule` 以及任何非 JS 模块变体。CSS 依赖只会通过 `ImportKind::AtImport` / `UrlImport` 到达，而这些来源于 CSS 模块，而不是 JS。因此，这些类型不可能出现在 JS 模块的 `import_records` 中，而这个 panic 是为了防止上游发生误分类。`NewUrl` 和 `HotAccept` _确实_ 会出现在 JS 模块中，但它们不携带任何 exports/wrap 相关的含义，所以它们被明确处理为 no-op。

## 编辑检查清单

在修改此文件时，有一些很容易破坏、值得重新检查的地方：

- **`set_wrap_kind` 调用与 `exports_kind` 变更之间的顺序。** `Require` / `DynamicImport` 分支中的包装决策会在任何提升发生之前读取 `importee.exports_kind`。不要重新排序。
- **CJS 导入者包装规则**（在逐条记录循环之后）。这些条件的合取编码了三种不同的输出格式契约；将其扁平化改写为 `match self.options.format` 形式已经让不止一位审阅者踩过坑。请添加回归测试，而不是盲目重构。
- **不要扩大 `unsafe` 块的范围。** 任何需要对 `NormalModule` 其他字段进行可变访问的操作，都应该通过单独的遍历来完成。
- **不要在这里提升 lazy-export 模块。** 将 `has_lazy_export()` 模块留给 `generate_lazy_export`；过早提升它们会破坏该文件中的 JSON-lazy 和 ESM-default 代码路径。

## 未解决的问题

- `addr_of!` 强制转换是一个已知的瑕疵。移除它的双遍重构已经尝试过两次；两次尝试都遇到了一个无法稳定复现的回归问题（#9237）。在接受该 unsafe 代码块作为永久方案之前，值得再借助一个由模糊测试驱动的测试语料库尝试一次。

## 相关

- [模块执行顺序](../module-execution-order/implementation.md)
