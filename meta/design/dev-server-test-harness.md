# Dev Server 测试运行器

## 概要

`@rolldown/test-dev-server` 浏览器套件会驱动一个真实的 Chromium 页面来对接
rolldown dev 引擎（HMR、惰性编译、错误覆盖层）。它以**进程内**方式运行：每个规格文件都会在各自的 vitest worker
中启动 dev server，使用由操作系统分配的端口，连接到同一个共享 Chromium，并通过
服务器自身的 `close()` 进行清理。Playground 的发现来源于每个规格自己的路径，
因此没有中心注册表——**新增一个测试只需要一个文件夹加一个 spec，完全无需修改中心配置**。配套的 node **fixtures** 套件（dev server
构建到磁盘、产物作为子进程运行）是独立的，不在此范围内。当前 CI 状态：`fileParallelism: false` 且开启 `retry`——二者都是有意为之（见 [后续待办](#open-follow-ups)）。

## 原则

### 进程内、自动端口、按 spec 路径发现

dev server 在测试 worker 中以进程内方式运行，绑定端口 0，测试再把解析后的 URL 读回来——从不手动指定端口。发现依据是 spec
文件自身的路径：`vitest.config.e2e.mts` 会匹配 `playground/**/*.spec.[tj]s`，playground 名称会从每个 spec 路径中用正则提取出来，global setup 只会把被选中的 playground 复制到 `playground-temp/` 中。**新增一个测试就是一个文件夹 + 一个 spec——无需中心修改。**

### 先监听，再构建

HMR 运行时需要在构建时把 websocket 端口写进 bundle，所以 server 会**先**绑定 socket，读取已绑定的端口，把它注入到
`experimental.devMode.port`，然后再构建。正因如此，自动端口才能工作而无需触碰共享运行时（使用相对 ws 的客户端才是“正确”的修复，但不在此范围内）。

### 一个 playground 对应一个 server-config

只有当 server 配置必须不同的时候，才会新增一个顶层 playground
（插件、平台、lazy 模式，等等）——绝不会因为场景数量增加。能共享配置的场景，共享同一个 playground。在一个 playground 内，有两种方式承载多个场景：

- **同租户**（一个页面）：根目录 `index.html` + entry 会静态 import 每个场景的模块；每个场景拥有**互不重叠的 DOM 节点 + 文件**，因此一个场景不会干扰另一个场景的断言。（Vite 的 `hmr`；rolldown 的 `lazy-compilation`。）
- **子页面**（每个场景一个页面）：一个带自己 `index.html` 的子目录，通过同一服务器上的 URL 访问。这要求 dev server 能从一个根目录提供多个 HTML 入口——而 test-dev-server 目前**不**会这么做（它只会从 cwd 输出一个 `index.html`），所以 rolldown 只使用同租户模式。

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

有两种机制。(1) `/_dev/status` 轮询——`waitForBuildStable`、`buildSeq`、`moduleRegistrationSeq`——以及对 DOM 文本使用 `expect.poll`。(2) 通过浏览器日志门控（`untilBrowserLogAfter`）来处理没有 DOM 信号的事件（重连、完整重载）。运行时的标记通过 `console.debug` 发出，Playwright 会捕获：

| 事件          | 标记                                        | 级别   |
| -------------- | --------------------------------------------- | ----- |
| Runtime 已加载 | `HMR runtime loaded <addr>`                   | debug |
| WS 已连接   | `[hmr]: Connection established with server`   | debug |
| 收到 patch | `[hmr]: Loading HMR patch: <path>`            | debug |
| 完整重载   | `[hmr]: Full reload required, reloading page` | log   |

只有纯字符串标记才能匹配（对象参数会以预览形式渲染，而不是 JSON）。test-dev-server 还通过注入的 overlay 客户端增加了自己的 `[test-dev-server] hot updated: …`、`error overlay shown: …` 和 `build ok` 标记，用于 apply 后 / overlay 断言。

## 实现（当前构建）

### 服务端入口点（`src/`）

- `createDevServer(config, opts?) → { url, port, close }`（`src/dev-server.ts`，并与 `loadDevConfig(dir)` 和 `Logger` 类型一起从 `src/index.ts` 导出）。它绑定 `opts.port ?? 0`，执行初始构建，并在输出开始被服务后解析完成。
- **`close()`** 的组合动作：停止 ws server、终止客户端、`closeAllConnections()`、`httpServer.close()`、`env.close()`。`DevServer` 是一个接收配置的类；`serve()`（CLI/fixtures 路径）会加载 cwd 配置并委托给它，而且是唯一会连接 stdin `'r'` 重建触发器的路径。`close()` 会释放 watcher/tokio 线程，因此 vitest fork 可以退出，并且第一个引擎关闭后，同一进程里还能启动第二个引擎——由 `dev-engine-close.test.ts` + `dev-engine-close-child.mjs` 覆盖。
- **`waitForFirstOutput`。** `env.run()` 会在引擎稳定后 resolve，但填充 `memoryFiles` 的 JS `onOutput` 回调可能会晚一个 tick；`createDevServer` 会等待一个首输出闩锁，因此一旦启动 resolved，就表示第一个 bundle（或其错误）确实已经在服务中——导航不会落到 spinner 上。
- **可注入的 `Logger`。** `DevServer` / `FullBundleDevEnvironment` / dev-server 插件 / lazy middleware / `Clients` 都通过一个 `Logger`（默认是 `console`）记录日志；harness 会传入一个内存 logger，使服务端输出落到 `serverLogs` 中。
- `DEV_SERVER_PORT` **不会**被 `createDevServer` 读取（它绑定的是 `opts.port ?? 0`）；它仍然是 `serve()` 使用的 fixtures/CLI 通道。

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
      __tests__/serve.ts           # 可选逃生口（cold-start）
      dev.config.mjs               # 无 dev.port
      package.json  index.html  …  # fixture（复制到 playground-temp/<name>/）
    lazy-compilation/              # 一个同租户 playground：一个配置，多个场景
      __tests__/
        serve.ts                   # 供所有场景 spec 共享的唯一 cold-start serve
        basic.spec.ts  aliased-import.spec.ts  shared-module.spec.ts  nested-dynamic-import.spec.ts
      dev.config.mjs  index.html  main.js   # 一个并集配置；main.js import 每个场景
      <scenario>/setup.js  …                # 每个场景一个子目录（源码 + lazy modules）
      package.json
```

值得注意的点：

- **文件名使用 kebab-case**（`vitest-setup.ts`、`vitest-global-setup.ts`）——
  仓库的 `ls-lint` 会强制执行。`__tests__/` 保留下来（它是 temp-copy 的过滤边界，能把 specs + `serve.ts` 排除在被服务的 fixture 之外），通过 `.ls-lint.json` 的 ignore 实现。
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
spec 都会自己触发 cold first `page.goto(serverUrl)`。默认路径（HMR）
没有 `serve.ts`：harness 会启动 server 并进行导航。

### 惰性编译：一个项目，多个场景

最初，lazy-compilation 的回归测试是四个相邻的 playground，每个都有自己的 server 配置。现在它们合并成了一个 playground，拥有**一个**
`dev.config.mjs` 和一个页面：`main.js` 从每个场景子目录（`basic/`、`aliased-import/`、
`shared-module/`、
`nested-dynamic-import/`）静态 import 一个 `setup.js`，每个场景拥有互不重叠的 DOM 节点
（`#<scenario>-btn` / `-status` / `-log`），并且在 `__tests__/` 中每个场景都有一个 spec 文件。之所以可行，是因为编译是惰性的（见上面的同租户原则）：每个 spec 都启动自己按文件独立的 server，并且只点击自己的按钮，因此拿到的是该场景全新的首次请求——这与过去四个独立 server 提供的一致。单一配置是各场景需求的并集：`viteAliasPlugin`（aliased-import；其他场景下无影响）、`strictExecutionOrder`，以及 `incrementalBuild`（shared-module、nested）。

### Knip / workspace

Playground 通过 `pnpm-workspace.yaml` 中的
`packages/test-dev-server/tests/playground/*` glob 成为 pnpm workspace 成员。合并后的 `lazy-compilation` playground 就是其中之一；它的单个
`knip.jsonc` 条目会匹配嵌套的场景源码（`*/*.js`）以及 specs 和 `serve.ts`。`test-utils.ts` + `dev-engine-close-child.mjs`（通过 `~utils` 别名和 execa 路径字符串引用，knip 无法追踪）是 `tests` workspace 中的条目。

## 待跟进事项

- **解除单个规范文件 / `fileParallelism: false` 的限制。** 进程内
  已移除了导致 Windows `forks` 不稳定的孤儿子服务器，因此
  多个规范文件应该是安全的——但在多个 worker 之间并发运行许多 `FullBundleDevEnvironment`
  构建尚未在大规模场景下经过测试。在 Windows CI 分支上试验并行性；只有在通过时才保留。
- **淘汰重试这根拐杖。** 一旦并行性得到验证，就移除 `retry` 以及任何
  重试重置用的 `beforeEach`；剩下的不稳定问题要么是真实 bug，要么是缺少等待。
- **重载后客户端重连门控。** 添加
  `untilBrowserLogAfter(() => page.reload(), [/Connection established/])`，这样
  在重载后触发的编辑就不会因为 websocket 尚未重新连接而丢失——
  标记已经存在，无需运行时更改。

## 相关

- [dev-engine](./dev-engine.md) — 该 harness 所测试的引擎。
- [lazy-compilation](./lazy-compilation.md), [watch-mode](./watch-mode.md)。
