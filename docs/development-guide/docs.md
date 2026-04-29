# 文档

Rolldown 使用 [VitePress](https://vitepress.dev) 进行文档编写。你可以在 `docs` 中找到该站点的源代码。查看 [Markdown 扩展指南](https://vitepress.dev/guide/markdown) 以了解 VitePress 的功能。

要为文档做出贡献，你可以在项目根目录运行 docs 开发服务器：

```sh
pnpm run docs
```

由于 `pnpm docs` 命令用于在 `npm` 中打开模块介绍，你可以使用上面的命令。

然后你就可以编辑 markdown 文件并立即看到更改。文档结构在 `docs/.vitepress/config.ts` 中配置（参见 [站点配置参考](https://vitepress.dev/reference/site-config)）。

如果你想查看构建后的站点，请在项目根目录运行：

```sh
pnpm docs:build
pnpm docs:preview
```

如果你没有修改文档构建设置，那么在贡献时这一步并不是必需的。
