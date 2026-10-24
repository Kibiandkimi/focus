#!/usr/bin/env node
/*
 * Focus — v2 end-to-end verification over the Chrome DevTools Protocol.
 *
 *   node tests/e2e.cjs
 *
 * v2 semantics verified here:
 *   - one target duration for the WHOLE task (hint/statistic, never auto-stops)
 *   - count UP from 00:00; passing the target keeps running and shows overtime
 *   - pause = end current round (counted) + task paused; controls become 继续 / 完成
 *   - continue / next round start a new round in the same task; next round has no confirm dialog
 *   - complete saves a record with actual time / target time + rounds + progress meter
 *   - refresh restores a running task as paused without losing rounds/actual time
 *   - rounds shorter than 1s are not counted
 *   - records persisted in localStorage; delete + undo; clear all
 *   - keyboard shortcuts, theme/sound persistence, custom duration validation, mobile layout
 *
 * No dependencies: Node 24 built-in WebSocket + child_process.
 * The clock is injected before app scripts with Page.addScriptToEvaluateOnNewDocument
 * (Date.now offset persisted in localStorage), so 25-minute countdowns run in ms.
 * Screenshots go to .qa/ (never /tmp); Chrome profile lives in .qa/ and is cleaned up.
 */
'use strict';

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

/* ------------------------------------------------------------------------- */
/* configuration                                                             */
/* ------------------------------------------------------------------------- */

const ROOT = path.resolve(__dirname, '..');
const QA_DIR = path.join(ROOT, '.qa');
const REPORT_PATH = path.join(QA_DIR, 'e2e-results-v2.json');
const CHROME_BIN = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT = Number(process.env.QA_CDP_PORT || 9444);
const PREVIEW_PORT = Number(process.env.QA_PREVIEW_PORT || 4173);
const FALLBACK_PREVIEW_PORT = 4181;
const PROFILE_DIR = path.join(QA_DIR, 'chrome-qa-profile-v2');
const CHROME_HOME = path.join(QA_DIR, 'chrome-qa-home-v2');
const APP_URL_BASE = `http://127.0.0.1:${PREVIEW_PORT}/index.html`;

// Deterministic wall-clock start for every scenario: 2026-10-24 10:00 local.
// Month is 0-based for the page-side Date constructor: 9 === October.
const BASE_ARGS = [2026, 9, 24, 10, 0, 0];

const MIN = 60 * 1000;
const SEC = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REPORT = {
  schema: 'focus-e2e-v2',
  startedAt: new Date().toISOString(),
  environment: {},
  preview: {},
  tests: [],
  consoleErrors: [],
  consoleWarnings: [],
  dialogs: [],
  screenshots: [],
  observations: [],
};

let appUrl = APP_URL_BASE;
let appOrigin = new URL(APP_URL_BASE).origin;
let cleanupUrl = appOrigin + '/.qa/blank.html';
let chromeProcess = null;
let fallbackServer = null;
let cdp = null;

const ONLY = process.env.QA_ONLY
  ? process.env.QA_ONLY.split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  : null;

function selected(key) {
  return !ONLY || ONLY.includes(key);
}

/* ------------------------------------------------------------------------- */
/* logging / assertions                                                      */
/* ------------------------------------------------------------------------- */

function log(message) {
  process.stdout.write(message + '\n');
}

function fail(message) {
  throw new Error(message);
}

function fmt(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}\n    期望: ${fmt(expected)}\n    实际: ${fmt(actual)}`);
  }
}

function assertTrue(condition, label) {
  if (!condition) fail(label);
}

function assertIncludes(haystack, needle, label) {
  const text = haystack == null ? '' : String(haystack);
  if (!text.includes(needle)) {
    fail(`${label}\n    期望包含: ${fmt(needle)}\n    实际: ${fmt(text)}`);
  }
}

function assertMatch(text, regexp, label) {
  if (!regexp.test(String(text == null ? '' : text))) {
    fail(`${label}\n    期望匹配: ${regexp}\n    实际: ${fmt(text)}`);
  }
}

function assertBetween(value, min, max, label) {
  if (!(value >= min && value <= max)) {
    fail(`${label}\n    期望范围: [${min}, ${max}]\n    实际: ${value}`);
  }
}

function parseClock(text) {
  const parts = String(text == null ? '' : text)
    .trim()
    .split(':')
    .map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

/** Assert a clock string like 00:05 / 1:05:00 (tolerates drift). */
function assertClock(actual, expectedText, label, toleranceSec = 2) {
  const actualSec = parseClock(actual);
  const expectedSec = parseClock(expectedText);
  if (!Number.isFinite(actualSec)) {
    fail(`${label}\n    无法解析时钟文本: ${fmt(actual)}（期望 ${expectedText}）`);
  }
  if (Math.abs(actualSec - expectedSec) > toleranceSec) {
    fail(`${label}\n    期望: ${expectedText} (±${toleranceSec}s)\n    实际: ${fmt(actual)}`);
  }
}

function note(id, title, detail, severity = 'info') {
  REPORT.observations.push({ id, title, detail, severity });
}

/* ------------------------------------------------------------------------- */
/* HTTP helpers                                                              */
/* ------------------------------------------------------------------------- */

function httpGetJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`JSON 解析失败: ${url}`));
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`请求超时: ${url}`)));
  });
}

function httpGetStatus(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', () => resolve(0));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(0);
    });
  });
}

function writeCleanupPageFixture() {
  // 同源清理页：不加载应用脚本，避免 beforeunload 回写 session；data: favicon 避免 404 噪声。
  fs.mkdirSync(QA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(QA_DIR, 'blank.html'),
    '<!doctype html>\n<meta charset="utf-8">\n<link rel="icon" href="data:,">\n<title>QA cleanup page</title>\n<p>Focus QA cleanup page</p>\n'
  );
}

async function resolveCleanupPage() {
  appOrigin = new URL(appUrl).origin;
  cleanupUrl = appOrigin + '/.qa/blank.html';
  if (await httpGetStatus(cleanupUrl) === 200) return;
  // 预览服务器根目录不包含 .qa/ 时，退化为同源静态资源页（同样没有应用脚本）
  cleanupUrl = appOrigin + '/focus-core.js';
  const status = await httpGetStatus(cleanupUrl);
  assertEqual(status, 200, `同源清理页不可用: ${cleanupUrl}`);
}

async function ensurePreviewServer() {
  writeCleanupPageFixture();
  const status = await httpGetStatus(appUrl);
  if (status === 200) {
    await resolveCleanupPage();
    REPORT.preview = {
      url: appUrl,
      reused: true,
      note: '复用后台已运行的 4173 预览服务器',
      cleanupPage: cleanupUrl,
    };
    log(`✓ 预览服务器可用: ${appUrl} (HTTP ${status})`);
    return;
  }

  log(`! ${appUrl} 不可用 (HTTP ${status})，启动备用 python3 http.server:${FALLBACK_PREVIEW_PORT}`);
  fallbackServer = spawn('python3', ['-m', 'http.server', String(FALLBACK_PREVIEW_PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env },
  });
  fallbackServer.stderr.on('data', () => {});
  appUrl = `http://127.0.0.1:${FALLBACK_PREVIEW_PORT}/index.html`;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await httpGetStatus(appUrl) === 200) {
      await resolveCleanupPage();
      REPORT.preview = {
        url: appUrl,
        reused: false,
        note: `4173 不可用，测试脚本自行启动 python3 -m http.server ${FALLBACK_PREVIEW_PORT}`,
        cleanupPage: cleanupUrl,
      };
      log(`✓ 备用预览服务器已启动: ${appUrl}`);
      return;
    }
    await sleep(100);
  }
  fail(`无法启动备用预览服务器: ${appUrl}`);
}

/* ------------------------------------------------------------------------- */
/* Chrome + CDP                                                              */
/* ------------------------------------------------------------------------- */

async function startChrome() {
  fs.mkdirSync(QA_DIR, { recursive: true });
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  fs.mkdirSync(CHROME_HOME, { recursive: true });

  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--window-size=1440,900',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    'about:blank',
  ];

  let chromeStderr = '';
  const child = spawn(CHROME_BIN, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HOME: CHROME_HOME,
      XDG_CONFIG_HOME: path.join(CHROME_HOME, '.config'),
      XDG_CACHE_HOME: path.join(CHROME_HOME, '.cache'),
      XDG_DATA_HOME: path.join(CHROME_HOME, '.local', 'share'),
    },
  });
  child.stderr.on('data', (chunk) => {
    chromeStderr = (chromeStderr + chunk.toString()).slice(-20000);
  });

  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (exitInfo) {
      fail(
        `Chrome 提前退出 (code=${exitInfo.code} signal=${exitInfo.signal})\n` +
          chromeStderr.split('\n').slice(-12).join('\n')
      );
    }
    try {
      const version = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 800);
      log(`✓ Chrome 已启动: ${version.Browser}`);
      return { child, version };
    } catch (error) {
      await sleep(100);
    }
  }
  try {
    child.kill('SIGKILL');
  } catch (error) {
    /* ignore */
  }
  fail(`Chrome 未在 CDP 端口 ${CDP_PORT} 上就绪\n${chromeStderr.split('\n').slice(-12).join('\n')}`);
  return null;
}

async function getPageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const page = targets.find(
        (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string'
      );
      if (page) return page;
    } catch (error) {
      /* not up yet */
    }
    await sleep(100);
  }
  fail('未找到可用的 page target');
  return null;
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.waiters = [];
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        this.ws.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => reject(new Error(`CDP WebSocket 连接失败: ${this.webSocketUrl}`));
      this.ws.addEventListener('open', onOpen, { once: true });
      this.ws.addEventListener('error', onError, { once: true });
    });
    this.ws.addEventListener('message', (event) => this.onMessage(event));
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, entry] of this.pending) entry.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
    return this;
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  onMessage(event) {
    let message = null;
    try {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      message = JSON.parse(raw);
    } catch (error) {
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message} (code ${message.error.code})`));
      else entry.resolve(message.result);
      return;
    }

    if (!message.method) return;

    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (waiter.method !== message.method) continue;
      if (waiter.predicate && !waiter.predicate(message.params)) continue;
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    }

    const handlers = this.listeners.get(message.method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(message.params, message.sessionId);
        } catch (error) {
          /* listener errors must not break the driver */
        }
      }
    }
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (!this.ws || this.ws.readyState !== 1) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`CDP WebSocket 未连接，无法发送 ${method}`));
        return;
      }
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitEvent(method, timeoutMs = 15000, predicate = null) {
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`CDP 事件等待超时: ${method}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------------- */
/* injected controllable clock                                               */
/* ------------------------------------------------------------------------- */

const CLOCK_SOURCE = `(() => {
  var KEY = '__focus_qa_clock_offset_v2';
  var realNow = Date.now.bind(Date);
  var offset = 0;
  try {
    var raw = localStorage.getItem(KEY);
    if (raw !== null) offset = Number(raw) || 0;
  } catch (error) {
    offset = 0;
  }
  Date.now = function () { return Math.round(realNow() + offset); };
  var clock = {
    offset: function () { return offset; },
    now: function () { return Date.now(); },
    real: function () { return realNow(); },
    set: function (ms) {
      offset = Math.round(Number(ms) || 0);
      try { localStorage.setItem(KEY, String(offset)); } catch (error) {}
      return offset;
    },
    seek: function (timestamp) { return clock.set(Number(timestamp) - realNow()); },
    seekLocal: function (year, monthIndex, day, hour, minute, second) {
      return clock.seek(new Date(year, monthIndex, day, hour || 0, minute || 0, second || 0, 0).getTime());
    },
    advance: function (ms) { return clock.set(offset + Math.round(Number(ms) || 0)); },
    reset: function () {
      offset = 0;
      try { localStorage.removeItem(KEY); } catch (error) {}
      return 0;
    }
  };
  window.__qaClock = clock;
})();`;

/* ------------------------------------------------------------------------- */
/* page snapshot + interactions                                              */
/* ------------------------------------------------------------------------- */

const SNAPSHOT_EXPR = `(() => {
  const $ = (sel) => document.querySelector(sel);
  const textOf = (el) => (el ? el.textContent.trim() : null);
  const txt = (sel) => textOf($(sel));
  const sessionView = $('#sessionView');
  const sessionVisible = !!(sessionView && !sessionView.classList.contains('is-hidden'));
  const modal = $('#modalBackdrop');
  const storage = {};
  ['focus.session.v1', 'focus.records.v1', 'focus.settings.v1'].forEach((key) => {
    try { storage[key] = localStorage.getItem(key); } catch (error) { storage[key] = null; }
  });
  const rectInfo = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      hiddenAttr: el.hidden === true,
      display: getComputedStyle(el).display,
      width: Math.round(rect.width * 100) / 100,
      left: Math.round(rect.left * 100) / 100,
      right: Math.round(rect.right * 100) / 100,
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden'
    };
  };
  const records = Array.from(document.querySelectorAll('#recordsList .record')).map((el) => {
    const meter = el.querySelector('.record-meter');
    const fill = el.querySelector('.record-meter i');
    return {
      id: el.dataset.id,
      task: textOf(el.querySelector('.record-task')),
      meta: textOf(el.querySelector('.record-meta')),
      targetLine: textOf(el.querySelector('.record-target')),
      meterWidth: fill ? fill.style.width : null,
      meterReached: meter ? meter.classList.contains('is-reached') : null
    };
  });
  const groups = Array.from(document.querySelectorAll('#recordsList .record-date')).map((el) => el.textContent.trim());
  const week = Array.from(document.querySelectorAll('#weekChart .week-col')).map((col) => {
    const fill = col.querySelector('.week-bar i');
    const label = col.querySelector('.week-day');
    return {
      label: label ? label.textContent.trim() : null,
      isToday: col.classList.contains('is-today'),
      isEmpty: col.classList.contains('is-empty'),
      height: fill ? fill.style.height : null,
      title: col.title
    };
  });
  const controls = Array.from(document.querySelectorAll('#controls .btn')).map((el) => ({
    text: el.textContent.trim(),
    info: rectInfo(el)
  }));
  const note = $('.session-note');
  return {
    ready: document.readyState,
    view: sessionVisible ? 'session' : 'setup',
    phase: sessionVisible ? sessionView.dataset.phase : 'idle',
    targetReached: sessionVisible ? sessionView.dataset.targetReached : null,
    targetReachedBody: document.body.dataset.targetReached || null,
    clock: txt('#timeDisplay'),
    timerPhase: txt('#timerPhase'),
    timerSub: txt('#timerSub'),
    roundLabel: txt('#roundLabel'),
    task: txt('#sessionTask'),
    pauseText: txt('#pauseBtn'),
    nextText: txt('#nextBtn'),
    completeText: txt('#completeBtn'),
    focus: txt('#sessionFocus'),
    rounds: txt('#sessionRounds'),
    progress: txt('#sessionProgress'),
    title: document.title,
    sessionNote: note ? note.textContent.trim() : null,
    startBtnText: txt('#startBtn'),
    durationNote: txt('#durationNote'),
    durationNoteWarning: $('#durationNote') ? $('#durationNote').classList.contains('is-warning') : null,
    todayLabel: txt('#todayLabel'),
    modalOpen: !!(modal && !modal.classList.contains('is-hidden')),
    modalTitle: txt('#modalTitle'),
    modalBody: txt('#modalBody'),
    modalConfirmText: txt('#modalConfirm'),
    recordsCount: txt('#recordsCount'),
    todayTime: txt('#statTodayTime'),
    todayRounds: txt('#statTodayRounds'),
    streak: txt('#statStreak'),
    weekTotal: txt('#weekTotal'),
    totalNote: txt('#totalNote'),
    theme: document.documentElement.dataset.theme,
    soundPressed: $('#soundToggle') ? $('#soundToggle').getAttribute('aria-pressed') : null,
    soundMuted: $('#soundToggle') ? $('#soundToggle').classList.contains('is-muted') : null,
    themeColor: (() => { const meta = document.querySelector('meta[name="theme-color"]'); return meta ? meta.getAttribute('content') : null; })(),
    records: records,
    groups: groups,
    week: week,
    emptyState: !!$('#recordsList .empty'),
    emptyHint: (() => { const el = $('#recordsList .empty-hint'); return el ? el.textContent.trim() : null; })(),
    clearInfo: rectInfo($('#clearRecords')),
    pauseInfo: rectInfo($('#pauseBtn')),
    nextInfo: rectInfo($('#nextBtn')),
    completeInfo: rectInfo($('#completeBtn')),
    controls: controls,
    toasts: Array.from(document.querySelectorAll('#toastStack .toast')).map((node) => node.textContent.trim()),
    toastActionLabels: Array.from(document.querySelectorAll('#toastStack .toast-action')).map((node) => node.textContent.trim()),
    storage: storage,
    injectedClock: !!(window.__qaClock && typeof window.__qaClock.advance === 'function')
  };
})()`;

async function evaluate(expression, options = {}) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: options.userGesture !== false,
  });
  if (response.exceptionDetails) {
    const description =
      (response.exceptionDetails.exception && response.exceptionDetails.exception.description) ||
      response.exceptionDetails.text ||
      '未知错误';
    throw new Error(`页面执行出错: ${description}\n  表达式: ${expression.slice(0, 200)}`);
  }
  return response.result ? response.result.value : undefined;
}

async function waitUntil(expression, label, timeoutMs = 6000) {
  const started = Date.now();
  let lastValue;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      lastValue = await evaluate(expression);
      if (lastValue) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await sleep(30);
  }
  throw new Error(
    `等待超时 (${timeoutMs}ms): ${label}\n  最后结果: ${fmt(lastValue)}` +
      (lastError ? `\n  最后错误: ${lastError.message}` : '')
  );
}

async function snap() {
  return evaluate(SNAPSHOT_EXPR);
}

async function click(selector) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error(${JSON.stringify('点击目标不存在: ' + selector)});
    el.click();
    return true;
  })()`);
  await sleep(40);
}

async function setInputValue(selector, value) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error(${JSON.stringify('输入框不存在: ' + selector)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
  await sleep(30);
}

async function focusElement(selector) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error(${JSON.stringify('元素不存在: ' + selector)});
    el.focus();
    return document.activeElement === el;
  })()`);
}

async function dispatchKey(key, code, targetSelector = 'body') {
  await evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(targetSelector)}) || document.body;
    const event = new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)},
      code: ${JSON.stringify(code)},
      bubbles: true,
      cancelable: true
    });
    target.dispatchEvent(event);
    return true;
  })()`);
  await sleep(60);
}

/** Advance the fake wall clock and let the app's 200ms tick render. */
async function advance(ms) {
  await evaluate(`window.__qaClock.advance(${ms})`);
  await sleep(340);
}

/** Advance the clock without waiting a full tick (for sub-second precision). */
async function advanceRaw(ms) {
  await evaluate(`window.__qaClock.advance(${ms})`);
  await sleep(30);
}

async function waitPhase(phase, timeoutMs = 5000) {
  await waitUntil(
    `(() => {
      const el = document.querySelector('#sessionView');
      return el && !el.classList.contains('is-hidden') && el.dataset.phase === ${JSON.stringify(phase)};
    })()`,
    `会话进入 ${phase} 状态`,
    timeoutMs
  );
}

async function waitText(selector, expected, timeoutMs = 5000) {
  await waitUntil(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return !!el && el.textContent.trim() === ${JSON.stringify(expected)};
    })()`,
    `${selector} 文本变为 ${expected}`,
    timeoutMs
  );
}

async function waitModal(timeoutMs = 5000) {
  await waitUntil(
    `(() => { const el = document.querySelector('#modalBackdrop'); return !!el && !el.classList.contains('is-hidden'); })()`,
    '确认弹窗出现',
    timeoutMs
  );
}

async function waitNoModal(timeoutMs = 5000) {
  await waitUntil(
    `(() => { const el = document.querySelector('#modalBackdrop'); return !!el && el.classList.contains('is-hidden'); })()`,
    '确认弹窗关闭',
    timeoutMs
  );
}

async function waitToastContains(fragment, timeoutMs = 5000) {
  await waitUntil(
    `(() => { const stack = document.querySelector('#toastStack'); return !!stack && stack.textContent.includes(${JSON.stringify(fragment)}); })()`,
    `toast 内容包含 ${fragment}`,
    timeoutMs
  );
}

async function waitSetup(timeoutMs = 5000) {
  await waitUntil(
    `(() => {
      const setup = document.querySelector('#setupView');
      const session = document.querySelector('#sessionView');
      return !!setup && !setup.classList.contains('is-hidden') && !!session && session.classList.contains('is-hidden');
    })()`,
    '回到设置视图',
    timeoutMs
  );
}

async function screenshot(name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const file = path.join(QA_DIR, name);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  const relative = path.relative(ROOT, file);
  REPORT.screenshots.push(relative);
  return relative;
}

/* ------------------------------------------------------------------------- */
/* navigation / app state helpers                                            */
/* ------------------------------------------------------------------------- */

async function waitReady() {
  await waitUntil(
    `(() => document.readyState === 'complete' && !!window.FocusCore && !!document.querySelector('#startBtn'))()`,
    '页面加载完成',
    15000
  );
  await sleep(60);
}

async function navigateRaw(url) {
  const loaded = cdp.waitEvent('Page.loadEventFired', 15000);
  await cdp.send('Page.navigate', { url });
  await loaded;
  await sleep(50);
}

async function navigate(url) {
  await navigateRaw(url);
  await waitReady();
}

async function reload() {
  const loaded = cdp.waitEvent('Page.loadEventFired', 15000);
  await cdp.send('Page.reload', { ignoreCache: false });
  await loaded;
  await waitReady();
}

/**
 * Clear all app state, load the app and reset the fake clock.
 * The app persists a running session on beforeunload, so clearing localStorage
 * before reloading the app page would be undone — therefore clear it on a
 * same-origin page that does not load the app, then load the app page fresh.
 */
async function resetApp(base = BASE_ARGS) {
  await navigateRaw(cleanupUrl);
  await waitUntil(`document.readyState === 'complete'`, '同源清理页就绪', 8000);
  await evaluate(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (error) {} return true; })()`);
  const keys = await evaluate(`(() => { const list = []; for (let i = 0; i < localStorage.length; i += 1) list.push(localStorage.key(i)); return list; })()`);
  assertEqual(keys.length, 0, `应用 localStorage 应已清空，实际残留: ${fmt(keys)}`);
  await navigate(appUrl);
  await evaluate(`window.__qaClock.seekLocal(${base.join(', ')})`);
  await sleep(120);
}

/** Reload while keeping localStorage (and therefore the fake clock offset). */
async function refresh() {
  await reload();
  await sleep(120);
}

async function startSession(options = {}) {
  const task = options.task === undefined ? '写项目提案' : options.task;
  const minutes = options.minutes === undefined ? 25 : options.minutes;
  const mode = options.mode || 'chip';

  if (task !== null) await setInputValue('#taskInput', task);
  if (mode === 'chip') {
    await click(`.chip[data-minutes="${minutes}"]`);
  } else {
    await setInputValue('#customMinutes', String(minutes));
  }
  await click('#startBtn');
  await waitPhase('running');
  await sleep(80);
}

async function clickStartExpectRunning(label) {
  await click('#startBtn');
  try {
    await waitPhase('running');
  } catch (error) {
    const debug = await snap();
    const form = await evaluate(`(() => ({
      custom: document.querySelector('#customMinutes').value,
      task: document.querySelector('#taskInput').value,
      durationNote: document.querySelector('#durationNote').textContent.trim(),
      toasts: document.querySelector('#toastStack').textContent.trim(),
      customChipClass: document.querySelector('#customChip').className
    }))()`);
    throw new Error(
      `${label} 点击开始后未进入 running：view=${debug.view}, phase=${debug.phase}, ` +
        `form=${fmt(form)}, session=${fmt(debug.storage['focus.session.v1'])}`
    );
  }
  await sleep(80);
}

async function confirmModal() {
  await waitModal();
  await click('#modalConfirm');
  await sleep(80);
}

async function cancelModal() {
  await waitModal();
  await click('#modalCancel');
  await waitNoModal();
}

async function completeSessionFlow() {
  await click('#completeBtn');
  await waitModal();
  await confirmModal();
  await waitSetup();
}

async function discardSessionFlow() {
  await click('#discardBtn');
  await waitModal();
  await confirmModal();
  await waitSetup();
}

/**
 * Seed v2 records into localStorage relative to the fake current day.
 * spec: { dayOffset, hour, task, totalFocusedMs, targetMs, roundsTotal, rounds }
 */
async function seedRecords(specs) {
  const count = await evaluate(`(() => {
    const specs = ${JSON.stringify(specs)};
    const now = Date.now();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    const records = specs.map((spec, index) => {
      const day = new Date(today.getTime());
      day.setDate(day.getDate() + (spec.dayOffset || 0));
      day.setHours(spec.hour == null ? 10 : spec.hour, spec.minute || 0, 0, 0);
      const endedAt = day.getTime();
      const totalFocusedMs = spec.totalFocusedMs;
      const targetMs = spec.targetMs || 25 * 60000;
      const startedAt = endedAt - totalFocusedMs;
      const dateKey = day.getFullYear() + '-' + pad(day.getMonth() + 1) + '-' + pad(day.getDate());
      const rounds = spec.rounds || [];
      return {
        v: 2,
        id: 'seed_' + index,
        taskName: spec.task,
        targetMs: targetMs,
        totalFocusedMs: totalFocusedMs,
        roundsTotal: spec.roundsTotal == null ? Math.max(1, rounds.length) : spec.roundsTotal,
        roundsCompleted: spec.roundsCompleted == null ? Math.max(1, rounds.length) : spec.roundsCompleted,
        rounds: rounds,
        targetReached: spec.targetReached == null ? totalFocusedMs >= targetMs : spec.targetReached,
        startedAt: startedAt,
        endedAt: endedAt,
        dateKey: dateKey
      };
    });
    localStorage.setItem('focus.records.v1', JSON.stringify(records));
    return records.length;
  })()`);
  assertEqual(count, specs.length, '预置记录数量');
  await refresh();
}

async function seedStorage(session, records) {
  await evaluate(`(() => {
    if (${JSON.stringify(session)} !== null) {
      localStorage.setItem('focus.session.v1', JSON.stringify(${JSON.stringify(session)}));
    } else {
      localStorage.removeItem('focus.session.v1');
    }
    if (${JSON.stringify(records)} !== null) {
      localStorage.setItem('focus.records.v1', JSON.stringify(${JSON.stringify(records)}));
    }
    return true;
  })()`);
  await refresh();
}

function readStorageJson(snapshot, key) {
  const raw = snapshot.storage[key];
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`localStorage[${key}] 不是合法 JSON: ${fmt(raw)}`);
    return null;
  }
}

async function formatSpanOf(ms) {
  return evaluate(`window.FocusCore.formatSpan(${Number(ms)})`);
}

async function minutesLabelOf(ms) {
  return evaluate(`window.FocusCore.minutesLabel(${Number(ms)})`);
}

function expectedMeterWidth(actualMs, targetMs) {
  return `${Math.min(100, Math.max(2, Math.round((actualMs / targetMs) * 100)))}%`;
}

/** Assert the record card in the DOM matches the persisted record. */
async function assertRecordCard(snap, record, index, label) {
  const card = snap.records[index];
  assertTrue(card, `${label}: 记录卡片存在`);
  assertEqual(card.task, record.taskName, `${label}: 记录任务名`);
  assertMatch(card.meta, /^\d{2}:\d{2} – \d{2}:\d{2} · \d+ 轮$/, `${label}: 记录时间段与轮数文案`);
  assertEqual(
    card.targetLine,
    `实际 ${await formatSpanOf(record.totalFocusedMs)} / 目标 ${await formatSpanOf(record.targetMs)}`,
    `${label}: 实际 / 目标 文案`
  );
  assertEqual(
    card.meterWidth,
    expectedMeterWidth(record.totalFocusedMs, record.targetMs),
    `${label}: 达成条宽度`
  );
  assertEqual(
    card.meterReached,
    record.totalFocusedMs >= record.targetMs,
    `${label}: 达成条 is-reached 状态`
  );
}

/* ------------------------------------------------------------------------- */
/* test harness                                                              */
/* ------------------------------------------------------------------------- */

async function runTest(name, fn) {
  const started = Date.now();
  process.stdout.write(`• ${name} ... `);
  try {
    await fn();
    const ms = Date.now() - started;
    REPORT.tests.push({ name, ok: true, ms });
    log(`PASS (${ms}ms)`);
  } catch (error) {
    const ms = Date.now() - started;
    REPORT.tests.push({ name, ok: false, ms, error: error.message });
    log('FAIL');
    log(`    ${String(error.message).split('\n').join('\n    ')}`);
  }
}

/* ------------------------------------------------------------------------- */
/* scenarios                                                                 */
/* ------------------------------------------------------------------------- */

async function scenarioSetupAndEmptyState() {
  await runTest('B1 首屏 v2：默认 25 分钟、正计时 00:00、空状态与 v2 文案', async () => {
    await resetApp();
    const s = await snap();

    assertEqual(s.injectedClock, true, '可控时钟注入成功');
    assertEqual(s.view, 'setup', '首屏应显示设置视图');
    assertEqual(s.modalOpen, false, '首屏不应有弹窗');
    assertMatch(s.todayLabel, /^\d{1,2}月\d{1,2}日 · 周[日一二三四五六]$/, '顶栏日期格式');

    const activeChip = await evaluate(`(() => {
      const chip = document.querySelector('#durationChips .chip.is-active');
      return chip ? { minutes: chip.dataset.minutes, checked: chip.getAttribute('aria-checked') } : null;
    })()`);
    assertEqual(activeChip && activeChip.minutes, '25', '默认选中的预设时长');
    assertEqual(activeChip && activeChip.checked, 'true', '默认预设 aria-checked');
    assertEqual(s.durationNote, '整个任务 25 分钟', '目标时长提示为「整个任务」语义');
    assertIncludes(s.startBtnText, '开始任务', '开始按钮文案');
    assertEqual(s.clock, '00:00', '计时器初始为 00:00（正计时）');
    assertIncludes(s.sessionNote, '目标时长只作提示，不会自动结束任务', '会话说明文案强调目标只作提示');

    assertEqual(s.recordsCount, '0', '记录计数');
    assertEqual(s.emptyState, true, '记录区应显示空状态');
    assertIncludes(s.emptyHint, '实际时长与目标时长', '空状态说明实际/目标');
    assertEqual(s.todayTime, '0', '今日专注分钟');
    assertEqual(s.todayRounds, '0', '今日完成轮次');
    assertEqual(s.streak, '0', '连续天数');
    assertEqual(s.weekTotal, '暂无记录', '近 7 天合计文案');
    assertEqual(s.week.length, 7, '7 日图列数');
    assertEqual(s.week[6].isToday, true, '最后一列是今天');
    assertTrue(s.week.every((day) => day.isEmpty), '无记录时 7 日图所有列都为空');
    assertEqual(s.clearInfo.display, 'none', '无记录时「清空」按钮应隐藏');
    assertEqual(s.toasts.length, 0, '首屏不应有残留 toast');
    assertEqual(s.storage['focus.session.v1'], null, '无会话时不应写入 session');
    assertEqual(s.storage['focus.records.v1'], null, '无记录时不应写入 records');

    await screenshot('v2-desktop-setup-dark.png');
  });
}

async function scenarioStartPauseResume() {
  await runTest('B2 正计时 → 暂停计轮（仅剩继续/完成）→ 继续新一轮 → 完成记录', async () => {
    await resetApp();
    await startSession({ task: '写项目提案', minutes: 15 });

    let s = await snap();
    assertEqual(s.view, 'session', '开始后切换到计时视图');
    assertEqual(s.phase, 'running', '开始后 phase=running');
    assertEqual(s.task, '写项目提案', '计时视图任务名');
    assertEqual(s.roundLabel, '第 1 轮 · 专注中', '轮次标签');
    assertEqual(s.timerPhase, '专注中', '计时阶段文案');
    assertEqual(s.clock, '00:00', '从 0 开始正计时');
    assertEqual(s.timerSub, '目标 15 分钟 · 还剩 15:00', '目标剩余说明');
    assertEqual(s.pauseText, '暂停', '暂停按钮文案');
    assertEqual(s.nextText, '下一轮', '下一轮按钮文案');
    assertEqual(s.completeText, '完成', '完成按钮文案');
    assertEqual(s.rounds, '0 轮', '已完成轮次');
    assertEqual(s.progress, '0%', '目标进度');
    assertEqual(s.targetReached, 'false', '未达成目标');

    const stored = readStorageJson(s, 'focus.session.v1');
    assertEqual(stored.v, 2, 'session 结构为 v2');
    assertEqual(stored.phase, 'running', '持久化 phase');
    assertEqual(stored.targetMs, 15 * MIN, '目标时长是整个任务的目标');
    assertEqual(stored.rounds.length, 0, '初始没有轮次');
    assertEqual(stored.roundIndex, undefined, 'v2 不再有 roundIndex');

    await advance(5 * MIN);
    s = await snap();
    assertClock(s.clock, '05:00', '快进 5 分钟后的正计时', 2);
    assertEqual(s.focus, '5 分钟', '本次专注 5 分钟');
    assertEqual(s.progress, '33%', '目标进度 33%');
    assertClock(s.timerSub.replace('目标 15 分钟 · 还剩 ', ''), '10:00', '距目标还剩 10 分钟', 2);
    assertEqual(s.title, `${s.clock} · 写项目提案`, '运行中文档标题显示已专注时间');

    await screenshot('v2-desktop-session-running.png');

    // 暂停 = 结束当前轮并计入轮次，任务不结束
    await click('#pauseBtn');
    await waitPhase('paused');
    const paused = await snap();
    assertEqual(paused.roundLabel, '已完成 1 轮 · 已暂停', '暂停后轮次标签');
    assertEqual(paused.pauseText, '继续', '暂停后按钮变为继续');
    assertEqual(paused.nextInfo.hiddenAttr, true, '暂停后「下一轮」按钮隐藏');
    assertEqual(paused.nextInfo.display, 'none', '暂停后「下一轮」按钮不渲染');
    assertEqual(paused.nextInfo.visible, false, '暂停后「下一轮」不可见');
    assertEqual(paused.completeInfo.visible, true, '暂停后「完成」按钮可见');
    const visibleControls = paused.controls.filter((control) => control.info.visible).map((c) => c.text);
    assertEqual(visibleControls.length, 2, `暂停态应只有 2 个操作按钮，实际 ${fmt(visibleControls)}`);
    assertTrue(visibleControls.includes('继续'), '暂停态包含「继续」');
    assertTrue(visibleControls.includes('完成'), '暂停态包含「完成」');
    assertIncludes(paused.toasts.join(' | '), '第 1 轮结束', '暂停 toast 说明轮次结束');
    assertIncludes(paused.toasts.join(' | '), '任务已暂停', '暂停 toast 说明任务暂停');
    assertEqual(paused.phase, 'paused', 'phase=paused');
    assertEqual(paused.rounds, '1 轮', '已完成轮次 1');
    const pausedClock = paused.clock;
    const pausedFocus = paused.focus;

    const storedPaused = readStorageJson(paused, 'focus.session.v1');
    assertEqual(storedPaused.phase, 'paused', '暂停后持久化 phase');
    assertEqual(storedPaused.rounds.length, 1, '暂停后持久化 1 条轮次');
    assertBetween(storedPaused.rounds[0].focusedMs, 5 * MIN, 5 * MIN + 3000, '轮次时长约 5 分钟');
    assertEqual(storedPaused.rounds[0].targetMs, undefined, '轮次不再带 per-round target');

    await screenshot('v2-desktop-session-paused.png');

    // 暂停期间快进：时间冻结、任务仍在
    await advance(3 * MIN);
    const frozen = await snap();
    assertEqual(frozen.clock, pausedClock, '暂停期间快进后计时冻结');
    assertEqual(frozen.focus, pausedFocus, '暂停期间快进后累计专注冻结');
    assertEqual(frozen.phase, 'paused', '暂停期间保持 paused');

    // 继续 = 开始下一轮（累计时间不丢）
    await click('#pauseBtn');
    await waitPhase('running');
    s = await snap();
    assertEqual(s.roundLabel, '第 2 轮 · 专注中', '继续后进入第 2 轮');
    assertEqual(s.clock, pausedClock, '继续后已累计时间保持');
    assertEqual(s.nextInfo.visible, true, '继续后「下一轮」按钮恢复');
    assertIncludes(s.toasts.join(' | '), '第 2 轮开始', '继续 toast 说明第 2 轮开始');

    await advance(2 * MIN);
    s = await snap();
    assertClock(s.clock, '07:00', '继续 2 分钟后的累计时间', 2);
    assertEqual(s.rounds, '1 轮', '继续不改变已完成轮次');
    assertEqual(s.progress, '47%', '目标进度 47%');

    // 下一轮：结束当前轮并立即开新一轮，无确认弹窗
    await click('#nextBtn');
    s = await snap();
    assertEqual(s.modalOpen, false, '「下一轮」不应出现确认弹窗');
    assertEqual(s.roundLabel, '第 3 轮 · 专注中', '下一轮后进入第 3 轮');
    assertEqual(s.rounds, '2 轮', '下一轮后已完成轮次 2');
    assertClock(s.clock, '07:00', '下一轮不丢失已累计时间', 2);

    await advance(3 * MIN);
    s = await snap();
    assertClock(s.clock, '10:00', '第 3 轮再走 3 分钟', 2);

    // 完成并保存：实际 / 目标 + 轮数
    await click('#completeBtn');
    await waitModal();
    s = await snap();
    assertEqual(s.modalTitle, '完成任务并保存记录？', '完成确认弹窗标题');
    assertIncludes(s.modalBody, '「写项目提案」', '完成弹窗显示任务名');
    assertIncludes(s.modalBody, '实际专注', '完成弹窗显示实际专注时间');
    assertIncludes(s.modalBody, '距目标 15 分钟 还差 5 分钟', '完成弹窗显示距目标差额');
    assertIncludes(s.modalBody, '共 3 轮', '完成弹窗显示轮数');
    await confirmModal();
    await waitSetup();

    s = await snap();
    assertEqual(s.recordsCount, '1', '保存后记录数 1');
    const record = readStorageJson(s, 'focus.records.v1')[0];
    assertEqual(record.v, 2, '记录结构 v2');
    assertEqual(record.taskName, '写项目提案', '记录任务名');
    assertEqual(record.targetMs, 15 * MIN, '记录保存设定时间');
    assertBetween(record.totalFocusedMs, 10 * MIN, 10 * MIN + 4000, '记录保存实际专注时间');
    assertEqual(record.roundsTotal, 3, '记录轮数 3');
    assertEqual(record.roundsCompleted, 3, '记录完成轮数 3');
    assertEqual(record.targetReached, false, '未达成目标');
    assertEqual(record.rounds.length, 3, '记录内轮次数组 3 条');
    await assertRecordCard(s, record, 0, 'B2 记录');
    assertEqual(s.todayTime, await minutesLabelOf(record.totalFocusedMs), '今日专注分钟与记录一致');
    assertEqual(s.todayRounds, '3', '今日完成轮次 3');
    assertEqual(s.streak, '1', '连续天数 1');
    assertEqual(s.totalNote, '今天 1 次任务', '今日 N 次任务文案');
    assertEqual(s.weekTotal, `共 ${await formatSpanOf(record.totalFocusedMs)}`, '近 7 天合计');
    assertEqual(s.week[6].isEmpty, false, '今天 7 日图有数据');
    assertEqual(s.storage['focus.session.v1'], null, '保存后 session 清除');
  });
}

async function scenarioNextRoundNoConfirm() {
  await runTest('B3 下一轮无确认弹窗：连续切换并完成，实际/目标达成条（未达成）', async () => {
    await resetApp();
    await startSession({ task: '连续写作', minutes: 25 });
    await advance(10 * MIN);

    let s = await snap();
    assertClock(s.clock, '10:00', '第 1 轮 10 分钟', 2);

    await click('#nextBtn');
    s = await snap();
    assertEqual(s.modalOpen, false, '下一轮无确认弹窗');
    assertEqual(s.roundLabel, '第 2 轮 · 专注中', '第 2 轮开始');
    assertEqual(s.rounds, '1 轮', '第 1 轮已计入');
    assertClock(s.clock, '10:00', '累计时间保持', 2);

    await advance(3 * MIN);
    await click('#nextBtn');
    s = await snap();
    assertEqual(s.modalOpen, false, '第二次下一轮也无确认弹窗');
    assertEqual(s.roundLabel, '第 3 轮 · 专注中', '第 3 轮开始');
    assertEqual(s.rounds, '2 轮', '第 2 轮已计入');
    assertClock(s.clock, '13:00', '累计时间 13 分钟', 2);

    await advance(2 * MIN);
    await click('#completeBtn');
    await waitModal();
    s = await snap();
    assertIncludes(s.modalBody, '共 3 轮', '完成弹窗轮数 3');
    assertIncludes(s.modalBody, '实际专注 15 分钟', '完成弹窗实际 15 分钟');
    await confirmModal();
    await waitSetup();

    s = await snap();
    const record = readStorageJson(s, 'focus.records.v1')[0];
    assertEqual(record.roundsTotal, 3, '记录 3 轮');
    assertBetween(record.totalFocusedMs, 15 * MIN, 15 * MIN + 4000, '记录实际 15 分钟');
    assertEqual(record.targetReached, false, '未达成 25 分钟目标');
    await assertRecordCard(s, record, 0, 'B3 记录');
    assertMatch(s.groups[0], /^今天/, '记录按今天分组');
    assertEqual(s.todayRounds, '3', '今日轮次 3');

    await screenshot('v2-desktop-records-under-target.png');
  });
}

async function scenarioTargetReachedKeepsRunning() {
  await runTest('B4 目标达成不自动结束：绿色状态、超时显示、只提示一次、超时后仍可完成', async () => {
    await resetApp();
    await setInputValue('#taskInput', '读论文');
    await setInputValue('#customMinutes', '1');
    await waitText('#durationNote', '整个任务 1 分钟');
    await clickStartExpectRunning('1 分钟自定义目标');

    let s = await snap();
    assertEqual(s.timerSub, '目标 1 分钟 · 还剩 01:00', '初始剩余 1 分钟');
    assertEqual(s.targetReached, 'false', '初始未达成');

    await advance(30 * SEC);
    s = await snap();
    assertClock(s.clock, '00:30', '30 秒后正计时', 2);
    assertEqual(s.timerPhase, '专注中', '未达成时文案');
    assertIncludes(s.timerSub, '还剩', '未达成时显示剩余时间');
    assertBetween(Number(s.progress.replace('%', '')), 48, 52, '目标进度约 50%');

    // 越过目标：不停止，进入「目标已达成 / 已超出」
    await advance(35 * SEC);
    s = await snap();
    assertClock(s.clock, '01:05', '越过目标后的正计时', 2);
    assertEqual(s.phase, 'running', '越过目标后仍在运行（不自动结束）');
    assertEqual(s.targetReached, 'true', '数据属性标记目标已达成');
    assertEqual(s.targetReachedBody, 'true', 'body 数据属性标记目标已达成');
    assertEqual(s.timerPhase, '目标已达成', '目标达成文案');
    assertIncludes(s.timerSub, '已超出', '超时显示已超出时长');
    assertEqual(s.progress, '100%', '进度 100%');
    assertEqual(s.rounds, '0 轮', '越过目标不自动计轮');
    await waitToastContains('已达到目标 1 分钟');
    assertEqual(
      (await snap()).toasts.filter((toast) => toast.includes('已达到目标')).length,
      1,
      '目标达成只提示一次'
    );

    await screenshot('v2-desktop-target-reached.png');

    // 越过后继续跑 10 分钟：仍然运行、不会自动暂停/完成
    await advance(10 * MIN);
    s = await snap();
    assertClock(s.clock, '11:05', '超时后继续累计', 3);
    assertEqual(s.phase, 'running', '超时后仍运行');
    assertEqual(s.timerPhase, '目标已达成', '超时后仍显示目标已达成');
    assertIncludes(s.timerSub, '已超出', '超时后仍显示已超出');
    assertEqual(s.rounds, '0 轮', '超时期间轮次仍为 0');
    assertEqual(
      s.toasts.filter((toast) => toast.includes('已达到目标')).length,
      1,
      '目标达成提示不会重复弹出'
    );

    // 超时后暂停仍然计轮，然后完成
    await click('#pauseBtn');
    await waitPhase('paused');
    s = await snap();
    assertEqual(s.rounds, '1 轮', '超时后暂停仍计入 1 轮');
    assertEqual(s.targetReached, 'true', '暂停后仍标记目标已达成');
    assertEqual(s.timerPhase, '已暂停', '暂停优先显示已暂停');
    await click('#completeBtn');
    await waitModal();
    s = await snap();
    assertEqual(s.modalTitle, '完成任务并保存记录？', '超时任务完成弹窗');
    assertIncludes(s.modalBody, '已达到目标 1 分钟', '完成弹窗说明已达到目标');
    assertIncludes(s.modalBody, '共 1 轮', '完成弹窗轮数');
    await confirmModal();
    await waitSetup();

    s = await snap();
    const record = readStorageJson(s, 'focus.records.v1')[0];
    assertEqual(record.targetReached, true, '记录标记目标已达成');
    assertEqual(record.roundsTotal, 1, '记录轮数 1');
    assertBetween(record.totalFocusedMs, 11 * MIN, 11 * MIN + 60 * SEC, '记录实际约 11 分钟');
    assertEqual(record.targetMs, MIN, '记录目标 1 分钟');
    await assertRecordCard(s, record, 0, 'B4 记录');
    assertEqual(s.records[0].meterReached, true, '达成条显示已达成');
    assertEqual(s.records[0].meterWidth, '100%', '达成条满格');
    assertEqual(s.todayTime, await minutesLabelOf(record.totalFocusedMs), '今日统计与记录一致');
    assertEqual(s.todayRounds, '1', '今日轮次 1');

    await screenshot('v2-desktop-records-reached.png');
  });
}

async function scenarioRefreshRestore() {
  await runTest('B5 刷新恢复：running → paused，结束当前轮但轮次与实际时间不丢', async () => {
    await resetApp();
    await startSession({ task: '恢复测试', minutes: 15 });
    await advance(4 * MIN);
    await sleep(700); // 让 4s 自动保存把 savedAt 跟上假时钟

    let s = await snap();
    assertEqual(s.phase, 'running', '刷新前仍在运行');
    assertClock(s.clock, '04:00', '刷新前累计 4 分钟', 2);

    await refresh();
    s = await snap();
    assertEqual(s.view, 'session', '刷新后仍处于会话视图');
    assertEqual(s.phase, 'paused', '刷新后恢复为 paused');
    assertEqual(s.pauseText, '继续', '恢复后按钮为继续');
    assertEqual(s.nextInfo.hiddenAttr, true, '恢复后「下一轮」隐藏');
    assertEqual(s.roundLabel, '已完成 1 轮 · 已暂停', '恢复后当前轮已结束并计入');
    assertEqual(s.rounds, '1 轮', '恢复后轮次不丢');
    assertClock(s.clock, '04:00', '恢复后实际时间不丢（最多回退 4 秒保存间隔）', 6);
    await waitToastContains('本轮已结束，任务已暂停');

    const stored = readStorageJson(s, 'focus.session.v1');
    assertEqual(stored.phase, 'paused', '恢复后持久化 phase=paused');
    assertEqual(stored.rounds.length, 1, '恢复后持久化轮次 1');
    assertBetween(stored.rounds[0].focusedMs, 4 * MIN - 5000, 4 * MIN + 5000, '恢复后轮次时长约 4 分钟');

    // 暂停态刷新：轮次与时间精确保持
    const frozenClock = s.clock;
    await refresh();
    const again = await snap();
    assertEqual(again.phase, 'paused', '暂停态再次刷新仍为 paused');
    assertEqual(again.clock, frozenClock, '暂停态再次刷新实际时间不变');
    assertEqual(again.rounds, '1 轮', '暂停态再次刷新轮次不变');

    // 继续并完成：累计时间与轮次都要保留
    await click('#pauseBtn');
    await waitPhase('running');
    s = await snap();
    assertEqual(s.roundLabel, '第 2 轮 · 专注中', '恢复后继续进入第 2 轮');
    await advance(2 * MIN);
    await click('#completeBtn');
    await waitModal();
    s = await snap();
    assertIncludes(s.modalBody, '共 2 轮', '恢复任务的完成弹窗含 2 轮');
    await confirmModal();
    await waitSetup();

    const record = readStorageJson(await snap(), 'focus.records.v1')[0];
    assertEqual(record.roundsTotal, 2, '恢复任务记录 2 轮');
    assertBetween(record.totalFocusedMs, 6 * MIN - 5000, 6 * MIN + 6000, '恢复任务记录实际约 6 分钟');
    assertEqual(record.targetMs, 15 * MIN, '目标时间保留');
    const finalSnap = await snap();
    await assertRecordCard(finalSnap, record, 0, 'B5 记录');
  });
}

async function scenarioRefreshTargetReached() {
  await runTest('B6 目标已达成时刷新：恢复为 paused 并保留达成状态，可继续完成', async () => {
    await resetApp();
    await startSession({ task: '超时恢复', minutes: 1, mode: 'custom' });
    await advance(70 * SEC);
    let s = await snap();
    assertEqual(s.targetReached, 'true', '刷新前已达成目标');
    await sleep(700);
    await refresh();

    s = await snap();
    assertEqual(s.phase, 'paused', '刷新后恢复为 paused');
    assertEqual(s.targetReached, 'true', '刷新后保留目标已达成状态');
    assertEqual(s.timerPhase, '已暂停', '暂停态文案');
    assertEqual(s.rounds, '1 轮', '刷新后当前轮已计入');
    assertClock(s.clock, '01:10', '刷新后实际时间保留', 6);
    await waitToastContains('本轮已结束，任务已暂停');

    await click('#completeBtn');
    await waitModal();
    s = await snap();
    assertIncludes(s.modalBody, '已达到目标 1 分钟', '完成弹窗保留达成信息');
    await confirmModal();
    await waitSetup();
    const record = readStorageJson(await snap(), 'focus.records.v1')[0];
    assertEqual(record.targetReached, true, '记录 targetReached=true');
    assertBetween(record.totalFocusedMs, 70 * SEC - 6000, 70 * SEC + 6000, '记录实际约 70 秒');
  });
}

async function scenarioRecordsCrud() {
  await runTest('B7 记录：实际/目标+达成条展示、删除撤销、清空与持久化', async () => {
    await resetApp();
    await seedRecords([
      { dayOffset: 0, hour: 9, task: '晨间写作', totalFocusedMs: 25 * MIN, targetMs: 25 * MIN, rounds: [25 * MIN] },
      { dayOffset: 0, hour: 11, task: '方案梳理', totalFocusedMs: 15 * MIN, targetMs: 30 * MIN, rounds: [10 * MIN, 5 * MIN] },
      { dayOffset: -1, hour: 18, task: '昨日复盘', totalFocusedMs: 40 * MIN, targetMs: 30 * MIN, rounds: [40 * MIN] },
    ]);

    let s = await snap();
    assertEqual(s.recordsCount, '3', '预置记录数 3');
    assertEqual(s.records.length, 3, '记录卡片 3 张');
    assertEqual(s.groups.length, 2, '两个日期分组');
    assertMatch(s.groups[0], /^今天/, '分组 1 今天');
    assertMatch(s.groups[1], /^昨天/, '分组 2 昨天');
    assertEqual(s.todayTime, '40', '今日实际 40 分钟');
    assertEqual(s.todayRounds, '3', '今日轮次 3（1+2）');
    assertEqual(s.streak, '2', '连续 2 天');
    assertEqual(s.weekTotal, '共 1 小时 20 分钟', '近 7 天合计 80 分钟');
    assertEqual(s.records[0].task, '方案梳理', '记录按结束时间倒序（今天 11:00 在前）');
    assertEqual(s.records[1].task, '晨间写作', '第二条为今天 09:00');
    assertEqual(s.records[2].task, '昨日复盘', '第三条为昨天');
    // DOM 顺序与 localStorage 原始写入顺序可能不同，按任务名取持久化记录再核对展示
    const seeded = readStorageJson(s, 'focus.records.v1');
    const recordByTask = (task) => seeded.filter((item) => item.taskName === task)[0];
    await assertRecordCard(s, recordByTask('方案梳理'), 0, 'B7 未达成记录');
    await assertRecordCard(s, recordByTask('昨日复盘'), 2, 'B7 达成记录');
    assertEqual(s.records[0].meterReached, false, '未达成记录无 is-reached');
    assertEqual(s.records[2].meterReached, true, '达成记录有 is-reached');

    // 删除 + 撤销
    await click('#recordsList .record .record-delete');
    await sleep(200);
    s = await snap();
    assertEqual(s.recordsCount, '2', '删除后记录数 2');
    assertIncludes(s.toasts.join(' | '), '已删除「方案梳理」的记录', '删除 toast');
    assertEqual(s.toastActionLabels.includes('撤销'), true, '删除 toast 提供撤销');
    assertEqual(s.todayTime, '25', '删除后今日统计更新');
    assertEqual(s.todayRounds, '1', '删除后今日轮次更新');
    assertEqual(readStorageJson(s, 'focus.records.v1').length, 2, '删除已持久化');
    await screenshot('v2-desktop-record-delete-toast.png');

    await click('#toastStack .toast-action');
    await sleep(200);
    s = await snap();
    assertEqual(s.recordsCount, '3', '撤销后记录数恢复 3');
    assertEqual(s.todayTime, '40', '撤销后今日统计恢复');
    assertEqual(readStorageJson(s, 'focus.records.v1').length, 3, '撤销已持久化');

    // 再删一条并刷新：删除结果持久化
    await click('#recordsList .record .record-delete');
    await sleep(200);
    await refresh();
    s = await snap();
    assertEqual(s.recordsCount, '2', '刷新后删除结果保留');
    assertEqual(readStorageJson(s, 'focus.records.v1').length, 2, '刷新后持久化 2 条');

    // 清空：取消 → 确认 → 刷新
    await click('#clearRecords');
    await waitModal();
    s = await snap();
    assertEqual(s.modalTitle, '清空全部完成记录？', '清空确认弹窗标题');
    assertIncludes(s.modalBody, '将删除 2 条', '清空弹窗显示记录数');
    await cancelModal();
    assertEqual((await snap()).recordsCount, '2', '取消清空后记录仍在');

    await click('#clearRecords');
    await waitModal();
    await confirmModal();
    await sleep(200);
    s = await snap();
    assertEqual(s.recordsCount, '0', '清空后记录数 0');
    assertEqual(s.emptyState, true, '清空后显示空状态');
    assertEqual(s.todayTime, '0', '清空后今日统计归零');
    assertEqual(s.todayRounds, '0', '清空后今日轮次归零');
    assertEqual(s.streak, '0', '清空后连续天数归零');
    assertEqual(s.weekTotal, '暂无记录', '清空后近 7 天合计');
    assertEqual(s.clearInfo.display, 'none', '清空后「清空」按钮隐藏');
    assertTrue(s.week.every((day) => day.isEmpty), '清空后 7 日图全部清空');
    assertEqual(readStorageJson(s, 'focus.records.v1').length, 0, '清空后持久化空数组');
    await screenshot('v2-desktop-records-empty.png');

    await refresh();
    assertEqual((await snap()).recordsCount, '0', '刷新后记录仍为空');
  });
}

async function scenarioCustomDurationValidation() {
  await runTest('B8 自定义目标时长校验：0 / 481 / 1440 拒绝，480 / 1 接受，小数按整分钟取整', async () => {
    await resetApp();
    await setInputValue('#taskInput', '时长校验');

    await setInputValue('#customMinutes', '0');
    let s = await snap();
    assertEqual(s.durationNote, '需在 1–480 分钟之间', '非法输入即时提示');
    assertEqual(s.durationNoteWarning, true, '非法输入提示为警告态');
    await click('#startBtn');
    await waitToastContains('自定义时长需在 1–480 分钟之间');
    s = await snap();
    assertEqual(s.view, 'setup', '0 分钟不应开始任务');
    assertEqual(s.storage['focus.session.v1'], null, '0 分钟不写 session');

    await setInputValue('#customMinutes', '481');
    assertEqual((await snap()).durationNote, '需在 1–480 分钟之间', '481 即时提示');
    await click('#startBtn');
    await waitToastContains('自定义时长需在 1–480 分钟之间');
    assertEqual((await snap()).view, 'setup', '481 分钟不应开始任务');

    await setInputValue('#customMinutes', '1440');
    await click('#startBtn');
    await waitToastContains('自定义时长需在 1–480 分钟之间');
    assertEqual((await snap()).view, 'setup', '1440 分钟（4 位）不应开始任务');
    assertEqual((await snap()).storage['focus.session.v1'], null, '非法输入不写 session');

    await setInputValue('#customMinutes', '480');
    await waitText('#durationNote', '整个任务 480 分钟');
    await clickStartExpectRunning('自定义 480 分钟');
    s = await snap();
    assertEqual(s.timerSub, '目标 480 分钟 · 还剩 8:00:00', '480 分钟上限的剩余时间');
    assertEqual(readStorageJson(s, 'focus.session.v1').targetMs, 480 * MIN, '480 分钟持久化');
    await discardSessionFlow();
    assertEqual((await snap()).storage['focus.session.v1'], null, '放弃后清除 session');

    // 放弃会重置设置表单，这里重新填写
    await setInputValue('#taskInput', '时长校验');
    await setInputValue('#customMinutes', '1');
    await waitText('#durationNote', '整个任务 1 分钟');
    await clickStartExpectRunning('自定义 1 分钟');
    s = await snap();
    assertEqual(s.timerSub, '目标 1 分钟 · 还剩 01:00', '1 分钟下限的剩余时间');
    await discardSessionFlow();

    // 已知取舍：小数按整分钟四舍五入，且提示显示取整后的结果
    await setInputValue('#taskInput', '小数分钟');
    await setInputValue('#customMinutes', '45.5');
    await waitText('#durationNote', '整个任务 46 分钟');
    await clickStartExpectRunning('自定义小数 45.5 分钟');
    s = await snap();
    assertEqual(s.timerSub, '目标 46 分钟 · 还剩 46:00', '45.5 分钟取整为 46');
    assertEqual(readStorageJson(s, 'focus.session.v1').targetMs, 46 * MIN, '取整后的目标被持久化');
    note(
      'O1',
      '自定义目标时长接受小数并四舍五入为整分钟（README 已声明为已知取舍）',
      '输入 "45.5" → 提示 "整个任务 46 分钟"，targetMs=2760000。规格第 7 条明确「小数输入按整分钟四舍五入（已知取舍）」，因此不作为缺陷，仅记录可验证行为。',
      'P3'
    );
    await discardSessionFlow();

    // 空任务名阻止开始
    await setInputValue('#taskInput', '   ');
    await setInputValue('#customMinutes', '25');
    await click('#startBtn');
    await waitToastContains('先写下这个任务要专注做的事');
    s = await snap();
    assertEqual(s.view, 'setup', '空任务名不应开始任务');
    assertEqual(s.storage['focus.session.v1'], null, '空任务名不写 session');
  });
}

async function scenarioKeyboardShortcuts() {
  await runTest('B9 快捷键：空格暂停/继续、N 下一轮、Enter 完成、Esc 关闭弹窗', async () => {
    await resetApp();
    await startSession({ task: '快捷键测试', minutes: 2, mode: 'custom' });
    await advance(5 * SEC);

    // 空格 = 暂停（结束当前轮）
    await dispatchKey(' ', 'Space');
    await waitPhase('paused');
    let s = await snap();
    assertEqual(s.roundLabel, '已完成 1 轮 · 已暂停', '空格暂停并计轮');
    assertEqual(s.rounds, '1 轮', '空格暂停后轮次 1');
    assertIncludes(s.toasts.join(' | '), '第 1 轮结束', '空格暂停 toast');
    const clockAfterPause = s.clock;

    // 空格 = 继续（开始下一轮）
    await dispatchKey(' ', 'Space');
    await waitPhase('running');
    s = await snap();
    assertEqual(s.roundLabel, '第 2 轮 · 专注中', '空格继续开始第 2 轮');
    assertEqual(s.clock, clockAfterPause, '继续不丢累计时间');
    assertIncludes(s.toasts.join(' | '), '第 2 轮开始', '空格继续 toast');

    // N = 下一轮（无确认弹窗）
    await advance(5 * SEC);
    await dispatchKey('n', 'KeyN');
    s = await snap();
    assertEqual(s.modalOpen, false, 'N 不弹确认框');
    assertEqual(s.roundLabel, '第 3 轮 · 专注中', 'N 进入第 3 轮');
    assertEqual(s.rounds, '2 轮', 'N 结束当前轮并计轮');

    // Enter = 完成 → 弹窗 → 保存
    await dispatchKey('Enter', 'Enter');
    await waitModal();
    s = await snap();
    assertEqual(s.modalTitle, '完成任务并保存记录？', 'Enter 弹出完成确认');
    assertIncludes(s.modalBody, '共 2 轮', 'Enter 完成弹窗轮数');
    await dispatchKey('Escape', 'Escape');
    await waitNoModal();
    assertEqual((await snap()).phase, 'running', 'Esc 关闭弹窗后仍在运行');

    await dispatchKey('Enter', 'Enter');
    await waitModal();
    await confirmModal();
    await waitSetup();
    s = await snap();
    assertEqual(s.recordsCount, '1', 'Enter 完成并保存记录');
    assertEqual(s.todayTime, '<1', '极短记录的今日统计');

    // 输入框聚焦时快捷键不生效
    await resetApp();
    await focusElement('#taskInput');
    await dispatchKey(' ', 'Space', '#taskInput');
    await dispatchKey('n', 'KeyN', '#taskInput');
    await dispatchKey('Enter', 'Enter', '#taskInput');
    await sleep(150);
    s = await snap();
    assertEqual(s.view, 'setup', '输入框聚焦时快捷键不开始/暂停任务');
    assertEqual(s.storage['focus.session.v1'], null, '输入框聚焦时快捷键不写 session');

    // 按钮聚焦时快捷键让给按钮，避免双触发
    await startSession({ task: '按钮聚焦', minutes: 2, mode: 'custom' });
    await focusElement('#pauseBtn');
    await dispatchKey(' ', 'Space', '#pauseBtn');
    await sleep(150);
    assertEqual((await snap()).phase, 'running', '按钮聚焦时空格交给按钮，不重复暂停');
    await discardSessionFlow();
  });
}

async function scenarioRapidClicks() {
  await runTest('B10 快速连点「下一轮」/「完成」不重复计轮、不重复保存', async () => {
    await resetApp();
    await startSession({ task: '连点测试', minutes: 25 });
    await advance(10 * MIN);

    await evaluate(`(() => {
      const button = document.querySelector('#nextBtn');
      for (let index = 0; index < 5; index += 1) button.click();
      return true;
    })()`);
    await sleep(300);

    let s = await snap();
    assertEqual(s.modalOpen, false, '连点下一轮不出现弹窗');
    assertEqual(s.phase, 'running', '连点后仍在运行');
    assertEqual(s.roundLabel, '第 2 轮 · 专注中', '连点只推进一次（第 2 轮）');
    assertEqual(s.rounds, '1 轮', '连点只结束并计入第 1 轮');
    assertClock(s.clock, '10:00', '连点后累计时间保持', 2);
    const stored = readStorageJson(s, 'focus.session.v1');
    assertEqual(stored.rounds.length, 1, '五连点只产生 1 条轮次');
    assertEqual(stored.phase, 'running', '连点后 phase 正常');

    // 快速连点完成：只弹一次窗、确认后只保存一条
    await evaluate(`(() => {
      const button = document.querySelector('#completeBtn');
      for (let index = 0; index < 3; index += 1) button.click();
      return true;
    })()`);
    await waitModal();
    s = await snap();
    assertEqual(s.modalTitle, '完成任务并保存记录？', '连点完成只弹保存确认');
    await confirmModal();
    await waitSetup();
    s = await snap();
    assertEqual(s.recordsCount, '1', '连点完成后只保存 1 条记录');
    assertEqual(readStorageJson(s, 'focus.records.v1').length, 1, '持久化只有 1 条记录');
  });
}

async function scenarioMinRoundMs() {
  await runTest('B11 0–1 秒轮次不计（MIN_ROUND_MS）', async () => {
    await resetApp();
    await startSession({ task: '极短轮次', minutes: 25 });

    // 立刻完成：还没有任何 ≥1 秒的轮次 -> 不生成记录，弹窗说明
    await click('#completeBtn');
    await waitModal();
    let zero = await snap();
    assertEqual(zero.modalTitle, '结束这个任务？', '0 轮任务的完成弹窗标题');
    assertIncludes(zero.modalBody, '还没有产生专注时长', '0 轮任务完成弹窗说明不生成记录');
    await cancelModal();
    assertEqual((await snap()).phase, 'running', '取消后任务继续运行');

    // 立刻暂停：不足 1 秒，不计轮
    await click('#pauseBtn');
    await waitPhase('paused');
    let s = await snap();
    assertEqual(s.rounds, '0 轮', '亚秒暂停不计轮');
    assertEqual(s.roundLabel, '任务已暂停', '无轮次时暂停标签');
    assertIncludes(s.toasts.join(' | '), '继续将开始新一轮', '亚秒暂停 toast');
    assertEqual(readStorageJson(s, 'focus.session.v1').rounds.length, 0, '持久化无轮次');

    // 继续后立刻下一轮：仍不足 1 秒，不计轮
    await click('#pauseBtn');
    await waitPhase('running');
    await click('#nextBtn');
    s = await snap();
    assertEqual(s.rounds, '0 轮', '亚秒下一轮不计轮');
    assertEqual(s.roundLabel, '第 1 轮 · 专注中', '未计轮时仍是第 1 轮');

    // 超过 1 秒后再下一轮：计轮
    await advance(1200);
    await click('#nextBtn');
    s = await snap();
    assertEqual(s.rounds, '1 轮', '满 1 秒后下一轮计 1 轮');
    assertEqual(s.roundLabel, '第 2 轮 · 专注中', '计轮后进入第 2 轮');

    // 亚秒收口不产生新轮，完成记录保留 1 轮
    await advanceRaw(500);
    await click('#completeBtn');
    await waitModal();
    s = await snap();
    assertIncludes(s.modalBody, '共 1 轮', '亚秒收口不增加轮数');
    await confirmModal();
    await waitSetup();
    s = await snap();
    const record = readStorageJson(s, 'focus.records.v1')[0];
    assertEqual(record.roundsTotal, 1, '记录轮数 1');
    assertBetween(record.totalFocusedMs, 1000, 4000, '记录实际约 1 秒多');
    assertEqual(record.targetReached, false, '记录未达成目标');
    assertEqual(s.todayTime, '<1', '极短记录今日统计 <1');
    await assertRecordCard(s, record, 0, 'B11 记录');
  });
}

async function scenarioCrossDay() {
  await runTest('B12 跨日：23:50 开始、次日 00:20 完成，记录归入结束日', async () => {
    await resetApp([2026, 9, 23, 23, 50, 0]);
    await startSession({ task: '跨日任务', minutes: 25 });
    await advance(10 * MIN);

    // 00:00 暂停（第 1 轮 10 分钟）
    await click('#pauseBtn');
    await waitPhase('paused');
    const expectedDay = await evaluate(`(() => { const d = new Date(); const pad = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); })()`);
    assertEqual(expectedDay, '2026-10-24', '跨日后假时钟日期为 2026-10-24');

    // 继续再跑 20 分钟，00:20 完成
    await click('#pauseBtn');
    await waitPhase('running');
    await advance(20 * MIN);
    await click('#completeBtn');
    await waitModal();
    await confirmModal();
    await waitSetup();

    let s = await snap();
    const record = readStorageJson(s, 'focus.records.v1')[0];
    assertEqual(record.dateKey, '2026-10-24', '记录归入结束当天');
    assertEqual(record.roundsTotal, 2, '跨日任务 2 轮');
    assertBetween(record.totalFocusedMs, 30 * MIN, 30 * MIN + 4000, '跨日任务实际 30 分钟');
    assertEqual(record.targetReached, true, '30 分钟 >= 25 分钟目标');
    assertMatch(s.groups[0], /^今天/, '跨日记录分组为今天');
    assertEqual(s.todayTime, await minutesLabelOf(record.totalFocusedMs), '今日统计');
    assertEqual(s.todayRounds, '2', '今日轮次 2');
    await assertRecordCard(s, record, 0, 'B12 记录');

    await refresh();
    s = await snap();
    assertEqual(s.recordsCount, '1', '刷新后跨日记录仍在');
    assertMatch(s.groups[0], /^今天/, '刷新后分组仍为今天');
  });
}

async function scenarioV1Migration() {
  await runTest('B13 v1 数据迁移：旧 session / 旧 record 可被正确读取', async () => {
    await resetApp();
    const now = await evaluate(`Date.now()`);
    const startedAt = now - 10 * MIN;
    const v1Session = {
      v: 1,
      id: 's_v1_migrate',
      taskName: '旧会话',
      targetMs: 15 * MIN,
      startedAt: startedAt,
      rounds: [{ focusedMs: 5 * MIN, targetMs: 15 * MIN, completed: false }],
      roundIndex: 2,
      phase: 'paused',
      roundElapsedMs: 2 * MIN,
      savedAt: now - 8 * MIN,
    };
    const v1Record = {
      v: 1,
      taskName: '旧记录',
      targetMs: 30 * MIN,
      totalFocusedMs: 15 * MIN,
      roundsCompleted: 2,
      roundsTotal: 3,
      startedAt: startedAt - 30 * MIN,
      endedAt: startedAt - 15 * MIN,
    };
    await seedStorage(v1Session, [v1Record]);

    let s = await snap();
    assertEqual(s.view, 'session', 'v1 session 恢复为会话视图');
    assertEqual(s.phase, 'paused', 'v1 session 恢复为 paused');
    assertEqual(s.roundLabel, '已完成 2 轮 · 已暂停', 'v1 轮次（5+2 分钟）迁移为 2 轮');
    assertEqual(s.rounds, '2 轮', '迁移后轮次 2');
    assertEqual(s.clock, '07:00', '迁移后实际时间 7 分钟');
    await waitToastContains('本轮已结束，任务已暂停');

    assertEqual(s.recordsCount, '1', 'v1 记录可读取');
    assertEqual(s.records[0].task, '旧记录', 'v1 记录任务名');
    assertMatch(s.records[0].meta, /· 3 轮$/, 'v1 记录 roundsTotal=3 保留');
    assertEqual(s.records[0].targetLine, '实际 15 分钟 / 目标 30 分钟', 'v1 记录实际/目标');
    assertEqual(s.records[0].meterWidth, '50%', 'v1 记录达成条 50%');
    assertEqual(s.records[0].meterReached, false, 'v1 记录未达成');

    // 迁移后的会话可继续并完成
    await click('#pauseBtn');
    await waitPhase('running');
    assertEqual((await snap()).roundLabel, '第 3 轮 · 专注中', '迁移后继续进入第 3 轮');
    await advance(3 * MIN);
    await click('#completeBtn');
    await waitModal();
    await confirmModal();
    await waitSetup();
    s = await snap();
    const records = readStorageJson(s, 'focus.records.v1');
    assertEqual(records.length, 2, '迁移会话完成后共 2 条记录');
    assertEqual(s.recordsCount, '2', '记录列表 2 条');
  });
}

async function scenarioThemeAndSound() {
  await runTest('B14 主题与提示音：状态、持久化、meta 主题色', async () => {
    await resetApp();
    let s = await snap();
    assertEqual(s.theme, 'dark', '默认深色主题');
    assertEqual(s.soundPressed, 'true', '默认开启提示音');
    assertEqual(s.themeColor, '#0a0b0e', '深色主题 meta 主题色');

    await click('#themeToggle');
    s = await snap();
    assertEqual(s.theme, 'light', '切换后为浅色主题');
    assertEqual(s.themeColor, '#f4f0e9', '浅色主题 meta 主题色');
    const themeLabel = await evaluate(`document.querySelector('#themeToggle').getAttribute('aria-label')`);
    assertEqual(themeLabel, '切换到深色主题', '浅色主题下按钮 aria-label');

    await click('#soundToggle');
    s = await snap();
    assertEqual(s.soundPressed, 'false', '关闭提示音后 aria-pressed=false');
    assertEqual(s.soundMuted, true, '关闭提示音后按钮 is-muted');
    assertIncludes(s.toasts.join(' | '), '提示音已关闭', '关闭提示音 toast');
    const settings = readStorageJson(s, 'focus.settings.v1');
    assertEqual(settings.theme, 'light', 'settings 持久化主题');
    assertEqual(settings.sound, false, 'settings 持久化提示音');

    await screenshot('v2-desktop-setup-light.png');
    await refresh();
    s = await snap();
    assertEqual(s.theme, 'light', '刷新后保持浅色主题');
    assertEqual(s.soundPressed, 'false', '刷新后保持提示音关闭');
    assertEqual(s.themeColor, '#f4f0e9', '刷新后 meta 主题色');

    await click('#themeToggle');
    await click('#soundToggle');
    s = await snap();
    assertEqual(s.theme, 'dark', '再次切换回深色');
    assertEqual(s.soundPressed, 'true', '再次开启提示音');
    assertIncludes(s.toasts.join(' | '), '提示音已开启', '开启提示音 toast');
  });
}

async function scenarioMobileLayout() {
  await runTest('B15 移动端 390×844：设置/运行/暂停/记录均无横向溢出', async () => {
    await resetApp();
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    await sleep(250);

    const setupMetrics = await evaluate(`(() => ({
      innerWidth: window.innerWidth,
      docScrollWidth: document.documentElement.scrollWidth
    }))()`);
    assertEqual(setupMetrics.innerWidth, 390, '移动端视口宽度');
    assertTrue(
      setupMetrics.docScrollWidth <= setupMetrics.innerWidth + 1,
      `设置视图不应横向溢出（scrollWidth=${setupMetrics.docScrollWidth}）`
    );
    await screenshot('v2-mobile-setup.png');

    await startSession({ task: '移动端专注', minutes: 15 });
    await advance(5 * MIN);
    await sleep(250);

    const runningMetrics = await evaluate(`(() => {
      const controls = Array.from(document.querySelectorAll('#controls .btn'))
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => { const r = el.getBoundingClientRect(); return { text: el.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right) }; });
      return {
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        controls: controls,
        clockRect: (() => { const r = document.querySelector('#timeDisplay').getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; })()
      };
    })()`);
    assertTrue(
      runningMetrics.docScrollWidth <= runningMetrics.innerWidth + 1,
      `计时视图不应横向溢出（scrollWidth=${runningMetrics.docScrollWidth}）`
    );
    assertEqual(runningMetrics.controls.length, 3, '运行态移动端有 3 个操作按钮');
    runningMetrics.controls.forEach((control) => {
      assertTrue(
        control.left >= -1 && control.right <= runningMetrics.innerWidth + 1,
        `移动端按钮「${control.text}」应在视口内（left=${control.left}, right=${control.right}）`
      );
    });
    assertTrue(
      runningMetrics.clockRect.left >= 0 && runningMetrics.clockRect.right <= runningMetrics.innerWidth,
      '移动端倒计时应在视口内'
    );
    await screenshot('v2-mobile-session.png');

    // 暂停态：仅 继续 / 完成
    await click('#pauseBtn');
    await waitPhase('paused');
    await sleep(250);
    const pausedMetrics = await evaluate(`(() => {
      const controls = Array.from(document.querySelectorAll('#controls .btn'))
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => el.textContent.trim());
      return {
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        roundLabel: document.querySelector('#roundLabel').textContent.trim(),
        controls: controls
      };
    })()`);
    assertEqual(pausedMetrics.roundLabel, '已完成 1 轮 · 已暂停', '移动端暂停态轮次标签');
    assertEqual(pausedMetrics.controls.length, 2, `移动端暂停态应只有 2 个按钮，实际 ${fmt(pausedMetrics.controls)}`);
    assertTrue(pausedMetrics.controls.includes('继续'), '移动端暂停态有「继续」');
    assertTrue(pausedMetrics.controls.includes('完成'), '移动端暂停态有「完成」');
    assertTrue(
      pausedMetrics.docScrollWidth <= pausedMetrics.innerWidth + 1,
      `暂停视图不应横向溢出（scrollWidth=${pausedMetrics.docScrollWidth}）`
    );
    await screenshot('v2-mobile-paused.png');

    // 完成保存后查看记录（实际/目标 + 达成条）
    await click('#completeBtn');
    await waitModal();
    await confirmModal();
    await waitSetup();
    await sleep(250);
    const recordsMetrics = await evaluate(`(() => {
      const first = document.querySelector('#recordsList .record');
      const target = first ? first.querySelector('.record-target') : null;
      const meter = first ? first.querySelector('.record-meter') : null;
      return {
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        recordsCount: document.querySelector('#recordsCount').textContent.trim(),
        targetLine: target ? target.textContent.trim() : null,
        hasMeter: !!meter
      };
    })()`);
    assertEqual(recordsMetrics.recordsCount, '1', '移动端保存记录 1 条');
    assertIncludes(recordsMetrics.targetLine, '实际', '移动端记录显示实际时间');
    assertIncludes(recordsMetrics.targetLine, '目标', '移动端记录显示目标时间');
    assertEqual(recordsMetrics.hasMeter, true, '移动端记录有达成条');
    assertTrue(
      recordsMetrics.docScrollWidth <= recordsMetrics.innerWidth + 1,
      `记录视图不应横向溢出（scrollWidth=${recordsMetrics.docScrollWidth}）`
    );
    await screenshot('v2-mobile-records.png');

    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(150);
  });
}

async function scenarioConsoleHealth() {
  await runTest('B16 无 console 错误、无未捕获异常、无阻塞弹窗；v2 核心 API 就绪', async () => {
    const errors = REPORT.consoleErrors;
    assertEqual(
      errors.length,
      0,
      `浏览器 console 错误 / 未捕获异常应为 0，实际 ${errors.length} 条\n` +
        errors.map((entry) => `    [${entry.kind}] ${entry.text}`).join('\n')
    );
    assertEqual(
      REPORT.dialogs.length,
      0,
      `不应出现 alert/confirm 等阻塞式弹窗，实际 ${REPORT.dialogs.length} 次: ${REPORT.dialogs.join(' | ')}`
    );

    const sanity = await evaluate(`(() => {
      const core = window.FocusCore;
      return {
        version: core ? core.VERSION : null,
        minRoundMs: core ? core.MIN_ROUND_MS : null,
        hasApi: ['createSession', 'pauseSession', 'resumeSession', 'startNextRound', 'completeSession',
          'getTotalFocusedMs', 'getRoundElapsedMs', 'isTargetReached', 'getOvertimeMs', 'restoreSession',
          'normalizeSession', 'normalizeRecord', 'summarize'].every((name) => typeof core[name] === 'function'),
        oldApi: ['tickSession', 'getElapsed', 'countCompletedRounds'].some((name) => typeof core[name] === 'function')
      };
    })()`);
    assertEqual(sanity.version, 2, '页面加载的 FocusCore 版本为 v2');
    assertEqual(sanity.minRoundMs, 1000, 'MIN_ROUND_MS=1000');
    assertEqual(sanity.hasApi, true, 'v2 核心 API 全部可用');
    assertEqual(sanity.oldApi, false, 'v1 状态机 API 已移除');
    assertEqual(
      REPORT.consoleWarnings.filter((entry) => !/AudioContext/i.test(entry.text)).length,
      0,
      `除 AudioContext 预期警告外不应有其它 console 警告\n` +
        REPORT.consoleWarnings.map((entry) => `    [${entry.kind}] ${entry.text}`).join('\n')
    );
  });
}

/* ------------------------------------------------------------------------- */
/* main                                                                      */
/* ------------------------------------------------------------------------- */

async function collectEnvironment(version) {
  REPORT.environment = {
    schema: 'focus-e2e-v2',
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    chromeBinary: CHROME_BIN,
    chromeVersion: version.Browser,
    cdpPort: CDP_PORT,
    previewUrl: appUrl,
    injectedClock: 'Page.addScriptToEvaluateOnNewDocument 覆盖 Date.now 偏移（localStorage 持久化，跨刷新保持）',
    viewports: '1440x900 desktop, 390x844@2x mobile emulation',
  };
  REPORT.environment.browser = await evaluate(`(() => ({
    userAgent: navigator.userAgent,
    dpr: window.devicePixelRatio,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    tzOffsetMinutes: new Date().getTimezoneOffset()
  }))()`);
}

async function shutdown() {
  if (cdp) cdp.close();
  if (chromeProcess) {
    const child = chromeProcess;
    chromeProcess = null;
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const finished = await Promise.race([once(child, 'exit').then(() => true), sleep(3000).then(() => false)]);
      if (!finished) {
        try {
          child.kill('SIGKILL');
        } catch (error) {
          /* ignore */
        }
      }
    }
  }
  if (fallbackServer) {
    try {
      fallbackServer.kill('SIGTERM');
    } catch (error) {
      /* ignore */
    }
    fallbackServer = null;
  }
  for (const dir of [PROFILE_DIR, CHROME_HOME]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      /* ignore */
    }
  }
}

function printSummary() {
  const total = REPORT.tests.length;
  const passed = REPORT.tests.filter((item) => item.ok).length;
  const failed = total - passed;

  log('');
  log('============ Focus v2 e2e 结果 ============');
  log(`测试: ${total}  通过: ${passed}  失败: ${failed}`);
  log(`截图: ${REPORT.screenshots.length} 张（.qa/）`);
  log(`console 错误: ${REPORT.consoleErrors.length} 条；警告: ${REPORT.consoleWarnings.length} 条`);
  if (failed > 0) {
    log('失败用例:');
    REPORT.tests
      .filter((item) => !item.ok)
      .forEach((item) => log(`  ✖ ${item.name}\n      ${String(item.error).split('\n')[0]}`));
  }
  log(`环境: Node ${process.version}, ${REPORT.environment.chromeVersion || 'Chrome 未知'}`);
  log(`报告 JSON: ${path.relative(ROOT, REPORT_PATH)}`);
  log('===========================================');
  return { total, passed, failed };
}

async function main() {
  log('Focus v2 e2e（CDP）开始');
  fs.mkdirSync(QA_DIR, { recursive: true });
  await ensurePreviewServer();

  const { child, version } = await startChrome();
  chromeProcess = child;

  try {
    const pageTarget = await getPageTarget();
    cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();

    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails || {};
      const exception = details.exception || {};
      REPORT.consoleErrors.push({
        kind: 'exception',
        text: exception.description || details.text || '未知异常',
        url: details.url,
        line: details.lineNumber,
      });
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type))
        .join(' ');
      if (params.type === 'error' || params.type === 'assert') {
        REPORT.consoleErrors.push({ kind: `console.${params.type}`, text });
      } else if (params.type === 'warning') {
        REPORT.consoleWarnings.push({ kind: 'console.warning', text });
      }
    });
    cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      if (entry.level === 'error') {
        REPORT.consoleErrors.push({ kind: 'log.error', text: entry.text, url: entry.url });
      } else if (entry.level === 'warning') {
        REPORT.consoleWarnings.push({ kind: 'log.warning', text: entry.text, url: entry.url });
      }
    });
    cdp.on('Page.javascriptDialogOpening', async (params) => {
      REPORT.dialogs.push(params.message || params.type || 'dialog');
      try {
        await cdp.send('Page.handleJavaScriptDialog', { accept: true });
      } catch (error) {
        /* ignore */
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SOURCE });

    await navigate(appUrl);
    await collectEnvironment(version);
    assertEqual(await evaluate(`!!window.__qaClock`), true, '可控时钟脚本已注入（导航前）');

    log('');
    const scenarios = [
      ['B1', scenarioSetupAndEmptyState],
      ['B2', scenarioStartPauseResume],
      ['B3', scenarioNextRoundNoConfirm],
      ['B4', scenarioTargetReachedKeepsRunning],
      ['B5', scenarioRefreshRestore],
      ['B6', scenarioRefreshTargetReached],
      ['B7', scenarioRecordsCrud],
      ['B8', scenarioCustomDurationValidation],
      ['B9', scenarioKeyboardShortcuts],
      ['B10', scenarioRapidClicks],
      ['B11', scenarioMinRoundMs],
      ['B12', scenarioCrossDay],
      ['B13', scenarioV1Migration],
      ['B14', scenarioThemeAndSound],
      ['B15', scenarioMobileLayout],
      ['B16', scenarioConsoleHealth],
    ];
    for (const [key, scenario] of scenarios) {
      if (!selected(key)) continue;
      await scenario();
    }
  } finally {
    await shutdown();
  }

  REPORT.finishedAt = new Date().toISOString();
  REPORT.summary = {
    total: REPORT.tests.length,
    passed: REPORT.tests.filter((item) => item.ok).length,
    failed: REPORT.tests.filter((item) => !item.ok).length,
    screenshots: REPORT.screenshots.length,
    consoleErrors: REPORT.consoleErrors.length,
    consoleWarnings: REPORT.consoleWarnings.length,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(REPORT, null, 2) + '\n');

  const summary = printSummary();
  process.exitCode = summary.failed > 0 ? 1 : 0;
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n收到 ${signal}，清理 Chrome ...`);
    await shutdown();
    process.exit(130);
  });
}

main().catch(async (error) => {
  log('');
  log(`✖ v2 e2e 运行失败: ${error.stack || error.message}`);
  try {
    await shutdown();
  } catch (shutdownError) {
    /* ignore */
  }
  REPORT.finishedAt = new Date().toISOString();
  REPORT.fatal = String(error.stack || error.message);
  REPORT.summary = {
    total: REPORT.tests.length,
    passed: REPORT.tests.filter((item) => item.ok).length,
    failed: REPORT.tests.filter((item) => !item.ok).length,
    screenshots: REPORT.screenshots.length,
    consoleErrors: REPORT.consoleErrors.length,
    consoleWarnings: REPORT.consoleWarnings.length,
  };
  try {
    fs.mkdirSync(QA_DIR, { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(REPORT, null, 2) + '\n');
  } catch (writeError) {
    /* ignore */
  }
  process.exitCode = 1;
});
