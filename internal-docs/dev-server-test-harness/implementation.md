# Dev Server 测试运行器

## 概要

`@rolldown/test-dev-server` 浏览器套件使用一个真实的 Chromium 页面针对
rolldown 开发引擎（HMR、懒加载编译、错误覆盖层）进行驱动。该服务器是
**Vite 的完整 bundle 模式**（`experimental.bundledDev`），在运行时从
Vite 检出目录中的 `vite/` 加载（仓库根目录下的一个 gitignore 的 vitejs/vite
`rolldown-canary` 克隆，并 rebased 到 `main`），其 `rolldown`
解析链接到工作区的 `packages/rolldown` —— 测试框架只是在其上层增加
测试埋点（见 [The Vite backend](#the-vite-backend)）。它是**进程内**运行的：每个 spec 文件都会在自己的 vitest worker 中于一个由操作系统分配的端口启动开发服务器，连接到同一个共享 Chromium，并通过服务器自身的 `close()` 将其关闭。Playground 的发现是根据每个 spec 自己的路径推导出来的，因此没有中心注册表——**新增一个测试只需要一个文件夹加一个 spec，不需要改任何中心配置**。配套的 node **fixtures** 套件（一个构建到磁盘的自定义开发服务器，该产物作为子进程运行——Vite 的 bundled dev 仅适用于 client 环境，因此该平台不能在其上运行）共享状态辅助工具，但除此之外是独立的。

## 原则

### 进程内、自动端口、按 spec 路径发现

dev server 在测试 worker 中以进程内方式运行，绑定端口 0，测试再把解析后的 URL 读回来——从不手动指定端口。发现依据是 spec
文件自身的路径：`vitest.config.e2e.mts` 会匹配 `playground/**/*.spec.[tj]s`，playground 名称会从每个 spec 路径中用正则提取出来，global setup 只会把被选中的 playground 复制到 `playground-temp/` 中。**新增一个测试就是一个文件夹 + 一个 spec——无需中心修改。**

### 先监听，再构建

HMR 运行时需要提前知道 websocket 端口。在 **node**
平台上，server 会**先**绑定 socket，读取已绑定的端口，把它注入到 `experimental.devMode.port`，然后再构建。在 **browser** 平台上，Vite
会自行管理客户端的 websocket 地址；harness 只是在 `createServer` 之前预留一个由 OS 分配的端口，因为 Vite 会把 `port: 0` 视为“使用默认端口”，而不是“让 OS 选择”（参见 `src/vite-server.ts` 中的 `getFreePort`）。

### 一个 playground 对应一个 server-config

只有当 server 配置必须不同的时候，才会新增一个顶层 playground
（插件、平台、lazy 模式，等等）——绝不会因为场景数量增加。能共享配置的场景，共享同一个 playground。在一个 playground 内，有两种方式承载多个场景：

- **Co-tenant** (one page): 根目录的 `index.html` + entry 静态导入每个
  场景的模块；每个场景拥有**互不重叠的 DOM 节点 + 文件**，因此一个场景不会干扰另一个场景的断言。（Vite 的 `hmr`; rolldown 的
  `lazy-compilation`。）
- **Sub-page** (one page per scenario): 一个带有自己 `index.html` 的子文件夹，通过同一 server 上的 URL 访问。Vite 的 html pipeline 可以从一个根目录提供多个 HTML entry，但现有的每个 playground 都使用 co-tenant，因此为了保持一致性应优先使用它。

**lazy 的冷启动与同租户模式兼容。** 一个 lazy chunk 只有在它自己的动态 import 触发时才会被编译，因此把多个 lazy 场景打包进同一个项目，永远不会让另一个场景的 chunk 预热。每个 spec 都会启动自己按文件独立的（全新）server，并且只触发自己的场景，因此首次请求和专用 server 一样冷。互不重叠的 lazy chunks + DOM 节点就足以完成隔离。

### Serve 模式阶梯

大多数 playground 走默认路径；只有在有特定需求时才升级：

| 需求                                   | 机制                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 正常浏览器 dev-server 行为     | 默认：harness 在 `beforeAll` 中启动 server 并导航                                                         |
| 冷的首次请求（无预导航） | `__tests__/serve.ts` 返回 `ctx.createServer()`，**不**进行导航；spec 自己发起 `page.goto` |
| 文件中途需要一个全新的 server               | spec 每个测试都自己创建/关闭 server（Vite 的 `client-reload` 模式）                             |

### 在共享页面上保证重载安全

同一个文件中的测试共享一个 `page`，并按顺序运行；一次重载会影响它之后的所有内容。安全性依赖约定，而非隔离：

- 场景拥有**互不重叠的文件 + DOM 节点**。
- **编辑只允许向前推进**（或者撤销它们的改动）——绝不要假设重载后文件仍然是初始状态。
- 在任何重载之后都要**重新获取 element handle**；重载会使它们失效。
- 对破坏性状态的升级阶梯：共享页面 → 自己的子页面 → 自己的页面（`browser.newPage()`）→ 自己的 server。

### 同步，绝不睡眠

两种机制：(1) `/_dev/status` 轮询——`waitForBuildStable`、`buildSeq`、
`moduleRegistrationSeq`——再加上对 DOM 文本使用 `expect.poll`。(2) 对没有 DOM 信号的内容使用 Browser 日志门控
（`untilBrowserLogAfter`）（重连、完全重载）。只有纯字符串的 console 参数才能匹配（对象参数显示的是预览，而不是 JSON）。

Browser specs 断言的是 **Vite 自身的信号**：

| 信号        | 位置                        | 标记                                              |
| ------------- | ---------------------------- | --------------------------------------------------- |
| WS connected  | browser log                  | `[vite] connected.`                                 |
| Patch applied | browser log                  | `[vite] hot updated: …`                             |
| Build error   | server log                   | `✘ Build error: …`                                  |
| HMR / reload  | server log                   | `hmr update …`, `hmr invalidate …`, `page reload`   |
| Error overlay | DOM (`<vite-error-overlay>`) | `errorOverlay()` / `errorOverlayText()` in `~utils` |

overlay 渲染在一个 **shadow root** 中，因此对宿主元素调用 `locator(...).textContent()` 不会返回任何内容——一定要通过 `~utils` 辅助函数。node fixtures 则改为断言 rolldown runtime 的 `[hmr]: …` 标记。

## 实现（当前构建）

### Vite 后端

浏览器平台采用 Vite 的完整 bundle 模式；harness 不负责任何
服务工作。harness 负责的部分位于 `src/vite-server.ts`：

- **配置转换。** `dev.config.mjs` → Vite 内联配置：
  `experimental.bundledDev: true`，将 playground 复制目录作为 `root`（其
  `index.html` 的 module script 作为入口），fixture 插件原样传入
  （Vite 8 原生运行 rolldown），`assetsInlineLimit: 0` 用于 asset-request
  断言，`treeshake` 透传。完整 bundle 模式会强制
  `devMode.lazy: true`，因此浏览器运行中始终启用惰性编译。
- **`vite` 不是 package 依赖。** 它通过文件 URL 从 checkout 中已构建的 dist
  动态导入（`loadVite()`），并为 harness 触及的那一小段 API 提供本地结构化类型。
  仅面向 Node 平台的 fixture 和从不运行浏览器测试的 CI 作业不依赖 checkout；
  若 dist 缺失，则会以“运行 `just setup-vite`”的提示失败。
- **测试埋点**（`createHarnessPlugin`）：`/_dev/status` 中间件；
  `buildSeq` 统计 `buildStart` 以及广播的 `update`/`full-reload`
  载荷，而**不**统计 `error` 载荷（服务器会将缓存的错误回放给每个新客户端，
  而保守重建的规格会断言：在损坏的构建上刷新不会推动 `buildSeq`）；
  `moduleRegistrationSeq` 统计 `vite:module-loaded` 事件；
  bundle 状态直接从 `bundledDev.devEngine.getBundleState()` 读取。
- **上游缺口的 workaround**，代码中都以 `WORKAROUND` 注释标出，等 Vite 修复后即可删除：
  - _恢复性重载_：上游只有在 HMR 已经挂起了 reload 的情况下，成功构建后才会进行 full-reload，因此处于错误覆盖层或回退页上的客户端永远不会得知“出错 → 成功”的构建已经完成。插件会观察广播的 `error` 载荷，并在下一次成功的 `generateBundle` 时清除缓存错误，然后在 `ensureLatestBuildOutput()` 之后执行 reload。
  - _旧错误回放保护_：上游只会在 `onOutput` 中清除 `lastBuildError`，而客户端在首次更新遇到已有覆盖层时会硬重载——这样重连会收到旧错误回放。一个 `vite:client:connect` 监听器（注册在 Vite 自己的回放监听器之前）会在跟踪到的构建状态健康时丢弃该旧错误。

**checkout 保持未打补丁。** rolldown 侧不修改任何 Vite 源码。修复和测试调整应提交到 vitejs/vite 的 `rolldown-canary` 分支，
本 harness 和 `packages/vite-tests` 都跟踪该分支。所有环境相关内容都放在未跟踪文件中，通过
`scripts/src/setup-vite/` 脚本完成（`just setup-vite`，幂等，仅 `vp` 可用）。它是唯一会接触 `vite/` 的入口：移动 commit 的命令会紧接着重建所有内容，因此 checkout 与已构建 dist 永远不会脱节。步骤如下：

1. 确保 `vite/` 处于最新的、基于 `main` rebase 的 `rolldown-canary`
  （若缺失则 clone，若已存在则更新）；若 checkout 被开发者接管（dirty，或不在 `rolldown-canary` 上），则按原样构建，
2. `vp install --frozen-lockfile`（vp 会委托给 checkout 中固定版本的 pnpm；这也会重置上一步的 step-4 swap，因此构建始终使用 Vite 自己固定的 rolldown），
3. 通过 `packages/vite` 自己的 `build` 脚本构建它（`vp run build`），
4. 将 `vite/packages/vite/node_modules/rolldown` 替换为指向 workspace 的 `packages/rolldown` 的符号链接，使 Vite 的 dist 在运行时解析到本地绑定。checkout 内的任何 install 都会重置这一点，因此在此类 install 之后需要重新运行脚本。

仓库范围的工具会忽略 `vite/**`（`.gitignore`
条目覆盖尊重 gitignore 的遍历器，如 oxfmt，另有 `.typos.toml` 和
`.ls-lint.json` 中的条目）——仓库范围的 `vp fmt --write` 绝不能触碰 `vite/` 内的文件。CI 上，dev-server 工作流和 vite-tests 作业都会通过 setup-vite 步骤准备 checkout（先运行 `run.ts`，然后在本地 clone 以运行 Vite 自己的测试套件）；其他所有作业都不需要 Vite checkout。

### 服务器入口点（`src/`）

- `createDevServer(config, opts?) → { url, port, close }`（`src/dev-server.ts`，并与 `loadDevConfig(dir)` 以及一个 `Logger` 类型一起从 `src/index.ts` 导出）会根据 `build.platform` 分发：`browser` → 上面的 Vite 后端，其他任意值 → node transport（`DevServer` +
  `FullBundleDevEnvironment`）。两条路径上，返回一个已解析的 promise 都表示初始构建（或其错误）已经稳定：Vite 的 `listen()` 会启动构建但不会等待它，因此 browser 路径会轮询 `BundledDev` 在其自身 `waitForInitialBuildFinish()`（它会轮询 `memoryFiles`）稳定后设置的 `initialBuildCompleted` 标志，并且那次性的 ready reload 已经广播；仅靠 `ensureCurrentBuildFinish()` 可能会在构建开始之前，或在 `onOutput` 还未存储文件之前就解析；node 路径则为同样的延迟等待第一个输出锁存器（`waitForFirstOutput`）。
- **`close()`。** 浏览器端：Vite 的 `server.close()` 会级联进入 `bundledDev.close()` → `devEngine.close()`。Node 端：停止 ws server，终止客户端，`closeAllConnections()`，`httpServer.close()`，`env.close()`。两者都会释放 watcher/tokio 线程，因此 vitest fork 可以退出，并且第一个引擎关闭后，同一进程中还能启动第二个引擎——由 `dev-engine-close.test.ts` + `dev-engine-close-child.mjs` 覆盖。
- `serve()`（CLI/fixtures 路径）会加载 cwd 配置并以相同方式分发；stdin 的 `'r'` 重建触发器只在 node 路径上接线。
- **可注入的 `Logger`。** node transport 直接通过它记录日志；browser 路径会将其适配为 Vite 的 `customLogger`（`toViteLogger`）。harness 传入一个内存 logger，因此服务端输出会落到 `serverLogs`。
- `DEV_SERVER_PORT` **不会**被 `createDevServer` 读取（它绑定的是 `opts.port ?? 0`）；它仍然作为 fixtures/CLI 通道，由 `serve()` 消费。

### Harness 布局（`tests/`）

```
tests/
  vitest.config.e2e.mts            # 发现：包含 playground/**/*.spec.ts；~utils 别名；setup/globalSetup
  vitest.config.fixtures.mts       # node fixtures + dev-engine-close 冒烟测试
  fixtures.test.ts                 # 重新按 URL 组织的 status helpers
  dev-engine-close.test.ts         # close 路径 + 进程内重启冒烟测试
  src/
    dev-status.ts                  # 以 URL 为键的 /_dev/status helpers（fixtures + browser 共用）
    dev-engine-close-child.mjs     # 纯 node 子进程，证明引擎会释放进程
    utils.ts                       # fixtures 目录 helpers
  playground/
    vitest-global-setup.ts         # 一个 chromium.launchServer()；选择性复制 → playground-temp/
    vitest-setup.ts                # 按文件：推导 testName/testDir，连接 browser，启动 server 或运行 serve.ts
    test-utils.ts                  # `~utils` 接口（重导出 + editFile + untilBrowserLogAfter + status helpers）
    <name>/                        # 一个扁平 playground：一个 server config，一个页面
      __tests__/<name>.spec.ts     # spec（保留在源码中，绝不复制）
      __tests__/serve.ts           # 可选逃生口（冷启动）
      dev.config.mjs               # 无 dev.port
      package.json  index.html  …  # 夹具（复制到 playground-temp/<name>/）
    lazy-compilation/              # 一个同租户 playground：一个配置，多个场景
      __tests__/
        serve.ts                   # 供所有场景 spec 共享的唯一冷启动 serve
        basic.spec.ts  aliased-import.spec.ts  shared-module.spec.ts  nested-dynamic-import.spec.ts
      dev.config.mjs  index.html  main.js   # 一个并集配置；main.js import 每个场景
      <scenario>/setup.js  …                # 每个场景一个子目录（源码 + lazy modules）
      package.json
```

值得注意的点：

- **文件名使用 kebab-case**（`vitest-setup.ts`、`vitest-global-setup.ts`）——
  仓库的 `ls-lint` 会强制执行。`__tests__/` 保留下来（它是 temp-copy 的过滤边界，能把 specs + `serve.ts` 排除在被服务的夹具之外），通过 `.ls-lint.json` 的 ignore 实现。
- **状态 helpers 位于 `tests/src/dev-status.ts`**（以 URL 为键、无 hook）因此 node 端的 `fixtures.test.ts` 也会导入它们；`test-utils.ts` 会重导出薄包装，默认把 URL 设为当前 spec 的 `serverUrl`。
- **`testDir` 是临时拷贝；`testPath` 是源 spec。** `serve.ts` 会在源 spec 附近解析（`dirname(testPath)`），因为 `__tests__/` 不会被复制。
- **`build.cwd = testDir` 注入。** 进程内 worker 的 cwd 是 tests 目录，因此 harness 在加载配置时会把 `cwd` 固定到 playground 拷贝上——否则相对的 `input` 路径以及插件对 `index.html` 的查找会解析到错误目录。
- global-setup 复制会**排除 `node_modules`**：来自 `playground-temp/<name>/` 的裸 import 会通过向上查找解析到 `tests/node_modules`
  （与深度无关），因此无需复制 pnpm 的符号链接森林。

### `serve.ts` 契约

一个 playground 可选的 `__tests__/serve.ts` 导出
`serve(ctx) → Promise<DevServerHandle>`。`ctx` 携带 `{ testName, testDir,
page, createServer }`，其中 `createServer()` 会加载 playground 配置并启动进程内 server（已接好 logger + cwd）。`lazy-compilation`
playground 的四个场景 spec 共用同一个 `serve.ts`，其主体为
`return ctx.createServer()` —— 它会创建 server 但跳过导航，因此每个
spec 都会自己触发冷首次 `page.goto(serverUrl)`。默认路径（HMR）
没有 `serve.ts`：harness 会启动 server 并进行导航。

### 惰性编译：一个项目，多个场景

lazy-compilation 的回归测试最初是四个同级 playground，每个都有自己的服务器配置。现在它们合并为一个 playground，只有**一个**
`dev.config.mjs` 和一个页面：`main.js` 从每个场景子文件夹（`basic/`、`aliased-import/`、
`shared-module/`、`nested-dynamic-import/`）静态导入一个 `setup.js`，每个场景拥有互不重叠的 DOM 节点
（`#<scenario>-btn` / `-status` / `-log`），并且在 `__tests__/` 中每个场景对应一个 spec 文件。之所以可行，是因为编译是 lazy 的（见上面的同租户原则）：每个 spec 启动自己的逐文件 server，并且只点击自己的按钮，从而获得该场景全新的首次请求——和专用 server 提供的一样冷。单一配置是各场景需求的并集：当前仅 `viteAliasPlugin`（仅 aliased-import 需要；其他场景中无影响）。

### Knip / workspace

Playground 通过 `pnpm-workspace.yaml` 中的
`packages/test-dev-server/tests/playground/*` glob 成为 pnpm workspace 成员。合并后的 `lazy-compilation` playground 也包含在内；它的单个
`knip.jsonc` 条目会匹配嵌套的场景源码（`*/*.js`）以及 specs 和 `serve.ts`。`test-utils.ts` + `dev-engine-close-child.mjs`（通过 `~utils` 别名和 execa 路径字符串引用，knip 无法追踪）是 `tests` workspace 中的条目。

## 待跟进事项

- **将这两个 Vite bundled-dev 修复上游化。** 恢复重载和
  过期错误重放（见 [The Vite backend](#the-vite-backend)）是真实存在的上游缺口；一旦这些修复合并到 vitejs/vite `rolldown-canary`，请删除
  `src/vite-server.ts` 中的 `WORKAROUND` 块。
- **重载后的客户端重连门控。** 添加
  `untilBrowserLogAfter(() => page.reload(), [/\[vite\] connected\./])`，这样在重载后触发的编辑就不会因为尚未重新连接的 websocket 而丢失——
  这个标记已经存在，无需运行时改动。

## 相关

- [dev-engine](../dev-engine/implementation.md) — 这个 harness 所驱动的引擎
  （其原则见 [design.md](../dev-engine/design.md)）。
- [lazy-compilation](../lazy-compilation/implementation.md), [watch-mode](../watch-mode/implementation.md)。
