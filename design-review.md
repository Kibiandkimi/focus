# Focus · 视觉打磨设计评审（design-review）

- 日期：2026-10-24
- 范围：仅修改 `styles.css`（+ 本文件与 `.design/` 截图）；**未修改** `index.html` / `app.js` / `focus-core.js`。
- 基线：以 Lead 在 `styles.css` 上完成的 `[hidden] { display:none !important; }`（roundComplete 隐藏「暂停」）与弹窗/彩带层级修复为起点，未回退。
- 结论：**通过**。所有状态（setup / running / paused / roundComplete / 记录空与多条 / 弹窗 / toast）在 1440×900、1024×768、768×1024、390×844 深色与浅色下均无横向溢出、无文本截断、无对比度不达标；键盘 focus-visible、reduced-motion、触控尺寸均已覆盖。

---

## 1. 自检方法

- 用 `.design/shots.cjs`（CDP，端口 9445）驱动 headless Chrome，注入 `localStorage` 复现各状态，逐状态截图并跑 DOM 审计：
  - 横向溢出：`documentElement.scrollWidth > clientWidth` + 逐元素盒模型越界扫描；
  - 文本截断：除 `text-overflow: ellipsis` / 可滚动容器外，扫描 `scrollWidth > clientWidth` 的文本节点；
  - 对比度：按祖先背景逐层 alpha 合成（含渐变叠层）计算前景/背景 WCAG 比值，大字号按 3:1、常规按 4.5:1 判定；
  - 触控目标尺寸、关键容器几何（`rects`）、`prefers-reduced-motion` 生效值；
  - `(hover:hover)/(pointer:fine)` 与 `(hover:none)/(pointer:coarse)` 分别用 Blink flag + CDP touch emulation 精确模拟，桌面/移动截图都反映真实媒体查询结果。
- 键盘态用真实 `Tab` 键事件（`Input.dispatchKeyEvent`）触发 `:focus-visible`；hover 态用 `Input.dispatchMouseEvent`。
- 产物：`.design/before/`（改前 32 张 + audit.json）、`.design/after/`（改后 39 张 + audit.json）、`.design/compare/`（4 张前后对照）。

### 审计结果对比

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 对比度不达标（全部状态合计） | **460 处 / 31 状态** | **0 处 / 37 状态** |
| 横向溢出 | 0 | 0 |
| 文本截断（非省略号） | 0 | 0 |
| 1440×900 页面滚动 | 无 | 无（固定一屏） |
| 1024×768 页面滚动 | 827px > 768，需滚动 | 768px，一屏内 |
| 1440×900 主卡/侧栏高度 | 622 / 493（右栏断裂） | 747 / 747（两栏对齐） |
| 1024×768 主卡/侧栏高度 | 503 / 677（错位 174px） | 622 / 622 |

---

## 2. 主要视觉改动

### 2.1 色调与对比度（核心修复）

- 深色：`--text-faint #74757f → #8d8e99`（卡片上 3.76 → 5.09），`--text-muted` 微调至 `#a9aab4`；faint/muted 仍保持清晰层级。
- 浅色整体重标：
  - `--text-muted #6c655a → #5a5247`（7.56）、`--text-faint #9b9285 → #6f675c`（卡片 5.48 / 页面 4.90）；浅色里所有小号标签（日期、记录 meta、周柱标签、页脚、字段说明）从 2.6–3.0 提升到 4.9+。
  - 主色由亮橙 `#cf6337` 调整为深赭 `--accent #b04a1c` / `--accent-strong #8f3712`；`--accent-contrast` 仍保留奶白。eyebrow、chip 选中、周柱、`开始专注` 渐变、focus halo 同步换色（文字对比 5.38，按钮文字 5.2–7.3）。
  - `--success #2f8f68 → #237b57`（roundComplete 的 11px eyebrow 也达标），`--danger → #b83a30`。
  - 浅色 ring 渐变加深为 `#cc7945 → #b3351a`（进度环在奶白卡片上 3.2:1 起）。
  - 浅色弹窗遮罩改用暖调 `--backdrop: rgba(46,33,20,.36)`，不再用纯黑压暗奶油底。
- 卡片加 `inset 0 1px 0 var(--card-top-hi)` 顶部内高光，深色卡面边界更清晰。

### 2.2 版式骨架：消除底部死区、两栏对齐

- 桌面（≥921px）`app-shell` 固定 `height: 100vh`，`.layout` 单行 `1fr`、`align-items: stretch`，`.stage` 改为纵向 flex 且卡片 `flex: 1`；左卡与右栏**同高、同底**，页脚贴底，1440×900 不再出现 120px 空白。
- 侧栏 `records-card` 弹性填充剩余高度，`records-list` 在卡片内部滚动（桌面不再整页滚动）；空状态在卡内垂直居中。
- ≤920px 恢复自然文档流（`align-items: start`、卡片 `flex: 0`、列表限高），平板/手机照常整页滚动。

### 2.3 计时区（session / ring / timer）

- 环形：轨道 5.5→6、进度 7→7.5，内圈新增 `::before` 柔和内盘（深色顶部微高光 / 浅色奶白渐变），进度 glow 由 10px 收紧到 9px、更克制；暂停态透明度 0.55→0.5/0.68 更明确。
- roundComplete：深色绿环 glow α 0.24→0.2、drop-shadow 14→12，去掉过曝感；浅色新增专用深绿环（`#35a97a → #1c6d4e`）与轨道染色，绿环在白卡上不再"消失"。
- 计时字号 `clamp(52px,6.2vw,76px)`、字距 -0.055em，加 46px 柔和 text-shadow；phase 10.5px/0.3em；副标题 12px。
- session 卡片：`timer-wrap` 上下 `margin:auto`，让圆环在卡片剩余空间里垂直居中，头部贴顶、统计/操作贴底；圆环 304px（1024×768 特例 272px，移动端 250px）。
- 任务名 2 行截断宽度由 `32ch` 改为 `26em`（CJK 下更合理），长任务名不再过早截断或撑破。

### 2.4 setup 表单

- 标题 `clamp(32px,3.6vw,46px)`、副标题 14.5px/1.75（`40ch → 34em` 修 CJK 提前换行）；eyebrow 下距 20→22。
- 输入框 18px 圆角、16px/19px 内距、hover/focus 三级反馈；chip 最小高 40px、13.5px、`自定义` 输入框 26→34px 触控高度，并新增 `.chip-custom:focus-within` 焦点反馈。
- 主 CTA 17px 纵向内距、56px 高、渐变内高光；`kbd ↵` 可读性提升。

### 2.5 侧栏（今日专注 / 近 7 天 / 完成记录）

- 统计数字 26→27px，单位与说明文字 11/11.5px 且全部达到 AA；卡头 18px 下距。
- 近 7 天柱状图：柱高 42→46、圆角 7→9、间距 7→8，今天列加 `accent-ghost` 底 + 边框，hover 有描边反馈；空数据柱提示更明显。
- 记录列表：行内距 9/8→10/10、圆角 14、标题 13.5、meta 10.8→11.5；删除按钮 26px，仅 hover/focus 出现（桌面），触屏常驻 0.55 透明度且放大到 30px；滚动条使用细样式 + `scrollbar-gutter`。
- 空状态图标 44px、标题 13px，提示文案改 `em` 限制宽度，单行显示。

### 2.6 弹窗 / Toast

- 弹窗宽 420→440、内距 28、圆角 26、`border-strong` + 更大投影；标题 17.5、正文 13.5/1.8，按钮 42px 高。移动端按钮等宽分栏。
- Toast 圆角 14→16、内距 13/17、字号 13，新增主色小圆点点缀；右下角 24px，移动端通栏 14px。

### 2.7 交互状态 / 响应式 / 可访问性

- `:focus-visible` 保留全局 accent 2px 外描边（在深/浅底上均可见）；键盘 Tab 顺序验证：任务输入 → 时长 chip → 自定义输入 → `开始专注`（截图 `focus-*`）。
- `@media (hover: none)` 为触屏常驻删除按钮；`@media (prefers-reduced-motion: reduce)` 下动画时长实测 1e-06s、彩带隐藏（原逻辑保留并复核）。
- 移动端：顶栏/图标 42px；表单 14px 边距；控制按钮 3 等分、48px 高；页脚次级文案隐藏；toast 通栏。
- 断点：1080（侧栏 372→344）、920（单列 + 侧栏双卡）、680（手机），另对 `max-height:780px` 桌面做高度压缩特例。

---

## 3. 截图清单

### 改前基线（`.design/before/`，32 张）
- setup：`setup-dark-1440 / setup-light-1440 / setup-dark-1024 / setup-light-1024 / setup-dark-768 / setup-dark-390 / setup-light-390`
- session：`session-running-dark-1440 / session-paused-dark-1440 / session-paused-light-1440 / session-running-light-1440 / session-running-dark-1024 / session-running-dark-768 / session-running-dark-390`
- roundComplete：`session-complete-dark-1440 / session-complete-light-1440 / session-complete-dark-390`
- 记录 / 空状态：`records-empty-light-1440 / records-many-dark-1440 / records-many-light-1440 / records-many-light-1024 / records-many-dark-768 / records-many-dark-390 / records-many-light-390 / hover-record-dark-1440`
- 弹窗 / toast：`modal-discard-dark-1440 / modal-save-dark-1440 / modal-clear-dark-1440 / modal-clear-light-390 / toast-dark-1440`
- 焦点：`focus-input-dark-1440 / focus-button-dark-1440`

### 改后（`.design/after/`，39 张）
- 同上述全部状态（`session-running-light-390`、`session-complete-light-390` 新增移动端浅色）
- 新增：`session-longtask-dark-1440 / session-longtask-light-1440`（长任务名 2 行截断）、`modal-clear-light-1440 / toast-light-1440`（浅色弹窗/Toast）、`focus-chip-dark-1440`（键盘 focus-visible）
- 极宽屏补充：`.design/extra/setup-dark-1366x768.png`、`.design/extra/setup-dark-1920x1080.png`

### 前后对照（`.design/compare/`）
- `setup-dark-1440.png`（版式骨架 + 类型）
- `roundcomplete-dark-1440.png`（完成态绿环/按钮）
- `session-dark-1024.png`（1024 一屏对齐）
- `records-light-1440.png`（浅色对比度 + 记录密度）

> 均可用 `.design/shots.cjs before|after` 复现（需要本地 4173 预览服务；CDP 9445）。

---

## 4. 验收自检

| 检查项 | 结果 |
| --- | --- |
| 无横向溢出（1440/1024/768/390 × 深/浅 × 各状态） | 通过（审计 0 处） |
| 无文本截断（长任务名、长记录名、CJK 标签） | 通过（只保留设计的单行 ellipsis） |
| 对比度（WCAG AA） | 通过（460 处 → 0 处） |
| roundComplete 按钮（仅「开始下一轮」+「完成」） | 通过（截图 `after/session-complete-*`；Lead 的 `[hidden]` 修复未被回退） |
| 弹窗层级（盖住 toast/彩带） | 通过（z-index 100/110 保持；`after/modal-clear-*`） |
| id/class 契约（`#sessionView`、`#ringProgress`、`.chip[data-minutes]` 等） | 未改 HTML/JS；CSS 未覆盖这些选择器的行为 |
| focus-visible / hover / reduced-motion | 通过（`focus-*` 截图、hover 记录、动画 1e-06s） |
| 移动端触控尺寸 | 主要操作 ≥42–48px；记录删除 30px；自定义输入 34px |
| 无网络字体 / 图片 / CDN / @import | 通过（未引入任何外部资源） |

---

## 5. 遗留问题与建议（不影响本轮验收）

1. **桌面高度锁定**：≥921px 时 `app-shell` 固定 `100vh`，若将来新增内容（例如更多侧栏卡片），需要在该断点内做内部滚动/压缩，否则会整页滚动（当前实测 1024×768 及 1366×768 均在单屏内）。
2. **超宽屏（≥1600px）**：`max-width: 1180px` 未改，左右留白较大属现有设计约束；如希望更"满屏"，需产品层面确认是否放宽栅格。
3. **触屏删除按钮**：通过 `@media (hover: none)` 常驻显示（30px）；若后续希望整行左滑删除，需要 JS 交互支持（本轮未改 JS）。
4. **roundComplete 主 CTA 仍为暖橙**：与绿色完成态形成互补对比，属有意保留；如果希望完成态 CTA 变绿，仅需 CSS 变量即可，但会削弱"下一轮=继续专注（暖色）"的语义。
5. **记录列表未做粘性日期头**：滚动时日期分组会滚出视野；实现需要处理半透明卡面背景，故本轮未做。
6. **无 DOM 结构变更需求**：本轮所有效果均通过 CSS + 伪元素达成，无需 Lead/前端配合。

---

## 6. 给 Lead 的接口说明

- `styles.css` 只改了视觉层；`#setupView` / `#sessionView` / `#ringProgress` / `.chip[data-minutes]` / `[hidden]` / `.modal-backdrop` 等 JS 依赖均保持不变。
- Lead 的两处修复（`[hidden]` 覆盖、弹窗/彩带 z-index）已保留并在截图中复验。
- 复现命令：`node .design/shots.cjs after`（CDP 9445；会重建 `.design/after/`）。

---

## 7. v2 迭代：正计时 / 暂停计轮 / 目标达成 / 实际-目标记录

> 本节记录 2026-10-24 需求变更后的第二轮视觉迭代（由 Lead 基于设计评审产出的 `.design/after-v2/` 与审计数据整理定稿）。v1 内容保留为历史。

### 7.1 需求变化对应的视觉调整

| 新状态 | 视觉处理 |
| --- | --- |
| 正计时（不再倒计时） | 计时数字仍保持大号 tabular-nums；正计时可能出现 `1:07:04` 等 7 字符，审计确认 390 宽（54px）与 1440 宽（72px）均完整落在圆环内盘内，不挤压、不换行 |
| 目标只是提示 | 副标题改为「目标 X 分钟 · 还剩 mm:ss / 已超出 mm:ss」，目标进度仍是第三格统计；到点不再进入「完成」语义 |
| 暂停 = 结束当前轮 | 暂停态轮次标签改为「已完成 N 轮 · 已暂停」；控制区只保留「继续 + 完成」；移动端 3 列控制自动降为 2 列（158px × 2，48px 高） |
| 目标达成/超时 | 由 v1 的 roundComplete 选择器改为 `[data-target-reached="true"]`：绿色环 + 绿色数字 +「目标已达成」，但仍保留运行中控制（暂停 / 下一轮 / 完成），不会看起来像已结束；浅色使用更深绿环保证对比 |
| 记录实际/目标 | 记录卡新增 `.record-target`（实际 / 目标）与 `.record-meter` 达成条：未达成为暖橙渐变，达成为绿色渐变；`is-reached` 仅改变颜色不改布局 |
| 暂停语义说明 | session 卡新增 `.session-note` 小号说明，位于统计与操作之间，层级弱于操作按钮 |
| 文案 | setup 提示「整个任务 X 分钟」、按钮「开始任务」、空状态「完成一个任务后，实际时长与目标时长会记录在这里」 |

### 7.2 v2 审计结果（`.design/after-v2/audit.json`）

- 覆盖 **47 个状态**（深/浅 × setup / running / paused / target-reached / longclock / longtask / records / modal / toast / focus / 移动端）。
- 横向溢出：**0**；文本截断（非设计省略号）：**0**；对比度不达标：**0**（含浅色记录 meta、session-note、目标达成绿、记录达成条）。
- 关键几何：
  - `1:07:04` 正计时：390 宽字号 54px，宽 150/内盘 215，完整；1440 宽字号 72px，宽 200/内盘 261，完整。
  - 暂停态移动端控制区：2 列 × 158px、48px 高，居中；运行态为 3 × 103px。
  - 目标达成态：绿色环、数字与 phase 文案在 1440/1024/390 均无溢出，按钮仍为运行态 3 按钮。
  - 记录达成条：未达成/达成两种颜色在深/浅主题均通过对比度审计。

### 7.3 截图清单（`.design/after-v2/`，49 张 + `audit.json`）

- setup：`setup-{dark,light}-{1440,1024,390}`、`setup-dark-768`
- session：`session-running-{dark,light}-1440`、`session-running-dark-{1024,768,390}`、`session-paused-{dark,light}-{1440,390}`、`session-paused-rich-*`、`session-paused-reached-dark-1440`
- 正计时/目标达成：`session-longclock-{dark,light?}-*`、`session-target-reached-{dark,light}-{1440,1024,390}`、`session-resumed-dark-1440`
- 记录：`records-v2-{dark,light}-{1440,1024,390}`、`records-empty-light-1440`、`hover-record-dark-1440`
- 弹窗/Toast：`modal-{complete,discard,clear}-*`、`toast-{dark,light}-1440`、`toast-stack-dark-1440`
- 焦点：`focus-{input,chip,button}-dark-1440`

复现：`node .design/shots.cjs after-v2`（CDP 9445；会重建该目录）。

### 7.4 v2 遗留问题与建议

1. 桌面 ≥921px 仍锁定视口高度；如未来侧栏新增卡片，需要在该断点内做内部滚动，否则会出现整页滚动。
2. 超宽屏（≥1600px）仍受 `max-width: 1180px` 限制，属于既定版式约束。
3. 记录列表日期分组未做粘性头；若需要，需同时处理半透明卡面背景。
4. 目标达成后主操作仍为暖橙「暂停」、绿色只用于状态表达，这是有意避免「绿色=已完成」的误读。
5. 长任务名在记录卡内仍为单行省略号；会话卡内为两行截断，符合信息层级取舍。

---

## 8. v3 视觉迭代：任务清单 / 单轮专注 / 任务耗时与专注效率

> 本节记录 2026-10-24 v3 需求后的第三轮视觉迭代：新增「任务清单 + 单轮专注」两层模型、任务耗时与专注均值对比、效率记录。v1、v2 内容保留为历史。

### 8.1 范围、方法与基线

- 范围：仅 `styles.css`（+ 本文件与 `.design/`）；**未修改** `index.html` / `app.js` / `focus-core.js`，无 DOM 变更需求。
- 源码基线（截图对应）：`index.html 743610dd…`、`app.js 6f5d20f3…`、`focus-core.js a5b2b88a…`；`styles.css` 由 Lead 的 v3 基础版 `38add58d…` 打磨为定稿 `e34281dd…`（本轮只改这一个样式文件；`audit.json` 内 `sourceHashes` 为实际采样版本）。
- 工具：新增 `.design/shots-v3.cjs`（CDP 9445；`Page.addScriptToEvaluateOnNewDocument` 打补丁 `Date.now()` 以确定性快进专注轮次；v3 schema 种子）。同一驱动分别对「基础版 styles.css」与「定稿 styles.css」各跑一遍：
  - `.design/before-v3/`：71 张截图 + `audit.json`（42 次审计）
  - `.design/after-v3/`：71 张截图 + `audit.json`（42 次审计、39 项自动检查）
  - 基础版/定稿样式留档：`.design/styles-baseline-v3.css`、`.design/styles-final-v3.css`
- 审计维度：逐元素横向越界、非设计性文本截断（`text-overflow: ellipsis` 与滚动容器豁免）、WCAG 对比度（渐变 + 透明度逐层合成，大字号 3:1 / 常规 4.5:1）、可交互目标尺寸、关键容器几何、任务列表内部滚动与首屏完整行数、会话卡片内容底边 vs 卡底（裁切）、4 统计列数、记录行高 / 差异是否换行 / 值是否截断、效率对比行重叠、弹窗 chips 行数、桌面两栏同底、`prefers-reduced-motion`。
- 视口：1440×900、1024×768、390×844；深色与浅色；`(hover:hover)/(pointer:fine)` 与触屏 `(hover:none)/(pointer:coarse)` 分别用 Blink flag + CDP touch emulation 精确模拟。

### 8.2 打磨前后（审计数据）

| 指标 | 基础版（before-v3） | 定稿（after-v3） |
| --- | --- | --- |
| 自动检查失败 | **12** | **0**（39/39 通过） |
| 对比度不达标 | **11 处** | **0 处** |
| 文本截断 / 横向溢出 / 越界元素 | 0 / 0 / 0 | 0 / 0 / 0 |
| 任务表单高度 @1440 / @1024 / @390 | 296 / 282 / 430 px | **177 / 170 / 357 px** |
| 任务列表首屏完整可见行 @1440 / @1024 | 3/6 / 2/6 | **6/6 / 5/6** |
| 两组时长 chips 单行（各 5 个）@1440 / @1024 | 否（各 2 行） | **是** |
| 1024×768 整页滚动 | 有（scrollHeight 778 > 768） | **无**（一屏） |
| 行内「开始专注」主色填充按钮 | 6 个（每行都有，过亮） | **0 个**；仅活动任务「继续专注」1 个 |
| 会话暂停态内容溢出卡片 @1440 / @1024 | 有（758/745、739/711，被裁切） | **无**（767/767、714/729） |
| 会话暂停态 390 卡片底 / 控制条底（vh=844） | 835 / 764 | **721 / 663**（一屏内可操作） |
| 开始专注弹窗 chips 行数 / 宽度 | 2 行 / 440px | **1 行 / 456px** |
| 完成记录行高 / 差异换行 / 首屏完整可见 | 126px / 6 处 / 1 条 | **113px / 0 处 / 2 条** |
| 侧栏「今日概览」卡高度 @1440 / @1024 | 451 / 451 px | **392 / 352 px** |
| 长计时 `1:13:12` 宽度 / 内盘 @1440 | 210 / 261（完整） | 192 / 258（完整；390 175/193） |

### 8.3 主要视觉改动

#### 8.3.1 任务清单页（信息层级与按钮层级）

- 标题收敛：eyebrow 10.5px/0.22em、标题 `clamp(25px, 2.45vw, 31px)`、副标题 13px/1.65（基础版标题 38px 偏高）；卡片内距 26/30/18。
- **Composer 重构**（纯 CSS Grid，无 DOM 改动）：任务名称输入 + 添加按钮同一行（均 48px 高），两组时长 chips 各占一行、左侧固定标签列 104px；表单高度 296 → **177px**，任务列表因此多出约 2 屏行数。
- chips：34px 高 / 12px 字号（桌面）、自定义输入 46px 宽；1440 与 1024 下两组 chips（各 5 个）均为单行，无横向溢出。
- 列表：行 padding 9/10、标题 13.5px/600、meta 11px faint；列表 `flex:1`、`overflow-y:auto`、`scrollbar-gutter:stable`——9 条任务时列表内部滚动（scrollHeight 534 / clientHeight 397），页面不滚动。
- **主/次按钮层级**：`.task-row .task-start` 默认是描边次按钮（透明底 + hairline 边框 + muted 文字）；只有 `.task-row.is-active .task-start`（「继续专注」）保留主色渐变；其他被阻塞的开始按钮 `aria-disabled` + 50% 透明；删除按钮透明底、hover/focus 显现；行 hover 也会点亮次级开始按钮。
- 活动任务行：`accent-ghost` 底 + `accent-border` 边框 + 「暂停中 · 已专注 X · N 轮」进度行，信息与清单其余行区分明确。
- 空状态：图标 38px、标题/提示居中。

#### 8.3.2 开始专注弹窗

- 宽度 440 → 456px、内距 24、圆角 22；标题 16px、任务名 14px、meta 11.5px、label 10.5px。
- 5 个「本轮预期专注」chips（含自定义）在桌面/平板单行显示（11.5px / 32px 高）；继续态额外显示「已专注 X · N 轮 · 任务暂停中」。
- 按钮 40px 高、13px；主按钮阴影收紧（0 10px 24px -16px），避免与页面主按钮抢层级。

#### 8.3.3 专注会话页（一屏不裁切）

- 桌面：环形 300px、计时 `clamp(44px,5vw,64px)`、4 个统计等分（strong 16.5 / label 10.5）；暂停态「下一轮预期专注」面板（chips 30px）、「继续」主按钮 +「完成任务」次按钮 +「返回任务清单」文字链；运行态 3 按钮。
- **修复基础版暂停态裁切**：1440×900 内容底边 834 < 卡底 853；1024×768 714 < 729；390×844 卡片整体 721px（<844），控制条底 663，一屏内可操作。短屏（≤800px 高）媒体查询把环形压到 252px 并收紧统计/面板/按钮间距。
- 移动端：环形 `min(224px, 61vw)`、计时 46px、4 统计变 2×2、暂停态控制 2 等分、下一轮面板 chips 10.5px 不溢出；toast 停靠在顶栏下方，不再遮挡「继续 / 完成任务」。
- 状态：本轮达标保持运行（环、数字、phase 变绿，副标题显示「已超出 mm:ss」）；暂停态冻结并压暗；长任务名 2 行截断 + ellipsis。
- 长计时 `1:13:12` 在 1440/1024/390 均完整落在圆环内盘（192/258、192/217、175/193）。

#### 8.3.4 侧栏「今日概览」与效率对比

- 2×2 统计：数字 24px、单位 11px、说明 10.5px，并补充 10px 小字（平均每轮「预期 X」、完成任务「共 N 轮」）；卡高 451 → 392（1440）/352（1024），把高度让给完成记录。
- 效率对比改为两行两行式条目：第一行「标签 + 右侧差异（快/慢）」、第二行「实际 / 预期」，避免一行挤压导致的换行/重叠；差异用克制的绿（更优）/暖橙（更慢），中性「持平」用 faint。
- 近 7 天柱状图：柱高 32px、列距 6px，今天列 `accent-ghost` + 边框强调；空数据以 3px 短柱提示。
- 浅色对比度修复：选中 chip 文字改用 `--accent-strong`（4.18 → **5.89**）；活动任务行 meta 改 `--text-muted`（4.48 → 6.31）。

#### 8.3.5 完成记录（两行对比、可读不截断）

- 行结构：左侧 5px 圆点、任务名 12.5px、meta（时间段 · N 轮 · 总专注）10.2px，随后两条对比：
  - 「任务耗时」+ 右侧差异（快/慢）一行，「实际 X / 预期 Y」一行；
  - 「专注均值」+ 右侧差异（+/-/持平）一行，「平均 X / 轮 · 预期 Y」一行。
- `.rm-value` 允许换行、不截断；`.rm-delta` 固定右对齐，不再被挤到下一行（差异换行 6 处 → **0 处**）；行高 126 → **113px**。
- 记录卡内部滚动（7 条时 scrollHeight 860 / clientHeight 299）；删除按钮 24px、hover/focus 显现，触屏常显 0.55；空状态文案沿用「完成任务后，任务耗时与每轮专注的预期/实际会记录在这里。」

#### 8.3.6 弹窗 / Toast / 交互状态 / 可访问性

- 删除任务、清空记录、完成任务保存弹窗统一 456px 宽、22px 圆角、40px 按钮；危险操作用 `btn-danger`，其余主按钮阴影收紧。
- Toast：桌面右下 24px；移动端改为顶栏下方通栏停靠，避免遮挡暂停/继续；删除记录 Toast 带「撤销」。
- focus-visible：全局 2px accent 描边；输入框用 accent 边框 + 4px halo；实测 chip / 添加按钮 / 任务开始按钮 / 记录删除按钮均获得 ≥2px 可见焦点环。
- hover：任务行 / 记录行底色、chip 边框、按钮位移与亮度；`@media (hover:none)` 下取消位移动画并常显删除按钮。
- reduced-motion：实测动画时长 1e-06s、iteration 1、彩带 `display:none`。
- 移动端触控：图标按钮 42px、chips 36px、行内按钮 34px、任务/记录删除 32px、返回清单链接 32px；自定义分钟输入嵌于 36px chip 内（输入区 28px；下一轮面板内为 27px，属嵌入 chip 的次级输入）；桌面 1440/1024 两栏同底（卡底 853 = 侧栏底 853）。

### 8.4 审计结论

- **after-v3：42 个状态审计 / 71 张截图 / 39 项自动检查全部通过**；对比度失败 0、非设计性截断 0、横向溢出 0、越界元素 0、页面级滚动 0（1440/1024），桌面两栏同底。
- 关键状态覆盖：任务空态 / 6 条与 9 条任务 / 活动任务行 / 9 条滚动 / 开始与继续弹窗 / 运行 / 本轮达标 / 暂停（含 1024 与 390）/ 暂停改下一轮 / 长计时 / 长任务名 / 记录 3 条与 7 条 / 记录空态 / 移动端侧栏 / 完成·删除·清空·放弃弹窗 / Toast 与 Toast 堆叠 / 键盘 focus / reduced-motion。
- before-v3（同一驱动、基础版样式）复现了 12 项失败与 11 处对比度问题，见 `.design/before-v3/audit.json` 与截图。

### 8.5 截图清单（`.design/after-v3/`，71 张 + `audit.json`）

- 任务页：`tasks-empty-{dark,light}-{1440,1024,390}`、`tasks-list-{dark,light}-{1440,1024,390}`、`tasks-list-rows-{dark,light}-390`、`tasks-many-dark-1440`、`tasks-many-scrolled-dark-1440`、`tasks-active-{dark,light}-1440`、`hover-task-dark-1440`
- 开始/继续弹窗：`modal-start-{dark,light}-{1440,390}`、`modal-start-dark-390`、`modal-resume-dark-1440`
- 会话：`session-running-{dark,light}-1440`、`session-running-dark-{1024,390}`、`session-reached-{dark,light}-{1440,390}`、`session-paused-{dark,light}-{1440,1024,390}`、`session-paused-next45-dark-{1440,390}`、`session-paused-reached-{dark,light}-1440`、`session-longclock-dark-1440`、`session-longtask-dark-1440`、`session-longtask-{dark,light}-390`
- 侧栏 / 记录：`records-{dark,light}-{1440,1024,390}`、`records-light-1440`、`records-many-dark-1440`、`hover-record-dark-1440`、`stats-{dark,light}-390`
- 弹窗 / Toast：`modal-delete-task-dark-1440`、`modal-clear-{dark,light}-1440`、`modal-complete-dark-1440`、`modal-complete-{dark,light}-390`、`modal-discard-dark-1440`、`toast-dark-1440`、`toast-stack-dark-1440`
- 焦点 / 动效：`focus-input-dark-1440`、`focus-chip-dark-1440`、`focus-addbtn-dark-1440`、`focus-task-start-dark-1440`、`focus-record-delete-dark-1440`、`reduced-motion-dark-1440`

### 8.6 复现命令

```bash
# 定稿截图 + 审计（CDP 9445；需要 4173 预览服务）
node .design/shots-v3.cjs after-v3

# 打磨前基线（同一驱动，用留档的基础版样式 + 当前 DOM 副本，避免影响 4173）
mkdir -p .design/baseline-app
cp index.html app.js focus-core.js .design/baseline-app/
cp .design/styles-baseline-v3.css .design/baseline-app/styles.css
python3 -m http.server 4182 --bind 127.0.0.1 --directory .design/baseline-app &
FOCUS_APP_URL=http://127.0.0.1:4182/index.html node .design/shots-v3.cjs before-v3
```

### 8.7 已知取舍与遗留

1. 长任务名在任务行与记录行仍使用单行 ellipsis（`title` 属性可见全名）；移动端任务 meta 允许换行（数据可读优先，行高会不一致）。
2. 390px 下两组时长 chips 各自自然换行（4 + 自定义）；开始弹窗在 390 仍保持 5 chips 单行。
3. 1024×768 记录卡首屏完整显示 1 条对比（list 232px，可内部滚动）；1440 首屏 2 条。如希望小屏也显示 2 条，需要进一步压缩侧栏统计（当前已从 451 压到 352）。
4. 运行/暂停切换时圆环尺寸不缩放（1440 300px / 短屏 252px / 390 224px），避免状态切换时布局跳动；运行态上下留白更大是刻意的「专注留白」。
5. 会话卡 `overflow:hidden` 保留；未来若新增统计或文案，需同步收紧短屏媒体查询（当前 1440/1024/390 均无裁切）。
6. 未改 HTML/JS：`.task-row` / `.start-modal` / `.next-focus` / `.record-metric` / `session-note` 等 Lead 新增结构全部保留，仅调整样式。
7. 本轮截图对应 `app.js 6f5d20f3…`（2026-10-24 10:05）。若 Lead/QA 后续再改 `app.js` / `index.html`，应按 8.6 重跑截图与审计。

---

## 9. v3.1 语义修正说明（2026-10-25）

用户反馈「暂停时间不应计入任务耗时」。Lead 已修正 core/UI 文案：任务耗时 = 各轮实际专注之和（不含暂停），会话页顶部 meta 由「任务已耗时（含暂停）」改为「任务耗时 实际 X / 预期 Y」，完成弹窗说明改为「按各轮实际专注累计，不含暂停」。本次只改文案与数据口径，样式结构不变，§8 的视觉审计与截图（历史语义数值）仍可作为 v3 布局参考；最终截图见 `screenshots/` 与 `.qa/v3-*.png`。
