# 监听模式 — 设计与原则

> **实现**——actor 架构、API 合约、状态机、
> 去抖动、事件生命周期、NAPI 桥接以及迁移状态：见
> [implementation.md](./implementation.md)。

## 概要

监听模式会监视源文件，并在检测到变更时自动重新构建。`rolldown_watcher` crate 是基础，采用简洁的基于 actor 的架构。本文档记录了指导该设计的原则以及尚未解决的问题；具体机制见
[implementation.md](./implementation.md)。

## 设计原则

- **JS API 与 Rollup 对齐** —— TypeScript 层面的接口（事件、选项、插件钩子、生命周期顺序）应当与 Rollup 的行为一致，除非出于技术原因无法做到。任何差异都会被明确记录。
- **Rust 代码遵循 Rust 习惯** —— Rust 核心应当具备原生感觉：由所有权驱动、基于 enum 的状态机、基于 trait 的可扩展性，除架构所需之外不应有不必要的 `Arc`/`Mutex`。
- **全栈命名保持一致** —— Rollup 定义了规范的事件/概念名称（例如 `BUNDLE_START`/`BUNDLE_END`）。Rust 侧应使用相同术语，以便在 NAPI 边界形成清晰的 1:1 映射，避免在心智上进行翻译。

## 未解决的问题

- **构建不应阻塞协调器循环** —— 当前协调器会在构建上直接 `await`，从而阻塞整个事件循环。开发引擎（`BundleCoordinator`）通过对构建使用 `tokio::spawn` 解决了这一点——协调器循环在构建运行期间仍能对消息保持响应。在 `Close` 时，开发引擎仍会等待正在进行的构建优雅完成，但关键在于它会立即接收该消息，而不是被阻塞。监听器应遵循相同模式——启动构建、接收完成消息回传，并在构建期间保持循环可自由处理事件。

- **并行任务构建** —— `watch([configA, configB])` 会按顺序构建任务（与 Rollup 一致），而分别调用 `watch(configA); watch(configB)` 则会并行运行它们（不同的协调器）。这意味着顺序执行并不是一个有意义的保证——用户只需将调用拆开，就能轻易切换到并行模式。我们是否应该也在单个协调器内并行化任务？

- **共享 vs 每任务一个 FsWatcher** —— 目前每个 `WatchTask` 都拥有自己的 `DynFsWatcher`。如果两个任务监视同一个文件，那么该文件会在 OS 层面被监视两次。若在协调器层面使用单个共享的 `DynFsWatcher`，则可以去重监视并减少 OS 资源占用。添加文件很直接。取消监视（尚未实现）则需要跨任务协调——只有当没有任何任务需要某个文件时，才能取消对它的监视（引用计数，或者跨任务监视集做并集检查）。由于取消监视尚未实现，共享 watcher 在当前阶段会明显更简单。

- **watch 文件不会在构建之间持久化** —— `bundler.watch_files()` 返回的是最近一次构建的监视集，但这个集合不会在构建之间持久保存。对于完整重建来说这没问题（每次构建都会生成完整集合）。但对于增量构建，只有部分模块会被重新处理，因此增量构建的 `watch_files()` 会是不完整的——它不会包含那些未被重新访问的模块中的文件。监视集合需要在构建之间累积/持久化，而不是每次都替换。

## 相关内容

- [implementation.md](./implementation.md) — 监听模式实现总览
- [rust-bundler](../rust-bundler/implementation.md) — Core Bundler 结构与 `Bundle.close()` 设计
- [rust-classic-bundler](../rust-classic-bundler/implementation.md) — Rollup API 兼容封装
- [module-id](../module-id/implementation.md) — Module ID、路径身份与规范化
- [#6482](https://github.com/rolldown/rolldown/issues/6482) — 监听模式问题汇总（跟踪所有已知 bug）
