# Focus 专注计时 — 独立 QA 报告（v2 语义）

- 报告人：qa-verifier（独立 QA，不参与应用实现）
- 测试对象：`/home/kibi/Work/Focus`（index.html / app.js / focus-core.js / styles.css）
- 适用版本：**schema v2**（任务级目标、正计时、暂停计轮、不自动结束、记录实际/目标）
- 最终验证快照：**styles.css 最后变更 2026-10-24T03:02:27Z**；最终验证运行 **03:04:02–03:04:40Z**，运行前后源码 hash 一致（`sha256` 见 §2）
- 结论：**通过（PASS），无 P0 / P1 / P2 功能缺陷**。34 项单元测试 + 16 项端到端测试全部通过，0 条 console 错误、0 个未捕获异常、0 个阻塞式弹窗。4 条 P3 观察/已知取舍见 §7。

> v1（旧语义：倒计时、每轮目标、roundComplete、自动结束）的 QA 报告已归档到 `.qa/qa-report-v1-archive.md`；`tests/core.test.js` 与 `tests/e2e.cjs` 已按 v2 语义**整体重写**，不保留旧断言。

---

## 1. 结论摘要

| 维度 | 结果 |
| --- | --- |
| 单元测试（`tests/core.test.js`，node:test） | **34 / 34 通过**（约 0.2s） |
| 端到端测试（`tests/e2e.cjs`，CDP + headless Chrome） | **16 / 16 通过**（约 38s） |
| 浏览器 console 错误 / 未捕获异常 | **0 条** |
| 阻塞式弹窗（alert/confirm） | **0 次** |
| 关键截图 | **13 张**（`.qa/v2-*.png`，桌面/移动/深色/浅色/目标达成/记录） |
| 可重复性 | 同快照多次完整运行均 16/16 通过（每个场景独立重置，无状态残留） |
| P0 / P1 / P2 缺陷 | **0 / 0 / 0** |
| P3 观察项 | 4（见 §7，其中 2 条 README 已声明为已知取舍） |

**v2 需求逐条验证状态：**

| # | 新语义要求 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| 1 | 一个任务只有一个目标时长（提示/统计参考，不分摊到轮） | 单测 `createSession`/`clampTargetMs`；E2E B1/B2/B8（`session.targetMs` 为唯一目标，轮次仅 `{focusedMs}`） | ✅ |
| 2 | 正计时从 0 累计；到目标不停止、可无限继续，超时显示「已超出」 | 单测 `formatElapsed`/`getTotalFocusedMs`/`getOvertimeMs`/`isTargetReached`；E2E B2/B4（越过 1 分钟目标后继续跑 10 分钟仍在 running，`已超出`、`目标已达成`、绿色数据状态） | ✅ |
| 3 | 暂停 = 结束当前轮并计一轮，任务不结束；暂停态按钮只剩「继续 + 完成」 | 单测 `pauseSession`（含 999/1000ms 边界）；E2E B2（暂停后可见按钮数量=2、下一轮隐藏、轮次=1、累计时间冻结）、B15 移动端同样验证 | ✅ |
| 4 | 下一轮 = 结束当前轮并立即开新一轮，不弹确认框 | 单测 `startNextRound`；E2E B2/B3/B10（点击后 `modalOpen=false`、轮次累加、累计时间不丢、连点只推进一次） | ✅ |
| 5 | 完成记录同时保存/展示实际时间 + 设定时间 + 轮数 + 达成条 | 单测 `completeSession`/`normalizeRecord`；E2E B2/B3/B4/B7/B12/B13（列表 `实际 X / 目标 Y`、`· N 轮`、达成条宽度与 `is-reached`、超时记录 100%） | ✅ |
| 6 | session 结构 v2（`rounds=[{focusedMs}]`，phase 仅 running/paused，目标在 `session.targetMs`） | 单测 `createSession`/`normalizeSession`（无 roundIndex、轮次无 targetMs）；E2E 直接断言 localStorage 结构 | ✅ |
| 7 | 刷新恢复：结束当前轮并恢复为 paused，轮次与实际时间不丢 | 单测 `restoreSession`（按 `savedAt` 收口）；E2E B5（running→paused、轮次 1、~4 分钟；再次刷新精确保持；继续后完成 2 轮）、B6（达成态刷新保留达成状态） | ✅ |
| 8 | 0–1 秒轮次不计（`MIN_ROUND_MS=1000`） | 单测边界 0/999/1000ms；E2E B11（亚秒暂停/下一轮/收口均不计轮，记录仅 1 轮） | ✅ |
| 9 | 目标时长设置：预设 + 1–480 自定义，小数按整分钟四舍五入（已知取舍） | 单测 `clampTargetMs`；E2E B8（0/481/1440 拒绝且即时提示，480/1 接受，45.5→46） | ✅ |
| 10 | UI 新状态：正计时、暂停态、目标达成/超时（绿色不停止）、记录实际 vs 目标 + 进度条 | E2E B1/B2/B4/B7 + 截图 `.qa/v2-desktop-*.png` | ✅ |

---

## 2. 最终源码快照（权威）

| 文件 | 大小 | mtime (UTC) | sha256 |
| --- | --- | --- | --- |
| `index.html` | 11889 | 2026-10-24 02:45:40 | `ed5a06c19b93d0247803d1e8819fa97b6eadfdbe9263190a3c08a436e6bb72f3` |
| `app.js` | 36289 | 2026-10-24 02:45:21 | `3feb4b5fe2e656853defae71d8a3adc71a9b96b06155719c251ba431d75a9a5f` |
| `focus-core.js` | 21636 | 2026-10-24 02:43:37 | `37c380b3c32ea7060d90e141ebaf5a5884ce2ba30a5b15362b259042ac2f2998` |
| `styles.css` | 39465 | 2026-10-24 03:02:27 | `40f0d38523891a7173ddd18362c9ee32bad508d8f61e944387950daf81595edd` |
| `README.md` | 7224 | 2026-10-24 02:48:11 | `a00cd5e942e3ed3df9883c7e5a6065bce3faa071141f43ec64d7e75a678fff0d` |

> 机器可读副本：`.qa/v2-source-final.sha256` / `.stat`；QA 开始时的基线：`.qa/v2-source-baseline.*`。
> 测试期间 `styles.css` 由设计评审并行精修（QA 开始后仍有多次变更，最后变更 03:02:27）；`app.js` / `focus-core.js` / `index.html` 自 v2 基线起未再变动。最终验证在 03:04:02–03:04:40Z 的冻结快照上执行，运行前后 hash 一致（`.qa/v2-final-run-before.sha256` / `-after.sha256`）。
> 若之后 `styles.css` 再变，只影响截图外观；本报告功能断言不依赖 CSS（仅依赖 DOM、文本与 `hidden`/溢出几何）。

---

## 3. 环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Linux x64（DSH 沙箱，workspace `/home/kibi/Work/Focus`） |
| Node | v24.22.1（仅内置能力，无 npm 依赖） |
| 浏览器 | Google Chrome 156.0.8078.47，`--headless=new` |
| CDP 端口 | 9444（测试脚本自行启动/结束 Chrome，profile 在 `.qa/` 内并清理） |
| 预览服务器 | `http://127.0.0.1:4173/index.html`（复用后台运行实例，HTTP 200） |
| 桌面视口 | window 1440×900，headless 可视区 1440×757 |
| 移动视口 | 390×844，DPR 2（`Emulation.setDeviceMetricsOverride`） |
| 时区 | UTC+0 |
| 数据隔离 | 每个场景经同源清理页 `.qa/blank.html`（不加载应用脚本）清空 localStorage，规避 `beforeunload` 回写 |
| 时间加速 | 导航前 `Page.addScriptToEvaluateOnNewDocument` 注入 `Date.now` 偏移时钟，offset 存 localStorage 跨刷新保持；场景起点固定为 `2026-10-24 10:00`（本地时区） |

---

## 4. 复现命令

```bash
cd /home/kibi/Work/Focus

# 单元测试（34 项，约 0.2 秒）
node --test tests/core.test.js
#    或：node --test

# 端到端测试（16 项，约 40 秒；自动启动并清理 headless Chrome）
node tests/e2e.cjs
#    产物：.qa/v2-*.png（13 张截图）、.qa/e2e-results-v2.json
#    退出码：0 = 全部通过；1 = 有失败（失败信息含「期望 vs 实际」）

# 可选环境变量
#   QA_ONLY=B2,B4        只运行指定场景（便于定位）
#   QA_CDP_PORT=9444     CDP 端口（默认 9444）
#   QA_PREVIEW_PORT=4173 预览端口（默认 4173）
#   CHROME_BIN=google-chrome
```

若 4173 不可用，`tests/e2e.cjs` 会自动启动 `python3 -m http.server 4181 --bind 127.0.0.1`，并在 `.qa/e2e-results-v2.json` 的 `preview` 字段标注来源。本次运行复用了 4173。

---

## 5. 测试方法（v2 重写要点）

### 5.1 单元测试（34 项）

- 直接 `require('../focus-core.js')`（UMD 同时支持浏览器/Node），使用内存 Storage 替身与「抛错 Storage」验证存储安全。
- 全部时间戳用本地时间构造，**与运行机器时区无关**；不依赖 DOM、不 sleep、确定性。
- 覆盖 v2 新 API：`createSession` / `getRoundElapsedMs` / `getTotalFocusedMs` / `getCompletedRounds` / `getCurrentRoundNumber` / `getTargetRemainingMs` / `getOvertimeMs` / `getProgress` / `isTargetReached` / `pauseSession` / `resumeSession` / `startNextRound` / `completeSession` / `restoreSession` / `normalizeSession`（v1→v2 迁移）/ `normalizeRecord` / `summarize` / storage。
- 保留 v1 的格式化/夹紧/统计/净化测试，但断言改为新语义（如 `formatElapsed` 向下取整、`summarize.todayRounds` 统计全部轮次）。

### 5.2 端到端测试（16 项）

- 零依赖 CDP 驱动：`child_process` 启动 headless Chrome，Node 24 内置 `WebSocket` 连接；自实现 `send/事件订阅/waitEvent`；SIGINT/异常时确保 Chrome 回收。
- **可控时钟**：`Page.addScriptToEvaluateOnNewDocument` 在应用脚本前覆盖 `Date.now`（真实时间 + offset），offset 持久化在 localStorage 因而跨刷新保持；25 分钟场景毫秒级快进。
- **状态重置**：应用在 `beforeunload` 中会回写运行中的 session，因此先导航到同源、不加载应用的 `.qa/blank.html` 清空 localStorage，再打开应用，保证场景从干净状态开始（并断言清空后 `localStorage.length === 0`）。
- **断言可读性**：统一输出「期望 / 实际」；等待类失败附带最后观察到值；`clickStartExpectRunning` 失败会附带表单/弹窗/toast/session 快照。
- **console 健康**：汇总 `Runtime.exceptionThrown`、`Runtime.consoleAPICalled(error/assert)`、`Log.entryAdded(error)` 与 `Page.javascriptDialogOpening`，B16 断言全为 0。
- **快照字段**：视图/phase/`data-target-reached`/正计时文本/目标剩余或超出/暂停与按钮可见性/进度/记录卡片（任务、时间段+轮数、实际/目标、达成条宽度与 `is-reached`）/统计/7 日图/存储内容/toast。

---

## 6. 测试清单与结果

### 6.1 单元测试 — 34 / 34 通过

| # | 用例 | 覆盖点 | 结果 |
| --- | --- | --- | --- |
| 1 | constants | `VERSION=2`、`MIN_ROUND_MS=1000`、目标上下限、`MAX_RECORDS`、storage keys | ✅ |
| 2 | 旧 v1 API 已移除 | `tickSession/getElapsed/getRemaining/countCompletedRounds/getSessionFocusedMs === undefined` | ✅ |
| 3 | `formatElapsed` | 正计时向下取整：999→00:00、1000→00:01、59:59、`1:00:00`、8h、负数/NaN | ✅ |
| 4 | `formatClock` | 剩余/超时向上取整：1→00:01、1499→00:02、`1:00:00` | ✅ |
| 5 | `formatSpan` / `minutesLabel` / 时间工具 | 不足 1 分钟、小时组合、`<1`、`formatTimeOfDay/dateKey/parseDateKey/formatDayLabel` | ✅ |
| 6 | `clampTargetMs` | 0/负值→1 分钟、480 上限、超限夹紧、undefined→25 分钟、数字字符串、null | ✅ |
| 7 | `createSession` | v2 结构、无 `roundIndex`、轮次无 per-round target、任务名折叠/截断、目标夹紧 | ✅ |
| 8 | `getRoundElapsedMs` | 仅当前轮计时、暂停→0、时钟回拨不为负、恢复后新一轮重新计时 | ✅ |
| 9 | `getTotalFocusedMs` | 已完成轮次 + 当前轮、暂停冻结、null→0、时钟回拨不减已完成轮 | ✅ |
| 10 | `getCompletedRounds` / `getCurrentRoundNumber` | running=轮次+1；paused=轮次；0 轮暂停=0 | ✅ |
| 11 | 目标数学 | 剩余/超时/进度（夹紧 100%）/`isTargetReached`（含恰好等于目标）、null | ✅ |
| 12 | `pauseSession` | 结束并计入当前轮、任务保持、phase=paused、再次暂停无副作用、null | ✅ |
| 13 | `pauseSession` MIN_ROUND_MS 边界 | 0/999ms 不计；1000ms 计入且时长=1000 | ✅ |
| 14 | `resumeSession` | paused→running 开新一轮、累计保留、running/null no-op | ✅ |
| 15 | `startNextRound` | 结束当前轮立即开新一轮、<1s 不计、暂停中直接开新一轮不重复计轮、null | ✅ |
| 16 | `completeSession`（running） | 包含未收口轮、actual/target/rounds、v2 记录字段、日期键 | ✅ |
| 17 | `completeSession`（paused/多轮） | 2 轮 12+10 分钟、`targetReached` 推导、暂停中直接完成 | ✅ |
| 18 | `completeSession`（空） | 0/亚秒→null、0 轮 paused→null、null 输入 | ✅ |
| 19 | `completeSession`（超目标） | 目标 5 分钟实做 8 分钟 → actual 8 / target 5 / reached | ✅ |
| 20 | `completeSession` 跨日 | 23:50 开始、次日 0:20 完成 → `dateKey` 为结束日 | ✅ |
| 21 | `restoreSession`（running） | 按 `savedAt` 收口当前轮（而非 now）、<1s 不收、恢复 paused、null/非法输入 | ✅ |
| 22 | `restoreSession`（paused） | 轮次原样保留、累计时间不变 | ✅ |
| 23 | v1 running 迁移 | v1 轮次对象→`{focusedMs}`、丢弃 v1 字段、`restoreSession` 收口 open round | ✅ |
| 24 | v1 paused / roundComplete 迁移 | 残留 `roundElapsedMs`≥1s 迁移为轮次、<1s 丢弃、roundComplete→paused 不重复 | ✅ |
| 25 | `normalizeSession` 防御 | null/字符串/数组拒绝、未知 phase→paused、目标夹紧、roundStartedAt 仅 running 保留 | ✅ |
| 26 | 轮次规范化 | 数字与 `{focusedMs}` 对象均可、v1 字段丢弃、非法对象丢弃；记录内轮次转为毫秒数字 | ✅ |
| 27 | `normalizeRecord` | 必填字段、轮次数组、`targetReached` 推导/显式优先、v1 记录迁移、`roundsCompleted≤roundsTotal`、dateKey 推导 | ✅ |
| 28 | `sanitizeRecords` / `addRecord` / `removeRecord` | 过滤、倒序、上限 500、不可变性、缺失 id、null | ✅ |
| 29 | `groupRecords` | 按 dateKey 分组、顺序 | ✅ |
| 30 | `summarize` | 今日实际分钟/轮次（`roundsTotal` 之和）/次数、总计时长、连续天数、7 日图、旧记录不进图 | ✅ |
| 31 | storage | session/records/settings 往返、坏 JSON→兜底、抛错 storage 安全、settings 规范化 | ✅ |
| 32 | edge：目标达成不变异 | `isTargetReached` 只读、超时后仍可暂停/继续/完成、超时量保持 | ✅ |
| 33 | edge：多轮累计 | 5×2 分钟轮 + 收口 60s → 6 轮 11 分钟，统计一致 | ✅ |
| 34 | edge：<1s 暂停/继续/下一轮 | 0 轮暂停→继续→亚秒下一轮→满 1 秒后计轮，累计一致 | ✅ |

命令输出：`ℹ tests 34 / ℹ pass 34 / ℹ fail 0`（`.qa/unit-final.log`）。

### 6.2 端到端测试 — 16 / 16 通过

| ID | 场景 | 关键断言（摘要） | 截图 | 结果 |
| --- | --- | --- | --- | --- |
| B1 | 首屏 v2 | 设置视图、默认 25 分钟胶囊、`整个任务 25 分钟`、「开始任务」、计时器 `00:00`、会话说明「目标只作提示，不会自动结束」、记录 0/空状态（提示实际时长与目标时长）、今日统计 0、7 日图 7 列、清空隐藏、无 session/records 写入 | `v2-desktop-setup-dark.png` | ✅ |
| B2 | 正计时→暂停计轮→继续新一轮→完成记录 | 从 00:00 正计时；5 分钟→`05:00`/33%/还剩 10:00；暂停→`已完成 1 轮 · 已暂停`、按钮仅「继续+完成」（`#nextBtn` hidden/display:none）、轮次 1、toast「第 1 轮结束…任务已暂停」、持久化轮次约 5 分钟；暂停期间快进 3 分钟计时冻结；继续→第 2 轮、累计不丢；下一轮→第 3 轮无弹窗；10 分钟完成→弹窗「实际专注…距目标 15 分钟 还差 5 分钟 · 共 3 轮」；记录 v2 字段/3 轮/实际 10 分钟/达成条 67%/未达成；今日统计 10 分钟/3 轮/连续 1 天/近 7 天合计；session 清除 | `v2-desktop-session-running.png`、`v2-desktop-session-paused.png` | ✅ |
| B3 | 下一轮无确认 + 未达成记录 | 10 分钟点下一轮→无弹窗、第 2 轮、1 轮、累计 10:00；再 3 分钟下一轮→第 3 轮、2 轮；再 2 分钟完成→弹窗「共 3 轮/实际 15 分钟」；记录 3 轮、实际 15/目标 25、达成条 60% 未达成、今天分组；今日轮次 3 | `v2-desktop-records-under-target.png` | ✅ |
| B4 | 目标达成不自动结束 | 1 分钟目标：30s→`00:30`、约 50%、还剩；再过 35s→`01:05` 仍 running、`data-target-reached=true`、`目标已达成`、`已超出`、100%、轮次 0、toast 只弹 1 次；再跑 10 分钟→`11:05` 仍 running、无重复提示；暂停→计 1 轮；完成→弹窗「已达到目标 1 分钟 · 共 1 轮」；记录 actual≈11 分钟/target 1 分钟/reached、达成条 100%、is-reached | `v2-desktop-target-reached.png`、`v2-desktop-records-reached.png` | ✅ |
| B5 | 刷新恢复 running→paused | 4 分钟刷新→仍会话视图、paused、按钮「继续」、下一轮隐藏、`已完成 1 轮 · 已暂停`、轮次 1、`04:00`（±6s，4 秒保存间隔）、toast「本轮已结束，任务已暂停」、持久化轮次约 4 分钟；暂停态再刷新时间/轮次精确不变；继续→第 2 轮→再 2 分钟完成→记录 2 轮、实际约 6 分钟、目标 15 保留 | — | ✅ |
| B6 | 达成目标后刷新 | 70s 越过 1 分钟目标→刷新→paused 且 `target-reached=true`、`已暂停`、轮次 1、`01:10`（±6s）；完成→记录 `targetReached=true`、实际约 70s | — | ✅ |
| B7 | 记录展示/删除撤销/清空 | 3 条（今天 2 + 昨天 1，含达成/未达成）→记录倒序、`· N 轮`、`实际 X / 目标 Y`、达成条宽度/is-reached 与持久化一致；今日 40 分钟/3 轮/连续 2 天/近 7 天 80 分钟；删除→toast+撤销、统计更新、持久化；撤销→恢复；再删+刷新→删除保留；清空弹窗「将删除 2 条」→取消不删→确认→空状态/统计归零/7 日图全空/按钮隐藏/持久化空；刷新仍空 | `v2-desktop-record-delete-toast.png`、`v2-desktop-records-empty.png` | ✅ |
| B8 | 自定义目标时长校验 | 0/481/1440→即时提示「需在 1–480 分钟之间」+警告态、开始被 toast 拒绝、不写 session；480→`目标 480 分钟 · 还剩 8:00:00` 并持久化；1→`还剩 01:00`；45.5→取整 46 分钟（README 已声明取舍）；空白任务名→提示且不开始 | — | ✅ |
| B9 | 快捷键 | 空格暂停（计 1 轮、toast）、空格继续（第 2 轮、累计不丢）、N 下一轮（无弹窗、2 轮）、Enter 完成（弹窗→Esc 取消→再 Enter→保存）、输入框聚焦时快捷键不触发、按钮聚焦时空格不双触发 | — | ✅ |
| B10 | 快速连点 | 连点下一轮 5 次→无弹窗、只推进到第 2 轮、只计 1 轮、累计 10:00、持久化 1 条轮次；连点完成 3 次→只弹一次保存窗、确认后只有 1 条记录 | — | ✅ |
| B11 | 0–1 秒轮次不计 | 立刻完成→「还没有产生专注时长」不生成记录（取消继续）；立刻暂停→0 轮、「任务已暂停」、toast「继续将开始新一轮」；继续后立刻下一轮→仍 0 轮；快进 1.2s 后下一轮→1 轮；亚秒收口完成→记录仅 1 轮、实际约 1 秒多、今日 `<1` | — | ✅ |
| B12 | 跨日 | 10-23 23:50 开始，10 分钟暂停（1 轮），继续 20 分钟，10-24 00:20 完成→记录 `dateKey=2026-10-24`、2 轮、实际 30 分钟、目标 25 达成、分组「今天」、今日统计；刷新后仍正确 | — | ✅ |
| B13 | v1 数据迁移 | 预置 v1 paused session（rounds 对象 + `roundElapsedMs` 2 分钟）→恢复 paused、`已完成 2 轮 · 已暂停`、`07:00`、轮次 2、restore toast；v1 record（roundsCompleted 2/roundsTotal 3）→记录显示 `· 3 轮`、`实际 15 分钟 / 目标 30 分钟`、达成条 50%；迁移会话继续→第 3 轮→完成→记录 2 条 | — | ✅ |
| B14 | 主题/提示音 | 默认深色 + meta `#0a0b0e` + 提示音 on；切浅色→`light`/`#f4f0e9`/aria-label；关提示音→aria-pressed=false/is-muted/toast/settings 持久化；刷新保持；切回默认恢复 | `v2-desktop-setup-light.png` | ✅ |
| B15 | 移动端 390×844 | 设置/运行/暂停/记录四态均无横向溢出；运行态 3 个按钮与倒计时在视口内；暂停态仅 2 个按钮（继续+完成）、标签 `已完成 1 轮 · 已暂停`；记录显示实际/目标 + 达成条 | `v2-mobile-setup.png`、`v2-mobile-session.png`、`v2-mobile-paused.png`、`v2-mobile-records.png` | ✅ |
| B16 | console 健康 | console 错误 0、未捕获异常 0、alert/confirm 0；`FocusCore.VERSION=2`、`MIN_ROUND_MS=1000`、v2 API 全部可用、v1 状态机 API 已移除；除 AudioContext 预期警告外无其它警告 | — | ✅ |

运行输出：`测试: 16 通过: 16 失败: 0；console 错误: 0 条；警告: 0 条`（`.qa/e2e-final.log`）。

---

## 7. 缺陷与观察项

### P0 — 阻塞缺陷

无。

### P1 — 高优先级缺陷

无。

### P2 — 中优先级缺陷

无。

### P3 — 低优先级观察项 / 已知取舍

#### O1（P3，README 已声明的已知取舍）自定义目标时长的小数按整分钟四舍五入

- 复现：设置页 → 任务填任意值 → 自定义时长输入 `45.5` → 提示变为「整个任务 46 分钟」→ 开始任务 → `目标 46 分钟 · 还剩 46:00`，持久化 `targetMs=2760000`。
- 说明：需求第 7 条明确「小数输入按整分钟四舍五入（已知取舍）」，README「已知取舍」也有说明，**不作为缺陷**；B8 将其固化为回归断言。
- 证据：`.qa/e2e-results-v2.json` → `observations[0]`。

#### O2（P3，健壮性）损坏数据中 `rounds` 的「数字」0/负数会被夹成 0 并计入轮数

- 复现：控制台执行
  `localStorage.setItem('focus.session.v1', JSON.stringify({phase:'paused', rounds:[0,-5,1500]}))` → 刷新。
- 期望：无意义的 0/负数轮次应被丢弃。
- 实际：`normalizeSession` 对「数字型轮次」走 `makeRound()`，`Math.max(0, …)` 后得到 `{focusedMs:0}`，被计入 `getCompletedRounds`（此例显示 3 轮）。
- 触发条件：仅当 localStorage 被手工/异常写成数字轮次时出现；正常应用只会写 `{focusedMs: >0}`，**不影响正常用户流程**（P3）。
- 证据：`tests/core.test.js` → 「轮次规范化」用例中的断言与注释。
- 建议（若后续再动 core）：`normalizeRound` 对数字分支也要求 `>0` 再 `makeRound`。

#### O3（P3，UX 一致性）暂停态隐藏「下一轮」按钮，但键盘 N 仍可直接开始下一轮

- 复现：运行中按空格暂停（按钮区只剩「继续 + 完成」）→ 按 `N`。
- 实际：进入新一轮（等价于「继续」），行为无害且与 README「N = 结束当前轮并开始下一轮」的语义不冲突（暂停时当前轮已结束），但按钮被隐藏而快捷键仍可用，交互一致性略有差异。
- 结论：**设计取舍/低风险**，是否收口由 Lead 决定（隐藏时同步忽略 N，或暂停态也保留「下一轮」语义按钮）。
- 证据：`tests/e2e.cjs` B9（暂停后空格继续）/ B2（暂停态按钮数量断言）。

#### O4（P3，README 已声明的已知取舍）刷新精度最多回退约 4 秒

- 说明：`SAVE_INTERVAL_MS=4000`，进行中每 4 秒落盘；刷新后恢复为 paused，当前轮按已保存时间收口，因此实际时间最多回退约 4 秒。README「已知取舍」已明确，E2E B5 用 ±6 秒容差验证而非精确相等，**不是缺陷**。

---

## 8. 非缺陷 / 设计取舍核查（避免误报）

1. **到达目标不自动暂停/结束**：B4 越过目标后继续跑 10 分钟仍为 running，只提示一次并进入绿色「目标已达成」状态；符合 v2 需求。
2. **暂停即结束当前轮但任务不结束**：B2/B11 验证；暂停后按钮仅「继续 + 完成」，「下一轮」按钮 `hidden` 且计算样式 `display:none`（Chrome UA `[hidden]{display:none !important}`），不是死按钮。
3. **「下一轮」没有确认弹窗**：B3/B10 明确断言 `modalOpen=false`；连点只推进一轮。
4. **0–1 秒轮次不计**：单测 999/1000ms 边界 + E2E B11 亚秒暂停/下一轮/收口均不计；0 轮任务完成不生成记录。
5. **记录同时包含实际与目标**：记录卡片 `实际 X / 目标 Y` 文案与持久化字段一致，达成条宽度按 `实际/目标` 计算、超目标封顶 100% 并带 `is-reached`。
6. **目标达成提示只弹一次**：B4 越过目标后继续 10 分钟，`已达到目标` toast 计数保持 1。
7. **刷新恢复不丢轮次/时间**：B5/B6；恢复为 paused 并结束当前轮，轮次与累计时间保留（误差在 4 秒保存间隔内）。
8. **v1 数据兼容**：B13 用真实 v1 session/record 结构验证迁移；旧版记录仍能显示轮次与实际/目标。
9. **`session.rounds` 不再有 per-round target**：单测明确断言 `rounds[0].targetMs === undefined`，与 v2 需求「目标作用于整个任务」一致。
10. **音效/彩带**：headless 无声音输出，仅验证开关状态、持久化与无异常；不判定实际发声。

---

## 9. 未覆盖 / 已知限制

| 项 | 说明 |
| --- | --- |
| 真实时长等待 | 用注入时钟快进，未真跑 25 分钟墙钟；逻辑基于时间戳差值，风险低 |
| 后台标签节流 / 系统休眠 | 未真实验证 Chrome timer throttling；`Date.now` 实现理论上不受节流影响 |
| 多标签页同步 | 仅代码审查（存在 `storage` 事件监听同步 records），未做双页面 E2E |
| 真实触屏手势 | 移动端为 390×844 视口 + DPR2 模拟，未启用触摸事件仿真/真机 |
| 音效发声与彩带视觉 | headless `--mute-audio`，仅验证状态与无异常；彩带为瞬态动画，截图可能捕捉到粒子 |
| localStorage 配额耗尽 / 隐私模式 | 单测用抛错 Storage 替身覆盖安全兜底；未在真实配额耗尽场景验证 |
| 浏览器兼容性 | 仅 Chrome 156（headless）；README 声称支持 Chrome/Edge/Firefox/Safari 最新版，未跨浏览器验证 |
| 500 条记录滚动性能 | 单测覆盖上限；未做大数据量交互性能测量 |
| 可访问性专项 | 未做 axe/WCAG 全面审计（仅验证 aria-pressed/label、键盘路径、`hidden` 几何） |
| v1 报告的旧场景 | 旧语义（倒计时/roundComplete/每轮目标）已整体废弃；v1 报告仅作历史归档 |

---

## 10. 截图清单（`.qa/v2-*.png`，13 张）

| 文件 | 场景 | 尺寸 |
| --- | --- | --- |
| `.qa/v2-desktop-setup-dark.png` | 首屏 · 深色 · 空状态（v2 文案「整个任务」「开始任务」） | 1440×757 |
| `.qa/v2-desktop-session-running.png` | 正计时运行中（05:00 / 33% / 还剩 10:00） | 1440×757 |
| `.qa/v2-desktop-session-paused.png` | 暂停态（已完成 1 轮 · 已暂停，仅继续+完成） | 1440×757 |
| `.qa/v2-desktop-target-reached.png` | 越过目标仍在运行（01:05 / 目标已达成 / 已超出 00:06 / 绿色状态） | 1440×757 |
| `.qa/v2-desktop-records-under-target.png` | 完成记录 · 未达成（实际 15 分钟 / 目标 25 分钟，达成条 60%） | 1440×757 |
| `.qa/v2-desktop-records-reached.png` | 完成记录 · 超目标（实际 11 分钟 / 目标 1 分钟，达成条 100%） | 1440×757 |
| `.qa/v2-desktop-record-delete-toast.png` | 删除记录后的 toast 与「撤销」 | 1440×757 |
| `.qa/v2-desktop-records-empty.png` | 清空记录后的空状态 | 1440×757 |
| `.qa/v2-desktop-setup-light.png` | 浅色主题设置页（提示音关闭） | 1440×757 |
| `.qa/v2-mobile-setup.png` | 移动端设置页 | 780×1688 (390×844@2x) |
| `.qa/v2-mobile-session.png` | 移动端正计时（暂停态前） | 780×1688 |
| `.qa/v2-mobile-paused.png` | 移动端暂停态（仅继续+完成） | 780×1688 |
| `.qa/v2-mobile-records.png` | 移动端完成记录（实际/目标 + 达成条） | 780×1688 |

> 截图由 `node tests/e2e.cjs` 在最终快照上重新生成；脚本结束清理 Chrome 临时 profile，仅保留截图与结果 JSON。

---

## 11. 附录

### 11.1 产物文件

| 文件 | 说明 |
| --- | --- |
| `tests/core.test.js` | **v2 重写**：34 项 node:test 单元测试（纯逻辑、零依赖） |
| `tests/e2e.cjs` | **v2 重写**：16 项 CDP 端到端测试（可控时钟、自动起停 Chrome、截图、console 断言） |
| `qa-report.md` | 本报告（v2） |
| `.qa/e2e-results-v2.json` | 最终 e2e 机器可读结果（tests/consoleErrors/observations/screenshots/environment） |
| `.qa/v2-source-final.sha256` / `.stat` | 最终源码快照 |
| `.qa/v2-source-baseline.sha256` / `.stat` | QA 开始（v2）基线 |
| `.qa/v2-final-run-before.sha256` / `-after.sha256` | 最终验证运行前后的源码 hash |
| `.qa/unit-final.log`、`.qa/e2e-final.log` | 最终验证的原始输出 |
| `.qa/qa-report-v1-archive.md` | 旧 v1 语义 QA 报告（历史归档） |
| `.qa/blank.html` | E2E 同源清理页 fixture（不加载应用脚本） |
| `.qa/v2-*.png` | 13 张 v2 关键截图 |

### 11.2 harness 摘要

- `QA_ONLY=B2,B4 node tests/e2e.cjs` 可只跑指定场景。
- 每个场景重置到 `2026-10-24 10:00`（可控时钟）并清空 localStorage；`refresh()` 保留 localStorage 与时钟偏移以验证持久化恢复。
- 断言失败不中断套件：每个场景独立重置，最终退出码 1。
- 失败信息统一包含 label + 期望 + 实际；B16 汇总全流程 console 错误与未捕获异常。

### 11.3 最终验证记录

```
2026-10-24T03:03:5xZ  记录最终快照 sha256（§2；styles.css 最后变更 03:02:27）
2026-10-24T03:04:02Z  node --test tests/core.test.js
                      → ℹ tests 34 / pass 34 / fail 0（duration 205ms）
2026-10-24T03:04:02Z  node tests/e2e.cjs 开始
2026-10-24T03:04:40Z  node tests/e2e.cjs 结束
                      → 测试 16 / 通过 16 / 失败 0；console 错误 0；警告 0；截图 13 张
2026-10-24T03:04:5xZ  sha256sum 运行前后比对 → 4 个源码文件 hash 完全一致
```

**最终结论：v2 语义在当前快照上功能验证通过，可合并。** 无 P0/P1/P2 功能缺陷；P3 观察项（O1/O4 为 README 已声明取舍，O2 仅损坏数据可见，O3 为交互一致性小差异）均不影响正常使用。
