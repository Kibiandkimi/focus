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
