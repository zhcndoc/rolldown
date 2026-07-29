# 代码拆分设计

本文档记录了选择性严格执行顺序的架构。当前实现已在 [implementation.md](./implementation.md) 中描述。顺序调度不表示为互操作包装，并且生成阶段的降低无法重新开启用户代码的存活性。

## 问题

`WrapKind` 回答的是输入模块表示层面的问题。`Cjs` 和 `Esm` 包装参与链接过程，因为它们决定了命名空间形状、绑定访问、`require()` 行为以及 tree-shaking 依赖。选择性的严格执行顺序回答的是另一个输出布局问题：某个模块主体是否必须延迟执行，因为生成的 chunk 图否则会过早执行它。

顺序决策只能在暂定的 chunk 放置之后做出。将 `WrapKind::Esm` 复用于这个较晚的决策，会让生成阶段的调度看起来像一种新的互操作事实。它还会让诸如 `wrapper_ref`、`wrapper_stmt_info` 和 `stmt_info_included` 之类的链接阶段拥有的字段暴露给后期修改。测试可以检测出许多错误的修改，但架构本身应该让这些修改根本不可能发生。

## 目标

- `LinkingMetadata::wrap_kind()` 保持为链接过程生成的不可变互操作决策。
- 用户模块和语句的存活状态在顺序规划开始之前已固定。
- 顺序降级只能添加合成的包装器、初始化、运行时、外观、符号和拓扑状态。
- 最终化和跨 chunk 链接通过显式的共享只读接口消费互操作包装器和顺序包装器。
- 关闭标志的构建会使顺序包装器状态保持为空，并且不会创建仅严格模式下存在的外观。
- 外部差分模糊测试器仍然是语义验证器。Rolldown 不会添加仅用于测试的执行模型，也不会添加那种只是把降级错误转化为构建失败的断言。

## 模式

`strictExecutionOrder: true` 单独运行 **wrap-all**：每个符合条件的模块都会延迟，eager
阶段只包含无活性的定义，并且不需要评估顺序预测——
正确性完全依赖于共享的 lowering 和触发器放置。它是默认值，
因为其信任基础更小，而且当选择性分析误判某种形态时，它可作为逃生出口。

`experimental.onDemandWrapping: true` 则启用下面描述的 **按需** 分析，
它从预测的评估顺序风险开始，并在安全性需要额外包装的情况下保守地闭合计划。
两种模式共享 plan/lowering/consumer 管线；它们的区别仅在于 plan 的种子生成方式。

这种差异是单向的：wrap-all 可能创建更多无活性包装，但它绝不能保留或
执行更多用户代码。在任一计划被 lowering 之前，链接阶段的语句和绑定活性
已经最终确定，因此 wrap-all 和按需模式会保留相同的 tree-shaking 结果。

## 保守性决策

以下是严格输出会为了确定性而刻意接受额外包装的主要位置：

- **全包裹模式** 会将所有符合条件的内容都包裹起来（见“模式”）。
- **块循环回退**（按需）：一个根模块如果能够沿着预测到的边到达一个静态块循环，那么它还会按预期顺序额外包裹其中每个符合条件的模块。在一个循环中，求值顺序取决于运行时先进入哪个块，而降低（lowering）本身会移动这个入口点；而且预测也无法看到另一个循环块会急切调用的 `var` 形式互操作包装器定义。
- **入口触发器 façade**：只要其块被求值，内联入口触发器就会触发，因此凡是其块中还有别的东西 _可能_ 加载的入口——无论是顺序包裹还是互操作包裹，在两种严格模式下都是如此——都会把触发器移到 façade 上。这个问题是通过将真实的跨块链接计算与完全降低后的顺序状态（`lowered_static_import_edges`）进行比较来回答的，而不是靠预测，因此某个入口如果只有它自己能加载到的块，就会保持触发器内联，不会额外增加文件。“加载”既包括来自其他块的静态导入，也包括宿主在入口块中的任何其他模块的跨块动态导入——例如，把一个动态目标手动分组到入口旁边时，`import()` 会求值入口块。对入口模块本身的动态导入必须运行其程序，而失效的动态导入会降级为无效 stub，所以二者都不会强制拆分；任何其他仍然存活的记录，即使从未执行，也都算作可能的加载来源。  
  纯动态入口是一个例外：当每个存活的 `import()` 调用点都可以携带该触发器时，允许这种情况：实现块会变成公共块，而每个调用点都会重写为 `Promise.resolve().then(() => (init_*(), namespace))` 或 `import(host).then(n => (n.init_*(), n.namespace))`。这既适用于被块优化器移除的 façade，也适用于严格降低本来会创建的 façade。以下情况会被拒绝：先前已恢复的空 façade、已发出/用户入口、带有 TLA 污染的目标、可能暴露可调用 `then` 的跨块宿主命名空间，或者——在创建路径上——直接或传递性的 `export-star` 链路会到达外部模块。入口级外部合并会以 façade 块的形式在所有格式中呈现，而模块本地的模拟命名空间无法重现它们特定于格式的行为。外部 `star` 保护仅适用于创建路径：恢复路径则依赖块优化器的模拟命名空间处理，其中对外部 `star` 的保留是单独处理的。
- **在严格模式下跳过 CJS 命名空间合并**（`determine_safely_merge_cjs_ns`）：合并会把仍然保留的 `require` 调用移动到仍会被包含的那条语句上——这是包裹无法修复的块内移动。每个导入者的调用点都会增加字节数；包装器会进行记忆化。
- **`expected ∖ actual` 种子**：对预测顺序不可见的、顺序敏感的模块（树摇会把它视为无副作用）会被包裹，而不是被信任。

## 触发器放置

每个可以运行包装模块的站点，集中放在一个位置：

| Trigger                                                                           | Lives in                                                                                 | Owner                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `init_*()` for an order-wrapped importee of a live statement                      | importer body, statement position                                                        | finalizer via the shared init-target view                                           |
| `init_*()` / `require_*()` obligations of removed statements                      | importer body, removed statement's position                                              | `OrderImportOverlay` / transitive init targets                                      |
| user or dynamic entry activation, unless every live `import()` rewrite carries it | entry chunk prologue (a facade only when other chunks can load the implementation chunk) | `create_order_wrap_entry_facades` / `restore_order_wrap_entry_facades`              |
| collapsible dynamic entry activation                                              | importer body, the rewritten `import()` call site                                        | finalizer `rewrite_dynamic_import_for_merged_entry` via the shared init-target view |
| interop `require_*()` of an eager importer                                        | importer body (its carrier)                                                              | flag-off interop machinery, order-analysis carrier rule                             |

触发器绝不能内联放在某个 chunk 的主体中，而该 chunk 还会被其他 chunk 作为依赖来求值；这就是 facade 规则的内容。

将动态入口触发器移动到 promise continuation，刻意让它比宿主 chunk 结算晚一个微任务。导入的 promise 仍然只会在 `init_*()` 运行之后才解析，但在宿主求值期间排入队列的微任务可以在初始化之前观察到目标。两种严格模式都采用这一策略；`m4_dynamic_facade_race` 对其进行了固定。

## Thenable chunk namespaces

`import()` 通过 promise 解析过程进行解析，因此携带可调用 `then` 导出的 chunk 命名空间会被同化：promise 会以该 `then` 产生的结果完成，而调用处改写的提取回调永远收不到这个命名空间。对于合并的动态入口，这会让某个 chunk 伙伴的导出改变导入目标时所观察到的内容——这在源代码中是不可能的，因为导入一个模块时，绝不会暴露兄弟模块的导出。

防御措施按导出名的所有者分开处理：

- **打包器拥有的名称绝不会是 `then`。** `deconflict_exported_names` 会在命名内部导出之前预留它——源符号名为 `then` 会像任何冲突一样被去重为 `then$1`——而且最小化名称生成器会跳过字面量 `then`（否则它会出现在数值 443,179 处）。只有当 `then` 本身就是被承诺的名称时，`emitFile` 承诺的导出才会保留 `then`；#10500 跟踪将这些导出改走预定义名称路径，这样就会移除这个特例。
- **用户可见的名称不能被重命名，因此改为拒绝这种合并**：入口自身的公共导出、`emitFile` 承诺的名称，以及运行时由 `export * from` 链最终从外部模块提供的任何内容。`order_wrap_host_can_expose_then_export` 负责保护恢复路径，而入口外观（entry-facade）决策负责保护创建路径——见上面的入口触发外观要点。

有意保留的情况：动态导入目标自身的 `then` 导出。对源模块的原生 `import()` 也会以同样方式同化，因此重命名它会偏离源语义，而不是保持语义一致。

## 严格模式下的 tree-shaking 对等性

后置顺序下沉不能让被排除的 import 绑定或 re-export 变为存活。棘手的情况是一个被 wrap-all 选中的纯 re-export barrel：它的包装器确实存在，但若让这个共享包装器拥有每一个下游 `init_*`，就会初始化被无关消费者使用的叶子节点。这样的包装器在没有本地可执行主体、生成的 missing-export 赋值、无条件执行依赖或 `keepNames` 工作时，会被标记为 re-export-transparent。随后，每个消费者只会通过它路由到该消费者保留的那些叶子绑定。

路由证据是按消费者局部决定的。具名导入使用其本地 facade 的链接阶段活性，包括通过导出链保留的 facade。命名空间持有者——既包括 `import * as ns`，也包括值为命名空间的具名导入——只检查已包含的语句：静态解析出的成员读取会路由该成员，而不透明用法则会展开非歧义命名空间。一个将被常量内联阶段替换掉的已解析成员，会使用与 tree shaking 相同的常量元数据和 inline 模式被跳过。模块全局的叶子或命名空间活性故意不够，因为另一个导入者可以让同一个规范化符号存活，而无需为这个消费者保留它。

仅为替换折叠后的动态入口 facade 而合成出的命名空间，不属于不透明命名空间消费者。它的 getter 仅限于链接时 `import()` 消费者已经保留的导出接口，并且其合成语句会引用这些 getter 背后所有未内联的绑定，从而在 entry chunk 变为公共 chunk 后，跨 chunk 链接不会留下悬空 getter。这里的限制按导出名而不是仅按规范化符号来计算：另一个消费者即使通过不同别名保留了同一个绑定，也不能扩大这个动态入口接口。如果模块命名空间同时还有一个真实的语义消费者，那么完整的语义接口会胜出。否则，被排除的 re-export init 路由会继续使用动态消费者记录的路径。将合成命名空间视为不透明会丢弃这些路径，并且可能在一个 re-export 环中跳过所需的叶子初始化器（`retained_star_renamed_cycle`）。

## 审计决策

有两种形状经过了质疑并被刻意保留：

- **预测会真实的跨 chunk 链接传递执行两次**（仅在按需时）。曾设计并否决过仅处理边的分支以及缓存状态复用：因为初始化元数据传递会在预测与最终链接运行之间写入，所以任何捷径都会偏离输出结果——这正是预测试图防止的那种失败。双重运行是保持保真度的机制；wrap-all 模式则完全跳过预测。
- **互操作包装模块会出现在 expected/actual 顺序中**，而不是被折叠为承载归属。曾实现并回退过一种归属-身份模型：两个不同的承载者可以在同一个序列位置触发同一个触发器（主机身份不同，顺序并未改变），因此身份比较会过度包装。按顺序表示才是序列语义；触发器主机转移则是针对无法自行延迟的高风险模块的定向修复。

## 按需的涌现式循环计划投影

存在两种不同的预测机制；请将它们分开看待。

1. **初始全链接预测**（`predicted_static_import_edges`）使用一个 _空的_ 顺序状态运行真实的跨 chunk
   链接过程，以获得降低前的基线 chunk 拓扑（值边和副作用边，不包含 `init_*` 包装导入）。这就是上面“链接过程运行两次”的
   真实性机制；计划和高风险分析都是基于它计算的。

2. **迭代式计划投影器**（`post_lowering_import_edges`）闭合单次分析会遗漏的循环：应用一个包装计划会使 lowering 自身添加其跨 chunk 的
   `init_*` 转发导入，而这可能闭合基线中从未显示的 chunk 环。位于这种涌现式循环中的 eager 模块，会在该循环期间、
   其兄弟 chunk 分配 wrapper 变量之前，在记录位置运行它的 `init_*()`/`require_*()` —— 这就是 `require_* is not a function`
   的启动崩溃。因此每一轮中，投影器都会在基线上叠加该计划的转发边，找出它们闭合的 chunk 强连通分量（SCC），将循环 chunk 中每个符合条件的模块标记为高风险，并重新构建计划，直到高风险集合不再增长（单调且有限 —— 投影出的
   _拓扑_ 并不单调，边可能会在新包装的转发器停止更深层遍历时变少）。`ROLLDOWN_ORDER_DEBUG=1` 会跟踪每轮的 SCC 数量和最终的包装差异。

该投影器从一个仅用于发现的探测顺序状态出发（与真实 lowering 生成的包装器、嵌套记录集合以及每条记录上的覆盖层完全相同），精确复现链接器注册的三种 `init_*` 依赖类型——因此它与发射过程保持同步，而不是另起一条捷径：

- **保留的重导出覆盖层** —— 一个导入者的 `OrderImportOverlay` 引用一个顺序包装目标的 wrapper，注册时不带 init-owner 门控，因此一个 _eager_ 转发器的跨 chunk 跳转也会计入。仅对顺序包装（而非互操作 `WrapKind::Esm`）的非嵌套目标允许。
- **包含的 + 保留的排除重导出转发** —— 通过共享的 `collect_wrapped_esm_init_targets_for_import_record`，处理一个已包装导入者的包含导入以及保留的排除重导出跳转。
- **非包含的转发器跳转** —— 一个已包装导入者对一个 _非包含_ 转发器的重导出，遍历该转发器的每一条静态导入（不只是其解析后的导出），即排除语句的元数据路由。

刻意省略的部分，以及这样做为何是正确的：互操作 wrapper 边（基线中已经存在）以及嵌套/消费门控跳转（由已包装祖先持有，对 eager 转发器会被 tree-shaking）都会被跳过，因此该投影永远不会对一个与 tree-shaking 等价的图进行过度包装；入口 facade 边被省略，是因为 facade 持有零个模块，因此静态入度为零，也就永远不可能位于静态 SCC 中（在最终链接过程中有调试断言）。其余的过近似（它省略了包装本身对活跃性抑制的影响）最多只会多包一些，这始终是合法的——全包装（wrap-all）就是现成的证明。

## 非目标

- 比默认构建更强的顶层 await 语义。
- 在 chunk 放置之后重新运行完整的链接阶段。
- 对于已经由顺序模型表示的图形结构，提供一种保守的全量包装回退方案。
- 当未选择顺序包装器时，改变 CJS 或 require-of-ESM 的互操作输出。
- 将通用的 tree-shaking 状态移出 `LinkingMetadata`；此设计只隔离规划之后的合成状态。

### 合约边界：不保证顺序，但始终输出有效

有两类输入超出了顺序保证的范围，但生成的代码必须保持有效且可执行：

- **顶层 await。** 顺序包装不会提供超出默认构建的任何 TLA 保证。在机制上它仍然是有效的：一个带有 TLA 污染的模块（或一个在传递依赖上依赖它的模块）会获得一个 `async` 包装体，并且当目标被污染时，每个生成的 `init_*()` 调用点都会 `await`（`EsmInitTarget::tla_tainted`），因此污染会随着包装器传播，而 `await` 永远不会落入同步函数中。
- **外部模块。** 对外部模块的静态 ESM `import` 不能在不改变语义的情况下延后（它会提升到其 chunk 的顶部，并在 chunk 加载时求值），因此当其导入者被包装时，外部模块的副作用可能会比源代码顺序更早运行——对于静态 ESM 输出，这无法通过包装修复，并且与其他所有打包器的行为一致。生成的代码仍然是有效的：外部 import 语句保留在 chunk 顶部，而被包装的导入者在闭包内部引用它们的绑定。

## 被拒绝的替代方案

### 延迟的 `WrapKind` 覆盖

这是最初的概念验证桥接方案。它复用了成熟的包装器代码，但将表示与调度混为一谈，并且要求生成阶段代码去修复由 link 拥有的元数据。即使所有已知的测试用例都通过了，保留这个桥接方案仍然会延续架构上的问题。

### 在规划后重新链接

规划器可以改变模块表示，然后重复绑定、引用传播、树摇优化和分块。这可以恢复一致性，但会让输出生成执行第二次全局编译器遍历，增加构建成本，并且有可能产生与最初促成该计划的那个分块图不同的结果。

### 内部语义验证器

Rolldown 可以独立模拟最终执行，并在模拟结果与源代码顺序不一致时拒绝输出。这会把 fuzzer 的判定器复制到编译器内部，并把一个降级错误变成构建失败。外部的差分判定器应当改为判断正常生成的输出。

## 目标架构

### 不可变链接状态

`LinkingMetadata` 只拥有链接事实：

- interop `wrap_kind`、`wrapper_ref` 和 `wrapper_stmt_info`；
- 用户语句和模块包含关系；
- 已链接导出、命名空间决策以及执行依赖；
- TLA 和 interop 元数据。

`override_wrap_kind()` 和 `hoist_esm_wrapper` 已移除。生成阶段的顺序代码不再接收任何可更改 interop 类型或用户包含关系的 API。

### `OrderWrapState`

生成阶段的最终化会创建一个旁路表，除非严格下推记录了属于顺序的状态，否则它始终为空：

```rust
pub struct OrderWrapState {
  modules: FxHashMap<ModuleIdx, OrderWrappedModule>,
  synthetic_statements: IndexVec<OrderSyntheticStmtIdx, OrderSyntheticStmt>,
  synthetic_statements_by_chunk: FxHashMap<ChunkIdx, Vec<OrderSyntheticStmtIdx>>,
  import_overlays: FxHashMap<OrderImportKey, OrderImportOverlay>,
  import_overlays_by_importer: FxHashMap<ModuleIdx, Vec<OrderImportKey>>,
  import_overlays_by_statement: FxHashMap<(ModuleIdx, StmtInfoIdx), Vec<OrderImportKey>>,
  namespace_requirements: FxHashMap<SymbolRef, FxIndexSet<ModuleIdx>>,
  runtime_symbols: FxHashSet<SymbolRef>,
  nested_reexport_records: FxHashSet<(ModuleIdx, ImportRecordIdx)>,
  consumed_reexport_facades: FxHashSet<SymbolRef>,
}

pub struct OrderWrappedModule {
  pub wrapper_ref: SymbolRef,
  pub wrapper_statement: Option<OrderSyntheticStmtIdx>,
  pub chunk: Option<ChunkIdx>,
  pub reexport_init_transparent: bool,
}

pub struct OrderSyntheticStmt {
  pub owner: ModuleIdx,
  pub declared_symbols: Vec<TaggedSymbolRef>,
  pub referenced_symbols: Vec<SymbolRef>,
  pub runtime_helpers: RuntimeHelper,
  pub chunk: Option<ChunkIdx>,
}

pub struct OrderImportKey {
  pub importer: ModuleIdx,
  pub statement: StmtInfoIdx,
  pub record: ImportRecordIdx,
}

pub struct OrderImportOverlay {
  pub referenced_symbols: Vec<SymbolRef>,
  pub runtime_helpers: RuntimeHelper,
  pub requires_importer_namespace: bool,
  pub requires_importee_namespace: bool,
  pub reexports_dynamic_exports: bool,
  pub retained_reexport_path: Vec<(ModuleIdx, ImportRecordIdx)>,
}
```

`OrderWrapState` 是这些顺序下推字段的唯一拥有者。辅助视图可以借用它，但数据不会镜像到 `LinkingMetadata` 中。

- 顺序包装器符号和位置归属于顺序状态，而不是 `LinkingMetadata`；
- 顺序状态不包含可变的用户语句包含关系；
- 与 importer 相关的引用和运行时辅助工具归属于 `import_overlays`，而不是原始 `StmtInfo`；
- 通过显式的合成语句 API 参与 chunk 分配和冲突消解，合成声明带有用于 chunk 渲染的二级索引；
- entry facade 是调用方在下推后显式做出的 chunk 图更改，而所需的运行时符号则从合成语句和 import overlay 中推导；
- 命名空间需求会保留当前仍然需要各命名空间的活跃 importer 模块，因此一个失活的 overlay 不会让命名空间继续存活；
- 嵌套 re-export 记录和已消费 facade 保留了用于 re-export 初始化路由的冻结 tree-shaking 决策；
- 当不需要包装器或 import overlay 时，该表保持为空。

### 下推 API 边界

下推器通过不可变引用接收链接数据。其可变输出面只包含符号数据库和新的顺序状态：

```rust
pub struct OrderLoweringInput<'a> {
  pub plan: &'a OrderWrapPlan,
  pub modules: &'a IndexModules,
  pub linking: &'a LinkingMetadataVec,
  pub statements: &'a IndexVec<ModuleIdx, StmtInfos>,
  pub asts: &'a IndexEcmaAst,
  pub keep_names: bool,
  pub export_chains: &'a FxHashMap<SymbolRef, Vec<SymbolRef>>,
  pub star_reexport_records_by_imported_symbol:
    &'a FxHashMap<SymbolRef, Vec<Vec<(ModuleIdx, ImportRecordIdx)>>>,
  pub used_symbols: &'a UsedSymbolRefsBuilder,
}

pub struct OrderLoweringOutput<'a> {
  pub symbols: &'a mut SymbolRefDb,
  pub state: &'a mut OrderWrapState,
}
```

该 API 不暴露可变的 `LinkingMetadata`、`StmtInfos` 或 chunk 图。周围的生成阶段 pass 会在下推后放置合成包装器、创建任何 entry facade，并重新计算拓扑派生事实；下推器通过 `OrderWrapState` 传达新的符号、命名空间、运行时以及 re-export 路由需求。

### 最终 ESM 初始化元数据

在包装器选择和最终 chunk 拓扑固定之后，`compute_wrapped_esm_init_metadata` 会推导出同时依赖链接状态和顺序状态的两个事实：`init_*()` 调用是否是 no-op，以及每个被排除的语句处必须初始化哪些包装模块。interop 和执行顺序包装器共享一个封装后的结果，而不是把相同类型的最终事实回写到任一拥有者的可变状态中：

```rust
pub struct Sealed<T>(T); // 私有字段和构造函数；仅提供 Deref，绝不提供 DerefMut 或 unwrap

pub struct FinalEsmInitMetadata {
  modules: FxHashMap<ModuleIdx, ModuleEsmInitMetadata>,
}

struct ModuleEsmInitMetadata {
  init_is_noop: bool,
  transitive_init_targets: FxHashMap<StmtInfoIdx, Vec<ModuleIdx>>,
}

fn compute_wrapped_esm_init_metadata(/* ... */) -> Sealed<FinalEsmInitMetadata>;
```

`Sealed<T>` 及其私有构造函数位于计算该制品的叶子模块中。结果不能被解封或可变解引用，因此再次取得所有权也不会重新开放可变性。最终的跨 chunk 链接和模块最终化只接受 `&Sealed<FinalEsmInitMetadata>`；未封装值无法满足这两个签名中的任意一个。

该表是稀疏的：缺失条目表示 `init_is_noop == false` 且没有被排除语句的目标，而绝不是表示模块没有包装器。包装器身份仍保留在 `LinkingMetadata` 或 `OrderWrapState` 中。更早期的按需投影仍会从其探测用的 `OrderWrapState` 重新计算保守草案，因为最终元数据尚不存在；它会标记最终元数据不可用，而不是伪造一个空的封装值。

### 共享初始化目标视图

最终化和跨 chunk 链接需要处理两种懒初始化来源：

1. 来自 `LinkingMetadata` 的 interop ESM 包装器；
2. 来自 `OrderWrapState` 的顺序包装器。

它们使用只读视图，而不是测试一个有效的 `WrapKind`：

```rust
pub struct EsmInitTarget {
  pub wrapper_ref: SymbolRef,
  pub tla_tainted: bool,
  pub origin: EsmInitOrigin,
}

pub enum EsmInitOrigin {
  Interop,
  ExecutionOrder,
}
```

访问器对某个模块至多解析一个 ESM 初始化目标。interop ESM 包装具有优先级，因为一个已经被 interop 包装的模块会由那个已有包装器来表示；顺序规划器会选择一个可用承载者，而不是再添加第二个包装器。该视图只携带结构性的包装器身份；最终的 no-op 和被排除语句事实来自 `FinalEsmInitMetadata`。

### 合成符号包含

顺序包装器会作为合成声明发出。它们不会新增一个 tree shaking 需要重新发现的用户 `StmtInfo`。下推会创建一个 `OrderSyntheticStmt`，它按构造就是存活的，并提供跨 chunk 链接和冲突消解所需的已声明符号、已引用符号、运行时辅助工具以及最终的 chunk 分配。

`used_symbol_refs` 在下推后保持封装，但跨 chunk 存活性使用一个复合视图：链接阶段使用的符号，加上任何由存活的 `OrderSyntheticStmt` 或 `OrderImportOverlay` 声明或引用的符号。符号到 chunk 的分配以及根作用域冲突消解会显式遍历合成语句，而不是通过链接阶段的语句表来发现它们。

顺序包装器主体只包含在最终化边界之前已经被包含的用户语句。一个被排除的普通 import 只有在链接阶段 `execution_dependencies` 已经记录其目标必须执行时，才会保留一个合成初始化义务。被排除的 re-export 可能保留转发初始化义务，因为这些义务属于保留的导出契约。无论哪种情况，都不会把原始用户语句标记为已包含。

### Import overlay

将一个 importee 从急切执行改为顺序包装器，虽然其 importer 的用户语句不会变为存活，但仍会影响这些 importer。overlay 记录当前通过修改 `StmtInfo` 修复的合成后果：

- 包装器和命名空间符号引用；
- `ReExport` 和 `ToCommonJs` 运行时辅助工具；
- 动态导出 re-export 行为；
- importer 和 importee 的命名空间需求；
- 直接和传递性的初始化义务。

最终化和跨 chunk 链接会结合不可变的原始 import 记录读取 overlay。tree shaking 和用户语句包含关系从不读取它。

### 最终化器

模块最终化器有三个显式分支：

- 来自 `WrapKind::Cjs` 的 CJS interop 包装器；
- 来自 `WrapKind::Esm` 的 ESM interop 包装器；
- 来自 `OrderWrapState` 的执行顺序包装器。

执行顺序分支复用既有的上提 `function init_*()` 代码形状，从顺序状态获取其包装器符号，并从 `FinalEsmInitMetadata` 获取最终推导出的初始化事实。它从不观察被覆盖的 interop 类型。

被移除的用户 import/re-export 语句会和任何匹配的 `OrderImportOverlay` 一起最终化。最终化器可能会在被移除语句的源码位置发出一个合成初始化或 re-export 表达式，但不会恢复原始语句。

### 入口序言

入口渲染使用与模块最终化相同的初始化目标视图。顺序包装的入口会发出显式的初始化调用。内部使用的 interop 入口也会在其公开 facade 后保留一个无作用的实现 chunk。

### 拓扑

`OrderWrapState` 驱动模块和运行时的放置。严格 entry facade 也可以在没有顺序包装器的情况下改变拓扑。`finalize_chunk_plan()` 仍然是其后的边界，在此之后拓扑派生元数据即为最终结果。

## 数据流

```text
链接 + tree shaking
  -> 不可变的 LinkingMetadata 和执行依赖
  -> 临时 ChunkGraph
  -> OrderAnalysis / OrderWrapPlan
  -> 将计划降级为 OrderWrapState + 最终 ChunkGraph
  -> 使用 LinkingMetadata + OrderWrapState 计算 Sealed<FinalEsmInitMetadata>
  -> 使用 EsmInitTarget + Sealed<FinalEsmInitMetadata> 计算跨 chunk 链接
  -> 使用显式 interop/order wrapper 情况 + Sealed<FinalEsmInitMetadata> 完成模块最终化
  -> 使用共享的 EsmInitTarget 视图渲染入口 prologue
```

## 不变式

- 任何生成阶段调用都不能更改 `LinkingMetadata::wrap_kind()`。
- 任何顺序下调调用都不能设置用户语句包含位。
- 每个顺序包装器恰好有一个符号所有者和一个渲染块。
- 每个合成声明都参与符号到块的分配和去冲突。
- 每个导入叠层都由不可变的链接阶段执行依赖或保留的重新导出契约提供支持。
- 每个合成的 init 调用都引用一个可达的互操作或顺序包装器。
- 计划中的静态块 SCC 包含该 SCC 中每个符合条件的顺序敏感模块。
- 每个普通导入 init 义务都对应一个链接阶段执行依赖。
- 每个被排除语句的 init 义务要么是保留的重新导出义务，要么是由执行依赖支持的合成义务。
- 最终的跨块注册和最终化器发射要求相同的 `Sealed<FinalEsmInitMetadata>` 类型；预最终投影不能提供该类型，也不会消耗最终元数据。
- wrap-all 和 on-demand 保持相同的链接阶段语句和绑定活性；只有它们的包装器计划可能不同。
- 每个顺序包装的入口都具有显式的入口触发器。
- 关闭标志的构建不会创建任何顺序包装器或仅严格模式的入口面板。

## 验证

验证保持在可观察的编译器边界上，而不是深入到私有的 pass 状态中：

1. 真正的 `Bundler` 集成不变量覆盖了关闭标志时的旧版输出、字节级一致且无副作用的按需输出、wrap-all 行为、入口前导和 facade 放置、跨 chunk 的 init 定义，以及运行时 helper 闭包。
2. 扫描范围 fixture 套件中每一个预先存在的显式 strict 配置都有对应的按需版本。对输出敏感的单元会对两种模式进行快照，而已执行的 fixture 则断言相同的运行时行为和 tree-shaking 结果。
3. 定向 fixture 覆盖了保留的 barrel 和 namespace 路径、新出现的 chunk 循环、CJS init 导出、用户/动态/生成的入口 facade、合法的 TLA 输出，以及外部模块边界。
4. 外部差分 fuzz 测试器会比较普通源代码执行与生成的 wrap-all 和按需输出，覆盖 ESM、CJS、混合模块、压缩、包 side-effect 元数据、namespace 读取以及输出格式。
5. 完整的 Rust、Node、WASI、Vite、格式化、lint 和仓库验证仍然是合并门槛。

只有在移除 `override_wrap_kind()`、`hoist_esm_wrapper`，以及对 interop wrapper 字段的按顺序读取之后，迁移才算完成。
