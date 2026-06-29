# 贡献指南

无论贡献大小，我们都欢迎！这里我们总结了一些关于如何参与 Rolldown 项目的通用指南。

## 开发开放

所有开发都直接在 [GitHub](https://github.com/rolldown/rolldown) 上进行。核心团队成员和外部贡献者（通过 fork）都会提交 pull request，并经过相同的审核流程。

除了 GitHub 之外，我们还使用一个 [Discord 服务器](https://chat.rolldown.rs) 进行实时讨论。

## AI 使用政策

在使用 AI 工具（包括 ChatGPT、Claude、Copilot 等 LLM）为 Rolldown 贡献时：

- **请披露 AI 的使用情况**，以减少维护者的疲劳
- **如果更改需要，请在打开 pull request 之前先进行讨论**——遵循下面 [提交 pull request](#submitting-a-pull-request) 中的相同规则；如果你不确定适用哪条路径，请先创建一个 issue
- **你要对你提交的所有 AI 生成问题或 PR 负责**
- **低质量或未经审查的 AI 内容会被立即关闭**
- **重复提交低质量（“slop”）PR 的贡献者将被直接封禁，不会提前警告。** 如果你承诺按照此政策为 Rolldown 贡献，封禁可能会被解除。你可以通过我们的 [Discord](https://chat.rolldown.rs/) 申请解除封禁。

我们鼓励使用 AI 工具协助开发，但所有贡献在提交前都必须经过贡献者的充分审查和测试。AI 生成的代码应被理解、验证并调整，以满足 Rolldown 的标准。

## 报告 bug

请仅在 GitHub 上打开 bug 报告，并且要先搜索现有 issues，确认没有匹配项。请尽可能详细，并包含所有适用的标签。

修复 bug 的最佳方式是提供一个最小复现——一个带有可运行示例的公开仓库、一个可用的代码片段，或者一个指向我们的 [REPL](https://repl.rolldown.rs/) 的链接，以便快速在浏览器中复现。

## 请求新功能

在请求新功能之前，请先搜索 [open issues](https://github.com/rolldown/rolldown/issues) —— 也许别人已经提过了。如果没有，请创建一个 issue，并在标题前加上 `[request]`。请尽可能描述清楚，并添加所有适用的标签。

## 提交 pull request

我们欢迎针对 bug 修复、改进和新功能的 pull request。在你打开之前，请先确认下面两条路径中哪一条适用于你的改动： [直接提交](#send-a-pull-request-directly)，或者 [先讨论方案](#discuss-the-approach-first)。无论哪种方式，在提交之前都请确保你的构建在本地通过。

关于项目开发环境的搭建，请参见 [项目设置](../development-guide/setup-the-project.md)。

:::info

在提交 pull request 之前，请先阅读 [礼仪](https://developer.mozilla.org/en-US/docs/MDN/Community/Open_source_etiquette) 章节。

:::

### 直接提交 pull request

对于那些其正确性不言自明的改动，无需事先讨论：

- 明确的 bug 修复，且预期行为没有歧义
- 文档、拼写和注释修复
- 针对现有行为的测试
- 没有用户可见变更的小型、独立的内部清理

如果有相关 issue，请在你的 pull request 中链接它。

### 先讨论方案

对于下面这些改动，请先创建或回复一个 issue，并在开始编码或打开 pull request 之前与团队达成一致：

- 新功能和新的公开 API
- 对现有公开 API 或默认行为的更改
- 修复一个尚未在讨论串中达成一致方案的问题

对于这些改动，最难的通常不是写代码，而是就正确方向达成一致。先把它讨论清楚，意味着你的工作会进入一个我们可以合并的方向，而不是因为方向仍在打磨而停滞不前。

如果你在没有达成一致的情况下为这类变更打开 pull request，我们可能会关闭它。**关闭它并不意味着拒绝你的工作，也不意味着否定你作为贡献者。** 这只意味着这个变更需要先经过讨论流程。如果你想推动它继续前进，可以在关联的 issue 上或在我们的 [Discord](https://chat.rolldown.rs) 中分享你的想法——一旦方向达成一致，我们非常欢迎这个 pull request。

### 草稿 pull request

如果你的 pull request 仍在进行中，请将其以 [draft](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/changing-the-stage-of-a-pull-request) 形式打开，并且只有在你真心希望团队审查时，才将其标记为 **Ready for review**。将 PR 转为 “Ready for review” 会通知审阅者和代码所有者，因此请等到你的改动完成且本地构建通过后再进行。这有助于让维护者的收件箱专注于真正需要关注的 PR。

### 分支组织

请将所有 pull request 直接提交到 `main` 分支。我们只会为即将发布的版本或破坏性变更使用单独分支；否则，所有内容都应指向 `main`。

进入 `main` 的代码必须与最新稳定版兼容。它可以包含额外功能，但不能有破坏性变更。我们应当能够随时从 `main` 的最新提交发布一个新的次要版本。
