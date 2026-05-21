# `rolldown_dev` 中的开发引擎（完整打包模式）

## 概要

开发引擎（`rolldown_dev` crate）是在完整打包模式下，rolldown 的开发模式构建编排层。它位于文件监听器 / 开发服务器与核心 `Bundler` 之间，负责决定要运行 _哪一种_ 构建——HMR 补丁、增量重建，还是完整构建——以及 _何时_ 运行。它的结构是：由一个 `DevEngine`（公开的异步 API 表面）驱动一个单消息循环的 `BundleCoordinator`（一个状态机加工作队列），后者一次只会启动一个 `BundlingTask`。本文是这套机制的结构图：组件分层、`CoordinatorMsg` 协议、`CoordinatorState` 状态机、`TaskInput` 工作类型，以及用于文件编辑、HMR 生成和浏览器页面加载时懒加载完整打包刷新的数据流管线。本文描述的是当前实现的 **事实**，而不是任何特定变更的叙事。

---

## 1. 组件与分层

开发引擎由四个协作部分构成，全部位于 `crates/rolldown_dev/src/`：

```
                    ┌─────────────────────────────────────────┐
                    │              DevEngine                   │
                    │  (dev_engine.rs)                         │
                    │  - public async API surface              │
                    │  - owns Arc<Mutex<Bundler>>              │
                    │  - owns the coordinator mpsc Sender      │
                    │  - spawns the coordinator task           │
                    └───────────────┬─────────────────────────┘
                                    │  CoordinatorMsg (mpsc)
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │           BundleCoordinator              │
                    │  (bundle_coordinator.rs)                 │
                    │  - single-threaded message loop          │
                    │  - owns CoordinatorState                 │
                    │  - owns queued_tasks: VecDeque<TaskInput>│
                    │  - owns the fs watcher                   │
                    │  - decides WHAT build to run and WHEN    │
                    └───────────────┬─────────────────────────┘
                                    │  spawns
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │             BundlingTask                 │
                    │  (bundling_task.rs)                      │
                    │  - one unit of build work                │
                    │  - locks the Bundler, runs HMR/rebuild   │
                    │  - reports back via CoordinatorMsg       │
                    └───────────────┬─────────────────────────┘
                                    │  calls into
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
- 每个 `BundlingTask` 都运行在它 **自己的** 已 spawn 任务中。协调器会持有当前正在运行任务的 `Shared` future 句柄（`current_bundling_future`）。
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
  GetState { reply: … },                     // 获取协调器状态快照
  EnsureLatestBundleOutput { reply: … },     // “我需要一个最新的完整打包结果”
  GetWatchedFiles { reply: … },              // 获取被监听的路径列表
  ModuleChanged { module_id: String },       // 程序化的模块变更
  Close,                                     // 关闭协调器
}
```

路由发生在 `BundleCoordinator::run` 中（`bundle_coordinator.rs:98-150`）：

| 消息                       | 处理器                                      |
| -------------------------- | -------------------------------------------- |
| `WatchEvent`               | `handle_watch_event` → `handle_file_changes` |
| `BundleCompleted`          | `handle_bundle_completed`                    |
| `ScheduleBuildIfStale`     | `schedule_build_if_stale`，并返回结果        |
| `GetState`                 | `create_state_snapshot`，并返回              |
| `EnsureLatestBundleOutput` | `ensure_latest_bundle_output`，并返回        |
| `GetWatchedFiles`          | 返回 `watched_files` 集合                    |
| `ModuleChanged`            | 入队一个 `Rebuild`，然后调度                 |
| `Close`                    | 等待正在运行的任务结束，然后 `break` 循环     |

消息的发送方：

- **文件监听器** 发送 `WatchEvent`。监听器事件处理器由 `BundleCoordinator::create_watcher_event_handler` 创建，并连接到同一个 `coordinator_tx`。
- 完成的 **`BundlingTask`** 会在其 `run()` 中发送 `BundleCompleted`（`bundling_task.rs:75-80`）。
- **`DevEngine`** 会代表其公开 API 调用者（开发服务器、HTTP 中间件、懒编译端点等）发送 `ScheduleBuildIfStale`、`GetState`、`EnsureLatestBundleOutput`、`GetWatchedFiles`、`ModuleChanged`、`Close`。

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
| `Initialized`          | 已构造，但 `run()`  هنوز未进入。瞬态状态。                        |
| `FullBuildInProgress`  | 初始的 `TaskInput::FullBuild` 正在运行。                          |
| `FullBuildFailed`      | 初始完整构建出错。此时完全没有可用输出。                           |
| `Idle`                 | 没有构建在运行；最后一次构建（如果有）已成功。                    |
| `InProgress`           | 正在运行增量任务（`Hmr` / `HmrRebuild` / `Rebuild`）。           |
| `Failed`               | 上一次增量任务出错。                                             |

### 状态转移图

```
            ┌──────────────┐
            │ Initialized  │  (constructor: BundleCoordinator::new)
            └──────┬───────┘
                   │ run() entry: push TaskInput::FullBuild,
                   │ set state=Idle, schedule_build_if_stale()
                   ▼
        ┌────────────────────┐
        │        Idle        │ ◄──────────────────────────────┐
        └─────────┬──────────┘                                │
                  │ schedule_build_if_stale pops a task:      │
                  │   FullBuild → FullBuildInProgress         │
                  │   else      → InProgress                  │
        ┌─────────┴──────────┐                                │
        ▼                    ▼                                │
┌───────────────────┐  ┌───────────────────┐                  │
│FullBuildInProgress│  │    InProgress     │                  │
└─────────┬─────────┘  └─────────┬─────────┘                  │
          │ BundleCompleted      │ BundleCompleted            │
          │  err → FullBuildFailed│  err → Failed             │
          │  ok  → Idle ─────────┼──ok──→ Idle ───────────────┤
          ▼                      ▼  (then schedule_build_if_  │
┌───────────────────┐  ┌───────────────────┐    stale always)│
│  FullBuildFailed  │  │      Failed       │                  │
└─────────┬─────────┘  └─────────┬─────────┘                  │
          │ next file change:    │ next file change:          │
          │  queue FullBuild,    │  queue Hmr/HmrRebuild,     │
          │  schedule →          │  schedule →                │
          │  FullBuildInProgress │  InProgress ───────────────┘
          ▼                      ▼
       (loop)                 (loop)
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

## 13. `ensure_latest_bundle_output` — 惰性的完整 bundle 管线

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

| 状态                                 | 操作                                                  | `future`      | `is_ensure_latest_bundle_output_future` |
| ------------------------------------ | ----------------------------------------------------- | ------------- | --------------------------------------- |
| `Initialized`                        | 警告，返回 `None`                                     | —             | —                                       |
| `Idle`，队列为空，**过时**           | 排队一个空 `changed_files` 的 `Rebuild`，并调度        | 新的构建       | `true`                                  |
| `Idle`，队列为空，**新鲜**           | 返回 `None`                                           | —             | —                                       |
| `Idle`，队列非空                     | 调度队列中的任务                                      | 那次构建       | `false`                                 |
| `FullBuildInProgress` / `InProgress` | 返回正在运行的 future                                  | 正在运行的构建 | `false`                                 |
| `Failed` / `FullBuildFailed`         | `queued_tasks.clear()`，排队 `FullBuild`，并调度        | 新的构建       | `true`                                  |

### 13c. `is_ensure_latest_bundle_output_future` 标志

这个标志告诉 `DevEngine` 循环：等待的 future 是否就是**那个**
会明确产出新鲜输出的构建：

- `true` — 这个构建是专门为了刷新输出而调度的（针对过时 `Idle` 的 `Rebuild`，
  或针对 `Failed`/`FullBuildFailed` 的恢复性 `FullBuild`）。它完成后，
  输出就是新鲜的——循环结束。
- `false` — 等待的 future 是别的构建（已经存在的排队任务，或已经在运行的构建）。
  它完成时输出仍可能是过时的，所以循环会再次发送
  `EnsureLatestBundleOutput` 并重新判断。
- `None` 回复 — 输出已经是新鲜的；循环立刻结束。

`loop_count > 100` 的保护是为了防止某种病态的、永远无法稳定结束的循环。

### 13d. 完整管线示例 — 在仅 `Hmr` 任务之后进行页面加载

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

---

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

| 方法                                                | 作用                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `new(config, options)`                              | 构建 `Bundler`，规范化选项，创建 watcher 和 coordinator                                 |
| `run()`                                             | 启动 coordinator 任务，通过 `ensure_latest_bundle_output` 等待初次构建                   |
| `wait_for_close()`                                  | 等待 coordinator 的 join handle                                                          |
| `wait_for_ongoing_bundle()`                         | `GetState`，等待任何正在运行的 future                                                   |
| `get_bundle_state()`                                | `GetState` → `BundleState { last_full_build_failed, has_stale_output }`                  |
| `invalidate(caller, first_invalidated_by)`          | 锁定 bundler，按客户端调用 `compute_update_for_calling_invalidate`                        |
| `compile_lazy_entry(proxy_module_id, client_id)`    | 编译一个懒入口；成功后发送 `ModuleChanged`                                               |
| `close()`                                           | 发送 `Close`，运行 `closeBundle`，等待 coordinator 关闭                                    |
| `is_closed()` / `bundler_options()`                 | 访问器                                                                                   |

`ModuleChanged` 的处理（`bundle_coordinator.rs:123-140`）：更新 watch
路径，为变更的模块排队一个 `TaskInput::Rebuild`，将 `has_stale_bundle_output = true`，
并进行调度。

`#[cfg(feature = "testing")]` 下的方法——
`ensure_task_with_changed_files`、`get_watched_files`、
`create_client_for_testing`——用于测试框架驱动合成文件变更并检查 coordinator 状态。

## 16. 快速参考 — 概念到文件映射

| 概念                                           | 文件                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- |
| 公共 dev API，协调器启动                        | `crates/rolldown_dev/src/dev_engine.rs`                         |
| 状态机、排队与调度                              | `crates/rolldown_dev/src/bundle_coordinator.rs`                 |
| 一个构建工作单元                                | `crates/rolldown_dev/src/bundling_task.rs`                      |
| 共享上下文                                      | `crates/rolldown_dev/src/dev_context.rs`                        |
| `CoordinatorState` 枚举                        | `crates/rolldown_dev/src/types/coordinator_state.rs`            |
| `TaskInput` 枚举，合并规则                     | `crates/rolldown_dev/src/types/task_input.rs`                   |
| `CoordinatorMsg` 枚举                          | `crates/rolldown_dev/src/types/coordinator_msg.rs`              |
| `RebuildStrategy` 枚举                         | `crates/rolldown_dev_common/src/types/rebuild_strategy.rs`      |
| 增量入口，`with_cached_bundle`                 | `crates/rolldown/src/bundler/impl_bundler_incremental_build.rs` |
| HMR 入口点                                      | `crates/rolldown/src/bundler/impl_bundler_hmr.rs`               |
| `ScanStageCache`                               | `crates/rolldown/src/types/scan_stage_cache.rs`                 |

---

## 相关

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
