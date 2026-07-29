# 代码拆分

关于其原理和目标架构已记录在 [design.md](./design.md) 中。本文档描述的是当前实现：在生成阶段的顺序下沉中，包装器和导入器覆盖由 `OrderWrapState` 持有，而不会改变链接阶段的 `WrapKind` 或用户语句包含；最终的 interop/顺序初始化事实则分别封装在 `FinalEsmInitMetadata` 中。有一个严格模式例外仍保留在链接阶段：当启用 `strictExecutionOrder` 且配置了 `codeSplitting` 分组时，`wrap_modules` 会将 `WrapKind::Cjs` 强制应用于每个 CommonJS 模块，因为顺序下沉只包装 ESM 模块，而互操作规则会让一个没有任何人导入的 CommonJS 模块（cjs 输出中的 CommonJS 入口）保持 eager——否则一个同组模块会在加载另一个模块时运行其中一个入口的顶层代码。之所以在存在分组时才启用该包装，是因为只有分组才能把这样的模块移出它自己的入口 chunk；如果没有分组，原始主体放在原处是安全的，并且会保留该入口的 Node 模块契约（`module.filename`、`require.main === module`、`exports` 对象形状），而包装器的合成 `module`/`exports` 参数无法复现这一点。

## 摘要

代码拆分决定哪些模块会进入哪些输出 chunk。Rolldown 使用基于 BitSet 的可达性模型——这与 esbuild 和 Rollup 的基本方法相同。每个入口点都有一个位位置，模块会被标记为能够到达它们的入口集合，而可达性模式相同的模块会被分组到同一个 chunk 中。

## 为什么选择基于 BitSet 的可达性？

生态系统中的这三种代码拆分方案本质上都在解决同一个问题：给定 N 个入口点和 M 个模块，将每个模块恰好分配到一个 chunk 中，使得没有模块重复，并且每个入口都只加载它需要的模块。

**Webpack 的方法（基于约束的启发式）：** 使用 `SplitChunksPlugin` 以及可配置规则——`minSize`、`minChunks`、`maxAsyncRequests`、缓存组优先级。这给了用户最大的控制权，但也接受代码重复作为换取更少 HTTP 请求的代价。基于规则的系统无法保证零重复。

**Rollup 的方法（入口集合着色）：** 为每个模块构建一个 `Set<entryIndex>`，将具有相同集合的模块分组。使用 `BigInt` 位掩码进行高效集合运算。保证零重复。支持 `experimentalMinChunkSize` 用于合并小 chunk。

**esbuild 的方法（BitSet 可达性）：** 为每个入口分配一个位位置，在图中传播，按相同的 `BitSet` 分组。概念上与 Rollup 的着色相同，但在文件级别使用紧凑的按位运算实现。保证零重复。用户配置最少。

Rolldown 采用 esbuild/Rollup 模型，因为：

1. **保证零重复** —— 每个模块恰好出现在一个 chunk 中。不需要用户配置来避免重复陷阱。
2. **确定性输出** —— 相同输入总是产生相同的 chunk。没有需要调优的启发式阈值。
3. **性能** —— BitSet 运算（并集、交集、相等）每次操作的复杂度是 O(entries/64)，使得整体算法复杂度为 O(modules × entries)。这对大型代码库至关重要。
4. **Rollup 兼容性** —— 作为 Rollup 的继任者，匹配 Rollup 的拆分语义可以最大限度减少迁移阻力。

这种方法的取舍在于：当存在许多具有不同可达性模式的入口点时，可能会产生很多很小的 chunk。chunk 优化器（见下文）通过在安全的情况下把这些小的公共 chunk 重新合并回入口 chunk 来缓解这一问题。

## 其他打包器如何处理关键问题

| 问题                       | Rollup                                                  | esbuild                                                 | Rolldown                                                                         |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 共享模块检测               | 每个模块一个 `Set<entryIndex>`                          | 每个文件一个 `BitSet`                                   | 每个模块一个 `BitSet`                                                            |
| 独立 chunk 还是内联？      | 始终独立；使用 `experimentalMinChunkSize` 进行合并      | 始终独立；不合并                                         | 默认独立；优化器会将其合并到入口 chunk 中                                        |
| 循环 chunk 依赖            | 发出警告；允许循环 reexports                            | 强制静态 chunk 图无环                                   | 在每次合并前通过 `would_create_circular_dependency` 检查强制无环                   |
| 动态导入                   | 新入口点；计算“已经加载”的原子                          | 新入口点；重写为 chunk 唯一键                            | 新入口点；对空动态入口进行 facade 消除                                            |
| 外部模块                   | 从 chunk 图中排除                                        | 从打包中排除                                             | 在源头从入口列表中过滤掉（永远不会获得位位置）                                      |
| 粒度                       | 模块级                                                  | 文件级（曾经是语句级，但因 TLA 而退回）                  | 模块级                                                                           |

## 流程

入口点是 `code_splitting.rs` 中的 `generate_chunks()`，由 `GenerateStage::generate()` 调用。

```
generate_chunks()
    │
    ├─ init_entry_point()             分配位位置，创建入口 chunk
    │
    ├─ split_chunks()
    │    │
    │    ├─ determine_reachable_modules_for_entry()   为每个入口执行 BFS，为可达模块设置位
    │    │
    │    ├─ apply_manual_code_splitting()             用户定义的 chunk 组（manualChunks）
    │    │
    │    ├─ Module assignment         按相同的 BitSet 对模块分组 → chunks
    │    │
    │    ├─ ChunkOptimizer           将公共 chunk 合并到入口 chunk，移除空的 facade
    │    └─ try_merge_runtime_chunk() 可选地将独立的 runtime 合并到安全的宿主中
    │
    └─ Chunk exec-order assignment    → ChunkGraph    暂定的模块到 chunk 的分配

ChunkGraph 之后的处理（在 generate() 中）：

ChunkGraph
    │
    ├─ finalize_chunk_plan()
    │    ├─ finalize provisional namespace/external facts
    │    ├─ analyze_execution_order()                构建一个带有每个模块原因的 OrderWrapPlan
    │    ├─ apply_order_wraps()                      将计划降级为包装器和拓扑编辑
    │    │    └─ ensure_runtime_module_for_order_wraps()   重新放置 runtime，然后进行唯一消费者折叠
    │    ├─ recompute metadata if topology changed
    │    ├─ sweep_unused_runtime_module()            丢弃没有源需求或顺序状态需求的 runtime
    │    └─ validate final output shape
    │
    ├─ used_symbol_refs.seal()                        冻结活性分析；sweep 是最后一个写入者
    │
    ├─ compute_wrapped_esm_init_metadata()            生成 Sealed<FinalEsmInitMetadata>
    │
    ├─ compute_cross_chunk_links()                    确定跨 chunk 的 imports/exports
    │
    ├─ ensure_lazy_module_initialization_order()      重新排序包装模块的初始化调用
    │
    └─ merge_cjs_namespace()                          合并 CJS namespace 对象
```

**关键文件：**

- `crates/rolldown/src/stages/generate_stage/code_splitting.rs` — 管线编排，`generate_chunks()`，`ensure_lazy_module_initialization_order()`
- `crates/rolldown/src/stages/generate_stage/order_analysis.rs` — `strictExecutionOrder` 分析以及带理由的 `OrderWrapPlan`
- `crates/rolldown/src/stages/generate_stage/order_wrapping.rs` — 在 chunk 分配后应用顺序包装器
- `crates/rolldown/src/stages/generate_stage/order_wrap_state.rs` — 管理合成的包装器声明、导入者覆盖、namespace/runtime 需求，以及重新导出路由证据
- `crates/rolldown/src/stages/generate_stage/compute_wrapped_esm_init_metadata.rs` — 推导供 interop 和顺序包装器共享的、已封存的最终 no-op 和被排除语句的初始化事实
- `crates/rolldown/src/stages/generate_stage/finalize_chunk_plan.rs` — 输出元数据和校验之前的最终拓扑边界
- `crates/rolldown/src/stages/generate_stage/dynamic_already_loaded.rs` — Rollup 风格的 dynamic import already-loaded 原子缩减
- `crates/rolldown/src/stages/generate_stage/chunk_optimizer.rs` — 合并/优化
- `crates/rolldown/src/stages/generate_stage/runtime_module_sweep.rs` — 优化后的 runtime 需求清扫
- `crates/rolldown/src/chunk_graph.rs` — 输出数据结构
- `crates/rolldown_utils/src/bitset.rs` — 紧凑的可达性表示
- `crates/rolldown/src/types/linking_metadata.rs` — 不可变的链接阶段 `wrap_kind()`

Wrap-all（默认的严格模式）仅根据预期顺序为计划设种子，并跳过预测；`experimental.onDemandWrapping` 启用选择性分析。`finalize_chunk_plan` 可能运行两次元数据传递。namespace 使用和入口级 external re-exports 会先在暂定图上完成最终化；当顺序包装或严格入口 facade 改变拓扑时，它们会被重新计算。

`create_order_wrap_entry_facades` 和 `restore_order_wrap_entry_facades` 共享一次对活动动态导入者的、考虑语句的扫描。当一个纯动态入口具有 ESM init 目标，且每个仍然存活的调用点都可以被重写时，create 路径会避免生成一个仅严格模式使用的 facade（或者 restore 路径会让一个被优化器移除的 facade 保持死亡）：实现 chunk 会被标记为 common，`common_chunk_exported_facade_chunk_namespace` 请求 namespace 提取，而 `rewrite_dynamic_import_for_merged_entry` 会在每个调用点携带触发条件。带 TLA 污染的入口、可调用 `then` 的宿主 namespace、已发射/用户入口，以及任何具有入口级 external star 的入口都会保留一个真实 facade。将 external-star 入口转换为 common chunk 会移除该 facade 的格式特定合并。ESM 会失去其 chunk 级 `export *`；类 CJS 格式会用逐记录的 `__reExport` 调用替换去重后的 `Object.keys` 合并，而这在 primitive 模块值上也有所不同，并且 transitive star 根本无法从入口模块的直接记录中获得。chunk 的 `entry_level_external_module_idx` 覆盖直接和传递链，因此一个与格式无关的守卫可以保留这些接口中的全部内容。这个 external-star 守卫只在 create 路径生效；restore 路径依赖 chunk optimizer 的模拟 namespace 处理，其中 external-star 的保留是单独处理的。如果 restore 路径因为自身的折叠证明失败而已经复活了一个空 facade，那么 create 路径就不能把该 facade 重新分类为实现 chunk。

create 路径会在 `OrderWrapState` 中注册一个合成的 namespace 声明及其 runtime 需求，然后重新计算 runtime-symbol 闭包。该状态保存 `DynamicImportExportsUsage` 选中的精确导出名，以及其背后未内联的绑定。即使同一 canonical binding 的另一个别名在别处仍然存活，这些名字也会保持与被移除的 facade 完全相同的最终化结果；这些 binding 引用则允许正常的跨 chunk 链接在入口变成 common chunk 后导入每个 getter 目标。真实的语义 namespace 消费者会覆盖这种收窄，并保留完整接口。runtime 需求包含 `ExportAll`；那些本应需要 external-star 合并的入口会改为保留它们的 facade。模拟 facade 的 namespace 需求与语义 namespace 需求仍然分离，因此这不会把收窄后的 dynamic-import 接口变成一个不透明的 namespace 读取，也不会重新打开链接阶段的用户代码活性分析。

一旦最终拓扑和活性都固定下来，`compute_wrapped_esm_init_metadata` 会生成一个稀疏的 `Sealed<FinalEsmInitMetadata>`：模块条目的缺失表示默认的 no-op/empty-target 值，而不是 wrapper 的缺失。`Sealed<T>` 有一个私有字段和构造器，只暴露 `Deref`，既没有 `DerefMut` 也没有 unwrap 操作。最终的跨 chunk 链接和模块最终化都需要这种 sealed 类型，因此重新持有该工件不能重新开启可变性，而未封存的结果也无法到达任一消费者。更早的 `predicted_static_import_edges` 传递会明确将最终元数据标记为不可用，而不是制造一个空的 sealed 工件；其 Project 模式的义务遍历则保持独立且保守。

两种模式都消费同一份冻结的 tree-shaking 事实。`order_wrapper_is_reexport_transparent` 识别纯顺序包装器，它们只是初始化路由的中转点。随后 `collect_wrapped_esm_init_targets_for_import_record` 会按消费者解析义务：它会根据本地 facade 的活性过滤命名导入符，沿着 `OrderWrapState` 中记录的已消费 re-export facades 继续追踪，从包含的 `StmtInfo` 引用中解析静态 namespace 成员读取，只在不透明的 namespace 使用时展开全部导出，并应用与 inclusion 传递相同的常量内联绕过。这使 wrap-all 能输出更多 wrapper，而不会比 on-demand 保留或执行更多用户代码。

顺序规划会覆盖敏感后缀、依赖的导入者/读取者，以及任何已被该计划触及的静态 chunk SCC 中符合条件的敏感模块。在 `onDemandWrapping` 下，它接着运行 `order_analysis.rs` 中的 emergent-cycle 不动点（`post_lowering_import_edges`）：每一轮都把计划的 post-lowering `init_*` 转发边投影到来自 `predicted_static_import_edges` 的 pre-lowering 基线，然后为这些边闭合的 chunk cycle 中每个符合条件的模块加上包装，并重复直到风险集合不再增长（投影/省略的边来源清单见设计文档）。设置 `ROLLDOWN_ORDER_DEBUG=1` 可在 stderr 中输出每轮 SCC 计数和最终 wrap delta 的跟踪信息。

扫描器在不改变 tree-shaking 结果的前提下推导模块的内在顺序敏感性。普通的 `StmtEvalAnalyzer` 仍然是 `tree_shaking_flags` 的唯一生产者。仅对严格 on-demand 构建，当模块中某个尚未被认为敏感的语句在普通分析里没有被判定为顺序敏感时，会对它单独进行一次 eager-evaluation 理由遍历。该遍历会跟随顶层表达式、绑定默认值和计算属性键、立即调用的函数字面量（包括条件/逻辑/赋值形式的被调用者、直接调用的字面模板标签，以及直接 `new` 的类字面量在构造期的位置），以及 `manualPureFunctions` 覆盖的 call/new/tagged template；它会在普通函数和方法体以及未构造的实例初始化器处停止。与 `TopLevelImportReadDetector` 一样，它也遵守 `propertyReadSideEffects: false` 的文档化契约：通过已认证的属性读取触发的 getter 或 `Proxy` trap 对顺序分析保持不可见。这样的分离可防止 Oxc 在纯调用或属性操作上的合法 tree-shaking 早退出，掩盖掉顺序包装中的可观察全局读取；而默认构建、wrap-all 构建以及跨模块 tree-shaking 重新分析则继续沿用它们现有的快速路径和标志。

## 位位置和入口点

`init_entry_point()` 会遍历 `link_output.entries`（一个 `FxIndexMap<ModuleIdx, Vec<EntryPoint>>`），通过 `.enumerate()` 为每个入口分配一个顺序位位置：

```
entry_index 0  →  entry-a.js      →  bit 0  →  ChunkIdx(0)
entry_index 1  →  entry-b.js      →  bit 1  →  ChunkIdx(1)
entry_index 2  →  plugin.js       →  bit 2  →  ChunkIdx(2)
```

动态导入被视为入口点——它们会像静态入口一样获得位位置和入口 chunk。这与 Rollup 和 esbuild 的行为一致：动态 `import()` 会创建一个新的加载边界，因此被导入的模块需要自己的 chunk（或者必须合并进已有 chunk）。

外部模块在源头就被过滤掉了——它们永远不会出现在 `link_output.entries` 中。这是在 `module_loader.rs` 中完成的，其中动态导入被收集为入口点：外部模块会被排除在 `dynamic_import_entry_ids` 之外。用户定义的入口和已发出的入口也同样安全，因为 `load_entry_module()` 会使用 `entry_cannot_be_external` 拒绝外部解析。这与 esbuild 的方法一致，即外部模块永远不会进入入口列表，并且确保 **位位置直接等于 chunk 索引**——`ChunkIdx::from_raw(bit_position)` 始终有效。

参见 #8595，了解促成这一过滤的 bug。

### 动态已加载分析

在 chunk 实例化之前，Rolldown 可以为那些保证会被该动态入口的每个导入者加载的模块，减少其动态入口位。这个阶段通过 `experimental.chunkOptimization: { mergeCommonChunks, avoidRedundantChunkLoads }` 与公共 chunk 合并分开控制。布尔形式仍然是用于同时启用或禁用两个优化器的兼容别名，而对象形式允许分别控制每个阶段。例如，当 `main` 静态导入 `shared`，动态导入 `route`，并且 `route` 也导入 `shared` 时，在模块被分组到 chunk 之前，会从 `shared` 中移除 `route` 位。

该阶段会根据模块当前的依赖入口位集将模块分组成临时原子，计算每个入口静态加载的原子，然后对动态导入运行固定点传播。某个动态入口的已加载原子是所有能够到达其所包含动态导入者的入口的静态原子与已加载原子的交集。对于某个动态入口已加载的任何原子都可以移除该动态入口位，然后在正常 chunk 创建期间，模块会根据缩减后的位集重新分组。

当缩减后的位集会把某个原子放入单独的动态入口 chunk 时，该阶段会保留该动态入口可观察到的命名空间。只有在该原子没有额外导出、其导出已经是动态入口签名的一部分、它仅在运行时使用，或者它本身就是被移除的动态入口模块时，才接受这种缩减。否则，该原子会保持独立，这样 `import("./entry.js")` 就不会暴露仅被其他 chunk 需要的辅助导出。

每一次被接受的缩减也必须保持重分组后的静态原子图无环。“已经加载”并不总是意味着“已经初始化”：如果一个被缩减的原子被移动到一个静态导入其某个消费者的 chunk 中，ES 模块循环可能会暴露未初始化的绑定，包括 CJS 包装函数。

运行时可能会参与这种位缩减，但仅作为放置元数据。在手动和普通 chunk 材料化之前，它会被提取到一个独立的运行时 chunk 中，因此这个阶段不会把运行时代码分配给用户 chunk，也不需要特定于运行时的循环处理。

顶层 await 的细化故意还没有在这里建模。现有的 chunk 优化器在任何包含模块是 TLA 或包含 TLA 依赖时仍然会全局退出，因此等待中的动态导入安全路径仍是未来工作。

## 可达性传播

`determine_reachable_modules_for_entry()` 会对每个入口模块运行 BFS，在每个可达模块上设置 `splitting_info[module].bits.set_bit(entry_index)`。遍历过程中会跳过外部模块（它们不是 `Module::Normal`）。

在处理完所有入口后，每个模块的 `bits` 编码了哪些入口可以到达它：

```
shared.js:    bits = 1111  （可从全部 4 个入口到达）
parser-a.js:  bits = 1010  （可从入口 1 和 3 到达）
entry-a.js:   bits = 0001  （仅可从入口 0 到达）
```

这等价于 Rollup 的“依赖入口集合”和 esbuild 的 `EntryBits`。关键洞见在于：具有相同 `bits` 的模块也具有相同的加载需求——它们总是一起需要，而不会单独需要——因此它们应该属于同一个 chunk。

## Chunk Creation

在可达性传播之后，`split_chunks()` 会根据模块的 `bits` 模式将模块分配到各个 chunk：

1. `init_entry_point()` 已经以单比特模式创建好了入口 chunk
2. 对于每个非入口模块（按 `sorted_modules` 顺序迭代），查找 `bits_to_chunk[module.bits]`
3. 如果该模式对应的 chunk 已存在，就把模块添加进去
4. 否则，创建一个新的 `Common` chunk

具有相同可达性模式的模块总是会落到同一个 chunk 中。这是保证零代码重复的核心不变量——一个模块只会被发射一次，并且正好发射在与其可达性指纹匹配的 chunk 中。

## Chunk 优化器

如果不做优化，BitSet 方法会产生许多很小的公共 chunk（每种唯一的可达性模式一个）。例如，10 个入口点如果共享模式各不相同，可能会产生几十个微小 chunk。这是纯 BitSet 方法的主要缺点，而 webpack 的启发式系统避免了这个问题。

chunk 优化器会在安全时通过把公共 chunk 合并回入口 chunk 来减少 chunk 数量。它在一个临时的 `ChunkOptimizationGraph` 上操作，以便在不修改真实 chunk 图的情况下测试合并。

### 公共模块合并（`try_insert_common_module_to_exist_chunk`）

对于每个公共 chunk，首先将其 `bits` 转换为 chunk 索引（比特位置会直接映射到 `ChunkIdx`），然后尝试将其合并到其中一个入口 chunk。若合并会导致以下情况，则会被跳过：

- **在 chunk 之间创建循环依赖** —— 通过 `would_create_circular_dependency()` 中的 BFS 检查。这比 Rollup 更严格（Rollup 只会警告但允许循环），并且与 esbuild 对静态 chunk 图无环性的强制约束一致。
- **改变入口的导出签名** —— 当 `preserveEntrySignatures: 'strict'` 时，将模块添加到入口 chunk 会暴露原始入口未导出的符号。
- **污染动态导入命名空间** —— 对于形成静态循环的动态入口，当非目标的待处理入口模块具有可观察导出时，不会非对称地合并。该检查使用关联的导出元数据，因此仅重新导出条目（`export * from ...`）与直接命名导出被视为相同。

合并的权衡在于：入口 chunk 可能会包含并非所有使用该入口的消费者都需要的模块。这会增加少量不必要的代码加载，但能显著减少 chunk 数量和 HTTP 请求数。

仅由动态入口共享的 chunk，优化器不会仅根据动态导入可达性来推断合并目标。同一个已加载入口发出的兄弟动态导入可以被独立请求，因此“入口能够到达两个 chunk”并不能证明其中任意一个动态 chunk 在另一个之前已经加载。在这种情况下，除非现有的静态导入合并目标检查证明存在安全目标，否则 Rolldown 会保留一个单独的公共 chunk。

### Facade 消除（`optimize_facade_entry_chunks`）

当优化器把某个动态/发射出的入口的所有模块都拉入其他 chunk 后，它可能会变成一个空的 facade。优化器会识别这些情况，并且要么：

- 将该 facade 合并到其目标 chunk
- 在 `post_chunk_optimization_operations` 中把它标记为 `Removed`

A **用户定义的**入口同样也可能在手动代码拆分（一个 `codeSplitting` 组，可能通过 `entriesAware` 子组合并）把它的模块放入某个公共 chunk 后，变成一个空的 facade。只有当该 chunk **不同时持有另一个用户定义入口的模块** 时，把这个公共 chunk 折叠回入口 chunk 才是安全的。否则，兄弟入口就会被迫导入这个入口 chunk 才能到达它自己的模块，而加载它会提前执行这个入口的顶层 `init_*`——在 `strictExecutionOrder` 下会把它的副作用泄漏到兄弟入口中。在这种情况下，会保留 facade，这样每个入口都导入共享的（被包装的）chunk，并且只运行自己的 `init_*`。参见 [#9463](https://github.com/rolldown/rolldown/issues/9463)。

### 运行时模块放置

当启用代码拆分时，运行时模块会在手动和普通模块 chunking 之前被分配到一个专用的公共 chunk 中。该 chunk 使用普通 chunk 命名，并且不会注册到 `bits_to_chunk` 中，因此具有相同可达性位的其他模块无法被分组进去。手动 chunking 在递归依赖收集期间也会把运行时视为已经分配。于是，普通 chunking 和公共 chunk 合并阶段会在不携带运行时特定例外的情况下处理用户模块。

当禁用代码拆分时，Rolldown 不会提取独立的运行时 chunk。运行时保留在单一输出 chunk 中，这保留了 IIFE 和 UMD 等单文件格式。

这种“先独立放置”的策略是正确性的基线。运行时辅助函数的消费者会从包含运行时的那个 chunk 中导入诸如 `__exportAll` 之类的辅助符号。如果运行时与一个已经存在到其中某个消费者的前向静态路径的 chunk 共置，那么辅助导入可能会闭合一个静态循环。参见 [#8989](https://github.com/rolldown/rolldown/issues/8989) 的典型形状：

```
chunk(node2) ──forward──> chunk(node3) ──forward──> chunk(node4)
     ▲                                                   │
     └──────── facade 消除后的 helper 边 ───────────────┘
```

在 chunk 优化之后，`try_merge_runtime_chunk()` 可以在证明安全时把独立的运行时 chunk 折叠进一个现存的活跃 chunk。它从以下内容计算运行时消费者集合：

```
consumer_chunks = (non-removed chunks with non-empty depended_runtime_helper)
                ∪ chunks whose included statements reference runtime-owned symbols
                ∪ chunks containing modules that depend on the runtime module
                ∪ chunks containing wrapped modules or side-effectful runtime dependencies
                ∪ caller-supplied additional consumers
```

额外消费者通道承载的需求只有调用方可见：在 chunk 优化期间的 facade 消除消费者，以及下面后序下沉折叠中的顺序引入消费者。

大多数运行时辅助函数依赖在链接时、chunking 之前就已知，因此只要 chunk 存在，这个消费者集合通常就是完整的。facade 消除是例外：将 facade 折叠到其目标 chunk 中，可能会通过 `optimize_facade_entry_chunks` 中两个由 `wrap_kind` 保护的路径之一，添加一个早期 chunking 阶段不存在的 helper 边：

- **`WrapKind::Esm` / `WrapKind::None`** —— 动态 `import()` 位置仍然期望一个命名空间对象，因此被消除模块的模拟命名空间会被具体化（`include_symbol(namespace_object_ref)`），并且 `__exportAll`（`RuntimeHelper::ExportAll`）会插入到目标 chunk 的 `depended_runtime_helper` 中。
- **`WrapKind::Cjs` / `WrapKind::Esm`** —— `require_xxx` 包装器（`wrapper_ref`）会被包含进去，这会通过正常的包含传播递归拉入包装器所需的辅助函数——通常是 `__toESM`（`RuntimeHelper::ToEsm`）和 `__commonJSMin`（`RuntimeHelper::CommonJsMin`）。

`WrapKind::Esm` facade 会同时命中这两条路径。

只有当某个 chunk 带有非空的 `depended_runtime_helper`（或引用了运行时拥有的符号）时，它才会“消耗”运行时。因此，在一个链接时根本不需要任何辅助函数的构建中，之前没有任何 chunk 会消耗运行时——而上述某条路径可能会在早期 chunking 已经把运行时单独放置之后，首次创建一个消费者。为了保持这种放置决策的正确性，该阶段会恢复刚刚修改过的包含元数据，重新材料化独立运行时 chunk，并使用这些新增加的消费者（即上面消费者集合的最后一项）重新运行 `try_merge_runtime_chunk`。

合并目标不能创建静态循环，也不能为了访问辅助函数而强迫无关的入口 chunk 执行。候选目标会按尽量保持紧凑性的顺序尝试：单一运行时消费者、单一带运行时位集的活跃 chunk、同一运行时位集的活跃公共 chunk，然后是消费者集合的支配者。调用方决定这个级联可以深入到什么程度（`RuntimeMergeCascade`）：chunk 优化期间的两次合并尝试都会使用完整级联，而下面的后序下沉折叠会在单一消费者步骤后停止。手动代码拆分 / 高级 chunk 分组 chunk 只有在该 chunk 是唯一运行时消费者时才能承载运行时；否则，其内容是面向用户的分组输出，吸收运行时会使无关 chunk 为了辅助函数而加载该分组。安全性通过沿着仍然存活的 chunk 之间的静态加载边来检查。不会跟随动态导入；静态导入和 `require()` 记录都会被考虑，因为它们都可能在生成输出中变成静态 chunk 导入。包含顶层 await，或依赖顶层 await 的 chunk，只有在它们是唯一运行时消费者时才是运行时宿主；否则，一个动态导入的 chunk 若为了辅助函数而静态导入其正在等待的导入者，可能会产生未完成的异步模块循环。

- **找到安全目标** → 运行时移入该 chunk，空的独立运行时 chunk 被标记为已移除。
- **未找到安全目标** → 保持独立运行时 chunk。仅解析到外部模块的运行时导入会被忽略，不参与 chunk 循环检查；否则，仍然存活的内部运行时导入会让运行时保持独立。

### 后置排序提升运行时折叠（`ensure_runtime_module_for_order_wraps`）

排序提升可能会使上面的合并所决定的位置失效。合成包装器和导入器覆写会增加只存在于 `OrderWrapState` 中的辅助需求，而不会写入链接阶段元数据，因此一个在提升前没有需求的 chunk，可能会变成消费者——而这个新的消费者又可能与运行时当前宿主处于静态循环中。因此，在启用代码分割时，`ensure_runtime_module_for_order_wraps` 会在 `apply_order_wraps()` 结束时恢复“独立优先”的基线：如果运行时被放在用户 chunk 中，就会被驱逐到一个新的独立 chunk；如果运行时之前从未被放置过，则会被独立地实体化。（在禁用代码分割时，上面的单 chunk 放置保持不变。）这些（重新）生成的 chunk 会携带合成的全活跃并集位，因此它们会作为通用来源进行排序和命名；这些位并不是可达性事实。

如果无条件驱逐，会永久拆分那些提升前合并已经证明安全的布局（#10294）。因此，该阶段的每个出口——保留独立运行时、驱逐共宿运行时、或新实体化运行时——都会针对提升后的消费者集合重新运行 `try_merge_runtime_chunk`（`fold_runtime_chunk_after_order_lowering`）。排序引入的消费者来自 `OrderWrapState::runtime_helper_consumer_chunks`：一个合成的 `init_*` 声明会在其分配的 chunk 中消费辅助代码，而一个导入器覆写则会在导入器的 chunk 中消费它们，因为其提升后的导入胶水会在那里渲染。它们通过额外消费者通道传入；提升前的需求会由合并本身重新扫描，因此证明看到的是完整的提升后消费者集合。保留独立运行时的出口也会重新运行该证明，因为提升期间的入口门面恢复可能会把提升前合并曾计为消费者的 chunk 变成墓碑——此时可能只剩一个消费者存在。

这个折叠的范围故意比优化阶段的合并更窄：

- **仅限唯一消费者宿主（`RuntimeMergeCascade::SingleConsumerOnly`）。** 执行顺序和 order-wrap 计划都已经固定。任何其他宿主都会创建或重排排序分析从未建模过的 chunk 执行边：支配合并会把传递可达性变成对辅助导入的直接导入，而其执行顺序排序位置可能会把宿主提升到兄弟导入之前；而位集宿主可能会获得一条全新的消费者边。仅合并到唯一消费者，只会移除该消费者到仅运行时 chunk 的边——不会引入新边，也不会重排序。
- **仅限 ESM 输出。** 在 CJS 输出下，`compute_cross_chunk_links` 之后会给每个 ESM 导出入口 chunk——包括在提升过程中生成的零模块门面——一个在折叠时不可见的推测性 `__toCommonJS` 需求，因此一个没有可见需求的 chunk 可能会被赋予一条指向用户 chunk 的全新 require 边。其他格式则保留独立或被驱逐后的布局。
- **不做位并集。** 完整的级联会把运行时 chunk 的位并入宿主，使这些位保持精确的可达性记录。这里运行时 chunk 的位是上面的合成全活跃并集；如果把它们并入，会扩展宿主的位，而这会通过基于位的 chunk 名称对用户可见。唯一消费者宿主保留自己的位。

**回归覆盖：** `crates/rolldown/tests/rolldown/issues/9463/` 和 `issues/9463_plain_group/` —— 无论在两个配置单元中，运行时都会折叠进唯一消费者 `common~a~b~shared`，而不是作为仅辅助 chunk 单独输出；`issues/10265/` 和 `optimization/chunk_merging/dynamic_entry_merged_in_user_defined_entry/` —— 唯一需求是由排序引入的（合成 `init_*` 包装器），运行时会折叠进承载它们的 chunk，而后者的 cjs 单元通过保留独立的 `rolldown-runtime.js` 来钉住仅限 ESM 的门槛；`function/experimental/strict_execution_order/` 的快照则在 wrap-all 和按需包装下钉住折叠后的布局（`top_level_await_syntax` 钉住了 TLA 唯一消费者的情形）。

### 未使用运行时清扫 (`sweep_unused_runtime_module`)

Tree-shaking 会在 chunk 存在之前、链接时把运行时辅助函数纳入进来，而其中一些依据是保守的：以外部模块结尾的星号重新导出链会注册 `__reExport`/`__exportAll` 的需求，而只有 chunking 才能使其失效。`find_entry_level_external_module` 会执行这段回溯（把链条压平为 chunk 级别的 `export * from '<external>'` 语句，并把跨越式星号导入者上的 `has_dynamic_exports` 重新传播为 `false`），而 `finalized_module_namespace_ref_usage` 则会移除只服务于这条链的命名空间对象。最终的 finalizer 因此不会发出任何辅助函数调用——但运行时模块早已被包含并放置，所以它过去会作为一个死 chunk 连同裸导入一起被产出（[#9374](https://github.com/rolldown/rolldown/issues/9374)、[#7233](https://github.com/rolldown/rolldown/issues/7233)）。

`sweep_unused_runtime_module`（位于 `runtime_module_sweep.rs`）弥补了这个缺口。它在 `finalize_chunk_plan()` 的尾部附近运行，位于 `try_merge_runtime_chunk`、顺序下移以及最终的命名空间/外部模块回溯之后，但在 liveness 被封口以及跨 chunk 链接被推导之前。它从与模块 finalizer 生成结果相同的、回溯之后的事实中重新推导运行时需求，途径有四个源模块通道：每模块的 `depended_runtime_helper` 标志（将 `ReExport` 视为不计入，除非某个被包含的 `export * from './normal'` 导入对象仍然具有 `has_dynamic_exports`——这正是 finalizer 检查的条件；CommonJS 导入对象始终保留它）、由 `namespace_included` 保护的命名空间对象通道（与 finalizer 共享 `LinkingMetadata::ns_star_external_re_export_emitted`，因此预测不会与发射结果分叉）、被包含语句引用的运行时拥有符号，以及 `referenced_symbols_by_entry_point_chunk`。如果 `OrderWrapState` 报告了合成的运行时辅助函数需求，那么该清扫会保守地跳过，因为这类需求并不位于链接阶段元数据中。

该清扫过程是**全有或全无且保守的**：任何剩余需求，或者任何回退条件（tree-shaking 被禁用、运行时未被包含、运行时在开发/HMR 模式下具有副作用），都会让一切保持与 tree-shaking 结果完全一致。只有零需求的运行时才会被取消包含：其语句/模块包含状态会被清除，其符号会通过 `remove_owned_by` 从 `used_symbol_refs` 中删除，它会从所属 chunk 中移除，而现在为空的 chunk 会被用 `PostChunkOptimizationOperation::Removed` 标记为墓碑化。

**清扫所依赖的 liveness 不变量。** 对运行时符号的陈旧引用会按设计在清扫后保留——不会渲染的命名空间语句会保留它们的 `__exportAll` 引用，chunk 级的 `depended_runtime_helper` 位会保留它们的标志，而 `compute_cross_chunk_links` 会为 CJS 格式的 ESM 入口推测性地插入 `__toCommonJS`。在成为导入或导出之前，所有这些都会先与 `used_symbol_refs` 过滤，因此真正切断每一条跨 chunk 边的，是清除运行时的符号。每个裸导入发射器都能容忍 `module_to_chunk == None`，而命名/渲染过程本来也会跳过墓碑化的 chunk（这与 chunk 优化器的移除所使用的生命周期相同）。如果清扫在临时执行顺序分配之后移除了运行时，`finalize_chunk_plan()` 会重新推导 chunk 的 `exec_order`，然后重建存活的已排序 chunk 列表。仅仅对现有值重新排序并不够，因为运行时可能只是与一个仍然存活的 `Common` chunk 同宿：`Common` chunk 以 `modules[0]` 为键，而运行时占用了这个位置，所以否则该 chunk 会保留一个从它刚失去的模块推导出的 `exec_order`，并排在它本应跟随的 chunk 之前。入口 chunk 则以其入口模块为键，因此失去运行时不会移动它。该清扫仍然是 `used_symbol_refs` 的**最后写入者**：`generate()` 会在 `finalize_chunk_plan()` 返回后立即封口 builder。

**回归覆盖：** `crates/rolldown/tests/rolldown/issues/9374/`（快照断言：多入口 star-to-external 链不会产生运行时 chunk，`minify: false` 以便多余的命名空间声明也能暴露出来）；issues `6992`、`7115`、`7233`、`7233_chain` 在 `preserveModules` 下为 ESM 和 CJS 输出覆盖了同一类问题；`crates/rolldown/tests/rolldown/topics/runtime/sweep_shared_chunk_exec_order/` 锁定了上文的 exec-order 重新推导（`artifacts.snap` 中 `entry_a.js` 顶部发出的两个 import 的顺序就是全部断言——交换它们就意味着回归又回来了）。

**为什么是这种形状**

Runtime 过去会先由常规 bitset 分组放置，之后在检测到循环时再被剥离出来。这让每个优化器都必须理解 runtime-host 的边界情况。Standalone-first 翻转了默认策略：初始布局总是循环安全的，而与 runtime 相关的处理被限制在三个最终 pass 中——先在 chunk 优化之后可选地合并到一个已证明的 host 中，然后在顺序下移之后重新放置并折叠唯一消费者，最后在 entry-level-external 回溯已经稳定最终会发出的内容之后执行未使用运行时清扫。

**回归覆盖**

- `crates/rolldown/tests/rolldown/issues/9401/` — `avoidRedundantChunkLoads` 不能把运行时移入用户入口并制造辅助函数循环。
- `crates/rolldown/tests/rolldown/issues/8989/` — facade 消除会引入辅助函数消费者；运行时只能合并到下游支配者中。
- `crates/rolldown/tests/rolldown/issues/8920_2/` — fuzz 发现的形状中，基于消费者数量的启发式会产生循环。
- `crates/rolldown/tests/rolldown/issues/9597/` — 一个静态 + 动态导入循环，以前会把运行时 chunk 放进循环中，导致 `__exportAll is not a function`；先独立放置可将运行时排除在循环之外。

这些 fixture 在 `_test.mjs` 中断言结构不变量，因此运行时放置回归会立即失败，而不会只表现为快照漂移。

## 懒模块初始化顺序

`ensure_lazy_module_initialization_order()` 会在 chunk 创建后作为 `ChunkGraph` 的后处理步骤运行。它修复了包装模块在懒求值时的一个正确性问题。

### 问题

当没有启用 `strict_execution_order` 时，CJS 模块会被包裹进 `__commonJSMin()`，其主体直到包装器的 init 函数（`require_xxx()`）被显式调用时才执行。一些 ESM 模块也可能被包裹进 `__esm()`（例如存在循环依赖或 TLA 的模块），但大多数 ESM 模块仍然不加包裹——它们的顶层代码会按在 bundle 中出现的顺序立即执行。

在作用域提升期间，每个 `require_xxx()` init 调用都会被放在 CJS 模块第一次被引用的位置。这个默认放置方式在未包裹的 ESM 模块引用了两个不同的、彼此存在依赖关系的包裹 CJS 模块时，可能产生错误的初始化顺序。

根本原因在于模块在 bundle 中的布局方式。链接阶段的 `sort_modules()`（位于 `sort_modules.rs`）会通过对导入图做 DFS 来计算全局执行顺序——在这个分析中，`require()` 被视为隐式静态导入，因此被 require 的模块会排在其 requirer 之前。随后模块会按这个顺序发射。对于**被包裹**的模块（CJS/ESM），在该位置上只会放置包装器定义；真正的 init 调用（`require_xxx()`）会放在该模块第一次被**未包裹**模块引用的位置。当两个被包裹模块分别被不同的未包裹模块引用时，init 调用最终可能处在错误的相对顺序中。

注意：`sort_modules()` 和 `js_import_order()`（如下所述）是两个不同的 DFS 分析，遍历规则也不同。`sort_modules()` 同时沿着 `import` 和 `require()` 边来确定全局执行顺序。`js_import_order()` 只沿着 `import` 边，因为它专门分析**同步**初始化——`require()` 调用会生成懒包装器，不会参与同步初始化顺序。

考虑这个例子（基于 [#5531](https://github.com/rolldown/rolldown/issues/5531)）：

```js
// leaflet.js（CJS → 包裹）
global.L = exports;
exports.foo = 'foo';

// leaflet-toolbar.js（CJS → 包裹，读取 global.L）
global.bar = global.L.foo;

// lib.js（ESM → 不包裹，内部使用 require）
require('./leaflet-toolbar.js');

// main.js（ESM → 不包裹）
import './leaflet.js';
import './lib.js';
assert.equal(bar, 'foo');
```

从 `main.js` 出发的 `sort_modules()` DFS 得到：`leaflet(1) < leaflet-toolbar(2) < lib(3) < main(4)`。执行顺序正确地把 `leaflet` 放在 `leaflet-toolbar` 之前。但在 bundle 输出中，由于二者都是**包裹**的，它们的包装器定义只是无害的函数声明——真正重要的是 init 调用落在哪里：

- `lib.js`（exec_order 3，未包裹）通过 `require()` 引用了 `leaflet-toolbar` → `require_leaflet_toolbar()` 被放在这里
- `main.js`（exec_order 4，未包裹）通过 `import` 引用了 `leaflet` → `require_leaflet()` 被放在这里

由于 `lib.js` 出现于 bundle 中 `main.js` 之前，`require_leaflet_toolbar()` 会先运行——但它需要 `global.L`，而 `require_leaflet()` 还没有设置它：

```js
// ❌ 错误输出：require_leaflet_toolbar() 在 require_leaflet() 之前运行
//#region lib.js
require_leaflet_toolbar(); // 💥 这里的 global.L 仍然是 undefined
//#endregion
//#region main.js
var import_leaflet = require_leaflet(); // 太晚了——toolbar 已经失败
assert.equal(bar, 'foo');
//#endregion
```

注意：如果 `main.js` 直接导入 `leaflet-toolbar.js`（而不是通过 `lib.js` 作为中介），那么两个 init 调用都会落在同一个模块区域中，rolldown 会正确地排序它们。只有当 init 调用被拆分到不同的未包裹模块中时，问题才会出现。

**有了**这个 pass，`require_leaflet()` 会从 `main.js` 转移到 `lib.js` 区域之前：

```js
// ✅ 正确输出：require_leaflet() 在 require_leaflet_toolbar() 之前运行
//#region lib.js
require_leaflet(); // ← 由 insert_map 转移到这里
require_leaflet_toolbar();
//#endregion
//#region main.js
assert.equal(bar, 'foo'); // 这里的 require_leaflet() 已被 remove_map 移除
//#endregion
```

该函数会在每个 chunk 上构建 `insert_map` 和 `remove_map`，把 init 调用从默认位置移动到正确位置。`remove_map` 会抑制原始位置上的 init 调用；`insert_map` 会把它前置到需要它的模块之前。

当启用 `strict_execution_order` 时，order plan 会包装需要调度的 eager carrier，并对其依赖的 reader/importer 进行闭包捕获。该计划会负责该输出的懒初始化顺序，因此这里会完全跳过这个 pass。

### 算法

该函数会遍历 `ChunkGraph` 中的每个 chunk，并执行六个步骤：

**步骤 1 — 找 DFS 根。** 入口 chunk 以入口模块作为根。公共 chunk 没有单一入口模块，因此根被计算为：在同一个 chunk 内，没有被任何其他模块通过 `ImportKind::Import` 导入的模块——也就是 chunk 内导入图的“顶部”。这些模块会在 chunk 加载时最先执行，因此它们是决定同步初始化顺序的 DFS 正确起点。根会按执行顺序排序，以确保遍历确定性。

**步骤 2 — 构建执行顺序映射。** 收集该 chunk 中所有模块的执行顺序，以及所有被导入符号的、来自其他 chunk 的已包裹模块。之所以需要这种跨 chunk 感知，是因为其他 chunk 中的已包裹模块仍然要求其 init 调用在当前 chunk 的依赖之前运行。

**步骤 3 — 通过 DFS（`js_import_order`）对模块分类。** 从根出发执行迭代 DFS，仅沿着 `ImportKind::Import` 边前进（跳过 `require()` 和 `import()`，因为它们本质上是懒的）。每个访问到的模块都会被分类为：

- `WrapKind::Cjs` 或 `WrapKind::Esm` → 放入 `wrapped_modules` 列表
- `WrapKind::None` → 记录在 DFS 顺序中它之前出现了多少个已包裹模块（它的“包裹依赖计数”）

使用链接阶段 `LinkingMetadata` 中不可变的 `wrap_kind()`。

**步骤 4 — 确定需要检查的模块。** 收集所有存在包裹依赖的未包裹模块，以及它们依赖的包裹模块（最多到最大依赖计数）。如果这个集合为空，则无需重排，函数直接返回。

**步骤 5 — 找到首个 init 位置。** 按顺序遍历 chunk 模块并扫描导入记录。对检查集合中的每个模块，记录首次导入它的 `(importer, import_record_idx)`。一旦所有位置都找到就提前停止。

**步骤 6 — 构建转移映射。** 按执行顺序对 init 位置排序，然后迭代：

- **包裹模块** → 加入 `pending_transfer`
- **未包裹模块** → 从 `pending_transfer` 中取出匹配的包裹模块，并构建：
  - `insert_map[module_idx]` → 需要在此模块输出之前前置的 init 调用
  - `remove_map[importer_idx]` → 需要从原始位置移除的 init 调用

有一个保护措施可以防止把 init 调用从低执行顺序模块转移到高执行顺序模块，这样会错误地重排执行顺序。

### 辅助函数：`js_import_order()`

从 chunk 的根开始进行迭代 DFS。只沿着 `ImportKind::Import` 边前进——`require()` 和 `import()` 本质上是懒的，因此它们不参与同步初始化顺序。返回 DFS 访问顺序中的模块。

### 输出：`insert_map` 和 `remove_map`

这些映射存储在每个 `Chunk` 上，并在模块最终化期间被消费：

- **`remove_map`** —— 在 `finalizer_context.rs` 中读取。`ScopeHoistingFinalizer` 会检查当前模块的哪些导入记录应该抑制其 init 调用（该 init 调用正被移动到别处）。
- **`insert_map`** —— 在 `finalize_modules.rs` 中读取。对于每个目标模块，来自原始位置的渲染后 init 调用字符串会通过 `PrependRenderedImport` 变更前置到模块输出中。

```rust
// 在 Chunk 上（位于 rolldown_common::chunk）
pub insert_map: FxHashMap<ModuleIdx, Vec<(ModuleIdx, ImportRecordIdx)>>,
pub remove_map: FxHashMap<ModuleIdx, Vec<ImportRecordIdx>>,
```

## 块图

```rust
pub struct ChunkGraph {
    pub chunk_table: ChunkTable,                    // IndexVec<ChunkIdx, Chunk>
    pub module_to_chunk: IndexVec<ModuleIdx, Option<ChunkIdx>>,
    pub entry_module_to_entry_chunk: FxHashMap<ModuleIdx, ChunkIdx>,
    pub post_chunk_optimization_operations: FxHashMap<ChunkIdx, PostChunkOptimizationOperation>,
    // ...
}
```

- `chunk_table` — 所有 chunk，按 `ChunkIdx` 索引。由于重新索引代价较高，可能包含已移除的 chunk（在 `post_chunk_optimization_operations` 中标记）。
- `module_to_chunk` — 每个模块属于哪个 chunk。O(1) 查找。

## 相关

- [rust-bundler](../rust-bundler/implementation.md) — 构建生命周期
- `crates/rolldown/src/stages/generate_stage/mod.rs` — 生成阶段入口点
- `crates/rolldown/src/stages/generate_stage/manual_code_splitting.rs` — 用户定义的 chunk 分组
- #8595 — 当存在 external entries 时，由 bit 位置 / chunk 索引不匹配引起的 bug
