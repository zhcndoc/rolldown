# Pass 之间的 AST 变异

## 概要

Rolldown 通过侧表在编译器各个 pass 之间传递每个 AST 节点的元数据。跨 pass 的身份键现在是 oxc 的语义分析后 `NodeId`，而 `Span` 仍然作为源位置元数据，用于诊断、注释、源码映射以及生成的替换范围。

公开的 oxc 类型是 `oxc::semantic::NodeId`。它是 AST 节点在语义分析后 `node_id()` / `set_node_id()` 访问器背后的实现；Rolldown 当前使用的版本中并没有单独公开的 `AstNodeId` 类型。

## Pass 概览

Rolldown 的打包流水线有三个会与 AST 交互的阶段：

- **扫描** - `ScanStage::scan` 会解析每个模块，运行 Rolldown 的预扫描 AST 调整，然后重建语义/作用域信息。这个最终重建步骤会为每个节点——包括调整过程中创建的节点——分配 `NodeId`，因此后续通过 `AstScanner` 的只读遍历会在填充 `EcmaView` 侧表时看到稳定的 id。
- **链接** - `LinkStage::link` 执行跨模块工作，例如符号绑定、导出解析、tree shaking 和跨模块优化。它仍然不会修改 AST，但可以基于 scan 阶段的记录派生出额外的侧表。
- **生成 / 收尾** - `ScopeHoistingFinalizer` 由 `GenerateStage::generate` 驱动，是主要在原地修改 AST 的阶段。它会访问感兴趣的节点，调用 `node_id()`，并查询侧表以决定要重写什么。

在这些 pass 之间，Rolldown 不会持有 AST 节点的直接引用。生命周期和并行的跨模块工作使这变得不现实。因此，一个模块 AST 内节点持久的身份就是它的 `NodeId`。

## NodeId 契约

跨 pass 共享的不变式如下：

- **插入**：scan/link 使用被记录的 AST 节点的 `NodeId` 写入侧表条目。
- **查找**：finalizer 或其他后续 AST walker 从当前节点读取 `node_id()`，并查询表。
- **必要保证**：该节点来自同一个语义分析后的 AST，并且侧表仅限于该模块，除非键中也包含 `ModuleIdx`。

重要限制：

- `NodeId` 只在单个 AST 内唯一。任何合并多个模块记录的表都必须以 `(ModuleIdx, NodeId)` 作为键。
- `NodeId` 只有在语义分析为其分配 id 之后才有意义。Rolldown 的正常 scan 路径是语义分析后进行的，因此 scan 创建的记录是有效的。
- 合成/默认节点在稍后分配 id 之前使用 `NodeId::DUMMY`。不要为合成的 `DUMMY` 节点插入跨 pass 的侧表记录。
- `NodeId::DUMMY` 等于 `NodeId::ROOT`（两者都是 `0`，即 `Program` 节点的 id）。来自合成节点的 `DUMMY` 探测之所以会缺失，只是因为没有任何侧表记录 `Program` 级别的条目——绝不要向按模块划分的 `NodeId` 表中添加以 `Program` 为键的条目。
- 已克隆的语义分析后节点可以保留原始节点 id，除非克隆被重置或重新构建语义信息。应将克隆节点视为对身份敏感。

有两条路径会对扫描得到的 AST 的 _克隆_ 进行最终处理；该克隆由 `EcmaAst::clone_with_another_arena` 复制到新的分配器中，它们通过不同机制满足“同一个语义分析后的 AST”这一保证：

- **缓存路径 — 保留 id。** 增量构建缓存（`NormalizedScanStageOutput::make_copy`、`ScanStageCache::create_output`）会把它的克隆交给 link 阶段和 `ScopeHoistingFinalizer`，它们复用 scan 阶段的作用域信息，并且不会重新运行语义分析。克隆本身必须携带 scan 阶段的 id——这就是为什么 `clone_with_another_arena` 使用 oxc 的 `clone_in_with_semantic_ids`，而不是普通的 `clone_in`；后者会把每个 id 重置为 `NodeId::DUMMY`，从而悄无声息地破坏所有查找。
- **HMR 路径 — 确定性重新推导。** `crates/rolldown/src/hmr/hmr_stage.rs` 中的 HMR 渲染器会先克隆，然后立即在克隆上运行 `EcmaAst::make_semantic`，这会重新标记每个 `NodeId`；克隆保留的 id 会在任何查找之前被覆盖。查找仍然有效，是因为 `SemanticBuilder` 仅按遍历顺序为节点编号，所以对同一树形结构的未修改克隆会重新推导出与 scan 阶段完全相同的 id。两个不变式保证了这一点：在 `make_semantic` 运行之前不能修改克隆，并且 oxc 的编号必须仍然是树形结构的纯函数（截至 oxc 0.135，这一点成立——`with_cfg` / `with_enum_eval` 等 builder 选项不会影响编号）。破坏任一条件都会悄无声息地改变 id：索引查找（`module.imports[&…]`）会 panic，`.get()` 查找则会静默跳过重写。

## 当前以 NodeId 为键的表

主要的跨 pass 侧表、以 `NodeId` 为键的有：

- `EcmaView::imports` - import declarations, export-from declarations, dynamic `import()` expressions, and recognized `require()` call expressions.
- `EcmaView::dummy_record_set` - 需要运行时 helper 重写的 `require` 标识符引用。
- `EcmaView::new_url_references` - 映射到资源导入记录的 `new URL('...', import.meta.url)` 节点。
- `EcmaView::rolldown_file_url_references` and the generate stage's `ResolvedFileUrls` - `import.meta.ROLLDOWN_FILE_URL_<referenceId>` member expressions recorded at scan; `resolveFileUrl` hook results are keyed by `(ModuleIdx, NodeId)` for the finalizer's rewrite.
- `EcmaView::this_expr_replace_map` - 应该变成 `exports` 或 `undefined` 的顶层 `this` 表达式。
- `MemberExprRef::node_id` and `LinkingMetadata::resolved_member_expr_refs` - 从 scan 到 link 再到 finalization 的命名空间/成员表达式解析。
- `DynamicImportExprInfo::node_id` 记录了其所在模块中的动态 `import()` 节点；`EntryPoint::related_stmt_infos` 随后携带 `(ModuleIdx, …, NodeId, …)` 元组，以便将动态 import 入口追溯回模块图中的位置。
- 跨模块优化状态，它有两种形态：每个模块各自的一组无副作用调用表达式（裸 `NodeId`，只在同一模块的遍历中消费），以及按 `(ModuleIdx, NodeId)` 键控的全图范围内不可达动态导入集合，因为它汇总了来自每个模块的记录。

这意味着 finalizer 生成的、保留默认 `NodeId::DUMMY` 的节点不会意外匹配 scan 阶段的记录。`Span` 不再需要同时充当这些重写决策的键。

## `Span` 仍然适用的地方

`Span` 仍然是源位置的正确表示。它依然用于：

- 指向用户源码的诊断和警告；
- 注释、源码映射范围、指令/hashbang 范围，以及 TLA 关键字位置；
- 生成的替换范围，其中代码生成应保留有用的源位置；
- import 记录的源位置，包括用于解析器诊断的原始模块请求范围，以及用于需要指向完整 import 位置的诊断的已解析 `importer_span`。

对于 import 记录，模块请求范围属于 `ImportRecordStateInit`：依赖解析诊断仍然需要标出原始说明符，但该范围不会被带入 `ImportRecordStateResolved`。已解析记录会保留 `importer_span`，因为后续 pass（例如 TLA import-chain 诊断）需要一个位置来表示已解析的 import 边。

对于成员表达式，`NodeId` 是跨 pass 的查找键，但 `Span` 仍然作为源位置必需：`MemberExprRef::span` 会让诊断定位到原始表达式，而 finalizer 会把当前成员表达式的 span 应用到生成的替换中，从而让源码映射和诊断位置继续绑定到被重写的源码范围。

不要再添加仅以 `Span` 为键的跨 pass 节点侧表。如果后续 pass 需要识别同一个 AST 节点，应优先使用 `NodeId`；如果一张表可能包含来自多个模块的记录，则应包含 `ModuleIdx`。

## 预扫描 Span 处理

`PreProcessor` 不再为了身份而重写 span。自从迁移到 `NodeId` 之后，成对 span 的唯一性不再支撑任何身份表，因此普通的重复 span 会保持原样，而预扫描重写过程中创建的节点可以保留保留的合成 span（`SPAN`，`0..0`）。

后续遍历不得使用 `span.is_unspanned()` 来判断一个 scanner 可见节点是否有跨遍历记录。例如，最终处理一个 `require()` 调用现在依赖 `EcmaView::imports.get(call_expr.node_id())`：预扫描创建的调用具有语义 `NodeId`，因此可以命中；而 finalizer 创建的调用会保留 `NodeId::DUMMY`，因此命不中。

实践规则很简单：把 `Span` 当作位置，把 `NodeId` 当作同一 AST 节点身份，把 `(ModuleIdx, NodeId)` 当作跨模块节点身份。

## 相关内容

- [ast-construction](../ast-construction/implementation.md) — rolldown 如何构建这些节点，其身份由该契约跟踪；合成节点使用 synthetic-`SPAN` / dummy-`NodeId` 的规范与本文档共享
- [bundler-data-lifecycle](../bundler-data-lifecycle/implementation.md)
- [module-id](../module-id/implementation.md)
