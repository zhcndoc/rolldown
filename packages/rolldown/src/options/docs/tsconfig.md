#### 选项

##### 自动发现模式 (`true`)

当设置为 `true` 时，Rolldown 会启用自动发现模式（类似于 Vite）。对于每个模块，解析器和转换器都会查找最近的 `tsconfig.json`。

如果 tsconfig 包含 `references`，Rolldown 会按照 TypeScript 的方式解析它们：包含该文件的被引用项目**优先于根配置**。每个被引用项目都会使用自己的 `allowJs`，因此 `.js`/`.jsx`/`.mjs`/`.cjs` 文件只会被启用它的项目包含。如果没有任何被引用项目包含该文件，Rolldown 会回退到根 tsconfig。

```js
export default {
  tsconfig: true,
};
```

##### 显式路径 (`string`)

指定某个特定 TypeScript 配置文件的路径。你可以提供相对路径（相对于 `cwd` 解析）或绝对路径。

如果 tsconfig 包含 `references`，此模式在引用解析方面的行为与自动发现模式相同。

```js
export default {
  tsconfig: './tsconfig.json',
};
```

```js
export default {
  tsconfig: '/absolute/path/to/tsconfig.json',
};
```

:::tip
Rolldown 会遵守 tsconfig 中的 `references` 以及 `include`/`exclude` 模式，而 esbuild 不会。如果你需要与 esbuild 兼容的行为，请指定一个不包含 `references` 的 tsconfig。你可以使用 [`extends`](https://www.typescriptlang.org/tsconfig/#extends) 在两者之间共享这些选项。
:::

#### tsconfig 中会使用哪些内容

当 tsconfig 被解析后，Rolldown 会针对不同用途使用其中的不同部分：

##### 解析器

用于模块路径映射的配置如下：

- `compilerOptions.paths`：用于模块解析的路径映射
- `compilerOptions.baseUrl`：路径解析的基础目录

##### 转换器

会使用部分编译器选项，包括：

- `jsx`：JSX 转换模式
- `experimentalDecorators`：启用装饰器支持
- `emitDecoratorMetadata`：生成装饰器元数据
- `verbatimModuleSyntax`：保留模块语法
- `useDefineForClassFields`：类字段语义
- 以及其他 TypeScript 特定选项

##### 示例

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@components/*": ["src/components/*"]
    }
  }
}
```

使用此配置：

- JSX 将使用 React 的自动运行时
- 像 `@/utils` 这样的路径别名将解析为 `src/utils`

#### 优先级

顶层的 `transform` 选项始终优先于 tsconfig 设置：

```js
export default {
  tsconfig: './tsconfig.json', // 具有 jsx: 'react-jsx'
  transform: {
    jsx: {
      mode: 'classic', // 这里优先
    },
  },
};
```

:::tip
对于 TypeScript 项目，建议使用 `tsconfig: true` 来自动发现，或者指定显式路径，以确保一致的编译行为并启用路径映射。
:::
