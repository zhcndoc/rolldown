# Code Splitting

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

这里暂时还没有建模顶层 await 的细化处理。现有的 chunk 优化器在任何包含模块是 TLA 或包含 TLA 依赖时，仍会全局退出，因此等待中的动态导入安全路径仍是未来工作。

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

对每个公共 chunk，先把它的 `bits` 转换为 chunk 索引（比特位置会直接映射到 `ChunkIdx`），然后尝试将其合并到其中一个入口 chunk。若合并会导致以下情况，则会跳过：

- **在 chunk 之间创建循环依赖** —— 通过 `would_create_circular_dependency()` 中的 BFS 检查。这比 Rollup 更严格（Rollup 会警告但允许成环），并且与 esbuild 对无环静态 chunk 图的强制约束一致。
- **改变入口的导出签名** —— 当 `preserveEntrySignatures: 'strict'` 时，向入口 chunk 添加模块会暴露原入口未导出的符号。

合并的权衡在于：入口 chunk 可能会包含并非所有使用该入口的消费者都需要的模块。这会增加少量不必要的代码加载，但能显著减少 chunk 数量和 HTTP 请求数。

### Facade 消除（`optimize_facade_entry_chunks`）

当优化器把某个动态/发射出的入口的所有模块都拉入其他 chunk 后，它可能会变成一个空的 facade。优化器会识别这些情况，并且要么：

- 将该 facade 合并到其目标 chunk
- 在 `post_chunk_optimization_operations` 中把它标记为 `Removed`

### 运行时模块放置

Facade 消除会在合并阶段已经放置好运行时模块之后，产生**新的运行时助手消费者**。消除一个动态导入 facade 时，会在目标 chunk 上运行两个彼此独立、由 `wrap_kind` 门控的分支，并且任一分支都会把该 chunk 加入 `runtime_dependent_chunks`：

- `WrapKind::Esm | WrapKind::None` —— `include_symbol(module.namespace_object_ref)` 会具体化模拟的 namespace，并显式地向目标 chunk 的 `depended_runtime_helper` 中插入 `RuntimeHelper::ExportAll`（发射出的 JS 符号：`__exportAll`）。
- `WrapKind::Cjs | WrapKind::Esm` —— `include_symbol(wrapper_ref)` 会拉入 `require_xxx` 符号，该符号会通过已有的包含传播机制递归带入包装器依赖的任意 helper（例如 `RuntimeHelper::ToEsm`、`RuntimeHelper::CommonJsMin` 等，发射为 `__toESM`、`__commonJSMin`，……）。

`WrapKind::Esm` 会命中这两个分支，所以 ESM facade 既可能向同一个 chunk 添加 `ExportAll`，也可能添加由包装器驱动的 helper。

危险在于，运行时模块在合并阶段可能已经与某些宿主 chunk 中的其他模块**同位放置**（chunker 之所以把它放在那里，是因为宿主的 bitset 与运行时的 bitset 匹配）。如果新的 helper-import 边从某个 facade 消除消费者指回该宿主，而宿主又有任何到消费者的前向路径，那么依赖图就会闭合成环。有关标准复现案例请参见 [#8989](https://github.com/rolldown/rolldown/issues/8989)：

```
chunk(node2) ──forward──> chunk(node3) ──forward──> chunk(node4)
     ▲                                                   │
     └──────── facade 消除后的 helper 边 ───────────────┘
```

放置逻辑位于 `rehome_runtime_module`，它会在 `optimize_facade_entry_chunks` 发现 `runtime_dependent_chunks` 非空时被调用。它是一个由 chunk 间静态导入可达性驱动的**两步决策**：

**步骤 1 — 剥离决策（仅判断环风险）**

只有当宿主存在到某个非宿主的 facade 消除消费者的**静态前向路径**时，才把运行时从当前宿主 chunk 中剥离出来。这是形成回边环的先决条件：如果不存在这样的路径，那么无论把运行时放到哪里，新的 helper 导入都不可能闭合成环，因此最紧凑的布局就是保留在合并阶段已经放置的位置。可达性由 `chunk_reaches_via_static_import` 计算，它是一个只沿着仍然存活的目标 chunk 中 `ImportKind::Import` 边进行的 BFS。

当存在环风险且宿主还有其他模块时，实现在宿主的 `modules` vec 中通过 `swap_remove` 移除 `runtime_module_idx`（顺序不重要——`sort_chunk_modules` 之后会重新建立顺序），并设置 `module_to_chunk[runtime_module_idx] = None`。如果运行时是宿主 chunk 中唯一的模块，它会留在那里——该 chunk 本身已经是叶子，不可能参与成环，而剥离它会留下一个空 chunk，后续期望 `chunk.modules[0]` 的代码会因此出错。

**步骤 2 — 放置决策（支配者搜索）**

当运行时尚未被放置（要么因为步骤 1 剥离了它，要么因为合并阶段根本没有放置它）时，计算完整的消费者集合：

```
consumer_chunks = (非 Removed 且 depended_runtime_helper 非空的 chunk)
                ∪ runtime_dependent_chunks
                ∪ ({original_host} 如果 original_host 未被标记为 Removed)
```

第一项会收集在链接阶段就已经需要 helper 的 chunk；第二项会收集刚刚由 facade 消除新宣布需要 helper 的 chunk；第三项则把原始宿主重新加回去——合并阶段把运行时放在那里，是因为它的 bitset 需要它，因此它是一个隐式消费者。“未 Removed” 门控是防御性的：`apply_common_chunk_merges` 在宿主被合并进其他 chunk 时已经会重定向 `module_to_chunk`，所以实际上 `original_host` 会解析到一个仍然存活的 chunk。去重通过 `FxHashSet` 自动完成。

然后寻找一个**支配者**——即一个成员 C，使得所有其他消费者都能通过前向边静态到达 C。`find_consumer_dominator` 会用 `chunk_reaches_via_static_import` 检查每个候选者。若存在支配者，它就是消费者集合中的一个下游汇点：把运行时放在那里意味着每个其他消费者的 helper 导入都会沿着一条已有的前向边传播，因此不会新增回边，也就不会形成环。

- **找到支配者** → 运行时移动到该 chunk 中，不会创建额外 chunk。
- **没有支配者**（消费者处于并行子图中，或形成更复杂的形状）→ 运行时被放入一个新建的 `rolldown-runtime.js` chunk 中，该 chunk 使用运行时的 bitset 创建。所有消费者都从它导入。这个 chunk 在结构上是叶子——不是因为新建就不会有出边，而是因为运行时模块本身不包含任何 `import` 语句，所以分配到该 chunk 的唯一模块没有可被跨 chunk 链接器转换为出边导入的依赖。因此不可能形成环。

**为什么是这种形状**

仅依赖 `runtime_dependent_chunks.len()` 会低估情况——它忽略了链接阶段已经需要 helper 的 chunk 以及原始宿主。仅依赖消费者数量（把“单消费者”与“多消费者”情况分开）则会同时产生过度触发和触发不足：单个消费者仍然可能位于图的中间，并通过其他隐式消费者产生的回边形成环（见 [#8920](https://github.com/rolldown/rolldown/issues/8920) 的 fuzz 发现案例）；而多个消费者的集合可能天然存在一个下游汇点，可以零额外成本地承载运行时（见 [#8989](https://github.com/rolldown/rolldown/issues/8989)）。

支配者搜索通过直接问正确的问题统一了这两种情况：“是否存在一个所有消费者都已经能前向到达的 chunk？”如果有，就复用它；如果没有，就添加一个叶子。

**回归覆盖**

- `crates/rolldown/tests/rolldown/issues/8989/` —— 原始环。四个入口中，`node3` 动态导入 `node4`，而 `node1` 以 namespace 方式导入 `node2`。合并阶段把运行时放进了 `entry2`（它已经能通过 `entry3` 前向到达 `node4`）。存在环风险 → 剥离。支配者搜索选择 `node4`（叶子，所有消费者都能到达它）。断言覆盖了叶子不变量、`entry2 → node4` 的方向，以及 `node4` 承载运行时这一点。
- `crates/rolldown/tests/rolldown/issues/8920_2/` —— fuzz 发现的形状，之前的单消费者规则会静默地产生环。两个入口之间只有一个动态边；`node1` 是共享公共 chunk。合并阶段把运行时放在 `entry-2`，但 `entry-2` 没有静态出边——不存在环风险。运行时保留在 `entry-2`，它是 `{entry-2, node1}` 的支配者，因为 `node1 → entry-2` 已经是一条前向静态边。三个 chunk，没有发射 `rolldown-runtime.js`。

两个 fixture 都在 `_test.mjs` 中断言结构不变量，因此任何回归（例如退回到“单消费者就放自己”的规则，或者在不存在环风险时过度剥离）都会立刻失败，而不是只表现为一个快照 diff。

## 懒模块初始化顺序

`ensure_lazy_module_initialization_order()` 在 chunk 创建之后作为 `ChunkGraph` 的后处理步骤运行。它修复了包装模块在懒求值时的一个正确性问题。

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
require_leaflet_toolbar(); // 💥 这里 global.L  هنوز是 undefined
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

## ChunkGraph

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

- [rust-bundler](./rust-bundler.md) — 构建生命周期
- `crates/rolldown/src/stages/generate_stage/mod.rs` — 生成阶段入口点
- `crates/rolldown/src/stages/generate_stage/manual_code_splitting.rs` — 用户定义的 chunk 分组
- #8595 — 当存在外部入口时，由位位置 / chunk 索引不匹配导致的 bug
