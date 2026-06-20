# 构建 AST

## 摘要

Rolldown 在许多地方合成 oxc AST 节点——模块收尾器、扫描器的预处理、HMR，以及插件。历史上，它通过几种相互竞争的惯用法来完成这件事（手工维护的 `AstSnippet` 门面、原始的 `oxc::ast::AstBuilder`、带有构造语义的扩展 trait，以及 `..Foo::dummy(alloc)` 结构更新字面量）。此后 oxc 已将 `AstBuilder` 设为唯一被认可的构造路径（每个带 `NodeId` 的节点都标记了 `#[non_exhaustive]`，oxc 0.135 / [oxc#23046](https://github.com/oxc-project/oxc/pull/23046)），这直接删除了结构字面量这一惯用法。

今后，rolldown 将把**所有**构造都通过一个由 rolldown 拥有的新类型 **`AstFactory`** 进行路由；它封装 oxc 的 `AstBuilder`（并通过 `Deref` 将通用节点构造器透出），同时将 rolldown 自身反复出现的构造以固有 `make_*` 方法的形式加入。把所有东西都收束到一个 rolldown 类型里——而不是在每个位置直接调用 oxc 的 `AstBuilder`——也正是让 rolldown 能在单一位置吸收未来 oxc 构造 API 变化的原因。本文记录这一决定及其理由，以便未来工作（以及即将到来的 oxc `AstBuilder` 重设计，[oxc#23043](https://github.com/oxc-project/oxc/issues/23043)）有一个基线。

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

Two facts constrain every choice and are documented in [ast-mutation](../ast-mutation/implementation.md): synthesized nodes must carry the reserved synthetic span (`SPAN`, `0..0`) — the cross-pass side tables are `NodeId`-keyed now, so the span no longer prevents false matches, but `span.is_unspanned()` checks (such as the global-`require` rewrite guard in `crates/rolldown/src/module_finalizers/mod.rs`) still use it to tell synthesized nodes from scanned ones — and rolldown does not re-run semantic after finalize, so synthesized nodes keep a dummy `NodeId` for life; that dummy id is what keeps them from matching scan-time records.

## 约定

所有东西都通过一个句柄 `ast_factory: AstFactory<'a>`——rolldown 对 `oxc::ast::AstBuilder` 的新类型封装——来完成。按你要构建的内容选择工具：

### 通用节点 → `ast_factory` 句柄（通过 `Deref` 使用 oxc 的 builder）

`AstFactory` 会解引用到被包装的 builder，因此每个 oxc 构造器都可以直接在 `ast_factory` 上调用。那些薄的 `AstSnippet` 重命名会收敛为这些 oxc 调用：

```rust
// 之前：一个 AstSnippet 包装方法
let member = self.snippet.builder.alloc_static_member_expression(SPAN, object, property, false);

// 之后：同一个 oxc 构造器，在 `ast_factory` 句柄上调用（通过 Deref 解析）
let member = ast_factory.alloc_static_member_expression(SPAN, object, property, false);
```

当作用域里已经有一个句柄时，不要临时构造 `AstFactory` / `AstBuilder`；当 builder 已经提供了 `ast_factory.vec*` / `ast_factory.alloc_*` 时，也不要去直接使用原始的 `oxc::allocator::Vec` / `Box`。oxc 的构造器是位置参数式的；如果一段内容很冗长，请在前面加注释说明它生成的 JS，这也是 oxc 自己的建议。

### Rolldown 特定模式 → `AstFactory` 上的固有 `make_*` 方法

对于将多个节点组合成反复出现的 rolldown 约定的构造（CJS/ESM 互操作包装器、`__toESM` / `__toCommonJS` 调用、`.then` 链，……），应当在 `AstFactory` 新类型上添加固有 `make_*` 方法，而不是在调用点手写：

```rust
#[derive(Clone, Copy)]
pub struct AstFactory<'a>(oxc::ast::AstBuilder<'a>);

impl<'a> Deref for AstFactory<'a> {          // 通用 oxc 构造器，无需样板代码
  type Target = oxc::ast::AstBuilder<'a>;
  fn deref(&self) -> &Self::Target { &self.0 }
}

impl<'a> AstFactory<'a> {                     // rolldown 自己的模式
  pub fn make_to_esm_wrapper(&self, namespace: Expression<'a>) -> Expression<'a> { /* ... */ }
  pub fn make_commonjs_wrapper(&self, /* ... */) -> Statement<'a> { /* ... */ }
}
```

这些方法：

- 以 **`make_`** 为前缀，并以 **操作** 命名（`make_to_esm_wrapper`），而不是用一个裸 AST 节点命名；
- 采用与 oxc builder 相同的签名风格：位置参数，`make_<x>` 返回一个值，而 `make_alloc_<x>` 返回一个 boxed 节点。调用者提供的 `span` 会像 oxc 一样放在最前面，但大多数 `make_*` 模式会在内部合成保留的 `SPAN`，因此不接收 span。它们使用 **`&self`**，并通过 `Deref` 访问被包装的 builder（`self.foo()`，绝不用 `self.0.foo()`）。`&self` 让**调用点**不依赖于 `Copy`——句柄是借用的，不会被移动，因此在一次 `make_*` 调用后继续复用它总是能编译通过。方法的**主体**仍然依赖当下的 `Copy` builder（`Deref` 得到 `&AstBuilder`，而 oxc 的按值构造器会把它再拷贝出来）；当 oxc#23043 落地时——按类型的构造器将把 generator 以引用方式传入，`AstFactory` 实现 `AstGenerator`，并移除 `Deref`——这些主体会迁移到那个 API 上，而 `&self` 的调用点保持不变。

只有当某个方法编码的是一种多步骤的 rolldown 约定，并且如果直接手写会默认出错时，才值得放在这里——不仅仅是为了缩短一次 oxc 调用。

### 默认用程序化方式构建；解析源代码是例外

通过 `ast_factory` 句柄来构建节点（通过 `Deref` 调用 oxc 构造器，通过 `make_*` 调用 rolldown 模式）。这适用于**所有**节点构建，包括 rolldown 生成的代码，因为直接构建没有运行时成本，而解析源字符串则在每次构建时都要付出词法分析 + 解析的开销。

将代码以 JS 源代码形式编写并解析它（`EcmaCompiler::parse`）只保留给那种体量很大且固定不变的代码主体，在这种情况下，维护它为真正的 JS 明显比一次性的解析成本更重要。实际中，这就是**运行时模块**（`crates/rolldown/src/module_loader/runtime_module_task.rs:226`）以及输出侧基本上没有别的东西——把它当作特例，而不是一个可随手使用的工具。对于那些要拼接进现有 AST、并且需要一个合成 `SPAN` + dummy `NodeId` 的节点，绝不要通过解析来生成——按照上面的约束，应该程序化地构建它们。

### 只读检查 → `as_*` / `is_*`

将只读检查 helper 与构造分开；它们不是 `AstFactory` 上的方法。

## 为什么是 `make_` + 操作名

这个前缀不是装饰性的——它有两个作用：

- **每个调用点都能自我标识。** 一个裸节点名（`ast_factory.call_expression(..)`）是通过 `Deref` 进入 oxc 的 builder；而一个 `make_*` 名称（`ast_factory.make_to_esm_wrapper(..)`）则是 `AstFactory` 上的 rolldown 方法。Rust 在调用点不会把二者区分标出来，因此这种区别只能靠命名传达：oxc 方法按其生成的节点命名（名词），rolldown 的方法按其执行的操作命名（动词）。
- **它能防止意外遮蔽。** `AstFactory` 上的固有方法会优先于通过 `Deref` 访问到的 oxc 方法。把 rolldown 方法命名成一个裸节点名（例如 `call_expression`）会在无声中覆盖 oxc 的同名方法——有时这正是为了吸收上游变化而刻意为之，但若是意外发生，它就是一个陷阱。`make_` 前缀把 rolldown 的新增方法放在自己的命名空间里，因此任何覆盖都必须是有意的。

这里的句柄写作 `ast_factory`，而不是一个裸的 `ast`：这样读起来明确表示它是 `AstFactory` 的一个实例，也不会在视觉上与某些文件导入的 oxc `ast` 模块混淆。

## 前向兼容：oxc 构造 API 的单一咽喉点

之所以现在就要这么做——与任何特定的 oxc 变化无关——更深层的原因是：把所有构造都通过一个由 rolldown 拥有的新类型（`AstFactory`，封装 oxc 的 `AstBuilder`）进行路由，会把这个类型变成围绕 oxc 构造 API 的一个**隔离边界**。oxc 的构造面仍在持续变化：0.135 引入了 `#[non_exhaustive]`（oxc#23046，本身也是一系列 AST 宏重组的一部分），而 oxc#23043 将彻底重设计 `AstBuilder`。无论 oxc 接下来怎么变，爆炸半径都被限制在这一层，而不会散落到数百个调用点上。（这隔离的是 _构造 API_——方法名、签名、builder 类型——而不是 oxc 的 AST 节点类型本身；这些类型在 rolldown 中无处不在，无法被完全封装掉。）

具体来说：

- **oxc#23043 可以低成本接入。** 它会把构造从 `builder.alloc_foo(span, …)` 改为按类型构造器，generator 放在最后（`Foo::boxed(span, …, gen)`），通过 `AstGenerator` trait 实现，并自动分配 `NodeId`——明确提到了 rolldown [#9609](https://github.com/rolldown/rolldown/pull/9609)。既然已经有一个 rolldown 新类型贯穿全局，那么接入它就是一次局部修改：`AstFactory` 实现 `AstGenerator`，按类型的 `Foo::new(.., ast)` 构造器可以直接在其上工作，而今天的 `AstBuilder` 上的 `Deref` 只需移除即可——调用点不用改。
- **即使移除 `AstBuilder` 也能保持局部化。** 如果 oxc 未来真的删除或重塑 builder，rolldown 就在这一单点重新承载构造——`AstFactory` 不再解引用到 oxc 的 builder，而是自己提供这套表面（或者实现 `AstGenerator`）——而所有通过 `AstFactory` 类型化的调用点都不会受影响。统一化正是这件事可行的原因：如果构造分散在四种惯用法和数百个直接绑定到 oxc 类型的站点上，你就不可能在一个点吸收上游变化。

所以，即便 oxc 仍在变化中，这项工作现在也值得做——统一化正是限制这种变化成本的关键。oxc 自己的重设计**不能**解决的唯一一个可用性问题，是位置参数的冗长；这也正是保留一个薄的本地层的剩余理由：它只承载真正的 rolldown 模式，并且保持与 oxc 风格一致，而不是演化成另一套自己的分类体系。

## 迁移

这是一项增量式约定，而不是一次性的大规模重构：

- `AstSnippet` 将变为 `AstFactory` 的新类型封装：其 `pub builder` 字段将变为通过 `Deref` 暴露的包装 `AstBuilder`；那些简单的重命名将被放弃，改为使用解引用后的 oxc 构造函数；真正的模式将成为固有的 `make_*` 方法。别扭的 `AstSnippet` 名称将消失——rolldown 现在拥有了一个命名合理的构建器。
- 新代码会立即遵循这一约定；现有代码会在合适时机逐步迁移（`..::dummy()` 这一组已经被 #9670 强制迁移过去了）。

## 相关

- [ast-mutation](../ast-mutation/implementation.md) — 约束合成节点的 span/`NodeId` 作为身份标识的契约
- [runtime-helpers](../runtime-helpers/implementation.md) — `make_*` 互操作构造器所调用的运行时函数
