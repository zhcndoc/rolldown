# 贡献指南

无论贡献大小，我们都欢迎！这里我们总结了一些关于如何参与 Rolldown 项目的通用指南。

## 开发开放

所有开发都直接在 [GitHub](https://github.com/rolldown/rolldown) 上进行。核心团队成员和外部贡献者（通过 fork）都会提交 pull request，并经过相同的审核流程。

除了 GitHub 之外，我们还使用一个 [Discord 服务器](https://chat.rolldown.rs) 进行实时讨论。

## 报告 bug

请仅在你已经搜索过该问题且未找到结果后，再向 GitHub 报告 bug。请务必尽可能详细地描述，并包含所有适用的标签。

修复 bug 的最佳方式是提供一个精简的测试用例。请提供一个包含可运行示例的公共仓库，或一段可用的代码片段。未来，我们还会提供一个可在浏览器中运行的 REPL，以便更容易复现问题。

## 请求新功能

在请求新功能之前，请先查看 [未关闭的问题](https://github.com/rolldown/rolldown/issues)，因为你要请求的内容可能已经存在。如果不存在，请提交一个标题前缀为 `[request]` 的 issue。请务必尽可能详细地描述，并包含所有适用的标签。

## 提交 pull request

我们接受所有 bug、修复、改进和新功能的 pull request。在提交 pull request 之前，请确保你的构建在本地使用上述开发流程能够通过。

关于项目开发环境的搭建，请参见 [项目设置](../development-guide/setup-the-project.md)。

:::info

在提交 pull request 之前，请先阅读 [礼仪](https://developer.mozilla.org/en-US/docs/MDN/Community/Open_source_etiquette) 章节。

:::

### 分支组织

请直接向 `main` 分支提交所有 pull request。我们只为即将发布的版本 / 破坏性变更使用单独的分支，否则所有内容都指向 main。

进入 main 的代码必须与最新稳定版兼容。它可以包含额外功能，但不能有破坏性变更。我们应该能够随时从 main 的最新提交发布一个新的小版本。
