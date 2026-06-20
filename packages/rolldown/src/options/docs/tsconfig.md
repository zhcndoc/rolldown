#### 选项

##### 自动发现模式 (`true`)

当设置为 `true` 时，Rolldown 会启用自动发现模式。对于每个模块，解析器和转换器都会从模块所在目录**向上**搜索，从最近的 `tsconfig.json` 开始。如果它包含 `references`，Rolldown 会检查每个被引用项目的 `files`/`include`/`exclude`，并使用第一个与该文件匹配的项目。如果没有任何引用匹配，则会检查 `tsconfig.json` 自身的 `files`/`include`/`exclude`。如果该文件两者都不匹配，Rolldown 会继续向上查找下一个 `tsconfig.json` 并重复上述过程。如果没有任何 `tsconfig.json` 与该文件匹配，则不会应用任何配置（没有 `paths`/`baseUrl`），这与 TypeScript 的行为相同。

`include` 的 glob 是否能匹配某个文件，取决于其扩展名：默认情况下，只匹配 TypeScript 文件（`.ts`/`.tsx`/`.mts`/`.cts`），以及在启用 `allowJs` 时匹配 `.js`/`.jsx`/`.mjs`/`.cjs`。如果 glob 指定了显式扩展名（例如 `src/**/*.vue`），则会按该扩展名原样匹配，因此非 TS 文件也可以使用项目的 `paths`/`baseUrl`。（`files` 列出的是精确路径，因此无论扩展名或 `allowJs` 如何，都会匹配）

如果 tsconfig 中包含 `references`，Rolldown 会按照 TypeScript 的方式解析它们：包含该文件的被引用项目**优先于根项目**，并且第一个匹配的引用获胜。每个被引用项目都会使用其自己的 `compilerOptions`（例如 `allowJs`）进行匹配。如果没有任何被引用项目包含该文件，Rolldown 会回退到根项目自身的 `files`/`include`/`exclude`。一种 solution-style 的根配置（仅包含 `references`，并显式设置为空的 `files`/`include`，就像 Vite 脚手架生成的那样）本身不包含任何文件模式，因此一旦其引用都未匹配，它就**不拥有**该文件，随后会按照上面的描述继续在父目录中发现。

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
- `emitDecoratorMetadata`：输出装饰器元数据
- `strictNullChecks`（回退到 `strict`）：控制在启用 `emitDecoratorMetadata` 时，是否从可空联合类型的 `design:type` 装饰器元数据中省略 `null`/`undefined`。当两者都未设置时，默认启用，与 TypeScript 6.0+ 保持一致（此时 `strict` 默认开启）
- `verbatimModuleSyntax`：保留模块语法
- `useDefineForClassFields`：类字段语义
- 以及其他 TypeScript 专用选项

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
