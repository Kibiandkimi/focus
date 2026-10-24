/*
 * Focus v3 — end-to-end tests (headless Chrome via Chrome DevTools Protocol).
 *
 * The clock is frozen and driven explicitly:
 *   Page.addScriptToEvaluateOnNewDocument replaces Date.now with a virtual
 *   clock (base + offset) that only moves when the test calls window.__qa.advance(ms).
 *   Time therefore never drifts with real test execution and the whole session
 *   can be fast-forwarded without waiting.
 *
 * Everything runs against a clean origin: navigate to the same-origin
 * .qa/blank.html, clear localStorage (so the app's beforeunload cannot write
 * a stale session back), then navigate to index.html.
 *
 * Run: node tests/e2e.cjs
 * Requires: google-chrome (or CHROME_BIN), python3 for the fallback server,
 * Node 24+ (built-in WebSocket). No npm dependencies.
 */
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------------------------------------------------ *
 * config
 * ------------------------------------------------------------------------ */

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.qa');
const PROFILE = path.join(OUT, 'chrome-e2e-v3');
const CHROME_HOME = path.join(OUT, 'chrome-e2e-home');
const CHROME_TMP = path.join(OUT, 'chrome-e2e-tmp');
const PREFERRED_BASE = process.env.FOCUS_BASE || 'http://127.0.0.1:4173';
const FALLBACK_PORT = 4181;
const CDP_PORT = Number(process.env.FOCUS_CDP_PORT || 9444);
const CHROME_BIN = process.env.CHROME_BIN || 'google-chrome';

const MIN = 60 * 1000;
const SEC = 1000;
const TASK_PRESETS = [30, 60, 120, 240];
const FOCUS_PRESETS = [15, 25, 45, 60];

let BASE = PREFERRED_BASE;
let INDEX_URL = BASE + '/index.html';
let BLANK_URL = BASE + '/.qa/blank.html';
let serverChild = null;
let chromeChild = null;
let client = null;

const scenarios = [];
const defects = [];
const consoleProblems = [];
let assertionCount = 0;

/* ------------------------------------------------------------------------ *
 * tiny utils
 * ------------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function clockOf(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function log(msg) {
  console.log(`  · ${msg}`);
}

function httpText(url, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('http timeout')));
  });
}

/* ------------------------------------------------------------------------ *
 * assertions
 * ------------------------------------------------------------------------ */

function assertOk(condition, label, detail) {
  assertionCount += 1;
  if (!condition) {
    throw new Error(`${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertEq(actual, expected, label) {
  assertionCount += 1;
  const same =
    actual === expected ||
    (typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) < 1e-6);
  if (!same) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEq(actual, expected, label) {
  assertionCount += 1;
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertIncludes(haystack, needle, label) {
  assertionCount += 1;
  if (typeof haystack !== 'string' || !haystack.includes(needle)) {
    throw new Error(
      `${label}: ${JSON.stringify(haystack)} does not include ${JSON.stringify(needle)}`
    );
  }
}

function assertMatches(value, regexp, label) {
  assertionCount += 1;
  if (typeof value !== 'string' || !regexp.test(value)) {
    throw new Error(`${label}: ${JSON.stringify(value)} does not match ${regexp}`);
  }
}

function softCheck(condition, defect) {
  assertionCount += 1;
  if (condition) return true;
  if (!defects.some((item) => item.id === defect.id)) {
    defects.push(defect);
    console.warn(`  ⚠ DEFECT ${defect.id} [${defect.severity}] ${defect.title}`);
  }
  return false;
}

/* ------------------------------------------------------------------------ *
 * CDP plumbing
 * ------------------------------------------------------------------------ */

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    } else if (message.method) {
      events.push(message);
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }

  return { send, events, ready, ws, close: () => ws.close() };
}

async function ensurePreview() {
  try {
    const res = await httpText(PREFERRED_BASE + '/index.html');
    if (res.status === 200) return PREFERRED_BASE;
  } catch (err) {
    /* fall through to own server */
  }
  log(`127.0.0.1:4173 不可用，自起 python3 -m http.server ${FALLBACK_PORT}`);
  serverChild = spawn(
    'python3',
    ['-m', 'http.server', String(FALLBACK_PORT), '--bind', '127.0.0.1'],
    { cwd: ROOT, stdio: 'ignore' }
  );
  const base = `http://127.0.0.1:${FALLBACK_PORT}`;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await httpText(base + '/index.html', 600);
      if (res.status === 200) return base;
    } catch (err) {
      /* retry */
    }
    await sleep(100);
  }
  throw new Error('无法启动预览服务器（4173 不可用且 4181 启动失败）');
}

async function closeStaleChrome() {
  try {
    const { body } = await httpText(`http://127.0.0.1:${CDP_PORT}/json/version`, 800);
    const info = JSON.parse(body);
    if (info.webSocketDebuggerUrl) {
      const stale = connect(info.webSocketDebuggerUrl);
      await stale.ready;
      await stale.send('Browser.close').catch(() => {});
      stale.close();
      await sleep(700);
    }
  } catch (err) {
    /* port is free */
  }
}

async function launchChrome() {
  fs.mkdirSync(CHROME_HOME, { recursive: true });
  fs.mkdirSync(CHROME_TMP, { recursive: true });
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1440,900',
    'about:blank',
  ];
  return spawn(CHROME_BIN, args, {
    stdio: 'ignore',
    env: Object.assign({}, process.env, { HOME: CHROME_HOME, TMPDIR: CHROME_TMP }),
  });
}

async function waitForTarget() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const { body } = await httpText(`http://127.0.0.1:${CDP_PORT}/json/list`, 600);
      const targets = JSON.parse(body);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (err) {
      /* retry */
    }
    await sleep(120);
  }
  throw new Error('Chrome DevTools target 未就绪');
}

/* ------------------------------------------------------------------------ *
 * page helpers
 * ------------------------------------------------------------------------ */

async function evalx(expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const detail =
      (result.exceptionDetails.exception && result.exceptionDetails.exception.description) ||
      result.exceptionDetails.text;
    throw new Error(`页面执行异常: ${String(detail).slice(0, 500)}`);
  }
  return result.result.value;
}

async function waitFor(expression, label, timeout = 8000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      if (await evalx(expression)) return true;
    } catch (err) {
      lastError = err;
    }
    await sleep(50);
  }
  throw new Error(
    `等待超时: ${label || expression}${lastError ? ` (最后错误: ${lastError.message})` : ''}`
  );
}

const sel = (selector) => JSON.stringify(selector);

async function click(selector) {
  await evalx(`(() => {
    const el = document.querySelector(${sel(selector)});
    if (!el) throw new Error('元素不存在: ' + ${sel(selector)});
    el.click();
    return true;
  })()`);
}

async function text(selector) {
  return evalx(`(() => {
    const el = document.querySelector(${sel(selector)});
    return el ? el.textContent.trim() : null;
  })()`);
}

async function count(selector) {
  return evalx(`document.querySelectorAll(${sel(selector)}).length`);
}

async function hasClass(selector, className) {
  return evalx(`(() => {
    const el = document.querySelector(${sel(selector)});
    return !!el && el.classList.contains(${sel(className)});
  })()`);
}

async function attr(selector, name) {
  return evalx(`(() => {
    const el = document.querySelector(${sel(selector)});
    return el ? el.getAttribute(${sel(name)}) : null;
  })()`);
}

async function setValue(selector, value) {
  await evalx(`(() => {
    const el = document.querySelector(${sel(selector)});
    if (!el) throw new Error('输入框不存在: ' + ${sel(selector)});
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
}

async function storage(key) {
  return evalx(`(() => {
    try { return JSON.parse(localStorage.getItem(${sel(key)})); } catch (error) { return null; }
  })()`);
}

async function storageKeys() {
  return evalx('Object.keys(localStorage)');
}

async function lastToast() {
  return evalx(`(() => {
    const nodes = document.querySelectorAll('#toastStack .toast');
    if (!nodes.length) return null;
    const toast = nodes[nodes.length - 1];
    const action = toast.querySelector('.toast-action');
    return { text: toast.textContent.trim(), action: action ? action.textContent.trim() : null };
  })()`);
}

async function waitToast(fragment, label, timeout = 5000) {
  await waitFor(
    `(() => {
      const nodes = document.querySelectorAll('#toastStack .toast');
      if (!nodes.length) return false;
      return nodes[nodes.length - 1].textContent.includes(${sel(fragment)});
    })()`,
    label || `toast ${fragment}`,
    timeout
  );
}

async function clearToasts() {
  await evalx(`document.querySelectorAll('#toastStack .toast').forEach((node) => node.remove())`);
}

async function waitView(view) {
  await waitFor(`document.body.dataset.view === ${sel(view)}`, `view=${view}`);
}

async function waitModal() {
  await waitFor(
    `!document.querySelector('#modalBackdrop').classList.contains('is-hidden')`,
    'modal opened'
  );
}

async function waitModalClosed() {
  await waitFor(
    `document.querySelector('#modalBackdrop').classList.contains('is-hidden')`,
    'modal closed'
  );
}

async function modalInfo() {
  return evalx(`(() => {
    const backdrop = document.querySelector('#modalBackdrop');
    return {
      visible: !backdrop.classList.contains('is-hidden'),
      title: document.querySelector('#modalTitle').textContent.trim(),
      body: document.querySelector('#modalBody').textContent.trim(),
      confirm: document.querySelector('#modalConfirm').textContent.trim(),
      cancel: document.querySelector('#modalCancel').textContent.trim(),
      confirmClass: document.querySelector('#modalConfirm').className,
    };
  })()`);
}

async function waitAppReady() {
  await waitFor(
    `document.readyState === 'complete' && !!document.querySelector('#taskForm') && ` +
      `(document.body.dataset.view === 'tasks' || document.body.dataset.view === 'session')`,
    'app ready'
  );
}

async function goto(url) {
  await client.send('Page.navigate', { url });
}

async function reloadApp() {
  await client.send('Page.reload', { ignoreCache: false });
  await waitAppReady();
  await sleep(120);
}

/** clean origin: same-origin blank page → clear storage → back to the app */
async function resetApp() {
  await goto(BLANK_URL);
  await sleep(150);
  try {
    await evalx('localStorage.clear()');
  } catch (err) {
    /* the blank document cleared */
  }
  await goto(INDEX_URL);
  await waitAppReady();
  await sleep(100);
}

async function advance(ms) {
  await evalx(`window.__qa.advance(${Math.round(ms)})`);
  await sleep(250); // let the 200ms UI tick repaint the frozen clock
}

async function setViewport(width, height, mobile, deviceScaleFactor) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: deviceScaleFactor || 1,
    mobile: !!mobile,
    screenWidth: width,
    screenHeight: height,
  });
}

async function shot(name) {
  await sleep(180);
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(result.data, 'base64'));
  log(`截图 ${name}`);
}

async function assertNoHorizontalOverflow(label) {
  const metrics = await evalx(`(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    iw: window.innerWidth,
    cw: document.documentElement.clientWidth,
  }))()`);
  assertOk(
    metrics.doc <= metrics.iw + 1,
    `${label}: document 横向溢出 doc=${metrics.doc} viewport=${metrics.iw}`
  );
  assertOk(
    metrics.body <= metrics.iw + 1,
    `${label}: body 横向溢出 body=${metrics.body} viewport=${metrics.iw}`
  );
  return metrics;
}

/* ------------------------------------------------------------------------ *
 * UI action helpers
 * ------------------------------------------------------------------------ */

async function addTask(options) {
  const opts = options || {};
  const before = await count('#taskList .task-row');
  await setValue('#taskTitleInput', opts.title);
  if (opts.taskMinutes != null) {
    if (TASK_PRESETS.includes(opts.taskMinutes)) {
      await click(`#taskExpectedChips .chip[data-task-minutes="${opts.taskMinutes}"]`);
    } else {
      await setValue('#taskCustomMinutes', opts.taskMinutes);
    }
  }
  if (opts.focusMinutes != null) {
    if (FOCUS_PRESETS.includes(opts.focusMinutes)) {
      await click(`#focusExpectedChips .chip[data-focus-minutes="${opts.focusMinutes}"]`);
    } else {
      await setValue('#focusCustomMinutes', opts.focusMinutes);
    }
  }
  await evalx(`document.querySelector('#taskForm').requestSubmit()`);
  await waitFor(
    `document.querySelectorAll('#taskList .task-row').length === ${before + 1}`,
    `task added: ${opts.title}`
  );
}

async function taskRows() {
  return evalx(`(() => Array.from(document.querySelectorAll('#taskList .task-row')).map((row) => ({
    title: row.querySelector('.task-row-title').textContent.trim(),
    meta: row.querySelector('.task-row-meta').textContent.trim(),
    progress: row.querySelector('.task-row-progress') ? row.querySelector('.task-row-progress').textContent.trim() : '',
    startText: row.querySelector('.task-start').textContent.trim(),
    startDisabled: row.querySelector('.task-start').classList.contains('is-disabled'),
    startAriaDisabled: row.querySelector('.task-start').getAttribute('aria-disabled'),
    active: row.classList.contains('is-active'),
    hasDelete: !!row.querySelector('.task-delete'),
  })))()`);
}

async function clickTaskAction(title, action) {
  await evalx(`(() => {
    const row = Array.from(document.querySelectorAll('.task-row')).find(
      (item) => item.querySelector('.task-row-title').textContent.trim() === ${sel(title)}
    );
    if (!row) throw new Error('找不到任务行: ' + ${sel(title)});
    const button = row.querySelector(${sel(action)});
    if (!button) throw new Error('找不到操作按钮: ' + ${sel(action)});
    button.click();
    return true;
  })()`);
}

async function startTaskByName(title) {
  await clickTaskAction(title, '.task-start');
  await waitModal();
}

async function deleteTaskByName(title) {
  await clickTaskAction(title, '.task-delete');
  await waitModal();
}

async function startFocusWithPreset(title, minutes) {
  await startTaskByName(title);
  if (minutes != null) {
    await click(`#modalBody .chip[data-minutes="${minutes}"]`);
  }
  await click('#modalConfirm');
  await waitView('session');
}

async function sessionState() {
  return evalx(`(() => ({
    view: document.body.dataset.view,
    phase: document.querySelector('#sessionView').dataset.phase,
    roundReached: document.querySelector('#sessionView').dataset.roundReached,
    roundLabel: document.querySelector('#roundLabel').textContent.trim(),
    taskTitle: document.querySelector('#sessionTask').textContent.trim(),
    taskMeta: document.querySelector('#sessionTaskMeta').textContent.trim(),
    timeDisplay: document.querySelector('#timeDisplay').textContent.trim(),
    timerPhase: document.querySelector('#timerPhase').textContent.trim(),
    timerSub: document.querySelector('#timerSub').textContent.trim(),
    roundFocus: document.querySelector('#sessionRoundFocus').textContent.trim(),
    avgFocus: document.querySelector('#sessionAvgFocus').textContent.trim(),
    taskElapsed: document.querySelector('#sessionTaskElapsed').textContent.trim(),
    rounds: document.querySelector('#sessionRounds').textContent.trim(),
    pauseText: document.querySelector('#pauseBtn').textContent.trim(),
    nextHidden: document.querySelector('#nextBtn').hidden,
    nextPanelVisible: !document.querySelector('#nextFocusPanel').classList.contains('is-hidden'),
    backToListVisible: !document.querySelector('#backToListBtn').classList.contains('is-hidden'),
    nextNote: document.querySelector('#nextFocusNote').textContent.trim(),
    controls: Array.from(document.querySelectorAll('#controls button'))
      .filter((button) => !button.hidden)
      .map((button) => button.textContent.trim()),
    title: document.title,
  }))()`);
}

async function recordNodes() {
  return evalx(`(() => Array.from(document.querySelectorAll('.record')).map((record) => ({
    title: record.querySelector('.record-task').textContent.trim(),
    meta: record.querySelector('.record-meta').textContent.trim(),
    metrics: Array.from(record.querySelectorAll('.record-metric')).map((metric) => ({
      label: metric.querySelector('.rm-label').textContent.trim(),
      value: metric.querySelector('.rm-value').textContent.trim(),
      delta: metric.querySelector('.rm-delta').textContent.trim(),
      deltaClass: metric.querySelector('.rm-delta').className,
    })),
    hasDelete: !!record.querySelector('.record-delete'),
  })))()`);
}

async function recordCount() {
  return count('.record');
}

async function createRecordViaUI(title, taskMinutes, focusMinutes, advanceMinutes) {
  const before = await recordCount();
  await addTask({ title, taskMinutes, focusMinutes });
  await startFocusWithPreset(title, focusMinutes);
  await advance(advanceMinutes * MIN);
  await click('#completeBtn');
  await waitModal();
  await click('#modalConfirm');
  await waitFor(`document.querySelectorAll('.record').length === ${before + 1}`, 'record saved');
  await waitView('tasks');
}

async function key(code, keyName, virtualKeyCode) {
  const base = {
    code,
    key: keyName,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
  await client.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base));
  await client.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  await sleep(120);
}

async function focusSession() {
  await evalx(
    `(() => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      const view = document.querySelector('#sessionView');
      view.focus();
      return document.activeElement === view;
    })()`
  );
}

/* ------------------------------------------------------------------------ *
 * scenario runner
 * ------------------------------------------------------------------------ */

async function scenario(name, fn) {
  const startedWith = assertionCount;
  const record = { name, ok: true, error: null, assertions: 0 };
  console.log(`\n▶ ${name}`);
  try {
    await fn();
  } catch (err) {
    record.ok = false;
    record.error = err.message;
    console.error(`  ✖ ${name}: ${err.message}`);
  }
  record.assertions = assertionCount - startedWith;
  scenarios.push(record);
}

/* ======================================================================== *
 * scenarios
 * ======================================================================== */

async function s1_bootEmpty() {
  await resetApp();
  const state = await evalx(`(() => ({
    view: document.body.dataset.view,
    theme: document.documentElement.dataset.theme,
    title: document.title,
    todayLabel: document.querySelector('#todayLabel').textContent.trim(),
    taskCount: document.querySelector('#taskCount').textContent.trim(),
    taskListNote: document.querySelector('#taskListNote').textContent.trim(),
    emptyTask: !!document.querySelector('#taskList .task-empty'),
    emptyTaskText: document.querySelector('#taskList .task-empty')
      ? document.querySelector('#taskList .task-empty').textContent.replace(/\\s+/g, ' ').trim()
      : '',
    emptyRecordText: document.querySelector('#recordsList').textContent.replace(/\\s+/g, ' ').trim(),
    recordsCount: document.querySelector('#recordsCount').textContent.trim(),
    statFocus: document.querySelector('#statTodayFocus').textContent.trim(),
    statAvg: document.querySelector('#statAvgFocus').textContent.trim(),
    statTasks: document.querySelector('#statTodayTasks').textContent.trim(),
    statStreak: document.querySelector('#statStreak').textContent.trim(),
    totalNote: document.querySelector('#totalNote').textContent.trim(),
    weekTotal: document.querySelector('#weekTotal').textContent.trim(),
    clearHidden: document.querySelector('#clearRecords').hidden,
    effTaskActual: document.querySelector('#effTaskActual').textContent.trim(),
    effFocusActual: document.querySelector('#effFocusActual').textContent.trim(),
    taskListHasRows: document.querySelectorAll('#taskList .task-row').length,
  }))()`);
  assertEq(state.view, 'tasks', '初始视图');
  assertEq(state.theme, 'dark', '默认深色主题');
  assertEq(state.taskCount, '0', '任务计数');
  assertEq(state.taskListHasRows, 0, '任务行为空');
  assertOk(state.emptyTask, '空任务状态存在');
  assertIncludes(state.emptyTaskText, '还没有待办任务', '空任务文案');
  assertEq(state.taskListNote, '还没有任务', '任务列表提示');
  assertIncludes(state.emptyRecordText, '还没有完成记录', '空记录文案');
  assertEq(state.recordsCount, '0', '记录计数');
  assertEq(state.statFocus, '0', '今日专注 0');
  assertEq(state.statAvg, '—', '今日平均 —');
  assertEq(state.statTasks, '0', '今日完成任务 0');
  assertEq(state.statStreak, '0', '连续天数 0');
  assertEq(state.totalNote, '今天还没有记录', '今日概览提示');
  assertEq(state.weekTotal, '暂无记录', '近 7 天提示');
  assertOk(state.clearHidden, '空记录时清空按钮隐藏');
  assertEq(state.effTaskActual, '—', '空状态效率对比');
  assertEq(state.effFocusActual, '—', '空状态专注均值');
  assertMatches(state.todayLabel, /\d+月\d+日 · 周[日一二三四五六]/, '日期标签');
  assertIncludes(state.title, 'Focus', '页面标题');
  const tasks = await storage('focus.tasks.v3');
  assertEq(Array.isArray(tasks) ? tasks.length : -1, 0, 'focus.tasks.v3 初始化为空数组');
  const settings = await storage('focus.settings.v3');
  assertEq(settings && settings.theme, 'dark', 'settings 默认主题持久化');
  assertEq(settings && settings.defaultExpectedTaskMs, 60 * MIN, 'settings 默认预期完成时长');
  assertEq(settings && settings.defaultExpectedFocusMs, 25 * MIN, 'settings 默认单轮专注');
  await shot('v3-desktop-empty-dark.png');
}

async function s2_taskForm() {
  await resetApp();

  /* 1. empty title is rejected */
  await click('#addTaskBtn');
  await sleep(100);
  assertIncludes((await lastToast()).text, '先写下任务名称', '空标题 toast');
  assertEq(await count('#taskList .task-row'), 0, '空标题不创建任务');

  /* 2. invalid custom expected-task duration */
  await setValue('#taskTitleInput', '自定义任务');
  await setValue('#taskCustomMinutes', '1441');
  assertIncludes(await text('#taskExpectedNote'), '需在 1–1440 分钟之间', '任务时长越界提示');
  await evalx(`document.querySelector('#taskForm').requestSubmit()`);
  await sleep(100);
  assertIncludes((await lastToast()).text, '预期完成时长需在 1–1440 分钟之间', '任务时长越界 toast');
  assertEq(await count('#taskList .task-row'), 0, '任务时长越界不创建任务');

  /* 3. invalid custom focus duration */
  await setValue('#taskCustomMinutes', '');
  assertEq(await text('#taskExpectedNote'), '1 小时', '清空任务自定义恢复默认提示');
  await setValue('#focusCustomMinutes', '481');
  assertIncludes(await text('#focusExpectedNote'), '需在 1–480 分钟之间', '单轮专注越界提示');
  await evalx(`document.querySelector('#taskForm').requestSubmit()`);
  await sleep(100);
  assertIncludes((await lastToast()).text, '单轮预期专注需在 1–480 分钟之间', '单轮专注越界 toast');
  assertEq(await count('#taskList .task-row'), 0, '单轮专注越界不创建任务');

  /* 4. valid custom values create the task */
  await setValue('#taskCustomMinutes', '90');
  await setValue('#focusCustomMinutes', '30');
  await evalx(`document.querySelector('#taskForm').requestSubmit()`);
  await waitFor(`document.querySelectorAll('#taskList .task-row').length === 1`, 'custom task added');
  let rows = await taskRows();
  assertEq(rows[0].title, '自定义任务', '自定义任务标题');
  assertEq(rows[0].meta, '预期完成 1 小时 30 分钟 · 单轮专注 30 分钟', '自定义任务元信息');
  assertEq(rows[0].startText, '开始专注', '新任务按钮文案');
  assertOk(rows[0].hasDelete, '任务带删除按钮');
  let settings = await storage('focus.settings.v3');
  assertEq(settings.defaultExpectedTaskMs, 90 * MIN, '上次预期完成时长被记住');
  assertEq(settings.defaultExpectedFocusMs, 30 * MIN, '上次单轮专注被记住');

  /* 5. preset chips + multiple tasks, newest first */
  await addTask({ title: '回邮件', taskMinutes: 30, focusMinutes: 15 });
  await addTask({ title: '复盘', taskMinutes: 120, focusMinutes: 45 });
  assertEq(await count('#taskList .task-row'), 3, '三个任务');
  assertEq(await text('#taskCount'), '3', '任务计数 3');
  assertEq(await text('#taskListNote'), '按创建时间', '任务列表排序提示');
  rows = await taskRows();
  assertDeepEq(rows.map((row) => row.title), ['复盘', '回邮件', '自定义任务'], '任务按创建时间倒序');
  assertEq(rows[1].meta, '预期完成 30 分钟 · 单轮专注 15 分钟', '预设任务元信息');
  settings = await storage('focus.settings.v3');
  assertEq(settings.defaultExpectedTaskMs, 120 * MIN, '最新任务默认值持久化');
  assertEq(settings.defaultExpectedFocusMs, 45 * MIN, '最新专注默认值持久化');

  /* 6. reload keeps tasks + remembers form defaults */
  await reloadApp();
  assertEq(await count('#taskList .task-row'), 3, '刷新后任务仍在');
  rows = await taskRows();
  assertDeepEq(rows.map((row) => row.title), ['复盘', '回邮件', '自定义任务'], '刷新后任务顺序不变');
  assertEq(await text('#taskExpectedNote'), '2 小时', '刷新后表单默认预期完成时长');
  assertEq(await text('#focusExpectedNote'), '45 分钟', '刷新后表单默认单轮专注');

  await clearToasts();
  await shot('v3-desktop-tasks-dark.png');
  await assertNoHorizontalOverflow('桌面任务清单');
}

async function s3_startModal() {
  await resetApp();
  await addTask({ title: '写邮件', taskMinutes: 60, focusMinutes: 30 });
  await startTaskByName('写邮件');
  let modal = await modalInfo();
  assertOk(modal.visible, '开始专注弹窗可见');
  assertEq(modal.title, '开始专注', '弹窗标题');
  assertIncludes(modal.body, '「写邮件」', '弹窗任务名');
  assertIncludes(modal.body, '预期完成 1 小时 · 计划单轮专注 30 分钟', '弹窗任务计划');
  assertEq(modal.confirm, '开始专注', '弹窗确认按钮');
  assertEq(modal.cancel, '取消', '弹窗取消按钮');

  /* default should be the task plan (30 min, a custom value) */
  assertIncludes(modal.body, '本轮 30 分钟', '弹窗默认取任务计划值');
  assertOk(await hasClass('#modalBody .chip-custom', 'is-active'), '非预设计划值时自定义 chip 高亮');
  const customValue = await evalx(`document.querySelector('#modalBody input[type=number]').value`);
  assertEq(
    await hasClass('#modalBody .chip[data-minutes="25"]', 'is-active'),
    false,
    '默认 30 分钟时 25 分钟预设不高亮'
  );
  assertEq(customValue, '30', '弹窗默认把非预设计划值回填到自定义输入框（P2-01 修复验证）');
  await clearToasts();
  await shot('v3-desktop-start-modal.png');

  /* invalid custom round expectation blocks confirm */
  await setValue('#modalBody input[type=number]', '0');
  await click('#modalConfirm');
  await sleep(140);
  assertOk((await modalInfo()).visible, '非法自定义时长时弹窗不关闭');
  assertIncludes((await lastToast()).text, '本轮预期专注需在 1–480 分钟之间', '弹窗自定义越界 toast');
  await setValue('#modalBody input[type=number]', '481');
  await click('#modalConfirm');
  await sleep(140);
  assertOk((await modalInfo()).visible, '上限越界时弹窗不关闭');
  assertIncludes((await lastToast()).text, '本轮预期专注需在 1–480 分钟之间', '弹窗自定义上限 toast');

  /* keyboard accessibility probe: can keyboard users reach the duration chips? */
  const focusSequence = [];
  for (let i = 0; i < 4; i += 1) {
    await key('Tab', 'Tab', 9);
    focusSequence.push(
      await evalx(`document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null`)
    );
  }
  assertOk(
    focusSequence.some((item) => item === 'INPUT' || item === 'BUTTON'),
    `弹窗内时长控件可通过 Tab 到达（P2-03 修复验证，序列 ${JSON.stringify(focusSequence)}）`
  );

  /* choose 15 min preset and start */
  await click('#modalBody .chip[data-minutes="15"]');
  await click('#modalConfirm');
  await waitView('session');
  assertOk(!(await modalInfo()).visible, '开始后弹窗关闭');
  const state = await sessionState();
  assertEq(state.roundLabel, '第 1 轮 · 专注中', '第一轮标签');
  assertEq(state.taskTitle, '写邮件', '会话任务名');
  assertEq(state.timeDisplay, '00:00', '正计时从 0 开始');
  assertEq(state.timerPhase, '专注中', '计时阶段');
  assertEq(state.timerSub, '本轮预期 15 分钟 · 还剩 15:00', '本轮预期提示');
  assertEq(state.roundFocus, '0 秒', '本轮专注 0 秒');
  assertEq(state.avgFocus, '—', '尚无平均每轮');
  assertEq(state.taskElapsed, '0 秒', '任务耗时 0 秒');
  assertEq(state.rounds, '0 轮', '已完成轮次 0');
  assertEq(state.taskMeta, '任务预期 1 小时 · 已耗时 0 秒（含暂停）', '任务耗时含暂停提示');
  assertEq(state.pauseText, '暂停', '运行态暂停按钮');
  assertEq(state.controls.join('|'), '暂停|下一轮|完成任务', '运行态三个按钮');
  assertEq(state.nextPanelVisible, false, '运行态隐藏下一轮预期面板');
  assertEq(state.backToListVisible, false, '运行态隐藏返回清单');
  const session = await storage('focus.session.v3');
  assertEq(session.phase, 'running', '存储中的会话为 running');
  assertEq(session.expectedFocusMs, 15 * MIN, '本轮预期 15 分钟已保存');
  assertEq(session.rounds.length, 0, '存储中尚无轮次');
}

async function s4_mainFlow() {
  await resetApp();
  await addTask({ title: '写方案', taskMinutes: 120, focusMinutes: 25 });
  await startTaskByName('写方案');
  assertIncludes((await modalInfo()).body, '本轮 25 分钟', '默认本轮预期取任务计划');
  await click('#modalBody .chip[data-minutes="15"]');
  await click('#modalConfirm');
  await waitView('session');
  await clearToasts();

  /* positive stopwatch + round hint */
  log('推进 5 分钟，验证正计时');
  await advance(5 * MIN);
  let state = await sessionState();
  assertEq(state.timeDisplay, '05:00', '正计时 5 分钟');
  assertEq(state.timerPhase, '专注中', '未达标阶段');
  assertEq(state.timerSub, '本轮预期 15 分钟 · 还剩 10:00', '剩余时间提示');
  assertEq(state.roundFocus, '5 分钟', '本轮专注统计');
  assertEq(state.taskElapsed, '5 分钟', '任务耗时统计');
  assertEq(state.taskMeta, '任务预期 2 小时 · 已耗时 5 分钟（含暂停）', '任务耗时（含暂停）');
  assertEq(state.rounds, '0 轮', '本轮未结束不计轮次');
  assertEq(state.title, '05:00 · 写方案', '页面标题显示计时');

  /* target reached does not stop anything */
  log('超过本轮预期 2 分钟，验证达标不自动停');
  await advance(12 * MIN);
  state = await sessionState();
  assertEq(state.timeDisplay, '17:00', '达标后继续计时');
  assertEq(state.timerPhase, '本轮达标', '达标文案');
  assertEq(state.timerSub, '本轮预期 15 分钟 · 已超出 02:00', '已超出提示');
  assertEq(state.roundReached, 'true', '达标状态标记');
  assertEq(state.phase, 'running', '达标后仍在运行');
  assertEq(state.rounds, '0 轮', '达标不自动计轮');
  await clearToasts();
  await shot('v3-desktop-session.png');

  /* pause = end + count the round, task stays active */
  log('推进到 18 分钟并暂停');
  await advance(1 * MIN);
  await click('#pauseBtn');
  await sleep(200);
  state = await sessionState();
  assertEq(state.phase, 'paused', '暂停后 phase=paused');
  assertEq(state.pauseText, '继续', '暂停后按钮变继续');
  assertEq(state.roundLabel, '已完成 1 轮 · 已暂停', '暂停轮次标签');
  assertEq(state.timeDisplay, '18:00', '暂停冻结本轮计时');
  assertEq(state.timerSub, '本轮实际 18 分钟 / 预期 15 分钟', '暂停时实际/预期');
  assertEq(state.rounds, '1 轮', '暂停计为一轮');
  assertEq(state.roundFocus, '18 分钟', '本轮实际专注');
  assertEq(state.avgFocus, '18 分钟', '平均每轮专注');
  assertEq(state.taskElapsed, '18 分钟', '任务耗时');
  assertEq(state.controls.join('|'), '继续|完成任务', '暂停态两个按钮');
  assertEq(state.nextHidden, true, '暂停态隐藏下一轮按钮');
  assertEq(state.nextPanelVisible, true, '暂停态显示下一轮预期面板');
  assertEq(state.backToListVisible, true, '暂停态显示返回任务清单');
  assertEq(state.nextNote, '下一轮 15 分钟', '下一轮默认与上一轮一致');
  let session = await storage('focus.session.v3');
  assertEq(session.phase, 'paused', '存储中会话 paused');
  assertEq(session.rounds.length, 1, '存储中 1 轮');
  assertEq(session.rounds[0].actualMs, 18 * MIN, '存储轮次实际 18 分钟');
  await clearToasts();
  await shot('v3-desktop-paused.png');

  /* task duration keeps running while paused; focus time does not */
  log('暂停中推进 7 分钟，验证任务耗时包含暂停而专注不增长');
  await advance(7 * MIN);
  state = await sessionState();
  assertEq(state.taskElapsed, '25 分钟', '任务耗时包含暂停（18+7）');
  assertEq(state.roundFocus, '18 分钟', '暂停期间本轮专注不增长');
  assertEq(state.rounds, '1 轮', '暂停期间轮次不变');
  assertEq(state.timeDisplay, '18:00', '暂停期间计时冻结');

  /* choose next round expectation (preset, custom, invalid) */
  log('修改下一轮预期专注 45 → 20 分钟');
  await click('#nextFocusChips .chip[data-next-minutes="45"]');
  await sleep(100);
  assertEq(await text('#nextFocusNote'), '下一轮 45 分钟', '预设下一轮预期');
  assertOk(
    await hasClass('#nextFocusChips .chip[data-next-minutes="45"]', 'is-active'),
    '下一轮预设选中态'
  );
  await setValue('#nextCustomMinutes', '20');
  await sleep(100);
  assertEq(await text('#nextFocusNote'), '下一轮 20 分钟', '自定义下一轮预期');
  assertOk(await hasClass('#nextCustomChip', 'is-active'), '自定义 chip 选中');
  await setValue('#nextCustomMinutes', '481');
  await sleep(100);
  assertIncludes(await text('#nextFocusNote'), '需在 1–480 分钟', '下一轮自定义越界提示');
  session = await storage('focus.session.v3');
  assertEq(session.nextExpectedFocusMs, 20 * MIN, '越界输入不写入存储');
  await setValue('#nextCustomMinutes', '20');
  await sleep(100);

  /* resume starts round 2 with the chosen plan */
  log('继续 → 第 2 轮（预期 20 分钟）');
  await click('#pauseBtn');
  await sleep(200);
  state = await sessionState();
  assertEq(state.phase, 'running', '继续后 running');
  assertEq(state.roundLabel, '第 2 轮 · 专注中', '第 2 轮标签');
  assertEq(state.timerSub, '本轮预期 20 分钟 · 还剩 20:00', '第 2 轮预期生效');
  assertEq(state.timeDisplay, '00:00', '新一轮从 0 计时');
  assertEq(state.rounds, '1 轮', '轮次保留');
  assertEq(state.avgFocus, '18 分钟', '平均每轮保留');
  assertEq(state.taskElapsed, '25 分钟', '任务耗时跨轮累计');
  session = await storage('focus.session.v3');
  assertEq(session.expectedFocusMs, 20 * MIN, '存储本轮预期 20 分钟');
  assertEq(session.rounds.length, 1, '存储轮次 1');

  /* round 2 over target, then "下一轮" ends it and starts round 3 */
  log('第 2 轮 21 分钟（超预期）→ 下一轮');
  await advance(21 * MIN);
  state = await sessionState();
  assertEq(state.timeDisplay, '21:00', '第 2 轮计时');
  assertEq(state.timerPhase, '本轮达标', '第 2 轮达标');
  assertEq(state.phase, 'running', '第 2 轮达标不自动停');
  await click('#nextBtn');
  await sleep(200);
  state = await sessionState();
  assertEq(state.phase, 'running', '下一轮后仍运行');
  assertEq(state.roundLabel, '第 3 轮 · 专注中', '第 3 轮标签');
  assertEq(state.rounds, '2 轮', '下一轮结束并计入上一轮');
  assertEq(state.timeDisplay, '00:00', '第 3 轮从 0 开始');
  assertEq(state.timerSub, '本轮预期 20 分钟 · 还剩 20:00', '第 3 轮沿用当前预期');
  assertEq(state.avgFocus, '20 分钟', '两轮平均专注 (18+21)/2≈19.5→20');
  assertEq(state.taskElapsed, '46 分钟', '任务耗时 46 分钟');
  session = await storage('focus.session.v3');
  assertEq(session.rounds.length, 2, '存储中 2 轮');
  assertEq(session.rounds[1].actualMs, 21 * MIN, '第 2 轮实际 21 分钟');

  /* complete the task → confirmation modal with expected vs actual */
  log('第 3 轮 4 分钟 → 完成任务');
  await advance(4 * MIN);
  await click('#completeBtn');
  await waitModal();
  const modal = await modalInfo();
  assertEq(modal.title, '完成任务并保存记录？', '完成弹窗标题');
  assertIncludes(modal.body, '「写方案」', '完成弹窗任务名');
  assertIncludes(modal.body, '任务耗时：实际 50 分钟 / 预期 2 小时（快 1 小时 10 分钟）', '完成弹窗任务耗时对比');
  assertIncludes(modal.body, '专注：3 轮 · 共 43 分钟 · 平均 14 分钟/轮（预期 18 分钟）', '完成弹窗专注对比');
  assertIncludes(modal.body, '任务耗时包含轮间暂停', '完成弹窗说明');
  assertEq(modal.confirm, '保存记录', '完成弹窗确认按钮');
  await clearToasts();
  await shot('v3-desktop-complete-modal.png');

  await click('#modalConfirm');
  await waitView('tasks');
  await sleep(250);

  /* record saved with expected vs actual */
  const records = await storage('focus.records.v3');
  assertEq(records.length, 1, '保存 1 条记录');
  const record = records[0];
  assertEq(record.title, '写方案', '记录任务名');
  assertEq(record.roundsTotal, 3, '记录 3 轮');
  assertEq(record.roundsWithExpected, 3, '记录 3 轮均有预期');
  assertEq(record.focusTotalMs, 43 * MIN, '记录总专注 43 分钟');
  assertEq(record.expectedFocusTotalMs, 55 * MIN, '记录预期专注合计 55 分钟');
  assertEq(record.taskDurationMs, 50 * MIN, '记录任务耗时 50 分钟（含暂停）');
  assertEq(record.expectedTaskMs, 120 * MIN, '记录任务预期 2 小时');
  assertEq(record.avgFocusMs, (43 / 3) * MIN, '记录平均专注 43/3 分钟');
  assertEq(record.rounds[0].actualMs, 18 * MIN, '记录第 1 轮 18 分钟');
  assertEq(record.rounds[1].actualMs, 21 * MIN, '记录第 2 轮 21 分钟');
  assertEq(record.rounds[2].actualMs, 4 * MIN, '记录第 3 轮 4 分钟');
  const expectedDateKey = await evalx(`(() => {
    const d = new Date(${record.endedAt});
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  })()`);
  assertEq(record.dateKey, expectedDateKey, '记录日期键');
  assertEq(await count('#taskList .task-row'), 0, '完成任务后从待办移除');

  /* records list rendering */
  const nodes = await recordNodes();
  assertEq(await recordCount(), 1, '记录计数 1');
  assertEq(nodes.length, 1, '记录节点 1');
  assertEq(nodes[0].title, '写方案', '记录卡片任务名');
  assertEq(
    nodes[0].meta,
    `${clockOf(record.startedAt)} – ${clockOf(record.endedAt)} · 3 轮 · 总专注 43 分钟`,
    '记录时间段/轮次/总专注'
  );
  assertEq(nodes[0].metrics[0].label, '任务耗时', '记录任务耗时行');
  assertEq(nodes[0].metrics[0].value, '实际 50 分钟 / 预期 2 小时', '记录任务耗时值');
  assertEq(nodes[0].metrics[0].delta, '快 1 小时 10 分钟', '记录任务耗时差异');
  assertIncludes(nodes[0].metrics[0].deltaClass, 'is-good', '任务更快显示绿色差异');
  assertEq(nodes[0].metrics[1].label, '专注均值', '记录专注均值行');
  assertEq(nodes[0].metrics[1].value, '平均 14 分钟 / 轮 · 预期 18 分钟', '记录专注均值');
  assertEq(nodes[0].metrics[1].delta, '-4 分钟', '记录专注差异');
  assertIncludes(nodes[0].metrics[1].deltaClass, 'is-bad', '专注更短显示警示差异');
  assertOk(nodes[0].hasDelete, '记录删除按钮');

  /* sidebar: today overview + efficiency comparison */
  assertEq(await text('#statTodayFocus'), '43', '今日专注 43 分钟');
  assertEq(await text('#statAvgFocus'), '14', '今日平均每轮 14 分钟');
  assertEq(await text('#statAvgFocusNote'), '预期 18 分钟', '今日平均对比预期');
  assertEq(await text('#statTodayTasks'), '1', '今日完成任务 1');
  assertEq(await text('#statTodayTasksNote'), '共 3 轮', '今日完成任务轮次');
  assertEq(await text('#statStreak'), '1', '连续专注 1 天');
  assertEq(await text('#totalNote'), '今天 1 个任务', '今日概览提示');
  assertEq(await text('#effTaskActual'), '50 分钟', '效率对比任务实际');
  assertEq(await text('#effTaskExpected'), '2 小时', '效率对比任务预期');
  assertEq(await text('#effTaskDelta'), '快 1 小时 10 分钟', '效率对比任务差异');
  assertIncludes(await attr('#effTaskDelta', 'class'), 'is-good', '任务差异颜色');
  assertEq(await text('#effFocusActual'), '14 分钟', '效率对比专注实际');
  assertEq(await text('#effFocusExpected'), '18 分钟', '效率对比专注预期');
  assertEq(await text('#effFocusDelta'), '-4 分钟', '效率对比专注差异');
  assertIncludes(await attr('#effFocusDelta', 'class'), 'is-bad', '专注差异颜色');
  assertEq(await text('#weekTotal'), '共 43 分钟', '近 7 天总专注');
  assertEq(await count('#weekChart .week-col'), 7, '近 7 天柱状图 7 列');
  const todayBar = await evalx(
    `(() => { const fill = document.querySelector('#weekChart .week-col.is-today .week-bar i'); return fill ? fill.style.height : null; })()`
  );
  assertMatches(todayBar, /%$/, '今日柱状图有高度');

  await clearToasts();
  await shot('v3-desktop-records-dark.png');

  /* light theme */
  await click('#themeToggle');
  await sleep(150);
  assertEq(await evalx('document.documentElement.dataset.theme'), 'light', '切换到浅色主题');
  let settings = await storage('focus.settings.v3');
  assertEq(settings.theme, 'light', '浅色主题持久化');
  await clearToasts();
  await shot('v3-desktop-records-light.png');
  await shot('v3-desktop-tasks-light.png');

  /* refresh keeps records, stats and the light theme */
  await reloadApp();
  assertEq(await recordCount(), 1, '刷新后记录仍在');
  assertEq(await text('#statTodayFocus'), '43', '刷新后今日专注保留');
  assertEq(await text('#statTodayTasks'), '1', '刷新后完成任务数保留');
  assertEq(await text('#statAvgFocus'), '14', '刷新后平均专注保留');
  assertEq(await evalx('document.documentElement.dataset.theme'), 'light', '刷新后浅色主题保留');
  await click('#themeToggle');
  await sleep(120);
  assertEq(await evalx('document.documentElement.dataset.theme'), 'dark', '切回深色主题');
}

async function s5_recordsActions() {
  await resetApp();
  await createRecordViaUI('记录删除测试', 30, 15, 20);
  assertEq(await recordCount(), 1, '准备 1 条记录');

  /* delete + undo */
  await click('.record .record-delete');
  await sleep(180);
  assertEq(await recordCount(), 0, '删除后记录为 0');
  const toast = await lastToast();
  assertIncludes(toast.text, '已删除「记录删除测试」的记录', '删除记录 toast');
  assertEq(toast.action, '撤销', '删除 toast 带撤销');
  await click('#toastStack .toast:last-child .toast-action');
  await sleep(200);
  assertEq(await recordCount(), 1, '撤销后记录恢复');
  assertIncludes((await lastToast()).text, '已恢复记录', '撤销恢复 toast');

  /* clear needs confirmation, cancel keeps data */
  await click('#clearRecords');
  await waitModal();
  const modal = await modalInfo();
  assertEq(modal.title, '清空全部完成记录？', '清空弹窗标题');
  assertIncludes(modal.body, '将删除 1 条完成记录，此操作不可撤销。', '清空弹窗说明');
  assertEq(modal.confirm, '清空记录', '清空弹窗确认按钮');
  assertIncludes(modal.confirmClass, 'btn-danger', '清空为危险操作样式');
  await click('#modalCancel');
  await waitModalClosed();
  assertEq(await recordCount(), 1, '取消清空不删记录');

  /* clear all */
  await click('#clearRecords');
  await waitModal();
  await click('#modalConfirm');
  await sleep(250);
  assertEq(await recordCount(), 0, '清空后记录为 0');
  assertIncludes((await text('#recordsList')).replace(/\s+/g, ' '), '还没有完成记录', '清空后空状态');
  assertEq(await text('#statTodayFocus'), '0', '清空后今日专注归零');
  assertEq(await text('#statTodayTasks'), '0', '清空后完成任务归零');
  assertEq(await text('#statStreak'), '0', '清空后连续天数归零');
  assertOk(await evalx(`document.querySelector('#clearRecords').hidden`), '清空后清空按钮隐藏');
  assertEq(await count('.record'), 0, '清空后无记录节点');
  const records = await storage('focus.records.v3');
  assertEq(Array.isArray(records) && records.length, 0, '清空后存储为空数组');
  await reloadApp();
  assertEq(await recordCount(), 0, '刷新后清空状态保持');

  /* clearing also clears any stale delete-undo toast (P2-02 fix) */
  await createRecordViaUI('记录A', 30, 15, 10);
  await createRecordViaUI('记录B', 30, 15, 10);
  assertEq(await recordCount(), 2, '准备 2 条记录');
  await evalx(`(() => {
    const target = Array.from(document.querySelectorAll('.record')).find(
      (node) => node.querySelector('.record-task').textContent.trim() === '记录A'
    );
    target.querySelector('.record-delete').click();
    return true;
  })()`);
  await sleep(150);
  assertOk(await evalx(`!!document.querySelector('#toastStack .toast-action')`), '删除记录后出现撤销 toast');
  await click('#clearRecords');
  await waitModal();
  await click('#modalConfirm');
  await sleep(200);
  assertEq(await recordCount(), 0, '清空后 2 条记录都没了');
  assertEq(
    await evalx(`!!document.querySelector('#toastStack .toast-action')`),
    false,
    '清空记录同步清空旧的删除撤销 toast（P2-02 修复验证）'
  );
  assertIncludes((await lastToast()).text, '已清空完成记录', '清空记录 toast');
  await sleep(300);
  assertEq(await recordCount(), 0, '无残留撤销入口，记录保持为空');
  assertEq(await recordCount(), 0, '清理后记录保持为 0');
}

async function s6_concurrencyResumeRefresh() {
  await resetApp();
  await addTask({ title: '写方案', taskMinutes: 120, focusMinutes: 25 });
  await addTask({ title: '回邮件', taskMinutes: 30, focusMinutes: 15 });
  await addTask({ title: '复盘', taskMinutes: 60, focusMinutes: 45 });

  /* start the first task, focus 3 min, pause */
  await startFocusWithPreset('写方案', 15);
  await advance(3 * MIN);
  await click('#pauseBtn');
  await sleep(200);
  await click('#backToListBtn');
  await waitView('tasks');
  let rows = await taskRows();
  const activeRow = rows.find((row) => row.title === '写方案');
  assertOk(activeRow && activeRow.active, '活动任务行高亮');
  assertEq(activeRow.startText, '继续专注', '活动任务按钮为继续专注');
  assertEq(activeRow.progress, '暂停中 · 已专注 3 分钟 · 1 轮', '清单中显示任务进度');
  assertEq(rows[0].title, '写方案', '活动任务置顶显示');
  assertEq(await count('#taskList .task-row'), 3, '任务清单仍有 3 个任务');
  assertEq(await text('#taskCount'), '3', '任务计数不变');

  /* other tasks cannot start while one is active */
  const blockedRows = rows.filter((row) => row.title !== '写方案');
  blockedRows.forEach((row) => assertOk(row.startDisabled, `${row.title} 开始按钮被禁用`));
  blockedRows.forEach((row) => assertEq(row.startAriaDisabled, 'true', `${row.title} aria-disabled`));
  await clickTaskAction('回邮件', '.task-start');
  await sleep(150);
  assertIncludes((await lastToast()).text, '请先完成或结束当前任务，再开始其他任务', '并发任务阻止 toast');
  assertEq(await evalx('document.body.dataset.view'), 'tasks', '阻止后仍停留在清单');
  const sessionBefore = await storage('focus.session.v3');
  assertEq(sessionBefore.phase, 'paused', '阻止后原会话保持暂停');

  /* continue from the list: modal shows progress, default plan = 15 */
  await startTaskByName('写方案');
  let modal = await modalInfo();
  assertEq(modal.title, '继续专注', '继续专注弹窗标题');
  assertIncludes(modal.body, '已专注 3 分钟 · 1 轮 · 任务暂停中', '继续弹窗显示进度');
  assertIncludes(modal.body, '本轮 15 分钟', '继续弹窗默认下一轮预期');
  assertEq(modal.confirm, '继续专注', '继续弹窗确认按钮');
  await click('#modalConfirm');
  await waitView('session');
  let state = await sessionState();
  assertEq(state.roundLabel, '第 2 轮 · 专注中', '继续后进入第 2 轮');
  assertEq(state.timerSub, '本轮预期 15 分钟 · 还剩 15:00', '继续后新一轮预期');
  assertEq(state.rounds, '1 轮', '继续后轮次保留');

  /* refresh while running → restored as paused, rounds/time kept */
  log('运行中刷新，验证 running→paused 恢复');
  await advance(2 * MIN);
  await reloadApp();
  await sleep(300);
  assertEq(await evalx('document.body.dataset.view'), 'session', '刷新后回到会话视图');
  state = await sessionState();
  assertEq(state.phase, 'paused', '运行中刷新后恢复为暂停');
  assertEq(state.roundLabel, '已完成 2 轮 · 已暂停', '刷新恢复轮次标签');
  assertEq(state.rounds, '2 轮', '刷新恢复轮次数');
  assertEq(state.roundFocus, '2 分钟', '刷新恢复当前轮实际时长');
  assertEq(state.timerSub, '本轮实际 2 分钟 / 预期 15 分钟', '刷新恢复实际/预期');
  assertEq(state.taskElapsed, '5 分钟', '刷新恢复任务耗时');
  const restoredSession = await storage('focus.session.v3');
  assertEq(restoredSession.phase, 'paused', '存储会话恢复为 paused');
  assertEq(restoredSession.rounds.length, 2, '存储保留 2 轮');
  assertEq(restoredSession.rounds[1].actualMs, 2 * MIN, '存储第 2 轮实际 2 分钟');
  const tasksAfterRestore = await storage('focus.tasks.v3');
  assertEq(tasksAfterRestore.length, 3, '运行中刷新后任务清单不重复/不丢失');
  await waitToast('已恢复上次专注', '恢复 toast');

  /* continue, then discard (task kept, no record) */
  await click('#pauseBtn');
  await sleep(200);
  state = await sessionState();
  assertEq(state.roundLabel, '第 3 轮 · 专注中', '恢复后继续进入第 3 轮');
  await advance(1 * MIN);
  await click('#discardBtn');
  await waitModal();
  modal = await modalInfo();
  assertEq(modal.title, '结束本次专注？', '结束专注弹窗标题');
  assertIncludes(modal.body, '不会保存为完成记录', '结束专注弹窗说明');
  assertEq(modal.confirm, '结束专注', '结束专注确认按钮');
  assertEq(modal.cancel, '继续专注', '结束专注取消按钮');
  await click('#modalCancel');
  await waitModalClosed();
  assertEq((await sessionState()).phase, 'running', '取消结束后仍在专注');
  await click('#discardBtn');
  await waitModal();
  await click('#modalConfirm');
  await waitView('tasks');
  assertEq(await text('#taskCount'), '3', '结束专注后任务保留在清单');
  rows = await taskRows();
  assertEq(rows.find((row) => row.title === '写方案').startText, '开始专注', '任务恢复为可重新开始');
  assertEq(rows.find((row) => row.title === '写方案').progress, '', '任务不再显示暂停进度');
  assertEq(await recordCount(), 0, '结束专注不生成记录');
  assertEq(await storage('focus.session.v3'), null, '结束专注清除会话存储');

  /* delete a todo (needs confirmation) */
  await deleteTaskByName('复盘');
  modal = await modalInfo();
  assertEq(modal.title, '删除任务？', '删除任务弹窗标题');
  assertIncludes(modal.body, '任务会从待办清单移除，不会生成完成记录', '删除待办说明');
  assertEq(modal.confirm, '删除', '删除任务确认');
  await click('#modalCancel');
  await waitModalClosed();
  assertEq(await count('#taskList .task-row'), 3, '取消删除保留任务');
  await deleteTaskByName('复盘');
  await waitModal();
  await click('#modalConfirm');
  await sleep(200);
  assertEq(await count('#taskList .task-row'), 2, '确认删除后移除任务');
  assertEq(await text('#taskCount'), '2', '删除后计数 2');

  /* deleting the paused active task ends the session without a record */
  await startFocusWithPreset('写方案', 15);
  await advance(2 * MIN);
  await click('#pauseBtn');
  await sleep(200);
  await click('#backToListBtn');
  await waitView('tasks');
  await deleteTaskByName('写方案');
  modal = await modalInfo();
  assertIncludes(modal.body, '该任务正在专注中。删除会结束当前专注，且不会生成完成记录。', '删除进行中任务说明');
  assertEq(modal.confirm, '删除', '删除进行中任务确认');
  await click('#modalConfirm');
  await sleep(250);
  assertEq(await count('#taskList .task-row'), 1, '删除活动任务后仅剩 1 个');
  assertEq(await recordCount(), 0, '删除进行中任务不生成记录');
  assertEq(await storage('focus.session.v3'), null, '删除活动任务清除会话');
  rows = await taskRows();
  assertOk(!rows[0].startDisabled, '无活动任务时其他任务可开始');
  assertEq(await evalx('document.body.dataset.view'), 'tasks', '删除后停留在任务清单');

  /* completing a task with no round yet keeps it and saves nothing */
  await startFocusWithPreset('回邮件', 15);
  await click('#completeBtn');
  await waitModal();
  modal = await modalInfo();
  assertEq(modal.title, '结束任务？', '0 轮完成弹窗标题');
  assertIncludes(modal.body, '还没有产生专注轮次，不会生成完成记录', '0 轮完成说明');
  assertEq(modal.confirm, '结束专注', '0 轮完成确认按钮');
  await click('#modalConfirm');
  await waitView('tasks');
  assertEq(await count('#taskList .task-row'), 1, '0 轮完成保留任务');
  assertEq(await recordCount(), 0, '0 轮完成不生成记录');
  assertEq(await storage('focus.session.v3'), null, '0 轮完成清除会话');
}

async function s7_keyboardShortcuts() {
  await resetApp();
  await addTask({ title: '快捷键任务', taskMinutes: 60, focusMinutes: 10 });
  await startFocusWithPreset('快捷键任务', null);
  await advance(5 * MIN);

  /* Space pauses (ends the round) */
  await focusSession();
  await key('Space', ' ', 32);
  await sleep(150);
  let state = await sessionState();
  assertEq(state.phase, 'paused', '空格暂停');
  assertEq(state.rounds, '1 轮', '空格暂停计入一轮');
  assertEq(state.timerSub, '本轮实际 5 分钟 / 预期 10 分钟', '空格暂停后的实际/预期');

  /* Space resumes with a new round */
  await advance(2 * MIN);
  await focusSession();
  await key('Space', ' ', 32);
  await sleep(150);
  state = await sessionState();
  assertEq(state.phase, 'running', '空格继续');
  assertEq(state.roundLabel, '第 2 轮 · 专注中', '空格继续开始新一轮');
  assertEq(state.timerSub, '本轮预期 10 分钟 · 还剩 10:00', '空格继续的预期时长');

  /* N ends the round immediately and starts the next one */
  await advance(3 * MIN);
  await focusSession();
  await key('KeyN', 'n', 78);
  await sleep(150);
  state = await sessionState();
  assertEq(state.rounds, '2 轮', 'N 结束当前轮');
  assertEq(state.roundLabel, '第 3 轮 · 专注中', 'N 立即开始下一轮');
  assertEq(state.timeDisplay, '00:00', 'N 后新一轮从 0 计时');

  /* Enter completes → modal; Esc closes it; Enter again saves */
  await advance(2 * MIN);
  await focusSession();
  await key('Enter', 'Enter', 13);
  await waitModal();
  assertEq((await modalInfo()).title, '完成任务并保存记录？', 'Enter 打开完成弹窗');
  await key('Escape', 'Escape', 27);
  await waitModalClosed();
  assertEq((await sessionState()).phase, 'running', 'Esc 关闭弹窗但任务继续');
  await focusSession();
  await key('Enter', 'Enter', 13);
  await waitModal();
  await click('#modalConfirm');
  await waitView('tasks');
  await sleep(250);
  assertEq(await recordCount(), 1, 'Enter 快捷键保存记录');
  const records = await storage('focus.records.v3');
  const record = records[0];
  assertEq(record.roundsTotal, 3, '快捷键流程 3 轮');
  assertEq(record.focusTotalMs, 10 * MIN, '快捷键流程总专注 10 分钟');
  assertEq(record.taskDurationMs, 12 * MIN, '快捷键流程任务耗时 12 分钟（含暂停）');
  const nodes = await recordNodes();
  assertEq(nodes[0].metrics[0].value, '实际 12 分钟 / 预期 1 小时', '快捷键记录任务耗时');
  assertEq(nodes[0].metrics[0].delta, '快 48 分钟', '快捷键记录任务差异');
  assertEq(nodes[0].metrics[1].value, '平均 3 分钟 / 轮 · 预期 10 分钟', '快捷键记录专注均值');
  assertEq(nodes[0].metrics[1].delta, '-7 分钟', '快捷键记录专注差异');
}

async function s8_mobile() {
  await setViewport(390, 844, true, 2);
  await resetApp();
  await addTask({ title: '整理周报', taskMinutes: 60, focusMinutes: 25 });
  await addTask({ title: '回邮件', taskMinutes: 30, focusMinutes: 15 });
  await addTask({ title: '复盘', taskMinutes: 45, focusMinutes: 15 });
  assertEq(await count('#taskList .task-row'), 3, '移动端 3 个任务');
  await clearToasts();
  await shot('v3-mobile-tasks.png');
  await assertNoHorizontalOverflow('移动端任务清单');

  await startFocusWithPreset('整理周报', 15);
  await advance(4 * MIN);
  await clearToasts();
  await shot('v3-mobile-session.png');
  await assertNoHorizontalOverflow('移动端会话运行中');
  let state = await sessionState();
  assertEq(state.timeDisplay, '04:00', '移动端正计时');

  await click('#pauseBtn');
  await sleep(250);
  await clearToasts();
  await shot('v3-mobile-paused.png');
  await assertNoHorizontalOverflow('移动端会话暂停中');
  state = await sessionState();
  assertEq(state.phase, 'paused', '移动端暂停');
  assertEq(state.nextPanelVisible, true, '移动端显示下一轮预期面板');
  const controlBoxes = await evalx(`(() => Array.from(document.querySelectorAll('#controls button'))
    .filter((button) => !button.hidden)
    .map((button) => { const rect = button.getBoundingClientRect(); return { left: rect.left, right: rect.right, text: button.textContent.trim() }; }))()`);
  controlBoxes.forEach((box) =>
    assertOk(box.left >= -1 && box.right <= 390 + 1, `移动端按钮 ${box.text} 不超出视口`)
  );
  const nextPanelBox = await evalx(`(() => {
    const rect = document.querySelector('#nextFocusPanel').getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  })()`);
  assertOk(nextPanelBox.right <= 390 + 1 && nextPanelBox.left >= -1, '移动端下一轮面板不横向溢出');
  await setViewport(1440, 900, false, 1);
  await sleep(200);
}

async function s9_migration() {
  await resetApp();
  await goto(BLANK_URL);
  await sleep(200);
  await evalx(`(() => {
    localStorage.clear();
    const now = Date.now();
    const legacyRecords = [
      {
        v: 2, id: 'r_v2_1', taskName: '写方案', targetMs: 25 * 60000, totalFocusedMs: 15 * 60000,
        roundsTotal: 2, rounds: [10 * 60000, 5 * 60000],
        startedAt: now - 30 * 60000, endedAt: now,
      },
      {
        v: 2, id: 'r_v2_2', taskName: '回邮件', targetMs: 15 * 60000, totalFocusedMs: 20 * 60000,
        roundsTotal: 1, rounds: [20 * 60000],
        startedAt: now - 60 * 60000, endedAt: now - 30 * 60000,
      },
    ];
    localStorage.setItem('focus.records.v1', JSON.stringify(legacyRecords));
    localStorage.setItem('focus.session.v1', JSON.stringify({
      v: 2, id: 's_old', taskName: '旧会话任务', targetMs: 45 * 60000,
      startedAt: now - 30 * 60000, rounds: [{ focusedMs: 20 * 60000 }], phase: 'paused',
    }));
    localStorage.setItem('focus.settings.v1', JSON.stringify({
      theme: 'light', sound: true, defaultTargetMs: 30 * 60000,
    }));
    return true;
  })()`);
  await goto(INDEX_URL);
  await waitAppReady();
  await sleep(300);

  assertEq(await evalx('document.documentElement.dataset.theme'), 'light', 'v2 设置迁移主题（light）');
  const settings = await storage('focus.settings.v3');
  assertOk(settings && settings.theme === 'light', 'v3 settings 已迁移写入');
  assertEq(settings.defaultExpectedFocusMs, 30 * MIN, 'v2 targetMs 迁移为默认单轮专注');
  assertEq(await recordCount(), 2, 'v2 记录迁移为 2 条 v3 记录');
  const nodes = await recordNodes();
  assertDeepEq(nodes.map((node) => node.title), ['写方案', '回邮件'], 'v2 记录按时间倒序迁移');
  assertEq(nodes[0].metrics[0].value, '实际 15 分钟 / 预期 25 分钟', '迁移记录任务耗时对比');
  assertEq(nodes[0].metrics[0].delta, '快 10 分钟', '迁移记录任务差异');
  assertIncludes(nodes[0].metrics[1].value, '平均 8 分钟 / 轮', '迁移记录平均专注');
  assertEq(await count('#taskList .task-row'), 1, 'v2 会话迁移为 1 个待办任务');
  const rows = await taskRows();
  assertEq(rows[0].title, '旧会话任务', '迁移任务名');
  assertEq(rows[0].meta, '预期完成 45 分钟 · 单轮专注 45 分钟', '迁移任务计划');
  assertEq(await text('#statTodayTasks'), '2', '迁移生效于今日统计');
  assertEq(await text('#statAvgFocus'), '12', '迁移生效于平均专注');
  assertEq(await text('#statAvgFocusNote'), '预期 —', '旧记录无专注预期');
  const keys = await storageKeys();
  ['focus.tasks.v3', 'focus.records.v3', 'focus.settings.v3'].forEach((key) =>
    assertOk(keys.includes(key), `迁移写入 ${key}`)
  );
  ['focus.session.v1', 'focus.records.v1', 'focus.settings.v1'].forEach((key) =>
    assertOk(keys.includes(key), `旧键保留 ${key}（不丢数据）`)
  );
  assertEq((await storage('focus.records.v3')).length, 2, 'v3 存储 2 条记录');
  assertEq((await storage('focus.tasks.v3')).length, 1, 'v3 存储 1 个任务');
  const errorsNow = consoleProblems.length;
  assertEq(errorsNow, 0, '迁移过程无 console error');
}

async function s10_orphanSessionRecovery() {
  await resetApp();
  /* simulate a persisted running session whose todo task is missing (e.g. an
     interrupted v2→v3 transition): the app must restore the round as paused and
     re-create the task in the todo list instead of losing it. */
  await evalx(`(() => {
    const now = Date.now();
    localStorage.setItem('focus.session.v3', JSON.stringify({
      v: 3, id: 's_orphan', taskId: 't_orphan', taskTitle: '孤儿任务',
      taskExpectedMs: 60 * 60000, expectedFocusMs: 25 * 60000, nextExpectedFocusMs: 25 * 60000,
      phase: 'running', startedAt: now - 10 * 60000, roundStartedAt: now - 10 * 60000,
      roundElapsedMs: 0, rounds: [], savedAt: now, restored: false,
    }));
    return true;
  })()`);
  await reloadApp();
  await sleep(300);
  assertEq(await evalx('document.body.dataset.view'), 'session', '孤儿会话恢复回到会话视图');
  const state = await sessionState();
  assertEq(state.phase, 'paused', '孤儿会话恢复为暂停');
  assertEq(state.roundLabel, '已完成 1 轮 · 已暂停', '孤儿会话当前轮计入');
  assertEq(state.roundFocus, '10 分钟', '孤儿会话恢复实际时长');
  assertEq(state.taskTitle, '孤儿任务', '孤儿会话任务名');
  const tasks = await storage('focus.tasks.v3');
  assertEq(tasks.length, 1, '孤儿会话补建任务到清单');
  assertEq(tasks[0].title, '孤儿任务', '补建任务名');
  assertEq(tasks[0].id, 't_orphan', '补建任务沿用会话 taskId');
  await click('#backToListBtn');
  await waitView('tasks');
  const rows = await taskRows();
  assertEq(rows.length, 1, '清单显示补建任务');
  assertEq(rows[0].progress, '暂停中 · 已专注 10 分钟 · 1 轮', '补建任务进度可继续');
  assertEq(rows[0].startText, '继续专注', '补建任务可继续专注');
}

/* ------------------------------------------------------------------------ *
 * console error collection
 * ------------------------------------------------------------------------ */

function collectConsoleEvent(event) {
  if (event.method === 'Runtime.exceptionThrown') {
    const details = event.params.exceptionDetails || {};
    consoleProblems.push({
      kind: 'exception',
      text: (details.exception && details.exception.description) || details.text,
    });
  } else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
    consoleProblems.push({
      kind: 'console.error',
      text: event.params.args.map((arg) => arg.value || arg.description || '').join(' '),
    });
  } else if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
    consoleProblems.push({
      kind: 'log.error',
      text: `${event.params.entry.text} ${event.params.entry.url || ''}`.trim(),
    });
  }
}

/* ------------------------------------------------------------------------ *
 * source hashes + main
 * ------------------------------------------------------------------------ */

function hashSources() {
  const crypto = require('node:crypto');
  const hashes = {};
  ['index.html', 'styles.css', 'focus-core.js', 'app.js'].forEach((file) => {
    try {
      hashes[file] = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, file)))
        .digest('hex');
    } catch (err) {
      hashes[file] = null;
    }
  });
  return hashes;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  BASE = await ensurePreview();
  INDEX_URL = BASE + '/index.html';
  BLANK_URL = BASE + '/.qa/blank.html';
  log(`预览服务器 ${BASE}`);

  await closeStaleChrome();
  chromeChild = await launchChrome();
  const target = await waitForTarget();
  client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await setViewport(1440, 900, false, 1);
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(function () {
      var KEY_BASE = 'qa.clockBase';
      var KEY_OFF = 'qa.clockOffset';
      var realNow = Date.now.bind(Date);
      var base = NaN;
      var off = 0;
      try {
        base = Number(localStorage.getItem(KEY_BASE));
        off = Number(localStorage.getItem(KEY_OFF)) || 0;
      } catch (error) { /* opaque origin */ }
      if (!Number.isFinite(base) || base <= 0) {
        base = Math.floor(realNow() / 1000) * 1000;
        try { localStorage.setItem(KEY_BASE, String(base)); } catch (error) {}
      }
      var now = base + off;
      window.__qa = {
        advance: function (ms) {
          now += ms;
          try { localStorage.setItem(KEY_OFF, String(now - base)); } catch (error) {}
          return now;
        },
        now: function () { return now; },
        base: function () { return base; },
      };
      Date.now = function () { return now; };
    })();`,
  });

  const startedAt = new Date().toISOString();
  await scenario('S1 初始状态（干净 origin）', s1_bootEmpty);
  await scenario('S2 任务清单：自定义校验 / 多任务 / 默认值持久化', s2_taskForm);
  await scenario('S3 开始专注弹窗：默认计划值 / 自定义校验', s3_startModal);
  await scenario('S4 主流程：正计时 → 达标不停 → 暂停计轮 → 改预期 → 下一轮 → 完成记录', s4_mainFlow);
  await scenario('S5 记录操作：删除撤销 / 清空确认 / 持久化', s5_recordsActions);
  await scenario('S6 返回清单 / 继续 / 阻止并发任务 / 刷新恢复 / 删除任务', s6_concurrencyResumeRefresh);
  await scenario('S7 键盘快捷键（空格 / N / Enter / Esc）', s7_keyboardShortcuts);
  await scenario('S8 移动端 390×844 无横向溢出', s8_mobile);
  await scenario('S9 v2 数据迁移（records / session / settings）', s9_migration);
  await scenario('S10 孤儿会话恢复：任务不在清单时补建待办', s10_orphanSessionRecovery);

  client.events.forEach(collectConsoleEvent);
  const relevant = consoleProblems.filter((problem) => !/favicon|ERR_ABORTED/i.test(problem.text || ''));
  console.log(`\n控制台检查：${relevant.length} 个 error / exception`);
  relevant.slice(0, 8).forEach((problem) => console.error(`  ! ${problem.kind}: ${problem.text}`));

  const passed = scenarios.filter((item) => item.ok).length;
  const failed = scenarios.length - passed;

  const result = {
    app: 'Focus v3',
    kind: 'e2e',
    baseUrl: BASE,
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceHashes: hashSources(),
    scenarios: scenarios.map((item) => ({
      name: item.name,
      ok: item.ok,
      assertions: item.assertions,
      error: item.error,
    })),
    totals: {
      scenarios: scenarios.length,
      passed,
      failed,
      assertions: assertionCount,
      knownDefects: defects.length,
      consoleErrors: relevant.length,
    },
    defects,
    consoleProblems: relevant,
  };
  fs.writeFileSync(path.join(OUT, 'v3-e2e-results.json'), JSON.stringify(result, null, 2));

  console.log('\n──────── E2E Summary ────────');
  scenarios.forEach((item) => {
    console.log(
      `${item.ok ? '✔' : '✖'} ${item.name} · ${item.assertions} checks${
        item.error ? ` — ${item.error}` : ''
      }`
    );
  });
  console.log(
    `场景 ${passed}/${scenarios.length} 通过 · 断言 ${assertionCount} 项 · 已知缺陷 ${defects.length} 项 · console error ${relevant.length} 项`
  );
  console.log(`结果文件: ${path.relative(ROOT, path.join(OUT, 'v3-e2e-results.json'))}`);
  if (failed > 0) process.exitCode = 1;
  if (relevant.length > 0) process.exitCode = 1;
  return result;
}

async function cleanup() {
  try {
    if (client) {
      await client.send('Browser.close').catch(() => {});
      client.close();
    }
  } catch (err) {
    /* ignore */
  }
  client = null;
  if (chromeChild) {
    try {
      chromeChild.kill('SIGKILL');
    } catch (err) {
      /* ignore */
    }
    chromeChild = null;
  }
  if (serverChild) {
    try {
      serverChild.kill('SIGKILL');
    } catch (err) {
      /* ignore */
    }
    serverChild = null;
  }
}

process.on('SIGINT', () => {
  cleanup().finally(() => process.exit(130));
});
process.on('SIGTERM', () => {
  cleanup().finally(() => process.exit(143));
});

main()
  .catch((error) => {
    console.error('\nE2E 运行失败:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
