# 运行时辅助工具

## `__commonJS` 和 `__commonJSMin`：初始化后释放 `cb`

在任一辅助函数中首次调用后，`mod` 已被设置，且不会再访问 `cb`。如果不显式执行 `cb = null`，工厂函数就会永久保留在闭包中——这会导致长生命周期进程中的内存泄漏（例如通过 `vm.createContext` 加载 bundle 的 SSR 服务器）。

参考：https://github.com/rolldown/rolldown/issues/9063

## `__toESM`：决定外部模块的互操作方式

`require("external")` 返回原始的 CommonJS 导出，因此每当 bundle 以 _ES module_ 的方式读取它时——`import * as ns` 或 `ns.default`——非 ESM 格式都必须通过 `__toESM` 处理。仅导入命名导出的情况会直接读取 CommonJS 对象，不能进行包装。

陷阱在于，这个问题无法根据 chunk 自身模块携带的静态导入来回答。`import d from 'external'; export { d }` 会将 shim 的符号链接到一个 `NamespaceAlias`，因此 tree-shaking 会沿着别名直接追踪到外部命名空间，而不会将声明该 shim 的语句加入队列。当外部模块没有副作用时，shim 会被完全删除，而它生成的 `<external_ns>.default` 引用仍会在其他位置存活。此时从 `chunk.direct_imports_from_external_modules` 推导 `needs_interop`，对于最终仍会对其渲染 `.default` 的 chunk 会给出“否”——从而生成一个静默错误的 bundle（issue #10069）。

因此，**纳入阶段会记录它**（`note_external_interop_use`），因为这是链接解析引用之后唯一会遍历该引用的地方。三个消费者会将该记录 OR 到各自基于 `named_imports` 推导的结果中：cjs 渲染器、iife/umd 渲染器，以及 chunk 去冲突器的混合模式命名——全部通过 `chunk_recorded_external_interop` 完成。

导入者可能已失效，这会带来两点影响：

- **保持辅助函数存活。** `RuntimeHelper::ToEsm` 通常由导入语句请求，因此会随持有它的模块一起消亡。只要记录了任何互操作使用，`include_statements` 就会重新添加它；而 `patch_module_dependencies` 则从引用而非导入者推导运行时的 _edge_——这也包括仅作为入口导出存在的引用（`referenced_symbols_by_entry_point_chunk`）。这些引用在其他情况下对语句遍历不可见，导致 chunk 发出一个它从未导入的辅助函数。
- **Node 模式的来源信息。** 当导入模块的定义格式是 ESM 时，`__toESM(mod, 1)` 才会生效。链接会将重新导出链折叠到外部模块的命名空间符号上，因此到达纳入阶段的引用可能属于下游数跳之外的消费者；导入模块会通过遍历符号链接链（`external_import_writer`）恢复。

纳入发生在分块之前，因此记录不能直接命名一个 chunk。它改为存储**观察者**——即其纳入代码持有存活引用的模块——渲染时再通过 `ChunkGraph::module_to_chunk` 将其解析为 chunk。观察者特意不是导入者：导入者通常正是会被删除的 shim，而观察者必然包含已纳入的代码，因此一定会落入某个 chunk。

随后，`chunk_recorded_external_interop` 会按 chunk 回答以下问题：

- **哪些 chunk 需要包装。** 只有观察者所在的 chunk 才需要包装。仅包含同一外部模块的命名导入的 chunk 会直接读取 CommonJS 对象。对其进行包装并不会破坏值读取——`__copyProps` 会安装转发 getter——但 `__toESM` 会返回一个新对象（`__create(__getProtoOf(mod))`），并主动遍历 `__getOwnPropertyNames`/`__getOwnPropertyDescriptor`，改变命名空间身份和描述符形状，同时还会在基于 Proxy 的导出上触发额外的 `ownKeys` 陷阱。
- **使用哪种模式。** 模式是按观察者聚合的，而不是在整个 bundle 范围内聚合的。分别将同一外部模块导入不同 chunk 的 `.mjs` 和 `.js` 模块，各自只会以一种模式观察它；如果在整个 bundle 范围内合并，两者都会看起来像混合模式，并为同一个存活绑定发出 `__toESM(mod, 1)` _和_ `__toESM(mod)`，从而将该主动遍历执行两次。

最终没有存活 chunk 的观察者无法归属，因此每个发出该外部模块的 chunk 都会遵循它——但只贡献该观察者的模式，而不是整个 bundle 的并集。这个回退机制至关重要：将其范围缩小会导致低估，而这正是 #10069 的成因。

进行包装的 chunk 还需要在其依赖符号中包含 `__toESM`，并且这两个决策必须一致。过度提供会增加输出：一个获得该 edge 但不进行包装的模块，会将 `__toESM` 放入其 chunk 的依赖符号中，生成的跨 chunk 导入会失去与 DCE 的绑定，而具有副作用的运行时 chunk `require` 仍会存活——最终得到一个没有任何调用者的辅助函数的裸 `require("./rolldown-runtime.js")`。提供不足则更糟：进行包装的 chunk 没有该 edge，却引用了一个自己从未导入的辅助函数，最终化在查找缺失的跨 chunk 绑定时会 panic。

它们之所以一致，是因为包装恰好通过**两条通道**到达，而每条通道都携带自己的 edge：

- **记录的观察结果。** `chunk_recorded_external_interop` 会包装观察者所在的 chunk，而 `patch_module_dependencies` 会将 edge 缩小到这些相同的观察者。入口导出引用属于这里，既不会到达语句遍历，也不会出现在任何 `named_imports` 中，因此 `note_external_interop` 也会遍历 `referenced_symbols_by_entry_point_chunk`——删除这一调用会触发 panic（`external_interop_default_reexport_only_reachable_via_entry_export`）。
- **静态写入的导入。** `chunk_external_interop_modes` 还会根据 chunk 自身的 `named_imports` 进行包装，不进行存活性过滤：即使默认导入或命名空间导入的绑定没有任何读取，也仍然会进行包装，并且不会记录观察者。相同的 `specifier_needs_interop` 判定会为其 edge 提供两次支持——`reference_needed_symbols` 会针对保留下来的导入语句注册 `__toESM`，而 `compute_chunk_imports` 会为直接外部导入需要互操作的任何 chunk 重新添加跨 chunk 导入（`external_interop_dead_default_import_keeps_helper`）。

因此，不变量是成对的，而不是由一个来源同时回答两个问题。缩小某条通道的包装范围却不缩小其 edge——或者更容易想到的反向做法，只为 tree-shaking 保留下来的导入注册 `ToEsm`——都会重新引发另一条通道无法覆盖的情形中的 panic。

运行 `patch_module_dependencies` 时 chunk 尚不存在，因此 `is_included` 代替“将会拥有一个 chunk”。未被纳入的观察者无法归属到某个 chunk，渲染时会回退为包装所有发出该外部模块的 chunk——因此每个引用该模块的模块都会保留该 edge，与这一回退行为相匹配。
