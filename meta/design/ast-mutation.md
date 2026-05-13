# Passes 之间的 AST 变异

## 摘要

Rolldown 通过以节点的 oxc `Span` 为键的侧表，在编译器各个 pass 之间传递每个 AST 节点的元数据。Scan 会填充这些数据，Link 会继续补充，最终 Finalizer 通过调用 `node.span()` 并据此查表，在原地修改 AST。这个机制今天是可行的，但它依赖一个隐含的“在同一模块内，span 稳定且唯一”的约定；这个约定没有验证层，而且很容易被破坏。本文描述当前行为，以便未来迁移到 oxc 即将推出的 `AstNodeId` 时，可以有一个基线进行对比——本文本身并不是该迁移的提案。

## Pass 概览

Rolldown 的打包流水线有三个会与 AST 交互的阶段：

- **Scan** — `ScanStage::scan`（`crates/rolldown/src/stages/scan_stage.rs:159`）。每个模块：先解析，然后通过 `AstScanner` 只读遍历 AST，以填充 `EcmaView` 侧表（imports、this 表达式、`new URL(...)` 引用等）。AST 本身不会被修改。
- **Link** — `LinkStage::link`（`crates/rolldown/src/stages/link_stage/mod.rs:229`）。跨模块工作——符号绑定、导出解析、tree shaking。此阶段仍然不会修改 AST。它会计算额外的侧表（尤其是 `resolved_member_expr_refs`），这些表以 scan 阶段收集到的 span 为键。
- **Generate / Finalize** — `ScopeHoistingFinalizer`（`crates/rolldown/src/module_finalizers/impl_visit_mut.rs:26`），由 `GenerateStage::generate`（`crates/rolldown/src/stages/generate_stage/mod.rs:82`）驱动。这是唯一会修改 AST 的阶段。它以 `VisitMut` 遍历实现；在每个相关节点处，它调用 `node.span()` 并查询侧表，以决定要重写什么。

在各个 pass 之间，rolldown **不会** 持有 AST 节点的直接引用（跨并行和跨模块边界，生命周期也不允许这么做）。跨 pass 保留下来的唯一信息是 `Span`。

## 以 Span 作为身份标识的约定

所有 pass 共享的约束是：

- **插入**：scan/link 使用被记录 AST 节点的 `Span` 来写入侧表项。
- **查找**：finalizer（或其他 AST walker）读取 `node.span()` 并查询表。
- **所需保证**：每个被记录的节点都必须拥有一个 `Span`，且该 `Span` 在其模块内是唯一的，并且从插入到查找期间保持不变。

这里没有 `AstNodeId` 或其他稳定身份标识。`Span` 既充当源位置元数据，也充当主键。

### 预扫描的 span 归一化

如果直接依赖解析后的原始 AST，上述约定是不安全的：oxc 会为每个节点提供一个来源于源代码位置的 span，但外观相同的源码可能产生相同的 span（最常见的是解析器输出中的空 span / 合成 span）。因此 Rolldown 在 scan 之前会运行一个预扫描 pass——`crates/rolldown/src/utils/tweak_ast_for_scanning.rs` 中的 `PreProcessor`——它遍历 AST，并对其关心的节点类型，将任何重复的 span 重写为一个新的空 span（`start == end`，从 `program.span.end + 1` 向上分配）。

这种去重是**有针对性的子集，而不是所有以 span 为键的节点类型的穷尽列表**。`PreProcessor` 会访问解析器已知会产生重复或合成 span 的节点类型（例如反糖化产生的空 span，或那些可以合法重叠的类型）：

- `ModuleDeclaration`（import/export 声明）
- `ImportExpression`（动态 `import()`）
- `ThisExpression`
- `CallExpression`，且其 callee 是 `require`（以及名为 `require` 的 `IdentifierReference`）
- `NewExpression`

见 `tweak_ast_for_scanning.rs:208-240`。其他节点类型会保留解析器给出的 span——包括 `StaticMemberExpression`，`resolved_member_expr_refs` 就是以它作为键。成员表达式不会被去重，因为它们的 span 覆盖真实源码范围，实际中不会冲突。合成的 `SPAN`（`0..0`）会预先加入已访问集合，因此去重器永远不会把它作为“唯一”的替代值生成——合成 span 仍保留给 finalizer 生成的新节点使用。

实际保证比表面看起来更窄：**对于 `PreProcessor` 访问的节点类型，当 scan 开始时，其 span 在模块内是唯一的。** 对于其他任何以 span 为键的表——包括成员表达式这种情况——唯一性都依赖解析器自身的行为。如果新增一个键容易发生冲突或使用合成 span 的侧表，就需要么向 `PreProcessor` 增加条目，要么采用不同的身份策略。

## 以 Address 作为身份标识（替代键）

`Span` 并不是 rolldown 在 passes 之间传递的唯一节点身份。有些侧表使用的是 oxc 的 `Address`（通过 `GetAddress::address` / `UnstableAddress::unstable_address` 获得的 arena 指针）作为键。与 span 不同，`Address` 在一个存活的 AST 中**按构造即唯一**——两个不同的、由 allocator 管理的节点不可能共享同一个 address，且不需要 `PreProcessor` 参与——但它只在拥有 AST 的 `Allocator` 生命周期内有效，因此在重新解析之后或 AST 被释放之后就无法使用。

Rolldown 会在生产者和消费者都持有同一 arena 引用、且该表无需在 AST 消失后继续存在的场景下使用 `Address`：

- **`DynamicImportExprInfo.address`**（`crates/rolldown_common/src/types/import_record.rs:22`）——scan 在每条动态 import 记录上保存 `ImportExpression` 的 address（`ast_scanner/mod.rs:509-510`），link 在跨模块优化期间查找它（`stages/link_stage/cross_module_optimization.rs:328-329`）。
- **`side_effect_free_call_expr_addr`**（`stages/link_stage/cross_module_optimization.rs:376`）——link 填充一个 `FxHashSet<Address>`，其中包含纯调用表达式；`SideEffectDetector` 在重新评估副作用时会查阅它（`ast_scanner/side_effect_detector/mod.rs:48`）。
- **`unreachable_import_expression_addresses`**（`stages/link_stage/cross_module_optimization.rs:340`）——link 将懒加载路径中的动态 import 标记出来，以便 tree-shaker 可以跳过它们（`stages/link_stage/tree_shaking/include_statements.rs:213`）。
- **`EntryPoint.related_stmt_infos`**（`crates/rolldown_common/src/types/entry_point.rs:16`）——元组会携带一个 `Address`，连同 `(ModuleIdx, StmtInfoIdx, ImportRecordIdx)` 一起，用来指向源 AST 节点。
- **`PreProcessor` 的 `statement_stack` / `statement_replace_map`**（`crates/rolldown/src/utils/tweak_ast_for_scanning.rs:17-18`）——仅在单次遍历内部使用的临时状态，此时 AST 显然仍然存活。

这两种机制并存的原因是：`Span` 是会一直存活到 finalizer 的那个标识；finalizer 在 AST 经过 scan → link → finalize 且没有保留直接节点引用的情况下，通过调用 `node.span()` 重新推导身份。`Address` 则是当消费者能够持有同一 arena 的引用，而若继续使用 `Span` 则必须扩展 `PreProcessor`（或者与合成 span 冲突作斗争）时的自然选择。未来的 `AstNodeId` 迁移原则上可以同时取代两者，但下面列出的脆弱性特指 `Span` 约定——以 `Address` 为键的场景不受这些问题影响。

## 经典模式

这些侧表在细节上各不相同，但它们都体现出下面两种模式之一。模式决定的是哪些 pass 会处理该条目，而不是数据的形状。

### 模式 A — Scan → Finalize

Scan 记录 span 以及它能够在本地做出的重写决定。link 阶段不会修改该条目。finalizer 读取它并修改 AST。

示例：`EcmaView::new_url_references`。

1. 在 scan 过程中，`ast_scanner/new_url.rs:69` 看到一个 `new URL('./img.png', import.meta.url)`，将路径解析为一个 import record，并把 `(NewExpression.span → ImportRecordIdx)` 插入侧表。
2. 在 finalize 过程中，`module_finalizers/mod.rs:961` 遍历每个 `NewExpression`，查找其 span，并在命中时将该表达式重写为输出已解析的资源 URL。

同样的形态还出现在：

- `EcmaView::this_expr_replace_map` —— scan 选择替换值（`exports` 或 `undefined`），finalizer 在 `impl_visit_mut.rs:460` 处应用它。
- `EcmaView::imports` —— scan 记录 import 位置的 span，finalizer 重写该位置。
- `EcmaView::dummy_record_set` —— scan 标记 `require` 标识符引用（`ast_scanner/impl_visit.rs:591`），finalizer 在 `module_finalizers/rename.rs:86` 处对每个 `IdentifierReference` 查阅该集合，并将调用重写为使用运行时的 `__require` 辅助函数。这里 span 充当的是逐节点布尔值，而不是更丰富数据的键，但流程仍然是 scan→finalize。

### 模式 B — Scan → Link → Finalize

Scan 只利用当前可得的局部信息收集 span；link 使用这些记录，在已知跨模块事实后，用相同的 span 填充一个解析表；finalizer 应用最终决策。

示例：`LinkingMetadata::resolved_member_expr_refs`。

1. **Scan** 看到像 `ns.foo.bar` 这样的链式表达式，并记录 `StaticMemberExpression.span` 以及本地符号引用。
2. **Link** 在 `link_stage/bind_imports_and_exports.rs:445-447, 477-479` 中，将每个被记录的 span 解析为它跨模块图所指向的实际导出绑定，并把结果写入 `FxHashMap<Span, MemberExprRefResolution>`（在 `link_stage/bind_imports_and_exports.rs:700` 提交到 `LinkingMetadata`）。
3. **Finalize** 在 `module_finalizers/mod.rs:1006` 中遍历每个 `StaticMemberExpression`，调用 `.span()`，并在命中时将该链替换为一个直接引用已链接符号的表达式。

这是该约定最完整的体现：三个 pass 完全通过节点的 span 来相互通信。

## 已知脆弱点

- **克隆的节点会携带原始 span。** 如果某个 pass 在克隆 AST 节点时没有重置其 span，那么这个克隆体就会错误地匹配原本属于原节点的侧表条目。后续查找可能会命中错误的节点。
- **合成 span 彼此会冲突。** 当 finalizer 构造新的 AST 节点（辅助函数、成员表达式等）时，必须给它们一个不会意外匹配已记录条目的 span。约定是使用合成 `SPAN`（`0..0`）——见 `module_finalizers/mod.rs:1088-1090`，其中注释明确说明了这种规避方式：

  ```rust
  // IMPORTANT: Use SPAN (0-0) for the new member expression to avoid being
  // matched by resolved_member_expr_refs lookup which uses span as key
  let ns_id_ref = self.snippet.id_ref_expr(ns_name, SPAN);
  ```

  这在另一个方向上也很脆弱：所有合成节点共享同一个键，因此如果新增以 `SPAN` 本身为键的侧表，就会立刻发生冲突。

- **唯一性覆盖由人工维护。** `PreProcessor` 只会去重它被教会处理的节点类型（见“预扫描的 span 归一化”）。其他以 span 为键的类型（例如 `StaticMemberExpression`）则依赖解析器自行生成唯一 span。若为某个容易冲突或使用合成 span 的类型新增侧表，而没有扩展 `PreProcessor`，那么安全网就会悄然失效——两者之间没有编译期检查来建立关联。
- **没有 `PreProcessor` 之后的验证。** 一旦 `PreProcessor` 完成，运行时并不会检查唯一性不变量是否仍然成立——该约定是靠构造保证的，而不是靠断言保证的。（插件 `transform` 钩子在解析之前对源代码进行操作，因此不在此列；当它们运行时，被键控的 AST 还没有被构建出来。）当不变量真的被破坏时——例如 span 被克隆、新增了未被 `PreProcessor` 覆盖的侧表类型，等等——回归表现为 finalizer 中静默的未命中（本应发生的重写没有发生），而不是崩溃。
- **已有的 FIXME。** `crates/rolldown_common/src/types/member_expr_ref.rs:23-24` 已经指出了这一点：

  ```rust
  /// FIXME: use `AstNodeId` to identify the MemberExpr instead of `Span`
  /// related discussion: https://github.com/rolldown/rolldown/pull/1818#discussion_r1699374441
  pub span: Span,
  ```

## 这为何值得关注

Oxc 正在引入一个 `AstNodeId` —— 一种真正按每棵树分配的节点标识，与源码位置无关。将侧表从以 `Span` 为键改为以 `AstNodeId` 为键，将消除上述结构性问题：不再需要维护唯一性假设，不再需要为 finalizer 生成的节点使用 synthetic-span 变通方案（合成节点会获得新的 id，且不可能与任何内容冲突），也不再需要 `PreProcessor` 维护一份手工整理的节点类型列表以与侧表集合保持同步。本文档记录了当前状态，以便能够基于对现状的具体描述来评估并规划迁移。

## 相关

- [bundler-data-lifecycle](./bundler-data-lifecycle.md)
- [module-id](./module-id.md)
