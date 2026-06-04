# `rolldown_dev` 中的开发引擎（完整打包模式）

## 概要

开发引擎（`rolldown_dev` crate）是在完整打包模式下，rolldown 的开发模式构建编排层。它位于文件监听器 / 开发服务器与核心 `Bundler` 之间，负责决定要运行 _哪一种_ 构建——HMR 补丁、增量重建，还是完整构建——以及 _何时_ 运行。它的结构是：由一个 `DevEngine`（公开的异步 API 表层）驱动一个单消息循环的 `BundleCoordinator`（一个状态机加工作队列），后者一次只会启动一个 `BundlingTask`。本文是这套机制的结构图：组件分层、`CoordinatorMsg` 协议、`CoordinatorState` 状态机、`TaskInput` 工作类型，以及用于文件编辑、HMR 生成和浏览器页面加载时懒加载完整打包刷新的数据流管线。本文描述的是当前实现的 **事实**，而不是任何特定变更的叙事。

---

## 1. 组件与分层

开发引擎由四个协作部分构成，全部位于 `crates/rolldown_dev/src/`：

```
                    ┌─────────────────────────────────────────┐
                    │              DevEngine                   │
                    │  (dev_engine.rs)                         │
                    │  - 公开的异步 API 表层                   │
                    │  - 持有 Arc<Mutex<Bundler>>              │
                    │  - 持有协调器 mpsc Sender                │
                    │  - 启动协调器任务                        │
                    └───────────────┬─────────────────────────┘
                                    │  CoordinatorMsg (mpsc)
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │           BundleCoordinator              │
                    │  (bundle_coordinator.rs)                 │
                    │  - 单线程消息循环                        │
                    │  - 持有 CoordinatorState                 │
                    │  - 持有 queued_tasks: VecDeque<TaskInput>│
                    │  - 持有文件系统监听器                    │
                    │  - 决定运行什么构建以及何时运行          │
                    └───────────────┬─────────────────────────┘
                                    │  启动
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │             BundlingTask                 │
                    │  (bundling_task.rs)                      │
                    │  - 一个构建工作单元                      │
                    │  - 锁定 Bundler，运行 HMR/重建           │
                    │  - 通过 CoordinatorMsg 回报              │
                    └───────────────┬─────────────────────────┘
                                    │  调用
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │               Bundler                    │
                    │  (crates/rolldown/src/bundler/)          │
                    │  - compute_hmr_update_for_file_changes   │
                    │  - incremental_generate / incremental_   │
                    │    write                                 │
                    └─────────────────────────────────────────┘
```

`DevContext`（`dev_context.rs`）是共享的、近似不可变的粘合层，以 `SharedDevContext = Arc<DevContext>` 的形式在各处传递：

```rust
pub struct DevContext {
  pub options: NormalizedDevOptions,
  pub coordinator_tx: CoordinatorSender,   // 克隆后用于发送消息
  pub clients: SharedClients,              // 已连接的 HMR 客户端
}
```

### 线程模型

- `BundleCoordinator` 运行在 **一个** 专用的 tokio 任务中（`DevEngine::run` 会执行 `tokio::spawn(coordinator.run())`，`dev_engine.rs:115`）。它的 `run()` 是一个单一的 `while let Some(msg) = self.rx.recv().await` 循环，因此所有协调器状态的变更都是串行的——`CoordinatorState` 上没有锁，这个消息循环 _就是_ 锁。
- 每个 `BundlingTask` 都运行在它 **自己的** 已启动任务中。协调器会持有当前正在运行任务的 `Shared` future 句柄（`current_bundling_future`）。
- `Bundler` 通过 `Arc<Mutex<Bundler>>` 共享。`BundlingTask` 会在其 HMR / 重建工作期间持有它的锁。
- 通信通过 **无界** mpsc 通道完成（`unbounded_channel::<CoordinatorMsg>()`，`dev_engine.rs:62`）。请求 / 响应消息会携带一个 `tokio::sync::oneshot` 回复通道。

---

## 2. 消息协议 —— `CoordinatorMsg`

定义于 `types/coordinator_msg.rs`。与协调器的每一次交互都是以下消息之一：

```rust
pub enum CoordinatorMsg {
  WatchEvent(FsEventResult),                 // 原始文件监听器事件批次
  BundleCompleted {                          // 一个 `BundlingTask` 已完成
    has_encountered_error: bool,
    has_generated_bundle_output: bool,
  },
  ScheduleBuildIfStale { reply: … },         // 请求协调器清空其队列
  GetState { reply: … },                     // 协调器状态快照
  EnsureLatestBundleOutput { reply: … },     // “我需要一个最新的完整打包产物”
  TriggerFullBuild,                           // 无条件完整构建（发出即不管）
  GetWatchedFiles { reply: … },              // 监听路径列表
  ModuleChanged { module_id: String },       // 以编程方式触发的模块变更
  Close,                                     // 关闭协调器
}
```

路由发生在 `BundleCoordinator::run` 中（`bundle_coordinator.rs:98-150`）：

| 消息                       | 处理器                                      |
| -------------------------- | -------------------------------------------- |
| `WatchEvent`               | `handle_watch_event` → `handle_file_changes` |
| `BundleCompleted`          | `handle_bundle_completed`                    |
| `ScheduleBuildIfStale`     | `schedule_build_if_stale`，回复结果          |
| `GetState`                 | `create_state_snapshot`，回复                |
| `EnsureLatestBundleOutput` | `ensure_latest_bundle_output`，回复          |
| `TriggerFullBuild`         | `trigger_full_build`（无回复）               |
| `GetWatchedFiles`          | 回复 `watched_files` 集合                    |
| `ModuleChanged`            | 将一个 `Rebuild` 入队，并调度                |
| `Close`                    | 等待运行中的任务，然后 `break` 跳出循环      |

消息的发送方：

- **文件监听器** 发送 `WatchEvent`。监听器事件处理器由 `BundleCoordinator::create_watcher_event_handler` 创建，并连接到同一个 `coordinator_tx`。
- 已完成的 **`BundlingTask`** 会在其 `run()` 中发送 `BundleCompleted`（`bundling_task.rs:75-80`）。
- **`DevEngine`** 会代表其公开 API 的调用者（开发服务器、HTTP 中间件、懒编译端点等）发送 `ScheduleBuildIfStale`、`GetState`、`EnsureLatestBundleOutput`、`GetWatchedFiles`、`ModuleChanged`、`Close`。

---

## 3. `CoordinatorState` —— 调度器状态机

定义于 `types/coordinator_state.rs`：

```rust
pub enum CoordinatorState {
  Initialized,
  Idle,
  FullBuildInProgress,
  FullBuildFailed,
  InProgress,
  Failed,
}
```

它是 `BundleCoordinator` 上的一个 `Copy` 枚举字段，只能通过 `set_initial_build_state`（`bundle_coordinator.rs:445`）进行修改。它以 `Idle` 为分界，分成两半：

- **初次完整构建阶段** —— `Initialized`、`FullBuildInProgress`、`FullBuildFailed`。关注第一次构建。
- **稳态阶段** —— `Idle`、`InProgress`、`Failed`。关注首次构建成功之后的每一次构建。

### 状态含义

| 状态                   | 含义                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| `Initialized`          | 已构造，但 `run()` 尚未进入。瞬态状态。                          |
| `FullBuildInProgress`  | 初始的 `TaskInput::FullBuild` 正在运行。                          |
| `FullBuildFailed`      | 初始完整构建出错。此时完全没有可用输出。                           |
| `Idle`                 | 没有构建在运行；最后一次构建（如果有）已成功。                    |
| `InProgress`           | 正在运行增量任务（`Hmr` / `HmrRebuild` / `Rebuild`）。           |
| `Failed`               | 上一次增量任务出错。                                             |

### 状态转移图

```
            ┌──────────────┐
            │ Initialized  │  (构造函数: BundleCoordinator::new)
            └──────┬───────┘
                   │ run() 入口：push TaskInput::FullBuild,
                   │ 设置 state=Idle，schedule_build_if_stale()
                   ▼
        ┌────────────────────┐
        │        Idle        │ ◄──────────────────────────────┐
        └─────────┬──────────┘                                │
                  │ schedule_build_if_stale 弹出一个任务：    │
                  │   FullBuild → FullBuildInProgress         │
                  │   否则      → InProgress                  │
        ┌─────────┴──────────┐                                │
        ▼                    ▼                                │
┌───────────────────┐  ┌───────────────────┐                  │
│FullBuildInProgress│  │    InProgress     │                  │
└─────────┬─────────┘  └─────────┬─────────┘                  │
          │ BundleCompleted      │ BundleCompleted            │
          │  err → FullBuildFailed│  err → Failed             │
          │  ok  → Idle ─────────┼──ok──→ Idle ───────────────┤
          ▼                      ▼  （然后总是调用            │
┌───────────────────┐  ┌───────────────────┐    schedule_build_if_│
│  FullBuildFailed  │  │      Failed       │    stale）           │
└─────────┬─────────┘  └─────────┬─────────┘                  │
          │ 下一次文件变更：     │ 下一次文件变更：           │
          │  入队 FullBuild，    │  入队 Hmr/HmrRebuild，     │
          │  调度 →              │  调度 →                    │
          │  FullBuildInProgress │  InProgress ───────────────┘
          ▼                      ▼
       （循环）               （循环）
```

### 每个转移发生的位置

| 转移                                                               | 位置                                           |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| `Initialized → Idle`                                               | `run()` 启动阶段，`bundle_coordinator.rs:84-87` |
| `Idle/Failed/FullBuildFailed → FullBuildInProgress` / `InProgress` | `schedule_build_if_stale`，`:352-356`          |
| `FullBuildInProgress → FullBuildFailed`                            | `handle_bundle_completed`，`:263`              |
| `FullBuildInProgress → Idle`                                       | `handle_bundle_completed`，`:268`              |
| `InProgress → Failed`                                              | `handle_bundle_completed`，`:288`              |
| `InProgress → Idle`                                                | `handle_bundle_completed`，`:293`              |

`set_initial_build_state` 是唯一的变更点——这是观察所有转移的一个便利位置。

## 4. 协调器运行循环与启动

`BundleCoordinator::run` (`bundle_coordinator.rs:80-151`)：

1. 断言它从 `Initialized` 状态开始；否则记录错误并返回。
2. 将 `TaskInput::FullBuild` 推入 `queued_tasks`，将状态设为 `Idle`，调用 `schedule_build_if_stale()` —— 这会触发初始构建（`Idle → FullBuildInProgress`）。
3. 进入 `while let Some(msg) = self.rx.recv().await` 循环，按 §2 中的方式分发每个 `CoordinatorMsg`。
4. 在 `Close` 时，等待任何正在运行的 `BundlingTask`（这样它就不会在尝试向已丢弃的 channel 发送 `BundleCompleted` 时 panic），然后跳出循环。

`BundleCoordinator::new` 初始化：`state = Initialized`、`queued_tasks = []`、`has_stale_bundle_output = true`、`current_bundling_future = None`。

---

## 5. `TaskInput` —— 队列中工作的单位

定义于 `types/task_input.rs`。协调器的工作队列为 `queued_tasks: VecDeque<TaskInput>`。

```rust
pub enum TaskInput {
  FullBuild,                              // 完整构建（初始或恢复）
  Rebuild     { changed_files: … },       // 增量重建，不生成 HMR 补丁
  Hmr         { changed_files: … },       // 仅 HMR 补丁，不重建
  HmrRebuild  { changed_files: … },       // HMR 补丁 AND 增量重建
}
```

### 谓词

```rust
requires_full_rebuild()      // 仅对 FullBuild 返回 true
requires_rebuild()           // 对 FullBuild | Rebuild | HmrRebuild 返回 true
require_generate_hmr_update()// 对 Hmr | HmrRebuild 返回 true
```

这些谓词决定打包任务的行为（见 §8）以及协调器的状态选择（见 §7）。

### 可合并性 —— `is_mergeable_with` / `merge_with`

当协调器弹出一个任务时，它会贪婪地将队列前端相邻且兼容的任务合并。规则如下：

| 第一个任务     | 可与之合并的任务        | 结果                                            |
| ------------- | ---------------------- | ----------------------------------------------- |
| `FullBuild`   | 任何任务               | 保持为 `FullBuild`（吸收一切）                  |
| `Rebuild`     | 仅 `Rebuild`           | `Rebuild`，并合并 `changed_files`               |
| `Hmr`         | `Hmr` 或 `HmrRebuild`  | 合并文件；`Hmr+HmrRebuild` → `HmrRebuild`      |
| `HmrRebuild`  | `Hmr` 或 `HmrRebuild`  | `HmrRebuild`，并合并 `changed_files`           |

`Rebuild` 与 `Hmr`/`HmrRebuild` **不能**相互合并——增量重建任务会带入不适合用于生成 HMR 的文件，因此必须保持分离。`FullBuild` 吸收一切意味着，如果存在一个 `FullBuild`，任何一波任务类型都会收敛为单个 `FullBuild`。

---

## 6. 从 fs 事件到队列任务 —— `handle_watch_event`

`handle_watch_event` (`bundle_coordinator.rs:154-194`) 将原始的 `notify` 事件批次转换为 `FxIndexMap<PathBuf, WatcherChangeKind>`：

| `notify` `EventKind`                          | `WatcherChangeKind` |
| --------------------------------------------- | ------------------- |
| `Create(_)`                                   | `Create`            |
| `Modify(Name(RenameMode::From))`, `Remove(_)` | `Delete`            |
| `Modify(_)`（其他）                           | `Update`            |
| `Modify(Metadata(_))`（macOS 非 polling）     | 忽略                |

然后它调用 `handle_file_changes`。注意，`rolldown_dev` 自身并不做防抖，也不做 Delete+Create 合并——它会将每个原始 watcher 事件批次直接向下分发。

---

## 7. `handle_file_changes` —— 按状态进行队列化

`handle_file_changes` (`bundle_coordinator.rs:197-237`) 根据当前状态决定文件变更会变成什么 `TaskInput`：

```
state                                 → action
─────────────────────────────────────────────────────────────────
FullBuildInProgress                   → 将文件暂存到
                                        queued_file_changes_waited_
                                        for_full_build（不入队任务）
Idle | InProgress | Failed            → 入队 Hmr（如果
                                        rebuild_strategy == Always，则入队 HmrRebuild），
                                        然后调用 schedule_build_if_stale()
FullBuildFailed                       → 清空 queued_file_changes，
                                        入队 TaskInput::FullBuild，
                                        然后调用 schedule_build_if_stale()
Initialized                           → 记录错误日志，忽略
```

说明：

- 在 `FullBuildInProgress` 期间，文件变更不会被转换为任务；它们会被暂存，并在完整构建成功时回放（`handle_bundle_completed` `:269-273` 会用已排空的集合再次调用 `handle_file_changes`）。
- `Idle`、`InProgress` 和 `Failed` 在这里被**完全同等**对待——三者都会入队一个 `Hmr`/`HmrRebuild`。
- `Hmr` 与 `HmrRebuild` 的选择（`Always` 还是非 `Always`）由 `rebuild_strategy` 选项决定（见 §9）。
- `FullBuildFailed` 是唯一一个会将文件变更处理为队列 `FullBuild` 的状态。

---

## 8. `schedule_build_if_stale` —— 弹出、合并、启动

`schedule_build_if_stale` (`bundle_coordinator.rs:303-372`) 是从 `queued_tasks` 到运行中的 `BundlingTask` 的桥梁。按状态的行为如下：

| 状态                                 | 行为                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Initialized`                         | 记录错误日志，返回 `None`                                                                      |
| `FullBuildInProgress` / `InProgress`  | 已有构建在运行——返回现有的 `current_bundling_future`，不调度任何内容                         |
| `Idle` / `FullBuildFailed` / `Failed` | 弹出队首任务，贪婪地合并后续可合并任务，启动一个 `BundlingTask`                                 |

启动任务时：

1. 弹出队首 `TaskInput`。
2. 当下一个队列任务 `is_mergeable_with` 它时，用 `merge_with` 合并。
3. 构造一个 `BundlingTask`。
4. 如果 `task_input.requires_full_rebuild()` → 状态设为 `FullBuildInProgress`；否则 → 设为 `InProgress`。
5. 用 `tokio::spawn` 将任务的 `run()` 作为 `Shared` future 启动；并将其存入 `current_bundling_future`。

关键不变量：同一时间最多只运行一个 `BundlingTask`。当一个任务运行时，协调器处于 `*InProgress`，新的文件变更只会追加到 `queued_tasks`；当前任务结束后它们会被清空处理（见 §11）。

---

## 9. `RebuildStrategy` 与 `Hmr → HmrRebuild` 升级

`RebuildStrategy` (`crates/rolldown_dev_common/src/types/rebuild_strategy.rs`)：

```rust
pub enum RebuildStrategy {
  Always,   // 在 HMR 之后始终发起增量重建
  Auto,     //（默认）仅当 HMR 更新包含 full-reload 时才重建
  Never,    // HMR 之后绝不重建
}
```

它会在**两个**地方影响 dev 引擎：

### 9a. 在队列阶段（`handle_file_changes`）

```rust
let task_input = if rebuild_strategy.is_always() {
  TaskInput::HmrRebuild { changed_files }   // Always
} else {
  TaskInput::Hmr { changed_files }          // Auto 或 Never
};
```

`Always` 会预先承诺执行重建。`Auto` 和 `Never` 会入队一个仅 HMR 的任务。

### 9b. 在运行时（`bundling_task.rs:104-114`）——自动升级

在生成 HMR 之后，打包任务可能会**重写自己的输入**：

```rust
if rebuild_strategy.is_auto()
  && has_full_reload_update         // 生成的 HMR 更新是 full reload
  && !self.input.requires_rebuild() // 输入原本是纯 Hmr
{
  self.input = TaskInput::HmrRebuild { changed_files: … };
}
```

原因是：一次变更究竟是可以热替换，还是需要整页重载，只有在计算出 HMR diff 之后才能知道。所以在 `Auto` 模式下，协调器先入队一个便宜的 `Hmr`，任务计算 HMR diff，然后 _如果_ diff 结果表明需要 full-reload，任务就把自己升级为 `HmrRebuild` 并执行重建。`Always` 通过始终重建来跳过这一步延迟；`Never` 则在运行时从不重建。

结果：协调器入队的 `TaskInput` 变体并不一定就是实际运行的变体。一个由协调器入队的 `Hmr` 可以在任务执行过程中变成 `HmrRebuild`。

---

## 10. `BundlingTask` —— 执行一个工作单元

`BundlingTask::run` (`bundling_task.rs:58-81`) 会调用 `run_inner`，然后向协调器发送 `BundleCompleted`，并附带两个布尔值：

- `has_encountered_error` —— `has_encountered_error` 标志位或 `run_inner`
  返回 `Err`。
- `has_generated_bundle_output` —— 等于 `has_rebuild_happen`，即任务是否实际执行了重建。

`run_inner` (`bundling_task.rs:83-122`) 按顺序执行：

1. **`watchChange` 插件钩子** —— 对每个变更文件，在最后一个 bundle handle 上调用 `plugin_driver.watch_change`。
2. **HMR 生成** —— 如果 `require_generate_hmr_update()`，则调用 `generate_hmr_updates`，它会设置 `has_full_reload_update`。
3. **自动升级** —— 见 §9b 的 `Hmr → HmrRebuild` 重写。
4. **重建** —— 如果 `requires_rebuild()`，则将 `has_rebuild_happen = true` 并调用 `rebuild()`。

### `generate_hmr_updates` (`bundling_task.rs:124-186`)

- 锁定 `Bundler`。
- 从 `dev_context.clients` 为每个已连接客户端收集 `ClientHmrInput`。
- 调用 `bundler.compute_hmr_update_for_file_changes(...)`。
- 扫描得到的更新；如果有任何一个 `is_full_reload()`，则设置 `has_full_reload_update = true`。
- 出错时，将 `self.has_encountered_error = true`。
- 如果配置了 `on_hmr_updates` 回调，则调用它。

### `rebuild` (`bundling_task.rs:189-223`)

- 锁定 `Bundler`。
- 选择扫描模式：
  ```rust
  let scan_mode = if self.input.requires_full_rebuild() {
    ScanMode::Full
  } else {
    ScanMode::Partial(<changed file paths>)
  };
  ```
- 如果 `skip_write` 为 false，则调用 `bundler.incremental_write(scan_mode)`；否则调用 `bundler.incremental_generate(scan_mode)`。
- 出错时，将 `self.has_encountered_error = true`。
- 如果配置了 `on_output` 回调，则调用它。

只有 `TaskInput::FullBuild` 会产生 `ScanMode::Full`。其他所有重建任务（`Rebuild`、`HmrRebuild`）都会产生 `ScanMode::Partial`。

## 11. `handle_bundle_completed` — 任务收尾

`handle_bundle_completed`（`bundle_coordinator.rs:240-299`）处理
`BundleCompleted` 消息。两个相关分支：

### `FullBuildInProgress`

```rust
current_bundling_future = None;
update_watch_paths();                       // 即使失败也一样
if has_encountered_error {
  state = FullBuildFailed;
  has_stale_bundle_output = true;
} else {
  has_stale_bundle_output = false;
  state = Idle;
  // 重放在完整构建期间暂存的文件变更
  if !queued_file_changes_waited_for_full_build.is_empty() {
    handle_file_changes(drained_changes);
  }
}
// 这里不调用 schedule_build_if_stale — 失败时我们等待外部触发；
// 成功时排队的变更已经处理完了。
```

### `InProgress`

```rust
current_bundling_future = None;
update_watch_paths();                       // 注册新拉入的文件
if has_encountered_error {
  state = Failed;
  has_stale_bundle_output = true;
} else {
  has_stale_bundle_output = !has_generated_bundle_output;
  state = Idle;
}
schedule_build_if_stale();                  // 始终调用 — 清空队列
```

关键信息：

- 任何出错的构建之后，`has_stale_bundle_output` 都会变成 `true`，以及
  成功但**没有**重新构建的任务之后（也就是仅 `Hmr` 任务：
  `has_generated_bundle_output == false`）。
- 成功并且完成了重新构建的任务之后（`Rebuild`、`HmrRebuild`、`FullBuild`），
  `has_stale_bundle_output` 会变成 `false`。
- `InProgress` 分支之后总是调用 `schedule_build_if_stale`，
  无论成功还是失败，因此工作队列会持续被清空。

---

## 12. `has_stale_bundle_output` — 新鲜度标志

`BundleCoordinator` 上的一个 `bool`。语义：磁盘/内存中的完整 bundle
输出可能无法反映最新源码。

| 事件                                                  | `has_stale_bundle_output` 变为 |
| ----------------------------------------------------- | ------------------------------ |
| 构造                                                   | `true`                         |
| 成功的 `FullBuild`                                     | `false`                        |
| 失败的 `FullBuild`                                     | `true`                         |
| 成功且完成了重新构建的任务（`Rebuild`/`HmrRebuild`）  | `false`                        |
| 成功的仅 `Hmr` 任务（未重新构建）                      | `true`                         |
| 失败的增量任务                                         | `true`                         |
| 收到 `ModuleChanged`                                   | `true`                         |

`ensure_latest_bundle_output`（§13）会消费它，以决定在提供完整 bundle 之前
是否需要进行惰性重新构建。它也会反映到 `CoordinatorStateSnapshot.has_stale_output`
以及 `BundleState.has_stale_output` 中。

---

## 13. `ensure_latest_bundle_output` —— 惰性的完整 bundle 管线

这条路径保证浏览器页面加载/刷新时拿到的是最新的完整 bundle。
它横跨 `DevEngine` 和 `BundleCoordinator`。

### 13a. `DevEngine::ensure_latest_bundle_output`（`dev_engine.rs:184-227`）

一个有上限的重试循环：

```rust
loop {
  loop_count += 1;
  if loop_count > 100 { panic!/warn!; break; }   // 安全阀

  // 发送带 oneshot 回复通道的 EnsureLatestBundleOutput
  let received: Option<EnsureLatestBundleOutputReturn> = …;

  if let Some(ret) = received {
    ret.future.await;                            // 等待那次构建完成
    if ret.is_ensure_latest_bundle_output_future {
      break;                                     // 已明确完成构建
    }
    // 否则继续循环，重新请求
  } else {
    break;                                       // None → 已经是最新的
  }
}
```

### 13b. `BundleCoordinator::ensure_latest_bundle_output`（`bundle_coordinator.rs:381-438`）

根据状态返回 `Option<EnsureLatestBundleOutputReturn>`：

| State                                | Action                                   | `future`      | `is_ensure_latest_bundle_output_future` |
| ------------------------------------- | ---------------------------------------- | ------------- | --------------------------------------- |
| `Initialized`                        | warn, return `None`                      | —             | —                                       |
| `Idle`, queue empty, **stale**       | queue an empty-files `Rebuild`, schedule | the new build | `true`                                  |
| `Idle`, queue empty, **fresh**       | return `None`                            | —             | —                                       |
| `Idle`, queue non-empty              | schedule the queued task                 | that build    | `false`                                 |
| `FullBuildInProgress` / `InProgress` | return the running future                | running build | `false`                                 |
| `Failed` / `FullBuildFailed`         | return `None`                            | —             | —                                       |

### 13c. `is_ensure_latest_bundle_output_future` 标志

这个标志告诉 `DevEngine` 循环：等待的 future 是否就是**那个**
会明确产出新鲜输出的构建：

- `true` — 特意为了刷新输出而调度了一次构建（对于过时的 `Idle`，会调度一个 `Rebuild`）。当它完成时，输出就是新鲜的——循环结束。
- `false` — 正在等待的 future 是其他某个构建（一个已存在的排队任务，或一个已经在运行的构建）。当它完成时，输出可能仍然过时，因此循环会重新发送 `EnsureLatestBundleOutput` 并重新评估。
- `None` 回复 — 输出已经是新鲜的；循环会立即结束。

`loop_count > 100` 的保护是为了防止某种病态的、永远无法稳定结束的循环。

### 13d. 完整管线示例 —— 在仅 `Hmr` 任务之后进行页面加载

1. 一个仅 `Hmr` 的任务成功完成。`has_rebuild_happen == false` → `has_generated_bundle_output == false` →
   `has_stale_bundle_output == true`，状态为 `Idle`。
2. 浏览器加载页面。开发服务器中间件（JS/绑定胶水代码，不在这些 crate 内）
   调用 `DevEngine::ensure_latest_bundle_output`。
3. `DevEngine` 向协调器发送 `EnsureLatestBundleOutput`。
4. 协调器处于 `Idle`，队列为空且输出过时：
   排队 `TaskInput::Rebuild { changed_files: {} }`，调度它（`Idle → InProgress`），
   返回该 future，并将标志设为 `true`。
5. `Rebuild` 任务运行：不生成 HMR（`Rebuild` 不需要 `require_generate_hmr_update`），
   `requires_rebuild()` 为 true → `ScanMode::Partial` → `BundleMode::IncrementalBuild`。
   它重新生成完整 bundle 输出。
6. `BundleCompleted { error: false, has_generated_bundle_output: true }` →
   `has_stale_bundle_output = false`，状态为 `Idle`。
7. `DevEngine` 等待的 future 完成；标志为 `true` → 循环结束。
   中间件现在提供的是新鲜的 bundle。

### 13e. 场景

`ensure_latest_bundle_output` 的语义是：**确保调用方拿到最新输出**。如果输出已经过时，它会调度一次构建来生成新鲜输出。如果已经有构建在运行，它就等待。如果构建已经失败且没有文件变更，那么这个失败状态就是最新状态——它无能为力。

**浏览器刷新——仅 HMR 任务之后输出过时。** 最常见的情况。协调器处于 `Idle`，`has_stale_bundle_output` 为 true，队列为空。`ensure_latest_bundle_output` 会调度一个 `Rebuild` 并等待——完整流程见 §13d。

**浏览器刷新——构建正在运行。** 某个文件变更触发了一个尚未完成的重建。协调器返回正在运行的 future。循环等待，然后重新检查，以防构建期间又排入了更多工作。

**浏览器刷新——构建之前已经失败。** 协调器处于 `FullBuildFailed` 或 `Failed`。这个失败状态就是最新输出——在没有新的文件变更前，没有更“新”的内容可以提供。`ensure_latest_bundle_output` 返回 `None`。

**从失败的构建中恢复。** 用户修复了代码。watcher 检测到变更并触发 `handle_file_changes`（§7），从而排入新的构建。当用户刷新浏览器时，协调器要么是 `InProgress`（构建仍在运行——`ensure_latest_bundle_output` 会等待它），要么是 `Idle`（构建已完成——输出已新鲜）。之所以能这样工作，是因为即使在构建失败后，`update_watch_paths()` 也会执行（`handle_bundle_completed`，§11），因此已经解析过的文件仍然会被监控。

**边缘情况：从缺失 import 失败中恢复。** 如果初次构建因为缺失 import 而失败，那么缺失的文件从未被解析过，因此不在 `watch_paths` 中。watcher 无法检测到它的创建，所以编辑或创建它不会触发重建。在这种情况下，需要使用 `triggerFullBuild`（见下文）来强制重建。

**`DevEngine::run()` —— 等待初始构建。** `run()` 会调用 `ensure_latest_bundle_output` 来等待第一次 `FullBuild`。协调器处于 `FullBuildInProgress` 状态并返回正在运行的 future。构建结束后——无论成功还是失败——输出都已经尽可能地最新。循环结束，`run()` 返回。

**通过 `triggerFullBuild` 手动重试。** 这是一个独立的、即发即忘的操作，供那些明确希望无论当前状态如何都强制发起新构建的调用方使用（例如开发服务器的重载命令）。`DevEngine::trigger_full_build` 会向协调器发送 `TriggerFullBuild`，协调器会无条件清空 `queued_tasks`、压入一个 `FullBuild`，并调度它。该调用会立即返回，不等待构建完成。需要等待的调用方可以把它和 `ensure_latest_bundle_output` 组合使用——FIFO 通道顺序保证 `FullBuild` 会先于 ensure 消息被调度。

## 14. bundler 侧的增量入口点

`BundlingTask::rebuild` 的调用会落到
`crates/rolldown/src/bundler/impl_bundler_incremental_build.rs`：

```rust
incremental_write(scan_mode)     // → incremental_bundle(true,  scan_mode)
incremental_generate(scan_mode)  // → incremental_bundle(false, scan_mode)
```

`incremental_bundle` 将 `ScanMode` 映射为 `BundleMode`：

```rust
let bundle_mode = match scan_mode {
  ScanMode::Full       => BundleMode::IncrementalFullBuild,
  ScanMode::Partial(_) => BundleMode::IncrementalBuild,
};
```

然后在 `with_cached_bundle` 中执行工作。

### `with_cached_bundle` — 缓存所有权转移

`with_cached_bundle` 将长生命周期缓存移入每次构建的 `Bundle`，
运行构建闭包，然后把缓存移回去：

```rust
async fn with_cached_bundle<T>(
  &mut self,
  bundle_mode: BundleMode,
  with_fn: impl AsyncFnOnce(&mut Bundle) -> BuildResult<T>,
) -> BuildResult<T> {
  let cache = mem::take(&mut self.cache);       // 从 Bundler 中取出
  let mut bundle =
    self.bundle_factory.create_bundle(bundle_mode, Some(cache))?;
  let ret = with_fn(&mut bundle).await?;
  self.cache = bundle.cache;                    // 移回 Bundler
  Ok(ret)
}
```

这里涉及 **两个** 不同的 `ScanStageCache` 实例：

1. `Bundler::cache` — 在多次重建之间长期保存的缓存（`bundler.rs`）。
2. `Bundle::cache` — 每次构建各自持有的缓存，生命周期仅持续一次 bundle 调用。

`with_cached_bundle` 是它们之间唯一的转移点。

### `ScanStageCache` 与快照

`ScanStageCache`（`crates/rolldown/src/types/scan_stage_cache.rs`）持有
`snapshot: Option<NormalizedScanStageOutput>`，以及模块索引映射和 barrel 状态。
相关方法：

- `set_snapshot(output)` — 存储快照。
- `take_snapshot() -> Option<…>` — 移除并返回它。
- `get_snapshot() -> &NormalizedScanStageOutput` — 借用它
  （文档说明若未设置则会 panic）。
- `get_snapshot_mut()` — 可变借用（若未设置则 panic）。
- `merge(...)` — 将增量扫描输出折叠进快照；第一次时会初始化它。
- `update_defer_sync_data(...)` — 取出快照，执行 `defer_sync_scan_data` 的工作，再把它放回去。

### HMR 读取 `Bundler::cache`

`impl_bundler_hmr.rs` 在三个调用点基于 `&mut self.cache`
（`Bundler::cache`）构建 `HmrStageInput`：

- `compute_hmr_update_for_file_changes` — 基于文件变更的 HMR。
- `compute_update_for_calling_invalidate` — 程序化的 `invalidate()`。
- `compile_lazy_entry` — 懒编译入口的编译。

随后 `HmrStage` 会读取该缓存的快照（例如 `hmr/hmr_stage.rs` 中的 `module_table()` 会调用 `get_snapshot()`）。

---

## 15. `DevEngine` 的其他 API 面

除了 `ensure_latest_bundle_output` 之外，`DevEngine` 上的公开方法（`dev_engine.rs`）：

| Method                                           | Purpose                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `new(config, options)`                           | 构建 `Bundler`，规范化选项，创建 watcher 和 coordinator                                  |
| `run()`                                          | 启动 coordinator 任务，通过 `ensure_latest_bundle_output` 等待初始构建                 |
| `trigger_full_build()`                           | 发送 `TriggerFullBuild`（即发即弃；可与 `ensure_latest_bundle_output` 组合以等待）      |
| `wait_for_close()`                               | 等待 coordinator 的 join handle                                                          |
| `wait_for_ongoing_bundle()`                      | `GetState`，等待任意正在运行的 future                                              |
| `get_bundle_state()`                             | `GetState` → `BundleState { last_full_build_failed, has_stale_output }`                  |
| `invalidate(caller, first_invalidated_by)`       | 锁定 bundler，为每个 client 调用 `compute_update_for_calling_invalidate`                |
| `compile_lazy_entry(proxy_module_id, client_id)` | 编译一个懒入口；成功后发送 `ModuleChanged`                                             |
| `close()`                                        | 发送 `Close`，运行 `closeBundle`，等待 coordinator 关闭                                  |
| `is_closed()` / `bundler_options()`              | 访问器                                                                                      |

`ModuleChanged` 的处理（`bundle_coordinator.rs:123-140`）：更新 watch
路径，为变更的模块排队一个 `TaskInput::Rebuild`，将 `has_stale_bundle_output = true`，
并进行调度。

`#[cfg(feature = "testing")]` 下的方法——
`ensure_task_with_changed_files`、`get_watched_files`、
`create_client_for_testing`——用于测试框架驱动合成文件变更并检查 coordinator 状态。

## 16. 快速参考 — 概念到文件映射

## 16. 错误处理

dev engine 有三个错误受众。给它们命名很重要，因为它们需要不同的处理方式，而同一个 `Result` 不可能同时满足所有对象的需求。错误的类别与传递通道也会因此按受众拆分。

### 16a. 三类受众

- **最终用户** — 使用构建在 `rolldown_dev` 之上的框架的应用开发者（通常是 Vite）。编写源代码和插件。看到来自自身工作的错误——构建错误、插件失败。
- **绑定消费者** — 集成 `rolldown_dev` 的框架或工具（通常是 Vite）。拥有引擎生命周期：构造它、调用 `run`、将 HMR 客户端消息路由到 `invalidate`、在关闭时调用 `close`。当它在错误的时机调用引擎时会看到错误（`close` 之后调用 `invalidate`、在 `run` 之前调用 `ensure_latest_build_output` 等）。他们负责正确的调用顺序；我们暴露这种误用，方便他们发现自己的 bug。
- **我们** — `rolldown_dev` 自身。把不变式违反视为 panic（§16g）。这些是我们发布出去的 bug；两个用户都无法从中恢复，而 panic 是让它们显性暴露的正确方式。

按受众划分的错误：

- **构建错误** → 最终用户。
- **生命周期错误** → 绑定消费者。
- **不变式违反** → panic（我们）。

#### 构建错误（最终用户）

`BuildResult<T>` / `BatchedBuildDiagnostic` 由 bundler 内部产生。
来源于用户代码或插件（resolve、load、transform、plugin 生命周期钩子）。

示例：

- `Bundler::compute_hmr_update_for_file_changes` — 来自 HMR 计算的诊断，在 `BundlingTask::generate_hmr_updates` 内部暴露。
- `Bundler::compute_update_for_calling_invalidate` — 来自程序化 `invalidate()` 路径的诊断，由 `DevEngine::invalidate` 暴露。
- `Bundler::incremental_write` / `incremental_generate` — 来自重建的诊断，在 `BundlingTask::rebuild` 内部暴露。
- `plugin_driver.watch_change` — 来自插件 `watchChange` 钩子的 `anyhow::Error`，在 `BundlingTask::run_inner` 调用点被提升为 `BatchedBuildDiagnostic`。

#### 生命周期错误（绑定消费者）

`BuildResult<T>` 由 `DevEngine` 自身产生，而不是 bundler。
来源于引擎的状态机：方法在一个已关闭的引擎上被调用、coordinator 的 mpsc 通道在操作过程中被关闭、因为 coordinator 消失导致内部 oneshot 回复始终未到达。

示例：

- 每个触及 coordinator 的 `DevEngine` 方法顶部的 `create_error_if_closed()?`（`dev_engine.rs`）。
- 引擎关闭后调用 `coordinator_sender.send(...).map_err_to_unhandleable().context(...)?`。
- 在 coordinator 响应之前它就已关闭时的 `reply_receiver.await.map_err_to_unhandleable().context(...)?`。

这些是绑定消费者的责任——Vite 必须安排好调用顺序，避免与 `close()` 竞争。当竞争真的发生时，我们会报告而不是吞掉它（§16d），这样消费者才能检测并修复排序 bug。

这两类错误如今共享同一个 `BuildResult<T>` 类型——没有静态区分。需要区别响应的代码必须先检查 `DevEngine::is_closed()`。

### 16b. 两种传递通道

**Throw（同步 API）** — 公开的 napi 方法，接受单个调用者并返回单个结果，在边界上使用 `BindingResult<T> = Either<BindingErrors, T>`，JS 包装层调用 `unwrapBindingResult`，要么返回成功值，要么抛出 `BundleError`。

适用于：`invalidate`、`ensureLatestBuildOutput`、`getBundleState`、
`waitForOngoingBundle`。抛出的错误会到达调用该方法的任一受众：

- `invalidate` 通常由绑定消费者的 HMR 层响应最终用户的 HMR 客户端消息而调用。抛出的错误由消费者观察；是否转发给最终用户由消费者决定。
- `ensureLatestBuildOutput` 由消费者的 dev-server 中间件在响应请求前调用。由消费者处理或转发。
- `close`、`run`、生命周期形态的方法在设计上就是由消费者驱动的。

**Callback（异步生命周期）** — 在 `BundlingTask` 内部异步发生的工作，通过引擎构造时注册的 `on_output` / `on_hmr_updates` 回调上报（见 §10）。

适用于：`BundlingTask::run_inner` 内产生的所有错误——
`watch_change`、`generate_hmr_updates`、`rebuild`。消费者在引擎创建时订阅一次，并会收到每次构建结果的通知。这些回调是构建错误抵达最终用户的标准通道（由消费者将其转发到自己的错误遮罩层 / HMR 错误展示）。

选择通道的规则：**如果消费者无法提前设置回调（因为错误来源于一次性调用），就 throw；否则交给回调**。

### 16c. `BundlingTask` 内部的错误路由

`run_inner` 有三个会产生错误的阶段。每个阶段都为自己的错误负责路由决策；`run_inner` 本身没有顶层错误处理器。

| 阶段                   | 使用的回调       | 若已注册回调         | 若未注册回调        |
| ---------------------- | ---------------- | -------------------- | ------------------- |
| `watch_change` 钩子    | `on_output`      | 传递，然后提前返回   | 仅记录日志，提前返回 |
| `generate_hmr_updates` | `on_hmr_updates` | 传递，然后可能继续   | 仅记录日志，可能停止 |
| `rebuild`              | `on_output`      | 传递                 | 仅记录日志          |

任一阶段失败都会设置 `self.has_encountered_error = true`，并通过 `BundleCompleted { has_encountered_error, ... }` 上报给 coordinator。coordinator 使用它切换到 `FullBuildFailed` / `Failed`（§11），不管是否注册了回调去接收错误本身。

`generate_hmr_updates` 返回 `bool` ——“后续阶段是否可以继续？”——保留了 `BuildResult` 之前的短路语义：只有当某个 HMR 错误没有可用回调来暴露它时，才会跳过 rebuild（与旧的 `?` 传播行为一致）。

`watch_change` 是短路的：如果某个插件的 `watchChange` 钩子失败，则 HMR 生成和 rebuild 都无法安全继续，所以 `run_inner` 会提前返回。

### 16d. 引擎已关闭：默认暴露给绑定消费者

生命周期错误（引擎已关闭、coordinator 消失、通道断开）会**暴露给绑定消费者**，而不是静默吞掉。Vite 需要看到它在 `close` 之后调用了 `invalidate`，这样才能修正调用顺序；吞掉错误只会掩盖误用并让它蔓延。

**每方法例外**：当“没有事情可做，直接返回”对于该方法语义来说显然是正确答案时，方法 MAY 返回 `Ok` 而不是生命周期错误。适用条件是：

- 该方法在等待 / 观测，而不是请求工作。
- “你正在等待的事情不可能再发生了”已经是完整且诚实的回答。
- 抛错会迫使消费者为一个正常的关闭事件写 `try/catch`，却没有任何有用的恢复动作。

当前采用该例外的方法：

- `DevEngine::wait_for_ongoing_bundle`（`dev_engine.rs:144-172`）——等待一个正在进行但现在不会再发生的构建；返回 `Ok` 在语义上是正确的。该方法的文档注释已明确说明这一点。
- `BindingDevEngine::ensure_current_build_finish`（JS 中 `DevEngine.ensureCurrentBuildFinish` 使用的 napi 包装）——同样的形态，PR #9564。

其他所有生命周期错误路径都应该暴露出来。新增方法时，**默认应选择暴露**；只有在存在明确的语义理由时才使用该例外，并在方法上写明。

### 16e. 转换路径：`BuildResult` → `BindingResult` → JS

三步：

1. **`BuildResult<T>`**（`Result<T, BatchedBuildDiagnostic>`）—— bundler 的原生错误类型，Rust crate 内部到处使用。
   `BatchedBuildDiagnostic` 承载一个或多个 `BuildDiagnostic`。

2. **`BindingResult<T>`**（`Either<BindingErrors, T>`，
   `crates/rolldown_binding/src/types/error/mod.rs`）—— napi 边界类型。
   在 `Err` 侧，每个 `BuildDiagnostic` 通过 `to_binding_error(diagnostic, cwd)`
   （`crates/rolldown_binding/src/types/binding_outputs.rs:79`）转换为一个 `BindingError`。
   `cwd` 用于 `DiagnosticOptions` 将路径格式化为相对于项目根目录的路径。`BindingDevEngine` 保存 `cwd: Arc<Path>`，这样结构体方法和两个回调闭包可以共享同一份分配。

3. **JS 层**（`packages/rolldown/src/utils/error.ts`）——
   `unwrapBindingResult(container)` 成功时返回 `T`，失败时抛出一个聚合了各个 `BindingError` 的 `BundleError`。
   `normalizeBindingResult(container)` 返回 `T | Error` 而不抛出，供没有合适 `throw` 语义的回调使用。

### 16f. 约定

- **不要在 `BuildResult` 或任何消费者可达的 `Result` 上调用 `.expect()` / `.unwrap()`。** panic 会穿过 napi FFI 边界，可能使 Node 进程崩溃。应使用 `match` 并通过合适的通道路由。
- **`create_error_if_closed()` 是入口守卫。** 每个触及 coordinator 的 `DevEngine` 方法都先运行它。默认情况下，得到的错误会暴露给绑定消费者（§16d）；采用“吞掉并返回 `Ok`”例外（§16d）的方法，也必须在每个 `.send(...)` 和 `.recv()` 位置处理调用过程中途的关闭竞争。
- **插件错误对用户可见。** 永远不要静默丢弃它们；它们总会到达 `on_output` 或 `on_hmr_updates`。
- **每个阶段都负责自己的传递。** 在 `BundlingTask` 内部，每个阶段函数处理自己的错误传递；`run_inner` 不是集中式错误处理器。
- **`has_encountered_error` 是 coordinator 的信号，callbacks 是消费者的信号。** 每次错误都会同时设置这两者；一个驱动状态机，另一个通知用户。

### 16g. 何时 panic

dev engine 中并非所有 `Result` 都应该被路由。有些 `.expect(...)` / `.unwrap()` 调用是正确的：它们断言的是内部不变式——由我们自己的代码保证的属性——而 panic 则是在暴露编程 bug，而不是运行时条件。

规则：

- **对不变式违反 panic。** 如果我们自己的状态机逻辑、关闭顺序或消息协议契约都正确，那么该代码路径应当不可达。如果它触发了，就说明我们发布了 bug，panic 会让问题显式暴露，而不是把它吞进静默日志。
- **路由运行时条件。** 任何依赖用户代码、插件行为、文件系统状态、网络、与消费者驱动的生命周期事件（如 `close()`）竞争，或输入校验的情况——都要通过 §16b 中的通道路由。若对此 panic，会因为消费者必须能够观察并恢复的问题而直接让 Node 进程崩溃。

判断时一个有用的测试：_这个错误能否由我们 crate 之外的任何东西触发？_ 如果能，就路由它；如果不能，就 panic。

`rolldown_dev` 中现有且是有意为之、不是权宜之计的 panic 点：

- `crates/rolldown_dev/src/watcher_event_handler.rs:10` —
  `coordinator_tx.send(...).expect(...)`。coordinator 的 mpsc receiver 由 coordinator 任务拥有，它只会在 `Close` 消息到来时关闭。文件系统 watcher 不可能触发那条路径；如果它的 `send` 失败，说明我们的关闭顺序有问题。
- `crates/rolldown_dev/src/bundling_task.rs:71` — 最终 `BundleCompleted` 发送上的同类模式。coordinator 会在处理 `Close` 前等待所有正在进行的 `BundlingTask`（§4），因此按设计在这次发送执行时 receiver 一定还活着。
- `crates/rolldown_dev/src/bundle_coordinator.rs:323, 420` —
  `current_bundling_future.clone().unwrap()` 只在 `*InProgress` 状态下可达，而状态机保证此时为 `Some(_)`。这里出现 `None` 说明有一次状态转换被遗漏了。
- `crates/rolldown_dev/src/dev_engine.rs:117` — coordinator 任务上的 `join_handle.await.unwrap()`。coordinator 的 `run()` 是内部代码，不应该 panic；这里出现 `JoinError` 说明我们在 coordinator 逻辑中引入了 panic，应当修复那个 panic 本身，而不是掩盖症状。

新增 panic 点时，请在 `.expect(...)` 消息中记录被断言的不变式，这样下一位读者无需反向推导就能看懂契约。

---

## 17. 速查——概念到文件映射

| 概念                                         | 文件                                                            |
| -------------------------------------------- | --------------------------------------------------------------- |
| 公共 dev API，协调器启动                       | `crates/rolldown_dev/src/dev_engine.rs`                         |
| 状态机、排队与调度                             | `crates/rolldown_dev/src/bundle_coordinator.rs`                 |
| 一个构建工作单元                               | `crates/rolldown_dev/src/bundling_task.rs`                      |
| 共享上下文                                     | `crates/rolldown_dev/src/dev_context.rs`                        |
| `CoordinatorState` 枚举                        | `crates/rolldown_dev/src/types/coordinator_state.rs`            |
| `TaskInput` 枚举，合并规则                     | `crates/rolldown_dev/src/types/task_input.rs`                   |
| `CoordinatorMsg` 枚举                          | `crates/rolldown_dev/src/types/coordinator_msg.rs`              |
| `RebuildStrategy` 枚举                         | `crates/rolldown_dev_common/src/types/rebuild_strategy.rs`      |
| 增量入口，`with_cached_bundle`                 | `crates/rolldown/src/bundler/impl_bundler_incremental_build.rs` |
| HMR 入口点                                     | `crates/rolldown/src/bundler/impl_bundler_hmr.rs`               |
| `ScanStageCache`                               | `crates/rolldown/src/types/scan_stage_cache.rs`                 |

---

## 未解决的问题

- **对缺失导入失败的自动恢复。** 当构建因为无法解析的导入而失败时，缺失的文件从未被解析，并且不在 `watch_paths` 中。创建该文件不会触发重建——用户必须触碰一个已被监视的文件，或使用 `triggerFullBuild`。一种修复方案是：在解析过程中，当某个文件未找到时，记录其路径，并将其父目录添加到 watcher 中。这样，目录级别的创建事件如果匹配到先前缺失的路径，就会自动触发重建。现有的 watcher 测试已经承认了这一缺口（`watch.test.ts`：“缺失文件所在目录不会被自动监视，所以我们需要触碰一个被监视的文件”）。

---

## 相关内容

- [bundler-data-lifecycle](./bundler-data-lifecycle.md) — `BundleMode`、
  `Bundle` / `BundleFactory`，以及 dev
  引擎增量构建所经历的 `ScanStageCache` 生命周期
- [rust-bundler](./rust-bundler.md) — 核心 `Bundler` 结构体以及 dev
  引擎驱动的构建生命周期
- [watch-mode](./watch-mode.md) — `rolldown_watcher`，基于 actor 的
  watch 架构；`rolldown_dev` 复用了相同的 actor 模式
- [lazy-compilation](./lazy-compilation.md) — 懒加载入口编译，
  通过 `DevEngine::compile_lazy_entry` 和 `ModuleChanged`
  消息到达
- [dev-server-browser-tests](./dev-server-browser-tests.md) — dev server 的浏览器
  测试工具
- `crates/rolldown_dev/` — dev 引擎实现
- `crates/rolldown_dev_common/` — `RebuildStrategy`、dev 选项
