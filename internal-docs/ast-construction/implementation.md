# 构建 AST

## 摘要

Rolldown 在很多地方都会合成 oxc AST 节点——模块最终化器、扫描器的预处理、HMR，以及插件。历史上，它通过几种彼此竞争的惯用方式来完成这件事（手工维护的 `AstSnippet` 外观、原始的 `oxc::ast::AstBuilder`、构造风格的扩展 trait，以及 `..Foo::dummy(alloc)` 结构更新字面量）。后来，oxc 将 `AstBuilder` 设为唯一被允许的构造路径（对每个带有 `NodeId` 的节点都加上 `#[non_exhaustive]`，oxc 0.135 / [oxc#23046](https://github.com/oxc-project/oxc/pull/23046)），这直接删除了结构字面量这一惯用法；随后又（[oxc#23043](https://github.com/oxc-project/oxc/issues/23043)，oxc 0.138）把构造移到了 AST 类型自身上，作为每种类型的关联函数，并且将 builder/allocator 作为它们的**最后一个**参数。

Rolldown 现在端到端都采用了同样的形态：

- **通用节点** 直接使用 oxc 为每种类型提供的构造函数——`Expression::new_identifier(SPAN, name, builder)`、`StaticMemberExpression::boxed(.., builder)`、`oxc::allocator::Vec::new_in(builder)`——将 `AstBuilder`（或任何持有 `GetAstBuilder` + `GetAllocator` 的对象）作为最后一个参数传入。
- **Rolldown 自己反复使用的构造** 则是定义在 rolldown 所拥有的 **扩展 trait** 上的 `new_*` 关联函数，每种它们生成的节点类型一个（`ExpressionFactoryExt`、`StatementFactoryExt`、`MemberExpressionFactoryExt`、`CallExpressionFactoryExt`、`BindingIdentifierFactoryExt`、`IdentifierNameFactoryExt`、`ObjectPropertyKindFactoryExt`、`ClassElementFactoryExt`）。它们同样把 builder 放在最后：`Expression::new_id_ref_expr(SPAN, name, builder)`、`Statement::new_commonjs_wrapper_stmt(.., builder)`。

现在已经不再有包裹 `AstBuilder` 的 rolldown 封装类型了。Rolldown 直接持有并传递 oxc 的 `AstBuilder`。本文档记录了这一决定以及背后的原因。

另请参见 `internal-docs/ast-mutation/implementation.md`，其中说明了约束合成节点的 span/`NodeId` 作为标识的契约。

## 先前状态

在这一约定之前，同一种节点可以用四种不同方式构建，而且这些入口彼此重叠：

- **`AstSnippet`** (`crates/rolldown_ecmascript_utils/src/ast_snippet.rs`, ~1030 行，~50 个方法)。它是 `AstBuilder` 的一个包装器，把两项彼此无关的工作混在了一起：一方面是对单个 `AstBuilder` 调用的轻量重命名（`id_ref_expr`、`call_expr_with_*` 系列、`string_literal_expr` 等），另一方面是真正的多节点 rolldown 模式（`wrap_with_to_esm`、`commonjs_wrapper_stmt`、`.then` 链）。它的命名范围庞杂，而且很难发现——仅 `call-expression` 这一组就把参数个数/返回形状编码进了一个后缀矩阵里（`call_expr_with_arg_expr` vs `_with_arg_expr_expr` vs `_with_2arg_expr_expr` …）。作者甚至已经把这个类型名标记为一种折中：

  ```rust
  // `AstBuilder` is more suitable name, but it's already used in oxc.
  pub struct AstSnippet<'ast> {
    pub builder: AstBuilder<'ast>,
  }
  ```

- **`pub builder` 逃逸口。** 由于 `AstSnippet::builder` 是公开的，大约一半的 `AstSnippet` 交互都会绕过这些辅助方法，直接访问原始的 `AstBuilder`（约 219 个 `snippet.builder.*` 调用点 vs. 约 196 个具名辅助方法调用）。这个门面与它所包装的东西并存，而不是把它封装起来。

- **临时性的 `AstBuilder` 访问。** 构造风格的扩展 trait（`crates/rolldown_ecmascript_utils/src/extensions/ast_ext/`）如果只接收 `&Allocator`，就会在内部直接写 `AstBuilder::new(alloc)` 新建一个构建器——这成了获得 builder 的第三种方式，和 `self.ast` 风格字段以及 `snippet.builder` 并列。

- **`..Foo::dummy(alloc)` 结构更新字面量。** 过去这是拼写一个节点最直接的方式。oxc 0.135 引入的 `#[non_exhaustive]` 让任何带 `NodeId` 的节点都无法再这样编译；[#9670](https://github.com/rolldown/rolldown/pull/9670) 将大约 26 个受影响的调用点迁移到了 `AstBuilder` 构造函数上。剩下的 `::dummy()` 调用位于非节点类型（选项/配置）上，因此不受影响。

- **从源字符串解析。** 并非所有 AST 都是构建出来的——有些是直接写成 JS 源码并通过 `EcmaCompiler::parse`（`crates/rolldown_ecmascript/src/ecma_compiler.rs`）解析的，它会把源字符串解析成一个带有自己分配器的独立 `EcmaAst`。在输出侧，这基本上只对应运行时模块（`crates/rolldown/src/module_loader/runtime_module_task.rs`）。插件和 scanner 子分析器中的直接 `oxc::Parser::new` 调用解析的是 _输入_ 源码，用于分析或转换——这与构造 rolldown 自己的 AST 是不同的活动。

`AstSnippet` 这个门面最初已经被替换过一次（oxc#23043 切换，oxc 0.138）：它被一个轻量的 rolldown newtype `AstFactory` 所替代，后者包装了 `AstBuilder`。但这个 newtype 之后也被移除了（见 [迁移](#migration)）；现在构造逻辑直接放在 AST 类型上，与 oxc 保持一致。

这两点约束了所有选择，并已在 [ast-mutation](../ast-mutation/implementation.md) 中记录：合成节点必须携带保留的合成 span（`SPAN`，`0..0`）——现在跨 pass 的 side tables 以 `NodeId` 为键，因此 span 不再阻止误匹配，但 `span.is_unspanned()` 检查（例如 `crates/rolldown/src/module_finalizers/mod.rs` 中的全局 `require` 重写保护）仍然用它来区分合成节点和扫描得到的节点——而且 rolldown 在 finalize 之后不会重新运行 semantic，因此合成节点会终身保留一个 dummy `NodeId`；正是这个 dummy id 让它们不会匹配扫描期记录。

## 约定

根据你正在构建的内容来选择工具。在这两种情况下，你通过其构建的对象都是一个实现了 oxc 的 `GetAstBuilder` + `GetAllocator` 的值——一个 `AstBuilder`，或者任何持有它的上下文——并作为**最后**一个参数传入。

### 通用节点 → oxc 按类型的构造函数

自 oxc#23043（oxc 0.138）起，构建逻辑存在于 AST 类型本身上，作为按类型的关联函数：`Expression::new_call_expression(.., builder)`、`StaticMemberExpression::boxed(.., builder)`、`oxc::allocator::Vec::new_in(builder)`、`oxc::ast::ast::Str::from_str_in(s, builder)`。

```rust
// 一个成员表达式，使用 oxc 按类型的构造函数构建，builder 作为最后一个参数传入。
let member = StaticMemberExpression::boxed(SPAN, object, property, false, builder);
```

命名可以机械地对应：`alloc_X` → `X::boxed`，普通值构造函数 `x` → `X::new`，枚举构造函数 → `Enum::new_<variant>`（例如，`Expression::new_call_expression` 构建 `Expression::CallExpression`）。oxc 的构造函数是按位置传参的；如果前面是一段较长的内容，请用注释说明它生成的 JS，正如 oxc 自己所建议的那样。

### Rolldown 特有模式 → 扩展 trait 上的 `new_*` 关联函数

对于那些将多个节点组合成某种重复出现的 rolldown 约定的构造（CJS/ESM 互操作包装器、`__toESM` / `__toCommonJS` 调用、`.then` 链，等等），应当在其所生成的节点类型对应的扩展 trait 上添加一个 `new_*` 关联函数，而不是在调用处手写实现。所有 trait 都位于同一个模块（`crates/rolldown_ecmascript_utils/src/ast_factory.rs`），并从 crate 根部重新导出，因此调用处只需通过一次 `use` 引入所需的 trait，并以 `as _` 形式导入：

```rust
use rolldown_ecmascript_utils::{ExpressionFactoryExt as _, StatementFactoryExt as _};

let stmt = Statement::new_commonjs_wrapper_stmt(binding_name, /* … */, builder);
let id_ref = Expression::new_id_ref_expr(SPAN, name, builder);
```

Rolldown 不能为 oxc 的外部类型添加固有方法，因此这些方法放在 trait 上。它们以 `as _` 的方式导入——调用处只需要这些 `new_*` 方法，trait 名称本身不会出现——这也避免了它们与同类型的检查 trait（`ExpressionExt`，……）发生冲突。

这些函数：

- 以 **`new_`** 为前缀，并按**操作**命名（`new_to_esm_wrapper`），而不是按某个裸 AST 节点命名；
- 是**关联函数**（没有 `self`），并且对 `B: GetAstBuilder<'ast> + GetAllocator<'ast>` 泛型化，将 builder 作为**最后**一个参数传入，完全与 oxc 自身的按类型构造函数一致。由调用方提供的 `span` 会像 oxc 那样放在前面，但大多数 `new_*` 模式会在内部使用保留的 `SPAN` 合成节点，因此不接收 span；
- 放在它们**返回**的节点类型对应的扩展 trait 上（`Expression::new_*` 放在 `ExpressionFactoryExt` 上，`Statement::new_*` 放在 `StatementFactoryExt` 上，……）。不值得作为公开入口的私有多步骤辅助函数，应当作为同一模块中的自由函数。

只有当某个函数编码了一个多步骤的 rolldown 约定，并且如果直接手写会变成错误的默认行为时，才应当把它放在这里——而不是仅仅为了缩短一次 oxc 调用。

### 默认用程序化方式构建；解析源代码是例外

以程序化方式构建节点（oxc 按类型构造函数、通过 `new_*` 的 rolldown 模式）。这是**所有**节点构建的默认方式，包括 rolldown 生成的代码，因为直接构建没有运行时开销，而解析源字符串则会在每次构建时都付出词法分析 + 解析的开销。

将代码写成 JS 源码并解析它（`EcmaCompiler::parse`）只适用于一大段固定不变的代码，且维护真实 JS 的成本明显大于一次性的解析开销。实践中，这只适用于**运行时模块**（`crates/rolldown/src/module_loader/runtime_module_task.rs`），以及输出侧几乎没有别的场景。对于会拼接进现有 AST、并且需要合成 `SPAN` + 虚拟 `NodeId` 的节点，绝不要解析；应按照上面的约束程序化构建这些节点。

### 只读检查 → `as_*` / `is_*`

将只读检查辅助函数（位于 `ExpressionExt`、`CallExpressionExt`、`StatementExt`、…… 上）与构造逻辑分开。构造 trait 命名为 `*FactoryExt`，且只包含 `new_*`；检查 trait 只包含 `as_*` / `is_*`。

## 命名：`new_` + 操作，不要用变体名

rolldown 的构造函数沿用了 oxc 的 `new_` 前缀——它们读起来像构造函数，也符合 oxc 自身的约定（提出这种形式的 oxc 维护者也在使用它）。有两条规则让它们保持一致：

- **按操作命名，而不是按节点命名。** oxc 的按类型构造函数是按它产生的节点来命名的（`Expression::new_call_expression`，一个名词）；而 rolldown 的约定是按它执行的操作来命名的（`Expression::new_to_esm_wrapper`，一个动词）。读者可以通过名词与动词的命名方式区分它们——而 rolldown 的这些方法是通过导入的 `*FactoryExt` trait 调用到的。
- **操作名称正是让两者互不重叠的关键。** rolldown 的函数是 oxc 类型上的 trait 关联函数，因此如果某个名称与 oxc 的 _固有_ 构造函数冲突，就会被 oxc 的构造函数无声地遮蔽。由于共享 `new_` 前缀，rolldown 依赖“操作名 vs 变体名”的区分来保持清晰：没有任何 rolldown 的操作名（`new_keep_name_call`、`new_re_export_call`、……）会与 oxc 的变体名重合。这是一种约束，而不是旧的 `make_` 前缀所提供的那种保证——新增一个 `new_*` 帮助函数时，要选一个 oxc 不会使用的名字；如果签名不兼容而发生冲突，编译会失败，而快照测试套件会捕获任何更隐蔽的问题。

## 为什么采用类型上的方法，而不使用包装器

早期的设计将所有构造都通过一个单独的 rolldown 新类型（`AstFactory`）来完成，它包装了 `AstBuilder`，其理论依据是：这会在 oxc 的构造 API 之外形成一道隔离边界。实际上，这种隔离非常薄弱——通用节点构造在每个调用点都已经直接引用了 oxc 的类型（`Expression::new_call_expression`、`StaticMemberExpression::boxed`，等等），因此这个新类型实际上只是把 `new_*` 模式和句柄 _类型_ 集中到了一处。采用 oxc 自己那种“类型上的方法”风格，虽然放弃了这一点，但收益远大于代价：

- **这与 oxc 保持一致。** 对于 oxc 和 rolldown 的节点来说，构造都发生在同一个地方——AST 类型上，builder 放在最后。rolldown 对外可见的唯一差异是：rolldown 的辅助方法以操作命名，并通过 `use … as _` 的 trait 导入来访问。`new_*` 模式仍然保留在一个模块中，因此“单一位置以吸收 oxc 构造 API 变更”的属性得以保留，而这一点正是实际需要它的地方。
- **builder-last 解除对 `&mut` 构造的阻碍。** oxc 计划将 builder 方法改为接收 `&mut AstBuilder`（以便去掉 `Allocator` 中的 `Cell`——这是热点路径上的性能收益——并支持能够自动分配唯一 `NodeId` 的有状态 builder）。将 builder 作为参数传入，而不是作为 `self` 接收者，正是这种写法更易用的原因：`Expression::new_id_ref_expr(SPAN, self.gen_name(), self)` 可以通过借用检查，而旧的接收者形式 `self.ast_factory.make_id_ref_expr(SPAN, self.gen_name())` 则不行，因为参数会在尾随的 `self` 借用之前求值。旧的“newtype 作为接收者”设计正是这里的具体阻碍。
- **有状态性是被推迟，而不是丢失。** 如果 rolldown 之后确实需要一个有状态的 builder（例如自动分配 `NodeId`），那么它可以重新引入一个包装类型，实现 `GetAstBuilder` + `GetAllocator`，并将其作为 builder 参数传递。由于每个 `new_*` 以及每个 oxc 构造函数都对 builder 是泛型的，这种替换不会带来任何调用点修改——这比它所替代的 `&self` 新类型方案要灵活得多。

因此，这一变化是朝着 oxc 的形态演进：保留旧设计中唯一真正有用的属性（将 rolldown 模式集中在一个模块中），同时舍弃那个实际上阻碍了 oxc 下一步发展的属性。

## 迁移

该约定分两步完成：

1. **`AstSnippet` → `AstFactory` 新类型（oxc#23043 切换，oxc 0.138）。** `AstSnippet` 变成了 `AstBuilder` 上的一个新类型：它的 `pub builder` 字段变成了被包装的 builder，去掉了那种简单的重命名，改为使用 oxc 按类型提供的构造函数，而真正的模式则变成了固有的 `make_*` 方法。所有泛型节点的调用点都迁移到了按类型的构造函数，且启用了 oxc_ast 的 **`disable_old_builder`** cargo 特性，移除了已弃用的 `AstBuilder` 方法（并去掉了 `AstBuilder` 的 `Clone`/`Copy`，以及顶层 `oxc::ast::{AstBuilder, NONE}` 的 re-exports —— 请改为从 `oxc::ast::builder::` 导入）。

2. **`AstFactory` 新类型 → 扩展 trait 上的 `new_*`（本次变更）。** `AstFactory` 上的固有 `make_*` 方法变成了按节点类型的 `*FactoryExt` trait 上的 `new_*` 关联函数，这些函数对 `B: GetAstBuilder + GetAllocator` 泛型化，并将 builder 放在最后；私有的多步骤辅助函数变成了同一模块中的自由函数。两个面向构造的绑定扩展 trait（`BindingPatternExt`、`BindingPropertyExt`）也以相同方式对 builder 泛型化，从而与已删除的类型解耦。每个 holder 结构体的 `ast_factory: AstFactory` 字段都变成了 `ast_builder: AstBuilder`，并且每个 `self.ast_factory.make_x(..)` 调用点都变成了 `Type::new_x(.., &self.ast_builder)`。`AstFactory` 这个新类型已被删除。

`disable_old_builder` 仍然处于启用状态，并通过 `crates/rolldown_ecmascript/Cargo.toml` 中对 `oxc_ast` 的直接依赖进行固定（cargo-shear 会忽略；特性统一会将其应用到 umbrella 重新导出的那份副本上）。在升级时，请保持这个固定与 `oxc` 版本同步。

## 相关

- [ast-mutation](../ast-mutation/implementation.md) — 约束合成节点的 span/`NodeId` 作为标识的契约
- [runtime-helpers](../runtime-helpers/implementation.md) — `new_*` 互操作构造函数会调用的运行时函数
