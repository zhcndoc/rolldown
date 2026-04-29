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

## 自定义模块元数据

插件可以为模块添加自定义元数据，这些元数据既可以由它们自己设置，也可以通过 [`resolveId`](/reference/Interface.Plugin#resolveid)、[`load`](/reference/Interface.Plugin#load) 和 [`transform`](/reference/Interface.Plugin#transform) 钩子由其他插件设置，并可通过 [`this.getModuleInfo`](/reference/Interface.PluginContext#getmoduleinfo)、[`this.load`](/reference/Interface.PluginContext#load) 以及 [`moduleParsed`](/reference/Interface.Plugin#moduleparsed) 钩子访问。这些元数据始终应当可以 `JSON.stringify`，并且会被持久化到缓存中，例如在监听模式下。

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
      // 使用这个列表执行某些操作
    },
  };
}
```

请注意约定：添加或修改数据的插件应当使用与插件名称对应的属性，在本例中是 `annotating`。另一方面，任何插件都可以通过 `this.getModuleInfo` 读取来自其他插件的所有元数据。

如果有多个插件添加元数据，或者元数据是在不同钩子中添加的，那么这些 `meta` 对象会进行浅合并。这意味着，如果插件 `first` 在 `resolveId` 钩子中添加 `{meta: {first: {resolved: "first"}}}`，并在 `load` 钩子中添加 `{meta: {first: {loaded: "first"}}}`，而插件 `second` 在 `transform` 钩子中添加 `{meta: {second: {transformed: "second"}}}`，那么最终得到的 `meta` 对象将是 `{first: {loaded: "first"}, second: {transformed: "second"}}`。这里 `resolveId` 钩子的结果会被 `load` 钩子的结果覆盖，因为该插件将它们都存储在其顶层属性 `first` 下。另一方面，另一个插件的 `transform` 数据则会被放在旁边。

一个模块的 `meta` 对象会在 Rolldown 开始加载模块时立即创建，并在该模块的每个生命周期钩子中更新。如果你保存了对此对象的引用，也可以手动更新它。要访问尚未加载的模块的 meta 对象，你可以通过 [`this.load`](/reference/Interface.PluginContext#load) 触发其创建并加载该模块：

```js
function plugin() {
  return {
    name: 'test',
    buildStart() {
      // 触发一个模块的加载。我们也可以在这里传入一个初始
      // "meta" 对象，但如果该模块已经通过其他方式
      // 加载过，它将被忽略
      this.load({ id: 'my-id' });
      // 现在模块信息已经可用，我们不需要等待
      // this.load
      const meta = this.getModuleInfo('my-id').meta;
      // 现在我们也可以手动修改 meta
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
