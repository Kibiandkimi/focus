/*
 * FocusCore — pure, DOM-free logic for the Focus app (schema v3).
 *
 * Semantics (v3):
 *   - A task is a todo item with an expected completion duration.
 *   - Working on a task is split into focus rounds. Each round has its own
 *     planned focus duration and actual focused time; the task duration is the
 *     sum of actual focus time across rounds (pause intervals excluded).
 *   - Reaching a round's planned focus duration never stops anything.
 *   - Pause ends a round (counted), the task stays active; resume starts a new round.
 *   - Completing a task records expected vs actual task duration, per-round focus
 *     expected vs actual, average focus per round and total focus time.
 *
 * Works as a plain browser script (window.FocusCore) and as a Node module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FocusCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 3;
  const STORAGE_KEYS = {
    tasks: 'focus.tasks.v3',
    session: 'focus.session.v3',
    records: 'focus.records.v3',
    settings: 'focus.settings.v3',
  };
  const LEGACY_KEYS = {
    session: 'focus.session.v1',
    records: 'focus.records.v1',
    settings: 'focus.settings.v1',
  };

  const MIN_TASK_MINUTES = 1;
  const MAX_TASK_MINUTES = 1440;
  const MIN_FOCUS_MINUTES = 1;
  const MAX_FOCUS_MINUTES = 480;
  const DEFAULT_TASK_MS = 60 * 60 * 1000;
  const DEFAULT_FOCUS_MS = 25 * 60 * 1000;
  const MIN_ROUND_MS = 1000;
  const MAX_RECORDS = 500;
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  /* ------------------------------------------------------------------ *
   * tiny helpers
   * ------------------------------------------------------------------ */

  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const pad2 = (n) => (n < 10 ? '0' + n : String(n));

  function makeId(prefix) {
    return (
      prefix +
      '_' +
      Date.now().toString(36) +
      '_' +
      Math.random().toString(36).slice(2, 7)
    );
  }

  function clampExpectedTaskMs(ms) {
    const n = Math.round(Number(ms));
    if (!Number.isFinite(n)) return DEFAULT_TASK_MS;
    return clamp(n, MIN_TASK_MINUTES * 60 * 1000, MAX_TASK_MINUTES * 60 * 1000);
  }

  function clampExpectedFocusMs(ms) {
    const n = Math.round(Number(ms));
    if (!Number.isFinite(n)) return DEFAULT_FOCUS_MS;
    return clamp(n, MIN_FOCUS_MINUTES * 60 * 1000, MAX_FOCUS_MINUTES * 60 * 1000);
  }

  function splitClock(ms, rounding) {
    const total = Math.max(0, rounding((isNum(ms) ? ms : 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  }

  function formatClock(ms) {
    return splitClock(ms, Math.ceil);
  }

  function formatElapsed(ms) {
    return splitClock(ms, Math.floor);
  }

  function formatSpan(ms) {
    const value = isNum(ms) ? ms : 0;
    if (value > 0 && value < 30000) return '不足 1 分钟';
    const minutes = Math.max(0, Math.round(value / 60000));
    if (minutes < 60) return `${minutes} 分钟`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }

  function minutesLabel(ms) {
    if (!isNum(ms) || ms <= 0) return '0';
    const minutes = Math.round(ms / 60000);
    return minutes === 0 ? '<1' : String(minutes);
  }

  function formatTimeOfDay(ts) {
    const d = new Date(isNum(ts) ? ts : Date.now());
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function dateKey(ts) {
    const d = new Date(isNum(ts) ? ts : Date.now());
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function parseDateKey(key) {
    if (typeof key !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDayLabel(key, now) {
    const nowValue = isNum(now) ? now : Date.now();
    if (key === dateKey(nowValue)) return '今天';
    const yesterday = new Date(nowValue);
    yesterday.setHours(12, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    if (key === dateKey(yesterday.getTime())) return '昨天';

    const d = parseDateKey(key);
    if (!d) return String(key || '');
    const sameYear = d.getFullYear() === new Date(nowValue).getFullYear();
    const prefix = sameYear ? '' : `${d.getFullYear()}年`;
    return `${prefix}${d.getMonth() + 1}月${d.getDate()}日`;
  }

  /* ------------------------------------------------------------------ *
   * tasks (todo items with plans)
   * ------------------------------------------------------------------ */

  function createTask(options) {
    const now = isNum(options && options.now) ? options.now : Date.now();
    const title =
      options && typeof options.title === 'string'
        ? options.title.replace(/\s+/g, ' ').trim().slice(0, 60)
        : '';
    return {
      v: VERSION,
      id: makeId('t'),
      title: title || '未命名任务',
      expectedTaskMs: clampExpectedTaskMs(options && options.expectedTaskMs),
      expectedFocusMs: clampExpectedFocusMs(options && options.expectedFocusMs),
      createdAt: now,
    };
  }

  function normalizeTask(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const title =
      typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 60) : '';
    if (!title) return null;
    return {
      v: VERSION,
      id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('t'),
      title: title,
      expectedTaskMs: clampExpectedTaskMs(raw.expectedTaskMs),
      expectedFocusMs: clampExpectedFocusMs(raw.expectedFocusMs),
      createdAt: isNum(raw.createdAt) ? raw.createdAt : Date.now(),
    };
  }

  function sanitizeTasks(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeTask).filter(Boolean);
  }

  function addTask(tasks, task) {
    const normalized = normalizeTask(task);
    const list = Array.isArray(tasks) ? tasks.slice() : [];
    if (!normalized) return list;
    return [normalized].concat(list);
  }

  function removeTask(tasks, id) {
    return (Array.isArray(tasks) ? tasks : []).filter((t) => t.id !== id);
  }

  function findTask(tasks, id) {
    return (Array.isArray(tasks) ? tasks : []).filter((t) => t.id === id)[0] || null;
  }

  /* ------------------------------------------------------------------ *
   * focus session (task -> rounds)
   * ------------------------------------------------------------------ */

  function createSession(options) {
    const now = isNum(options && options.now) ? options.now : Date.now();
    const task = options && options.task;
    const expectedFocusMs = clampExpectedFocusMs(
      (options && options.expectedFocusMs) || (task && task.expectedFocusMs)
    );
    return {
      v: VERSION,
      id: makeId('s'),
      taskId: task && task.id ? task.id : makeId('t'),
      taskTitle: task && task.title ? task.title : '专注',
      taskExpectedMs: clampExpectedTaskMs(task && task.expectedTaskMs),
      expectedFocusMs: expectedFocusMs,
      nextExpectedFocusMs: expectedFocusMs,
      phase: 'running',
      startedAt: now,
      roundStartedAt: now,
      roundElapsedMs: 0,
      rounds: [],
      savedAt: now,
      restored: false,
    };
  }

  function normalizeSession(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const taskTitle =
      typeof raw.taskTitle === 'string' && raw.taskTitle.trim()
        ? raw.taskTitle.trim().slice(0, 60)
        : '';
    if (!taskTitle) return null;

    const phase = raw.phase === 'running' ? 'running' : 'paused';
    const rounds = Array.isArray(raw.rounds)
      ? raw.rounds.map(normalizeRoundRecord).filter(Boolean)
      : [];

    return {
      v: VERSION,
      id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('s'),
      taskId: typeof raw.taskId === 'string' && raw.taskId ? raw.taskId : makeId('t'),
      taskTitle: taskTitle,
      taskExpectedMs: clampExpectedTaskMs(raw.taskExpectedMs),
      expectedFocusMs: clampExpectedFocusMs(raw.expectedFocusMs),
      nextExpectedFocusMs: clampExpectedFocusMs(
        isNum(raw.nextExpectedFocusMs) ? raw.nextExpectedFocusMs : raw.expectedFocusMs
      ),
      phase: phase,
      startedAt: isNum(raw.startedAt) ? raw.startedAt : Date.now(),
      roundStartedAt: phase === 'running' && isNum(raw.roundStartedAt) ? raw.roundStartedAt : null,
      roundElapsedMs:
        phase === 'running' && isNum(raw.roundElapsedMs) ? Math.max(0, raw.roundElapsedMs) : 0,
      rounds: rounds,
      savedAt: isNum(raw.savedAt) ? raw.savedAt : Date.now(),
      restored: false,
    };
  }

  function getRoundElapsedMs(session, now) {
    if (!session || session.phase !== 'running') return 0;
    const nowValue = isNum(now) ? now : Date.now();
    let elapsed = isNum(session.roundElapsedMs) ? session.roundElapsedMs : 0;
    if (isNum(session.roundStartedAt)) {
      elapsed += Math.max(0, nowValue - session.roundStartedAt);
    }
    return Math.max(0, elapsed);
  }

  function getCompletedRounds(session) {
    return session && Array.isArray(session.rounds) ? session.rounds.length : 0;
  }

  function getFocusTotalMs(session) {
    if (!session) return 0;
    return (session.rounds || []).reduce(
      (sum, round) => sum + (isNum(round.actualMs) ? round.actualMs : 0),
      0
    );
  }

  function getAverageFocusMs(session) {
    const rounds = getCompletedRounds(session);
    return rounds > 0 ? getFocusTotalMs(session) / rounds : 0;
  }

  /**
   * Actual time spent on the task: finished rounds + the current round.
   * Pause intervals are NOT included (in contrast to the wall-clock span
   * between startedAt and endedAt, which is only used as a time range).
   */
  function getTaskElapsedMs(session, now) {
    if (!session) return 0;
    const nowValue = isNum(now) ? now : Date.now();
    return getFocusTotalMs(session) + getRoundElapsedMs(session, nowValue);
  }

  function getRoundExpectedMs(session) {
    return session ? session.expectedFocusMs : 0;
  }

  function getCurrentRoundActualMs(session, now) {
    return getRoundElapsedMs(session, now);
  }

  function getRoundRemainingMs(session, now) {
    if (!session) return 0;
    return Math.max(0, session.expectedFocusMs - getRoundElapsedMs(session, now));
  }

  function getRoundOvertimeMs(session, now) {
    if (!session) return 0;
    return Math.max(0, getRoundElapsedMs(session, now) - session.expectedFocusMs);
  }

  function getRoundProgress(session, now) {
    if (!session || !session.expectedFocusMs) return 0;
    return clamp(getRoundElapsedMs(session, now) / session.expectedFocusMs, 0, 1);
  }

  function isRoundTargetReached(session, now) {
    return session ? getRoundElapsedMs(session, now) >= session.expectedFocusMs : false;
  }

  function getLastRound(session) {
    if (!session || !Array.isArray(session.rounds) || session.rounds.length === 0) return null;
    return session.rounds[session.rounds.length - 1];
  }

  function endCurrentRound(session, now) {
    const rounds = (session.rounds || []).slice();
    if (!session || session.phase !== 'running') {
      return { rounds: rounds, roundEnded: false, round: null };
    }
    const nowValue = isNum(now) ? now : Date.now();
    const actualMs = getRoundElapsedMs(session, nowValue);
    if (actualMs < MIN_ROUND_MS) {
      return { rounds: rounds, roundEnded: false, round: null };
    }
    const round = {
      expectedMs: session.expectedFocusMs,
      actualMs: Math.round(actualMs),
      startedAt: session.roundStartedAt,
      endedAt: nowValue,
    };
    rounds.push(round);
    return { rounds: rounds, roundEnded: true, round: round };
  }

  function pauseSession(session, now) {
    if (!session || session.phase !== 'running') {
      return { session: session, roundEnded: false, round: null };
    }
    const nowValue = isNum(now) ? now : Date.now();
    const ended = endCurrentRound(session, nowValue);
    return {
      roundEnded: ended.roundEnded,
      round: ended.round,
      session: {
        ...session,
        rounds: ended.rounds,
        phase: 'paused',
        roundStartedAt: null,
        roundElapsedMs: 0,
        nextExpectedFocusMs: session.expectedFocusMs,
        savedAt: nowValue,
      },
    };
  }

  function setNextExpectedFocusMs(session, ms) {
    if (!session) return session;
    return {
      ...session,
      nextExpectedFocusMs: clampExpectedFocusMs(ms),
      savedAt: Date.now(),
    };
  }

  function resumeSession(session, now) {
    if (!session || session.phase !== 'paused') return session;
    const nowValue = isNum(now) ? now : Date.now();
    return {
      ...session,
      phase: 'running',
      expectedFocusMs: clampExpectedFocusMs(session.nextExpectedFocusMs),
      roundStartedAt: nowValue,
      roundElapsedMs: 0,
      savedAt: nowValue,
    };
  }

  function startNextRound(session, now) {
    if (!session) return { session: null, roundEnded: false, round: null };
    const nowValue = isNum(now) ? now : Date.now();
    const ended = endCurrentRound(session, nowValue);
    const expectedFocusMs =
      session.phase === 'paused'
        ? clampExpectedFocusMs(session.nextExpectedFocusMs)
        : session.expectedFocusMs;
    return {
      roundEnded: ended.roundEnded,
      round: ended.round,
      session: {
        ...session,
        rounds: ended.rounds,
        phase: 'running',
        expectedFocusMs: expectedFocusMs,
        roundStartedAt: nowValue,
        roundElapsedMs: 0,
        nextExpectedFocusMs: expectedFocusMs,
        savedAt: nowValue,
      },
    };
  }

  function completeSession(session, now) {
    if (!session) return null;
    const nowValue = isNum(now) ? now : Date.now();
    const ended = endCurrentRound(session, nowValue);
    const rounds = ended.rounds;
    if (rounds.length === 0) return null;

    const focusTotalMs = rounds.reduce(
      (sum, round) => sum + (isNum(round.actualMs) ? round.actualMs : 0),
      0
    );
    if (focusTotalMs <= 0) return null;

    const roundsWithExpected = rounds.filter((r) => isNum(r.expectedMs)).length;
    const expectedFocusTotalMs = rounds.reduce(
      (sum, r) => sum + (isNum(r.expectedMs) ? r.expectedMs : 0),
      0
    );
    // Task duration = accumulated actual focus time across rounds (pauses excluded).
    const taskDurationMs = focusTotalMs;

    return {
      v: VERSION,
      id: makeId('r'),
      taskId: session.taskId,
      title: session.taskTitle,
      expectedTaskMs: session.taskExpectedMs,
      taskDurationMs: taskDurationMs,
      rounds: rounds.map((round) => ({
        expectedMs: isNum(round.expectedMs) ? round.expectedMs : null,
        actualMs: Math.round(round.actualMs),
      })),
      roundsTotal: rounds.length,
      roundsWithExpected: roundsWithExpected,
      focusTotalMs: focusTotalMs,
      avgFocusMs: focusTotalMs / rounds.length,
      expectedFocusTotalMs: expectedFocusTotalMs,
      startedAt: session.startedAt,
      endedAt: nowValue,
      dateKey: dateKey(nowValue),
    };
  }

  function restoreSession(raw, now) {
    let session = normalizeSession(raw);
    if (!session) return null;
    const nowValue = isNum(now) ? now : Date.now();

    if (session.phase === 'running') {
      const savedAt = isNum(session.savedAt) ? session.savedAt : nowValue;
      const ended = endCurrentRound(session, savedAt);
      session = {
        ...session,
        rounds: ended.rounds,
        phase: 'paused',
        roundStartedAt: null,
        roundElapsedMs: 0,
        nextExpectedFocusMs: session.expectedFocusMs,
        restored: true,
      };
    }
    return session;
  }

  /* ------------------------------------------------------------------ *
   * records
   * ------------------------------------------------------------------ */

  function normalizeRoundRecord(raw) {
    if (isNum(raw) && raw > 0) return { expectedMs: null, actualMs: Math.round(raw) };
    if (!raw || typeof raw !== 'object') return null;
    if (!isNum(raw.actualMs) || raw.actualMs <= 0) return null;
    return {
      expectedMs: isNum(raw.expectedMs) ? clampExpectedFocusMs(raw.expectedMs) : null,
      actualMs: Math.round(raw.actualMs),
    };
  }

  function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title =
      typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim().slice(0, 60)
        : typeof raw.taskName === 'string' && raw.taskName.trim()
        ? raw.taskName.trim().slice(0, 60)
        : '';
    if (!title) return null;
    if (!isNum(raw.startedAt) || !isNum(raw.endedAt)) return null;

    const rounds = Array.isArray(raw.rounds)
      ? raw.rounds.map(normalizeRoundRecord).filter(Boolean)
      : [];
    const focusTotalMs = isNum(raw.focusTotalMs)
      ? raw.focusTotalMs
      : isNum(raw.totalFocusedMs)
      ? raw.totalFocusedMs
      : rounds.reduce((sum, round) => sum + round.actualMs, 0);
    if (!(focusTotalMs > 0)) return null;

    let roundsTotal = Math.max(
      1,
      Math.round(isNum(raw.roundsTotal) ? raw.roundsTotal : rounds.length || 1)
    );
    let roundsWithExpected = Math.max(
      0,
      Math.round(
        isNum(raw.roundsWithExpected)
          ? raw.roundsWithExpected
          : rounds.filter((round) => isNum(round.expectedMs)).length
      )
    );
    roundsWithExpected = Math.min(roundsWithExpected, roundsTotal);

    let expectedFocusTotalMs = isNum(raw.expectedFocusTotalMs)
      ? raw.expectedFocusTotalMs
      : rounds.reduce((sum, round) => sum + (isNum(round.expectedMs) ? round.expectedMs : 0), 0);
    expectedFocusTotalMs = Math.max(0, expectedFocusTotalMs);

    // v3.x compatibility: older v3 records may have stored wall-clock duration
    // (including pauses); task duration is always the sum of round focus time.
    const taskDurationMs = Math.round(focusTotalMs);

    return {
      v: VERSION,
      id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('r'),
      taskId: typeof raw.taskId === 'string' && raw.taskId ? raw.taskId : 'legacy_' + makeId('t'),
      title: title,
      expectedTaskMs: clampExpectedTaskMs(
        raw.expectedTaskMs != null ? raw.expectedTaskMs : raw.targetMs
      ),
      taskDurationMs: taskDurationMs,
      rounds: rounds,
      roundsTotal: roundsTotal,
      roundsWithExpected: roundsWithExpected,
      focusTotalMs: Math.round(focusTotalMs),
      avgFocusMs:
        isNum(raw.avgFocusMs) && raw.avgFocusMs >= 0
          ? raw.avgFocusMs
          : focusTotalMs / roundsTotal,
      expectedFocusTotalMs: Math.round(expectedFocusTotalMs),
      startedAt: raw.startedAt,
      endedAt: raw.endedAt,
      dateKey: typeof raw.dateKey === 'string' && raw.dateKey ? raw.dateKey : dateKey(raw.endedAt),
    };
  }

  function sanitizeRecords(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(normalizeRecord)
      .filter(Boolean)
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, MAX_RECORDS);
  }

  function addRecord(records, record) {
    const normalized = normalizeRecord(record);
    const list = Array.isArray(records) ? records.slice() : [];
    if (!normalized) return list;
    return [normalized]
      .concat(list)
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, MAX_RECORDS);
  }

  function removeRecord(records, id) {
    return (Array.isArray(records) ? records : []).filter((r) => r.id !== id);
  }

  function groupRecords(records) {
    const groups = [];
    const index = Object.create(null);
    (Array.isArray(records) ? records : []).forEach((record) => {
      const key = record.dateKey;
      if (!index[key]) {
        index[key] = { key: key, records: [] };
        groups.push(index[key]);
      }
      index[key].records.push(record);
    });
    return groups;
  }

  function recordMetrics(record) {
    if (!record) {
      return { avgFocusMs: 0, expectedFocusAvgMs: null, taskDeltaMs: 0, focusDeltaMs: null };
    }
    const avgFocusMs = record.roundsTotal ? record.focusTotalMs / record.roundsTotal : 0;
    const expectedFocusAvgMs = record.roundsWithExpected
      ? record.expectedFocusTotalMs / record.roundsWithExpected
      : null;
    return {
      avgFocusMs: avgFocusMs,
      expectedFocusAvgMs: expectedFocusAvgMs,
      taskDeltaMs: record.expectedTaskMs - record.taskDurationMs,
      focusDeltaMs: expectedFocusAvgMs == null ? null : avgFocusMs - expectedFocusAvgMs,
    };
  }

  function emptyAggregate() {
    return {
      tasks: 0,
      rounds: 0,
      focusMs: 0,
      expectedTaskMs: 0,
      taskDurationMs: 0,
      expectedFocusTotalMs: 0,
      roundsWithExpected: 0,
    };
  }

  function finishAggregate(agg) {
    const avgFocusMs = agg.rounds > 0 ? agg.focusMs / agg.rounds : 0;
    const expectedFocusAvgMs =
      agg.roundsWithExpected > 0 ? agg.expectedFocusTotalMs / agg.roundsWithExpected : null;
    return {
      tasks: agg.tasks,
      rounds: agg.rounds,
      focusMs: agg.focusMs,
      expectedTaskMs: agg.expectedTaskMs,
      taskDurationMs: agg.taskDurationMs,
      expectedFocusTotalMs: agg.expectedFocusTotalMs,
      roundsWithExpected: agg.roundsWithExpected,
      avgFocusMs: avgFocusMs,
      expectedFocusAvgMs: expectedFocusAvgMs,
      taskDeltaMs: agg.expectedTaskMs - agg.taskDurationMs,
      focusDeltaMs: expectedFocusAvgMs == null ? null : avgFocusMs - expectedFocusAvgMs,
    };
  }

  function summarize(records, now) {
    const nowValue = isNum(now) ? now : Date.now();
    const list = Array.isArray(records) ? records : [];
    const byDay = Object.create(null);
    const total = emptyAggregate();

    list.forEach((record) => {
      const key = record.dateKey || dateKey(record.endedAt || nowValue);
      const day = byDay[key] || (byDay[key] = emptyAggregate());
      [day, total].forEach((agg) => {
        agg.tasks += 1;
        agg.rounds += record.roundsTotal || 0;
        agg.focusMs += record.focusTotalMs || 0;
        agg.expectedTaskMs += record.expectedTaskMs || 0;
        agg.taskDurationMs += record.taskDurationMs || 0;
        agg.expectedFocusTotalMs += record.expectedFocusTotalMs || 0;
        agg.roundsWithExpected += record.roundsWithExpected || 0;
      });
    });

    const today = finishAggregate(byDay[dateKey(nowValue)] || emptyAggregate());
    const overall = finishAggregate(total);

    const cursor = new Date(nowValue);
    cursor.setHours(12, 0, 0, 0);
    let streak = 0;
    if (!byDay[dateKey(cursor.getTime())]) cursor.setDate(cursor.getDate() - 1);
    while (byDay[dateKey(cursor.getTime())]) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    const last7 = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(nowValue);
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = dateKey(d.getTime());
      const day = byDay[key];
      last7.push({
        key: key,
        weekday: WEEKDAYS[d.getDay()],
        ms: day ? day.focusMs : 0,
        rounds: day ? day.rounds : 0,
        isToday: i === 0,
      });
    }

    return { today: today, total: overall, streak: streak, last7: last7 };
  }

  /* ------------------------------------------------------------------ *
   * storage + v2 migration
   * ------------------------------------------------------------------ */

  function safeStorage(storage) {
    if (storage) return storage;
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (err) {
      /* private mode */
    }
    return null;
  }

  function readJSON(storage, key, fallback) {
    const store = safeStorage(storage);
    if (!store) return fallback;
    try {
      const raw = store.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function writeJSON(storage, key, value) {
    const store = safeStorage(storage);
    if (!store) return false;
    try {
      store.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  function removeKey(storage, key) {
    const store = safeStorage(storage);
    if (!store) return;
    try {
      store.removeItem(key);
    } catch (err) {
      /* ignore */
    }
  }

  function saveTasks(storage, tasks) {
    return writeJSON(storage, STORAGE_KEYS.tasks, sanitizeTasks(tasks));
  }

  function loadTasks(storage) {
    const raw = readJSON(storage, STORAGE_KEYS.tasks, null);
    if (Array.isArray(raw)) return sanitizeTasks(raw);

    // v2 → v3: the old active session becomes a todo task so nothing is lost.
    const legacySession = readJSON(storage, LEGACY_KEYS.session, null);
    const tasks = [];
    if (
      legacySession &&
      typeof legacySession === 'object' &&
      typeof legacySession.taskName === 'string'
    ) {
      tasks.push(
        createTask({
          title: legacySession.taskName,
          expectedTaskMs: legacySession.targetMs,
          expectedFocusMs: legacySession.targetMs,
          now: isNum(legacySession.startedAt) ? legacySession.startedAt : Date.now(),
        })
      );
    }
    saveTasks(storage, tasks);
    return sanitizeTasks(tasks);
  }

  function saveSession(storage, session, now) {
    if (!session) return false;
    const nowValue = isNum(now) ? now : Date.now();
    return writeJSON(storage, STORAGE_KEYS.session, { ...session, savedAt: nowValue });
  }

  function loadSession(storage) {
    return normalizeSession(readJSON(storage, STORAGE_KEYS.session, null));
  }

  function clearSession(storage) {
    removeKey(storage, STORAGE_KEYS.session);
  }

  function saveRecords(storage, records) {
    return writeJSON(storage, STORAGE_KEYS.records, sanitizeRecords(records));
  }

  function loadRecords(storage) {
    const raw = readJSON(storage, STORAGE_KEYS.records, null);
    if (Array.isArray(raw)) return sanitizeRecords(raw);
    const migrated = sanitizeRecords(readJSON(storage, LEGACY_KEYS.records, []));
    if (migrated.length > 0) saveRecords(storage, migrated);
    return migrated;
  }

  function defaultSettings() {
    return {
      theme: 'dark',
      sound: true,
      defaultExpectedTaskMs: DEFAULT_TASK_MS,
      defaultExpectedFocusMs: DEFAULT_FOCUS_MS,
    };
  }

  function normalizeSettings(raw) {
    const base = defaultSettings();
    if (!raw || typeof raw !== 'object') return base;
    return {
      theme: raw.theme === 'light' ? 'light' : 'dark',
      sound: raw.sound !== false,
      defaultExpectedTaskMs: clampExpectedTaskMs(
        raw.defaultExpectedTaskMs != null ? raw.defaultExpectedTaskMs : base.defaultExpectedTaskMs
      ),
      defaultExpectedFocusMs: clampExpectedFocusMs(
        raw.defaultExpectedFocusMs != null
          ? raw.defaultExpectedFocusMs
          : raw.defaultTargetMs != null
          ? raw.defaultTargetMs
          : base.defaultExpectedFocusMs
      ),
    };
  }

  function loadSettings(storage) {
    const raw = readJSON(storage, STORAGE_KEYS.settings, null);
    if (raw) return normalizeSettings(raw);
    const legacy = readJSON(storage, LEGACY_KEYS.settings, null);
    const migrated = normalizeSettings(legacy);
    saveSettings(storage, migrated);
    return migrated;
  }

  function saveSettings(storage, settings) {
    return writeJSON(storage, STORAGE_KEYS.settings, normalizeSettings(settings));
  }

  return {
    VERSION: VERSION,
    STORAGE_KEYS: STORAGE_KEYS,
    LEGACY_KEYS: LEGACY_KEYS,
    MIN_TASK_MINUTES: MIN_TASK_MINUTES,
    MAX_TASK_MINUTES: MAX_TASK_MINUTES,
    MIN_FOCUS_MINUTES: MIN_FOCUS_MINUTES,
    MAX_FOCUS_MINUTES: MAX_FOCUS_MINUTES,
    DEFAULT_TASK_MS: DEFAULT_TASK_MS,
    DEFAULT_FOCUS_MS: DEFAULT_FOCUS_MS,
    MIN_ROUND_MS: MIN_ROUND_MS,
    MAX_RECORDS: MAX_RECORDS,
    WEEKDAYS: WEEKDAYS,

    clampExpectedTaskMs: clampExpectedTaskMs,
    clampExpectedFocusMs: clampExpectedFocusMs,
    formatClock: formatClock,
    formatElapsed: formatElapsed,
    formatSpan: formatSpan,
    minutesLabel: minutesLabel,
    formatTimeOfDay: formatTimeOfDay,
    dateKey: dateKey,
    parseDateKey: parseDateKey,
    formatDayLabel: formatDayLabel,

    createTask: createTask,
    normalizeTask: normalizeTask,
    sanitizeTasks: sanitizeTasks,
    addTask: addTask,
    removeTask: removeTask,
    findTask: findTask,

    createSession: createSession,
    normalizeSession: normalizeSession,
    getRoundElapsedMs: getRoundElapsedMs,
    getCompletedRounds: getCompletedRounds,
    getFocusTotalMs: getFocusTotalMs,
    getAverageFocusMs: getAverageFocusMs,
    getTaskElapsedMs: getTaskElapsedMs,
    getRoundExpectedMs: getRoundExpectedMs,
    getCurrentRoundActualMs: getCurrentRoundActualMs,
    getRoundRemainingMs: getRoundRemainingMs,
    getRoundOvertimeMs: getRoundOvertimeMs,
    getRoundProgress: getRoundProgress,
    isRoundTargetReached: isRoundTargetReached,
    getLastRound: getLastRound,
    pauseSession: pauseSession,
    setNextExpectedFocusMs: setNextExpectedFocusMs,
    resumeSession: resumeSession,
    startNextRound: startNextRound,
    completeSession: completeSession,
    restoreSession: restoreSession,

    normalizeRecord: normalizeRecord,
    sanitizeRecords: sanitizeRecords,
    addRecord: addRecord,
    removeRecord: removeRecord,
    groupRecords: groupRecords,
    recordMetrics: recordMetrics,
    summarize: summarize,

    loadTasks: loadTasks,
    saveTasks: saveTasks,
    loadSession: loadSession,
    saveSession: saveSession,
    clearSession: clearSession,
    loadRecords: loadRecords,
    saveRecords: saveRecords,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    normalizeSettings: normalizeSettings,
    defaultSettings: defaultSettings,
  };
});
