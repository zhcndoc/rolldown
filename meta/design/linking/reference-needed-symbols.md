# reference_needed_symbols

## 目的

`reference_needed_symbols` 会将每个模块的链接决策转换为逐语句依赖。对于每条导入记录，给定 importer/importee 对以及 `wrap_modules` 选出的 `WrapKind`，它会记录：

- 下沉后的代码将会引用的 `SymbolRef`（`init_foo`、`require_foo`、命名空间对象），
- 每条语句所依赖的运行时辅助函数（`__toESM`、`__reExport`、`__toCommonJS`、`__name`、`__require`），
- 该下沉是否会强制把语句标记为有副作用，
- 一个稳定的 `import_<name>` 重命名，用于外部/CJS 命名空间绑定。

它只写入数据；不会决定哪些内容会被包含。`include_statements` 是下一步，并且会消费这里写入的所有内容。

来源：`crates/rolldown/src/stages/link_stage/reference_needed_symbols.rs`。

## 流水线位置

```
… wrap_modules → generate_lazy_export → determine_side_effects
  → bind_imports_and_exports → create_exports_for_ecma_modules
  → reference_needed_symbols   ← 本阶段
  → cross_module_optimization → include_statements → patch_module_dependencies
```

这个位置在两个方向上都很关键：

1. **`wrap_kind` 和 `wrapper_ref` 必须已经存在。** 每个 CJS/ESM-wrap 分支都会读取 `metas[importee.idx].wrap_kind()` 并解引用 `wrapper_ref.unwrap()`。`wrap_modules` 和 `generate_lazy_export` 会填充它们。
2. **`include_statements` 必须在之后运行。** Tree-shaking 会遍历 `stmt_info.referenced_symbols`，并把 `depended_runtime_helper` 与已包含的语句合并。没有本阶段写入的数据，包装器和辅助函数会被静默地从输出中丢弃。

## 分发

对于每个 `(importer, stmt_info, rec)` 三元组，本阶段会根据 `rec.kind`、被导入模块的 `WrapKind`，以及（对于 `Import`）该记录是否为全量 re-export（`export *`）来进行分发。

### `Module::Normal` 导入项

- **`Import`, `WrapKind::None`, 非 reexport** —— 不记录任何内容；两侧都是扁平 ESM，因此没有包装器可调用。

  ```js
  // foo.js: export const x = 1;
  // index.js: import { x } from './foo';   → import { x } from './foo';   （此处不变）
  ```

- **`Import`, `WrapKind::None`, 带 `has_dynamic_exports` 的 reexport-all** —— `side_effect=true`，设置 `ReExportDynamicExports`，推入 `__reExport`、importer 和 importee 的命名空间引用。覆盖的是间接 CJS 场景：一个未包装的 ESM 中间层转发了一个已包装 CJS 模块的动态导出。

  ```js
  // bar.js (cjs): module.exports = { a: 1 };
  // foo.js: export * from './bar';          // wrap=cjs（已转发）
  // index.js: export * from './foo';        // wrap=none，但 bar 的导出是动态的
  //   → __reExport(index_exports, foo_exports);
  ```

- **`Import`, `WrapKind::Cjs`, 非 reexport** —— 推入 `wrapper_ref`（`require_foo`）；若需要 interop，则推入 `__toESM`；声明并将命名空间引用重命名为 `import_<repr_name>`。

  ```js
  // foo.js (cjs): module.exports = { a: 1 };
  // index.js: import foo from './foo'; foo.a;
  //   → var import_foo = __toESM(require_foo()); import_foo.default.a;
  ```

- **`Import`, `WrapKind::Cjs`, reexport-all** —— `side_effect=true`；推入 `wrapper_ref`；推入 `__toESM` 和 `__reExport`；当 `treeshake.commonjs` 关闭时，还会推入 importer 的命名空间引用。

  ```js
  // foo.js (cjs): module.exports = { a: 1 };
  // index.js: export * from './foo';
  //   → __reExport(index_exports, __toESM(require_foo()));
  ```

- **`Import`, `WrapKind::Esm`, 非 reexport** —— 推入 `wrapper_ref`（`init_foo`）；`side_effect = importee.side_effects.has_side_effects()`。

  ```js
  // foo.js (esm, wrapped): export const x = 1;
  // index.js: import { x } from './foo'; use(x);
  //   → init_foo(); use(x);
  ```

- **`Import`, `WrapKind::Esm`, reexport-all** —— 推入 `wrapper_ref`（`init_foo`）；`side_effect=true` 无条件成立（对一个已包装的 ESM importee 做 reexport-all 总会执行，不管 `importee.side_effects` 如何）。此外，当 importee 具有动态导出时，推入 `__reExport`、设置 `ReExportDynamicExports`，并推入 importer 和 importee 的命名空间引用。

  ```js
  // foo.js (esm, wrapped, 通过 re-export cjs 具有动态导出)
  // index.js: export * from './foo';
  //   → init_foo(); __reExport(index_exports, foo_exports);
  ```

- **`Require`, `WrapKind::None`** —— 无操作；对一个未被提升的扁平 ESM importee 执行 `require`，在这一层等价于 no-op。

- **`Require`, `WrapKind::Cjs`** —— 推入 `wrapper_ref`（`require_foo`）。

  ```js
  // foo.js (cjs): module.exports = 1;
  // index.js: const f = require('./foo');
  //   → const f = require_foo();
  ```

- **`Require`, `WrapKind::Esm`** —— 推入 `wrapper_ref` 和 importee 的命名空间引用；除非是 `IsRequireUnused`，否则还会推入 `__toCommonJS`。

  ```js
  // foo.js (esm, wrapped): export const x = 1;
  // index.js: const f = require('./foo');
  //   → const f = (init_foo(), __toCommonJS(foo_exports));
  ```

- **`DynamicImport`, 启用代码分割，CJS importee** —— 推入 `__toESM`；为 importee 生成的 chunk 会在调用点被规范化。

  ```js
  // foo.js (cjs)
  // index.js: const f = await import('./foo');
  //   → const f = await import('./foo-chunk').then((m) => __toESM(m.default));
  ```

- **`DynamicImport`, 启用代码分割，ESM/None importee** —— 无操作；该导入会变成一个 chunk 级别的构造，并在后面处理。

- **`DynamicImport`, 关闭代码分割，CJS importee** —— 推入 `wrapper_ref` 和 `__toESM`。

  ```js
  // index.js: const f = await import('./foo');
  //   → const f = Promise.resolve().then(() => __toESM(require_foo()));
  ```

- **`DynamicImport`, 关闭代码分割，ESM importee** —— 推入 `wrapper_ref` 和 importee 的命名空间引用。

  ```js
  // index.js: const f = await import('./foo');
  //   → const f = Promise.resolve().then(() => (init_foo(), foo_exports));
  ```

- **`AtImport` / `UrlImport`** —— `unreachable!`。JS 模块的导入记录不可能合法地包含仅用于 CSS 的种类。

- **`NewUrl` / `HotAccept`** —— 无操作（资源引用 / HMR 元数据）。

### `Module::External` 导入项

- **`Import`, reexport-all** —— 将 `rec.namespace_ref` 重命名为 `import_<identifier_name>`。`export *` 本身会在后续阶段被移除；这里只需要稳定的命名空间名称来避免冲突。

  ```js
  // index.js: export * from 'lodash';
  //   → （移除；命名空间引用重命名为 `import_lodash`）
  ```

- **`Import`, named，输出格式 ∈ `Cjs`/`Iife`/`Umd`** —— `side_effect=true`；若 `import_record_needs_interop` 为真（默认导入或命名空间导入），则推入 `__toESM`。

  ```js
  // index.js: import lodash from 'lodash';                 // cjs 输出
  //   → const import_lodash = __toESM(require('lodash')); import_lodash.default;
  ```

- **`Require`, ESM-on-Node + `polyfill_require` 选项** —— 推入 `__require` 符号；在导入记录上延后设置 `CallRuntimeRequire` 元数据，以便最终化阶段重写该调用。

  ```js
  // index.js: const fs = require('fs');                    // esm 输出，node 平台
  //   → const fs = __require('fs');
  ```

- **`DynamicImport`, `Cjs` 格式 + `!dynamic_import_in_cjs`** —— 推入 `__toESM`。

  ```js
  // index.js: const lodash = await import('lodash');       // cjs 输出，未开启 dynamicImportInCjs
  //   → const lodash = await Promise.resolve().then(() => __toESM(require('lodash')));
  ```

- **其他 external 的 `rec.kind`** —— 无操作。

### 语句级标志（独立于任何特定记录检查）

- `HasDummyRecord` → 推入 `__require`。用于没有可解析目标的 `require(...)` 调用。
- `NonStaticDynamicImport` → 推入 `__toESM`。用于 `import(foo)` / `import('a' + 'b')`。
- `keep_names && KeepNamesType` → 推入 `__name`。即 `keepNames` 的运行时实现。

当 `safely_merge_cjs_ns_map` 中存在某个 importee 的条目时，其 `needs_interop` 对于 `Import` / `WrapKind::Cjs` / 非 reexport 分支具有权威性——会覆盖按记录检查的 `import_record_needs_interop`。这个映射记录了跨 importer 的一致性，说明多个 ESM importer 可以共享一次 `__toESM` 调用。

## 不变量（`include_statements` 的契约）

经过本阶段之后：

1. **包装器和命名空间 `SymbolRef` 都在 `referenced_symbols` 中。** 如果下沉后的形式会提到一个包装器调用（`init_foo`、`require_foo`）或一个命名空间对象（importer 的或 importee 的 `namespace_object_ref`），那么对应的 `SymbolRef` 必须存在于 `stmt_info.referenced_symbols` 中。Tree-shaking 会丢弃未被引用的内容；这里漏推入 = 包装器/命名空间会被静默省略。
2. **运行时辅助函数放在 `depended_runtime_helper` 中，而不是 `referenced_symbols` 中。** 唯一例外是外部运行时 `__require` polyfill 分支，它会直接把解析后的 `__require` 符号推入 `referenced_symbols`。`include_statements` 会将这个映射与语句包含结果合并，并通过 `include_runtime_symbol` 拉入辅助函数。
3. **当下沉后的语句无论谁读取都必须执行时，会设置 `side_effect=true`。** 包括 `export * from 'cjs'`、`import 'esm-with-side-effects'`、所有位于 `Cjs/Iife/Umd` 下的 CJS 外部导入，以及动态 `__reExport` 分支。
4. **每个 CJS 命名空间导入都拥有稳定的 `import_<repr_name>` 名称。** 下游渲染既可以依赖 `wrap_modules` 设置的 `wrapper_ref`，也可以依赖这里设置好的命名空间名称。

这些不变量中的任意一条出错，通常会表现为 tree-shaking 的误判（输出中缺少辅助函数或包装器）或者去冲突失败。

## 实现约束

- **通过原始指针转换进行并行可变写入。** 该阶段通过 `par_iter()` 并行遍历模块（它返回 `&NormalModule`），但会写入 importer 的两个字段：`stmt_infos` 和 `depended_runtime_helper`。它们通过 `addr_of!(...).cast_mut()` 进行修改。安全性依赖于模块级隔离：每个闭包只修改它所拿到的 importer，而所有跨模块读取（例如 `self.module_table[importee_idx]`、`self.metas[..]`）都通过 `&self` 访问其他模块的状态。不要在没有重新建立安全论证的情况下，把这些转换扩大到这两个字段之外。
- **跨记录的元数据写入会延后处理。** 闭包不能直接修改 `importer.import_records[rec_id].meta`（迭代器给出的是 `&NormalModule`），因此运行时 `__require` polyfill 分支会把 `(rec_id, ImportRecordMeta::CallRuntimeRequire)` 收集到每个模块自己的 `record_meta_pairs` 中，并在并行遍历 join 之后串行应用这些写入。这是唯一的延后写入；如果未来某个分支还需要修改其他每条记录的状态，请通过同样的延后列表来处理，而不要引入第二种机制。

## 编辑说明

- **`safely_merge_cjs_ns_map` 覆盖逐条记录的互操作判断。** 当某个 importee 已存在条目时，`info.needs_interop` 具有权威性；如果只做单条记录检查，在合并场景下会算出错误结果。
- **`WrapKind::None` + `is_reexport_all` 是刻意为之。** 它用于“ESM importer 重新导出一个通过 ESM 中间层的 CJS，而该中间层具有动态导出”的链路。移除它会破坏间接 CJS 重新导出时的 `__reExport`。
- **`commonjs_treeshake` 控制 `Cjs` 重新导出分支中 importer 的 namespace-ref push。** 开启时，`include_commonjs_export_symbol` 会处理那条路径；关闭时，namespace ref 会无条件推入。
- **CSS import 类型在这里是 `unreachable!`。** JS 模块的 `import_records` 不可能合法地包含 `AtImport` / `UrlImport`；这里的 panic 是对上游分类 bug 的防护。

## 相关

- [determine-module-exports-kind](./determine-module-exports-kind.md) — 生成 `wrap_kind` 和 `safely_merge_cjs_ns_map`。
- [module-execution-order](./module-execution-order.md) — 正交关注点；`exec_order` 是 `include_statements` 用来确定性遍历模块的依据。
- `crates/rolldown/src/stages/link_stage/wrapping.rs` — 填充 `wrap_kind` 和 `wrapper_ref`。
- `crates/rolldown/src/stages/link_stage/tree_shaking/include_statements.rs` — `referenced_symbols`、`side_effect` 和 `depended_runtime_helper` 的使用方。
