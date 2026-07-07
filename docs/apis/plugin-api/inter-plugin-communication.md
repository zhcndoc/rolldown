# 插件间通信

在使用许多专用插件时，某个阶段可能会需要无关的插件在构建过程中交换信息。Rolldown 提供了几种机制来实现这一点。

## 自定义解析器选项

假设你有一个插件，需要根据另一个插件生成导入的方式，将某个导入解析为不同的 id。一种实现方式是重写该导入，使用特殊的代理 id，例如，在 CommonJS 文件中通过 `require("foo")` 转换而来的导入，可以变成一个带有特殊 id 的普通导入 `import "foo?require=true"`，这样解析器插件就能识别它。

不过，这里存在一个问题：这个代理 id 在传递给其他解析器时，可能会或可能不会造成非预期的副作用，因为它并不真正对应某个文件。此外，如果该 id 由插件 `A` 创建，而解析发生在插件 `B` 中，就会在这些插件之间建立依赖关系，使得 `A` 在没有 `B` 的情况下无法使用。

自定义解析器选项通过允许在使用 [`this.resolve`](/reference/Interface.PluginContext#resolve) 手动解析模块时，为插件传递额外选项，从而提供了一种解决方案。这种方式不会更改 id，因此如果目标插件不存在，也不会影响其他插件正确解析该模块的能力。

```js
function requestingPlugin() {
  return {
    name: 'requesting',
    async buildStart() {
      const resolution = await this.resolve('foo', undefined, {
        custom: { resolving: { specialResolution: true } },
      });
      console.log(resolution.id); // "special"
    },
  };
}

function resolvingPlugin() {
  return {
    name: 'resolving',
    resolveId(id, importer, { custom }) {
      if (custom.resolving?.specialResolution) {
        return 'special';
      }
      return null;
    },
  };
}
```

请注意约定：自定义选项应通过与解析插件名称对应的属性来添加。由解析插件自行决定它接受哪些选项。

## Custom Module Metadata

Plugins can add custom metadata to modules. This metadata can be set by the plugins themselves, or by other plugins via the [`resolveId`](/reference/Interface.Plugin#resolveid), [`load`](/reference/Interface.Plugin#load), and [`transform`](/reference/Interface.Plugin#transform) hooks, and can be accessed through the [`this.getModuleInfo`](/reference/Interface.PluginContext#getmoduleinfo), [`this.load`](/reference/Interface.PluginContext#load), and [`moduleParsed`](/reference/Interface.Plugin#moduleparsed) hooks. This metadata should always be `JSON.stringify`-able, and will be persisted in the cache, for example in watch mode.

```js
function annotatingPlugin() {
  return {
    name: 'annotating',
    transform(code, id) {
      if (thisModuleIsSpecial(code, id)) {
        return { meta: { annotating: { special: true } } };
      }
    },
  };
}

function readingPlugin() {
  let parentApi;
  return {
    name: 'reading',
    buildEnd() {
      const specialModules = Array.from(this.getModuleIds()).filter(
        (id) => this.getModuleInfo(id).meta.annotating?.special,
      );
      // Use this list to perform some operations
    },
  };
}
```

Please note the convention: plugins that add or modify data should use a property corresponding to the plugin name, in this case `annotating`. On the other hand, any plugin can read all metadata from other plugins via `this.getModuleInfo`.

If multiple plugins add metadata, or if metadata is added in different hooks, then these `meta` objects are shallow merged. This means that if plugin `first` adds `{meta: {first: {resolved: "first"}}}` in the `resolveId` hook, and adds `{meta: {first: {loaded: "first"}}}` in the `load` hook, while plugin `second` adds `{meta: {second: {transformed: "second"}}}` in the `transform` hook, then the final `meta` object will be `{first: {loaded: "first"}, second: {transformed: "second"}}`. Here the result from the `resolveId` hook is overwritten by the result from the `load` hook because that plugin stores them both under its top-level property `first`. On the other hand, the `transform` data from the other plugin is placed alongside it.

A module's `meta` object is created immediately when Rolldown starts loading the module, and is updated in each lifecycle hook for that module. If you keep a reference to this object, you can also update it manually. To access the meta object of a module that has not yet been loaded, you can trigger its creation and loading via [`this.load`](/reference/Interface.PluginContext#load):

```js
function plugin() {
  return {
    name: 'test',
    buildStart() {
      // Trigger loading of a module. We could also pass an initial
      // "meta" object here, but if the module has already been
      // loaded through other means, it will be ignored
      this.load({ id: 'my-id' });
      // Now the module information is available, and we don't need to wait for
      // this.load
      const meta = this.getModuleInfo('my-id').meta;
      // Now we can also modify meta manually
      meta.test = { some: 'data' };
    },
  };
}
```

## 直接插件通信

对于其他任何类型的插件间通信，我们建议采用下面这种模式。请注意，`api` 永远不会与未来可能出现的任何插件钩子冲突。

```js
function parentPlugin() {
  return {
    name: 'parent',
    api: {
      //...暴露给其他插件的方法和属性
      doSomething(...args) {
        // 做一些有趣的事情
      },
    },
    // ...插件钩子
  };
}

function dependentPlugin() {
  let parentApi;
  return {
    name: 'dependent',
    buildStart({ plugins }) {
      const parentName = 'parent';
      const parentPlugin = plugins.find((plugin) => plugin.name === parentName);
      if (!parentPlugin) {
        // 如果它是可选的，也可以静默处理
        throw new Error(`This plugin depends on the "${parentName}" plugin.`);
      }
      // 现在你可以在后续钩子中访问这些 API 方法
      parentApi = parentPlugin.api;
    },
    transform(code, id) {
      if (thereIsAReasonToDoSomething(id)) {
        parentApi.doSomething(id);
      }
    },
  };
}
```

## 描述性元数据

插件可以为模块以及自身附加描述性元数据。这些元数据仅用于信息展示，旨在由检查构建结果的工具呈现，例如 [Vite devtools](https://github.com/vitejs/devtools)。

### 模块描述

工具通常会通过模块的 id 来显示模块，而这个 id 往往并不直观。例如，`\\0vite/modulepreload-polyfill.js` 无法提示该模块的用途。这对虚拟模块很有用。插件可以通过 [`resolveId`](/reference/Interface.Plugin#resolveid)、[`load`](/reference/Interface.Plugin#load) 或 [`transform`](/reference/Interface.Plugin#transform) 钩子，为模块附加一个人类可读的 [`description`](/reference/Interface.ModuleOptions#description)。

```js
function modulePreloadPolyfillPlugin() {
  return {
    name: 'vite:modulepreload-polyfill',
    load: {
      filter: { id: /^\0vite\/modulepreload-polyfill\.js$/ },
      handler(id) {
        return {
          code: '/* ... */',
          description: '对带有 `rel="modulepreload"` 的 `link` 标签的 polyfill',
        };
      },
    },
  };
}
```

### 插件元数据

一个单独的包通常会提供多个插件，而插件的 `name` 并不总能说明它来自哪个包。插件可以通过插件对象的 [`meta`](/reference/Interface.Plugin#meta) 属性声明其来源包名和版本，从而让工具能够按包对插件进行归属和分组。也可以通过 `description` 属性附加一段简短说明，描述该插件的作用。

```js
function vuePlugin() {
  return {
    name: 'vite:vue',
    meta: {
      packageName: '@vitejs/plugin-vue',
      version: '5.0.0',
      description: '处理 Vue 单文件组件',
    },
    // ...插件钩子
  };
}
```

完整形状请参见 [`PluginMeta`](/reference/Interface.PluginMeta) 类型。
