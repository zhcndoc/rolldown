# 故障排查

## 性能

性能是 Rolldown 的首要目标之一。然而，构建性能并不仅仅由 Rolldown 本身决定。它还会受到运行环境和所使用插件的显著影响。

虽然我们会持续努力改进 Rolldown，以尽量减少这些外部因素的影响，但仍然存在一些固有的限制，并且某些优化仍在进行中。本指南将介绍可能的瓶颈，以及你可以如何缓解它们。

### 环境

操作系统及其配置会影响构建时间，尤其是文件系统操作。

#### Windows

与 macOS 或 Linux 等其他操作系统相比，Windows 上的文件系统访问通常更慢。尤其是杀毒软件会让这种情况变得更糟。即使没有杀毒软件干扰，基础文件系统性能通常也更慢。它比 macOS 慢 3 倍，比 Linux 慢 10 倍。当大多数转换都在没有插件的情况下完成时，这就会成为瓶颈。

为了提升 Windows 上的性能，可以考虑使用其他文件系统环境：

1. [**Dev Drive**](https://learn.microsoft.com/en-us/windows/dev-drive/): Windows 较新的一个功能，专为开发者工作负载设计，使用弹性文件系统（ReFS）。与标准的 Windows NTFS 文件系统相比，使用 Dev Drive 进行文件系统操作可带来 **2x 到 3x 的速度提升**。
2. [**Windows Subsystem for Linux (WSL)**](https://learn.microsoft.com/en-us/windows/wsl/): WSL 让 Linux 环境可以轻松在 Windows 上运行，并提供显著更好的文件系统性能。将项目文件放在 WSL 中并在其中运行构建过程，相较于标准的 Windows NTFS 文件系统，文件系统操作的速度可提升约 **10x**。

:::details 基准参考

所使用的基准脚本在这篇博客文章中有描述（[How fast can you open 1000 files?](https://lemire.me/blog/2025/03/01/how-fast-can-you-open-1000-files/)）。

结果如下：

|        文件系统 / 线程数 |     1 |     2 |     4 |     8 |    16 |
| -----------------------: | ----: | ----: | ----: | ----: | ----: |
|             Windows NTFS | 286ms | 153ms |  85ms | 106ms | 110ms |
| Windows Dev Drive (ReFS) | 124ms |  67ms |  35ms |  48ms |  55ms |
|               WSL (ext4) |  24ms |  13ms | 7.8ms | 9.0ms |  13ms |

基准测试运行于以下环境：

- 操作系统: Windows 11 Pro 23H2 22631.5189
- CPU: AMD Ryzen 9 5900X
- 内存: DDR4-3600 32GB
- SSD: Western Digital Black SN850X 1TB

:::

<!-- 也许还要写一下 macOS？ -->

### 插件

插件扩展了 Rolldown 的功能，但也可能引入性能开销。

#### 插件 Hook 过滤器

Rolldown 提供了一项名为 **插件 Hook 过滤器** 的功能。这允许你精确指定插件 hook 应该处理哪些模块，从而减少 JavaScript 和 Rust 之间的通信开销。有关过滤器内部工作原理的详细信息，请参阅 [Hook Filters](/apis/plugin-api/hook-filters) 页面。

如果你是插件使用者，并且你使用的插件没有指定 hook 过滤器，你可以使用 Rolldown 导出的 `withFilter` 工具函数为其添加过滤器。

```js
import yaml from '@rollup/plugin-yaml';
import { defineConfig } from 'rolldown';
import { withFilter } from 'rolldown/filter';

export default defineConfig({
  plugins: [
    // 仅对以 `.yaml` 结尾的模块运行 `yaml` 插件的 transform hook
    withFilter(
      yaml({
        /*...*/
      }),
      { transform: { id: /\.yaml$/ } },
    ),
  ],
});
```

#### 利用内置功能

Rolldown 包含若干为高效而设计的内置功能。只要可能，优先使用这些原生能力，而不是使用执行类似任务的外部 Rollup 插件。依赖内置功能通常意味着处理完全在 Rust 内部完成，从而可以并行处理。

可查看 [Rolldown Features](/guide/notable-features) 页面，了解 Rollup 中不存在的能力。

例如，以下常见的 Rollup 插件可以被 Rolldown 的内置功能替代：

- `@rollup/plugin-alias`: [`resolve.alias`](/reference/InputOptions.resolve#alias) 选项
- `@rollup/plugin-commonjs`: 开箱即支持
- `@rollup/plugin-inject`: [`inject`](/guide/notable-features#inject) 选项
- `@rollup/plugin-replace`: [`replacePlugin`](/builtin-plugins/replace)
- `@rollup/plugin-node-resolve`: 开箱即支持
- `@rollup/plugin-json`: 开箱即支持
- `@rollup/plugin-swc`, `@rollup/plugin-babel`, `@rollup/plugin-sucrase`: 通过 Oxc 开箱即支持（复杂配置可能仍然需要插件）
- `@rollup/plugin-terser`: `output.minify` 选项

<!--
experimental plugins (do we want to document these?)

- `@rollup/plugin-dynamic-import-vars`: `import { viteDynamicImportVarsPlugin } from 'rolldown/experimental'`

-->

## 避免直接使用 `eval`

`eval()` 函数会对一段 JavaScript 代码字符串求值。`eval()` 调用有两种模式：直接 eval 和间接 eval。直接 eval 指的是直接调用全局 `eval` 函数的情况。与间接 eval 不同，直接 eval 允许传入的字符串访问调用者的局部作用域变量。

在打包代码时，直接 eval 会带来多方面的问题：

- Rolldown 采用一种名为“作用域提升（scope hoisting）”的优化，它会把多个文件放入同一个作用域。然而，这意味着通过直接 `eval` 求值的代码可以读取和写入 bundle 中另一个文件里的变量！这会带来正确性问题，因为被求值的代码可能尝试访问一个全局变量，却意外访问到了另一个文件中同名的私有变量。**如果另一个文件中的私有变量包含敏感数据，这甚至可能构成安全问题**。
- Rolldown 可能会重命名 bundle 中的一些变量，以避免名称冲突。虽然在不使用直接 eval 时这不是问题，但对于直接 eval 来说却是问题，因为通过直接 eval 求值的代码可能会尝试使用原始名称引用被重命名后的变量。
- 为了保证正确性，压缩器会避免对可能被直接 eval 代码引用的变量名进行混淆。直接 eval 还会阻止其他一些优化。这意味着输出代码无法被高效压缩。

幸运的是，通常很容易避免使用直接 eval。下面是两种常见的替代方式，它们可以避免上面提到的所有缺点：

- `(0, eval)('x')`

  这是使用间接 eval 最常见的方式。触发间接 eval 的方法还有其他一些。例如，`var eval2 = eval; eval2('x')`、`[eval][0]('x')` 和 `window.eval('x')` 都属于间接 eval 调用。当你使用间接 eval 时，代码会在全局作用域中求值，而不是在调用者的内联作用域中。

- `new Function('x')`

  这会在运行时构造一个新的函数对象。它就像你在全局作用域中写了 `function() { x }` 一样，只不过 `x` 可以是一段任意的代码字符串。这种形式有时很方便，因为你可以给函数添加参数，并使用这些参数向被求值的代码暴露变量。例如，`(new Function('env', 'x'))(someEnv)` 就像你写了 `(function(env) { x })(someEnv)`。当被求值的代码需要访问局部变量时，这通常是直接 `eval` 的一个足够好的替代方案，因为你可以将局部变量作为参数传入。

## 避免在导出的函数中依赖 `this`

在 JavaScript 中，`this` 是一个特殊变量，它的绑定值通常会根据函数的调用方式而不同。例如，当函数作为对象的方法被调用时，`this` 会绑定到该对象。

```js
const obj = {
  method() {
    console.log(this); // 这里的 `this` 是 `obj`
  },
};
obj.method();
```

与此类似，当一个函数从模块中导出，并通过模块命名空间对象调用时，根据 ECMAScript 规范，`this` 会绑定到该模块命名空间对象。

```js
// imported.js
export function method() {
  console.log(this); // 这里的 `this` 是 `imported.js` 的模块命名空间对象

// main.js
import * as namespace from './imported.js';
namespace.method();
```

然而，在这种情况下，**Rolldown 不一定会保留 `this` 的值**。因此，建议避免在导出的函数中依赖 `this`。不过，这种行为在大多数打包器中都很常见，实际上通常不会成为问题。

之所以会有这种行为，是因为保留 `this` 的值会限制 tree-shaking 的可能性。例如，如果 `this` 变量需要绑定到模块命名空间对象，那么即使模块中的某些导出没有通过 `import` 使用，该模块中的所有导出也都无法被 tree-shake 掉。

::: tip 输出为 CJS 时的类似问题

与上面描述的问题类似，当将代码输出为 CJS 时，Rolldown 也不一定会保留导出函数的 `this` 值。在这种情况下，本应为 `undefined` 的 `this` 可能会绑定到 `module.exports` 对象。

:::
