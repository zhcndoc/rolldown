# Bundler 数据生命周期

## 总结

Rolldown 数据分为两个生命周期层级：**bundler 级**（贯穿所有构建存在）和 **bundle 级**（作用域限定在单次构建）。如果搞错了，会引发真实 bug——例如 HMR 重建之间丢失插件状态、在非增量 watch 构建中不必要地物化 `ScanStageCache`、完整重建时模块元数据混杂。本文定义哪些数据属于哪里，以及原因。

## 背景

最初的设计是让 `RolldownBuild` 在每次 `generate()`/`write()` 调用时都创建一个新的 `Bundler`。这意味着每次构建都是完全独立的会话——没有共享状态，也没有复用。这对于一次性构建没问题，但会让增量构建、HMR 和 watch 模式变得不可能或很脆弱。重构（rolldown/rolldown#6877 到 rolldown/rolldown#6896）引入了 `BundleFactory`/`Bundle` 拆分以及 `PluginDriverFactory`，为每一类数据赋予清晰的所有者和生命周期。

## 两个层级

```
Bundler（长生命周期）
  ├── BundleFactory（创建一次）
  │     ├── PluginDriverFactory
  │     ├── SharedResolver
  │     ├── SharedOptions
  │     ├── SharedFileEmitter
  │     ├── module_infos_for_incremental_build     ─┐
  │     └── transform_dependencies_for_incremental_build ─┤ 通过 Arc 与 PluginDriver 共享
  │
  ├── ScanStageCache（在每次构建时进出 Bundle）
  │     ├── snapshot（NormalizedScanStageOutput）
  │     ├── module_id_to_idx
  │     ├── importers
  │     ├── modules_with_changed_importers
  │     ├── pending_rescans
  │     ├── barrel_state
  │     ├── module_idx_by_abs_path
  │     └── module_idx_by_stable_id
  │
  └── Session（devtools tracing）

Bundle（按构建创建，使用后即消耗）
  ├── PluginDriver（全新实例，由 PluginDriverFactory 创建）
  │     ├── plugins / contexts（全新）
  │     ├── watch_files（全新）
  │     ├── module_infos（Arc → bundler 级）
  │     └── transform_dependencies（Arc → bundler 级）
  ├── warnings
  └── bundle_span
```

### 层级 1：Bundler 级（持久）

在所有构建之间持续存在的数据。它们要么是不可变配置，要么是可增量维护的共享状态。

| 数据                                           | 为什么属于 bundler 级                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SharedOptions`                                | 不可变配置。没有理由每次重建。                                                                                                                                                                                                                                                                           |
| `SharedResolver`                               | 构建成本高；resolver 的内部缓存能提升重建速度。                                                                                                                                                                                                                                                           |
| `SharedFileEmitter`                            | 文件发射状态必须在不同构建之间保持一致（例如已发射资源的去重）。                                                                                                                                                                                                                                          |
| `PluginDriverFactory`                          | 插件定义在构建之间不会变化。变化的只是每次构建的插件 _实例_ 和 _上下文_。                                                                                                                                                                                                                                 |
| `module_infos_for_incremental_build`           | 插件填充的模块元数据（通过 `this.getModuleInfo`）。必须在增量构建之间保留，以便插件可以查询它们未重新处理过的模块。                                                                                                                                                                                       |
| `transform_dependencies_for_incremental_build` | 来自插件的 `addWatchFile()` 依赖。对 HMR 失效至关重要——必须持久保存，这样 HMR 阶段才能知道哪些文件影响哪些模块。                                                                                                                                                                                          |
| `ScanStageCache`                               | 模块图快照、模块索引映射、barrel 状态。使增量构建成为可能——在 `IncrementalBuild` 中，只有变更的模块会被重新扫描，并通过 `ScanStageCache::merge()` 合并。构建期间会临时移动到 `Bundle` 中，然后再移回（见下文“ScanStageCache 所有权”）。 |

**重置规则：** `module_infos` 和 `transform_dependencies` 会在 `FullBuild` 和 `IncrementalFullBuild` 时重置为新的 `Arc::default()`（通过 `BundleFactory::create_bundle`）。它们会在 `IncrementalBuild` 之间保留。

### 层级 2：Bundle 级（每次构建）

每次构建都会新建，构建完成后被丢弃（或被消耗）的数据。

| 数据              | 为什么属于 bundle 级                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PluginDriver`    | 插件 hook 携带每次构建的状态（例如累计的 `watch_files`、每个模块的 transform 上下文）。来自上一次构建的旧 driver 会泄漏状态。                             |
| `watch_files`     | 一次构建触及的文件集合。必须是新的——某个不再被导入的文件不应触发重建。                                                                                     |
| `warnings`        | 诊断信息是每次构建的输出。                                                                                                                                |
| `bundle_span`     | 该次构建专用的 tracing span。                                                                                                                              |
| 插件 `contexts` | `PluginContext` 实例携带每次构建的引用（resolver、file emitter 句柄）。                                                                                   |

### ScanStageCache 所有权

`ScanStageCache` 是 bundler 级数据，但在构建期间，bundle 需要对它进行可变访问。这通过在 `Bundler` 和 `Bundle` 之间临时移动它来实现，然后再移回。由 `with_cached_bundle_experimental` 管理：

```
Bundler.cache（ScanStageCache） ──(move)──> Bundle.cache（临时持有者） ──(build)──> Bundle.cache ──(move)──> Bundler.cache
```

| `ScanStageCache` 字段           | 作用                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `snapshot`                       | 完整的模块图（模块、AST、符号、入口）                                           |
| `module_id_to_idx`               | 模块 ID 到索引的查找                                                                     |
| `importers`                      | 反向依赖图                                                                      |
| `modules_with_changed_importers` | 其 `importers` 记录在部分扫描中发生变更的模块；由 `merge` 清空                  |
| `pending_rescans`                | 工作队列：被中止（并回滚）的部分扫描对应的文件；由下一次部分扫描重试 |
| `barrel_state`                   | barrel 导出优化状态                                                              |
| `module_idx_by_abs_path`         | 供 watcher 使用的基于路径的查找                                                                 |
| `module_idx_by_stable_id`        | 供 HMR 使用的稳定 ID 查找                                                                      |

### 构建失败时的缓存完整性

`ScanStageCache` 必须在 _失败的_ 构建之后仍然完整，而不仅仅是在成功构建后——否则下一次 HMR/增量构建会读取到损坏的缓存并 panic。其不变量是：**在构建之间，`Bundler::cache` 始终是完整的**——`snapshot` 为 `Some`，并且其中的 `symbol_ref_db` 具有真实的作用域信息。

一次构建会通过几个非原子性的“破坏 → 修复”步骤来修改缓存。过去，如果在破坏和修复之间发生早期 `?` 返回，缓存会永久损坏：

| 步骤       | 破坏                                                                                         | 修复                                                                    |
| ---------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 所有权     | `with_cached_bundle` 使用 `mem::take` 取走 `Bundler::cache`，留下 `default()`（`snapshot: None`） | 将 `Bundle::cache` 移回 `Bundler`                                        |
| 作用域     | `create_output` / `make_copy` 克隆 `symbol_ref_db` 时 _不带_ 作用域（性能优化）                 | `merge_immutable_fields_for_cache` 从 link 阶段恢复作用域                 |
| 延迟同步   | `ScanStageCache::update_defer_sync_data` `take`s 走 snapshot                                   | `set_snapshot` 将其放回                                                 |

因此每个修复步骤都会**无条件**执行：

- `with_cached_bundle` 在任何结果下都会把缓存移回——它不会 `?` 提前返回。
- `bundle_up` 在 link 阶段之后、进入可失败的 `generate_bundle` / 文件名检查 / `invalidate_js_side_cache` 步骤之前，立即运行 `merge_immutable_fields_for_cache`。
- `update_defer_sync_data` 会在向外传播错误之前恢复 snapshot。

失败的扫描也绝不能让缓存处于 _不同步_ 状态。任务结果会在到达时就被应用，因此一次被中止的部分扫描，已经把重新扫描的模块在 `module_id_to_idx` 中标记为 `Seen`，并且可能已经变更了已完成任务的 `importers` 边列表，以及为新发现的模块分配了索引；而 snapshot 从未得到这些变化（`merge` 在错误路径上不会执行）。把下一次部分扫描接到那个状态上，会默默地沿用过时的模块代码，并把新的模块索引从其 snapshot 中对应的位置移开。

因此，`ModuleLoader::revert_partial_scan` 会在每次中止时恢复扫描前状态。snapshot 从不被扫描直接修改，所以它充当了干净的主副本，其他一切都从它恢复：

- 现有的 `module_id_to_idx` 条目会在扫描结束时回到扫描前的值（`Seen` -> `Invalidate` -> `Seen`）；只有为新发现模块插入的键会被移除；
- `importers` 边列表会从 snapshot 重新推导（`ScanStageCache::derive_importers_from_snapshot`），因为每条边都是某个模块的已解析导入记录；
- `modules_with_changed_importers` 会被清空，`barrel_state` 会从预先克隆的副本恢复（仅在启用 lazy barrel 时才会克隆）；
- 新分配的（现在已释放的）模块索引中的 `transform_dependencies` 条目会被丢弃，因此之后复用该索引的模块不会继承它们；
- 被扫描的文件会进入 `ScanStageCache::pending_rescans`，这是下一次部分扫描会清空的工作队列，因此它们的错误会持续暴露，直到文件被修复。只有图仍然需要的文件才会入队——即条目文件，或在最新边状态下仍被某些内容导入的文件。一个损坏文件如果它的最后一个导入恰好被这次扫描移除了，就会被丢弃；否则它的重试会导致之后每次构建都失败，而同一棵树的全新构建本应通过。

有两个消费者依赖这个队列的内容：

- `HmrStage::compute_hmr_update` 会在计算客户端边界之前，把待处理文件折叠进它的 stale 和 changed 集合，因此一次被失败扫描回滚的编辑，在重试成功后会进入客户端的补丁（不仅仅是服务端图）；
- 错误增强（`trace_import_chain_from_modules`）会在 revert 之前运行，此时失败扫描的模块仍存在于 `module_id_to_idx` 和活动边列表中。

因此得到的不变量是：**在构建之间，缓存要么是空的
（`snapshot` 为 `None`：全新 bundler，或一次失败的全量扫描已将其重置），要么就是一个任何部分扫描都可以继续构建的有效图。** `Bundler::incremental_bundle` 仅凭这个属性（`has_snapshot`）来决定扫描模式，其他消费者无需再推理失败构建。

**为什么还要保留失败构建的缓存？** 提交一个 _破损_ 的缓存比直接丢弃它更糟：空的 snapshot 会让下一次 `get_snapshot()` panic，而破损的作用域会让下一次 link 时 `oxc_semantic` 数组越界。一个完整但略微过时的缓存是可恢复的；损坏的则不行。恢复路径是 `BundleMode` 的 `IncrementalFullBuild`（见下表）——它会重新扫描所有内容，但仍依赖缓存结构本身是有效的，才能合并进去。

**存在不等于新鲜。** 恢复 snapshot 只能保证它是 _存在_ 且 _结构有效_ 的——不能保证每个字段都是最新的。`defer_sync_scan_data`（按模块进行副作用重新分析）故意采用 **best-effort**：无法重新分析的模块会被跳过——保留其先前的 `side_effects`——其错误会被收集，剩余模块仍会继续同步。因此，失败的构建可能会让某个模块保留过时的 `side_effects`。这只有在 `side_effects` 是一个独立的、没有跨模块不变量的按模块字段时才是安全的：过时的值仍然是一个有效值，而下一次成功构建会重新同步它。对于破损窗口修复的一般规则是：恢复一个 _结构一致_ 的缓存；当在部分失败下无法保证内容新鲜度时，把过时性限制在那些即使过时也安全的字段中。

## BundleMode

`BundleMode` 使三个增量状态显式化。在这个枚举之前，代码使用 `ScanMode` + `is_incremental_build_enabled` 的组合，这些组合含义模糊，且容易出错。

```rust
pub enum BundleMode {
    FullBuild,              // 为本次构建创建全新的 ScanStageCache；随后丢弃。
    IncrementalFullBuild,   // 为本次构建创建全新的 ScanStageCache；保留以供后续增量构建使用。
    IncrementalBuild,       // 复用现有的 ScanStageCache；仅重新扫描发生变化的文件。
}
```

| 模式                   | `ScanStageCache` 输入 | `ScanStageCache` 输出 | 共享状态重置 | 使用场景                                                                        |
| ---------------------- | ------------------- | -------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `FullBuild`            | 无                  | 丢弃                 | 是                | 一次性构建、非增量 watch                                                           |
| `IncrementalFullBuild` | 全新                | 保存                 | 是                | `incremental: true` 的首次构建，或失败构建后的 dev 模式恢复                         |
| `IncrementalBuild`     | 现有                | 更新                 | 否                | 后续的 `incremental: true` 构建                                                     |

**关键区别：** `IncrementalFullBuild` 与 `FullBuild` —— 两者都会执行完整扫描，但 `IncrementalFullBuild` 会保留生成的 `ScanStageCache`，以供后续增量构建使用。若没有这个区分，`incremental: false` 的 watch 模式在每次重建时都会默默承担物化并保留扫描阶段状态的成本，却得不到任何收益。

## PluginDriverFactory

`PluginDriverFactory` 是让打包器层级 / bundle 层级拆分能够用于插件的关键。它持有插件的 _definitions_（打包器层级），并在每次构建时生成新的 `PluginDriver` _instances_（bundle 层级）。

这个工厂还持有 `module_infos` 和 `transform_dependencies` 的 `Arc`。当它创建 `PluginDriver` 时，会把这些 `Arc` 克隆到驱动中。这意味着：

- 每个 bundle 的 `PluginDriver` 都会写入**同一个**底层 `module_infos` 映射（用于增量构建）
- 在完整构建时，工厂会在创建驱动之前把自己的 `Arc` 替换为新的实例，因此之前的数据会被丢弃

这就是修复 `this.getModuleInfo()` 在第二次 HMR 重建时返回空值的原因——旧代码会创建完全独立的插件上下文，与上一次构建的模块信息没有任何关联。

## 通过这种拆分发现的 Bug

1. **HMR 重建期间 `module_infos` 丢失**（rolldown/rolldown#6891）—— 每次构建都会创建完全独立的插件上下文。在第二次构建时，`transform` 中的 `this.getModuleInfo()` 返回空值，因为新上下文的模块信息映射是空的。修复：`module_infos` 变为打包器层级，并通过 `PluginDriverFactory` 以 `Arc` 共享。

2. **首次增量构建没有 `ScanStageCache`**（rolldown/rolldown#6894）—— 使用 `incremental: true` 时，第一次 `generate()` 调用了 `create_bundle()`（即 `FullBuild`），而不是 `IncrementalFullBuild`，因此没有保留 `ScanStageCache`。第二次调用 `incremental_generate()` 时会 panic，因为它预期存在一个 `ScanStageCache`。修复：`BundleMode` 将这一差异显式化。

3. **在 `IncrementalFullBuild` 调用之间混入了模块信息**（rolldown/rolldown#6894）—— 如果变更的文件过多，dev 模式会触发第二次 `IncrementalFullBuild`，但代码只在 `create_bundle()`（针对 `FullBuild`）中清空了 `module_infos`，而没有在增量 bundle 创建路径中清空。两个构建的元数据因此混在了一起。修复：使用统一的 `create_bundle(BundleMode, Option<ScanStageCache>)` 方法来处理所有模式。

4. **非增量 watch 模式中不必要的 `ScanStageCache` 物化**（rolldown/rolldown#6894）—— 早期版本即使在 watch 模式以 `incremental: false` 运行时也会物化扫描阶段状态，使得这个拆分问题暴露出来。`BundleMode` 将这一点显式化。当前代码在禁用增量构建时会重置 `ScanStageCache`（参见 `Bundle::scan_modules()`），因此它不会再在非增量构建之间被保留。

## 未解决的问题

- `Bundler::close()` 仍然存在 `closed` 标志，但 `closeBundle` 是每次构建的关注点。它应该移动到 `BundleHandle`——见 [rust-bundler.md](../rust-bundler/implementation.md)。

## 相关

- [rust-bundler](../rust-bundler/implementation.md) — Bundler 结构体和构建生命周期
- [rust-classic-bundler](../rust-classic-bundler/implementation.md) — Rollup API 兼容包装器（无共享状态）
- rolldown/rolldown#6877 — 引入 Build 抽象
- rolldown/rolldown#6883 — Bundler 的 BuildFactory
- rolldown/rolldown#6886 — Build/BuildFactory 重命名为 Bundle/BundleFactory
- rolldown/rolldown#6891 — PluginDriverFactory
- rolldown/rolldown#6894 — BundleMode 枚举
