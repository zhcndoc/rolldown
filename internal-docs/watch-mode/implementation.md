# Watch 模式 — 实现

> 设计原则和开放问题位于 [design.md](./design.md)。
> 本文件是实现参考。

## 摘要

Watch 模式会监视源文件，并在检测到变更时自动重新构建。`rolldown_watcher` crate 是其基础，采用简洁的 actor 架构。本文档是实现和演进 watch 模式的权威参考。

## API 契约

### TypeScript API（与 Rollup 对齐）

```typescript
function watch(input: WatchOptions | WatchOptions[]): RolldownWatcher;
```

- 接受单个配置或配置数组。
- 每个配置可以包含多个 `output` 条目。在内部，**每个 output 都会创建一个独立的 bundler**（一个 `WatchTask`）。
- 立即返回一个 `RolldownWatcher`。第一次构建会延迟到 `process.nextTick`，以便调用方先挂载事件监听器。这与 Rollup 的模式一致：构造函数会调用 `process.nextTick(() => this.run())`，其中 `run()` 是私有的。

```typescript
interface RolldownWatcher {
  on<E extends keyof RolldownWatcherEventMap>(
    event: E,
    listener: (...args: RolldownWatcherEventMap[E]) => MaybePromise<void>,
  ): this;
  off<E extends keyof RolldownWatcherEventMap>(
    event: E,
    listener: (...args: RolldownWatcherEventMap[E]) => MaybePromise<void>,
  ): this;
  clear<E extends keyof RolldownWatcherEventMap>(event: E): void;
  close(): Promise<void>;
}

type RolldownWatcherEventMap = {
  event: [data: RolldownWatcherEvent];
  change: [id: string, change: { event: ChangeEvent }];
  restart: [];
  close: [];
};

type ChangeEvent = 'create' | 'update' | 'delete';

type RolldownWatcherEvent =
  | { code: 'START' }
  | { code: 'BUNDLE_START' }
  | { code: 'BUNDLE_END'; duration: number; output: readonly string[]; result: RolldownWatchBuild }
  | { code: 'END' }
  | { code: 'ERROR'; error: Error; result: RolldownWatchBuild };
```

事件监听器通常会在继续之前被 **await** —— 这种阻塞语义与 Rollup 一致。
协调器只有在下面所述的具备关闭感知的派发竞态中，关闭请求赢得胜利时，才可能停止等待 `event`、`change` 或 `restart` 监听器。
JavaScript 回调本身仍会继续运行，而 `watcher.close()` 仍会等待完整的关闭序列结束。

### Rust API

```rust
let watcher = Watcher::new(configs, handler, &watcher_config)?;
watcher.run();       // 启动协调器（非阻塞）
watcher.close().await?;  // 发送 Close，等待完成
```

遵循与 `DevEngine` 相同的 `new → run → close` 模式。`new()` 创建协调器 future，但不会立即启动它。`run()` 将其调度到 tokio runtime 上。`close()` 会设置共享关闭信号，发送一个 fire-and-forget 的 `Close` 消息，并等待共享完成 future。`wait_for_close()` 为消费者提供了一种可靠的方式，可在不关闭 watcher 的情况下等待其完成。

### 与 Rollup 的已知差异

| 方面               | Rollup                     | Rolldown               | 原因                                                              |
| ------------------ | -------------------------- | ---------------------- | ------------------------------------------------------------------- |
| 每个 output 一个 bundler | 一个 build，多次写入 | 每个 output 一个 bundler | 架构约束 — Rolldown 的 bundler 拥有完整流水线 |
| `buildStart` 调用   | 每个 config 一次           | 每个 output 一次        | 每个 output 一个 bundler 的结果                               |
| 模块图共享         | 各 output 共享             | 每个 output 独立        | 未来可能会改变                                            |
| `restart` 事件      | 每次 config 变更一次       | 每次 rebuild cycle 一次 | Rolldown 每个 rebuild cycle 触发一次 `restart`                     |

## 架构

### Actor 模式

```
Watcher（公共 API）
  ├── tx: mpsc::Sender ──→ WatchCoordinator（actor，拥有一切）
  └── close_notify ──────→ 在其等待消费者回调时唤醒协调器
                               ├── handler: H（WatcherEventHandler impl）
                               ├── state: WatcherState
                               └── tasks: IndexVec<WatchTaskIdx, WatchTask>
                                    ├── WatchTask 0
                                    │   ├── bundler: Arc<TokioMutex<Bundler>>
                                    │   ├── fs_watcher: DynFsWatcher（拥有，按 task）
                                    │   ├── watched_files: FxDashSet<ArcStr>
                                    │   └── needs_rebuild: bool
                                    └── WatchTask N ...

数据流：
  DynFsWatcher ──(TaskFsEventHandler: 将 notify 事件映射为 FileChangeEvent)──→ WatcherMsg::FileChanges ──→ WatchCoordinator
  WatchCoordinator ──→ dispatch_event / dispatch_change / dispatch_restart
                         └── await_handler_or_close()
                               ├── handler.on_*().await ──→ Consumer（NAPI/Rust）
                               └── close_notify ─────────→ 停止回调等待并执行 handle_close()
```

**所有权规则：**

- `Watcher` 只持有生命周期状态（`tx`、关闭信号和 `coordinator_state`）——轻量，不直接访问 bundler。
- `WatchCoordinator` 拥有所有可变状态。没有外部修改。
- 每个 `WatchTask` 都拥有自己的 `DynFsWatcher`。每个 task 独立的 watcher 集合意味着更清晰的所有权和更简单的设计。
- Bundler 使用 `Arc<TokioMutex<>>`，因为事件数据结构会携带一个克隆供消费者访问（例如 `BUNDLE_END.result`）。

### 三层栈

```
TypeScript API (packages/rolldown/src/api/watch/)
  ├── watch-emitter.ts   — WatcherEmitter: on/off/clear，向监听器派发
  ├── watcher.ts         — createWatcher: options → BindingWatcher，连接 close
  └── index.ts           — watch() 公共函数
       ↓
NAPI Bindings (crates/rolldown_binding/src/watcher.rs)
  ├── BindingWatcher     — 封装 rolldown_watcher::Watcher
  └── NapiWatcherEventHandler — 实现 WatcherEventHandler，桥接到 JS
       ↓
Rust Core (crates/rolldown_watcher/)
  └── Watcher → WatchCoordinator → WatchTask[] → Bundler
```

### Crate 布局

```
rolldown_watcher/
├── lib.rs                     // 公共导出
├── watcher.rs                 // Watcher（公共 API）+ WatcherConfig
├── watch_coordinator.rs       // WatchCoordinator（actor + event loop）
├── watch_task.rs              // WatchTask（bundler + fs watcher）+ WatchTaskIdx + BuildOutcome
├── task_fs_event_handler.rs   // TaskFsEventHandler（notify → FileChangeEvent 映射）
├── handler.rs                 // WatcherEventHandler async trait
├── event.rs                   // WatchEvent、BundleStartEventData、BundleEndEventData、WatchErrorEventData
├── file_change_event.rs       // FileChangeEvent（path + kind）
├── watcher_state.rs           // WatcherState enum + transitions
└── watcher_msg.rs             // WatcherMsg enum（FileChanges、Close）
```

## 状态机

```
Idle ──(FsEvent)──→ Debouncing
Debouncing ──(更多 FsEvent)──→ Debouncing（延长 deadline，合并变更）
Debouncing ──(timeout)──→ 运行 rebuild 序列 → drain buffered → Idle 或 Debouncing
Any ──(Close)──→ Closing → Closed
```

**没有显式的 Building 状态。** 协调器的事件循环在构建期间会阻塞（它会 `await`）。Fs 事件会在 mpsc channel 中缓冲。构建完成后，通过 `try_recv()` 执行 `drain_buffered_events()` 将其取出。

```rust
enum WatcherState {
    Idle,
    Debouncing { changes: FxIndexMap<String, WatcherChangeKind>, deadline: Instant },
    Closing,
    Closed,
}
```

**去抖合并：** 当在去抖窗口内同一路径到达多个事件时，变更类型会被合并，而不是简单地采用最后写入覆盖。细节见下方“类型合并”。

## 去抖

### 两层机制，一个默认值

存在两种可能的去抖层：

1. **协调器层**（`WatcherState::Debouncing`）——在触发重建之前，跨文件批量收集文件变更。由 `buildDelay` 控制。这是主要机制。
2. **Fs-watcher 层**（`notify-debouncer-full`）——对同一文件的快速 OS 级事件进行去重（例如在一次保存中多次写入的编辑器）。可在 `rolldown_fs_watcher` 中使用，但 watcher 默认未启用。

默认情况下仅启用协调器层去抖。这与 Rollup 一致，后者在 chokidar 之上自行实现 `setTimeout`/`clearTimeout` 去抖（chokidar 没有 debounce 选项——只有用于写入完成检测的 `awaitWriteFinish`）。

### Rollup 的做法

Rollup 的 `buildDelay` 选项（默认：**0ms**）控制一种简单的定时器重置模式：

```javascript
// 每次文件变更都会重置定时器
if (this.buildTimeout) clearTimeout(this.buildTimeout);
this.buildTimeout = setTimeout(() => {
  // 发出所有累计的变更，触发单次重建
}, this.buildDelay);
```

在延迟窗口内，变更会累积在一个 `invalidatedIds` Map 中——文件内去重和跨文件批处理都通过同一个机制完成。Rollup 还应用了一个 `eventsRewrites` 表来进行更智能的合并（create+delete=null，delete+create=update，等等）。

### Rolldown 的做法

`WatcherState::Debouncing` 状态使用 `tokio::select!` 和 deadline 重置来完成同样的事情：

- 文件变更 → `Idle` 变为 `Debouncing { changes, deadline }`
- 更多变更 → deadline 重置，changes 按路径合并并做类型合并
- deadline 触发 → 如果 changes 非空，则传给 `run_build_sequence()`；如果为空（全部被类型合并抵消），则静默返回 Idle

#### 类型合并

类似 Rollup 的 `eventsRewrites` 表，rolldown 会在去抖窗口内同一路径收到多个事件时合并变更类型（`watcher_state.rs` 中的 `merge_change_kind`）：

| 现有   | 新的   | 结果     | 原因                                                          |
| ------ | ------ | -------- | ------------------------------------------------------------------ |
| Create | Update | Create   | 文件仍然是新的——修改不会改变这一点               |
| Create | Delete | _移除_   | 从观察者视角看，该文件从未存在                 |
| Delete | Create | Update   | 文件被重新创建——净效应是一次修改                  |
| _其他_  | _任意_ | 新类型   | 最新类型生效（例如 Update+Update→Update，Update+Delete→Delete） |

这很重要，因为插件会在 `watchChange` 钩子中接收到 `WatcherChangeKind`，并且可能根据文件是“创建”还是“修改”而采取不同行为。

Fs-watcher 层（`notify-debouncer-full`）也可作为需要 OS 级事件去重的用户选项（噪声较多的编辑器、网络驱动器），通过 `watch.watcher` 选项（`usePolling` / `pollInterval`）暴露。两层同时使用会增加延迟并使时序更难推理，因此默认不启用。

### 默认延迟

Rollup 将 `buildDelay` 默认设为 0ms。新的 `rolldown_watcher` 也默认使用 0ms（`DEFAULT_DEBOUNCE_MS`），与 Rollup 保持一致。

## 事件生命周期

### 初始构建

```
Watcher 启动 coordinator
  → run_initial_build()
  → on_event(START)
  → 对每个任务：on_event(BUNDLE_START) → build → on_event(BUNDLE_END or ERROR)
  → on_event(END)
  → 进入事件循环（Idle）
```

### 文件变更 → 重新构建

```
每个任务的 FsWatcher 检测到文件变更
  → TaskFsEventHandler 发送 WatcherMsg::FileChanges
  → process_fs_event():
      - 将 notify 的 EventKind → WatcherChangeKind（Create/Update/Delete）
      - task.invalidate(path) → 设置 needs_rebuild = true
      - task.call_on_invalidate(path) → 立即触发，早于 debounce
      - 状态：Idle → Debouncing，或延长截止时间
  → debounce 定时器触发（tokio::select!）
  → run_build_sequence(changes):
      1. 对每个变更执行 handler.on_change(path, kind)
      2. 对每个 task × 每个 change 执行 task.call_watch_change(path, kind)
      3. handler.on_restart()
      4. handler.on_event(START)
      5. 对每个需要重新构建的 task：
         a. handler.on_event(BUNDLE_START)
         b. task.build():
            - bundler.with_cached_bundle_experimental(FullBuild, |bundle| { ... })
              1. bundle.scan_modules() → 发现模块图
              2. bundle.get_watch_files() → 注册文件系统监听（在 render 之前、在检查 scan 结果错误恢复之前）
              3. bundle.bundle_write() 或 bundle.bundle_generate()（如果 skip_write）
            - update_watch_files() 再次处理 render 阶段产生的任何文件
         c. handler.on_event(BUNDLE_END or ERROR)
      6. handler.on_event(END)
      7. drain_buffered_events() → 处理构建期间到达的事件
```

### 关闭

```
watcher.close() 发送 WatcherMsg::Close（fire-and-forget）
  → 设置 close 标志，并通知任何正在进行的 consumer callback 等待
  → 等待共享的 coordinator future（wait_for_close）
  → handle_close():
      1. 状态 → Closing
      2. 对每个 task 执行 task.call_hook_close_watcher()（插件钩子，await）
      3. 对每个 task 执行 task.close()（bundler 清理）
      4. handler.on_close()（await）
      5. 状态 → Closed
      6. coordinator future 完成 → 所有 wait_for_close() 调用者都 resolve
```

消费者回调通常是阻塞式的，但 coordinator 会将它们与专用的 close 信号一起等待。如果某个 `event`、`change` 或 `restart` 监听器调用并 await `watcher.close()`，close 信号会赢得等待，coordinator 只会放弃其 Rust 侧对该回调的等待。JavaScript 回调及其 promise 会继续运行。随后 coordinator 会执行正常的关闭钩子，关闭所有 bundler，并发出 `close`；只有在这之后，原始的 `watcher.close()` promise 才会 resolve。这打破了自等待循环，同时不削弱已 resolve 的 close promise 的语义。

### 错误恢复

构建错误**不会**停止 watcher。发生错误时，会发出带有错误详情和 `result` 句柄的 `event('ERROR')`。watcher 会继续监听——当用户修复错误并保存后，会触发重新构建。

## 插件钩子

所有与 watch 相关的钩子都是**阻塞式**的——coordinator 会等待它们完成。这与 Rollup 一致。

| 钩子                         | 时机                           | 作用                                                   |
| ---------------------------- | ------------------------------ | ------------------------------------------------------ |
| `watchChange(id, { event })` | debounce 之后、重新构建之前     | 让插件对文件变更做出反应（缓存失效）                   |
| `closeWatcher()`             | watcher 关闭期间               | 让插件清理资源                                         |

watch 模式下的插件上下文新增：

- `this.meta.watchMode` — 以 watch 模式运行时为 `true`
- `this.addWatchFile(id)` — 将文件加入 watch 集合（不在模块图中）

### onInvalidate 回调

通过 `WatcherOptions` 配置，在文件变更时**立即**触发（早于 debounce 完成）。不同于 `watchChange`，它是按事件触发，而不是按构建周期触发。

## 文件监听

- 每次构建后，`bundler.watch_files()` 返回当前集合。
- `WatchTask::update_watch_files()` 与当前集合做 diff——新增文件会被加入到每个任务的 `DynFsWatcher`。
- `include`/`exclude` 模式会过滤哪些文件会被监听（通过 `pattern_filter`）。
- 文件监听是**非递归**的（逐个文件监听）。
- 批量操作：`fs_watcher.paths_mut()` 返回一个用于批量添加的 guard，通过 `.commit()` 提交。

### watch 模式下的分阶段构建

`Bundler::write()` 会原子地执行 scan → render → write。但 watcher 需要在 scan 和 write 之间为发现的文件注册文件系统监听——否则 render hooks 期间所做的更改（例如 `renderStart` 修改某个文件）会被遗漏，因为此时 FS watcher 还没开始监听。

watcher 使用 `Bundler::with_cached_bundle_experimental()` 获取 `&mut Bundle` 访问权限，从而可以手动编排构建阶段：

1. **Scan** — `bundle.scan_modules()` 发现模块图并填充 watch 文件
2. **Watch registration** — `bundle.get_watch_files()` → 在 render hooks 触发之前注册文件系统监听。
   这一步发生在检查 scan 结果之前——因此即使 scan 出错，文件也已经被监听。
   这对错误恢复至关重要：如果用户引入了语法错误，watcher 仍然必须监听那个损坏的文件，这样在保存修复后才能触发重新构建。
3. **Write/Generate** — `bundle_write()` 或 `bundle_generate()`（如果 `skip_write`）

这与旧版 watcher 的做法（`with_cached_bundle`）一致：`watch_files()` 在 scan 和 write 阶段之间被调用。

### 缺失文件恢复

当某个 import 解析到一个不存在的文件时，构建会报错。watch 模式依赖于在每次重新构建前清空 resolver 缓存（`bundler.clear_resolver_cache()`）。预期的恢复流程是：创建缺失文件，然后手动编辑一个已监听的文件（例如对 importer 做一次无操作编辑）以触发重新构建。resolver 会用新缓存重新评估该 import，并成功解析。这与 Rollup 的行为一致——Rollup 只监听已成功加载的模块。

### Notify 事件映射

```
notify::EventKind::Create(_)                              → WatcherChangeKind::Create
notify::EventKind::Modify(Name(RenameMode::To))           → WatcherChangeKind::Create
notify::EventKind::Modify(Name(RenameMode::Both))         → 按路径处理（见下）
notify::EventKind::Modify(Name(RenameMode::From))         → WatcherChangeKind::Delete
notify::EventKind::Remove(_)                              → WatcherChangeKind::Delete
notify::EventKind::Modify(_)  （其他）                     → WatcherChangeKind::Update
notify::EventKind::Access(_)                              → None（忽略——防止 Linux 上的无限重建循环）
```

**重命名处理：** 当 Linux inotify 在一次重命名事件中同时已知源路径和目标路径时，可能会发出 `Modify(Name(Both))`。该事件携带两个路径 `[from, to]`。事件处理器会将其拆分为两个 `FileChangeEvent`：源路径对应 `Delete`，目标路径对应 `Create`。这样可以保留两个信号——delete 确保失效的缓存条目被清除，而 create 会触发缺失目录的重新构建。`RenameMode::To` 和 `RenameMode::From` 是单路径对应形式。

**Access 过滤：** 构建过程会读取已监听的源文件，这在 Linux 上会触发 `IN_OPEN`/`IN_CLOSE_NOWRITE` 事件。如果不做过滤，这些事件会导致无限重建循环。

### 路径身份

watch 集合将路径存储为原始 `ArcStr` 字符串。`notify` crate 报告的事件使用操作系统原生路径。如果它们不能完全匹配，`is_watched_file()` 会静默失败。当前 `#[cfg(windows)]` 的反斜杠回退就是这一问题的表现。

**建议：** 用 `PathBuf` 代替 `ArcStr` 来表示 watched file 集合。这样可以处理尾部斜杠、双分隔符、`.` 片段，以及 Windows 的 `\` 与 `/` 差异——这些都是 resolver 输出与 notify 事件之间常见的不匹配来源。

关于 bundler 中路径身份、`PathBuf` 的比较行为以及 Rollup 的处理方式，请参见 [module-id.md](../module-id/implementation.md) 的完整分析。

## WatcherEventHandler Trait

这是消费者唯一的扩展点。NAPI 用它来桥接到 JS；Rust 消费者则直接实现它。

```rust
pub trait WatcherEventHandler: Send + Sync {
    fn on_event(&self, event: WatchEvent) -> impl Future<Output = ()> + Send;
    fn on_change(&self, path: &str, kind: WatcherChangeKind) -> impl Future<Output = ()> + Send;
    fn on_restart(&self) -> impl Future<Output = ()> + Send;
    fn on_close(&self) -> impl Future<Output = ()> + Send;
}
```

所有方法在正常运行期间都会被 await，以确保与 Rollup 兼容的顺序语义。
`on_event`、`on_change` 和 `on_restart` 的等待都具有 close 感知能力，因此被 await 的监听器可以在不死锁的情况下关闭自己的 watcher。`on_close` 仍然作为关闭序列的一部分被完全 await。

## NAPI 桥接

### 事件处理器

`NapiWatcherEventHandler` 实现了 `WatcherEventHandler`，通过 `ThreadsafeFunction` 将这 4 个 trait 方法全部桥接到一个 JS 回调。每个方法都会把数据包装成一个 `BindingWatcherEvent` 变体，并调用 `listener.await_call()`，它会 await JS Promise。在正常分发期间，coordinator 因此会阻塞，直到 JS 处理器完成；如果 close 信号获胜，具备 close 感知的分发包装器就只会放弃这个 Rust 侧的等待，如上所述。

```rust
struct NapiWatcherEventHandler {
    listener: Arc<MaybeAsyncJsCallback<FnArgs<(BindingWatcherEvent,)>>>,
}

impl WatcherEventHandler for NapiWatcherEventHandler {
    async fn on_event(&self, event: WatchEvent) {
        let binding_event = BindingWatcherEvent::from_watch_event(event);
        self.listener.await_call(FnArgs { data: (binding_event,) }).await;
    }
    // on_change（from_change）、on_restart、on_close 也采用相同模式
}
```

`BindingWatcherEvent` 将一个内部枚举（`BundleEvent | Change | Restart | Close`）包装起来，并提供 NAPI 暴露的访问器方法（`eventKind()`、`bundleEventKind()`、`bundleEndData()` 等）供 JS 使用。

### 事件循环保持存活

`ThreadsafeFunction` 使用 `Weak = true`（unref'd），因此不会阻止 Node.js 退出。`Watcher::wait_for_close()` 返回一个 `Shared<Future>`，在 coordinator 完成时 resolve——这是幂等的，因此多个调用者（或完成后的晚到调用者）都会立即 resolve。NAPI 绑定将其暴露为 `waitForClose()`——挂起的 JS Promise 会保持事件循环存活。这取代了旧的 `setInterval(() => {}, 1e9)` 技巧。

```
constructor(options, listener)  // 创建带有 handler 的 Watcher，准备运行
run()   → inner.run()           // 启动 coordinator（非阻塞）
        → inner.waitForClose()  // 挂起的 Promise 保持 Node 存活
close() → inner.close()         // 发送 Close 消息，等待共享 future
                                // waitForClose() resolve，事件循环可自由退出
```

### 作为轻量包装器的 Binding

`BindingWatcher` 被刻意设计为轻量包装器——它持有一个 `rolldown_watcher::Watcher` 并直接委托调用。没有状态机，没有锁，除了类型转换外没有额外逻辑。所有生命周期管理都在 Rust 核心中完成。构造函数同时接收 `options` 和 `listener`，创建 `NapiWatcherEventHandler`，并将其传给 `Watcher::new()`。每个 NAPI 方法（`run`、`waitForClose`、`close`）都直接委托给内部 watcher。

### 事件发射器

`WatcherEmitter` 使用一个简单的 `Map<string, Function[]>` 来存储监听器（on/off）。异步 `emit()` 会按顺序分发处理器（`for...of` + `await`），因此前面处理器的副作用（例如 `result.close()` 触发 `closeBundle`）对后面的处理器可见。无需外部依赖。

### 事件映射

位于 `watcher.ts`（`createEventCallback()`——一个独立函数），而不在 emitter 中。该回调在 `BindingWatcher` 构造函数之前创建，并与 options 一起传给它。它将 `BindingWatcherEvent` 映射为与 Rollup 兼容的事件对象。错误事件携带来自 Rust 的结构化 `Vec<BuildDiagnostic>` 数据；binding 会保留这些诊断信息，而 JS 层会在将其暴露为 Rollup 风格的事件对象之前，通过 `aggregateBindingErrorsIntoJsError()` 将其转换。

### 端到端流程

```
WatchCoordinator.run_build_sequence()
  → dispatch_event(WatchEvent::BundleEnd(data))
    → await_handler_or_close(handler.on_event(...))
      ├── callback 分支：
      │     → NapiWatcherEventHandler.on_event()
      │       → BindingWatcherEvent::from_watch_event(event)
      │       → listener.await_call(binding_event).await → ThreadsafeFunction 调用 JS
      │     → JS: createEventCallback() 接收 BindingWatcherEvent
      │       → 映射为 RolldownWatcherEvent { code: 'BUNDLE_END', ... }
      │       → emitter.emit('event', mapped_event) → 顺序 for...of await
      │     → await_call resolve → coordinator 继续
      └── close 分支：
            → close_notify resolve → dispatch 返回 close requested
            → coordinator 运行 handle_close() 并完成关闭序列
```

## 配置

```typescript
interface WatcherOptions {
  skipWrite?: boolean; // 跳过 bundle.write()。默认值：false
  buildDelay?: number; // 防抖延迟，单位毫秒。默认值：0
  watcher?: {
    usePolling?: boolean; // 使用轮询后端。默认值：false
    pollInterval?: number; // 轮询间隔，单位毫秒。默认值：100
  };
  notify?: { ... }; // 已弃用 — 改用 `watcher`
  include?: StringOrRegExp | StringOrRegExp[];
  exclude?: StringOrRegExp | StringOrRegExp[];
  onInvalidate?: (id: string) => void;
  clearScreen?: boolean; // 重建时清屏。默认值：true
}
```

监视模式下设置的环境变量：

```
ROLLUP_WATCH=true    // Rollup 兼容
ROLLDOWN_WATCH=true  // Rolldown 特有
```

## 迁移状态

跟踪旧 watcher → 新 `rolldown_watcher` 的进度。各项链接到 [#6482](https://github.com/rolldown/rolldown/issues/6482) 及相关 issue。

### NAPI + TypeScript 桥接

- [ ] 将初始化错误（例如 `options` hook）暴露为 `ERROR` 事件，而不是未处理的拒绝（[ #6482 ](https://github.com/rolldown/rolldown/issues/6482)）

### 清理

- [ ] 移除 `reset_closed_for_watch_mode()` 这个临时方案 — 见 [rust-bundler.md](../rust-bundler/implementation.md) 中替代它的 `Bundle.close()` 设计
- [ ] 将 `WatcherChangeKind` 重命名为 `FileChangeEventKind`（类型仍保留在 `rolldown_common` 中）
- [ ] 使用新 watcher 的 CLI `--watch` 模式可正常工作（[#7759](https://github.com/rolldown/rolldown/issues/7759)）

### 缺失功能

- [x] 重建之间的解析器缓存失效（[#6482](https://github.com/rolldown/rolldown/issues/6482)）— 在每次重建开始时调用了 `clear_resolver_cache()`
- [ ] 文件取消监听 — `update_watch_files()` 只会添加，不会移除。监听集合会单调增长

### 未来

- [ ] 非阻塞构建 — 不是在当前流程中 `await`，而是启动构建（见未解决问题）
- [ ] 增量构建 — `WatchTask::build()` 当前通过 `bundler.write()` 执行完整重建
- [ ] 单个协调器内的并行任务构建
- [ ] 批量变更阈值优化 — 对于批量变更（例如 `git checkout` 产生 1000+ 个文件事件），我们可以跳过逐文件的 `on_change`/`watchChange` 钩子，直接执行一次完整重建。Rollup 不会这样做 — 它总是无论事件量多少都调用逐文件钩子。如果逐文件钩子的开销成为性能问题，这将是一个潜在的未来优化方向。

## 相关

- [design.md](./design.md) — 监视模式的设计原则和未解决问题
- [rust-bundler](../rust-bundler/implementation.md) — 核心 Bundler 结构体和 `Bundle.close()` 设计
- [rust-classic-bundler](../rust-classic-bundler/implementation.md) — Rollup API 兼容性封装
- [module-id](../module-id/implementation.md) — 模块 ID、路径标识和规范化
- [#6482](https://github.com/rolldown/rolldown/issues/6482) — 监视模式问题集合（跟踪所有已知 bug）
- `crates/rolldown_watcher/` — 实现
- `crates/rolldown_fs_watcher/` — 基于 `notify` 的文件系统监视抽象
- `crates/rolldown_dev/` — 开发模式，采用相同的 actor 模式作为参考
- `packages/rolldown/src/api/watch/` — TypeScript API 层
