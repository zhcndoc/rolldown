# 因不支持的功能而失败的测试

## 插件相关

### 位于 hooks 中的 `NormalziedOptions` 与 rollup 不兼容
 - rollup@function@options-hook: 允许在 options hook 中读取和修改选项
 - rollup@function@output-options-hook: 允许在 output-options hook 中读取和修改选项

### `load` hook 返回 `ast` 不受支持
 - rollup@function@uses-supplied-ast: 使用提供的 AST
 - rollup@form@custom-ast: 支持从插件返回自定义 AST

### `resolveId` hook 的 `resolvedBy` 不受支持
 - rollup@function@validate-resolved-by-logic: 验证 resolvedBy 逻辑

### 不支持 `shouldTransformCachedModule` hook
 - rollup@function@plugin-error-should-transform: `shouldTransformCachedModule` 中的错误会中止构建

### 不支持 `resolveDynamicImport` hook 的 `specifier: AstNode`
 - rollup@form@dynamic-import-unresolvable: 返回无法解析的动态导入的原始 AST 节点@generates es
 - rollup@function@dynamic-import-expression: 动态导入表达式替换

### 不支持插件 `sequential`
 - rollup@function@enforce-sequential-plugin-order: 允许对并行插件 hook 强制执行顺序化的插件 hook 顺序
 - rollup@hooks@allows to enforce sequential plugin hook order in watch mode

### 不支持 `renderDynamicImport/resolveImportMeta/shouldTransformCachedModule` hooks
 - rollup@function@enforce-plugin-order: 允许强制执行插件 hook 顺序
 
### 不支持 `renderDynamicImport` hook
 - rollup@form@custom-dynamic-import-no-interop: 在使用自定义动态导入处理程序时不添加任何互操作@generates es

### `PluginContext.parse` 不支持 `allowReturnOutsideFunction` 选项
 - rollup@function@parse-return-outside-function: 通过选项支持解析函数外部的 return 语句

### 不支持 `PluginContext.cache`
 - rollup@function@plugin-cache@anonymous-delete: 匿名插件从缓存中删除时会抛出错误
 - rollup@function@plugin-cache@anonymous-get: 匿名插件从缓存中读取时会抛出错误
 - rollup@function@plugin-cache@anonymous-has: 匿名插件检查缓存时会抛出错误
 - rollup@function@plugin-cache@anonymous-set: 匿名插件向缓存中添加内容时会抛出错误
 - rollup@function@plugin-cache@duplicate-names: 如果两个同名且没有 cache key 的插件访问缓存，则会抛出错误
 - rollup@hooks@Disables the default transform cache when using cache in transform only
 - rollup@hooks@opts-out transform hook cache for custom cache

### `PluginContext.load` 并未完全支持
 - rollup@function@preload-cyclic-module: 在 resolveId hook 中预加载循环模块（在 resolveId hook 中加载入口模块）
 - rollup@function@preload-module: 允许通过 this.load 预加载模块（在 resolveId hook 中加载入口模块）
 - rollup@function@module-side-effects@writable: 构建期间 ModuleInfo.moduleSideEffects 应可写（在 resolveId hook 中加载入口模块）
 - rollup@function@modify-meta: 允许自由修改 moduleInfo.meta 并保持对象身份

### 不支持 `maxParallelFileOps`
 - rollup@function@max-parallel-file-operations@default: 未设置 maxParallelFileOps
 - rollup@function@max-parallel-file-operations@error: maxParallelFileOps: fileRead 错误被转发
 - rollup@function@max-parallel-file-operations@infinity: maxParallelFileOps 设置为 infinity
 - rollup@function@max-parallel-file-operations@set: maxParallelFileOps 设置为 3
 - rollup@function@max-parallel-file-operations@with-plugin: 带插件的 maxParallelFileOps

### `PluginContext.emitFile` 发出的 chunk 仅部分支持
 - rollup@function@implicit-dependencies@dependant-dynamic-import-no-effects: 当在已发出 chunk 之前加载的模块被完全 tree-shake 时抛出
 - rollup@function@implicit-dependencies@dependant-dynamic-import-not-included: 当在已发出 chunk 之前加载的模块仅通过被 tree-shake 的动态导入链接到模块图时抛出
 - rollup@function@implicit-dependencies@dependant-not-part-of-graph: 当在已发出 chunk 之前加载的模块不属于模块图时抛出
 - rollup@function@implicit-dependencies@external-dependant: 当在已发出 chunk 之前加载的模块不存在时抛出
 - rollup@function@implicit-dependencies@missing-dependant: 当在已发出 chunk 之前加载的模块是 external 时抛出
 - rollup@function@implicit-dependencies@dependent-dynamic-import-no-effects: 当在已发出 chunk 之前加载的模块被完全 tree-shake 时抛出
 - rollup@function@implicit-dependencies@dependent-dynamic-import-not-included: 当在已发出 chunk 之前加载的模块仅通过被 tree-shake 的动态导入链接到模块图时抛出
 - rollup@function@implicit-dependencies@dependent-not-part-of-graph: 当在已发出 chunk 之前加载的模块不属于模块图时抛出
 - rollup@function@implicit-dependencies@external-dependent: 当在已发出 chunk 之前加载的模块不存在时抛出
 - rollup@function@implicit-dependencies@missing-dependent: 当在已发出 chunk 之前加载的模块是 external 时抛出
 - rollup@function@emit-file@set-asset-source-chunk: 尝试设置 chunk 的资源源时抛出
 - rollup@function@emit-file@modules-loaded: 在模块完成加载后添加 chunk 时抛出
 - rollup@function@emit-file@invalid-chunk-id: 对无效的 chunk id 抛出错误
 - rollup@function@emit-file@chunk-filename-not-available-buildEnd: 在 buildEnd 中访问文件名、但其尚未生成时抛出
 - rollup@function@emit-file@chunk-filename-not-available-renderStart: 在 renderStart 中访问文件名、但其尚未生成时抛出
 - rollup@function@emit-file@chunk-filename-not-available: 在文件名尚未生成时访问它会抛出错误
 - rollup@function@emit-file@file-references-in-bundle: 在 bundle 中列出被引用的文件
 - rollup@hooks@caches chunk emission in transform hook

### 不支持 `PluginContext.emitFile` 发出预构建 chunk
 - rollup@function@emit-file@prebuilt-chunk: 获取正确的预构建 chunk
 - rollup@function@emit-file@invalid-prebuilt-chunk-filename: 对无效的预构建 chunk 文件名抛出错误
 - rollup@function@emit-file@invalid-prebuit-chunk-code: 对无效的预构建 chunk 代码抛出错误

### 不支持 `PluginContext.setAssetSource`
 - rollup@function@emit-file@asset-source-invalid2: 在设置空的资源源时抛出
 - rollup@function@emit-file@asset-source-invalid3: 在设置空的资源源时抛出
 - rollup@function@emit-file@asset-source-invalid4: 在设置空的资源源时抛出
 - rollup@function@emit-file@set-asset-source-transform: 在 transform hook 中设置资源源时抛出
 - rollup@function@emit-file@set-source-in-output-options: 尝试在 outputOptions hook 中设置文件源时抛出
 - rollup@function@emit-file@set-asset-source-twice2: 重复设置资源源时抛出
 - rollup@function@emit-file@set-asset-source-twice: 重复设置资源源时抛出
 - rollup@function@emit-file@invalid-set-asset-source-id: 对无效的资源 id 抛出错误
 - rollup@hooks@keeps emitted ids stable between runs

### `originalFileName` / `originalFileNames` 未得到妥善支持
- rollup@function@deprecated@emit-file@original-file-name: 将原始文件名转发给其他 hook
- rollup@function@emit-file@original-file-name: 将原始文件名转发给其他 hook
- rollup@function@emit-file@original-file-names: 将原始文件名转发给其他 hook

### `import.meta.ROLLUP_FILE_URL_OBJ_*` 不受支持
- rollup@chunking form@resolve-file-url-obj: 允许直接使用 ROLLUP_FILE_URL_OBJ 获取 URL 对象@generates cjs
- rollup@chunking form@resolve-file-url-obj: 允许直接使用 ROLLUP_FILE_URL_OBJ 获取 URL 对象@generates es

## 相关选项

### 不支持 `output.format` 为 systemjs
 - rollup@form@system-comments: 在渲染 system 绑定时正确放置前导注释
 - rollup@form@system-default-comments: 在渲染 system 默认导出时正确放置前导注释
 - rollup@form@system-export-declarations: 渲染部分变量被导出的声明
 - rollup@form@system-export-destructuring-declaration: 支持 systemJS 的解构声明
 - rollup@form@system-export-rendering-compact: 以紧凑模式渲染 SystemJS 输出中已导出变量的更新
 - rollup@form@system-export-rendering: 渲染 SystemJS 输出中已导出变量的更新
 - rollup@form@system-module-reserved: 不输出保留的 system 格式标识符
 - rollup@form@system-multiple-export-bindings: 支持 systemJS 中同一符号的多个活绑定
 - rollup@form@system-null-setters: 允许对仅有副作用的导入避免使用 null setter
 - rollup@form@system-reexports: 在 systemjs 中合并 reexport
 - rollup@form@system-semicolon: 支持 system binding 输出中的 ASI
 - rollup@form@system-uninitialized: 支持未初始化的绑定导出
 - rollup@form@import-namespace-systemjs: 导入命名空间（仅限 systemjs）
 - rollup@form@modify-export-semi: 在修改 SystemJS 导出时正确插入分号@generates system
 - rollup@form@system-module-reserved: 不输出保留的 system 格式标识符@generates es

### 不支持 `input.perf` 和 `bundle.getTimings()`
 - rollup@function@adds-timings-to-bundle-when-codesplitting: 在使用 perf=true 打包时向 bundle 添加耗时信息
 - rollup@function@adds-timings-to-bundle: 在使用 perf=true 打包时向 bundle 添加耗时信息

### 不支持 `input.moduleContext`
 - rollup@form@custom-module-context-function: 允许通过函数选项自定义模块级上下文
 - rollup@form@custom-module-context: 允许自定义模块级上下文@generates es

### 不支持 `output.compact`
 - rollup@function@inlined-dynamic-namespace-compact: 正确解析紧凑模式下内联的动态命名空间
 - rollup@function@compact: 使用 compact: true 的紧凑输出
 - rollup@form@compact-multiple-imports: 在紧凑模式下正确处理空的外部导入@generates es
 - rollup@form@compact: 支持 compact: true 的紧凑输出@generates es

### 不支持 `output.validate`
 - rollup@function@validate-output: 处理 validate 失败

### 不支持 `output.interop`
 - rollup@function@interop-auto-live-bindings: 处理带有活绑定支持的 "auto" 互操作
 - rollup@function@interop-auto-no-live-bindings: 处理不带活绑定支持的 "auto" 互操作
 - rollup@function@interop-default-conflict: 处理新增的 interop 默认变量冲突，并支持默认活绑定
 - rollup@function@interop-default-only-named-import: 在 interop 为 "defaultOnly" 时使用命名导入会抛出
 - rollup@function@interop-default-only-named-namespace-reexport: 允许在 interop 为 "defaultOnly" 时将命名空间重新导出为名称
 - rollup@function@interop-default-only-named-reexport: 在 interop 为 "defaultOnly" 时重新导出命名空间会抛出
 - rollup@function@interop-default-only-namespace-import: 在 interop 为 "defaultOnly" 时允许导入命名空间
 - rollup@function@interop-default-only-namespace-reexport: 在 interop 为 "defaultOnly" 时重新导出命名空间会发出警告
 - rollup@function@interop-default-only: 处理 "defaultOnly" 互操作
 - rollup@function@interop-default: 处理带有活绑定支持的 "default" 互操作
 - rollup@function@interop-esmodule: 处理带有活绑定支持的 "esModule" 互操作
 - rollup@function@invalid-interop: 对无效的 interop 值抛出错误
 - rollup@function@deconflicts-interop: 解决 interop 函数的命名冲突
 - rollup@form@interop-per-dependency-no-live-binding: 允许为每个外部依赖项配置 interop 类型
 - rollup@form@interop-per-dependency: 允许为每个外部依赖项配置 interop 类型@generates es
 - rollup@form@interop-per-reexported-dependency: 允许为每个重新导出的外部依赖项配置 interop 类型@generates es

### 不支持 `Bundle.cache`
 - rollup@function@module-tree: bundle.modules 包含依赖项（#903）
 - rollup@function@has-modules-array: 面向用户的 bundle 具有 modules 数组

### 不支持 `output.generatedCode`
 - rollup@form@generated-code-compact@arrow-functions-false: 不使用箭头函数@generates es
 - rollup@form@generated-code-compact@arrow-functions-true: 使用箭头函数@generates es
 - rollup@form@generated-code-compact@const-bindings-false: 不使用块级绑定@generates es
 - rollup@form@generated-code-compact@const-bindings-true: 使用块级绑定@generates es
 - rollup@form@generated-code-compact@object-shorthand-false: 不使用对象简写语法
 - rollup@form@generated-code-compact@object-shorthand-true: 使用对象简写语法
 - rollup@form@generated-code-compact@reserved-names-as-props-false: 对作为属性使用的保留名称进行转义@generates es
 - rollup@form@generated-code-compact@reserved-names-as-props-true: 对作为属性使用的保留名称进行转义@generates es
 - rollup@form@generated-code@arrow-functions-false: 不使用箭头函数@generates es
 - rollup@form@generated-code@arrow-functions-true: 使用箭头函数@generates es
 - rollup@form@generated-code@const-bindings-false: 不使用块级绑定@generates es
 - rollup@form@generated-code@const-bindings-true: 使用块级绑定@generates es
 - rollup@form@generated-code@object-shorthand-false: 不使用对象简写语法
 - rollup@form@generated-code@object-shorthand-true: 使用对象简写语法
 - rollup@form@generated-code@reserved-names-as-props-false: 对作为属性使用的保留名称进行转义@generates es
 - rollup@form@generated-code@reserved-names-as-props-true: 对作为属性使用的保留名称进行转义@generates es
 - rollup@function@unknown-generated-code-value: 对 generatedCode 选项的未知字符串值抛出错误

### 不支持 `output.generatedCode.preset`
 - rollup@form@generated-code-presets@es2015: 处理 generatedCode 预设 "es2015"
 - rollup@form@generated-code-presets@es5: 处理 generatedCode 预设 "es5"
 - rollup@form@generated-code-presets@preset-with-override: 处理 generatedCode 预设 "es2015"
 - rollup@function@unknown-generated-code-preset: 对 generatedCode 选项的未知预设抛出错误

### `output.generatedCode.symbols` 未得到妥善支持
 - rollup@function@name-conflict-symbol: 避免与名为 Symbol 的局部变量发生名称冲突
 - rollup@function@namespace-tostring@dynamic-import-default-mode: 为采用默认导出模式的入口 chunk 的动态导入添加 Symbol.toStringTag 属性
 - rollup@function@namespace-tostring@dynamic-import: 为动态导入添加 Symbol.toStringTag 属性
 - rollup@function@namespace-tostring@external-namespaces: 为外部命名空间添加 Symbol.toStringTag 属性
 - rollup@function@namespace-tostring@property-descriptor: 命名空间导出应具有带正确属性描述符的 @@toStringTag #4336

### `output.preserveModules` 目前还不兼容
 - rollup@function@preserve-modules-default-mode-namespace: 在保留模块时，从采用默认导出模式的 chunk 导入命名空间，
 - rollup@function@circular-preserve-modules: 在保留模块时正确处理循环依赖
 - rollup@function@missing-export-preserve-modules: 在保留模块时支持为缺失导出提供补丁
 - rollup@function@preserve-modules-circular-order: 在保留模块时保持循环依赖的执行顺序
 - rollup@function@preserve-modules@invalid-default-export-mode: 在使用默认导出模式并带有命名导出时抛出
 - rollup@function@preserve-modules@invalid-no-preserve-entry-signatures: 在将 preserveEntrySignatures 设为 false 时抛出
 - rollup@function@preserve-modules@invalid-none-export-mode: 在使用 none 导出模式并带有命名导出时抛出
 - rollup@function@preserve-modules@manual-chunks: 在保留模块时分配手动 chunk 会失败
 - rollup@function@preserve-modules@mixed-exports: 在保留模块时，对所有 chunk 中的混合导出发出警告
 - rollup@function@synthetic-named-exports@preserve-modules: 在 preserveModules 模式下处理带有 synthetic named exports 的动态导入
 - rollup@function@circular-namespace-reexport-preserve-modules: 在保留模块时正确处理带有循环依赖的命名空间重新导出

### `output.manualChunks` 不兼容
 - rollup@function@manual-chunks-conflict: 对手动 chunk 之间的冲突抛出错误
 - rollup@function@manual-chunks-include-external-modules3: 对于被 'external' 选项解析为外部模块的 manualChunks 模块，抛出错误 EXTERNAL_MODULES_CANNOT_BE_TRANSFORMED_TO_MODULES
 - rollup@function@manual-chunks-include-external-modules: 对由插件解析为外部模块的 manualChunks 模块抛出错误
 - rollup@function@manual-chunks-info: 为 manualChunks 函数提供额外的 chunk 信息
 - rollup@function@circular-namespace-reexport-manual-chunks: 在使用手动 chunk 时正确处理带有循环依赖的命名空间重新导出
 - rollup@function@emit-chunk-manual-asset-source: 支持将设置资源源作为 manual chunks 选项的副作用
 - rollup@function@emit-chunk-manual: 支持将发出 chunk 作为 manual chunks 选项的副作用
 - rollup@function@manual-chunks-order: 按入口索引对手动 chunk 进行排序

### 不支持 `format: amd`
 - rollup@function@amd-auto-id-id: 同时使用 amd.autoId 和 amd.id 选项时抛出
 - rollup@function@amd-base-path-id: 同时使用 amd.basePath 和 amd.id 选项时抛出
 - rollup@function@amd-base-path: 仅使用 amd.basePath 选项时抛出


### `output.sourcemapBaseUrl` 目前还不兼容
 - rollup@function@sourcemap-base-url-invalid: 对无效的 sourcemapBaseUrl 抛出错误
 - rollup@sourcemaps@sourcemap-base-url-without-trailing-slash: 如果缺少尾部斜杠，则自动添加@generates es
 - rollup@sourcemaps@sourcemap-base-url: 添加 sourcemap 基础 URL@generates es

### 不支持 `output.treeshake.preset`
 - rollup@function@unknown-treeshake-preset: 对 treeshake 选项的未知预设抛出错误

### `output.treeshake.moduleSideEffect` 与 rollup 不兼容
 - rollup@function@module-side-effects@resolve-id-external: 当 moduleSideEffect 为 false 时，不包含没有被使用导出的模块
 - rollup@function@module-side-effects@resolve-id: 当 moduleSideEffect 为 false 时，不包含没有被使用导出的模块

### `ModuleInfo` 与 rollup 不兼容
 - rollup@function@plugin-module-information-no-cache: 在禁用缓存时，通过插件处理对模块信息的访问
 - rollup@function@plugin-module-information: 在插件上下文中提供模块信息
 - rollup@function@module-parsed-hook: 在模块解析完成后调用 moduleParsedHook 一次
 - rollup@function@has-default-export: 报告模块是否具有默认导出（`hasDefaultExport`）
 - rollup@function@context-resolve: 为 context resolve 辅助函数返回正确结果
 - rollup@function@check-exports-exportedBindings-as-a-supplementary-test: 作为补充测试，在 moduleParsed 中检查 exports 和 exportedBindings
 - rollup@function@load-resolve-dependencies: 允许在 this.load 中等待依赖解析，以扫描依赖树（`importedIdResolutions`） 
 - rollup@function@resolve-relative-external-id: 解析相对外部 id

### chunk 信息与 rollup 不兼容
 - rollup@form@addon-functions: 在添加 addon 时提供模块信息@generates es
 - rollup@hooks@supports generateBundle hook including reporting rendered exports and source length(`modules.dep.renderedExports/removedExports`)

## 功能

### 不支持 `syntheticNamedExports`
 - rollup@form@synthetic-named-exports: 合成命名导出
 - rollup@function@synthetic-named-exports-fallback-es2015: 在合成命名导出为假值时添加回退
 - rollup@function@synthetic-named-exports-fallback: 在合成命名导出为假值时添加回退
 - rollup@function@synthetic-named-exports@circular-synthetic-exports2: 处理循环合成导出
 - rollup@function@synthetic-named-exports@circular-synthetic-exports: 处理循环合成导出
 - rollup@function@synthetic-named-exports@dynamic-import: 支持动态导入带有合成命名导出的模块
 - rollup@function@synthetic-named-exports@entry: 如果入口点使用字符串值，则不暴露合成命名空间
 - rollup@function@synthetic-named-exports@external-synthetic-exports: 外部模块不能具有 syntheticNamedExports
 - rollup@function@synthetic-named-exports@namespace-object: 不在命名空间对象中包含命名的合成命名空间
 - rollup@function@synthetic-named-exports@namespace-overrides: 支持在命名空间对象中以正确的导出优先级重新导出合成导出
 - rollup@function@synthetic-named-exports@non-default-export: 支持提供一个命名导出以生成合成导出
 - rollup@function@synthetic-named-exports@synthetic-exports-need-default: 合成命名导出模块需要默认导出
 - rollup@function@synthetic-named-exports@synthetic-exports-need-fallback-export: 合成命名导出模块需要其回退导出
 - rollup@function@synthetic-named-exports@synthetic-named-export-as-default: 确保合成命名导出的默认导出是快照
 - rollup@function@synthetic-named-exports@synthetic-named-export-entry: 不在入口点上暴露合成命名导出
 - rollup@function@reexport-from-synthetic: 处理从非合成模块重新导出合成命名空间
 - rollup@function@respect-synthetic-export-reexporter-side-effects: 即使 moduleSideEffects 关闭，也保留重新导出模块中的副作用
 - rollup@function@internal-reexports-from-external: 支持具有外部星号重新导出的命名空间
 - rollup@function@deconflict-synthetic-named-export-cross-chunk: 消除跨 chunk 的合成命名导出冲突
 - rollup@function@deconflict-synthetic-named-export: 消除合成命名导出冲突
 - rollup@form@entry-with-unused-synthetic-exports: 不在入口点中包含未使用的合成命名空间对象@generates es
 - rollup@form@merge-namespaces-non-live: 合并不带 live-binding 的命名空间
 - rollup@form@merge-namespaces: 合并带 live-binding 的命名空间
 - rollup@form@namespace-optimization-in-operator-synthetic: 使用 in 运算符时禁用对合成命名导出的优化

### 不支持 Import Assertions
 - rollup@function@import-assertions@plugin-assertions-this-resolve: 允许插件为 this.resolve' 提供断言
 - rollup@function@import-assertions@plugin-assertions-this-resolve: 允许插件为 this.resolve 提供属性
 - rollup@function@import-assertions@warn-assertion-conflicts: 对冲突的 import 属性发出警告
 - rollup@function@import-assertions@warn-unresolvable-assertions: 对无法解析的动态导入属性发出警告
 - rollup@form@deprecated@removes-dynamic-assertions: 为动态导入保留 import 断言
 - rollup@form@deprecated@removes-static-attributes: 保留输入中的任何 import 断言
  
### 不支持 Import attributes
 - rollup@form@import-attributes@attribute-shapes: 处理属性的特殊形状
 - rollup@form@import-attributes@keep-dynamic-assertions: 保留动态导入的 import attributes@generates es
 - rollup@form@import-attributes@keep-dynamic-attributes: 保留动态导入的 import attributes@generates es
 - rollup@form@import-attributes@keeps-static-assertions: 保留输入中的任何 import assertions@generates es
 - rollup@form@import-attributes@keeps-static-attributes: 保留输入中的任何 import attributes@generates es
 - rollup@form@import-attributes@plugin-attributes-resolvedynamicimport: 允许插件在 resolveDynamicImport 中读取和写入 import attributes
 - rollup@form@import-attributes@plugin-attributes-resolveid: 允许插件在 resolveId 中读取和写入 import attributes
 - rollup@form@import-attributes@removes-dynamic-attributes: 保留动态导入的 import attributes
 - rollup@form@import-attributes@removes-static-attributes: 保留输入中的任何 import attributes
 - rollup@form@import-attributes@keep-attribute-declarations-for-external-dynamic-imports: 保留外部动态导入的属性声明
 - rollup@form@import-attributes@keep-dynamic-attributes-assert: 保留带有 "assert" 键的动态导入的 import attributes@generates es
 - rollup@form@import-attributes@keep-dynamic-attributes-default: 保留动态导入的 import attributes@generates es
 - rollup@form@import-attributes@keep-dynamic-attributes-with: 保留带有 "with" 键的动态导入的 import attributes@generates es
 - rollup@form@import-attributes@keeps-static-attributes-key-assert: 使用带有 "with" 键的 import attributes 保留输入中的任何 import attributes@generates es
 - rollup@form@import-attributes@keeps-static-attributes-key-default: 使用带有 "with" 键的 import attributes 保留输入中的任何 import attributes@generates es
 - rollup@form@import-attributes@keeps-static-attributes-key-with: 使用带有 "with" 键的 import attributes 保留输入中的任何 import attributes@generates es
 - rollup@form@resolve-file-url-import-meta-attributes: 为 file resolveFileUrl 和 resolveImportMeta 钩子添加 attributes@generates es
 - rollup@form@configure-file-url: 允许配置 file urls@generates es
 - rollup@chunking form@resolve-file-url: 允许配置 file urls@generates es
 - rollup@chunking form@resolve-file-url: 允许配置 file urls@generates cjs
 - rollup@function@deprecated@load-attributes: 不允许从 "load" 钩子返回 attributes
 - rollup@function@deprecated@transform-attributes: 不允许从 "transform" 钩子返回 attributes
 - rollup@function@extend-more-hooks-to-include-import-attributes: 扩展 load、transform 和 renderDynamicImport 以包含 import attributes

### 不支持源阶段导入
 - rollup@form@source-phase-imports-external: 保留源阶段导入的外部项
 - rollup@function@source-phase-dynamic-import-error-resolved: 对带有动态属性的非外部动态源阶段导入抛出错误
 - rollup@function@source-phase-dynamic-import-error: 对非外部动态源阶段导入抛出错误
 - rollup@function@source-phase-format-unsupported: 对非 ES 输出格式中的源阶段导入抛出错误
 - rollup@function@source-phase-import-error: 对非外部源阶段导入抛出错误

### watch 行为尚不兼容
 - rollup@hooks@允许在 watch 模式下强制执行插件钩子顺序

### 不支持转义外部 id
 - rollup@form@quote-id: 处理外部 id 的转义@generates es

### 从函数体中移除 `use strict`
 - rollup@function@function-use-strict-directive-removed: 应该删除函数体中的 use strict

### 命名空间对象与 rollup 不兼容
 - rollup@function@namespaces-have-null-prototype: 创建原型为 null 的命名空间
 - rollup@function@namespaces-are-frozen: 命名空间应当不可扩展，其属性应不可修改且不可配置
 - rollup@function@namespace-override: 在覆盖命名空间重新导出为显式导出时不发出警告
 - rollup@function@escape-arguments: 默认导出时不使用 "arguments" 作为占位变量
 - rollup@function@dynamic-import-only-default: 正确导入仅具有默认导出的动态命名空间，适用于入口和非入口 chunk
 - rollup@function@dynamic-import-default-mode-facade: 处理使用默认导出模式的 facade 中的动态导入
 - rollup@function@chunking-duplicate-reexport: 处理动态导入时的重复重新导出
 - rollup@function@namespace-tostring@interop-property-descriptor: 生成的 interop 命名空间应具有正确的 Symbol.toStringTag
 - rollup@function@external-dynamic-import-live-binding-compact: 支持紧凑模式下带有 live-binding 的外部动态导入
 - rollup@function@external-dynamic-import-live-binding: 支持带有 live-binding 的外部动态导入
 - rollup@function@no-external-live-bindings: 允许省略处理外部 live-binding 的代码
 - rollup@function@no-external-live-bindings-compact: 允许省略处理外部 live-binding 的代码

### `hasOwnProperty` 导出未正确处理
 - rollup@function@re-export-own: 避免使用 export.hasOwnProperty（hasOwnProperty 行为不同）

### `__proto__` 导出未正确处理
 - rollup@form@cjs-transpiler-re-exports-1: 如果 output.externalLiveBindings 和 output.reExportProtoFromExternal 都为 false，则禁用从外部模块重新导出 __proto__@generates cjs
 - rollup@form@cjs-transpiler-re-exports: 当 output.externalLiveBindings 为 false 时，与 CJS Transpiler Re-exports 保持兼容@generates cjs

### 源映射合并逻辑对粗粒度 sourcemap 的支持不够好
- rollup@sourcemaps@combined-sourcemap-3：获取打包代码正确的合并 sourcemap@generates es

### 不支持 `strictDeprecations` 选项
 - rollup@function@deprecations@externalImportAssertions: 将 "output.externalImportAssertions" 选项标记为已弃用
 - rollup@function@deprecations@asset-filename-name: 将 assetFileNames 中发出的资产的 "name" 属性标记为已弃用
 - rollup@function@deprecations@asset-filename-originalfilename: 将 assetFileNames 中发出的资产的 "name" 属性标记为已弃用
 - rollup@function@deprecations@asset-name-in-bundle: 将 generateBundle 中发出的资产的 "name" 属性标记为已弃用
 - rollup@function@deprecations@asset-originalfilename-in-bundle: 将在 generate 阶段发出的资产的 "originalFileName" 属性标记为在 generateBundle 中已弃用
 - rollup@function@deprecations@asset-render-chunk-originalfilename-in-bundle: 将在 generate 阶段发出的资产的 "originalFileName" 属性标记为在 generateBundle 中已弃用
 - rollup@function@deprecations@asset-render-chunk-name-in-bundle: 将在 generate 阶段发出的资产的 "name" 属性标记为在 generateBundle 中已弃用

### 错误/警告信息与 rollup 不兼容
 - rollup@function@banner-and-footer: 添加 banner/footer（期望 `ADDON_ERROR` 但得到了 `PLUGIN_ERROR`）
 - rollup@function@conflicting-reexports@named-import: 当通过命名导入导入冲突绑定时抛出错误（期望 `AMBIGUOUS_EXTERNAL_NAMESPACES` 但得到了 `MISSING_EXPORT`）
 - rollup@function@logging@handle-logs-in-plugins: 允许插件读取和过滤日志
 - rollup@hooks@supports renderError hook
 - rollup@function@ast-validations@redeclare-catch-scope-parameter-var-outside-conflict: 当将 catch 作用域的参数重新声明为与外部绑定冲突的 var 时抛出错误（未知）
 - rollup@function@import-not-at-top-level-fails: 禁止非顶层导入（缺少 `cause` 属性）
 - rollup@function@export-not-at-top-level-fails: 禁止非顶层导出（缺少 `cause` 属性）

### 未实现的错误/警告
 - rollup@hooks@Throws when using the "sourcemapFile" option for multiple chunks (`INVALID_OPTION` error)
 - rollup@function@non-function-hook-async: 在为异步函数 hook 提供值时抛出错误（期望 `INVALID_PLUGIN_HOOK` 错误，但得到 `PLUGIN_ERROR`）
 - rollup@function@non-function-hook-sync: 在为同步函数 hook 提供值时抛出错误（`INVALID_PLUGIN_HOOK` 错误）
 - rollup@function@export-type-mismatch-b: 导出类型必须为 auto、default、named 或 none（期望 `INVALID_EXPORT_OPTION` 错误，但得到 `InvalidArg`）
 - rollup@function@assign-namespace-to-var: 允许将命名空间赋值给变量（`EMPTY_BUNDLE` 警告）
 - rollup@function@can-import-self-treeshake: 直接自我导入（`EMPTY_BUNDLE` 警告）
 - rollup@function@external-conflict: 来自自定义解析器的外部路径保持为 external (#633)（`INVALID_EXTERNAL_ID` 错误）
 - rollup@function@shims-missing-exports: 为缺失的导出生成 shim（`SHIMMED_EXPORT` 警告）
 - rollup@function@conflicting-reexports@named-import-external: 当通过来自外部命名空间的命名导入导入冲突绑定时发出警告（`AMBIGUOUS_EXTERNAL_NAMESPACES` 警告）
 - rollup@function@cycles-pathological-2: 能更优雅地解析更复杂的循环依赖
 - rollup@function@circular-missed-reexports: 处理循环重导出（`MISSING_EXPORT` 应为警告而不是错误）
 - rollup@function@iife-code-splitting: 在 IIFE 构建中生成多个 chunk 时抛出错误（`INVALID_OPTION` 错误）
 - rollup@function@inline-imports-with-multiple-array: 在内联动态导入时，不支持数组形式的多个输入（期望 `INVALID_OPTION`，但得到 `GenericFailure`）
 - rollup@function@inline-imports-with-multiple-object: 在内联动态导入时，不支持对象形式的多个输入（期望 `INVALID_OPTION`，但得到 `GenericFailure`）
 - rollup@function@preserve-modules@inline-dynamic-imports: 在保留模块时不支持内联动态导入（期望 `INVALID_OPTION`，但得到 `GenericFailure`）
 - rollup@function@inline-imports-with-manual: 在内联动态导入时不支持手动分块（`INVALID_OPTION` 错误）
 - rollup@function@warning-low-resolution-location: 处理使用低分辨率 sourcemap 报告错误的情况（`THIS_IS_UNDEFINED` 警告）
 - rollup@function@warning-incorrect-sourcemap-location: 如果由于缺少 sourcemap 导致警告位置不正确，则不应失败（期望 `MISSING_EXPORT` 警告，但得到 `IMPORT_IS_UNDEFINED`）
 - rollup@function@paths-are-case-sensitive: 强制要求导入时的大小写正确
 - rollup@function@warnings-to-string: 为警告提供字符串转换（`EMPTY_BUNDLE` 警告）
 - rollup@function@warn-on-empty-bundle: 如果生成了空 bundle，则发出警告  (#444)（`EMPTY_BUNDLE` 警告）
 - rollup@function@warn-on-namespace-conflict: 对重复的 export * from 发出警告（`NAMESPACE_CONFLICT` 警告）
 - rollup@function@warn-on-unused-missing-imports: 对缺失但未使用的导入发出警告（`MISSING_EXPORT` 应为警告而不是错误）
 - rollup@function@warn-misplaced-annotations: 对放错位置的注解发出警告（`INVALID_ANNOTATION` 警告）
 - rollup@function@namespace-missing-export: 用 undefined 替换缺失的命名空间成员并对其发出警告（期望 `MISSING_EXPORT` 警告，但得到 `IMPORT_IS_UNDEFINED`）
 - rollup@function@transform-without-code-warn-ast: 当 transform hook 返回 map 但没有返回 code 时发出警告（`NO_TRANSFORM_MAP_OR_AST_WITHOUT_CODE` 警告）
 - rollup@function@transform-without-code-warn-map: 当 transform hook 返回 map 但没有返回 code 时发出警告（`NO_TRANSFORM_MAP_OR_AST_WITHOUT_CODE` 警告）
 - rollup@function@unknown-treeshake-value: 对 treeshake 选项中未知的字符串值抛出错误（`INVALID_OPTION` 错误）
 - rollup@function@warns-for-invalid-options: 对无效选项发出警告（`UNKNOWN_OPTION` 警告）
 - rollup@function@module-side-effects@invalid-option: 对无效选项发出警告（期望 `INVALID_OPTION` 错误，但得到 `InvalidArg`）
 - rollup@function@invalid-addon-hook: 在为 addon hook 提供非字符串值时抛出错误（期望 `ADDON_ERROR` 错误，但得到 `unreachable: Invalid hook type`）
 - rollup@function@invalid-ignore-list-function: 如果 sourcemapIgnoreList 函数没有返回布尔值，则抛出描述性错误（期望 `VALIDATION_ERROR` 错误，但得到 `InvalidArg`）
 - rollup@function@invalid-transform-source-function: 如果 sourcemapPathTransform 函数没有返回字符串，则抛出描述性错误 (#3484)（期望 `VALIDATION_ERROR` 错误，但得到 `GenericFailure`）
 - rollup@function@invalid-pattern-replacement: 对模式中的无效占位符抛出错误（`VALIDATION_ERROR` 错误）
 - rollup@function@invalid-pattern: 对无效模式抛出错误（期望 `VALIDATION_ERROR` 错误，但得到 `INVALID_OPTION`）
 - rollup@function@invalid-top-level-await: 对无效的 top-level-await 格式抛出错误（期望 `INVALID_TLA_FORMAT` 错误，但得到 `UNSUPPORTED_FEATURE`）
 - rollup@function@load-returns-string-or-null: 如果 load 返回了奇怪的内容则抛出错误（期望 `BAD_LOADER` 错误，但得到 `InvalidArg`）
 - rollup@function@vars-with-init-in-dead-branch: 处理死分支中带初始值的变量 (#1198)（`EMPTY_BUNDLE` 警告）
 - rollup@function@module-level-directive: 模块级指令应产生警告（`MODULE_LEVEL_DIRECTIVE` 警告）
 - rollup@function@hashing@maximum-hash-size: 当超过最大 hash 大小时抛出错误（`VALIDATION_ERROR` 错误）
 - rollup@function@hashing@minimum-hash-size: 当超过最大 hash 大小时抛出错误（`VALIDATION_ERROR` 错误）
 - rollup@function@hashing@length-at-non-hash: 在为非 "hash" 占位符配置长度时抛出错误（`VALIDATION_ERROR` 错误）
 - rollup@function@emit-file@invalid-file-type: 对无效文件类型抛出错误（期望 `pluginCode":"VALIDATION_ERROR"`，但得到 `pluginCode:"InvalidArg"`）
 - rollup@function@emit-file@emit-same-file: 如果发出了多个同名文件则发出警告（`FILE_NAME_CONFLICT` 错误）
 - rollup@function@emit-file@emit-from-output-options: 当尝试从 outputOptions hook 中发出文件时抛出错误（`CANNOT_EMIT_FROM_OPTIONS_HOOK` 错误）
 - rollup@function@conflicting-reexports@namespace-import: 当通过命名空间导入导入冲突绑定时发出警告（`MISSING_EXPORT` 警告）
 - rollup@function@cannot-resolve-sourcemap-warning: 处理无法解析 sourcemap 的警告（`SOURCEMAP_ERROR` 警告）
 - rollup@function@adds-json-hint-for-missing-export-if-is-json-file: 在导入一个没有导出的 json 文件时应提供 json 提示（期望 `pluginCode":"VALIDATION_ERROR"`，但得到 `pluginCode:"InvalidArg"`）
 - rollup@function@emit-file@asset-source-invalid: 设置空的 asset source 时抛出错误（期望 `pluginCode":"VALIDATION_ERROR"`，但得到 `pluginCode:"InvalidArg"`）
 - rollup@function@emit-file@asset-source-missing3: 在设置 asset source 之前访问文件名时抛出错误（预期 `ASSET_SOURCE_MISSING` 错误，但抛出的是 `PLUGIN_ERROR`）
 - rollup@function@emit-file@asset-source-missing4: 在设置 asset source 之前访问文件名时抛出错误（预期 `ASSET_SOURCE_MISSING` 错误，但抛出的是 `PLUGIN_ERROR`）
 - rollup@function@emit-file@asset-source-missing2: 未设置 asset source 时抛出错误（预期 `ASSET_SOURCE_MISSING` 错误，但抛出的是 `PLUGIN_ERROR`）
 - rollup@function@emit-file@asset-source-missing5: 未设置 asset source 且访问 asset URL 时抛出错误（预期 `ASSET_SOURCE_MISSING` 错误，但抛出的是 `PLUGIN_ERROR`）
 - rollup@function@emit-file@asset-source-missing: 未设置 asset source 时抛出错误（预期 `ASSET_SOURCE_MISSING` 错误，但抛出的是 `PLUGIN_ERROR`）
 - rollup@form@cycles-dependency-with-TLA-await-import: 当检测到包含顶层 await 导入的循环时抛出警告（`CIRCULAR_DEPENDENCY` 警告）
 - rollup@function@optional-chaining-namespace: 处理带命名空间的可选链（期望 `MISSING_EXPORT` 警告，但得到 `IMPORT_IS_UNDEFINED` 警告）
 - rollup@function@ast-validations@redeclare-import-var: 通过 var 重新声明导入时抛出错误（https://github.com/oxc-project/oxc/issues/15961）
 - rollup@function@warn-on-top-level-this: 对顶层 this 发出警告 (#770)（`THIS_IS_UNDEFINED` 警告）
 - rollup@sourcemaps@warning-with-coarse-sourcemap: 在 coarse sourcemap@generates es 的情况下获得正确的映射位置（`THIS_IS_UNDEFINED` 警告）
 - rollup@function@circular-namespace-reexport-cache: 通过缓存的命名空间重导出处理多个导入者的循环重导出（`CYCLIC_CROSS_CHUNK_REEXPORT` 警告）
