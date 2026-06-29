# 代码拆分

## 总结

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
    └─ split_chunks()
         │
         ├─ determine_reachable_modules_for_entry()   每个入口执行 BFS，在可达模块上设置位
         │
         ├─ apply_manual_code_splitting()             用户定义的 chunk 组（manualChunks）
         │
         ├─ Module assignment         按相同 BitSet 分组模块 → chunks
         │
         └─ ChunkOptimizer           将公共 chunk 合并回入口 chunk，移除空的 facade
              │
              ▼
         ChunkGraph                   最终的模块到 chunk 分配

ChunkGraph 之后的处理（在 generate() 中）：

ChunkGraph
    │
    ├─ compute_cross_chunk_links()                    确定跨 chunk 的导入/导出
    │
    ├─ ensure_lazy_module_initialization_order()      重新排序包装模块的初始化调用
    │
    ├─ on_demand_wrapping()                           移除不必要的包装器
    │
    └─ merge_cjs_namespace()                          合并 CJS 命名空间对象
```

**关键文件：**

- `crates/rolldown/src/stages/generate_stage/code_splitting.rs` — 流程编排，`generate_chunks()`，`ensure_lazy_module_initialization_order()`
- `crates/rolldown/src/stages/generate_stage/dynamic_already_loaded.rs` — Rollup 风格的动态导入已加载原子缩减
- `crates/rolldown/src/stages/generate_stage/chunk_optimizer.rs` — 合并/优化
- `crates/rolldown/src/chunk_graph.rs` — 输出数据结构
- `crates/rolldown_utils/src/bitset.rs` — 紧凑的可达性表示
- `crates/rolldown/src/types/linking_metadata.rs` — `original_wrap_kind()`，用于初始化顺序分析

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

顶层 await 的细化故意还没有在这里建模。现有的 chunk 优化器在任何包含模块是 TLA 或包含 TLA 依赖时仍会全局退出，因此等待中的动态导入安全路径仍是未来工作。

## 可达性传播

`determine_reachable_modules_for_entry()` 会对每个入口模块运行 BFS，在每个可达模块上设置 `splitting_info[module].bits.set_bit(entry_index)`。遍历过程中会跳过外部模块（它们不是 `Module::Normal`）。

在处理完所有入口后，每个模块的 `bits` 编码了哪些入口可以到达它：

```
shared.js:    bits = 1111  （可从全部 4 个入口到达）
parser-a.js:  bits = 1010  （可从入口 1 和 3 到达）
entry-a.js:   bits = 0001  （仅可从入口 0 到达）
```

这等价于 Rollup 的“依赖入口集合”和 esbuild 的 `EntryBits`。关键洞见在于：具有相同 `bits` 的模块也具有相同的加载需求——它们总是一起需要，而不会单独需要——因此它们应该属于同一个 chunk。

## Chunk 创建

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

对每个公共 chunk，先把它的 `bits` 转换为 chunk 索引（比特位置会直接映射到 `ChunkIdx`），然后尝试将其合并到其中一个入口 chunk。若合并会导致以下情况，则会被跳过：

- **在 chunk 之间创建循环依赖** —— 通过 `would_create_circular_dependency()` 中的 BFS 检查。这比 Rollup 更严格（Rollup 只会警告但允许循环），并且与 esbuild 对静态 chunk 图无环性的强制约束一致。
- **改变入口的导出签名** —— 当 `preserveEntrySignatures: 'strict'` 时，将模块添加到入口 chunk 会暴露原始入口未导出的符号。
- **污染动态导入命名空间** —— 对于形成静态循环的动态入口，当非目标的待处理入口模块具有可观察导出时，不会非对称地合并。该检查使用关联的导出元数据，因此仅重新导出条目（`export * from ...`）与直接命名导出被视为相同。

合并的权衡在于：入口 chunk 可能会包含并非所有使用该入口的消费者都需要的模块。这会增加少量不必要的代码加载，但能显著减少 chunk 数量和 HTTP 请求数。

仅由动态入口共享的 chunk，优化器不会仅根据动态导入可达性来推断合并目标。同一个已加载入口发出的兄弟动态导入可以被独立请求，因此“入口能够到达两个 chunk”并不能证明其中任意一个动态 chunk 在另一个之前已经加载。在这种情况下，除非现有的静态导入合并目标检查证明存在安全目标，否则 Rolldown 会保留一个单独的公共 chunk。

### Facade 消除（`optimize_facade_entry_chunks`）

当优化器把某个动态/发射出的入口的所有模块都拉入其他 chunk 后，它可能会变成一个空的 facade。优化器会识别这些情况，并且要么：

- 将该 facade 合并到其目标 chunk
- 在 `post_chunk_optimization_operations` 中把它标记为 `Removed`

A **user-defined** entry can likewise become an empty facade when manual code splitting (a `codeSplitting` group, possibly via `entriesAware` subgroup merging) places its module into a common chunk. Folding that common chunk back into the entry chunk is only safe when the chunk does not also hold **another user-defined entry's module**. Otherwise the sibling entry would be forced to import this entry chunk just to reach its own module, and loading it would eagerly run this entry's top-level `init_*` — leaking its side effects into the sibling (visible under `strictExecutionOrder`). In that case the facade is kept so each entry imports the shared (wrapped) chunk and runs only its own `init_*`. See [#9463](https://github.com/rolldown/rolldown/issues/9463).

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
                ∪ facade-elimination consumers added during the current pass
```

大多数运行时辅助依赖在链接阶段、即 chunking 之前就已经知道，因此一旦 chunk 存在，这个消费者集合通常就是完整的。Facade 消除是个例外：把一个 facade 折叠进其目标 chunk，可能会通过 `optimize_facade_entry_chunks` 中两个受 `wrap_kind` 约束的路径之一，新增一个在早期 chunking 阶段不存在的 helper 边：

- **`WrapKind::Esm` / `WrapKind::None`** —— 动态 `import()` 位置仍然期望一个命名空间对象，因此被消除模块的模拟命名空间会被具体化（`include_symbol(namespace_object_ref)`），并且 `__exportAll`（`RuntimeHelper::ExportAll`）会插入到目标 chunk 的 `depended_runtime_helper` 中。
- **`WrapKind::Cjs` / `WrapKind::Esm`** —— `require_xxx` 包装器（`wrapper_ref`）会被包含进去，这会通过正常的包含传播递归拉入包装器所需的辅助函数——通常是 `__toESM`（`RuntimeHelper::ToEsm`）和 `__commonJSMin`（`RuntimeHelper::CommonJsMin`）。

`WrapKind::Esm` facade 会同时命中这两条路径。

只有当某个 chunk 带有非空的 `depended_runtime_helper`（或引用了运行时拥有的符号）时，它才会“消耗”运行时。因此，在一个链接时根本不需要任何辅助函数的构建中，之前没有任何 chunk 会消耗运行时——而上述某条路径可能会在早期 chunking 已经把运行时单独放置之后，首次创建一个消费者。为了保持这种放置决策的正确性，该阶段会恢复刚刚修改过的包含元数据，重新材料化独立运行时 chunk，并使用这些新增加的消费者（即上面消费者集合的最后一项）重新运行 `try_merge_runtime_chunk`。

合并目标不能创建静态循环，也不能为了访问辅助函数而强迫无关的入口 chunk 执行。候选目标按保守且保持紧凑性的顺序尝试：唯一的运行时消费者、唯一带运行时位集的活跃 chunk、与运行时位集相同的活跃公共 chunk，然后是消费者集合主导者。手动 code splitting / 高级 chunk 组 chunk 只有在该 chunk 是唯一的运行时消费者时才可承载运行时；否则，它们的内容是用户指向的分组输出，吸收运行时会让无关 chunk 为了辅助函数而加载该组。安全性通过沿着仍存活的 chunk 的静态加载边进行检查来保证。不会跟随动态导入；静态导入和 `require()` 记录都会被考虑，因为二者都可能在生成输出中变成静态 chunk 导入。包含顶层 await，或依赖顶层 await 的 chunk，只有在它们是唯一运行时消费者时才可作为运行时宿主；否则，一个动态导入的 chunk 若为了辅助函数而静态导入其等待中的导入者，可能会产生未稳定的异步模块循环。

- **找到安全目标** → 运行时移入该 chunk，空的独立运行时 chunk 被标记为已移除。
- **未找到安全目标** → 保持独立运行时 chunk。仅解析到外部模块的运行时导入会被忽略，不参与 chunk 循环检查；否则，仍然存活的内部运行时导入会让运行时保持独立。

**为什么是这种形状**

过去运行时会先通过普通 bitset 分组放置，随后在检测到循环时再剥离出来。这让每个优化器都必须理解运行时宿主的边缘情况。先独立放置改变了默认策略：初始布局始终是无循环风险的，而唯一与运行时相关的优化，就是最后可选地合并进一个已经证明是支配者的目标中。

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

由于 `lib.js` 出现在 bundle 中 `main.js` 之前，`require_leaflet_toolbar()` 会先运行——但它需要 `global.L`，而 `require_leaflet()` 还没有设置它：

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

当启用了 `strict_execution_order` 时，所有模块本来就已经被包裹，并且会按正确顺序执行，因此这个 pass 会完全跳过。

### 算法

该函数会遍历 `ChunkGraph` 中的每个 chunk，并执行六个步骤：

**步骤 1 — 找 DFS 根。** 入口 chunk 以入口模块作为根。公共 chunk 没有单一入口模块，因此根被计算为：在同一个 chunk 内，没有被任何其他模块通过 `ImportKind::Import` 导入的模块——也就是 chunk 内导入图的“顶部”。这些模块会在 chunk 加载时最先执行，因此它们是决定同步初始化顺序的 DFS 正确起点。根会按执行顺序排序，以确保遍历确定性。

**步骤 2 — 构建执行顺序映射。** 收集该 chunk 中所有模块的执行顺序，以及所有被导入符号的、来自其他 chunk 的已包裹模块。之所以需要这种跨 chunk 感知，是因为其他 chunk 中的已包裹模块仍然要求其 init 调用在当前 chunk 的依赖之前运行。

**步骤 3 — 通过 DFS（`js_import_order`）对模块分类。** 从根出发执行迭代 DFS，仅沿着 `ImportKind::Import` 边前进（跳过 `require()` 和 `import()`，因为它们本质上是懒的）。每个访问到的模块都会被分类为：

- `WrapKind::Cjs` 或 `WrapKind::Esm` → 放入 `wrapped_modules` 列表
- `WrapKind::None` → 记录在 DFS 顺序中它之前出现了多少个已包裹模块（它的“包裹依赖计数”）

这里使用 `LinkingMetadata` 中的 `original_wrap_kind()`，它保留了 `strictExecutionOrder` 之前的包裹类型。

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
