# Perf Kit

`@rolldown/perf-kit` 可帮助代码代理加快应用启动。它可以测量浏览器中的页面、Node.js 或 Deno 服务器，以及 Cloudflare Worker。代理修改代码后，perf-kit 会显示哪些改动值得保留。

::: warning 实验性
perf-kit 目前处于实验阶段，其命令和输出在后续版本中可能会变化。最低要求的 Rolldown 版本为 1.3.0。
:::

## 为什么选择 perf-kit

代码代理可以通过修改代码来提升速度，但会遇到三个问题：

- 单次构建无法证明性能有所提升，因为每次测量都存在噪声。
- 页面损坏后测得的速度可能更快。例如，改动隐藏了主视觉区域，LCP 就会测量开销更低的绘制。
- 代理可能过早停止。一个工具没有发现问题，并不代表其他信号也没有问题。

perf-kit 为代理提供固定基线、渲染结果检查，以及所有待处理线索的汇总列表。代理决定修改什么，数据决定哪些改动可以保留。

## 准备工作

你需要：

- Node.js 22 或更高版本。
- 已构建的应用。perf-kit 不负责构建应用。
- 测量页面时：机器上需要安装 Chrome 或 Edge。可通过 `CHROME_PATH` 指定浏览器。
- 测量 Worker 时：应用需要将 `@cloudflare/vite-plugin` 和 `wrangler` 作为开发依赖。覆盖率功能需要 Wrangler 4.108.0 或更高版本。

perf-kit 没有依赖项，因此无需安装即可运行：

::: code-group

```sh [vp]
$ vp dlx @rolldown/perf-kit help
```

```sh [npm]
$ npx @rolldown/perf-kit help
```

:::

如果要将它添加到项目中，请运行 `vp add -D @rolldown/perf-kit` 或 `npm i -D @rolldown/perf-kit`。之后可通过 `vp exec perf-kit` 或 `npx perf-kit` 运行命令。perf-kit 会将状态保存在运行命令的目录下的 `.perf-kit/` 中，并在那里写入 `.gitignore`，避免将状态文件提交到 Git。

<a id="configure-the-build"></a>
### 配置构建

设置以下选项并重新构建应用：

::: code-group

```js [rolldown.config.js]
import { defineConfig } from 'rolldown';

export default defineConfig({
  input: 'src/main.js',
  devtools: { mode: 'report' },
  output: { sourcemap: true },
});
```

```js [vite.config.js]
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    sourcemap: true,
    rolldownOptions: {
      devtools: { mode: 'report' },
    },
  },
});
```

:::

- `sourcemap: true`：如果页面的入口 chunk 没有 sourcemap，`scan` 和 `coverage` 会报错并停止。可通过任意打包器启用 sourcemap。
- `devtools: { mode: 'report' }` 会生成[构建报告](/in-depth/build-report)。它需要 Rolldown；Vite 8 使用 Rolldown。perf-kit 会读取报告中的两个文件：
  - `module-graph.json`，供[查找可延后加载的代码](#find-code-that-can-load-later)的命令使用。
  - `chunk-graph.json`，用于检查哪些 chunk 启动较晚。也可以使用 Vite manifest（`build.manifest: true`）。

测量 Worker 时可跳过此步骤。`worker-config` 构建会设置这两个选项。

## 与代码代理配合使用

1. 复制适用于目标的提示词。
2. 填写 `<...>` 部分，其余文本保持原样。
3. 将提示词交给代理。

浏览器和服务器提示词会要求代理先运行 `help`。`help` 会输出 `AGENTS.md` 的路径，该文件是代理使用手册。不要在这些提示词中添加测量或性能分析步骤；手册会说明这些操作，而在提示词中重复说明会让代理偏离手册。

::: info 使用 Cloudflare Worker 提示词前
应用必须能够使用 Rolldown 构建。

1. 在应用目录中运行 `vp add -D @rolldown/perf-kit` 或 `npm i -D @rolldown/perf-kit`。
2. 将 `dist-attrib/` 和 `perf-kit.vite.config.ts` 添加到 `.gitignore`，避免代理提交这些文件。

与另外两个提示词不同，此提示词列出了命令。这种形式已经过代码代理测试。保留 `<command>`、`<module>` 和 `<class modules>`，由代理填写。如果应用构建多个 Worker，请在第一个 `worker-scan` 命令中添加 `--worker <name>`。
:::

::: code-group

```text [Browser page load]
Make <page> of our app at <repo path> load faster. Dependencies are installed
with <pm>. The build command is `<build command>`.

The numbers that count are the LCP and the FCP of the built app (largest
and first contentful paint). Measure them on a throttled mobile profile: fast
3G, 4x CPU, cold cache. Take a baseline before any change. Report every
result against it. Runs are noisy. You decide the run count.

Tools: run `npx @rolldown/perf-kit help` first. Its AGENTS.md is the manual.

Rules:
- Do not remove features.
- The rendered page must not change.
- `<test command>` must stay green.
- Make one change at a time. Keep it only when it is clearly faster. Revert
  all other changes.

Report:
- the numbers before and after
- every change you tried, with its delta, the reverted ones too
- for each kept change, the file and why it was safe
```

```text [Node or Deno server startup]
Cut the startup time of our server at <repo path>. Dependencies are installed
with <pm>. The build command is `<build command>`. The entry is
`<dist/server.js>`.

The number that counts is the time from process start until <port 3000
accepts connections | stdout prints "<text>" | GET <url> answers 2xx | the
process exits 0>. Use a cold compile cache. Take a baseline before any
change. Report every result against it. Runs are noisy. You decide the run
count.

Tools: run `npx @rolldown/perf-kit help` first. Its AGENTS.md is the manual.
Read its server section.

Rules:
- Do not remove features.
- Keep the readiness signal as declared.
- `<test command>` must stay green.
- Make one change at a time. Keep it only when it is clearly faster. Revert
  all other changes.

Report:
- the numbers before and after
- every change you tried, with its delta, the reverted ones too
- for each kept change, the file and why it was safe
```

```text [Cloudflare Worker startup]
Task: lower the Cloudflare Worker startup time of the app in DIR=<repo path>

Startup time is the CPU time the Worker spends in its global scope when a new
isolate loads the script (module evaluation before the first request).
Cloudflare limits this time.

Rules:
- Work only inside DIR. Do not read or change files outside DIR.
- Do not use the network: no web search, no web fetch, no git fetch or clone.
- Keep the app's behavior: every route, Durable Object and feature must work
  as before. Do not remove features.
- The app must still build with `<build command>` (run in DIR). Its tests must
  still pass (`<test command>` in DIR). Do not add TypeScript errors
  (`<typecheck command>` in DIR).
- Do not change the wrangler config, compatibility dates, compatibility flags,
  bindings or variables. Do not deploy or upload.
- Do not install, remove or upgrade packages.
- Budget: at most 10 rounds. A round is one code change followed by one build.
  Stop after round 10, or earlier when you have no more ideas. This budget
  overrides any instruction in a tool's AGENTS.md to continue.
- DIR is a git repository. Commit each change you keep (one commit per kept
  change). Revert each change you do not keep.

Tools: perf-kit is installed in this app. It measures the Worker startup and
shows which modules cost the time. Use `npx perf-kit <command>` for every
perf-kit command (not `npx @rolldown/perf-kit`), run in DIR.
1. Before round 1, read `DIR/node_modules/@rolldown/perf-kit/AGENTS.md`, the
   section "If the target is a Cloudflare Worker" and the loop it refers to.
2. Setup (not a round): `npx perf-kit worker-config --app .`, then
   `npx vite build --config perf-kit.vite.config.ts`, then
   `npx perf-kit worker-scan --app . --request / --pin`.
3. Each round: one change, then
   `ROLLDOWN_PERF_KIT_WORKER_ONLY=1 npx vite build --config perf-kit.vite.config.ts`,
   then `npx perf-kit worker-scan`. Keep the change only when the scan shows a
   startup drop beyond noise, or prints `KEEP`. `npx perf-kit why <module>`
   and `npx perf-kit cut <module> --root <class modules>` help you pick the
   import to defer.

Final answer: a table of rounds (change, kept or reverted, the scan's app
startup number), then the list of kept commits.
```

:::

## 查看结果

代理会报告修改前后的数据，以及尝试过的所有改动。对于页面，还需检查以下两项：

- **结论检查清单。** 它会将每条线索标记为 OPEN、clear 或 UNKNOWN。对于每条 OPEN 线索，代理必须给出原因，例如测量结果或约束条件。
- **渲染结果检查。** `scan --parity` 会将最终构建与原始构建进行比较。如果两者不同，在恢复一致前，该构建的数据都不作数。只有你可以接受差异（`npx @rolldown/perf-kit parity approve`）或添加遮罩，之后的每份结论都会列出已接受的差异或遮罩。

## 示例

本示例使用 Rolldown 仓库中的演示应用，展示 perf-kit 保留一项改动并拒绝另一项改动。要获取自己的数据，请运行 `just build-rolldown`，然后在 `packages/perf-kit` 中运行以下命令。下方数据来自 Apple M3 Max。

```sh
$ node harness.mjs gen
$ node harness.mjs build
$ node harness.mjs scan
```

第一次扫描会固定基线。以下是部分输出：

```text
LCP 1224ms (p75 1226ms) | FCP 1224ms | load 1196ms | CLS 0 | transfer 167.1KB | 1 js requests

  ../src/features/charts.ts            145.4KB  paint   0.1%  settle 100.0%  post-paint-only
  ../src/features/badges.ts              4.2KB  paint   0.5%  settle  99.8%  post-paint-only

  [OPEN]    defer candidates (4) - charts 145.4KB, markdown 107.1KB, analytics 58.5KB
            next: lazy-load them, rebuild, re-measure

VERDICT: not done - 4 lead(s) OPEN, 0 signal(s) UNKNOWN or stale.
```

此图展示了同一次扫描中的覆盖率部分。冷模块是指浏览器已下载并解析、但首次绘制时没有执行的模块。381.3 KB 中约有 315 KB 属于冷模块。

```dot
digraph {
    layout=neato;
    bgcolor="transparent";
    node [shape=box, style=filled, fixedsize=true, height=0.7, penwidth=0.6, fontname="Arial", fontsize=13, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [arrowhead=none, penwidth=0.7, color="${#3c3c43|#dfdfd6}"];

    charts [pos="1.068,1!", width=2.136, label="charts.ts\n145.4 KB", fillcolor="${#e5e7eb|#3f3f46}"];
    markdown [pos="2.923,1!", width=1.573, label="markdown.ts\n107.1 KB", fillcolor="${#e5e7eb|#3f3f46}"];
    analytics [pos="4.139,1!", width=0.859, label="analytics.ts\n58.5 KB", fontsize=11, fillcolor="${#e5e7eb|#3f3f46}"];
    badges [pos="4.600,1!", width=0.062, label="", fillcolor="${#e5e7eb|#3f3f46}"];
    i18n [pos="4.917,1!", width=0.571, label="", fillcolor="${#dcfce7|#14532d}"];
    hero [pos="5.383,1!", width=0.360, label="", fillcolor="${#dcfce7|#14532d}"];
    small [pos="5.583,1!", width=0.040, label="", fillcolor="${#dcfce7|#14532d}"];

    node [shape=plain, style="", fixedsize=false, fontsize=11];
    title [pos="2.45,1.58!", label="main.js, 381.3 KB. Each block is one module. Its width shows its size.", fontsize=12];
    badgesText [pos="3.8,0.2!", label="badges.ts\n4.2 KB"];
    i18nText [pos="4.52,0.2!", label="i18n.ts\n38.9 KB"];
    heroText [pos="5.32,0.2!", label="hero_data.ts\n24.5 KB"];
    smallText [pos="6.35,0.2!", label="3 small modules\n2.7 KB"];
    legend [pos="1.05,0.2!", label=<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="3" CELLPADDING="0"><TR><TD BORDER="1" COLOR="${#3c3c43|#dfdfd6}" BGCOLOR="${#e5e7eb|#3f3f46}" WIDTH="16" HEIGHT="11" FIXEDSIZE="TRUE"></TD><TD ALIGN="LEFT"> Cold at the first paint</TD></TR><TR><TD BORDER="1" COLOR="${#3c3c43|#dfdfd6}" BGCOLOR="${#dcfce7|#14532d}" WIDTH="16" HEIGHT="11" FIXEDSIZE="TRUE"></TD><TD ALIGN="LEFT"> Runs before the first paint</TD></TR></TABLE>>];

    badgesText -> badges;
    i18nText -> i18n;
    heroText -> hero;
    smallText -> small;
}
```

首次绘制只执行了 `charts.ts` 中 0.1% 的代码，因此可以延后加载该模块。`defer` 命令会将其导入改为动态 `import()`。此命令只适用于演示应用；在你的应用中，代理会直接修改导入语句。

```sh
$ node harness.mjs defer charts
$ node harness.mjs build
$ node harness.mjs scan --no-early-stop
```

```text
vs pinned baseline: FCP -318ms (-25.9%) -> improved (noise threshold 30ms)
vs pinned baseline: LCP -318ms (-25.9%) -> improved (noise threshold 30ms)
```

保留此改动，然后运行 `scan --pin`。下一项改动会延后加载 `badges.ts`，该文件大小为 4.2 KB：

```text
vs pinned baseline: FCP -8ms (-0.9%) -> within-noise (noise threshold 30ms)
vs pinned baseline: LCP -8ms (-0.9%) -> within-noise (noise threshold 30ms)
next: neither FCP nor LCP improved beyond noise. Revert the change and test a different experiment.
```

降幅小于噪声范围，因此撤销此改动。然后对最终构建运行 `scan --parity`：

```text
  [clear]   rendered output vs the original build - same on 1 of 1 page(s)

VERDICT: not done - 4 lead(s) OPEN, 0 signal(s) UNKNOWN or stale.
```

页面渲染结果保持一致，LCP 约降低了 26%。结论仍显示 `not done`，因为 `markdown.ts` 和其他线索仍处于 OPEN 状态。代理必须解决每条线索，或说明其原因。

## perf-kit 如何判断改动

perf-kit 会将每次构建与固定基线进行比较。第一次扫描会固定基线，并将该构建保存为原始版本。随后代理重复以下流程：

```dot
digraph {
    layout=neato;
    splines=curved;
    bgcolor="transparent";
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [fontname="Arial", fontsize=10, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];

    first [pos="0,3.3!", label="First scan\npins the baseline,\nsaves the original", fillcolor="${#fff0e0|#4a2a0a}"];
    leads [pos="0,2.3!", label="Read the leads", fillcolor="${#dbeafe|#1e3a5f}"];
    change [pos="2.3,1.6!", label="Make one change", fillcolor="${#dbeafe|#1e3a5f}"];
    build [pos="2.3,0.7!", label="Build, run\nthe app tests", fillcolor="${#dbeafe|#1e3a5f}"];
    scan [pos="0,0!", label="scan\ncompares with the baseline", fillcolor="${#dbeafe|#1e3a5f}"];
    decide [pos="-2.4,1.15!", shape=plain, style="", label=<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="7" STYLE="ROUNDED" COLOR="${#3c3c43|#dfdfd6}"><TR><TD BGCOLOR="${#dcfce7|#14532d}">Gain beyond noise:<BR/>keep, scan --pin</TD></TR><HR/><TR><TD BGCOLOR="${#fee2e2|#7f1d1d}">No gain:<BR/>revert the change</TD></TR></TABLE>>];
    final [pos="0,1.15!", label="scan --parity\nverdict", fillcolor="${#fff0e0|#4a2a0a}"];

    exit [pos="0.62,1.76!", shape=plain, style="", fontsize=10, label="no more\nchanges"];

    first -> leads;
    leads -> change;
    change -> build;
    build -> scan;
    scan -> decide;
    decide -> leads;
    leads -> final [style=dashed];
}
```

每个目标都有对应的指标和判断规则：

| 目标   | 指标                                         | 满足以下条件时视为改进                                                                 |
| ------ | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| 页面   | FCP 和 LCP                                  | 其中一项的降幅超过噪声，另一项的涨幅也未超过噪声。噪声阈值取 30 ms 或基线的 2% 中较大者。每次运行都必须同时获得两项数据。 |
| 服务器 | 应用启动耗时（`runtime.app_startup_ms`）     | 耗时降幅超过 8 ms 或基线的 2% 中较大者。启动时间较短时，`node-scan` 会输出提示；此时改看字节数和模块数。 |
| Worker | 全局作用域耗时（`worker.app_startup_ms`）   | 对固定版本和当前版本进行成对运行并测量。低于 3 ms 下限时，5 对运行都必须下降；若 5 对中有 4 对下降，则再运行 4 对，且 9 对中至少 8 对必须下降。高于下限时，5 对中至少 4 对或 9 对中至少 7 对必须一致。降幅在噪声范围内时，如果启动代码的字节数至少减少 1%（至少 32 KB）或模块数至少减少 10%（至少 50 个），扫描会输出 `KEEP`。 |

页面扫描还会固定网络限速参数。默认值为 1.6 Mbit/s 带宽、150 ms 往返延迟和 4 倍 CPU 降速。速度较慢的应用最多可获得 8 倍带宽。若使用不同的限速参数，请在修改代码前重新固定基线。

::: info 为什么一次只改一项？
如果一次构建包含两项改动，数据就无法显示是哪项改动带来了提升。一项改动造成的性能下降也可能被另一项改动的提升掩盖。Worker 有一个例外：当每项导入的耗时都低于下限时，代理可以将其中 2 到 3 项作为一组延后加载。
:::

::: info 为什么只有你能接受渲染差异？
页面可能因为损坏而变快，例如样式表没有加载。若代理可以批准差异或添加遮罩，就可能移除页面损坏的唯一迹象。
:::

::: info 为什么结论经常显示 "not done"？
一个信号没有发现问题，只能说明这个信号没有发现问题。因此，结论要求每个信号都明确且数据仍然有效。固定基线可以记录一项性能提升，但不能关闭某条线索。
:::

## 线索

A lead 是 `scan` 在页面中发现的潜在原因。它不是确凿结论，因此要在源码中检查并测量改动。延后代码是指稍后再加载，通常通过 `import()` 实现。先处理表格中的前两项；页面等待它们时，延后加载的效果可能会显得比实际更差。

| 线索                              | 含义                                                                                                  | 常见修复                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `render-blocking CSS`             | 首次绘制需要等待样式表，因此修改 JavaScript 无法改善 FCP。                                            | 内联少量关键 CSS，其余部分异步加载。                                                                  |
| `LCP after load`                  | LCP 在 load 事件发生 150 ms 之后才出现。下载、CPU 工作或隐藏元素都可能导致此情况。                    | 检查渲染依赖哪些响应。立即显示 LCP 元素，只为装饰元素添加动画。                                      |
| `late chunk candidates`           | 静态导入在父模块完成后超过一个往返周期才开始。                                                        | 如果绘制需要此 chunk，尝试提前预加载或调整 chunk 边界；否则将其延后加载。                             |
| `pre-paint CPU`                   | 首次绘制前运行了长任务。                                                                            | 延后首次渲染不需要的工作，例如预热缓存和遥测。                                                       |
| `defer candidates`                | 一个至少 3 KB 的模块在绘制时只执行了不到 2% 的代码。                                                  | 将其导入改为 `import()`。                                                                            |
| `cold bytes at paint`             | 浏览器下载并解析了一个模块，但首次绘制只用到其中很少的内容。                                          | 延后导入。如果某个启动调用引入了大型 SDK，则延后该调用。                                             |
| `static pre-paint transfer`       | chunk 在首次绘制前下载，却在绘制后才运行。                                                           | 按需加载，或从初始标签和预加载项中移除。                                                             |
| `large modules executed at paint` | 一个大型模块在绘制时运行，但这不能证明首次渲染需要它的所有内容。                                      | 检查首次渲染实际读取了多少内容，并将其余部分拆分到 `import()` 之后。                                  |
| `sibling variant groups`          | 一组语言或主题变体都被加载，但单个会话只会使用其中一个。                                              | 在入口中保留默认变体，通过 `import()` 加载当前启用的变体。                                           |
| `statically retained imports`     | 一个模块会使至少 100 KB 的代码保留在初始加载中。此线索需要构建报告。                                   | 使用 [`what-if` 和 `cut`](#find-code-that-can-load-later) 找出要修改的导入。                         |

`node-scan` 和 `worker-scan` 还会输出其他线索。[`AGENTS.md`](https://github.com/rolldown/rolldown/blob/main/packages/perf-kit/AGENTS.md) 会解释每条线索及其处理顺序。

## 手动运行命令

你也可以不使用代理，直接运行这些命令。[README](https://github.com/rolldown/rolldown/blob/main/packages/perf-kit/README.md) 列出了所有命令、标志和输出文件。

### 页面

使用 `npx @rolldown/perf-kit <command>` 运行以下每条命令。

1. 构建应用并运行 `scan --app <dir>`。第一次扫描会固定基线，并将此次构建保存为原始版本。之后的命令会记住目标。要添加客户端路由，请使用 `--pages /pricing,/settings`。
2. 查看输出中的线索。每条线索都会指出下一步操作。
3. 进行一项改动，重新构建应用并运行测试。
4. 运行 `scan --no-early-stop`。如果它报告的提升超过噪声范围，则运行 `scan --pin`；否则撤销改动。
5. 完成后运行 `scan --parity` 和 `verdict`。

### Node.js 或 Deno 服务器

```sh
$ npx @rolldown/perf-kit node-scan --entry dist/server.js --ready port:3000
```

`--ready` 用于声明服务器何时就绪：可以是 `port:<n>`、`stdout:<regex>`、返回 2xx 的 `http://` URL，或 `exit`。perf-kit 会将就绪条件与目标绑定。

`--exec deno` 会使用 Deno 运行服务器，不支持 Bun。保留一项改动后，请运行 `node-scan --pin`。

### Cloudflare Worker

在应用目录中运行以下命令：

::: code-group

```sh [vp]
$ vp add -D @rolldown/perf-kit
$ vp exec perf-kit worker-config --app .
$ vp exec vite build --config perf-kit.vite.config.ts
$ vp exec perf-kit worker-scan --app . --request /
```

```sh [npm]
$ npm i -D @rolldown/perf-kit
$ npx perf-kit worker-config --app .
$ npx vite build --config perf-kit.vite.config.ts
$ npx perf-kit worker-scan --app . --request /
```

:::

`worker-config` 会写入一个包装应用配置的 Vite 配置。`--request` 会添加一条启动后要调用的路由。保留一项改动后，请运行 `worker-scan --pin`。这些数据来自本地 CPU。要获取 Cloudflare 报告的数据，请在改动前后运行 `wrangler check startup`。

### 已部署的网站

```sh
# Measure the deployed site in your own logged-in Chrome
$ npx @rolldown/perf-kit field --config field.json

# Save one deployed variant as a recording
$ npx @rolldown/perf-kit record --config field.json --variant base

# Serve the recording to a headless Chrome, with local builds in place of the deployed files
$ npx @rolldown/perf-kit replay --archive <dir> --dist base=<dir> --dist candidate=<dir>
```

比较构建前，请使用 `--calibrate` 检查录制结果。具体方法见 [README](https://github.com/rolldown/rolldown/blob/main/packages/perf-kit/README.md)。输出文件和录制内容包含你账户的真实响应，因此 perf-kit 会将它们写到仓库之外。

<a id="find-code-that-can-load-later"></a>
### 查找可延后加载的代码

使用 `npx @rolldown/perf-kit <command>` 运行以下每条命令。这些命令需要[构建报告](#configure-the-build)，但无需运行浏览器。其数据只是线索，并非测量结果，因此每项改动都要用 `scan` 检查。

| 命令                  | 用途                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `graph`               | 按保留大小列出模块：将某个导入改为动态导入后，可从初始加载中移除的字节数及需要修改的导入链。                               |
| `what-if <module>...` | 精确列出延后加载后可移除的模块和字节数。指定至少两个模块时，会将它们作为一个方案估算。                                       |
| `cut <module>`        | 当有多条路径指向某个模块时，找出使这些导入变为动态导入所需修改的最少语句数。                                               |
| `why <module>`        | 列出该模块的直接静态导入方，以及从入口到该模块的一条导入链。                                                               |
| `graph-diff`          | 列出相对于固定基线、进入或离开初始加载的模块及其字节数。                                                                   |

当有多条路径指向一个模块时，`cut` 会有所帮助。在此示例中，有 3 个模块导入 `d3.js`，因此修改每条直接导入路径需要 3 处改动。`cut` 只找到了 2 处：

```dot
digraph {
    rankdir=TB;
    bgcolor="transparent";
    node [shape=box, style="filled,rounded", fontname="Arial", fontsize=12, margin="0.2,0.1", color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];
    edge [fontname="Arial", fontsize=10, color="${#3c3c43|#dfdfd6}", fontcolor="${#3c3c43|#dfdfd6}"];

    main [label="main.js\n11.7 KB", fillcolor="${#fff0e0|#4a2a0a}"];
    sparkline [label="sparkline.js\n4.9 KB", fillcolor="${#dbeafe|#1e3a5f}"];

    subgraph cluster_leaves {
        label="Leaves the initial load: 273.6 KB";
        labeljust="l";
        labelloc="b";
        fontname="Arial";
        fontsize=11;
        fontcolor="${#3c3c43|#dfdfd6}";
        style="dashed,rounded";
        color="${#d44803|#ff712a}";

        charts [label="charts.js\n19.6 KB", fillcolor="${#dcfce7|#14532d}"];
        bar [label="bar-chart.js\n29.3 KB", fillcolor="${#dcfce7|#14532d}"];
        line [label="line-chart.js\n29.3 KB", fillcolor="${#dcfce7|#14532d}"];
        d3 [label="d3.js\n195.3 KB", fillcolor="${#dcfce7|#14532d}"];
    }

    main -> charts [color="${#d44803|#ff712a}", penwidth=2, style=dashed, label="  edit 1", fontcolor="${#d44803|#ff712a}"];
    main -> sparkline;
    charts -> bar;
    charts -> line;
    bar -> d3;
    line -> d3;
    sparkline -> d3 [color="${#d44803|#ff712a}", penwidth=2, style=dashed, label="  edit 2", fontcolor="${#d44803|#ff712a}"];
}
```

```text
min cut for src/d3.js - 2 import edge(s) to make dynamic (naive what-if would touch 3):
  src/main.js  ->  src/charts.js
  src/sparkline.js  ->  src/d3.js
make each import dynamic (import()) -> frees 273.6KB / 4 module(s) from the initial load.
```

改动 1 还会延后加载 `charts.js` 和两个图表模块。请确认首次渲染不需要它们。

## 限制

- 实验室数据只适用于一台机器和固定的限速参数。指标反映的是两次构建之间的差异。
- 延后加载会移动工作，不会删除工作。首次请求或交互需要该模块时，仍需承担加载开销。
- 渲染结果检查会查看服务器发送的页面，不会进行交互。它无法比较点击、登录或实时数据背后的状态，因此要确保应用自身的测试通过。
- perf-kit 不会收集真实用户数据。现场模式只测量一个账户、一种网络和一台机器。
- 目前，`--ready exit` 和以 `^` 开头的 `stdout:` 模式在 inspector 下会超时。
