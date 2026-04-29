# 命令行界面

Rolldown 可以从命令行使用。你可以提供一个可选的 Rolldown 配置文件，以简化命令行用法并启用高级 Rolldown 功能。

## 配置文件

Rolldown 配置文件是可选的，但它们功能强大且方便，因此**推荐**使用。
配置文件是一个 ES 模块，它导出一个包含所需选项的默认对象。
通常，它被命名为 `rolldown.config.js`，并位于项目的根目录中。
你也可以在 CJS 文件中使用 CJS 语法，此时使用 `module.exports` 而不是 `export default`。
Rolldown 也原生支持 TypeScript 配置文件。

请参阅 [参考](/reference/) 以获取可包含在配置文件中的完整选项列表。

```js [rolldown.config.js]
export default {
  input: 'src/main.js',
  output: {
    file: 'bundle.js',
    format: 'cjs',
  },
};
```

要在 Rolldown 中使用配置文件，请传入 `-c`（或 `--config`）标志：

```shell
rolldown -c                 # 使用 rolldown.config.{js,mjs,cjs,ts,mts,cts}
rolldown --config           # 同上
rolldown -c my.config.js    # 使用自定义配置文件
```

如果你不传入文件名，Rolldown 将尝试在工作目录中加载 `rolldown.config.{js,mjs,cjs,ts,mts,cts}`。
如果未找到配置文件，Rolldown 将显示错误。

你也可以从配置文件中导出一个函数。该函数会使用命令行参数调用，因此你可以动态调整配置：

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';

export default defineConfig((commandLineArgs) => {
  if (commandLineArgs.watch) {
    // 仅用于 watch 的配置
  }
  return {
    input: 'src/main.js',
  };
});
```

### 配置智能提示

由于 Rolldown 附带 TypeScript 类型定义，你可以利用 IDE 的 JSDoc 类型提示获得智能提示：

```js [rolldown.config.js]
/** @type {import('rolldown').RolldownOptions} */
export default {
  // ...
};
```

或者，你也可以使用 `defineConfig` 辅助函数，它无需 JSDoc 注解即可提供智能提示：

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';

export default defineConfig({
  // ...
});
```

### 配置数组

要从不同输入构建不同的 bundle，你可以提供一个配置对象数组：

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';

export default defineConfig([
  {
    input: 'src/main.js',
    output: { format: 'esm', entryFileNames: 'bundle.esm.js' },
  },
  {
    input: 'src/main.js',
    output: { format: 'cjs', entryFileNames: 'bundle.cjs.js' },
  },
]);
```

::: tip 相同输入的不同输出

你也可以为 `output` 选项提供一个数组，以便从相同输入生成多个输出：

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';

export default defineConfig({
  input: 'src/main.js',
  output: [
    { format: 'esm', entryFileNames: 'bundle.esm.js' },
    { format: 'cjs', entryFileNames: 'bundle.cjs.js' },
  ],
});
```

:::

## 命令行标志

标志可以通过 `--foo`、`--foo <value>` 或 `--foo=<value>` 传入。像 `--minify` 这样的布尔标志不需要值，而像 `--transform.define` 这样的键值选项使用逗号分隔语法：`--transform.define key:value,key2:value2`。许多标志都有简写别名（例如，`-m` 对应 `--minify`，`-f` 对应 `--format`）。

::: info 集成到其他工具中

请注意，在 Rolldown 看到参数之前，你的 shell 会先对它们进行解释——引号和通配符的行为可能会出乎意料。对于高级构建流程或集成到其他工具中，建议改用 [JavaScript API](/apis/bundler-api)。从配置文件切换到 API 时的关键区别：

- 配置必须是对象（不能是 Promise 或函数）
- 对每一组 `inputOptions` 分别运行 [`rolldown.rolldown`](/reference/Function.rolldown)（不支持配置数组）
- 使用 [`bundle.generate(outputOptions)`](/reference/Interface.RolldownBuild#generate) 或 [`bundle.write(outputOptions)`](/reference/Interface.RolldownBuild#write) 来替代 `output` 选项

:::

许多选项都有对应的命令行标志。
有关这些标志的详细信息，请参阅 [参考](/reference/)。
在这些情况下，如果你使用了配置文件，这里传入的任何参数都会覆盖配置文件中的设置。
下面是所有受支持标志的列表：

<script setup>
import { data } from '../data-loading/cli-help.data'
</script>

```sh-vue
{{ data.help }}
```

下面列出的标志仅可通过命令行界面使用。

### `-c, --config <filename>`

使用指定的配置文件。如果使用了该参数但未指定文件名，Rolldown 将查找默认配置文件。有关更多详细信息，请参阅 [配置文件](#configuration-files)。

### `-h` / `--help`

显示帮助信息。

### `-v` / `--version`

显示已安装的版本号。

### `-w` / `--watch`

当源文件在磁盘上发生变化时重新构建 bundle。

::: info `ROLLDOWN_WATCH` 环境变量
在 watch 模式下，Rolldown 的命令行界面会将 `ROLLDOWN_WATCH` 和 `ROLLUP_WATCH` 环境变量设置为 `true`，并且可以被其他进程检查。插件应改为检查 [`this.meta.watchMode`](/reference/Interface.PluginContextMeta#watchmode)，它不依赖于命令行界面。
:::

### `--environment <values>`

通过 `process.env` 向配置文件传递额外设置。
值是以逗号分隔的键值对，其中值为 `true` 时可以省略。

例如：

```shell
rolldown -c --environment INCLUDE_DEPS,BUILD:production
```

这会设置 `process.env.INCLUDE_DEPS = 'true'` 和 `process.env.BUILD = 'production'`。

你可以多次使用此选项。
在这种情况下，后续设置的变量将覆盖先前的定义。

::: tip 覆盖这些值
如果你有 `package.json` 脚本：

```json
{
  "scripts": {
    "build": "rolldown -c --environment BUILD:production"
  }
}
```

你可以通过 `npm run build -- --environment BUILD:development` 来调用此脚本，以设置 `process.env.BUILD="development"`。

:::
