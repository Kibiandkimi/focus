/*
 * Focus — unit tests for the pure v2 logic in focus-core.js.
 * Run with:  node --test tests/core.test.js
 *
 * v2 semantics under test:
 *   - one target duration for the whole task (hint/statistic only, never stops anything)
 *   - time counts UP (actual focused time); reaching the target does not end a round/task
 *   - pause = end current round + count it, task stays alive
 *   - continue / next round = start a new round inside the same task
 *   - completion records actual time + target time + rounds
 *   - rounds shorter than MIN_ROUND_MS (1s) are not counted
 *   - v1 persisted data is migrated to v2 on restore
 *
 * No dependencies: Node built-in test runner + assert. Timestamps are built with
 * local-time Date constructors so the suite is timezone-independent.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Core = require(path.join(__dirname, '..', 'focus-core.js'));

/* ------------------------------------------------------------------------- */
/* helpers                                                                   */
/* ------------------------------------------------------------------------- */

const MIN = 60 * 1000;
const SEC = 1000;

function D(year, month, day, hour = 10, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime();
}

function makeRecord(overrides) {
  const base = {
    v: 2,
    id: 'r_1',
    taskName: '写方案',
    targetMs: 25 * MIN,
    totalFocusedMs: 15 * MIN,
    roundsTotal: 2,
    roundsCompleted: 2,
    rounds: [10 * MIN, 5 * MIN],
    targetReached: false,
    startedAt: D(2026, 10, 24, 9, 0),
    endedAt: D(2026, 10, 24, 9, 15),
    dateKey: '2026-10-24',
  };
  return Object.assign(base, overrides || {});
}

function fakeStorage(entries) {
  const map = new Map(Object.entries(entries || {}));
  return {
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
  };
}

function brokenStorage() {
  const boom = () => {
    throw new Error('storage denied');
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

/**
 * Build a running session whose open round has been running for `openMs`
 * at wall-clock time `at`. `rounds` are already finished rounds (ms numbers).
 */
function runningSession(options) {
  const opts = options || {};
  const at = opts.at === undefined ? D(2026, 10, 24, 10, 0) : opts.at;
  const openMs = opts.openMs === undefined ? 0 : opts.openMs;
  const base = Core.createSession({
    taskName: opts.taskName || '任务',
    targetMs: opts.targetMs === undefined ? 25 * MIN : opts.targetMs,
    now: at - openMs,
  });
  return {
    ...base,
    rounds: (opts.rounds || []).map((ms) => ({ focusedMs: ms })),
    roundElapsedMs: 0,
    roundStartedAt: at - openMs,
  };
}

/* ------------------------------------------------------------------------- */
/* constants / formatting                                                    */
/* ------------------------------------------------------------------------- */

test('constants: v2 version, MIN_ROUND_MS and storage keys', () => {
  assert.equal(Core.VERSION, 2);
  assert.equal(Core.MIN_ROUND_MS, 1000);
  assert.equal(Core.MIN_MINUTES, 1);
  assert.equal(Core.MAX_MINUTES, 480);
  assert.equal(Core.DEFAULT_TARGET_MS, 25 * MIN);
  assert.equal(Core.MAX_RECORDS, 500);
  assert.deepEqual(Core.STORAGE_KEYS, {
    session: 'focus.session.v1',
    records: 'focus.records.v1',
    settings: 'focus.settings.v1',
  });
  assert.equal(Core.WEEKDAYS.length, 7);
});

test('old v1 state-machine API is gone (sanity for the rewrite)', () => {
  assert.equal(Core.tickSession, undefined);
  assert.equal(Core.getElapsed, undefined);
  assert.equal(Core.getRemaining, undefined);
  assert.equal(Core.countCompletedRounds, undefined);
  assert.equal(Core.getSessionFocusedMs, undefined);
});

test('formatElapsed: stopwatch formatting rounds down', () => {
  const cases = [
    [0, '00:00'],
    [999, '00:00'],
    [1000, '00:01'],
    [1999, '00:01'],
    [59999, '00:59'],
    [60000, '01:00'],
    [900000, '15:00'],
    [3599999, '59:59'],
    [3600000, '1:00:00'],
    [3661000, '1:01:01'],
    [8 * 3600000, '8:00:00'],
  ];
  cases.forEach(([ms, expected]) => {
    assert.equal(Core.formatElapsed(ms), expected, `formatElapsed(${ms})`);
  });
  assert.equal(Core.formatElapsed(-1000), '00:00');
  assert.equal(Core.formatElapsed(undefined), '00:00');
  assert.equal(Core.formatElapsed(NaN), '00:00');
});

test('formatClock: countdown/overtime formatting rounds up', () => {
  assert.equal(Core.formatClock(0), '00:00');
  assert.equal(Core.formatClock(1), '00:01');
  assert.equal(Core.formatClock(999), '00:01');
  assert.equal(Core.formatClock(1000), '00:01');
  assert.equal(Core.formatClock(1499), '00:02');
  assert.equal(Core.formatClock(60000), '01:00');
  assert.equal(Core.formatClock(3600000), '1:00:00');
  assert.equal(Core.formatClock(-5000), '00:00');
  assert.equal(Core.formatClock(undefined), '00:00');
});

test('formatSpan / minutesLabel / time helpers', () => {
  assert.equal(Core.formatSpan(0), '0 分钟');
  assert.equal(Core.formatSpan(29999), '不足 1 分钟');
  assert.equal(Core.formatSpan(30000), '1 分钟');
  assert.equal(Core.formatSpan(45 * MIN), '45 分钟');
  assert.equal(Core.formatSpan(65 * MIN), '1 小时 5 分钟');
  assert.equal(Core.formatSpan(120 * MIN), '2 小时');
  assert.equal(Core.minutesLabel(0), '0');
  assert.equal(Core.minutesLabel(20000), '<1');
  assert.equal(Core.minutesLabel(MIN), '1');
  assert.equal(Core.minutesLabel(90 * MIN), '90');
  assert.equal(Core.formatTimeOfDay(D(2026, 1, 5, 9, 7)), '09:07');
  assert.equal(Core.dateKey(D(2026, 12, 31, 23, 59)), '2026-12-31');
  assert.equal(Core.parseDateKey('2026-10-24').getDate(), 24);
  assert.equal(Core.parseDateKey('2026-1-5'), null);
  const now = D(2026, 10, 24, 10, 0);
  assert.equal(Core.formatDayLabel('2026-10-24', now), '今天');
  assert.equal(Core.formatDayLabel('2026-10-23', now), '昨天');
  assert.equal(Core.formatDayLabel('2026-10-20', now), '10月20日');
  assert.equal(Core.formatDayLabel('2025-12-31', now), '2025年12月31日');
});

test('clampTargetMs: 1–480 minute bounds', () => {
  assert.equal(Core.clampTargetMs(0), MIN);
  assert.equal(Core.clampTargetMs(-1000), MIN);
  assert.equal(Core.clampTargetMs(MIN), MIN);
  assert.equal(Core.clampTargetMs(25 * MIN), 25 * MIN);
  assert.equal(Core.clampTargetMs(480 * MIN), 480 * MIN);
  assert.equal(Core.clampTargetMs(481 * MIN), 480 * MIN);
  assert.equal(Core.clampTargetMs(1000 * MIN), 480 * MIN);
  assert.equal(Core.clampTargetMs(undefined), Core.DEFAULT_TARGET_MS);
  assert.equal(Core.clampTargetMs(NaN), Core.DEFAULT_TARGET_MS);
  assert.equal(Core.clampTargetMs('1500000'), 25 * MIN);
  assert.equal(Core.clampTargetMs(null), MIN);
});

/* ------------------------------------------------------------------------- */
/* session creation / clocks                                                 */
/* ------------------------------------------------------------------------- */

test('createSession: v2 shape, no per-round target, clamped target', () => {
  const now = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ now: now });

  assert.equal(session.v, 2);
  assert.match(session.id, /^s_/);
  assert.equal(session.taskName, '专注');
  assert.equal(session.targetMs, 25 * MIN);
  assert.equal(session.startedAt, now);
  assert.deepEqual(session.rounds, []);
  assert.equal(session.phase, 'running');
  assert.equal(session.roundElapsedMs, 0);
  assert.equal(session.roundStartedAt, now);
  assert.equal(session.savedAt, now);
  assert.equal(session.restored, false);
  assert.equal(session.roundIndex, undefined, 'v2 不再有 roundIndex');
  assert.equal(
    session.rounds.some((round) => round.targetMs),
    false,
    '轮次不再携带 per-round target'
  );

  assert.equal(Core.createSession({ taskName: '  写   提案  ', now }).taskName, '写 提案');
  assert.equal(Core.createSession({ taskName: '  ', now }).taskName, '专注');
  assert.equal(Core.createSession({ taskName: 'x'.repeat(80), now }).taskName.length, 60);
  assert.equal(Core.createSession({ targetMs: 45 * MIN, now }).targetMs, 45 * MIN);
  assert.equal(Core.createSession({ targetMs: 0, now }).targetMs, MIN);
  assert.equal(Core.createSession({ targetMs: 999 * MIN, now }).targetMs, 480 * MIN);
});

test('getRoundElapsedMs: only the open round counts, stopped when paused', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ targetMs: 25 * MIN, now: start });

  assert.equal(Core.getRoundElapsedMs(session, start + 5 * MIN), 5 * MIN);
  assert.equal(Core.getRoundElapsedMs(session, start - MIN), 0, '时钟回拨不产生负时长');
  assert.equal(Core.getRoundElapsedMs(null, start), 0);

  const paused = Core.pauseSession(session, start + 5 * MIN).session;
  assert.equal(Core.getRoundElapsedMs(paused, start + 60 * MIN), 0, '暂停后没有正在进行的轮次');

  const resumed = Core.resumeSession(paused, start + 60 * MIN);
  assert.equal(Core.getRoundElapsedMs(resumed, start + 62 * MIN), 2 * MIN);
});

test('getTotalFocusedMs: finished rounds + current round, never negative', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = runningSession({ at: start, rounds: [5 * MIN, 3 * MIN], openMs: 2 * MIN });

  assert.equal(Core.getTotalFocusedMs(session, start), 10 * MIN);
  assert.equal(Core.getTotalFocusedMs(session, start + 3 * MIN), 13 * MIN);

  const paused = Core.pauseSession(session, start).session;
  assert.equal(paused.rounds.length, 3, '暂停把当前 2 分钟收口成轮次');
  assert.equal(Core.getTotalFocusedMs(paused, start + 99 * MIN), 10 * MIN, '暂停后不再增长');

  assert.equal(Core.getTotalFocusedMs(null, start), 0);

  const backdated = { ...session, roundStartedAt: start + 10 * MIN };
  assert.equal(Core.getTotalFocusedMs(backdated, start), 8 * MIN, '时钟回拨不会减少已完成轮次');
});

test('getCompletedRounds / getCurrentRoundNumber', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = runningSession({ at: start, rounds: [MIN, MIN] });
  assert.equal(Core.getCompletedRounds(session), 2);
  assert.equal(Core.getCurrentRoundNumber(session), 3, '运行中：已完成轮次 + 1');
  assert.equal(Core.getCompletedRounds(null), 0);

  const paused = Core.pauseSession(session, start).session;
  assert.equal(Core.getCompletedRounds(paused), 2);
  assert.equal(Core.getCurrentRoundNumber(paused), 2, '暂停态：已完成轮次');

  const zero = Core.createSession({ targetMs: 25 * MIN, now: start });
  const zeroPaused = Core.pauseSession(zero, start + 500).session;
  assert.equal(Core.getCurrentRoundNumber(zeroPaused), 0, '不足 1 秒的轮次不计数');
});

test('target maths: remaining / overtime / progress / isTargetReached', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = runningSession({ at: start, targetMs: 10 * MIN, openMs: 4 * MIN });

  assert.equal(Core.getTargetRemainingMs(session, start), 6 * MIN);
  assert.equal(Core.getOvertimeMs(session, start), 0);
  assert.equal(Core.getProgress(session, start), 0.4);
  assert.equal(Core.isTargetReached(session, start), false);

  assert.equal(Core.getTargetRemainingMs(session, start + 7 * MIN), 0);
  assert.equal(Core.getOvertimeMs(session, start + 7 * MIN), MIN);
  assert.equal(Core.getProgress(session, start + 7 * MIN), 1, '进度夹紧到 100%');
  assert.equal(Core.isTargetReached(session, start + 7 * MIN), true);

  const exact = start + 6 * MIN;
  assert.equal(Core.getTargetRemainingMs(session, exact), 0);
  assert.equal(Core.getOvertimeMs(session, exact), 0);
  assert.equal(Core.isTargetReached(session, exact), true);

  assert.equal(Core.getTargetRemainingMs(null, start), 0);
  assert.equal(Core.getOvertimeMs(null, start), 0);
  assert.equal(Core.getProgress(null, start), 0);
  assert.equal(Core.getProgress({ targetMs: 0 }, start), 0);
  assert.equal(Core.isTargetReached(null, start), false);
});

/* ------------------------------------------------------------------------- */
/* pause / resume / next round                                               */
/* ------------------------------------------------------------------------- */

test('pauseSession: ends current round, counts it, task stays alive', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ targetMs: 25 * MIN, now: start });

  const result = Core.pauseSession(session, start + 5 * MIN);
  assert.equal(result.roundEnded, true);
  assert.equal(result.roundMs, 5 * MIN);
  assert.equal(result.session.phase, 'paused');
  assert.deepEqual(result.session.rounds, [{ focusedMs: 5 * MIN }]);
  assert.equal(result.session.roundElapsedMs, 0);
  assert.equal(result.session.roundStartedAt, null);
  assert.equal(Core.getTotalFocusedMs(result.session, start + 60 * MIN), 5 * MIN);
  assert.equal(Core.getRoundElapsedMs(result.session, start + 60 * MIN), 0);

  // 暂停中的会话再暂停：无副作用
  const again = Core.pauseSession(result.session, start + 9 * MIN);
  assert.equal(again.roundEnded, false);
  assert.equal(again.session.phase, 'paused');
  assert.equal(again.session.rounds.length, 1);

  // null / 非 running
  assert.deepEqual(Core.pauseSession(null, start), { session: null, roundEnded: false, roundMs: 0 });
});

test('pauseSession: MIN_ROUND_MS boundary (0–999ms not counted, >=1000ms counted)', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ targetMs: 25 * MIN, now: start });

  assert.equal(Core.pauseSession(session, start + 0).roundEnded, false);
  assert.equal(Core.pauseSession(session, start + 999).roundEnded, false);
  assert.equal(Core.pauseSession(session, start + 999).session.rounds.length, 0);

  const boundary = Core.pauseSession(session, start + 1000);
  assert.equal(boundary.roundEnded, true);
  assert.equal(boundary.roundMs, 1000);
  assert.deepEqual(boundary.session.rounds, [{ focusedMs: 1000 }]);
  assert.equal(boundary.session.phase, 'paused');
});

test('resumeSession: paused -> running, starts a new round, totals preserved', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ targetMs: 25 * MIN, now: start });
  const paused = Core.pauseSession(session, start + 5 * MIN).session;

  const resumed = Core.resumeSession(paused, start + 10 * MIN);
  assert.equal(resumed.phase, 'running');
  assert.equal(resumed.roundStartedAt, start + 10 * MIN);
  assert.equal(resumed.roundElapsedMs, 0);
  assert.equal(resumed.rounds.length, 1, '已完成的轮次保留');
  assert.equal(Core.getTotalFocusedMs(resumed, start + 10 * MIN), 5 * MIN);
  assert.equal(Core.getTotalFocusedMs(resumed, start + 12 * MIN), 7 * MIN);
  assert.equal(Core.getCurrentRoundNumber(resumed), 2);

  const running = Core.resumeSession(resumed, start + 20 * MIN);
  assert.equal(running, resumed, '运行中 resume 是 no-op');
  assert.equal(Core.resumeSession(null, start), null);
});

test('startNextRound: end current round + immediately start the next one', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ targetMs: 25 * MIN, now: start });

  const next = Core.startNextRound(session, start + 10 * MIN);
  assert.equal(next.roundEnded, true);
  assert.equal(next.roundMs, 10 * MIN);
  assert.equal(next.session.phase, 'running');
  assert.equal(next.session.rounds.length, 1);
  assert.equal(next.session.rounds[0].focusedMs, 10 * MIN);
  assert.equal(next.session.roundElapsedMs, 0);
  assert.equal(next.session.roundStartedAt, start + 10 * MIN);
  assert.equal(Core.getTotalFocusedMs(next.session, start + 10 * MIN), 10 * MIN);
  assert.equal(Core.getCurrentRoundNumber(next.session), 2);

  // <1s：不产生轮次，重新开始当前轮
  const quick = Core.startNextRound(session, start + 300);
  assert.equal(quick.roundEnded, false);
  assert.equal(quick.session.rounds.length, 0);
  assert.equal(quick.session.phase, 'running');
  assert.equal(Core.getCurrentRoundNumber(quick.session), 1);

  // 暂停中「下一轮」：直接开始新一轮，不重复计轮
  const paused = Core.pauseSession(session, start + 5 * MIN).session;
  const fromPaused = Core.startNextRound(paused, start + 6 * MIN);
  assert.equal(fromPaused.roundEnded, false);
  assert.equal(fromPaused.session.rounds.length, 1, '暂停时当前轮已计入，不再重复');
  assert.equal(fromPaused.session.phase, 'running');
  assert.equal(fromPaused.session.roundStartedAt, start + 6 * MIN);
  assert.equal(Core.getTotalFocusedMs(fromPaused.session, start + 6 * MIN), 5 * MIN);

  assert.deepEqual(Core.startNextRound(null, start), { session: null, roundEnded: false, roundMs: 0 });
});

/* ------------------------------------------------------------------------- */
/* completion / records                                                      */
/* ------------------------------------------------------------------------- */

test('completeSession: running task includes the open round (actual + target)', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ taskName: '写提案', targetMs: 25 * MIN, now: start });

  const record = Core.completeSession(session, start + 10 * MIN);
  assert.ok(record);
  assert.equal(record.v, 2);
  assert.match(record.id, /^r_/);
  assert.equal(record.taskName, '写提案');
  assert.equal(record.targetMs, 25 * MIN);
  assert.equal(record.totalFocusedMs, 10 * MIN);
  assert.equal(record.roundsTotal, 1);
  assert.equal(record.roundsCompleted, 1);
  assert.deepEqual(record.rounds, [10 * MIN]);
  assert.equal(record.targetReached, false);
  assert.equal(record.startedAt, start);
  assert.equal(record.endedAt, start + 10 * MIN);
  assert.equal(record.dateKey, '2026-10-24');
});

test('completeSession: paused task, multi-round totals, targetReached', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ taskName: '多轮', targetMs: 20 * MIN, now: start });

  const paused = Core.pauseSession(session, start + 12 * MIN).session;
  const resumed = Core.resumeSession(paused, start + 20 * MIN);
  const record = Core.completeSession(resumed, start + 30 * MIN);

  assert.ok(record);
  assert.equal(record.roundsTotal, 2);
  assert.equal(record.roundsCompleted, 2);
  assert.deepEqual(record.rounds, [12 * MIN, 10 * MIN]);
  assert.equal(record.totalFocusedMs, 22 * MIN);
  assert.equal(record.targetReached, true, '实际 22 分钟 >= 目标 20 分钟');
  assert.equal(record.targetMs, 20 * MIN);

  // 暂停中直接完成：轮次已计入
  const recordFromPaused = Core.completeSession(paused, start + 40 * MIN);
  assert.equal(recordFromPaused.roundsTotal, 1);
  assert.equal(recordFromPaused.totalFocusedMs, 12 * MIN);
  assert.equal(recordFromPaused.roundsCompleted, 1);
});

test('completeSession: nothing focused -> null (0 / sub-second)', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ targetMs: 25 * MIN, now: start });

  assert.equal(Core.completeSession(session, start), null);
  assert.equal(Core.completeSession(session, start + 999), null);
  assert.ok(Core.completeSession(session, start + 1000), '满 1 秒即可生成记录');

  const pausedEmpty = Core.pauseSession(session, start + 500).session;
  assert.equal(pausedEmpty.rounds.length, 0);
  assert.equal(Core.completeSession(pausedEmpty, start + 60 * MIN), null);
  assert.equal(Core.completeSession(null, start), null);
});

test('completeSession: over-target task records both actual and target', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ taskName: '超时', targetMs: 5 * MIN, now: start });
  const record = Core.completeSession(session, start + 8 * MIN);
  assert.equal(record.targetMs, 5 * MIN);
  assert.equal(record.totalFocusedMs, 8 * MIN);
  assert.equal(record.targetReached, true);
});

test('completeSession: record dateKey is the ending day (cross-midnight task)', () => {
  const start = D(2026, 10, 23, 23, 50);
  const session = Core.createSession({ targetMs: 25 * MIN, now: start });
  const record = Core.completeSession(session, D(2026, 10, 24, 0, 20));
  assert.equal(record.dateKey, '2026-10-24');
  assert.equal(record.startedAt, start);
});

/* ------------------------------------------------------------------------- */
/* restore + v1 -> v2 migration                                              */
/* ------------------------------------------------------------------------- */

test('restoreSession: running -> paused, open round closed at last saved time', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ targetMs: 25 * MIN, now: start });

  const restored = Core.restoreSession({ ...session, savedAt: start + 5 * MIN }, start + 60 * MIN);
  assert.equal(restored.phase, 'paused');
  assert.equal(restored.restored, true);
  assert.equal(restored.rounds.length, 1);
  assert.equal(restored.rounds[0].focusedMs, 5 * MIN, '使用 savedAt 关闭轮次，而不是 now');
  assert.equal(restored.roundElapsedMs, 0);
  assert.equal(restored.roundStartedAt, null);
  assert.equal(Core.getTotalFocusedMs(restored, start + 60 * MIN), 5 * MIN);

  // 上次保存时当前轮还不足 1 秒 -> 不产生轮次
  const shortRound = Core.restoreSession({ ...session, savedAt: start + 500 }, start + 60 * MIN);
  assert.equal(shortRound.phase, 'paused');
  assert.equal(shortRound.rounds.length, 0);
  assert.equal(Core.getTotalFocusedMs(shortRound, start + 60 * MIN), 0);

  assert.equal(Core.restoreSession(null, start), null);
  assert.equal(Core.restoreSession('bogus', start), null);
  assert.equal(Core.restoreSession([], start), null);
});

test('restoreSession: paused session keeps its rounds untouched', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ targetMs: 25 * MIN, now: start });
  const paused = Core.pauseSession(session, start + 7 * MIN).session;

  const restored = Core.restoreSession(paused, start + 99 * MIN);
  assert.equal(restored.phase, 'paused');
  assert.equal(restored.rounds.length, 1);
  assert.equal(restored.rounds[0].focusedMs, 7 * MIN);
  assert.equal(Core.getTotalFocusedMs(restored, start + 99 * MIN), 7 * MIN);
});

test('normalizeSession: v1 running session is migrated to v2', () => {
  const start = D(2026, 10, 24, 10, 0);
  const v1 = {
    v: 1,
    id: 's_v1',
    taskName: '旧会话',
    targetMs: 45 * MIN,
    startedAt: start,
    rounds: [
      { focusedMs: 25 * MIN, targetMs: 45 * MIN, completed: false },
      { focusedMs: 45 * MIN, targetMs: 45 * MIN, completed: true },
      'garbage',
    ],
    roundIndex: 3,
    phase: 'running',
    roundElapsedMs: 0,
    roundStartedAt: start + 70 * MIN,
    savedAt: start + 72 * MIN,
  };

  const session = Core.normalizeSession(v1);
  assert.equal(session.v, 2);
  assert.equal(session.phase, 'running');
  assert.equal(session.targetMs, 45 * MIN);
  assert.deepEqual(session.rounds, [{ focusedMs: 25 * MIN }, { focusedMs: 45 * MIN }]);
  assert.equal(session.roundIndex, undefined);
  assert.equal(session.roundStartedAt, start + 70 * MIN);
  assert.equal(Core.getCurrentRoundNumber(session), 3);

  // restore 时把 open round 收口
  const restored = Core.restoreSession(v1, start + 100 * MIN);
  assert.equal(restored.phase, 'paused');
  assert.equal(restored.rounds.length, 3);
  assert.equal(restored.rounds[2].focusedMs, 2 * MIN, 'savedAt - roundStartedAt = 2 分钟');
});

test('normalizeSession: v1 paused / roundComplete phases migrate safely', () => {
  const start = D(2026, 10, 24, 10, 0);

  // v1 paused 且带未收口的 roundElapsedMs -> 迁移成一条轮次
  const v1Paused = {
    v: 1,
    taskName: '旧暂停',
    targetMs: 30 * MIN,
    startedAt: start,
    rounds: [{ focusedMs: 10 * MIN, targetMs: 30 * MIN, completed: false }],
    phase: 'paused',
    roundElapsedMs: 5 * MIN,
    savedAt: start + 20 * MIN,
  };
  const paused = Core.normalizeSession(v1Paused);
  assert.equal(paused.phase, 'paused');
  assert.deepEqual(paused.rounds, [{ focusedMs: 10 * MIN }, { focusedMs: 5 * MIN }]);
  assert.equal(paused.roundElapsedMs, 0);
  assert.equal(Core.getTotalFocusedMs(paused, start + 99 * MIN), 15 * MIN);

  // 不足 1 秒的残留不计
  const tiny = Core.normalizeSession({ ...v1Paused, roundElapsedMs: 500 });
  assert.equal(tiny.rounds.length, 1);

  // v1 roundComplete -> paused，轮次已存在，不重复
  const v1Complete = {
    v: 1,
    taskName: '旧完成',
    targetMs: 25 * MIN,
    startedAt: start,
    rounds: [{ focusedMs: 25 * MIN, targetMs: 25 * MIN, completed: true }],
    phase: 'roundComplete',
    roundElapsedMs: 25 * MIN,
    savedAt: start + 30 * MIN,
  };
  const complete = Core.normalizeSession(v1Complete);
  assert.equal(complete.phase, 'paused');
  assert.equal(complete.rounds.length, 1);
  assert.equal(complete.roundElapsedMs, 0);
  assert.equal(Core.getTotalFocusedMs(complete, start + 99 * MIN), 25 * MIN);
  assert.equal(Core.isTargetReached(complete, start + 99 * MIN), true);
});

test('normalizeSession: defensive parsing', () => {
  assert.equal(Core.normalizeSession(null), null);
  assert.equal(Core.normalizeSession('x'), null);
  assert.equal(Core.normalizeSession([]), null, '数组不是会话');
  assert.equal(Core.normalizeSession(42), null);

  const weird = Core.normalizeSession({
    phase: 'exploded',
    targetMs: 'bad',
    roundElapsedMs: 5000,
    roundStartedAt: D(2026, 10, 24, 10, 0),
  });
  assert.equal(weird.phase, 'paused');
  assert.equal(weird.targetMs, Core.DEFAULT_TARGET_MS);
  assert.equal(weird.taskName, '专注');
  assert.deepEqual(weird.rounds, [{ focusedMs: 5000 }], '未知 phase 的残留时长按轮次迁移');
  assert.equal(weird.roundElapsedMs, 0);
  assert.equal(weird.roundStartedAt, null);
  assert.match(weird.id, /^s_/);

  const running = Core.normalizeSession({
    phase: 'running',
    roundElapsedMs: 2000,
    roundStartedAt: 123,
    targetMs: 10 * MIN,
  });
  assert.equal(running.phase, 'running');
  assert.equal(running.roundElapsedMs, 2000);
  assert.equal(running.roundStartedAt, 123);

  const paused = Core.normalizeSession({ phase: 'paused', roundStartedAt: 123 });
  assert.equal(paused.roundStartedAt, null, '非 running 不保留 roundStartedAt');
});

test('round normalisation (via normalizeSession/normalizeRecord): numbers and v1/v2 objects', () => {
  // normalizeRound 是内部函数，这里通过对外 API 验证轮次清洗
  const session = Core.normalizeSession({
    phase: 'paused',
    targetMs: 25 * MIN,
    rounds: [
      1500,
      { focusedMs: 2000 },
      { focusedMs: 3000, targetMs: 999, completed: true },
      { focusedMs: 0 },
      { focusedMs: -1 },
      { focusedMs: 'x' },
      null,
      'x',
      { targetMs: 5000 },
    ],
  });
  assert.deepEqual(
    session.rounds,
    [{ focusedMs: 1500 }, { focusedMs: 2000 }, { focusedMs: 3000 }],
    '数字与对象轮次都被规范化为 { focusedMs }，v1 字段与非法对象被丢弃'
  );

  // 已知健壮性观察（P3，非阻塞）：session.rounds 里的「数字」轮次若为 0/负数，
  // 会被 makeRound 夹成 0 而不是丢弃（正常应用流程只会写 { focusedMs: >0 } 对象）。
  const numericZero = Core.normalizeSession({ phase: 'paused', rounds: [0, -5, 1500] });
  assert.deepEqual(numericZero.rounds, [{ focusedMs: 0 }, { focusedMs: 0 }, { focusedMs: 1500 }]);
  assert.equal(Core.getCompletedRounds(numericZero), 3, '零轮会被计入轮数（仅数据被写坏时可见）');

  const record = Core.normalizeRecord({
    taskName: 'x',
    startedAt: 1,
    endedAt: 2,
    totalFocusedMs: 6500,
    roundsTotal: 3,
    rounds: [1500, { focusedMs: 2000 }, { focusedMs: 3000, targetMs: 1, completed: true }],
  });
  assert.deepEqual(record.rounds, [1500, 2000, 3000], '记录内轮次规范化为毫秒数字');
});

/* ------------------------------------------------------------------------- */
/* records: normalisation / storage / grouping / statistics                  */
/* ------------------------------------------------------------------------- */

test('normalizeRecord: v2 record with actual + target + rounds', () => {
  const record = Core.normalizeRecord(
    makeRecord({ id: 'r_9', rounds: [{ focusedMs: 10 * MIN }, { focusedMs: 5 * MIN }], totalFocusedMs: 15 * MIN })
  );
  assert.equal(record.v, 2);
  assert.equal(record.id, 'r_9');
  assert.equal(record.taskName, '写方案');
  assert.equal(record.targetMs, 25 * MIN);
  assert.equal(record.totalFocusedMs, 15 * MIN);
  assert.equal(record.roundsTotal, 2);
  assert.equal(record.roundsCompleted, 2);
  assert.deepEqual(record.rounds, [10 * MIN, 5 * MIN]);
  assert.equal(record.targetReached, false);
  assert.equal(record.dateKey, '2026-10-24');

  const reached = Core.normalizeRecord(
    makeRecord({ totalFocusedMs: 30 * MIN, rounds: [30 * MIN], targetReached: undefined })
  );
  assert.equal(reached.targetReached, true, '缺少 targetReached 时由实际>=目标推导');
  const explicit = Core.normalizeRecord(makeRecord({ totalFocusedMs: 30 * MIN, targetReached: false }));
  assert.equal(explicit.targetReached, false, '显式 targetReached 优先');

  // 未提供 rounds 数组的 v1 记录
  const v1Record = Core.normalizeRecord({
    v: 1,
    taskName: '旧记录',
    targetMs: 30 * MIN,
    totalFocusedMs: 15 * MIN,
    roundsCompleted: 2,
    roundsTotal: 3,
    startedAt: D(2026, 10, 24, 9, 0),
    endedAt: D(2026, 10, 24, 9, 30),
  });
  assert.equal(v1Record.roundsTotal, 3);
  assert.equal(v1Record.roundsCompleted, 2);
  assert.deepEqual(v1Record.rounds, []);
  assert.equal(v1Record.dateKey, '2026-10-24');
  assert.equal(v1Record.targetReached, false);

  // roundsCompleted 不能超过 roundsTotal
  const clamped = Core.normalizeRecord(makeRecord({ roundsCompleted: 9, roundsTotal: 2 }));
  assert.equal(clamped.roundsCompleted, 2);

  // 非法记录
  assert.equal(Core.normalizeRecord({}), null);
  assert.equal(Core.normalizeRecord({ taskName: 'x' }), null);
  assert.equal(
    Core.normalizeRecord({ taskName: 'x', startedAt: 1, endedAt: 2, totalFocusedMs: 0 }),
    null
  );
  assert.equal(
    Core.normalizeRecord({ taskName: '  ', startedAt: 1, endedAt: 2, totalFocusedMs: 1000 }),
    null
  );
});

test('sanitizeRecords / addRecord / removeRecord', () => {
  assert.deepEqual(Core.sanitizeRecords(null), []);
  assert.deepEqual(Core.sanitizeRecords('nope'), []);
  assert.deepEqual(Core.sanitizeRecords([null, 'x', 42]), []);

  const older = makeRecord({ id: 'a', endedAt: D(2026, 10, 22, 10, 0) });
  const newer = makeRecord({ id: 'b', endedAt: D(2026, 10, 24, 10, 0) });
  const middle = makeRecord({ id: 'c', endedAt: D(2026, 10, 23, 10, 0) });
  assert.deepEqual(Core.sanitizeRecords([older, newer, null, middle]).map((r) => r.id), ['b', 'c', 'a']);

  const many = [];
  for (let i = 0; i < 520; i += 1) {
    many.push(makeRecord({ id: 'r' + i, endedAt: D(2026, 10, 24, 10, 0) + i * 1000 }));
  }
  const capped = Core.sanitizeRecords(many);
  assert.equal(capped.length, 500);
  assert.equal(capped[0].id, 'r519');

  const base = [
    makeRecord({ id: 'a', endedAt: D(2026, 10, 22, 10, 0) }),
    makeRecord({ id: 'b', endedAt: D(2026, 10, 24, 10, 0) }),
  ];
  const added = Core.addRecord(base, makeRecord({ id: 'c', endedAt: D(2026, 10, 23, 10, 0) }));
  assert.deepEqual(added.map((r) => r.id), ['b', 'c', 'a']);
  assert.equal(base.length, 2, '不修改传入数组');
  assert.deepEqual(Core.addRecord([], null), []);
  assert.deepEqual(Core.removeRecord(base, 'a').map((r) => r.id), ['b']);
  assert.deepEqual(Core.removeRecord(null, 'a'), []);
});

test('groupRecords: date grouping preserves order', () => {
  assert.deepEqual(Core.groupRecords([]), []);
  const records = [
    makeRecord({ id: '1', dateKey: '2026-10-24', endedAt: D(2026, 10, 24, 12, 0) }),
    makeRecord({ id: '2', dateKey: '2026-10-24', endedAt: D(2026, 10, 24, 10, 0) }),
    makeRecord({ id: '3', dateKey: '2026-10-23', endedAt: D(2026, 10, 23, 18, 0) }),
  ];
  const groups = Core.groupRecords(records);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].records.map((r) => r.id), ['1', '2']);
  assert.equal(groups[1].key, '2026-10-23');
});

test('summarize: actual minutes, all rounds, streak and last 7 days', () => {
  const now = D(2026, 10, 24, 12, 0);
  const empty = Core.summarize([], now);
  assert.equal(empty.todayMs, 0);
  assert.equal(empty.todayRounds, 0);
  assert.equal(empty.todaySessions, 0);
  assert.equal(empty.totalRounds, 0);
  assert.equal(empty.streak, 0);
  assert.equal(empty.last7.length, 7);
  assert.equal(empty.last7[6].isToday, true);

  const records = [
    makeRecord({ id: 't1', dateKey: '2026-10-24', totalFocusedMs: 25 * MIN, roundsTotal: 2, endedAt: D(2026, 10, 24, 9, 0) }),
    makeRecord({ id: 't2', dateKey: '2026-10-24', totalFocusedMs: 35 * MIN, roundsTotal: 3, endedAt: D(2026, 10, 24, 11, 0) }),
    makeRecord({ id: 'y1', dateKey: '2026-10-23', totalFocusedMs: 45 * MIN, roundsTotal: 1, endedAt: D(2026, 10, 23, 9, 0) }),
    makeRecord({ id: 'y2', dateKey: '2026-10-22', totalFocusedMs: 20 * MIN, roundsTotal: 2, endedAt: D(2026, 10, 22, 9, 0) }),
    makeRecord({ id: 'old', dateKey: '2026-10-10', totalFocusedMs: 60 * MIN, roundsTotal: 4, endedAt: D(2026, 10, 10, 9, 0) }),
  ];
  const summary = Core.summarize(records, now);
  assert.equal(summary.todayMs, 60 * MIN);
  assert.equal(summary.todayRounds, 5, '今日轮次为当日记录 roundsTotal 之和');
  assert.equal(summary.todaySessions, 2);
  assert.equal(summary.totalMs, 185 * MIN);
  assert.equal(summary.totalRounds, 12);
  assert.equal(summary.totalSessions, 5);
  assert.equal(summary.streak, 3);
  assert.equal(summary.last7[6].ms, 60 * MIN);
  assert.equal(summary.last7[5].ms, 45 * MIN);
  assert.equal(summary.last7[4].ms, 20 * MIN);
  assert.equal(summary.last7.reduce((sum, day) => sum + day.ms, 0), 125 * MIN);

  const gap = Core.summarize(
    [
      makeRecord({ id: 'a', dateKey: '2026-10-24', endedAt: D(2026, 10, 24, 9, 0) }),
      makeRecord({ id: 'b', dateKey: '2026-10-22', endedAt: D(2026, 10, 22, 9, 0) }),
    ],
    now
  );
  assert.equal(gap.streak, 1);

  const fallback = Core.summarize(
    [makeRecord({ id: 'f', dateKey: undefined, endedAt: D(2026, 10, 24, 8, 0), totalFocusedMs: 10 * MIN })],
    now
  );
  assert.equal(fallback.todayMs, 10 * MIN);
  assert.equal(fallback.last7[6].ms, 10 * MIN);
});

test('storage: session / records / settings round trips and safe failures', () => {
  const store = fakeStorage();
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ taskName: '测试', targetMs: 15 * MIN, now: start });

  assert.equal(Core.saveSession(store, session, start + MIN), true);
  const loaded = Core.loadSession(store);
  assert.equal(loaded.v, 2);
  assert.equal(loaded.taskName, '测试');
  assert.equal(loaded.phase, 'running');
  assert.equal(JSON.parse(store.getItem(Core.STORAGE_KEYS.session)).savedAt, start + MIN);
  Core.clearSession(store);
  assert.equal(Core.loadSession(store), null);
  assert.equal(Core.saveSession(store, null), false);
  assert.equal(Core.saveSession(null, session), false);

  assert.equal(Core.saveRecords(store, [makeRecord()]), true);
  assert.equal(Core.loadRecords(store).length, 1);
  store.setItem(Core.STORAGE_KEYS.records, '{oops');
  assert.deepEqual(Core.loadRecords(store), []);
  store.setItem(Core.STORAGE_KEYS.records, '{"not":"array"}');
  assert.deepEqual(Core.loadRecords(store), []);

  assert.deepEqual(Core.loadRecords(brokenStorage()), []);
  assert.equal(Core.saveRecords(brokenStorage(), [makeRecord()]), false);
  assert.equal(Core.loadSession(brokenStorage()), null);
  assert.doesNotThrow(() => Core.clearSession(brokenStorage()));

  const defaults = Core.defaultSettings();
  assert.deepEqual(defaults, { theme: 'dark', sound: true, defaultTargetMs: 25 * MIN });
  assert.equal(Core.normalizeSettings({ theme: 'neon' }).theme, 'dark');
  assert.equal(Core.normalizeSettings({ theme: 'light' }).theme, 'light');
  assert.equal(Core.normalizeSettings({ sound: false }).sound, false);
  assert.equal(Core.normalizeSettings({ sound: 0 }).sound, true);
  assert.equal(Core.normalizeSettings({ defaultTargetMs: 0 }).defaultTargetMs, MIN);
  assert.equal(Core.saveSettings(store, { theme: 'light', sound: false, defaultTargetMs: 60 * MIN }), true);
  assert.deepEqual(Core.loadSettings(store), {
    theme: 'light',
    sound: false,
    defaultTargetMs: 60 * MIN,
  });
  store.setItem(Core.STORAGE_KEYS.settings, 'nope');
  assert.deepEqual(Core.loadSettings(store), defaults);
});

/* ------------------------------------------------------------------------- */
/* edge cases                                                                */
/* ------------------------------------------------------------------------- */

test('edge: target reached never mutates or stops the session', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ targetMs: 10 * MIN, now: start });

  // 只读判断：多次调用不改变会话
  assert.equal(Core.isTargetReached(session, start + 30 * MIN), true);
  assert.equal(Core.isTargetReached(session, start + 30 * MIN), true);
  assert.equal(session.phase, 'running');
  assert.equal(session.rounds.length, 0);
  assert.equal(Core.getTotalFocusedMs(session, start + 30 * MIN), 30 * MIN);
  assert.equal(Core.getOvertimeMs(session, start + 30 * MIN), 20 * MIN);

  // 超时后仍能暂停计轮、继续、完成
  const paused = Core.pauseSession(session, start + 30 * MIN).session;
  assert.equal(paused.rounds[0].focusedMs, 30 * MIN);
  assert.equal(Core.getOvertimeMs(paused, start + 99 * MIN), 20 * MIN, '暂停后超时量保持');
  const resumed = Core.resumeSession(paused, start + 99 * MIN);
  assert.equal(Core.getTotalFocusedMs(resumed, start + 99 * MIN), 30 * MIN);
  const record = Core.completeSession(resumed, start + 99 * MIN + 500);
  assert.equal(record.roundsTotal, 1, '不足 1 秒的收口轮次不计');
  assert.equal(record.targetReached, true);
});

test('edge: many rounds accumulate actual time; all rounds are counted', () => {
  const start = D(2026, 10, 24, 10, 0);
  let session = Core.createSession({ taskName: '多轮', targetMs: 25 * MIN, now: start });
  let t = start;
  for (let round = 0; round < 5; round += 1) {
    t += 2 * MIN;
    session = Core.startNextRound(session, t).session;
  }
  assert.equal(session.rounds.length, 5);
  assert.equal(Core.getTotalFocusedMs(session, t), 10 * MIN);
  assert.equal(Core.getCurrentRoundNumber(session), 6);

  const record = Core.completeSession(session, t + 60 * SEC);
  assert.equal(record.roundsTotal, 6, '收口轮次 60 秒 >= 1 秒，计入');
  assert.equal(record.totalFocusedMs, 11 * MIN);
  assert.deepEqual(record.rounds, [2 * MIN, 2 * MIN, 2 * MIN, 2 * MIN, 2 * MIN, 60 * SEC]);
  assert.equal(record.targetReached, false);

  const summary = Core.summarize([record], t + 60 * SEC);
  assert.equal(summary.todayRounds, 6);
  assert.equal(summary.todayMs, 11 * MIN);
});

test('edge: pause/resume/next on <1s keeps task and totals consistent', () => {
  const start = D(2026, 10, 24, 10, 0);
  const session = Core.createSession({ targetMs: 25 * MIN, now: start });

  const paused = Core.pauseSession(session, start + 500).session;
  assert.equal(paused.rounds.length, 0);
  assert.equal(paused.phase, 'paused');
  assert.equal(Core.getCurrentRoundNumber(paused), 0);

  const resumed = Core.resumeSession(paused, start + MIN);
  assert.equal(resumed.phase, 'running');
  assert.equal(Core.getTotalFocusedMs(resumed, start + MIN), 0);

  const next = Core.startNextRound(resumed, start + MIN + 400);
  assert.equal(next.roundEnded, false);
  assert.equal(next.session.rounds.length, 0);
  assert.equal(Core.getTotalFocusedMs(next.session, start + MIN + 400), 0);

  // 满 1 秒后暂停才计轮
  const later = Core.pauseSession(next.session, start + 3 * MIN);
  assert.equal(later.roundEnded, true);
  assert.equal(later.session.rounds.length, 1);
  assert.equal(later.session.rounds[0].focusedMs, 3 * MIN - MIN - 400);
});
