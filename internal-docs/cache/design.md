# 缓存 — 设计与开放问题

> 缓存机制——清单、`ScanStageCache`、模块标识模型、合并路径：见 [implementation.md](./implementation.md)。

## 概要

Rolldown 有几种不同的缓存机制。架构上最核心的是 **`ScanStageCache`** —— 它是 bundler 级别对已解析模块图的快照，使增量构建和 HMR 成为可能。其他缓存包括构建内记忆化、插件临时状态，以及一个 JS 侧存储。

本文先列出所有缓存，然后详细说明 `ScanStageCache`：它的数据、其所依赖的模块标识模型（`ModuleId` / `ModuleIdx` / `module_id_to_idx`）、`ScanStageCache::merge` 如何将部分扫描拼接进快照，以及完整的读写方列表。

所有文件/行引用都基于撰写本文时的工作树，后续可能会变动；请将其视为起点。

## 构建失败时的缓存完整性

一次构建会通过若干非原子的“撕裂 → 修复”步骤修改 `ScanStageCache`；在撕裂与修复之间若过早 `?` 返回，可能会让缓存对下一次构建而言处于损坏状态。该不变量、三个被撕裂的窗口（所有权 / 作用域 / defer-sync），以及“无条件修复”规则，都记录在 [bundler-data-lifecycle.md](../bundler-data-lifecycle/implementation.md)（“构建失败时的缓存完整性”）中。三个修复位置——`with_cached_bundle`、`bundle_up` 中 `merge_immutable_fields_for_cache` 的顺序，以及 `update_defer_sync_data`——都引用了该小节。

## 未解决的问题

- `merge` 中 `module_id_to_idx[new_module.id()]` 的索引在键缺失时会 panic，并且只会在内部不一致时触发；`Module::idx()` 会直接给出相同的值，而不需要可能失败的查找。是否切换是一个跟踪中的后续事项（需要确认没有调用方把一个 `.idx` 不是由 loader 分配的 `Module` 传给 `merge`）。
- `merge` 是一个涉及多个字段的大型变更，循环中没有中途 `?`，但如果在 `merge` 过程中间 panic（上面两个触发点）会导致快照仍然存在，但内部不一致。恢复“存在性”并不能保证“一致性”。

## 相关

- [implementation.md](./implementation.md) — 缓存实现（清单、`ScanStageCache`、标识模型）
- [bundler-data-lifecycle](../bundler-data-lifecycle/implementation.md) — bundler 级与 bundle 级数据、`BundleMode`、构建失败时的缓存完整性。
- [module-id](../module-id/implementation.md) — `ModuleId` 设计。
- [rust-bundler](../rust-bundler/implementation.md) — `Bundler` 结构体与构建生命周期。
- [watch-mode](../watch-mode/implementation.md) — watch 模式，驱动部分扫描。
