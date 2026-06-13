#### 选项

##### 自动发现模式 (`true`)

当设置为 `true` 时，Rolldown 会启用自动发现模式。对于每个模块，resolver 和 transformer 都会从模块目录向上搜索，始于最近的 `tsconfig.json`。如果它包含 `references`，Rolldown 会检查每个被引用项目的 `files`/`include`/`exclude`，并使用第一个与文件匹配的项目。如果没有任何引用匹配，则会检查该 `tsconfig.json` 自身的 `files`/`include`/`exclude`。如果文件两者都不匹配，Rolldown 会继续向上查找下一个 `tsconfig.json` 并重复此过程。如果没有任何 `tsconfig.json` 与文件匹配，它会回退到找到的**最外层（最顶层）**那个，而不是最近的那个。

如果 tsconfig 包含 `references`，Rolldown 会像 TypeScript 那样解析它们：包含该文件的被引用项目会**优先于根配置**，并且第一个匹配的引用获胜。每个被引用项目都使用其自己的 `allowJs`，因此 `.js`/`.jsx`/`.mjs`/`.cjs` 文件只会被启用它的项目包含。如果没有任何被引用项目包含该文件，Rolldown 会回退到根配置自身的 `files`/`include`/`exclude`。一个 solution-style 根配置（只有 `references`，并且像 Vite 脚手架那样显式将 `files`/`include` 设为空）本身没有文件模式，因此一旦其引用都不匹配，它就**不拥有**该文件，发现过程会按照上文所述继续在父目录中进行。

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
