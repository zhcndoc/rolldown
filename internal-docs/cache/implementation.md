# Cache — Implementation

> 缓存完整性契约和开放问题位于 [design.md](./design.md)。

## 摘要

Rolldown 有几种不同的缓存机制。其中架构上最核心的是 **`ScanStageCache`** —— 这是 bundler 级别的已解析模块图快照，使增量构建和 HMR 成为可能。其他缓存包括构建内记忆化、插件临时状态，以及一个 JS 侧存储。

本文先梳理所有缓存，然后详细介绍 `ScanStageCache`：它的数据、所依赖的模块身份模型（`ModuleId` / `ModuleIdx` / `module_id_to_idx`）、`ScanStageCache::merge` 如何将部分扫描结果拼接进快照，以及完整的读取者和写入者列表。

文中的所有文件/行号引用均以写作时的工作区为准，之后可能会变化；请将它们视为起点。

## 缓存清单

按字面上名为 `*Cache` 的类型计数，共有 14 个。按用途分组如下：

### 1. 增量构建缓存

| 类型             | 位置                                              | 存储内容                                                               |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `ScanStageCache` | `crates/rolldown/src/types/scan_stage_cache.rs:20` | 模块图快照 + 模块索引映射。详见本文其余部分。 |

### 2. 跨构建失效状态

这不是结果缓存；它们与 `ScanStageCache` 一起持久化，以便下一次增量构建知道要使哪些内容失效 / 能回答插件查询。

| 数据                     | 位置                                     | 说明                                                                                                   |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `transform_dependencies` | `crates/rolldown_plugin/src/plugin_driver/` | `addWatchFile()` 依赖；模块 → 它依赖的文件。文档见 `bundler-data-lifecycle.md`。                      |
| `module_infos`           | `crates/rolldown_plugin/src/plugin_driver/` | 由插件填充的模块元数据，用于 `this.getModuleInfo`。文档见 `bundler-data-lifecycle.md`。               |

### 3. 构建内记忆化

| 类型                                | 位置                                                                          | 存储内容                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SideEffectCache`（枚举）            | `crates/rolldown/src/stages/link_stage/tree_shaking/determine_side_effects.rs:9` | `None` / `Visited` / `Cache(DeterminedSideEffects)`；在 link 阶段副作用遍历期间使用的临时局部记忆。              |
| `PackageJsonCache`                  | `crates/rolldown_plugin_vite_resolve/src/package_json_cache.rs:9`                | `side_effects_cache: FxDashMap<PathBuf, Arc<PackageJson>>`，`optional_peer_dep_cache: FxDashMap<PathBuf, Arc<…>>`。 |
| `ResolverCaches`                    | `crates/rolldown_plugin_vite_resolve/src/resolver.rs:77`                         | `package_json: PackageJsonCache`，`importer_exists: FxDashSet<String>`。                                          |
| `TsconfigCache`                     | `crates/rolldown_binding/src/transform_cache.rs:12`                              | `resolver: Arc<Resolver>`，`cache: FxDashMap<PathBuf, Arc<TsConfig>>`。NAPI 暴露（`#[napi]`）。                    |
| `RawTransformOptions` 的 `cache` 字段 | `crates/rolldown_common/src/inner_bundler_options/types/transform_options.rs`    | tsconfig → 编译后的 Oxc transform 选项。                                                                          |
| oxc_resolver 内部缓存               | 外部 crate，由 bundler 级别的 `SharedResolver` 持有                               | 文件系统/路径元数据。                                                                                            |

### 4. 插件临时状态（位于 `PluginContext.meta()` 中）

名字带 `*Cache`，但功能上是按构建共享的 map，用于在插件 hook 调用之间传递数据。都位于 `crates/rolldown_plugin_utils/src/`。

| 类型                       | 位置                            | 存储内容                                       |
| -------------------------- | ------------------------------- | ---------------------------------------------- |
| `AssetCache`               | `file_to_url.rs:24`             | `FxDashMap<String, String>`                    |
| `PublicAssetUrlCache`      | `public_file_to_built_url.rs:5` | `FxDashMap<String, String>`                    |
| `CSSEntriesCache`          | `constants.rs:46`               | `FxDashMap<ArcStr, ArcStr>`                    |
| `CSSModuleCache`           | `constants.rs:51`               | `FxDashMap<String, FxHashMap<String, String>>` |
| `CSSChunkCache`            | `constants.rs:82`               | `FxDashMap<ArcStr, String>`                    |
| `RemovedPureCSSFilesCache` | `constants.rs:90`               | `FxDashMap<ArcStr, Arc<OutputChunk>>`          |
| `CSSUrlCache`              | `constants.rs:95`               | `FxDashMap<String, String>`                    |

同一文件中相关但不以 `Cache` 命名的结构还有：`ViteMetadata`、`HTMLProxyResult`、`HTMLProxyMap`、`CSSStyles`、`PureCSSChunks`。

### 5. JS 侧缓存

| 类型                    | 位置                                                                                | 存储内容                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `PluginContextData`     | `packages/rolldown/src/plugin/plugin-context-data.ts:18`                                | `moduleOptionMap`、`resolveOptionsMap`、`loadModulePromiseMap`、`renderedChunkMeta`、`normalizedInputOptions`、`normalizedOutputOptions`。 |
| `InvalidateJsSideCache` | `crates/rolldown_common/src/inner_bundler_options/types/invalidate_js_side_cache.rs:11` | `Arc<InvalidateJsSideCacheFn>` —— 一个 Rust 持有的回调，调用回 JS。                                                                          |
| `FilterExprCache`       | `crates/rolldown_binding/src/options/plugin/binding_plugin_options.rs:218`              | 预编译的插件 hook 过滤表达式（NAPI binding，每个插件一个）。                                                                                 |

`InvalidateJsSideCache` 在 `crates/rolldown_binding/src/utils/normalize_binding_options.rs` 中接线；在 JS 侧
（`packages/rolldown/src/utils/bindingify-input-options.ts`）它绑定到
`PluginContextData.clear`。调用它会清空 JS 侧的 `PluginContextData`。

### 6. watch 模式文件系统缓存

`notify` crate 的 `RecommendedCache` 保存在
`crates/rolldown_fs_watcher/src/` 中的 debouncer 内部，用于跟踪事件防抖所需的文件系统元数据。

---

## `ScanStageCache` —— 增量构建缓存

### 所在位置

`ScanStageCache` 是 **bundler 级别** 数据（跨构建保留）。在一次构建期间，它会临时移动到每次构建对应的 `Bundle` 中，然后再移回去。这个来回移动由
`crates/rolldown/src/bundler/impl_bundler_incremental_build.rs:9` / `:27` 中的 `with_cached_bundle` /
`with_cached_bundle_experimental` 完成。

两层模型（bundler 级别 vs bundle 级别）记录在
[bundler-data-lifecycle.md](../bundler-data-lifecycle/implementation.md) 中；该文档也涵盖了构建失败时的缓存完整性。

### 结构体

`crates/rolldown/src/types/scan_stage_cache.rs:20`：

```rust
pub struct ScanStageCache {
  snapshot: Option<NormalizedScanStageOutput>,
  pub barrel_state: BarrelState,
  pub module_id_to_idx: FxHashMap<ModuleId, VisitState>,
  pub importers: IndexVec<ModuleIdx, Vec<ImporterRecord>>,
  pub user_defined_entry: FxHashSet<ModuleId>,
  pub module_idx_by_abs_path: FxHashMap<ArcStr, ModuleIdx>,
  pub module_idx_by_stable_id: FxHashMap<StableModuleId, ModuleIdx>,
}
```

| 字段                     | 作用                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `snapshot`               | 完整的模块图。`None` 是合法的临时状态；它是 `private`，只能通过下述方法访问。                                      |
| `barrel_state`           | barrel re-export 解析状态（`BarrelState`）。                                                                       |
| `module_id_to_idx`       | `ModuleId` → `ModuleIdx` 的注册/分配器（见“模块身份模型”）。                                                        |
| `importers`              | 反向依赖图：每个模块被哪些模块导入。                                                                                |
| `user_defined_entry`     | 配置的根入口 `ModuleId` 集合。                                                                                      |
| `module_idx_by_abs_path` | 绝对路径 → `ModuleIdx`，供 watcher 使用。路径使用 slash 规范化。                                                     |
| `module_idx_by_stable_id`| `StableModuleId` → `ModuleIdx`，供 HMR 使用。                                                                       |

`module_idx_by_abs_path` 和 `module_idx_by_stable_id` 是**派生字段**——
`build_module_index_maps`（`scan_stage_cache.rs:213`）会在每次 `set_snapshot` 运行时
清空并根据 snapshot 重新构建这两个映射。

snapshot 访问器（`scan_stage_cache.rs`）：

- `set_snapshot`（`:34`）—— 安装 snapshot 并重建索引映射。
- `get_snapshot`（`:66`）—— `&NormalizedScanStageOutput`；**如果 `snapshot` 为 `None` 会 panic**。
- `get_snapshot_mut`（`:41`）—— `&mut`；**如果为 `None` 会 panic**。
- `take_snapshot`（`:46`）—— 将 snapshot 移出，留下 `None`。
- `update_defer_sync_data`（`:50`）—— 取出 snapshot，执行 `defer_sync_scan_data`，在任何结果下都恢复它，然后传播任何错误。
- `merge`（`:70`）—— 将扫描输出拼接进 snapshot（见下文）。
- `create_output`（`:229`）—— 生成供构建消费的 `NormalizedScanStageOutput`。

### `BundleMode`

`crates/rolldown_common/src/types/bundle_mode.rs` —— 决定缓存是创建、保留还是复用：

| 模式                     | 缓存进入 | 缓存输出 | 使用场景                                     |
| ---------------------- | -------- | --------- | -------------------------------------------- |
| `FullBuild`            | 无       | 丢弃      | 一次性构建，非增量 watch                      |
| `IncrementalFullBuild` | 新建     | 保存      | 首次增量构建，或开发模式下构建失败后的恢复    |
| `IncrementalBuild`     | 现有     | 更新      | 后续增量构建                                 |

`is_full_build()` 对 `FullBuild` 和 `IncrementalFullBuild` 返回 true；
`is_incremental()` 对 `IncrementalFullBuild` 和 `IncrementalBuild` 返回 true。

### snapshot：`NormalizedScanStageOutput`

`crates/rolldown/src/stages/scan_stage.rs:41`。字段包括 `module_table`、`index_ecma_ast`（每个模块的解析 AST）、`stmt_infos`、`entry_points`、`symbol_ref_db`、`runtime`、`dynamic_import_exports_usage_map`、`user_defined_entry_modules`、`tla_module_count`、`tla_keyword_span_map`。

`make_copy`（`scan_stage.rs:65`）会克隆 snapshot，但通过 `clone_without_scoping` 克隆 `symbol_ref_db`（一种性能优化——构建结束后会恢复 scoping）。

### `ScanStageOutput` 与 `NormalizedScanStageOutput`

`ScanStageOutput`（`scan_stage.rs:131`）是 scan 阶段的产物。它的 `module_table`、`index_ecma_ast` 和 `stmt_infos` 是 `HybridIndexVec`，而 snapshot 中对应的是基于稠密 `IndexVec` 的结构。转换发生在 `merge`（部分扫描）或 `try_into`（完整扫描）中。

## 模块身份模型

如果不了解这个模型，就无法理解 `ScanStageCache::merge`。

### `ModuleId` vs `ModuleIdx`

一个模块有两个身份：

- **`ModuleId`** — 解析后的文件路径（+ query）。稳定；模块的名称。
- **`ModuleIdx`** — 一个小整数（`u32` 的 newtype）。一个槽位编号 / 数组
  索引。在 bundler 会话期间保持不变。

`Module::id()`（`crates/rolldown_common/src/module/mod.rs:33`）返回
`&ModuleId`；`Module::idx()`（`:18`）返回存储在模块结构体 `idx` 字段中的
`ModuleIdx`。

### `module_id_to_idx` — 注册表 / 分配器

`module_id_to_idx: FxHashMap<ModuleId, VisitState>` 是将模块名称映射到其槽位
的唯一事实来源。它是单调递增的：新模块总是分配
`idx = module_id_to_idx.len()`。槽位按 `0, 1, 2, …` 顺序发放，没有空洞，
且永不复用。

### `VisitState`

`crates/rolldown/src/module_loader/module_loader.rs:96`：

```rust
pub enum VisitState { Seen(ModuleIdx), Invalidate(ModuleIdx) }
```

两个变体都携带 idx。变体本身是“新鲜度”标记：

- `Seen(i)` — 模块是最新的；loader 跳过它（不重新扫描）。
- `Invalidate(i)` — 模块已过期；loader 重新扫描它，并复用 `i`。

### `IndexVec` / `Map` / `HybridIndexVec`

- `IndexVec<ModuleIdx, T>` — 以 `ModuleIdx` 为索引的 `Vec`。**稠密**：对于
  每个 `i in 0..len`，槽位 `i` 都存在。
- `FxHashMap<ModuleIdx, T>` — **稀疏**：只保存插入过的键。
- `HybridIndexVec<ModuleIdx, T>`（`crates/rolldown_common/src/types/hybrid_index_vec.rs`）
  — 一个枚举，要么是 `IndexVec(..)`，要么是 `Map(..)`。`Default` 是
  `IndexVec` 变体。

**全量扫描**会产生所有模块 → 稠密的 `IndexVec`。**部分扫描**只会产生已
变更 + 新发现的模块 → 稀疏的 `Map`。

### 不变量

1. 一个模块的 `ModuleIdx` 只分配一次（在首次解析时），并且永远不会改变
   或被复用。
2. idx 从 0 开始按稠密方式分配；已分配集合恰好是
   `0..module_id_to_idx.len()`。
3. 缓存快照是稠密且完整的：`module_table` 以及每个并行 side-table
  （`index_ecma_ast`、`stmt_infos`、`symbol_ref_db` 的本地 DB）都对每个已
   分配的 idx 有一个槽位。
4. 部分扫描输出是稀疏的：它只包含 {已变更} ∪ {新建} 模块。未变更模块不
   会出现。
5. 对于部分扫描输出中的某个模块，“新建” ⇔ 其 idx ≥ 发生 merge 时缓存中
   当前的模块数量。
6. 模块 loader 为每个模块分配一个单独的 `ModuleIdx`，并将同一个值同时用作
   扫描输出 `Map` 的 key、`Module.idx` 字段，以及
   `module_id_to_idx` 的 value（见 `try_spawn_new_task`）。因此，对任意给定
   模块，这三者相等。

---

## `module_id_to_idx` — 更新生命周期

`module_id_to_idx` 位于 `ScanStageCache` 中。`ModuleLoader` 持有对同一缓存的可
变借用——`cache: &'a mut ScanStageCache`
（`module_loader.rs:117`）——因此 loader 的写入会直接修改 bundler 的实际缓存。
这里没有拷贝。

`module_id_to_idx` 在 **扫描阶段期间** 由 loader **急切更新**。`merge` 在扫描结
束后运行，并且**只读取** `module_id_to_idx`——它从不向其中插入。

### 写入位置（都在 `module_loader.rs` 中，扫描期间）

| 位置                     | 位置说明                            | 作用                                                                                        |
| ------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Runtime module           | `fetch_modules`, `:304`–`:308`      | `Entry::Vacant` → 插入 `Seen(idx)`（一次）。                                                  |
| 标记变更文件为失效       | `fetch_modules`, `:348`–`:350`      | 对每个 watcher 报告的文件：`Entry::Occupied` → `insert(Invalidate(idx))`。idx 不变。          |
| `Seen(idx)` 分支         | `try_spawn_new_task`, `:230`–`:244` | 不写入；返回 idx，模块不重新扫描。                                                            |
| `Invalidate(idx)` 分支   | `try_spawn_new_task`, `:246`–`:251` | `insert(Seen(idx))` — 模块正在被重新扫描。                                                    |
| `None`，部分扫描         | `try_spawn_new_task`, `:252`–`:259` | 新模块：`insert(id, Seen(len))`，`len = module_id_to_idx.len()`。                             |
| `None`，全量扫描         | `try_spawn_new_task`, `:260`–`:264` | 新模块：`insert(id, Seen(alloc()))`。                                                         |

### 每项状态机

```
   (absent) --首次解析--> Seen(idx) --文件变更--> Invalidate(idx)
                                     ^                              |
                                     |  loader 重新扫描该模块       |
                                     +------------------------------+
```

idx 在出生时就固定了；后续转换只是在 `Seen` / `Invalidate` 标记之间切换。

### 构建内顺序

在部分扫描中，`fetch_modules` 会先将每个 watcher 报告的文件置为
`Invalidate`，然后调用 `try_spawn_new_task`，后者命中 `Invalidate` 分支，把它
改回 `Seen` 并重新扫描。中间的 `Invalidate` 状态正是触发重新扫描的原因——如果是
`Seen` 条目，`try_spawn_new_task` 会直接返回而不重新扫描。它也用于去重：一旦
切回 `Seen`，之后才解析到同一模块的导入者只会直接返回 idx。

结论：扫描输出中出现的每个模块，在 `merge` 运行前都已由 loader 注册到
`module_id_to_idx`。

---

## `ScanStageCache::merge` — 写入路径

`scan_stage_cache.rs:70`。签名：`merge(&mut self, scan_stage_output: ScanStageOutput) -> BuildResult<()>`。

### 调用者

- `bundle.rs:256` — 在 `normalize_scan_stage_output_and_update_cache` 中的
  非全量扫描分支。
- `hmr_stage.rs:286`, `:379`, `:621` — HMR 更新路径。

全量扫描构建路径不会调用 `merge`；它使用 `set_snapshot`（`bundle.rs:250`）。
当前所有调用者都传入部分扫描输出，其 `module_table` 为
`HybridIndexVec::Map`；因此 `merge` 中的 `IndexVec` 匹配分支是
`unreachable!()`。

### 算法

1. **首次构建逃生口**（`:77`–`:82`）——如果 `snapshot` 为 `None`，则通过
   `try_into` 转换整个输出并返回。
2. **提取 `modules`**（`:83`–`:92`）——对 `module_table` 进行匹配：
   `IndexVec` 分支是 `unreachable!()`；`Map` 分支收集为 `Vec` 并按 idx
   **排序**。排序会把已有模块（idx < cache 长度）放在新模块之前，并让新模块按
   升序排列，以便 `push` 将每个模块放入其分配好的槽位。
3. **逐模块循环**（`:94`–`:158`）：
   - `new_idx` 是 `Map` 的 key（扫描输出的索引）；`idx` 是
     `module_id_to_idx[new_module.id()].idx()`（缓存的索引）。根据不变量 6，
     二者相等。
   - 更新 `module_idx_by_abs_path`（仅普通模块，路径做斜杠归一化）和
     `module_idx_by_stable_id`。
   - **新模块**（`new_idx ≥ cache.module_table.modules.len()`）：将模块 / AST /
     stmt infos / local symbol DB 追加到并行集合中；调整
     `tla_module_count` 和 `tla_keyword_span_map`。
   - **已有模块**：在 `idx` 处覆盖相同集合；按旧值与新值的差异调整 TLA 计数；
     替换或移除 TLA span。
   - 所有 payload 都是从扫描输出中移动出来的（`mem::take` / `take` /
     `mem::replace` / `mem::swap`）——从不克隆。
4. **合并入口点**（`:161`–`:181`）——对于匹配到的已有入口点，删除已重新扫
   描模块的 `related_stmt_infos`，并扩展为新的内容；否则追加新的入口点。
5. **修补 barrel 模块**（`:184`–`:192`）——排空
   `barrel_state.resolved_barrel_modules`，并将已解析的导入记录写回缓存中的模块。
6. **重新计算用户定义入口**（`:194`–`:208`）——从扫描输出中的集合开始，再加
   回仍能解析到活跃模块的持久配置根目录
   (`self.user_defined_entry`)。这里每次构建都会重建该集合，而不是单调扩展它。

`merge` 有两个 panic 点：`module_id_to_idx[new_module.id()]` 这个索引表达式（在缺
失键时 panic——只有当不变量 6 被破坏时才会发生）以及 `unreachable!()` 分支。
`Module::idx()` 返回的值与 `module_id_to_idx` 查找结果相同，并且是不会失败的。

---

## 读取者和写入者

### `ScanStageCache` 的写入者

| 写入者                                                   | 位置                                                                                | 写入内容                                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScanStage::scan(scan_mode, &mut self.cache)`            | 调用位置 `bundle.rs:104`                                                               | 由 loader 写入非 snapshot 字段。                                                                                                                   |
| `ModuleLoader` (`cache: &'a mut ScanStageCache`)         | `module_loader.rs:117` 及其方法                                                         | `module_id_to_idx`、`barrel_state`（例如在 invalidate 时移除 `barrel_infos`）、`importers`、`user_defined_entry`（全量增量扫描）。               |
| `ScanStageCache::merge`                                  | `scan_stage_cache.rs:70`; 被 `bundle.rs:256`, `hmr_stage.rs:286/379/621` 调用         | `snapshot`、`module_idx_by_abs_path`、`module_idx_by_stable_id`、`barrel_state.resolved_barrel_modules`（被排空）、snapshot 中的 `tla_*` 字段。 |
| `ScanStageCache::set_snapshot`                           | `scan_stage_cache.rs:34`; 被 `bundle.rs:250` 和 `update_defer_sync_data` 内部调用      | `snapshot` + 重建 `module_idx_by_abs_path` / `module_idx_by_stable_id`。                                                                        |
| `ScanStageCache::update_defer_sync_data`                 | `scan_stage_cache.rs:50`; 被 `bundle.rs:257`, `hmr_stage.rs:289/382/623` 调用         | 取出并恢复 `snapshot`；`defer_sync_scan_data` 会修改其中按模块划分的 `side_effects`。                                                              |
| `ScanStageCache::create_output`                          | `scan_stage_cache.rs:229`; 被 `bundle.rs:258` 调用                                    | 修改 `snapshot.symbol_ref_db`（在不限定作用域的情况下克隆它，然后交换）；返回一个 `NormalizedScanStageOutput`。                                   |
| `merge_immutable_fields_for_cache`                       | `bundle.rs:315`，被 `bundle.rs:279` 调用                                                | `get_snapshot_mut()`；在 link 阶段之后恢复符号表作用域。                                                                                            |
| `with_cached_bundle` / `with_cached_bundle_experimental` | `impl_bundler_incremental_build.rs:9` / `:27`                                           | 在 `Bundler` 与 `Bundle` 之间移动整个 `ScanStageCache`。                                                                                          |

### `ScanStageCache` 的读取者

| 读取者                 | 位置                                  | 读取内容                                                                                                                                                     |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HmrStage`             | `hmr_stage.rs:48`, `:52`              | `get_snapshot().module_table`、`get_snapshot().index_ecma_ast`；同时也使用模块索引映射。HMR 也是写入者（它调用 `merge` / `update_defer_sync_data`）。          |
| `ModuleLoader`         | `module_loader.rs:410`, `:983`        | `get_snapshot()`（例如 `module_table.modules.get(..)`）。此外还读取 `module_id_to_idx`（`:229`, `:869`）、`barrel_state`、`user_defined_entry`。              |
| `defer_sync_scan_data` | `module_loader/deferred_scan_data.rs` | 读取 `module_id_to_idx`（以 `&FxHashMap<ModuleId, VisitState>` 形式传入）；修改 snapshot 中按模块划分的 side effects。                                       |
| `merge`                | `scan_stage_cache.rs:70`              | 读取 `module_id_to_idx` 和 `user_defined_entry`。                                                                                                            |

---

## 相关内容

- [design.md](./design.md) — 缓存完整性契约与未决问题
- [bundler-data-lifecycle](../bundler-data-lifecycle/implementation.md) — bundler 级与
  bundle 级数据、`BundleMode`、构建失败时的缓存完整性。
- [module-id](../module-id/implementation.md) — `ModuleId` 设计。
- [rust-bundler](../rust-bundler/implementation.md) — `Bundler` 结构体与构建生命周期。
- [watch-mode](../watch-mode/implementation.md) — 由部分扫描驱动的 watch 模式。
