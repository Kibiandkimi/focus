# Focus v3.1 — 独立 QA 报告（任务耗时 = 各轮实际专注之和，不含暂停）

- 报告人：**qa-v3**（独立 QA，teammate；不参与应用实现，只写 `tests/`、`.qa/`、`qa-report.md`）
- 测试对象：`/home/kibi/Work/Focus`（`index.html`、`styles.css`、`focus-core.js`、`app.js`）
- 适用版本：**schema v3.1**（任务清单 + 每轮预期专注；任务耗时改为各轮实际专注之和，暂停不计入）
- 报告日期：2026-10-25（v3 报告升级为 v3.1；v3 首版验证记录见 `.qa/v3-e2e-results-wallclock-archive.json`）
- 规格来源：用户反馈 + Lead 修正后的 v3.1 语义（task-7）+ `focus-core.js` 暴露的 API / 存储键

## 1. 结论摘要

**通过。** v3.1 语义修正已全部落地并有回归断言保护，未发现 P0/P1 遗留缺陷：

| 项目 | 结果 |
| --- | --- |
| 单元测试 `node --test tests/core.test.js` | **66 / 66 通过**（exit 0，约 0.23s） |
| 端到端 `node tests/e2e.cjs` | **10 / 10 场景通过，367 项断言**（exit 0，约 26s） |
| Console error / 未捕获异常 | **0**（整个 e2e 会话，含所有场景与刷新） |
| P0 / P1 / P2 遗留缺陷 | **0 / 0 / 0** |
| 本轮修复 | **P1 语义缺陷 1 个**：暂停时间被计入任务耗时 → 已由 Lead 修正，QA 复测通过（§7） |
| 历史缺陷 | v3 首轮的 3 个 P2（开始弹窗回填/Tab 焦点/清空后撤销）仍保持修复，回归断言全部通过 |
| 源码修改 | 无（QA 只写 `tests/`、`.qa/`、`qa-report.md`） |

关键结论：

- **任务耗时 = 各轮实际专注之和**；运行中 = 已完成轮次专注 + 当前轮实际专注；**暂停时冻结、不增长**；
  完成记录的 `taskDurationMs` 恒等于 `focusTotalMs`。
- 会话顶部显示「任务耗时 实际 X / 预期 Y」，完成弹窗说明「任务耗时按各轮实际专注累计，不含暂停」。
- `startedAt` / `endedAt` 仅用于记录的时间段展示，不再参与任务耗时计算。
- 旧 v3 记录中曾存过的墙钟任务耗时，在 `normalizeRecord` 时自动修正为各轮专注之和（含回归测试）。
- 其余 v3 行为（任务清单、开始弹窗本轮预期、正计时达标不停、暂停计轮、下一轮、记录/统计/效率、
  刷新恢复、并发阻止、删除、撤销/清空、快捷键、v2 迁移、移动端无横向溢出）全部保持通过。

## 2. 测试环境与工具

| 项 | 值 |
| --- | --- |
| 机器时区 | Atlantic/Reykjavik（UTC） |
| Node.js | v24.22.1（内置 `WebSocket`，e2e 零依赖） |
| 浏览器 | Google Chrome 156.0.8078.47（headless=new） |
| 预览服务器 | 本次验证时 `127.0.0.1:4173` 已不在线；e2e **自动启动** `python3 -m http.server 4181` 并在结束时关闭（兜底路径已被真实验证） |
| CDP 端口 | 9444（`FOCUS_CDP_PORT` 可覆盖） |
| 浏览器 profile / 截图 | `.qa/chrome-e2e-v3`、`.qa/*.png`（均位于 workspace，未用 `/tmp`） |
| 视口 | 桌面 1440×900 @1x；移动端 390×844 @2x（`Emulation.setDeviceMetricsOverride`） |
| 时钟 | **冻结可控时钟**：`Page.addScriptToEvaluateOnNewDocument` 覆盖 `Date.now`，基准为真实秒级时间，仅 `window.__qa.advance(ms)` 推进，测试执行耗时不会引入漂移 |
| 主题/动效 | 深/浅色均测；e2e 全程模拟 `prefers-reduced-motion: reduce` 以保证截图稳定（不影响业务断言） |
| 干净状态 | 同源 `.qa/blank.html`（不加载应用脚本）→ `localStorage.clear()` → 回到 `index.html`，规避 `beforeunload` 回写旧会话 |

## 3. 源码 hash（v3.1 最终验证）

QA 开始时（2026-10-25 09:32）记录基线 `.qa/v31-source-baseline.sha256`，最终完整重跑前后校验一致
（见 `.qa/v3-source-final.sha256` / `.qa/v3-source-final.stat`；e2e 结果内亦带 `sourceHashes`）：

| 文件 | v3 首版验证（2026-10-24） | **v3.1 最终验证（2026-10-25）** |
| --- | --- | --- |
| `index.html` | `743610dd…`（未变） | `743610dd02571e92e42cb945beb54a2e19765b5f8b61cc12e45573637a112cd9` |
| `focus-core.js` | `a5b2b88a…` | `92ad7e59864e8f2de4b27cfb20f675c56d69703f5874525e66dd95b3fc3bbc77`（任务耗时语义修正） |
| `app.js` | `6f5d20f3…` | `95fcd54a416849616428d2acba50135343496245813719c6891e4b842b4f53cd`（会话 meta / 完成弹窗文案） |
| `styles.css` | `e34281dd…` | `e34281dd4596acf9ca72ec310fa7524c1be9f9839537f2a2f0febb3d62d47335`（设计定稿，未再变动） |
| `README.md` | — | `916eb3883939bbac2c4ae0bb0d0e1349f109eba6abd5d60836c92cd4bd2097c3`（Lead 同步 v3.1 语义文档，非 QA 修改） |

> **最终验证运行**：2026-10-25 09:35:42–09:36:08 UTC（e2e）与 09:36 UTC（core），
> 日志 `.qa/v3-e2e-final.log` / `.qa/v3-core-final.log`；e2e 全程 0 console error。
> 说明：`styles.css` 为设计定稿版本；功能断言与 DOM 选择器契约不依赖具体样式，移动端「无横向溢出」按元素几何实时校验。

## 4. 交付物与复现方式

```bash
cd /home/kibi/Work/Focus

# 1) 单元测试（纯逻辑，focus-core.js）
node --test tests/core.test.js
# → ℹ tests 66 / pass 66 / fail 0（exit 0）

# 2) 端到端（自动起停 headless Chrome；4173 不在线时自动起 4181 静态服务器）
node tests/e2e.cjs
# → 场景 10/10 通过 · 断言 367 项 · 已知缺陷 0 项 · console error 0 项，exit 0
```

产物：

| 路径 | 内容 |
| --- | --- |
| `tests/core.test.js` | v3.1 核心逻辑单元测试（node:test + assert/strict，66 用例） |
| `tests/e2e.cjs` | CDP 端到端测试（10 场景，自动起停 Chrome/预览服务器） |
| `.qa/v3-e2e-results.json` | 最近一次完整 e2e 结果（场景/断言/console/源码 hash） |
| `.qa/v3-*.png` | 12 张桌面/移动端、深/浅色关键截图（数值已按 v3.1 重出，索引见 §10） |
| `.qa/v3-source-final.sha256` / `.qa/v3-source-final.stat` / `.qa/v31-source-baseline.sha256` | 源码 hash 基线 / 最终 / 校验记录 |
| `.qa/v3-e2e-final.log` / `.qa/v3-core-final.log` | 最终两条命令的完整输出日志 |
| `.qa/v31-user-feedback-fix.md` | 本轮「暂停不计任务耗时」语义修正的 before/after 证据与回归断言清单 |
| `.qa/v3-defects-prefix-evidence.md` | v3 首轮 3 个 P2 修复前证据归档 |
| `.qa/v3-e2e-results-wallclock-archive.json` | v3 旧语义（墙钟含暂停）最后一次 e2e 结果归档（对照用） |
| `.qa/qa-report-v2-archive.md` | 旧 v2 QA 报告归档（sha256 `cc54730d…`） |

## 5. v3.1 规格 → 测试覆盖矩阵

| # | v3.1 规格 | 覆盖位置 | 关键断言（示例） |
| --- | --- | --- | --- |
| 1 | 任务清单：多任务，名称 + 预期完成时长 + 单轮预期专注 | e2e S2；core 任务 API | 自定义 90/30、预设 30/15、120/45 三任务倒序；`预期完成 1 小时 30 分钟 · 单轮专注 30 分钟` |
| 2 | 开始专注弹窗：预设 15/25/45/60 + 自定义 1–480，默认取任务计划值 | e2e S3、S4；core clamp | 30 分钟计划 → 自定义框回填 30；0/481 被拦截并 toast；选 15 → `本轮预期 15 分钟` |
| 3 | 会话按轮：只统计本轮实际专注（正计时）；预期到点不自动停 | e2e S4；core `getRoundElapsedMs` 等 | 5→17 分钟持续累加；`本轮达标` 后仍 running、仍 0 轮；达标绿色态由 data 属性断言 |
| 4 | 暂停=结束当前轮并计轮，任务不结束；可选下一轮预期再继续；运行中「下一轮」 | e2e S4；core `pauseSession`/`resumeSession`/`startNextRound`/`setNextExpectedFocusMs` | 18 分钟暂停 → 1 轮/实际 18；改 20 分钟继续 → 第 2 轮预期 20；下一轮 → 第 3 轮 |
| **5** | **任务耗时 = 各轮实际专注之和（不含暂停）**；运行中 = 已完成轮 + 当前轮，暂停冻结；任务越快越好、专注越长越好 | e2e S3/S4/S6/S7；core `getTaskElapsedMs`/`completeSession`/`normalizeRecord` | 暂停 7 分钟：任务耗时保持 18 分钟（不涨到 25）；完成记录任务耗时 43 = 总专注 43；键盘流程 10 = 专注和 10 |
| 6 | 完成记录：任务预期 vs 实际耗时（不含暂停）、每轮预期 vs 实际专注（平均/总计/轮次）、日期时间段 | e2e S4、S7；core `normalizeRecord`/`recordMetrics` | 3 轮 18/15、21/20、4/20；记录 `实际 43 分钟 / 预期 2 小时（快 1 小时 17 分钟）`、`平均 14 分钟/轮 · 预期 18 分钟`；时间段仅作展示 |
| 7 | 暂停后可返回清单（显示进度/可继续）；同一时间仅一个进行中任务，其他开始被阻止 | e2e S6 | 活动行置顶、`暂停中 · 已专注 3 分钟 · 1 轮`；其他按钮 `is-disabled` + toast 阻止；继续弹窗显示进度 |
| 8 | 删除任务需确认；删除进行中任务结束会话且不生成记录 | e2e S6 | 取消保留；进行中删除提示「不会生成完成记录」；删除后无记录、会话清空 |
| 9 | 刷新恢复：running → 结束后恢复 paused，轮次与实际专注时间不丢 | e2e S6、S10；core `restoreSession` | 运行中刷新 → 2 轮、当前轮 2 分钟、任务耗时 = 3+2 = 5 分钟；孤儿会话补建待办并恢复 10 分钟轮次 |
| 10 | 今日统计：专注总时长、平均每轮（对比预期）、完成任务数/轮次、连续天数；任务耗时与专注均值对比（任务耗时不含暂停） | e2e S4、S9；core `summarize` | 今日专注 43 分钟 / 平均 14（预期 18）/ 1 个 / 共 3 轮 / 连续 1 天；效率行任务 `43 分钟 / 2 小时 · 快 1 小时 17 分钟`、专注 `-4 分钟` |
| 11 | 记录列表：实际/预期 + 快慢差异；删除撤销、清空、刷新持久化 | e2e S4、S5；core `sanitizeRecords`/`addRecord` | 删除→撤销恢复；清空需二次确认；清空同步清空旧撤销 toast；刷新后为空 |
| 12 | v2 迁移：旧 records→完成记录、旧 session→待办任务，不报错不丢数据；旧 v3 墙钟任务耗时会被修正 | e2e S9；core 迁移/修正用例 | 2 条 v2 记录 + 1 个 v2 会话 + v1 设置全部迁移；旧键保留；旧 v3 记录 90 分钟墙钟 → 45 分钟专注和 |

## 6. 单元测试清单（`tests/core.test.js`，66 用例）

按组统计（完整用例名见附录 A）：

| 组 | 覆盖内容 | 用例数 |
| --- | --- | --- |
| API / 常量 | 规格要求的全部导出函数、VERSION=3、`focus.*.v3` 存储键、min/max/默认值 | 2 |
| clamp / 格式化 | 任务 1–1440、专注 1–480、默认回退；`formatClock`(ceil)/`formatElapsed`(floor)/`formatSpan`/`minutesLabel`/日期工具 | 7 |
| 任务 | create/normalize/sanitize/add/remove/find、标题清洗 60 字符、id、不可变输入 | 4 |
| 会话与轮次 | create/normalize、轮次实际/剩余/超时/进度/达标、总专注/平均专注、**任务耗时=已完成轮+当前轮（暂停冻结）**、`getLastRound` | 7 |
| 暂停 / 继续 / 下一轮 | 0ms/999ms/1000ms 轮边界、暂停计轮（含 `roundElapsedMs` 累计）、resume、`setNextExpectedFocusMs`、运行中/暂停中 `startNextRound` | 9 |
| 完成 / 任务耗时（完整流程） | 无轮次拒绝；**`taskDurationMs === focusTotalMs`**；暂停不计数；墙钟小于/大于专注的边界；混合预期加权；完成时 paused 保留轮次；完整 flow；**「暂停 7 分钟不计任务耗时」专项** | 8 |
| 刷新恢复 | running→paused 收口不丢专注时间、<1s 轮丢弃、paused 原样、坏 payload 降级 | 4 |
| 记录模型 / 指标 | v3 往返、**旧 v3 墙钟值修正为专注和**、坏数据拒绝、v2 字段迁移、roundsTotal 一致性、`recordMetrics`（加权/快慢/空值） | 9 |
| 记录列表 / 统计 | 排序/去重/500 上限、add/remove/group、今日聚合（任务耗时为专注和）、streak、last7、无 dateKey 回退 | 6 |
| 存储与迁移 | tasks/session/records/settings 往返、坏 JSON、storage 抛异常、v2 session→todo、v2 records→v3、损坏 v3 仍迁移、设置迁移 | 9 |
| 集成 | 刷新恢复 → 完成（任务耗时=专注和）→ 记录 → summarize 全链路 | 1 |

## 7. 缺陷清单

**P0：无。P2 遗留：无。** 本轮（v3.1）由用户反馈暴露并修复 1 个 **P1 语义缺陷**；
v3 首轮的 3 个 P2 修复保持有效，相关回归断言在 v3.1 源码上全部通过。

### 7.1 本轮修复：P1 — 暂停时间被计入「任务耗时」（用户反馈）

| 项 | 内容 |
| --- | --- |
| 级别 / 状态 | **P1** / 已修复并回归复测 |
| 现象 | v3 中任务耗时 = 首次开始→完成的墙钟时间，暂停/离开时间被计入；用户反馈「暂停时间不该算进任务完成时间」 |
| 期望 | 任务耗时 = 各轮实际专注之和，不含暂停；运行中 = 已完成轮专注 + 当前轮专注；暂停冻结 |
| 修复 | `focus-core.js`：`getTaskElapsedMs` 改为专注和口径；`completeSession().taskDurationMs = focusTotalMs`；`normalizeRecord()` 强制 `taskDurationMs = round(focusTotalMs)`（自动修正旧 v3 墙钟记录）。`app.js`：会话 meta 改为「任务耗时 实际 X / 预期 Y」；完成弹窗说明改为「任务耗时按各轮实际专注累计，不含暂停」 |
| 证据 | 修复前/后数值与断言清单：`.qa/v31-user-feedback-fix.md`；旧语义 e2e 结果归档 `.qa/v3-e2e-results-wallclock-archive.json` |
| 回归断言 | core：`getTaskElapsedMs: sum of actual focus time (pauses excluded)`、`task duration: a 7 minute pause between rounds is not counted`、`completeSession: task duration excludes paused gaps`、`completeSession: task duration always equals the focus total`、`normalizeRecord: old v3 record with wall-clock duration is corrected`；e2e S4/S6/S7 多处 |

### 7.2 历史 P2（v3 首轮，保持修复/已复测）

| ID | 级别 | 状态 | 缺陷 | 修复方式 | 回归断言 |
| --- | --- | --- | --- | --- | --- |
| P2-01 | P2 | 已修复/已复测 | 开始专注弹窗默认取非预设计划值时自定义输入框为空 | `app.js` `sync()` 非预设回填分钟数 | e2e S3：`customValue === '30'` |
| P2-02 | P2 | 已修复/已复测 | 清空记录后残留删除撤销 toast 仍能恢复记录 | 清空记录时同步清空 toast 栈 | e2e S5：清空后无 toast-action 且记录保持 0 |
| P2-03 | P2 | 已修复/已复测 | 开始专注弹窗 Tab 无法到达时长 chip/输入 | 新增 `getModalFocusables()` 收集正文可聚焦元素 | e2e S3：Tab 序列出现弹窗内 INPUT/BUTTON |

证据留档：`.qa/v3-defects-prefix-evidence.md`（修复前实测值）。

## 8. 关键正确性数据摘录（v3.1 口径）

同一任务（预期完成 2 小时、计划单轮 25 分钟，本轮选择 15 分钟）的完整流程，冻结时钟快进得到：

| 事件 | **任务耗时（各轮专注和）** | 本轮专注 | 本轮预期 | 累计专注 | 已完成轮次 |
| --- | --- | --- | --- | --- | --- |
| 开始 | 0 | 0 | 15 | 0 | 0 |
| 5 分钟 | 5 分钟 | 5 分钟 | 15（还剩 10:00） | 0 | 0 |
| 17 分钟（超预期 2 分钟） | 17 分钟 | 17 分钟 | 本轮达标、不自动停 | 0 | 0 |
| 18 分钟暂停 | 18 分钟 | 18 分钟 | 15 | 18 分钟 | 1 |
| **暂停 7 分钟后** | **18 分钟（冻结，不增长）** | 仍 18 分钟 | — | 18 分钟 | 1 |
| 改下一轮预期 20 分钟并继续 +21 分钟 | 39 分钟（18+21） | 21 分钟 | 20（超 1 分钟） | 39 分钟 | 2 |
| 「下一轮」+4 分钟后完成 | **43 分钟（18+21+4）** | 4 分钟 | 20 | 43 分钟 | 3 |

完成记录（UI 与 localStorage 双向断言）：`任务耗时 实际 43 分钟 / 预期 2 小时（快 1 小时 17 分钟）`；
`专注 3 轮 · 共 43 分钟 · 平均 14 分钟/轮（预期 18 分钟）`；`record.taskDurationMs === record.focusTotalMs === 43 分钟`；
`startedAt`/`endedAt` 仅用于记录时间段；今日概览：专注 43 分钟、平均 14（预期 18）、完成任务 1（共 3 轮）、连续 1 天；
效率对比任务 `43 分钟 / 2 小时 · 快 1 小时 17 分钟`（绿色）、专注均值 `-4 分钟`（警示色）；
近 7 天柱今日有高度；`focus.session.v3` 清除、`focus.records.v3` 与 `focus.tasks.v3` 持久化。

其他经断言的关键数据：

- 暂停期间（S4）`#sessionTaskElapsed` 与 meta 均保持 18 分钟不增长；继续后仍从 18 起累计。
- 键盘流程：空格暂停/继续、N 换轮、Enter 完成、Esc 关弹窗；**记录任务耗时 = 专注和 10 分钟**（快 50 分钟），
  不再使用墙钟 12 分钟。
- 刷新恢复：运行中刷新 → paused、2 轮、当前轮 2 分钟、任务耗时 = 3+2 = 5 分钟；任务清单不重复（3 个任务）。
- 孤儿会话：仅存 `focus.session.v3`（任务不在清单）→ 自动补建「孤儿任务」待办并恢复 1 轮 10 分钟。
- v2 迁移：2 条旧记录（15/25、20/15 分钟）+ 旧会话（45 分钟）+ 旧设置（light、30 分钟）全部迁移；
  旧键保留；`今日 任务 2 / 共 3 轮 / 平均 12 / 预期 —`；无 console error。
- 旧 v3 记录修正：`taskDurationMs: 90 分钟（墙钟）` + 专注和 45 分钟 → normalize 后 45 分钟，时间段字段保留。

## 9. 已知取舍 / 未覆盖范围

**产品已知取舍（与实现/README 一致，非缺陷）**

- **任务耗时不包含暂停**（v3.1 用户确认语义）：暂停只用于分轮；运行中任务耗时 = 已完成轮专注 + 当前轮实际专注，
  暂停期间冻结；`startedAt`/`endedAt` 只作为时间段展示。
- 旧 v3 记录若存过墙钟任务耗时，读取时会被**不可逆地修正**为各轮专注之和（符合新语义；时间段字段保留原值）。
- 轮次最短 1 秒（`MIN_ROUND_MS=1000`）：不足 1 秒的轮次不计入轮次，避免误触空轮。
- 刷新/崩溃精度：运行中每 4 秒落盘一次 + `beforeunload` 落盘；恢复时以最后 `savedAt` 收口当前轮，正常刷新不丢专注时间；
  浏览器崩溃/强杀（无 beforeunload）最多回退约 4 秒。
- 显示精度：时长文案按整分钟四舍五入（`formatSpan`），计时器秒级向下取整；差异 <30 秒显示「持平」。
- 连续天数：若今天尚无记录，则从昨天起向前统计连续天（常见 streak 口径）。
- 「结束本次专注」（×）丢弃本次轮次、不生成记录；任务保留，之后重新开始会重置任务计时。
- v2 迁移记录没有每轮预期（旧 rounds 只有实际值），其「专注均值 · 预期」显示 `—`、差异为空（数据诚实）。
- 删除进行中任务会结束会话且不生成记录（规格明确要求）。

**未覆盖 / 局限**

- E2E 仅在 Linux headless Chrome 156 单浏览器验证；未覆盖 Firefox/Safari、真实移动设备触摸、真实系统时钟跨天/休眠。
- 时钟为冻结+快进，未验证真实 `setInterval` 节流、跨日切换、系统时间回拨等场景（核心纯逻辑的 `now` 参数化已覆盖边界）。
- 提示音（Web Audio）、彩带、动画细节仅保证不报错/不阻塞，不做听感/帧率断言；e2e 用 reduced-motion 稳定截图。
- 移动端仅 390×844（另做 1440×900 桌面）；平板断点未逐一截图。
- 跨标签页 `storage` 事件仅代码层检查，未做双标签页并发编辑压测。
- localStorage 容量/写入失败（quota）在 core 以异常注入覆盖，未在浏览器中实测。

## 10. 截图索引（`.qa/v3-*.png`，v3.1 数值已重出）

| 文件 | 视口/主题 | 内容 |
| --- | --- | --- |
| `v3-desktop-empty-dark.png` | 1440×900 深色 | 干净初始状态：空任务清单、空记录、今日 0 |
| `v3-desktop-tasks-dark.png` | 1440×900 深色 | 三个任务（含自定义 90/30）+ 表单默认值 |
| `v3-desktop-tasks-light.png` | 1440×900 浅色 | 浅色任务清单 + 侧栏记录/统计 |
| `v3-desktop-start-modal.png` | 1440×900 深色 | 开始专注弹窗；任务计划 30 分钟 → 自定义框回填 30（P2-01 回归） |
| `v3-desktop-session.png` | 1440×900 深色 | 运行中 17:00、本轮达标绿色态；顶部 meta 为「任务耗时 实际 17 分钟 / 预期 2 小时」 |
| `v3-desktop-paused.png` | 1440×900 深色 | 暂停态：已完成 1 轮、实际 18/预期 15、任务耗时 18 分钟（冻结）、下一轮预期面板 |
| `v3-desktop-complete-modal.png` | 1440×900 深色 | 完成任务弹窗：实际 43 分钟 / 预期 2 小时（快 1 小时 17 分钟）+「不含暂停」说明 |
| `v3-desktop-records-dark.png` | 1440×900 深色 | 完成记录（任务耗时 43/2 小时·快 1h17；专注均值 14/18·-4）、今日概览、近 7 天 |
| `v3-desktop-records-light.png` | 1440×900 浅色 | 同上，浅色主题 |
| `v3-mobile-tasks.png` | 390×844 深色 | 移动端任务清单（无横向溢出） |
| `v3-mobile-session.png` | 390×844 深色 | 移动端专注会话 04:00（任务耗时 meta，新文案；无横向溢出） |
| `v3-mobile-paused.png` | 390×844 深色 | 移动端暂停态 + 下一轮预期面板（按钮/面板不超视口） |

## 11. 归档

- 旧 **v2** QA 报告：`.qa/qa-report-v2-archive.md`（sha256 `cc54730d…`）
- 更早 v1 报告：`.qa/qa-report-v1-archive.md`（历史留存）
- v3 旧语义（墙钟含暂停）最后一次 e2e 结果：`.qa/v3-e2e-results-wallclock-archive.json`
- v3 首轮 3 个 P2 修复前证据：`.qa/v3-defects-prefix-evidence.md`
- 本轮 P1 语义修复证据：`.qa/v31-user-feedback-fix.md`
- e2e 明细结果：`.qa/v3-e2e-results.json`

## 12. 建议（非阻塞，P3）

1. `focus-core.js` 顶部文件注释仍写着 "task duration is the wall-clock time ... (includes pauses)"，与 v3.1 实现不符；
   建议同步为「各轮实际专注之和」，避免后续维护误读（仅注释，不影响功能）。
2. 可考虑为开始专注弹窗补充 `aria-describedby`/错误文本 `role=alert`，让屏幕阅读器直接播报自定义时长越界信息。
3. e2e 可加入跨日快进（推进 24h）验证「今日统计/连续天数」在真实日期翻转时的 UI 刷新（当前由 core `summarize` 单元测试覆盖）。
4. 若要上线 GitHub Pages，建议把本 QA 脚本接入 CI（Node 24 + Chrome headless），每次改动跑 `node --test` + `node tests/e2e.cjs`。

---

## 附录 A：单元测试用例全名（66）

```text
v3 API surface: every documented export exists
constants: VERSION=3, v3 storage keys, limits and defaults
clampExpectedTaskMs: default, min, max, rounding
clampExpectedFocusMs: default, min, max
formatClock rounds up, formatElapsed rounds down
formatSpan: below a minute, minutes, hours
minutesLabel: whole-minute label used by today stats
formatTimeOfDay / dateKey / parseDateKey
formatDayLabel: 今天 / 昨天 / same-year / other-year / raw key
createTask: defaults, trimming, clamping, generated id
createTask: title limited to 60 chars, unique ids
normalizeTask: rejects invalid shapes, keeps + clamps valid ones
sanitizeTasks / addTask / removeTask / findTask
createSession: derives plan from task, custom round expectation wins
normalizeSession: invalid → null, phases + rounds sanitized
getRoundElapsedMs: running stopwatch, paused frozen, clamped at zero
getCompletedRounds / getFocusTotalMs / getAverageFocusMs
getTaskElapsedMs: sum of actual focus time (pauses excluded)
round target helpers: expected / actual / remaining / overtime / progress / reached
getLastRound
pauseSession: ends + counts the running round, keeps the task paused
pauseSession: 0ms / 999ms rounds are not counted, 1000ms is
pauseSession: pausing an already paused session is a safe no-op
setNextExpectedFocusMs: changes only the next round plan, clamps input
resumeSession: paused → running with the next round plan
resumeSession: default plan is the paused session nextExpectedFocusMs
startNextRound from running: ends current round and starts another immediately
startNextRound: sub-second current round is skipped, new round still starts
startNextRound from paused: starts a round with nextExpectedFocusMs, counts nothing
completeSession: rejects sessions with no countable round
completeSession: running session records expected vs actual task + rounds
completeSession: task duration excludes paused gaps
completeSession: task duration always equals the focus total
completeSession: mixed round expectations weight the focus target
completeSession: completing while paused keeps all recorded rounds
full session flow: expected/actual metrics line up with the v3 spec
task duration: a 7 minute pause between rounds is not counted
restoreSession: running session is closed as a round and becomes paused
restoreSession: sub-second open round is dropped, previous rounds kept
restoreSession: already paused session stays paused with rounds intact
restoreSession: invalid payloads return null / degrade safely
normalizeRecord: v3 record round-trips
normalizeRecord: old v3 record with wall-clock duration is corrected
normalizeRecord: rejects missing title / timestamps / zero focus
normalizeRecord: legacy v2 field names migrate
normalizeRecord: legacy object rounds without actualMs are dropped safely
normalizeRecord: roundsTotal/roundsWithExpected are coherent
recordMetrics: current v3 record
recordMetrics: focus target weighted by roundsWithExpected, not roundsTotal
recordMetrics: faster than expected is positive, slower is negative
sanitizeRecords: sort desc, drop junk, cap at MAX_RECORDS
addRecord / removeRecord / groupRecords
summarize: empty records produce an all-zero summary
summarize: aggregates today only, keeps overall total
summarize: streak breaks on a gap and counts from yesterday if today is empty
summarize: record without dateKey falls back to endedAt day
storage: tasks round-trip and bad data falls back safely
migration: v2 session becomes a todo task (old keys preserved)
migration: v3 tasks win over the legacy session when both exist
migration: v2 records become v3 records under the new key
migration: corrupt v3 records key still migrates legacy records
migration: v3 records win over legacy records
settings: defaults, normalization and v2 migration
session storage: save / load / clear round-trip
records storage: save / load round-trip with sanitization
integration: refresh recovery keeps rounds, then the record stays honest
```

## 附录 B：E2E 场景与断言数（v3.1 最终运行）

| 场景 | 断言数 | 说明 |
| --- | --- | --- |
| S1 初始状态（干净 origin） | 24 | 空任务/空记录/零统计/默认深色/settings 初始化 |
| S2 任务清单：自定义校验 / 多任务 / 默认值持久化 | 28 | 空标题、1441、481 越界、自定义任务、三任务顺序、刷新持久化、无横向溢出 |
| S3 开始专注弹窗：默认计划值 / 自定义校验 | 33 | 默认 30 回填（P2-01）、0/481 拦截、Tab 可达（P2-03）、启动会话初态与新 meta |
| S4 主流程：正计时 → 达标不停 → 暂停计轮 → 改预期 → 下一轮 → 完成记录 | 126 | 5/17/18/18/39/43 分钟节点（暂停 7 分钟不涨）；记录=专注和、弹窗/今日效率新数值、主题/刷新持久化 |
| S5 记录操作：删除撤销 / 清空确认 / 持久化 | 27 | 删除撤销、清空二次确认、清空同步清空旧撤销（P2-02）、刷新后为空 |
| S6 返回清单 / 继续 / 阻止并发任务 / 刷新恢复 / 删除任务 | 62 | 活动行置顶/进度、并发阻止、继续弹窗、运行中刷新恢复（任务耗时=专注和）、×/删除/0 轮完成 |
| S7 键盘快捷键（空格 / N / Enter / Esc） | 20 | 暂停/继续/换轮/完成、Esc 关弹窗、记录任务耗时=专注和 10 分钟（快 50） |
| S8 移动端 390×844 无横向溢出 | 13 | 任务/运行/暂停三视图 scrollWidth 与按钮/面板几何 |
| S9 v2 数据迁移（records / session / settings） | 23 | 记录/会话/设置迁移、旧键保留、统计生效、无 console error |
| S10 孤儿会话恢复：任务不在清单时补建待办 | 11 | 运行中刷新→paused、10 分钟专注、补建任务可继续 |
| **合计** | **367** | 场景 10/10 通过，exit 0，console error 0 |

> 断言计数为脚本内 `assertEq/assertOk/assertIncludes/assertMatches/assertDeepEq` 的调用次数（含逐元素循环断言），
> 不是 node:test 的用例数。

---

## 附录 C：最终复跑记录（v3.1）

设计定稿后（`styles.css` 未再变动），在 v3.1 源码上完整复跑：

| 文件 | 最终 hash |
| --- | --- |
| `focus-core.js` | `92ad7e59864e8f2de4b27cfb20f675c56d69703f5874525e66dd95b3fc3bbc77` |
| `app.js` | `95fcd54a416849616428d2acba50135343496245813719c6891e4b842b4f53cd` |
| `index.html` | `743610dd02571e92e42cb945beb54a2e19765b5f8b61cc12e45573637a112cd9` |
| `styles.css` | `e34281dd4596acf9ca72ec310fa7524c1be9f9839537f2a2f0febb3d62d47335` |

```
node --test tests/core.test.js  → tests 66 / pass 66 / fail 0
node tests/e2e.cjs              → 场景 10/10、断言 367 项、0 known defect、0 console error
```

运行时间：2026-10-25 09:35:42–09:36:08 UTC（e2e），09:36 UTC（core）。
环境备注：本次 `127.0.0.1:4173` 预览服务不在线，e2e 自动启动 4181 静态服务器并正常完成、退出时清理。

---

## 附录 D：Lead 注释同步与最终复跑（v3.1 定稿）

按 QA 的 P3 建议，同步了 `focus-core.js` / `app.js` 顶部注释（仅注释，逻辑未变，任务耗时明确为「各轮实际专注之和，不含暂停」）。最终源码在 2026-10-25 由 Lead 完整复跑：

| 文件 | 最终 hash |
| --- | --- |
| `index.html` | `743610dd02571e92e42cb945beb54a2e19765b5f8b61cc12e45573637a112cd9` |
| `app.js` | `4fe384486d34eefb41ea6a8ad9687ce9504502ebd52f93f850193d47a6cd7fa7` |
| `focus-core.js` | `37dc29a8f7240971cee80a3b4575f40e6a983bde87683c0eebcaa9f18a57ad0a` |
| `styles.css` | `e34281dd4596acf9ca72ec310fa7524c1be9f9839537f2a2f0febb3d62d47335` |
| `README.md` | `916eb3883939bbac2c4ae0bb0d0e1349f109eba6abd5d60836c92cd4bd2097c3` |

```
node --test tests/core.test.js  → 66 pass / 0 fail
node tests/e2e.cjs              → 10/10 场景、367 项断言通过、0 console error
```

注：`app.js` / `focus-core.js` 与 QA v3.1 最终运行相比只有顶部注释差异，功能与断言完全一致。QA 的 P3 注释不一致问题已关闭。
