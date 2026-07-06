# 构建 AST

## 摘要

Rolldown 在许多地方合成 oxc AST 节点——模块收尾器、扫描器的预处理、HMR，以及插件。历史上，它通过几种相互竞争的惯用法来完成这件事（手工维护的 `AstSnippet` 门面、原始的 `oxc::ast::AstBuilder`、带有构造语义的扩展 trait，以及 `..Foo::dummy(alloc)` 结构更新字面量）。此后 oxc 已将 `AstBuilder` 设为唯一被认可的构造路径（每个带 `NodeId` 的节点都标记了 `#[non_exhaustive]`，oxc 0.135 / [oxc#23046](https://github.com/oxc-project/oxc/pull/23046)），这直接删除了结构字面量这一惯用法。

接下来，rolldown 将 **所有** 构造都路由到一个由 rolldown 拥有的单一新类型 **`AstFactory`** 中；它封装了 oxc 的 `AstBuilder`（实现 `GetAstBuilder` / `GetAllocator`，因此可以传递给 oxc 按类型生成的节点构造器），并将 rolldown 自己那些反复出现的构造以固有的 `make_*` 方法形式加入其中。把一切都通过一个 rolldown 类型进行转发——而不是在每个位置直接调用 oxc 的 `AstBuilder`——使得 rolldown 能够在单一入口点吸收 oxc `AstBuilder` 的重设计（[oxc#23043](https://github.com/oxc-project/oxc/issues/23043)，oxc 0.138）。本文记录了这一决定及其原因。

## 先前状态

在这一约定之前，同一种节点可以用四种不同方式构建，而且这些入口彼此重叠：

- **`AstSnippet`**（`crates/rolldown_ecmascript_utils/src/ast_snippet.rs`，约 1030 行，约 50 个方法）。这是一个对 `AstBuilder` 的封装，混合了两类互不相关的工作：对单个 `AstBuilder` 调用的薄重命名（`id_ref_expr`、`call_expr_with_*` 家族、`string_literal_expr`，……）以及真正的、multi-node 的 rolldown 模式（`wrap_with_to_esm`、`commonjs_wrapper_stmt`、`.then` 链）。它的命名范围过大且难以发现——仅调用表达式这一家族就把参数个数/返回形状编码进了后缀矩阵（`call_expr_with_arg_expr` vs `_with_arg_expr_expr` vs `_with_2arg_expr_expr` …）。作者自己已经把这个类型名标记为一种折中：

  ```rust
  // crates/rolldown_ecmascript_utils/src/ast_snippet.rs
  // `AstBuilder` 这个名字更合适，但它已经在 oxc 中被使用了。
  pub struct AstSnippet<'ast> {
    pub builder: AstBuilder<'ast>,
  }
  ```

- **`pub builder` 逃逸口。** 由于 `AstSnippet::builder` 是公开的，大约一半的 `AstSnippet` 交互会绕过这些 helper，直接访问原始 `AstBuilder`（约 219 个 `snippet.builder.*` 调用点，而命名 helper 调用约 196 个）。这个门面与它所包装的对象并存，而不是将其封装起来。

- **临时性的 `AstBuilder` 访问。** 只接收 `&Allocator` 的构造型扩展 trait（`crates/rolldown_ecmascript_utils/src/extensions/ast_ext/`）会在内联中创建一个新的 `AstBuilder::new(alloc)`——这是获取 builder 的第三种方式，与 `self.ast` 风格字段和 `snippet.builder` 并列。

- **`..Foo::dummy(alloc)` 结构更新字面量。** 之前这是拼写一个节点最直接的方式。oxc 0.135 的 `#[non_exhaustive]` 让任何带 `NodeId` 的节点都无法再以这种方式编译；[#9670](https://github.com/rolldown/rolldown/pull/9670) 已将受影响的约 26 个位置（在 `module_finalizers/` 和 `ast_ext` trait 中）迁移到 `AstBuilder` 构造器上。剩余的 `::dummy()` 位置都在非节点类型（options/config）上，不受影响。

- **从源字符串解析。** 并非所有 AST 都是构建出来的——有些是以 JS 源代码形式编写，再通过 `EcmaCompiler::parse`（`crates/rolldown_ecmascript/src/ecma_compiler.rs`）解析，后者会把源字符串解析成带有自己 allocator 的独立 `EcmaAst`。在输出侧，这基本上只有运行时模块（`crates/rolldown/src/module_loader/runtime_module_task.rs:226`）。插件和 scanner 子分析器中约 35 个直接的 oxc `Parser::new` 位置是在解析**输入**源代码以进行分析或转换——这与构建 rolldown 自己的 AST 是不同的活动。

这两点约束了所有选择，并已在 [ast-mutation](../ast-mutation/implementation.md) 中记录：合成节点必须携带保留的合成 span（`SPAN`，`0..0`）——现在跨 pass 的 side tables 以 `NodeId` 为键，因此 span 不再阻止误匹配，但 `span.is_unspanned()` 检查（例如 `crates/rolldown/src/module_finalizers/mod.rs` 中的全局 `require` 重写保护）仍然用它来区分合成节点和扫描得到的节点——而且 rolldown 在 finalize 之后不会重新运行 semantic，因此合成节点会终身保留一个 dummy `NodeId`；正是这个 dummy id 让它们不会匹配扫描期记录。

## 约定

所有东西都通过一个句柄 `ast_factory: AstFactory<'a>`——rolldown 对 `oxc::ast::AstBuilder` 的新类型封装——来完成。按你要构建的内容选择工具：

### Generic nodes → oxc's per-type constructors, passing the `ast_factory` handle

自 oxc#23043（oxc 0.138）起，构造逻辑位于 AST 类型本身的按类型关联函数上，这些函数将 builder/allocator 作为**最后**一个参数：`Expression::new_call_expression(.., gen)`, `StaticMemberExpression::boxed(.., gen)`, `oxc::allocator::Vec::new_in(gen)`, `oxc::ast::ast::Str::from_str_in(s, gen)`。`AstFactory` 实现了 oxc 的 `GetAstBuilder` 和 `GetAllocator`，所以 `ast_factory` 句柄**就是**你要传入的生成器：

```rust
// 之前（0.138 之前）：通过 Deref 访问 builder 上的方法
let member = ast_factory.alloc_static_member_expression(SPAN, object, property, false);

// 之后：按类型的构造函数，句柄作为最后一个参数传入
let member = StaticMemberExpression::boxed(SPAN, object, property, false, &ast_factory);
```

在持有该句柄的 `&self` 方法中，直接传 `self`（它实现了这些 traits）；如果是值句柄，则传 `&ast_factory` / `&self.ast_factory`。命名映射是机械式的：`alloc_X` → `X::boxed`，普通值构造器 `x` → `X::new`，枚举构造器 → `Enum::new_<variant>`（例如 `expression_call` 构造的是 `Expression::CallExpression`，所以它是 `Expression::new_call_expression`）。当句柄已经在作用域中时，不要临时构造一个 `AstFactory` / `AstBuilder`。oxc 的构造函数是按位置传参的；对于冗长的代码块，建议先写一条注释说明它生成的 JS，正如 oxc 自己建议的那样。

### Rolldown 特定模式 → `AstFactory` 上的固有 `make_*` 方法

对于将多个节点组合成反复出现的 rolldown 约定的构造（CJS/ESM 互操作包装器、`__toESM` / `__toCommonJS` 调用、`.then` 链，……），应当在 `AstFactory` 新类型上添加固有 `make_*` 方法，而不是在调用点手写：

```rust
#[derive(Clone, Copy)]
pub struct AstFactory<'a>(oxc::ast::AstBuilder<'a>);

// generic oxc constructors reach the handle through these traits
impl<'a> GetAllocator<'a> for AstFactory<'a> {
  fn allocator(&self) -> &'a Allocator { self.0.allocator() }
}
impl<'a> GetAstBuilder<'a> for AstFactory<'a> {
  type Builder = AstBuilder<'a>;
  fn builder(&self) -> &AstBuilder<'a> { &self.0 }
}

impl<'a> AstFactory<'a> {                     // rolldown 自己的模式
  pub fn make_to_esm_wrapper(&self, namespace: Expression<'a>) -> Expression<'a> { /* ... */ }
  pub fn make_commonjs_wrapper(&self, /* ... */) -> Statement<'a> { /* ... */ }
}
```

这些方法：

- 以前缀 **`make_`** 开头，并以**操作**命名（`make_to_esm_wrapper`），绝不以单个 AST 节点命名；
- 遵循 oxc 的 builder 签名风格：位置参数，`make_<x>` 返回一个值，`make_alloc_<x>` 返回一个 boxed 节点。调用者提供的 `span` 按照 oxc 的惯例放在最前面，但大多数 `make_*` 模式会在内部使用保留的 `SPAN` 来合成节点，并且不接受 span。它们接收 **`&self`**，并将 `self` 作为生成器传给 oxc 的按类型构造函数（`self` 实现了 `GetAstBuilder` / `GetAllocator`）。`&self` 让**调用点**不依赖 `Copy` —— 句柄只是借用，从不移动，所以在一次 `make_*` 调用后继续复用它总是可以编译通过的。

只有当某个方法编码的是一种多步骤的 rolldown 约定，并且如果直接手写会默认出错时，才值得放在这里——不仅仅是为了缩短一次 oxc 调用。

### 默认用程序化方式构建；解析源代码是例外

通过 `ast_factory` 句柄来构建节点（通过 `Deref` 调用 oxc 构造器，通过 `make_*` 调用 rolldown 模式）。这适用于**所有**节点构建，包括 rolldown 生成的代码，因为直接构建没有运行时成本，而解析源字符串则在每次构建时都要付出词法分析 + 解析的开销。

将代码以 JS 源代码形式编写并解析它（`EcmaCompiler::parse`）只保留给那种体量很大且固定不变的代码主体，在这种情况下，维护它为真正的 JS 明显比一次性的解析成本更重要。实际中，这就是**运行时模块**（`crates/rolldown/src/module_loader/runtime_module_task.rs:226`）以及输出侧基本上没有别的东西——把它当作特例，而不是一个可随手使用的工具。对于那些要拼接进现有 AST、并且需要一个合成 `SPAN` + dummy `NodeId` 的节点，绝不要通过解析来生成——按照上面的约束，应该程序化地构建它们。

### 只读检查 → `as_*` / `is_*`

将只读检查 helper 与构造分开；它们不是 `AstFactory` 上的方法。

## 为什么是 `make_` + 操作名

这个前缀不是装饰性的——它有两个作用：

- **每个调用点都能自我标识。** 一个通用节点是一个 oxc 的逐类型构造函数（`Expression::new_call_expression(.., &ast_factory)`）；一个 `make_*` 名称（`ast_factory.make_to_esm_wrapper(..)`）则是 `AstFactory` 上的 rolldown 方法。二者的区别通过命名体现：oxc 的构造函数以它们生成的节点命名（名词），rolldown 的则以它们执行的操作命名（动词）。
- **它让 rolldown 的新增内容保持在自己的命名空间中。** `make_` 前缀意味着 `AstFactory` 的固有方法永远不会与 oxc 构造函数名冲突，读者也始终能知道某个构造是通用的 oxc 节点，还是 rolldown 的约定。

这里的句柄写作 `ast_factory`，而不是一个裸的 `ast`：这样读起来明确表示它是 `AstFactory` 的一个实例，也不会在视觉上与某些文件导入的 oxc `ast` 模块混淆。

## 前向兼容：oxc 构造 API 的单一咽喉点

这样做的更深层原因——不依赖于任何特定的 oxc 变更——在于：将所有构造都通过一个由 rolldown 拥有的新类型（`AstFactory`，封装 oxc 的 `AstBuilder`）来进行，会把这个类型变成围绕 oxc 构造 API 的一个**隔离边界**。oxc 的构造表面已经多次变动：`#[non_exhaustive]` 在 0.135 中落地（oxc#23046，本身也是一系列 AST 宏重组的一部分），而 oxc#23043 在 0.138 中彻底重设计了 `AstBuilder`。无论 oxc 接下来做什么，影响范围都被限制在这一层，而不是扩散到数百个调用点上。（这里隔离的是 _构造 API_——方法名、签名、构建器类型——而不是 oxc 的 AST 节点类型本身；这些节点类型在 rolldown 中无处不在，无法通过包装完全屏蔽。）

具体来说：

- **oxc#23043 的适配成本很低（oxc 0.138）。** 它将构造方式从 `builder.alloc_foo(span, …)` 改为每种类型各自的构造函数，并把生成器放在最后一个参数位置（`Foo::boxed(span, …, gen)`），同时自动分配 `NodeId`——并且明确提到了 rolldown [#9609](https://github.com/rolldown/rolldown/pull/9609)。由于一个 rolldown 的新类型早已贯穿全局，接入它只是一个局部变更：`AstFactory` 实现了 `GetAstBuilder` + `GetAllocator`，各类型的 `Foo::new(.., &ast_factory)` / `Foo::boxed(..)` 构造函数直接接收它，`make_*` 的实现体把 `self` 传进去，而对 oxc 的 `AstBuilder` 的 `Deref` 也被移除了。（泛型节点的调用点确实改了写法——`ast_factory.alloc_foo(..)` → `Foo::boxed(.., &ast_factory)`——但生成的节点是同一个，而 `make_*` 的调用点完全没动。）
- **即使移除 `AstBuilder`，影响范围也仍然可控。** 如果 oxc 未来彻底删除或重塑这个构建器，rolldown 也只需要在这一个位置重新承载构造逻辑——`AstFactory` 提供这个表面本身（或实现 oxc 引入的任何新生成器 trait）——而所有通过 `AstFactory` 类型标注的调用点都可以原地不动。统一正是让这一点成为可能的原因：如果构造分散在四种不同的惯用法和数百个直接绑定到 oxc 类型的调用点上，就不可能在一个位置吸收上游变更。

因此，这种统一性限制了 oxc 变动带来的成本。oxc 这次重设计**没有**解决的唯一一个易用性问题，是位置参数过于冗长；这也正是保留一个轻量本地层的理由：它只保留真正的 rolldown 模式，并与 oxc 的风格保持一致，而不是另起一套自己的分类体系。

## 迁移

这个约定是逐步引入的，但 oxc#23043 的切换（oxc 0.138）则是一口气完成的：

- `AstSnippet` 变成了 `AstFactory` 的 newtype：它的 `pub builder` 字段变成了被包装的 `AstBuilder`；那些简单的重命名被舍弃，改为使用 oxc 的构造器；真正的模式则变成了内在的 `make_*` 方法。`AstSnippet` 这个别扭的名字消失了——rolldown 现在拥有了一个命名恰当的 builder。
- oxc 0.138 的 builder 重设计一次性迁移完成：所有泛型节点的调用点都从（当时已弃用的）`ast_factory.<builder_method>(..)` 形式迁移到了按类型的构造器（`Foo::new(.., &ast_factory)` / `Foo::boxed(..)` / `oxc::allocator::Vec::new_in(..)` / `Str::from_str_in(..)`），`AstFactory` 增加了 `GetAstBuilder` / `GetAllocator` 的实现，并移除了 `Deref`。新代码直接遵循按类型的约定。

## 相关

- [ast-mutation](../ast-mutation/implementation.md) — 约束合成节点的 span/`NodeId` 作为身份标识的契约
- [runtime-helpers](../runtime-helpers/implementation.md) — `make_*` 互操作构造器所调用的运行时函数
