/*
 * Focus v3 — unit tests for focus-core.js (pure logic, no DOM).
 *
 * v3 model under test:
 *   - tasks (todo) carry expectedTaskMs + expectedFocusMs (plan per round)
 *   - a session is a series of focus rounds; each round has its own expected
 *     focus (hint only) and actual focused time (stopwatch)
 *   - pause ends + counts the current round, keeps the task active
 *   - task duration = wall clock from first start to completion (pauses count)
 *   - records store expected vs actual task duration and per-round focus
 *   - v2 data (focus.*.v1 keys) migrates without data loss
 *
 * Run: node --test tests/core.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../focus-core.js');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/* local-time helper so date keys are stable in any timezone */
function D(year, month, day, hour = 10, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime();
}

const NOW = D(2026, 10, 24, 10, 0, 0); // fixed "now" for deterministic tests

/** minimal localStorage-like fake */
function fakeStorage(entries) {
  const map = new Map(Object.entries(entries || {}));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    keys() {
      return Array.from(map.keys());
    },
    read(key) {
      try {
        return JSON.parse(map.get(key));
      } catch (err) {
        return undefined;
      }
    },
  };
}

function brokenStorage() {
  const boom = () => {
    throw new Error('storage denied');
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

function makeTask(overrides) {
  const opts = Object.assign(
    { title: '写方案', expectedTaskMs: HOUR, expectedFocusMs: 25 * MIN, now: NOW },
    overrides || {}
  );
  return Core.createTask(opts);
}

/** a running session with an open round that started `openMs` ago */
function runningSession(options) {
  const opts = options || {};
  const now = opts.now === undefined ? NOW : opts.now;
  const openMs = opts.openMs === undefined ? 0 : opts.openMs;
  const base = Core.createSession({
    task: opts.task || makeTask(),
    expectedFocusMs: opts.expectedFocusMs === undefined ? 25 * MIN : opts.expectedFocusMs,
    now: now - openMs,
  });
  return Object.assign(base, { roundStartedAt: now - openMs });
}

/**
 * Build a v3 record fixture and normalize it.
 * `rounds` accept {expectedMs, actualMs} pairs; extra v3 keys can be passed
 * through (roundsTotal, roundsWithExpected, focusTotalMs, ...).
 */
function makeRecordFixture(overrides) {
  const opts = overrides || {};
  const startedAt = opts.startedAt === undefined ? NOW - 30 * MIN : opts.startedAt;
  const endedAt = opts.endedAt === undefined ? NOW : opts.endedAt;
  const raw = {
    v: 3,
    title: opts.title === undefined ? '写方案' : opts.title,
    expectedTaskMs: opts.expectedTaskMs === undefined ? HOUR : opts.expectedTaskMs,
    taskDurationMs: opts.taskDurationMs === undefined ? 30 * MIN : opts.taskDurationMs,
    rounds: opts.rounds || [{ expectedMs: 25 * MIN, actualMs: 20 * MIN }],
    startedAt,
    endedAt,
  };
  ['id', 'taskId', 'dateKey', 'roundsTotal', 'roundsWithExpected', 'focusTotalMs', 'avgFocusMs', 'expectedFocusTotalMs'].forEach(
    (key) => {
      if (opts[key] !== undefined) raw[key] = opts[key];
    }
  );
  return Core.normalizeRecord(raw);
}

/** floating point comparison for derived averages / deltas */
function assertClose(actual, expected, message, epsilon = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${message || 'value'}: expected ≈ ${expected}, got ${actual}`
  );
}

/* ======================================================================== *
 * 0. API surface + constants
 * ======================================================================== */

test('v3 API surface: every documented export exists', () => {
  const functions = [
    'createTask',
    'normalizeTask',
    'addTask',
    'removeTask',
    'findTask',
    'createSession',
    'normalizeSession',
    'getRoundElapsedMs',
    'getCompletedRounds',
    'getFocusTotalMs',
    'getAverageFocusMs',
    'getTaskElapsedMs',
    'getRoundExpectedMs',
    'getCurrentRoundActualMs',
    'getRoundRemainingMs',
    'getRoundOvertimeMs',
    'getRoundProgress',
    'isRoundTargetReached',
    'getLastRound',
    'pauseSession',
    'setNextExpectedFocusMs',
    'resumeSession',
    'startNextRound',
    'completeSession',
    'restoreSession',
    'normalizeRecord',
    'recordMetrics',
    'summarize',
    'loadTasks',
    'saveTasks',
    'loadSession',
    'saveSession',
    'loadRecords',
    'saveRecords',
    'loadSettings',
    'saveSettings',
  ];
  functions.forEach((name) => assert.equal(typeof Core[name], 'function', `Core.${name}`));
  [
    'clampExpectedTaskMs',
    'clampExpectedFocusMs',
    'formatClock',
    'formatElapsed',
    'formatSpan',
    'minutesLabel',
    'formatTimeOfDay',
    'dateKey',
    'parseDateKey',
    'formatDayLabel',
    'sanitizeTasks',
    'sanitizeRecords',
    'addRecord',
    'removeRecord',
    'groupRecords',
    'clearSession',
    'normalizeSettings',
    'defaultSettings',
  ].forEach((name) => assert.equal(typeof Core[name], 'function', `Core.${name}`));
});

test('constants: VERSION=3, v3 storage keys, limits and defaults', () => {
  assert.equal(Core.VERSION, 3);
  assert.deepEqual(Core.STORAGE_KEYS, {
    tasks: 'focus.tasks.v3',
    session: 'focus.session.v3',
    records: 'focus.records.v3',
    settings: 'focus.settings.v3',
  });
  assert.deepEqual(Core.LEGACY_KEYS, {
    session: 'focus.session.v1',
    records: 'focus.records.v1',
    settings: 'focus.settings.v1',
  });
  assert.equal(Core.MIN_TASK_MINUTES, 1);
  assert.equal(Core.MAX_TASK_MINUTES, 1440);
  assert.equal(Core.MIN_FOCUS_MINUTES, 1);
  assert.equal(Core.MAX_FOCUS_MINUTES, 480);
  assert.equal(Core.DEFAULT_TASK_MS, HOUR);
  assert.equal(Core.DEFAULT_FOCUS_MS, 25 * MIN);
  assert.equal(Core.MIN_ROUND_MS, 1000);
  assert.equal(Core.MAX_RECORDS, 500);
  assert.equal(Core.WEEKDAYS.length, 7);
});

/* ======================================================================== *
 * 1. clamps / formatting
 * ======================================================================== */

test('clampExpectedTaskMs: default, min, max, rounding', () => {
  assert.equal(Core.clampExpectedTaskMs(undefined), HOUR);
  assert.equal(Core.clampExpectedTaskMs(null), MIN, 'Number(null) = 0 → clamped to the 1 min floor');
  assert.equal(Core.clampExpectedTaskMs(NaN), HOUR);
  assert.equal(Core.clampExpectedTaskMs('abc'), HOUR);
  assert.equal(Core.clampExpectedTaskMs(0), MIN);
  assert.equal(Core.clampExpectedTaskMs(-5), MIN);
  assert.equal(Core.clampExpectedTaskMs(999999999), 1440 * MIN);
  assert.equal(Core.clampExpectedTaskMs(90 * MIN), 90 * MIN);
  assert.equal(Core.clampExpectedTaskMs(90 * MIN + 400), 90 * MIN + 400, 'only rounds to ms');
  assert.equal(Core.clampExpectedTaskMs('1800000'), 30 * MIN);
});

test('clampExpectedFocusMs: default, min, max', () => {
  assert.equal(Core.clampExpectedFocusMs(undefined), 25 * MIN);
  assert.equal(Core.clampExpectedFocusMs(0), MIN);
  assert.equal(Core.clampExpectedFocusMs(1), MIN);
  assert.equal(Core.clampExpectedFocusMs(15 * MIN), 15 * MIN);
  assert.equal(Core.clampExpectedFocusMs(480 * MIN), 480 * MIN);
  assert.equal(Core.clampExpectedFocusMs(481 * MIN), 480 * MIN);
  assert.equal(Core.clampExpectedFocusMs(-1), MIN);
  assert.equal(Core.clampExpectedFocusMs(45.5 * MIN), 45.5 * MIN);
});

test('formatClock rounds up, formatElapsed rounds down', () => {
  assert.equal(Core.formatClock(0), '00:00');
  assert.equal(Core.formatClock(1), '00:01');
  assert.equal(Core.formatClock(999), '00:01');
  assert.equal(Core.formatClock(1000), '00:01');
  assert.equal(Core.formatClock(61000), '01:01');
  assert.equal(Core.formatClock(3600000), '1:00:00');
  assert.equal(Core.formatClock(3661000), '1:01:01');
  assert.equal(Core.formatElapsed(0), '00:00');
  assert.equal(Core.formatElapsed(999), '00:00');
  assert.equal(Core.formatElapsed(1000), '00:01');
  assert.equal(Core.formatElapsed(59999), '00:59');
  assert.equal(Core.formatElapsed(60000), '01:00');
  assert.equal(Core.formatElapsed(3600000), '1:00:00');
});

test('formatSpan: below a minute, minutes, hours', () => {
  assert.equal(Core.formatSpan(0), '0 分钟');
  assert.equal(Core.formatSpan(-1), '0 分钟');
  assert.equal(Core.formatSpan(29999), '不足 1 分钟');
  assert.equal(Core.formatSpan(30000), '1 分钟');
  assert.equal(Core.formatSpan(25 * MIN), '25 分钟');
  assert.equal(Core.formatSpan(59 * MIN + 30000), '1 小时'); // rounds to 60
  assert.equal(Core.formatSpan(HOUR), '1 小时');
  assert.equal(Core.formatSpan(HOUR + 10 * MIN), '1 小时 10 分钟');
  assert.equal(Core.formatSpan(2 * HOUR), '2 小时');
});

test('minutesLabel: whole-minute label used by today stats', () => {
  assert.equal(Core.minutesLabel(0), '0');
  assert.equal(Core.minutesLabel(-1000), '0');
  assert.equal(Core.minutesLabel(500), '<1');
  assert.equal(Core.minutesLabel(29999), '<1');
  assert.equal(Core.minutesLabel(30000), '1');
  assert.equal(Core.minutesLabel(90000), '2');
  assert.equal(Core.minutesLabel(43 * MIN), '43');
  assert.equal(Core.minutesLabel(90 * MIN), '90');
});

test('formatTimeOfDay / dateKey / parseDateKey', () => {
  assert.equal(Core.formatTimeOfDay(D(2026, 10, 24, 9, 5)), '09:05');
  assert.equal(Core.formatTimeOfDay(D(2026, 10, 24, 23, 59)), '23:59');
  assert.equal(Core.dateKey(D(2026, 1, 5, 0, 30)), '2026-01-05');
  const parsed = Core.parseDateKey('2026-10-24');
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 9);
  assert.equal(parsed.getDate(), 24);
  assert.equal(Core.parseDateKey('2026-10'), null);
  assert.equal(Core.parseDateKey('not-a-date'), null);
  assert.equal(Core.parseDateKey(42), null);
});

test('formatDayLabel: 今天 / 昨天 / same-year / other-year / raw key', () => {
  const now = D(2026, 10, 24, 12, 0, 0);
  assert.equal(Core.formatDayLabel('2026-10-24', now), '今天');
  assert.equal(Core.formatDayLabel('2026-10-23', now), '昨天');
  assert.equal(Core.formatDayLabel('2026-10-22', now), '10月22日');
  assert.equal(Core.formatDayLabel('2025-12-31', now), '2025年12月31日');
  assert.equal(Core.formatDayLabel('garbage', now), 'garbage');
});

/* ======================================================================== *
 * 2. tasks (todo items)
 * ======================================================================== */

test('createTask: defaults, trimming, clamping, generated id', () => {
  const task = Core.createTask({ now: NOW });
  assert.equal(task.v, 3);
  assert.equal(task.title, '未命名任务');
  assert.equal(task.expectedTaskMs, HOUR);
  assert.equal(task.expectedFocusMs, 25 * MIN);
  assert.equal(task.createdAt, NOW);
  assert.match(task.id, /^t_/);

  const custom = Core.createTask({
    title: '  写   方案   ',
    expectedTaskMs: 0,
    expectedFocusMs: 999 * MIN,
    now: 12345,
  });
  assert.equal(custom.title, '写 方案');
  assert.equal(custom.expectedTaskMs, MIN);
  assert.equal(custom.expectedFocusMs, 480 * MIN);
  assert.equal(custom.createdAt, 12345);
});

test('createTask: title limited to 60 chars, unique ids', () => {
  const long = Core.createTask({ title: 'x'.repeat(100) });
  assert.equal(long.title.length, 60);
  const a = Core.createTask({ title: 'a' });
  const b = Core.createTask({ title: 'b' });
  assert.notEqual(a.id, b.id);
});

test('normalizeTask: rejects invalid shapes, keeps + clamps valid ones', () => {
  assert.equal(Core.normalizeTask(null), null);
  assert.equal(Core.normalizeTask([]), null);
  assert.equal(Core.normalizeTask('task'), null);
  assert.equal(Core.normalizeTask({}), null);
  assert.equal(Core.normalizeTask({ title: '   ' }), null);
  assert.equal(Core.normalizeTask({ title: 42 }), null);

  const kept = Core.normalizeTask({
    id: 't_keep',
    title: '  任务 A  ',
    expectedTaskMs: 2 * HOUR,
    expectedFocusMs: 45 * MIN,
    createdAt: 999,
  });
  assert.equal(kept.id, 't_keep');
  assert.equal(kept.title, '任务 A');
  assert.equal(kept.expectedTaskMs, 2 * HOUR);
  assert.equal(kept.expectedFocusMs, 45 * MIN);
  assert.equal(kept.createdAt, 999);

  const fixed = Core.normalizeTask({ title: 'B', expectedTaskMs: 5, expectedFocusMs: 999 * MIN });
  assert.equal(fixed.expectedTaskMs, MIN);
  assert.equal(fixed.expectedFocusMs, 480 * MIN);
  assert.match(fixed.id, /^t_/);
  assert.equal(typeof fixed.createdAt, 'number');
});

test('sanitizeTasks / addTask / removeTask / findTask', () => {
  assert.deepEqual(Core.sanitizeTasks(null), []);
  assert.deepEqual(Core.sanitizeTasks({}), []);
  const list = Core.sanitizeTasks([
    { title: 'A', expectedTaskMs: HOUR, expectedFocusMs: 25 * MIN },
    null,
    { title: '' },
    { title: 'B' },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].title, 'A');
  assert.equal(list[1].title, 'B');

  const base = [makeTask({ title: 'old' })];
  const added = Core.addTask(base, makeTask({ title: 'new' }));
  assert.equal(added.length, 2);
  assert.equal(added[0].title, 'new', 'addTask prepends the newest task');
  assert.equal(base.length, 1, 'addTask does not mutate its input');
  assert.equal(Core.addTask(null, makeTask({ title: 'x' }))[0].title, 'x');
  assert.equal(Core.addTask(base, null).length, 1);
  assert.deepEqual(Core.addTask(null, null), []);

  const a = makeTask({ title: 'A' });
  const b = makeTask({ title: 'B' });
  const two = [a, b];
  assert.equal(Core.findTask(two, a.id).title, 'A');
  assert.equal(Core.findTask(two, 'missing'), null);
  assert.equal(Core.findTask(null, a.id), null);
  assert.deepEqual(
    Core.removeTask(two, a.id).map((task) => task.title),
    ['B']
  );
  assert.equal(two.length, 2, 'removeTask does not mutate its input');
  assert.deepEqual(Core.removeTask(null, 'x'), []);
});

/* ======================================================================== *
 * 3. sessions: create / normalize / round accounting helpers
 * ======================================================================== */

test('createSession: derives plan from task, custom round expectation wins', () => {
  const task = makeTask({ title: '写方案', expectedTaskMs: 2 * HOUR, expectedFocusMs: 45 * MIN });
  const session = Core.createSession({ task, now: NOW });
  assert.equal(session.v, 3);
  assert.equal(session.taskId, task.id);
  assert.equal(session.taskTitle, '写方案');
  assert.equal(session.taskExpectedMs, 2 * HOUR);
  assert.equal(session.expectedFocusMs, 45 * MIN);
  assert.equal(session.nextExpectedFocusMs, 45 * MIN);
  assert.equal(session.phase, 'running');
  assert.equal(session.startedAt, NOW);
  assert.equal(session.roundStartedAt, NOW);
  assert.equal(session.roundElapsedMs, 0);
  assert.deepEqual(session.rounds, []);
  assert.equal(session.restored, false);
  assert.match(session.id, /^s_/);

  const custom = Core.createSession({ task, expectedFocusMs: 15 * MIN, now: NOW });
  assert.equal(custom.expectedFocusMs, 15 * MIN);
  assert.equal(custom.nextExpectedFocusMs, 15 * MIN);

  const fallback = Core.createSession({ now: NOW });
  assert.equal(fallback.taskTitle, '专注');
  assert.equal(fallback.expectedFocusMs, 25 * MIN);
  assert.match(fallback.taskId, /^t_/);
});

test('normalizeSession: invalid → null, phases + rounds sanitized', () => {
  assert.equal(Core.normalizeSession(null), null);
  assert.equal(Core.normalizeSession([]), null);
  assert.equal(Core.normalizeSession({}), null);
  assert.equal(Core.normalizeSession({ taskTitle: '  ' }), null);

  const paused = Core.normalizeSession({
    taskTitle: ' 任务 ',
    phase: 'paused',
    expectedFocusMs: 45 * MIN,
    nextExpectedFocusMs: 20 * MIN,
    startedAt: 1000,
    roundStartedAt: 5000,
    roundElapsedMs: 9000,
    rounds: [{ expectedMs: 25 * MIN, actualMs: 10 * MIN }, { actualMs: 5000 }, 'junk'],
  });
  assert.equal(paused.v, 3);
  assert.equal(paused.taskTitle, '任务');
  assert.equal(paused.phase, 'paused');
  assert.equal(paused.roundStartedAt, null, 'paused sessions have no open round');
  assert.equal(paused.roundElapsedMs, 0);
  assert.equal(paused.rounds.length, 2);
  assert.equal(paused.rounds[0].expectedMs, 25 * MIN);
  assert.equal(paused.rounds[1].expectedMs, null);
  assert.equal(paused.nextExpectedFocusMs, 20 * MIN);
  assert.equal(paused.restored, false);

  const running = Core.normalizeSession({
    taskTitle: '任务',
    phase: 'running',
    startedAt: 1000,
    roundStartedAt: 2000,
    roundElapsedMs: 3000,
  });
  assert.equal(running.phase, 'running');
  assert.equal(running.roundStartedAt, 2000);
  assert.equal(running.roundElapsedMs, 3000);

  const weirdPhase = Core.normalizeSession({ taskTitle: '任务', phase: 'weird' });
  assert.equal(weirdPhase.phase, 'paused', 'unknown phase degrades to paused');
});

test('getRoundElapsedMs: running stopwatch, paused frozen, clamped at zero', () => {
  const session = runningSession({ now: NOW, openMs: 5 * MIN });
  assert.equal(Core.getRoundElapsedMs(session, NOW), 5 * MIN);
  assert.equal(Core.getRoundElapsedMs(session, NOW + 90 * SEC), 6.5 * MIN);
  assert.equal(Core.getRoundElapsedMs(session, NOW - 60 * SEC), 5 * MIN - 60 * SEC);

  const paused = { ...session, phase: 'paused' };
  assert.equal(Core.getRoundElapsedMs(paused, NOW + 60 * MIN), 0);

  const accumulated = { ...session, roundElapsedMs: 10 * MIN, roundStartedAt: NOW - MIN };
  assert.equal(Core.getRoundElapsedMs(accumulated, NOW), 11 * MIN);
  assert.equal(Core.getRoundElapsedMs(null, NOW), 0);
});

test('getCompletedRounds / getFocusTotalMs / getAverageFocusMs', () => {
  const empty = runningSession({ now: NOW });
  assert.equal(Core.getCompletedRounds(empty), 0);
  assert.equal(Core.getFocusTotalMs(empty), 0);
  assert.equal(Core.getAverageFocusMs(empty), 0);
  assert.equal(Core.getCompletedRounds(null), 0);
  assert.equal(Core.getFocusTotalMs(null), 0);
  assert.equal(Core.getAverageFocusMs(null), 0);

  const withRounds = {
    ...empty,
    rounds: [
      { expectedMs: 25 * MIN, actualMs: 20 * MIN },
      { expectedMs: 15 * MIN, actualMs: 10 * MIN },
    ],
  };
  assert.equal(Core.getCompletedRounds(withRounds), 2);
  assert.equal(Core.getFocusTotalMs(withRounds), 30 * MIN);
  assert.equal(Core.getAverageFocusMs(withRounds), 15 * MIN);
});

test('getTaskElapsedMs: wall clock from first start (pauses included)', () => {
  const session = runningSession({ now: NOW, openMs: 10 * MIN });
  assert.equal(Core.getTaskElapsedMs(session, NOW), 10 * MIN);
  const paused = { ...session, phase: 'paused' };
  assert.equal(Core.getTaskElapsedMs(paused, NOW + 30 * MIN), 40 * MIN);
  assert.equal(Core.getTaskElapsedMs(session, NOW - 60 * MIN), 0, 'never negative');
  assert.equal(Core.getTaskElapsedMs(null, NOW), 0);
});

test('round target helpers: expected / actual / remaining / overtime / progress / reached', () => {
  const session = runningSession({ now: NOW, expectedFocusMs: 25 * MIN, openMs: 10 * MIN });
  assert.equal(Core.getRoundExpectedMs(session), 25 * MIN);
  assert.equal(Core.getCurrentRoundActualMs(session, NOW), 10 * MIN);
  assert.equal(Core.getRoundRemainingMs(session, NOW), 15 * MIN);
  assert.equal(Core.getRoundOvertimeMs(session, NOW), 0);
  assert.equal(Core.getRoundProgress(session, NOW), 0.4);
  assert.equal(Core.isRoundTargetReached(session, NOW), false);

  assert.equal(Core.getRoundRemainingMs(session, NOW + 20 * MIN), 0);
  assert.equal(Core.getRoundOvertimeMs(session, NOW + 20 * MIN), 5 * MIN);
  assert.equal(Core.getRoundProgress(session, NOW + 20 * MIN), 1);
  assert.equal(Core.isRoundTargetReached(session, NOW + 20 * MIN), true);

  // exact boundary: reached exactly at expected, not one ms before
  assert.equal(Core.isRoundTargetReached(session, NOW + 15 * MIN - 1), false);
  assert.equal(Core.isRoundTargetReached(session, NOW + 15 * MIN), true);

  assert.equal(Core.getRoundProgress({ ...session, expectedFocusMs: 0 }, NOW), 0);
  assert.equal(Core.getRoundExpectedMs(null), 0);
  assert.equal(Core.isRoundTargetReached(null, NOW), false);
});

test('getLastRound', () => {
  const session = runningSession({ now: NOW });
  assert.equal(Core.getLastRound(session), null);
  const rounds = [{ expectedMs: MIN, actualMs: 2 * MIN }];
  const withRounds = { ...session, rounds };
  assert.deepEqual(Core.getLastRound(withRounds), rounds[0]);
  assert.equal(Core.getLastRound(null), null);
});

/* ======================================================================== *
 * 4. pause / next round / resume
 * ======================================================================== */

test('pauseSession: ends + counts the running round, keeps the task paused', () => {
  const session = runningSession({ now: NOW, expectedFocusMs: 25 * MIN, openMs: 18 * MIN });
  const result = Core.pauseSession(session, NOW);
  assert.equal(result.roundEnded, true);
  assert.equal(result.session.phase, 'paused');
  assert.equal(result.session.rounds.length, 1);
  assert.equal(result.round.expectedMs, 25 * MIN);
  assert.equal(result.round.actualMs, 18 * MIN);
  assert.equal(result.round.startedAt, NOW - 18 * MIN);
  assert.equal(result.round.endedAt, NOW);
  assert.equal(result.session.roundStartedAt, null);
  assert.equal(result.session.roundElapsedMs, 0);
  assert.equal(result.session.nextExpectedFocusMs, 25 * MIN);
  assert.equal(result.session.savedAt, NOW);
  assert.equal(Core.getFocusTotalMs(result.session), 18 * MIN);
  assert.equal(Core.getTaskElapsedMs(result.session, NOW), 18 * MIN);
});

test('pauseSession: 0ms / 999ms rounds are not counted, 1000ms is', () => {
  const zero = Core.pauseSession(runningSession({ now: NOW, openMs: 0 }), NOW);
  assert.equal(zero.roundEnded, false);
  assert.equal(zero.round, null);
  assert.equal(zero.session.rounds.length, 0);
  assert.equal(zero.session.phase, 'paused');

  const almost = Core.pauseSession(runningSession({ now: NOW, openMs: 999 }), NOW);
  assert.equal(almost.roundEnded, false);
  assert.equal(almost.session.rounds.length, 0, 'sub-second round is ignored');

  const exactly = Core.pauseSession(runningSession({ now: NOW, openMs: 1000 }), NOW);
  assert.equal(exactly.roundEnded, true);
  assert.equal(exactly.session.rounds.length, 1);
  assert.equal(exactly.round.actualMs, 1000);

  const extra = { ...runningSession({ now: NOW, openMs: 1500 }), roundElapsedMs: 2500 };
  const withPrevious = Core.pauseSession(extra, NOW);
  assert.equal(withPrevious.round.actualMs, 4000, 'carried roundElapsedMs counts too');
});

test('pauseSession: pausing an already paused session is a safe no-op', () => {
  const paused = Core.pauseSession(runningSession({ now: NOW, openMs: 5 * MIN }), NOW).session;
  const again = Core.pauseSession(paused, NOW + 10 * MIN);
  assert.equal(again.session, paused);
  assert.equal(again.roundEnded, false);
  assert.equal(again.round, null);
  assert.equal(again.session.rounds.length, 1);
  assert.equal(Core.pauseSession(null, NOW).session, null);
});

test('setNextExpectedFocusMs: changes only the next round plan, clamps input', () => {
  const session = runningSession({ now: NOW, expectedFocusMs: 25 * MIN });
  const changed = Core.setNextExpectedFocusMs(session, 45 * MIN);
  assert.equal(changed.nextExpectedFocusMs, 45 * MIN);
  assert.equal(changed.expectedFocusMs, 25 * MIN, 'current round expectation untouched');
  assert.equal(session.nextExpectedFocusMs, 25 * MIN, 'no mutation');
  assert.equal(Core.setNextExpectedFocusMs(session, 999 * MIN).nextExpectedFocusMs, 480 * MIN);
  assert.equal(Core.setNextExpectedFocusMs(session, 0).nextExpectedFocusMs, MIN);
  assert.equal(Core.setNextExpectedFocusMs(null, MIN), null);
});

test('resumeSession: paused → running with the next round plan', () => {
  const paused = Core.pauseSession(runningSession({ now: NOW, openMs: 18 * MIN }), NOW).session;
  const planned = Core.setNextExpectedFocusMs(paused, 20 * MIN);
  const resumed = Core.resumeSession(planned, NOW + 7 * MIN);
  assert.equal(resumed.phase, 'running');
  assert.equal(resumed.expectedFocusMs, 20 * MIN);
  assert.equal(resumed.nextExpectedFocusMs, 20 * MIN);
  assert.equal(resumed.roundStartedAt, NOW + 7 * MIN);
  assert.equal(resumed.roundElapsedMs, 0);
  assert.equal(resumed.rounds.length, 1, 'previous rounds kept');
  assert.equal(Core.getRoundElapsedMs(resumed, NOW + 9 * MIN), 2 * MIN);
  assert.equal(Core.getTaskElapsedMs(resumed, NOW + 9 * MIN), 27 * MIN, 'pause counts in task time');

  const running = runningSession({ now: NOW });
  assert.equal(Core.resumeSession(running, NOW), running, 'running session unchanged');
  assert.equal(Core.resumeSession(null, NOW), null);
});

test('resumeSession: default plan is the paused session nextExpectedFocusMs', () => {
  const paused = Core.pauseSession(runningSession({ now: NOW, expectedFocusMs: 45 * MIN }), NOW).session;
  assert.equal(paused.nextExpectedFocusMs, 45 * MIN);
  const resumed = Core.resumeSession(paused, NOW);
  assert.equal(resumed.expectedFocusMs, 45 * MIN);
});

test('startNextRound from running: ends current round and starts another immediately', () => {
  const session = runningSession({ now: NOW, expectedFocusMs: 25 * MIN, openMs: 30 * MIN });
  const result = Core.startNextRound(session, NOW);
  assert.equal(result.roundEnded, true);
  assert.equal(result.round.actualMs, 30 * MIN);
  assert.equal(result.round.expectedMs, 25 * MIN);
  assert.equal(result.session.phase, 'running');
  assert.equal(result.session.rounds.length, 1);
  assert.equal(result.session.roundStartedAt, NOW);
  assert.equal(result.session.roundElapsedMs, 0);
  assert.equal(result.session.expectedFocusMs, 25 * MIN, 'same plan for the new round');
  assert.equal(Core.getRoundElapsedMs(result.session, NOW + MIN), MIN);
});

test('startNextRound: sub-second current round is skipped, new round still starts', () => {
  const session = runningSession({ now: NOW, openMs: 999 });
  const result = Core.startNextRound(session, NOW);
  assert.equal(result.roundEnded, false);
  assert.equal(result.session.rounds.length, 0);
  assert.equal(result.session.phase, 'running');
  assert.equal(result.session.roundStartedAt, NOW);
});

test('startNextRound from paused: starts a round with nextExpectedFocusMs, counts nothing', () => {
  const paused = Core.pauseSession(runningSession({ now: NOW, openMs: 18 * MIN }), NOW).session;
  const planned = Core.setNextExpectedFocusMs(paused, 15 * MIN);
  const result = Core.startNextRound(planned, NOW + 5 * MIN);
  assert.equal(result.roundEnded, false);
  assert.equal(result.round, null);
  assert.equal(result.session.phase, 'running');
  assert.equal(result.session.expectedFocusMs, 15 * MIN);
  assert.equal(result.session.nextExpectedFocusMs, 15 * MIN);
  assert.equal(result.session.roundStartedAt, NOW + 5 * MIN);
  assert.equal(result.session.rounds.length, 1);
});

/* ======================================================================== *
 * 5. completeSession → record
 * ======================================================================== */

test('completeSession: rejects sessions with no countable round', () => {
  assert.equal(Core.completeSession(null, NOW), null);
  assert.equal(Core.completeSession(runningSession({ now: NOW, openMs: 0 }), NOW), null);
  assert.equal(Core.completeSession(runningSession({ now: NOW, openMs: 999 }), NOW), null);
});

test('completeSession: running session records expected vs actual task + rounds', () => {
  const task = makeTask({ title: '写方案', expectedTaskMs: 2 * HOUR, expectedFocusMs: 25 * MIN });
  const session = Core.createSession({ task, expectedFocusMs: 15 * MIN, now: NOW });
  const record = Core.completeSession(session, NOW + 18 * MIN);
  assert.ok(record);
  assert.equal(record.v, 3);
  assert.match(record.id, /^r_/);
  assert.equal(record.taskId, task.id);
  assert.equal(record.title, '写方案');
  assert.equal(record.expectedTaskMs, 2 * HOUR);
  assert.equal(record.taskDurationMs, 18 * MIN);
  assert.equal(record.roundsTotal, 1);
  assert.equal(record.roundsWithExpected, 1);
  assert.equal(record.focusTotalMs, 18 * MIN);
  assert.equal(record.avgFocusMs, 18 * MIN);
  assert.equal(record.expectedFocusTotalMs, 15 * MIN);
  assert.deepEqual(record.rounds, [{ expectedMs: 15 * MIN, actualMs: 18 * MIN }]);
  assert.equal(record.startedAt, NOW);
  assert.equal(record.endedAt, NOW + 18 * MIN);
  assert.equal(record.dateKey, Core.dateKey(NOW + 18 * MIN));
});

test('completeSession: task duration is wall clock, includes paused gaps', () => {
  const session = Core.createSession({ task: makeTask({ expectedTaskMs: HOUR }), now: NOW });
  const paused = Core.pauseSession(session, NOW + 10 * MIN).session;
  // leave the task paused for 50 min, then complete
  const record = Core.completeSession(paused, NOW + 60 * MIN);
  assert.equal(record.focusTotalMs, 10 * MIN);
  assert.equal(record.roundsTotal, 1);
  assert.equal(record.taskDurationMs, 60 * MIN, 'wall clock includes the pause');
  assert.equal(record.expectedTaskMs, HOUR);
});

test('completeSession: task duration never smaller than focus total', () => {
  const session = {
    ...Core.createSession({ task: makeTask(), now: NOW }),
    startedAt: NOW + 5 * MIN, // wall = 5 min
    roundStartedAt: NOW, // but this round has actually run 10 min
  };
  const record = Core.completeSession(session, NOW + 10 * MIN);
  assert.equal(record.focusTotalMs, 10 * MIN);
  assert.equal(record.taskDurationMs, 10 * MIN);
});

test('completeSession: mixed round expectations weight the focus target', () => {
  const session = Core.createSession({ task: makeTask(), now: NOW });
  const afterFirst = Core.pauseSession(
    Object.assign(session, { roundStartedAt: NOW - 20 * MIN }),
    NOW
  ).session;
  const resumed = Core.resumeSession(Core.setNextExpectedFocusMs(afterFirst, 10 * MIN), NOW + 5 * MIN);
  resumed.roundStartedAt = NOW + 5 * MIN;
  const completed = Core.completeSession(resumed, NOW + 15 * MIN);
  assert.equal(completed.roundsTotal, 2);
  assert.equal(completed.roundsWithExpected, 2);
  assert.equal(completed.expectedFocusTotalMs, 25 * MIN + 10 * MIN);
  assert.equal(completed.focusTotalMs, 20 * MIN + 10 * MIN);
  assert.equal(completed.avgFocusMs, 15 * MIN);
});

test('completeSession: completing while paused keeps all recorded rounds', () => {
  const session = Core.createSession({ task: makeTask(), now: NOW });
  const r1 = Core.pauseSession(Object.assign(session, { roundStartedAt: NOW - 10 * MIN }), NOW).session;
  const r2 = Core.pauseSession(
    Object.assign(Core.resumeSession(r1, NOW + MIN), { roundStartedAt: NOW + MIN }),
    NOW + 6 * MIN
  ).session;
  const record = Core.completeSession(r2, NOW + 20 * MIN);
  assert.equal(record.roundsTotal, 2);
  assert.equal(record.rounds[0].actualMs, 10 * MIN);
  assert.equal(record.rounds[1].actualMs, 5 * MIN);
  assert.equal(record.focusTotalMs, 15 * MIN);
  assert.equal(record.taskDurationMs, 20 * MIN);
});

test('full session flow: expected/actual metrics line up with the v3 spec', () => {
  const t0 = D(2026, 10, 24, 9, 0, 0);
  const task = makeTask({ title: '写方案', expectedTaskMs: 2 * HOUR, expectedFocusMs: 25 * MIN, now: t0 });
  let session = Core.createSession({ task, expectedFocusMs: 15 * MIN, now: t0 });

  // round 1: 18 min (target 15 — over target but not auto stopped)
  assert.equal(Core.isRoundTargetReached(session, t0 + 15 * MIN), true);
  assert.equal(session.phase, 'running', 'reaching the target never stops the round');
  let step = Core.pauseSession(session, t0 + 18 * MIN);
  session = Core.setNextExpectedFocusMs(step.session, 20 * MIN);

  // paused for 7 min, then round 2: 21 min (target 20)
  session = Core.resumeSession(session, t0 + 25 * MIN);
  assert.equal(session.rounds.length, 1);
  assert.equal(session.expectedFocusMs, 20 * MIN);
  assert.equal(Core.getTaskElapsedMs(session, t0 + 25 * MIN), 25 * MIN);

  // switch to round 3 (target stays 20) and focus 4 more min
  step = Core.startNextRound(session, t0 + 46 * MIN);
  assert.equal(step.roundEnded, true);
  assert.equal(step.round.actualMs, 21 * MIN);
  assert.equal(step.round.expectedMs, 20 * MIN);
  session = step.session;

  const record = Core.completeSession(session, t0 + 50 * MIN);
  assert.equal(record.roundsTotal, 3);
  assert.deepEqual(
    record.rounds.map((round) => round.actualMs),
    [18 * MIN, 21 * MIN, 4 * MIN]
  );
  assert.deepEqual(
    record.rounds.map((round) => round.expectedMs),
    [15 * MIN, 20 * MIN, 20 * MIN]
  );
  assert.equal(record.focusTotalMs, 43 * MIN);
  assert.equal(record.avgFocusMs, (43 / 3) * MIN);
  assert.equal(record.expectedFocusTotalMs, 55 * MIN);
  assert.equal(record.taskDurationMs, 50 * MIN, 'pauses included in wall clock');
  assert.equal(record.expectedTaskMs, 2 * HOUR);

  const metrics = Core.recordMetrics(record);
  assert.equal(metrics.avgFocusMs, (43 / 3) * MIN);
  assert.equal(metrics.expectedFocusAvgMs, (55 / 3) * MIN);
  assert.equal(metrics.taskDeltaMs, 70 * MIN, 'actual 50 vs expected 120 = 70 min early');
  assertClose(metrics.focusDeltaMs, -4 * MIN, 'focus delta (43/3 - 55/3 min)');
});

/* ======================================================================== *
 * 6. restoreSession (refresh recovery)
 * ======================================================================== */

test('restoreSession: running session is closed as a round and becomes paused', () => {
  const task = makeTask();
  const start = NOW - 10 * MIN;
  const running = Core.createSession({ task, expectedFocusMs: 25 * MIN, now: start });
  const storage = fakeStorage();

  // simulate persisted payload: phase running, savedAt = NOW
  const persisted = { ...running, savedAt: NOW };
  const restored = Core.restoreSession(persisted, NOW + 5 * MIN);
  assert.equal(restored.phase, 'paused');
  assert.equal(restored.restored, true);
  assert.equal(restored.rounds.length, 1);
  assert.equal(restored.rounds[0].actualMs, 10 * MIN, 'actual time is not lost');
  assert.equal(restored.rounds[0].expectedMs, 25 * MIN);
  assert.equal(restored.roundStartedAt, null);
  assert.equal(restored.roundElapsedMs, 0);
  assert.equal(Core.getFocusTotalMs(restored), 10 * MIN);
  assert.equal(Core.getTaskElapsedMs(restored, NOW + 5 * MIN), 15 * MIN);

  // and it can be persisted + loaded again
  assert.equal(Core.saveSession(storage, restored, NOW + 5 * MIN), true);
  const loaded = Core.loadSession(storage);
  assert.equal(loaded.phase, 'paused');
  assert.equal(loaded.rounds.length, 1);
});

test('restoreSession: sub-second open round is dropped, previous rounds kept', () => {
  const running = runningSession({ now: NOW, openMs: 500 });
  running.rounds = [{ expectedMs: 25 * MIN, actualMs: 10 * MIN }];
  const restored = Core.restoreSession({ ...running, savedAt: NOW }, NOW + 2 * MIN);
  assert.equal(restored.phase, 'paused');
  assert.equal(restored.rounds.length, 1, 'short open round discarded');
  assert.equal(restored.rounds[0].actualMs, 10 * MIN);
});

test('restoreSession: already paused session stays paused with rounds intact', () => {
  const paused = Core.pauseSession(runningSession({ now: NOW, openMs: 18 * MIN }), NOW).session;
  const restored = Core.restoreSession(paused, NOW + 60 * MIN);
  assert.equal(restored.phase, 'paused');
  assert.equal(restored.rounds.length, 1);
  assert.equal(restored.rounds[0].actualMs, 18 * MIN);
  assert.equal(Core.getTaskElapsedMs(restored, NOW + 60 * MIN), 78 * MIN);
});

test('restoreSession: invalid payloads return null / degrade safely', () => {
  assert.equal(Core.restoreSession(null, NOW), null);
  assert.equal(Core.restoreSession({}, NOW), null);
  assert.equal(Core.restoreSession({ taskTitle: '任务', phase: 'running' }, NOW).phase, 'paused');
});

/* ======================================================================== *
 * 7. records: normalize / metrics
 * ======================================================================== */

test('normalizeRecord: v3 record round-trips', () => {
  const raw = {
    id: 'r_1',
    taskId: 't_1',
    title: '  写方案 ',
    expectedTaskMs: 2 * HOUR,
    taskDurationMs: 50 * MIN,
    rounds: [
      { expectedMs: 15 * MIN, actualMs: 18 * MIN },
      { expectedMs: 20 * MIN, actualMs: 21 * MIN },
      { expectedMs: 20 * MIN, actualMs: 4 * MIN },
    ],
    focusTotalMs: 43 * MIN,
    avgFocusMs: (43 / 3) * MIN,
    expectedFocusTotalMs: 55 * MIN,
    startedAt: NOW - 50 * MIN,
    endedAt: NOW,
  };
  const record = Core.normalizeRecord(raw);
  assert.equal(record.v, 3);
  assert.equal(record.id, 'r_1');
  assert.equal(record.taskId, 't_1');
  assert.equal(record.title, '写方案');
  assert.equal(record.expectedTaskMs, 2 * HOUR);
  assert.equal(record.taskDurationMs, 50 * MIN);
  assert.equal(record.roundsTotal, 3);
  assert.equal(record.roundsWithExpected, 3);
  assert.equal(record.focusTotalMs, 43 * MIN);
  assert.equal(record.expectedFocusTotalMs, 55 * MIN);
  assert.equal(record.avgFocusMs, (43 / 3) * MIN);
  assert.equal(record.dateKey, Core.dateKey(NOW));
});

test('normalizeRecord: rejects missing title / timestamps / zero focus', () => {
  assert.equal(Core.normalizeRecord(null), null);
  assert.equal(Core.normalizeRecord('record'), null);
  assert.equal(Core.normalizeRecord({}), null);
  assert.equal(
    Core.normalizeRecord({ title: 'A', startedAt: NOW, endedAt: NOW, focusTotalMs: 0 }),
    null
  );
  assert.equal(
    Core.normalizeRecord({ title: 'A', endedAt: NOW, focusTotalMs: 1000 }),
    null,
    'missing startedAt'
  );
  assert.equal(
    Core.normalizeRecord({ title: '', startedAt: NOW, endedAt: NOW, focusTotalMs: 1000 }),
    null
  );
});

test('normalizeRecord: legacy v2 field names migrate', () => {
  const legacy = {
    v: 2,
    id: 'r_v2',
    taskName: '旧任务',
    targetMs: 25 * MIN,
    totalFocusedMs: 15 * MIN,
    roundsTotal: 2,
    rounds: [10 * MIN, 5 * MIN],
    startedAt: NOW - 20 * MIN,
    endedAt: NOW,
    dateKey: '2026-10-24',
  };
  const record = Core.normalizeRecord(legacy);
  assert.ok(record, 'legacy record is not dropped');
  assert.equal(record.v, 3);
  assert.equal(record.id, 'r_v2');
  assert.equal(record.title, '旧任务');
  assert.equal(record.expectedTaskMs, 25 * MIN);
  assert.equal(record.focusTotalMs, 15 * MIN);
  assert.equal(record.taskDurationMs, 15 * MIN, 'falls back to totalFocusedMs');
  assert.equal(record.roundsTotal, 2);
  assert.equal(record.roundsWithExpected, 0);
  assert.equal(record.rounds.length, 2);
  assert.equal(record.rounds[0].actualMs, 10 * MIN);
  assert.equal(record.rounds[0].expectedMs, null);
  assert.equal(record.dateKey, '2026-10-24');
  assert.equal(record.avgFocusMs, 7.5 * MIN);

  const metrics = Core.recordMetrics(record);
  assert.equal(metrics.expectedFocusAvgMs, null);
  assert.equal(metrics.focusDeltaMs, null);
  assert.equal(metrics.taskDeltaMs, 10 * MIN);
});

test('normalizeRecord: legacy object rounds without actualMs are dropped safely', () => {
  const record = Core.normalizeRecord({
    title: '旧的',
    startedAt: NOW - MIN,
    endedAt: NOW,
    totalFocusedMs: 5 * MIN,
    rounds: [{ focusedMs: 3000 }, { focusedMs: 5000 }, 'junk', 2000],
  });
  assert.equal(record.rounds.length, 1, 'only numeric rounds survive');
  assert.equal(record.rounds[0].actualMs, 2000);
  assert.equal(record.focusTotalMs, 5 * MIN);
});

test('normalizeRecord: roundsTotal/roundsWithExpected are coherent', () => {
  const record = Core.normalizeRecord({
    title: 'A',
    startedAt: NOW,
    endedAt: NOW,
    focusTotalMs: 1000,
    roundsTotal: 5,
    roundsWithExpected: 9,
    rounds: [{ expectedMs: 25 * MIN, actualMs: 1000 }],
  });
  assert.equal(record.roundsTotal, 5);
  assert.equal(record.roundsWithExpected, 5, 'cannot exceed total rounds');
  const fallback = Core.normalizeRecord({
    title: 'B',
    startedAt: NOW,
    endedAt: NOW,
    focusTotalMs: 1000,
    rounds: [{ expectedMs: 25 * MIN, actualMs: 1000 }],
  });
  assert.equal(fallback.roundsTotal, 1);
  assert.equal(fallback.roundsWithExpected, 1);
});

test('recordMetrics: current v3 record', () => {
  const record = makeRecordFixture({
    expectedTaskMs: HOUR,
    taskDurationMs: 40 * MIN,
    rounds: [
      { expectedMs: 20 * MIN, actualMs: 25 * MIN },
      { expectedMs: 20 * MIN, actualMs: 15 * MIN },
    ],
  });
  const metrics = Core.recordMetrics(record);
  assert.equal(metrics.avgFocusMs, 20 * MIN);
  assert.equal(metrics.expectedFocusAvgMs, 20 * MIN);
  assert.equal(metrics.taskDeltaMs, 20 * MIN);
  assert.equal(metrics.focusDeltaMs, 0);
  assert.deepEqual(Core.recordMetrics(null), {
    avgFocusMs: 0,
    expectedFocusAvgMs: null,
    taskDeltaMs: 0,
    focusDeltaMs: null,
  });
});

test('recordMetrics: focus target weighted by roundsWithExpected, not roundsTotal', () => {
  // 2 rounds actual, only 1 of them knew its expectation
  const record = makeRecordFixture({
    expectedTaskMs: HOUR,
    taskDurationMs: 30 * MIN,
    rounds: [{ expectedMs: 30 * MIN, actualMs: 20 * MIN }, { actualMs: 10 * MIN }],
    roundsTotal: 3, // legacy record may claim more rounds than stored
    roundsWithExpected: 1,
    expectedFocusTotalMs: 30 * MIN,
    focusTotalMs: 30 * MIN,
  });
  const metrics = Core.recordMetrics(record);
  assert.equal(metrics.avgFocusMs, 10 * MIN, '30 min / 3 rounds');
  assert.equal(metrics.expectedFocusAvgMs, 30 * MIN, 'weighted by 1 known expectation');
  assert.equal(metrics.focusDeltaMs, -20 * MIN);
});

test('recordMetrics: faster than expected is positive, slower is negative', () => {
  const fast = Core.recordMetrics(
    makeRecordFixture({ expectedTaskMs: 2 * HOUR, taskDurationMs: 30 * MIN })
  );
  assert.equal(fast.taskDeltaMs, 90 * MIN);
  const slow = Core.recordMetrics(
    makeRecordFixture({ expectedTaskMs: 30 * MIN, taskDurationMs: 2 * HOUR })
  );
  assert.equal(slow.taskDeltaMs, -90 * MIN);
  const equal = Core.recordMetrics(
    makeRecordFixture({ expectedTaskMs: HOUR, taskDurationMs: HOUR })
  );
  assert.equal(equal.taskDeltaMs, 0);
});

test('sanitizeRecords: sort desc, drop junk, cap at MAX_RECORDS', () => {
  assert.deepEqual(Core.sanitizeRecords(null), []);
  assert.deepEqual(Core.sanitizeRecords({}), []);
  const three = Core.sanitizeRecords([
    makeRecordFixture({ endedAt: NOW - 2 * HOUR, startedAt: NOW - 3 * HOUR }),
    makeRecordFixture({ endedAt: NOW, startedAt: NOW - HOUR }),
    null,
    makeRecordFixture({ endedAt: NOW - HOUR, startedAt: NOW - 2 * HOUR }),
  ]);
  assert.equal(three.length, 3);
  assert.deepEqual(
    three.map((r) => r.endedAt),
    [NOW, NOW - HOUR, NOW - 2 * HOUR]
  );

  const many = [];
  for (let i = 0; i < 505; i += 1) {
    many.push({
      title: `任务${i}`,
      startedAt: NOW - (505 - i) * MIN,
      endedAt: NOW - (505 - i) * MIN + 30 * SEC,
      focusTotalMs: 30 * SEC,
      expectedTaskMs: HOUR,
      taskDurationMs: 30 * SEC,
      rounds: [30 * SEC],
    });
  }
  const capped = Core.sanitizeRecords(many);
  assert.equal(capped.length, Core.MAX_RECORDS);
  assert.equal(capped[0].endedAt, NOW - MIN + 30 * SEC, 'newest first');
  assert.ok(capped[0].endedAt > capped[capped.length - 1].endedAt);
});

test('addRecord / removeRecord / groupRecords', () => {
  const older = makeRecordFixture({ endedAt: NOW - HOUR, startedAt: NOW - 2 * HOUR });
  const newer = makeRecordFixture({ endedAt: NOW, startedAt: NOW - HOUR });
  const list = Core.addRecord([older], newer);
  assert.deepEqual(
    list.map((r) => r.endedAt),
    [NOW, NOW - HOUR],
    'newest first'
  );
  assert.equal(Core.addRecord([], null).length, 0);
  const removed = Core.removeRecord(list, newer.id);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, older.id);
  assert.equal(list.length, 2, 'no mutation');
  assert.deepEqual(Core.removeRecord(null, 'x'), []);

  const dayA = makeRecordFixture({ endedAt: D(2026, 10, 24, 12), startedAt: D(2026, 10, 24, 11) });
  const dayB = makeRecordFixture({ endedAt: D(2026, 10, 23, 12), startedAt: D(2026, 10, 23, 11) });
  const dayB2 = makeRecordFixture({ endedAt: D(2026, 10, 23, 9), startedAt: D(2026, 10, 23, 8) });
  const groups = Core.groupRecords(Core.sanitizeRecords([dayB, dayA, dayB2]));
  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, '2026-10-24');
  assert.equal(groups[0].records.length, 1);
  assert.equal(groups[1].key, '2026-10-23');
  assert.equal(groups[1].records.length, 2);
  assert.deepEqual(Core.groupRecords(null), []);
});

/* ======================================================================== *
 * 8. summarize (today stats / streak / 7-day chart)
 * ======================================================================== */

test('summarize: empty records produce an all-zero summary', () => {
  const summary = Core.summarize([], NOW);
  assert.equal(summary.today.tasks, 0);
  assert.equal(summary.today.rounds, 0);
  assert.equal(summary.today.focusMs, 0);
  assert.equal(summary.today.avgFocusMs, 0);
  assert.equal(summary.today.expectedFocusAvgMs, null);
  assert.equal(summary.today.taskDeltaMs, 0);
  assert.equal(summary.streak, 0);
  assert.equal(summary.last7.length, 7);
  assert.equal(summary.last7[6].isToday, true);
  assert.deepEqual(
    summary.last7.map((day) => day.ms),
    [0, 0, 0, 0, 0, 0, 0]
  );
  assert.deepEqual(Core.summarize(null, NOW).total, summary.total);
});

test('summarize: aggregates today only, keeps overall total', () => {
  const todayA = makeRecordFixture({
    endedAt: NOW,
    startedAt: NOW - 40 * MIN,
    expectedTaskMs: HOUR,
    taskDurationMs: 40 * MIN,
    rounds: [
      { expectedMs: 20 * MIN, actualMs: 25 * MIN },
      { expectedMs: 20 * MIN, actualMs: 15 * MIN },
    ],
  });
  const todayB = makeRecordFixture({
    endedAt: NOW - HOUR,
    startedAt: NOW - 2 * HOUR,
    expectedTaskMs: 30 * MIN,
    taskDurationMs: 20 * MIN,
    rounds: [{ expectedMs: 15 * MIN, actualMs: 10 * MIN }],
  });
  const yesterday = makeRecordFixture({
    endedAt: NOW - 24 * HOUR,
    startedAt: NOW - 25 * HOUR,
    expectedTaskMs: HOUR,
    taskDurationMs: 30 * MIN,
    rounds: [{ expectedMs: 25 * MIN, actualMs: 20 * MIN }],
  });
  const summary = Core.summarize([todayA, todayB, yesterday], NOW);

  assert.equal(summary.today.tasks, 2);
  assert.equal(summary.today.rounds, 3);
  assert.equal(summary.today.focusMs, 50 * MIN);
  assertClose(summary.today.avgFocusMs, (50 / 3) * MIN, 'today average focus');
  assertClose(summary.today.expectedFocusAvgMs, (55 / 3) * MIN, 'today expected average focus');
  assert.equal(summary.today.expectedTaskMs, 90 * MIN);
  assert.equal(summary.today.taskDurationMs, 60 * MIN);
  assert.equal(summary.today.taskDeltaMs, 30 * MIN);
  assert.equal(summary.today.roundsWithExpected, 3);

  assert.equal(summary.total.tasks, 3);
  assert.equal(summary.total.rounds, 4);
  assert.equal(summary.total.focusMs, 70 * MIN);
  assert.equal(summary.total.expectedTaskMs, 150 * MIN);
  assert.equal(summary.total.taskDurationMs, 90 * MIN);

  assert.equal(summary.last7[6].ms, 50 * MIN, 'today bar');
  assert.equal(summary.last7[5].ms, 20 * MIN, 'yesterday bar');
  assert.equal(summary.streak, 2);
  assert.equal(summary.last7[6].weekday, Core.WEEKDAYS[new Date(NOW).getDay()]);
  assert.equal(summary.last7[6].isToday, true);
});

test('summarize: streak breaks on a gap and counts from yesterday if today is empty', () => {
  const day = (offset) => {
    const endedAt = NOW - offset * 24 * HOUR;
    return makeRecordFixture({ endedAt, startedAt: endedAt - 30 * MIN });
  };
  assert.equal(Core.summarize([day(0), day(1), day(2)], NOW).streak, 3);
  assert.equal(Core.summarize([day(1), day(2)], NOW).streak, 2, 'today empty → count from yesterday');
  assert.equal(Core.summarize([day(0), day(2)], NOW).streak, 1);
  assert.equal(Core.summarize([day(3)], NOW).streak, 0);
});

test('summarize: record without dateKey falls back to endedAt day', () => {
  const record = { ...makeRecordFixture({ endedAt: NOW }), dateKey: undefined };
  const summary = Core.summarize([record], NOW);
  assert.equal(summary.today.tasks, 1);
  assert.equal(summary.today.focusMs, record.focusTotalMs);
});

/* ======================================================================== *
 * 9. storage + migration
 * ======================================================================== */

test('storage: tasks round-trip and bad data falls back safely', () => {
  const storage = fakeStorage();
  const tasks = [makeTask({ title: 'A' }), makeTask({ title: 'B' })];
  assert.equal(Core.saveTasks(storage, tasks), true);
  assert.ok(storage.map.has(Core.STORAGE_KEYS.tasks));
  const loaded = Core.loadTasks(storage);
  assert.equal(loaded.length, 2);
  assert.deepEqual(
    loaded.map((t) => t.title),
    ['A', 'B']
  );
  assert.deepEqual(Core.loadTasks(fakeStorage()), []);

  const corrupted = fakeStorage({ [Core.STORAGE_KEYS.tasks]: '{not json' });
  assert.deepEqual(Core.loadTasks(corrupted), []);

  const denied = brokenStorage();
  assert.deepEqual(Core.loadTasks(denied), []);
  assert.equal(Core.saveTasks(denied, tasks), false);
});

test('migration: v2 session becomes a todo task (old keys preserved)', () => {
  const legacySession = {
    v: 2,
    id: 's_old',
    taskName: '旧会话任务',
    targetMs: 45 * MIN,
    startedAt: NOW - 30 * MIN,
    rounds: [{ focusedMs: 20 * MIN }],
    phase: 'paused',
  };
  const storage = fakeStorage({ [Core.LEGACY_KEYS.session]: JSON.stringify(legacySession) });
  const tasks = Core.loadTasks(storage);
  assert.equal(tasks.length, 1, 'legacy session becomes a task');
  assert.equal(tasks[0].title, '旧会话任务');
  assert.equal(tasks[0].expectedTaskMs, 45 * MIN);
  assert.equal(tasks[0].expectedFocusMs, 45 * MIN);
  assert.equal(tasks[0].createdAt, NOW - 30 * MIN);
  assert.ok(storage.map.has(Core.STORAGE_KEYS.tasks), 'migrated task is persisted');
  assert.ok(storage.map.has(Core.LEGACY_KEYS.session), 'legacy key untouched (no data loss)');
  assert.equal(Core.loadTasks(storage).length, 1, 'second load does not duplicate');
});

test('migration: v3 tasks win over the legacy session when both exist', () => {
  const v3 = [makeTask({ title: '新任务' })];
  const storage = fakeStorage({
    [Core.STORAGE_KEYS.tasks]: JSON.stringify(v3),
    [Core.LEGACY_KEYS.session]: JSON.stringify({ taskName: '旧会话', targetMs: 25 * MIN }),
  });
  const tasks = Core.loadTasks(storage);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, '新任务');
});

test('migration: v2 records become v3 records under the new key', () => {
  const legacyRecords = [
    {
      v: 2,
      id: 'r_v2_1',
      taskName: '写方案',
      targetMs: 25 * MIN,
      totalFocusedMs: 15 * MIN,
      roundsTotal: 2,
      rounds: [10 * MIN, 5 * MIN],
      startedAt: NOW - 30 * MIN,
      endedAt: NOW,
      dateKey: '2026-10-24',
    },
    {
      v: 2,
      id: 'r_v2_2',
      taskName: '回邮件',
      targetMs: 15 * MIN,
      totalFocusedMs: 20 * MIN,
      roundsTotal: 1,
      rounds: [20 * MIN],
      startedAt: NOW - 60 * MIN,
      endedAt: NOW - 30 * MIN,
      dateKey: '2026-10-24',
    },
  ];
  const storage = fakeStorage({ [Core.LEGACY_KEYS.records]: JSON.stringify(legacyRecords) });
  const records = Core.loadRecords(storage);
  assert.equal(records.length, 2, 'no record is lost');
  assert.equal(records[0].title, '写方案');
  assert.equal(records[0].expectedTaskMs, 25 * MIN);
  assert.equal(records[0].focusTotalMs, 15 * MIN);
  assert.equal(records[0].roundsTotal, 2);
  assert.ok(storage.map.has(Core.STORAGE_KEYS.records), 'migrated records persisted under v3 key');
  assert.ok(storage.map.has(Core.LEGACY_KEYS.records), 'legacy key untouched');
  assert.equal(Core.loadRecords(storage).length, 2);
});

test('migration: corrupt v3 records key still migrates legacy records', () => {
  const legacy = [
    {
      taskName: '旧任务',
      targetMs: 25 * MIN,
      totalFocusedMs: 10 * MIN,
      startedAt: NOW - 20 * MIN,
      endedAt: NOW,
      rounds: [10 * MIN],
    },
  ];
  const storage = fakeStorage({
    [Core.STORAGE_KEYS.records]: '{{{',
    [Core.LEGACY_KEYS.records]: JSON.stringify(legacy),
  });
  const records = Core.loadRecords(storage);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, '旧任务');
});

test('migration: v3 records win over legacy records', () => {
  const v3record = makeRecordFixture({ title: '新记录' });
  const storage = fakeStorage({
    [Core.STORAGE_KEYS.records]: JSON.stringify([v3record]),
    [Core.LEGACY_KEYS.records]: JSON.stringify([
      { taskName: '旧', totalFocusedMs: 1000, startedAt: NOW, endedAt: NOW },
    ]),
  });
  const records = Core.loadRecords(storage);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, '新记录');
});

test('settings: defaults, normalization and v2 migration', () => {
  const defaults = Core.defaultSettings();
  assert.deepEqual(defaults, {
    theme: 'dark',
    sound: true,
    defaultExpectedTaskMs: HOUR,
    defaultExpectedFocusMs: 25 * MIN,
  });

  assert.deepEqual(Core.loadSettings(fakeStorage()), defaults);

  const legacy = fakeStorage({
    [Core.LEGACY_KEYS.settings]: JSON.stringify({
      theme: 'light',
      sound: false,
      defaultTargetMs: 30 * MIN,
    }),
  });
  const migrated = Core.loadSettings(legacy);
  assert.equal(migrated.theme, 'light');
  assert.equal(migrated.sound, false);
  assert.equal(migrated.defaultExpectedFocusMs, 30 * MIN);
  assert.equal(migrated.defaultExpectedTaskMs, HOUR);
  assert.ok(legacy.map.has(Core.STORAGE_KEYS.settings), 'migrated settings persisted');

  const storage = fakeStorage();
  assert.equal(
    Core.saveSettings(storage, { theme: 'light', sound: false, defaultExpectedFocusMs: 45 * MIN }),
    true
  );
  const loaded = Core.loadSettings(storage);
  assert.equal(loaded.theme, 'light');
  assert.equal(loaded.sound, false);
  assert.equal(loaded.defaultExpectedFocusMs, 45 * MIN);
  assert.equal(loaded.defaultExpectedTaskMs, HOUR);

  const weird = Core.normalizeSettings({ theme: 'neon', sound: 'nope', defaultExpectedFocusMs: 0 });
  assert.equal(weird.theme, 'dark');
  assert.equal(weird.sound, true);
  assert.equal(weird.defaultExpectedFocusMs, MIN);
  assert.deepEqual(Core.normalizeSettings(null), defaults);
});

test('session storage: save / load / clear round-trip', () => {
  const storage = fakeStorage();
  const session = runningSession({ now: NOW, openMs: 5 * MIN });
  assert.equal(Core.saveSession(storage, session, NOW), true);
  assert.equal(storage.read(Core.STORAGE_KEYS.session).savedAt, NOW, 'savedAt stamped');

  const loaded = Core.loadSession(storage);
  assert.equal(loaded.phase, 'running');
  assert.equal(loaded.taskTitle, session.taskTitle);
  assert.equal(loaded.roundStartedAt, session.roundStartedAt);
  assert.equal(loaded.savedAt, NOW);

  assert.equal(Core.saveSession(storage, null, NOW), false);
  Core.clearSession(storage);
  assert.equal(storage.map.has(Core.STORAGE_KEYS.session), false);
  assert.equal(Core.loadSession(storage), null);
  assert.equal(Core.loadSession(brokenStorage()), null);
  assert.equal(Core.saveSession(brokenStorage(), session, NOW), false);
});

test('records storage: save / load round-trip with sanitization', () => {
  const storage = fakeStorage();
  const records = [
    makeRecordFixture({ endedAt: NOW, startedAt: NOW - HOUR }),
    makeRecordFixture({ endedAt: NOW - HOUR, startedAt: NOW - 2 * HOUR }),
  ];
  assert.equal(Core.saveRecords(storage, records), true);
  const loaded = Core.loadRecords(storage);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].endedAt, NOW);
  assert.equal(
    loaded[0].focusTotalMs,
    loaded[0].rounds.reduce((sum, round) => sum + round.actualMs, 0)
  );
  assert.equal(Core.saveRecords(fakeStorage(), null), true);
  assert.deepEqual(Core.loadRecords(fakeStorage()), []);
  assert.equal(Core.saveRecords(brokenStorage(), records), false);
  assert.deepEqual(Core.loadRecords(brokenStorage()), []);
});

/* ======================================================================== *
 * 10. end-to-end logic: v3 persistence across "refresh"
 * ======================================================================== */

test('integration: refresh recovery keeps rounds, then the record stays honest', () => {
  const storage = fakeStorage();
  const t0 = D(2026, 10, 24, 9, 0, 0);
  const task = makeTask({ title: '真实流程', expectedTaskMs: HOUR, expectedFocusMs: 25 * MIN, now: t0 });

  // round 1: 12 min, paused → persisted
  let session = Core.createSession({ task, expectedFocusMs: 20 * MIN, now: t0 });
  let step = Core.pauseSession(session, t0 + 12 * MIN);
  session = step.session;
  Core.saveSession(storage, session, t0 + 12 * MIN);

  // user "refreshes" while paused: nothing changes
  let reloaded = Core.restoreSession(Core.loadSession(storage), t0 + 30 * MIN);
  assert.equal(reloaded.phase, 'paused');
  assert.equal(reloaded.rounds.length, 1);
  assert.equal(reloaded.rounds[0].actualMs, 12 * MIN);

  // resume at +30, then the page is refreshed while running at +35
  session = Core.setNextExpectedFocusMs(reloaded, 15 * MIN);
  session = Core.resumeSession(session, t0 + 30 * MIN);
  Core.saveSession(storage, session, t0 + 35 * MIN); // last periodic save before unload
  reloaded = Core.restoreSession(Core.loadSession(storage), t0 + 40 * MIN);
  assert.equal(reloaded.phase, 'paused');
  assert.equal(reloaded.rounds.length, 2, 'the open round is closed on restore');
  assert.equal(reloaded.rounds[1].actualMs, 5 * MIN, 'savedAt - roundStartedAt');
  assert.equal(reloaded.rounds[1].expectedMs, 15 * MIN);

  // finish at +50 (wall clock keeps counting while paused)
  const record = Core.completeSession(reloaded, t0 + 50 * MIN);
  assert.equal(record.roundsTotal, 2);
  assert.equal(record.focusTotalMs, 17 * MIN);
  assert.equal(record.taskDurationMs, 50 * MIN);
  assert.equal(record.expectedTaskMs, HOUR);
  const metrics = Core.recordMetrics(record);
  assert.equal(metrics.avgFocusMs, 8.5 * MIN);
  assert.equal(metrics.expectedFocusAvgMs, 17.5 * MIN);
  assert.equal(metrics.taskDeltaMs, HOUR - 50 * MIN);

  // the persisted record can be summarised as today's activity
  const records = Core.addRecord(Core.loadRecords(storage), record);
  const summary = Core.summarize(records, t0 + 50 * MIN);
  assert.equal(summary.today.tasks, 1);
  assert.equal(summary.today.rounds, 2);
  assert.equal(summary.today.focusMs, 17 * MIN);
  assert.equal(summary.streak, 1);
});
