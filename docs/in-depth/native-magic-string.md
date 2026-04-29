# Native MagicString

## 概览

`experimental.nativeMagicString` 是一项优化功能，它使用原生 Rust 版本替换基于 JavaScript 的 MagicString 实现，从而支持在后台线程中生成 source map，以提升性能。

## 什么是 MagicString？

MagicString 是由 Rich Harris（Rollup 和 Svelte 的创建者）开发的一个 JavaScript 库，它提供了高效的字符串操作，并自动生成 source map。它通常被打包器和构建工具用于：

- 插件中的代码转换
- source map 生成
- 精确的行/列跟踪
- 高效的字符串操作（替换、前置、追加等）

## JavaScript 实现 vs 原生 Rust

### 传统的 JavaScript MagicString

原始的 MagicString 实现是用 JavaScript 编写的，并运行在 Node.js 环境中。当打包器进行代码转换时，通常会：

1. 将源代码作为 JavaScript 字符串加载
2. 使用 MagicString API 应用转换
3. 为转换后的代码生成 source map
4. 在主 JavaScript 线程中处理所有内容

### 原生 Rust 实现

Rolldown 的原生 MagicString 实现用 Rust 重写了核心功能，带来了几个优势：

- **性能**：Rust 的内存安全和零成本抽象使字符串操作更快
- **并行处理**：source map 生成可以在后台线程中完成
- **内存效率**：更适合大规模代码库的内存管理
- **集成**：与 Rolldown 基于 Rust 的架构无缝集成

## 工作原理

当启用 `experimental.nativeMagicString` 时，Rolldown 会修改转换流水线。下图展示了架构上的差异：

:::info
某些技术细节为了便于说明而进行了简化。原生 MagicString 实现会在 transform hooks 的 `meta` 参数中提供一个 `magicString` 对象，插件可以像使用 JavaScript 版本一样使用它。
:::

### 不使用 Native MagicString

<img width="3426" height="1699" alt="js-magic-string" src="https://github.com/user-attachments/assets/c9e81f8a-fad0-4f99-99c4-c71c67b8912e" style="background: white;" />

（图片中的更正：`rolldown without js magic-string` 应为 `rolldown without native magic-string`）

### 使用 Native MagicString

<img width="3343" height="1659" alt="native-magic-string" src="https://github.com/user-attachments/assets/71ca5d7b-9b40-46ce-86dd-bfa4bdd73f4b" style="background: white;" />

**关键区别**：原生实现使用 Rust 编写，同时具备 Rust 的性能优势和后台线程 source map 生成能力。卸载到后台线程可提升整体 CPU 利用率，并带来显著的性能改进。

## API 兼容性

原生实现与 JavaScript 版本保持 API 兼容。最常用的 API 已经实现，其余 API 计划在后续版本中补齐。

### 已实现的方法

以下 MagicString 方法目前在原生实现中可用：

**字符串操作：**

- `append(content)` - 将内容追加到字符串末尾
- `prepend(content)` - 将内容前置到字符串开头
- `appendLeft(index, content)` - 将内容追加到指定索引左侧
- `appendRight(index, content)` - 将内容追加到指定索引右侧
- `prependLeft(index, content)` - 将内容前置到指定索引左侧
- `prependRight(index, content)` - 将内容前置到指定索引右侧
- `overwrite(start, end, content)` - 替换一个范围内的内容
- `update(start, end, content)` - 更新一个范围内的内容
- `remove(start, end)` - 删除一个范围内的内容
- `replace(from, to)` - 替换第一次出现的模式
- `replaceAll(from, to)` - 替换所有出现的模式

**转换：**

- `indent(indentor?)` - 使用可选的自定义缩进字符串缩进内容
- `relocate(start, end, to)` - 将内容从一个位置移动到另一个位置

**工具：**

- `toString()` - 返回转换后的字符串
- `hasChanged()` - 检查字符串是否已被修改
- `length()` - 返回转换后字符串的长度
- `isEmpty()` - 检查字符串是否为空
- `clone()` - 返回 MagicString 实例的克隆
- `trim(charType?)` - 去除两端的空白字符或指定字符
- `trimStart(charType?)` - 去除开头的空白字符或指定字符
- `trimEnd(charType?)` - 去除末尾的空白字符或指定字符
- `trimLines()` - 去除两端的换行符
- `snip(start, end)` - 返回一个克隆，并移除范围外的内容
- `slice(start?, end?)` - 返回位置之间的内容
- `reset(start, end)` - 将某个范围重置为原始内容
- `lastChar()` - 返回最后一个字符
- `lastLine()` - 返回最后一个换行符之后的内容

**Source Map 生成：**

- `generateMap(options?)` - 生成一个 JSON 字符串形式的 source map
  - `options.source` - 源文件名
  - `options.includeContent` - 在 map 中包含原始源代码
  - `options.hires` - 高分辨率模式：`true`、`false` 或 `"boundary"`

### 尚未实现

以下功能计划在未来版本中实现：

- `generateDecodedMap()` - 生成带解码映射的 source map

## 真实世界性能

使用 [rolldown/benchmarks](https://github.com/rolldown/benchmarks/) 作为基准测试用例

### 构建时间

| Runs       | oxc raw transfer + js magicString | oxc raw transfer + native magicString | Time Saved | Speedup |
| ---------- | --------------------------------- | ------------------------------------- | ---------- | ------- |
| apps/1000  | 497.6 ms                          | 431.1 ms                              | 66.5 ms    | 1.15x   |
| apps/5000  | 1.100 s                           | 894.5 ms                              | 205.5 ms   | 1.23x   |
| apps/10000 | 1.814 s                           | 1.368 s                               | 446.0 ms   | 1.33x   |

### 插件转换时间（构建时间 - noop 插件构建时间）

| Runs  | Transform Time (oxc raw transfer + js magicString) | Transform Time (oxc raw transfer + native magicString) | Time Saved | Speedup |
| ----- | -------------------------------------------------- | ------------------------------------------------------ | ---------- | ------- |
| 1000  | 172.0 ms                                           | 105.5 ms                                               | 66.5 ms    | 1.63x   |
| 5000  | 455.4 ms                                           | 249.9 ms                                               | 205.5 ms   | 1.82x   |
| 10000 | 799.0 ms                                           | 353.0 ms                                               | 446.0 ms   | 2.26x   |

如需详细的基准测试结果，请参阅 [benchmark pull request](https://github.com/rolldown/benchmarks/pull/9/files)。

## 使用示例

### 带 Native MagicString 的基础插件

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';

export default defineConfig({
  experimental: {
    nativeMagicString: true,
  },
  output: {
    sourcemap: true,
  },
  plugins: [
    {
      name: 'transform-example',
      transform(code, id, meta) {
        if (!meta?.magicString) {
          // nativeMagicString 不可用时的回退方案
          return null;
        }

        const { magicString } = meta;

        // 示例转换：添加调试注释
        if (code.includes('console.log')) {
          magicString.replace(/console\.log\(/g, 'console.log("[DEBUG]", ');
        }

        // 示例：添加文件头
        magicString.prepend(`// Transformed from: ${id}\n`);

        return {
          code: magicString,
        };
      },
    },
  ],
});
```

## 兼容性与回退方案

### 检查 Native MagicString 是否可用

```javascript [rolldown.config.js]
transform(code, id, meta) {
  if (meta?.magicString) {
    // Native MagicString 可用
    const { magicString } = meta;

    // 使用原生实现
    // 注意：直接返回 magicString 对象，而不是字符串
    return {
      code: magicString
    };
  } else {
    // 回退到常规字符串操作
    // 或使用 JavaScript 版 MagicString 库
    const MagicString = require('magic-string');
    const ms = new MagicString(code);

    // 你的转换逻辑写在这里...

    return {
      code: ms.toString(),
      map: ms.generateMap()
    };
  }
}
```

### Rollup 兼容性

此功能是 Rolldown 特有的，Rollup 中不可用。对于需要同时兼容这两种打包器的插件：

```javascript [plugin.js]
function createTransform() {
  return function (code, id, meta) {
    if (meta?.magicString) {
      // 带有 native MagicString 的 Rolldown
      return transformWithNativeMagicString(code, id, meta);
    } else {
      // Rollup 或不带 native MagicString 的 Rolldown
      return transformWithJsMagicString(code, id);
    }
  };
}
```

::: tip

你可以使用 [`rolldown-string`](https://github.com/sxzz/rolldown-string)，它提供了一个适用于两种打包器的统一接口。

:::

## 何时使用 Native MagicString

### 推荐场景

1. **大型代码库**：包含数百或数千个文件的项目
2. **复杂转换**：执行大量代码处理的插件
3. **密集型 Source Map**：需要详细 source map 的项目
4. **性能关键**：构建速度至关重要的场景
5. **开发模式**：开发期间需要更快的重建速度

### 需要谨慎的情况

1. **实验性功能**：作为实验性功能，API 可能会变化
2. **插件兼容性**：某些插件可能依赖特定的 JavaScript MagicString 行为
3. **调试**：原生实现的错误信息可能有所不同

## 迁移指南

### 启用 Native MagicString

1. **更新配置**：

```javascript [rolldown.config.js]
export default {
  experimental: {
    nativeMagicString: true,
  },
  output: {
    sourcemap: true, // source map 生成所必需
  },
};
```

2. **更新插件**：

```javascript [rolldown.config.js]
// 之前
transform(code, id) {
  const ms = new MagicString(code);
  // ... 转换
  return { code: ms.toString(), map: ms.generateMap() };
}

// 之后
transform(code, id, meta) {
  if (meta?.magicString) {
    const { magicString } = meta;
    // ... 转换（相同的 API）
    return { code: magicString };
  }
  // 回退逻辑
}
```

## 限制和注意事项

### 当前限制

1. **实验性状态**：API 可能会在未来版本中发生变化
2. **边缘情况**：某些边缘情况的行为可能与 JavaScript 版本不同
3. **调试**：错误消息可能不太熟悉

### 最佳实践

1. **始终检查可用性**：在使用前验证 `meta?.magicString` 是否存在
2. **提供回退方案**：加入回退逻辑以确保兼容性
3. **充分测试**：使用两种实现方式测试转换结果
4. **报告问题**：将任何行为差异报告给 Rolldown 团队

## 结论

`experimental.nativeMagicString` 通过利用 Rust 在代码转换任务中的高效性，为 Rolldown 带来了显著的性能优化。虽然它需要在兼容性方面做一些考虑，但其性能优势使其成为大规模项目和性能关键型构建流程的一个有吸引力的选择。

作为一个实验性功能，建议在开发环境中进行充分测试后，再在生产工作流中采用。Rolldown 团队正在积极推进这一功能，社区反馈对其持续发展具有重要价值。
