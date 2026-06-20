# Dev 引擎 — 设计与原则（`rolldown_dev`，完整打包模式）

> **实现地图** — 组件分层、`CoordinatorMsg`
> 协议、`CoordinatorState` 状态机、`TaskInput` 工作类型，以及
> 各阶段的数据流管线：参见
> [implementation.md](./implementation.md)。下面的
> `§N` 章节引用都指向该文件。

## 概要

dev 引擎（`rolldown_dev` crate）是 rolldown 在完整打包模式下的开发模式构建
编排层。它位于文件监听器 / 开发服务器与核心 `Bundler`
之间，决定 _执行什么_ 构建——HMR
补丁、增量重建，还是完整构建——以及 _何时_ 执行。它被组织为一个 `DevEngine`（公开的异步 API 接口），驱动一个单消息循环的 `BundleCoordinator`（一个状态机加工作队列），每次只生成一个 `BundlingTask`。

本文档记录的是 **为什么** —— 即决定引擎何时重建以及其错误如何向绑定消费者传递的原则。实现这些原则的机制，请参见
[implementation.md](./implementation.md)。

## 设计原则

有四条原则决定 dev 引擎何时重建以及其错误如何向绑定消费者传递。它们定义了 rolldown_dev 与其消费者（通常是 Vite）之间的契约，并约束 §7、§13 和 §16 中的实现。

### 1. 保守重建

只有当 bundle **过期**时才会发生重建——也就是自上次构建尝试以来输入发生了变化。页面访问和浏览器重连本身都不会触发重建。特别是：如果上一次构建失败了，访问请求也不会重试——在没有新输入的情况下，同样的错误会再次出现。

实现位置：`BundleCoordinator::ensure_latest_bundle_output` 对 `Failed` / `FullBuildFailed` 返回 `None`（§13b，§13e）。

### 2. 每次构建都要发出错误

rolldown_dev 会通过 `on_output` / `on_hmr_updates` 回调（§16b）在每次构建时向绑定消费者暴露构建错误。它不会静默重试并越过错误，不会静默吞掉错误，也不会跨请求缓存错误——rolldown_dev 在 HTTP 请求之间是无状态的。绑定消费者（Vite）负责保留最近一次错误，并在每次客户端重连时重放它，这样即使浏览器刷新后错误覆盖层也会出现。

Vite 侧的实现（在 `fullBundleEnvironment.ts` 中）：一个单独的 `lastBuildError: Error | null` 字段会缓存来自**任一**通道的最近错误——它会在 `onOutput`（完整构建错误）和 `onHmrUpdates`（HMR 错误）中都被设置，并在来自**任一**通道的成功构建后清回 `null`（成功的 `onOutput` _或_ 成功的 `onHmrUpdates` 都会清空，因为一个干净计算出来的 HMR 补丁会覆盖先前缓存的错误）。它会在每个新连接客户端（包括刷新后的重连）的 **`vite:client:connect`** 事件上重放，因此浏览器刷新后错误覆盖层会重新出现。两个通道只是在其 _实时_ 传递方式上不同：`onOutput` 错误还会记录到终端（`logger.error`），这样即使没有浏览器也能看到构建失败，并且会通过 `hot.send` 广播给所有客户端；`onHmrUpdates` 错误则会单独发送给每个已连接客户端，不会记录到终端。

### 3. 文件变更是唯一的恢复触发器

构建失败后，引擎会等待文件变更后再重建。Vite 配置编辑和用户源码编辑都是有效触发器。在 rolldown_dev 内部，其他任何东西都不算恢复——既不是页面刷新，也不是时间流逝，更不是手动关闭 UI：`ensure_latest_bundle_output` 在所有失败状态下都不执行任何操作（§13b），因此访问不会自己触发重建。

**一个消费者侧的例外——HMR 阶段失败后的页面刷新。** 当最近一次失败起源于 HMR 生成（`last_error_stage == Hmr`）时，消费者允许把页面刷新视为恢复触发器：在访问时它调用 `triggerFullBuild`（§13e）强制进行一次完整重建，从而绕过可能有问题的 HMR 路径，而不是重放缓存的错误。这一行为仅限于消费者侧——rolldown_dev 本身不改变行为；升级策略是消费者根据其从 `BundleState`（§12）读取到的 `last_error_stage` 所做的决定。`Rebuild` 阶段或完整构建失败不享有这种例外——只有文件变更才能恢复它们。（在仓库内的参考消费者中已接入：`packages/test-dev-server/src/environments/full-bundle-dev-environment.ts` 里的 `triggerBundleRegenerationIfStale`。）

实现位置：`handle_file_changes`（§7）是失败后重建任务的唯一产生者。`triggerFullBuild`（§13e）是针对监听器无法观察到的情况的显式逃生通道（例如缺失导入解析；见未解决问题）。

推论：失败构建之后的文件变更必须安排能够消除该失败的工作。实际中这意味着要跟踪失败起源于哪里（HMR 计算还是增量重建），这样下一次任务才能覆盖出问题的阶段（§7）。

### 4. 构建错误是可恢复的；panic 是 bug

通过 `on_output` / `on_hmr_updates` 传递给消费者的每一个错误都被视为**用户错误**——由源码或插件行为引起，可通过编辑源码恢复。这个模型假定 Rolldown 和 Vite 本身没有 bug。唯一不能通过文件变更循环恢复的状态是 panic，它表示 rolldown_dev 自身违反了不变量（§16g）。

## 未解决问题

- **缺失导入失败后的自动恢复。** 当构建因为无法解析的导入而失败时，缺失的文件从未被解析，也不在 `watch_paths` 中。创建它不会触发重建——用户必须手动触碰一个被监听的文件，或者使用 `triggerFullBuild`。一种修复方式：在解析期间，当文件未找到时，记录其路径并把其父目录加入监听器。这样，目录级别的创建事件如果匹配到先前缺失的路径，就会自动触发重建。现有的监听器测试已经承认了这个缺口（`watch.test.ts`："the missing file's directory is not auto-watched, so we need to touch a watched file"）。

## 相关内容

- [implementation.md](./implementation.md) — dev 引擎的实现地图（组件、消息协议、状态机、各阶段数据流）
- [bundler-data-lifecycle](../bundler-data-lifecycle/implementation.md) — `BundleMode`、
  `Bundle` / `BundleFactory`，以及 dev 引擎增量构建所经历的 `ScanStageCache` 生命周期
- [rust-bundler](../rust-bundler/implementation.md) — dev 引擎驱动的核心 `Bundler` 结构体和构建
  生命周期
- [watch-mode](../watch-mode/implementation.md) — `rolldown_watcher`，基于 actor 的
  监听架构；`rolldown_dev` 复用了相同的 actor 模式
- [lazy-compilation](../lazy-compilation/implementation.md) — 延迟入口编译，
  可通过 `DevEngine::compile_lazy_entry` 和 `ModuleChanged`
  消息访问
- [dev-server-test-harness](../dev-server-test-harness/implementation.md) — 开发服务器的浏览器
  测试框架
