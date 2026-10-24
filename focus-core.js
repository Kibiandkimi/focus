/*
 * FocusCore — pure, DOM-free logic for the Focus app (schema v2).
 *
 * Semantics (v2):
 *   - A task has one target duration for the WHOLE task (a hint + statistic).
 *   - Time counts UP; reaching the target never stops a round or the task.
 *   - Pausing ends the current round and counts it, but keeps the task alive.
 *   - Resuming / "next round" starts a new round inside the same task.
 *   - Finishing a task records actual focused time and the target time.
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

  const VERSION = 2;
  const STORAGE_KEYS = {
    session: 'focus.session.v1',
    records: 'focus.records.v1',
    settings: 'focus.settings.v1',
  };
  const MIN_MINUTES = 1;
  const MAX_MINUTES = 480;
  const DEFAULT_TARGET_MS = 25 * 60 * 1000;
  const MAX_RECORDS = 500;
  /** Rounds shorter than this are not counted (prevents accidental click noise). */
  const MIN_ROUND_MS = 1000;
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  /* ------------------------------------------------------------------ *
   * small helpers
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

  function clampTargetMs(ms) {
    const n = Math.round(Number(ms));
    if (!Number.isFinite(n)) return DEFAULT_TARGET_MS;
    return clamp(n, MIN_MINUTES * 60 * 1000, MAX_MINUTES * 60 * 1000);
  }

  function splitClock(ms, rounding) {
    const total = Math.max(0, rounding((isNum(ms) ? ms : 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  }

  /** Countdown clock (rounds up): 25:00, 1:05:30 */
  function formatClock(ms) {
    return splitClock(ms, Math.ceil);
  }

  /** Stopwatch clock (rounds down): 00:00 → 12:34 */
  function formatElapsed(ms) {
    return splitClock(ms, Math.floor);
  }

  /** Human duration: 45 分钟 / 1 小时 15 分钟 */
  function formatSpan(ms) {
    const value = isNum(ms) ? ms : 0;
    if (value > 0 && value < 30000) return '不足 1 分钟';
    const minutes = Math.max(0, Math.round(value / 60000));
    if (minutes < 60) return `${minutes} 分钟`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }

  /** Compact minutes for stat tiles: 0, 7, 90, <1 */
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

  /** 今天 / 昨天 / 10月24日 / 2025年12月31日 */
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
   * task / round state machine
   * ------------------------------------------------------------------ */

  function makeRound(focusedMs) {
    return { focusedMs: Math.max(0, Math.round(focusedMs)) };
  }

  function roundFocusedMs(round) {
    return isNum(round && round.focusedMs) ? Math.max(0, round.focusedMs) : 0;
  }

  function createSession(options) {
    const now = isNum(options && options.now) ? options.now : Date.now();
    const targetMs = clampTargetMs(options && options.targetMs);
    const rawName = options && typeof options.taskName === 'string' ? options.taskName : '';
    const taskName = rawName.replace(/\s+/g, ' ').trim().slice(0, 60) || '专注';

    return {
      v: VERSION,
      id: makeId('s'),
      taskName: taskName,
      targetMs: targetMs,
      startedAt: now,
      rounds: [],
      phase: 'running',
      roundElapsedMs: 0,
      roundStartedAt: now,
      savedAt: now,
      restored: false,
    };
  }

  /** Elapsed time of the round that is currently running, in ms. */
  function getRoundElapsedMs(session, now) {
    if (!session || session.phase !== 'running') return 0;
    const nowValue = isNum(now) ? now : Date.now();
    let elapsed = isNum(session.roundElapsedMs) ? session.roundElapsedMs : 0;
    if (isNum(session.roundStartedAt)) {
      elapsed += Math.max(0, nowValue - session.roundStartedAt);
    }
    return Math.max(0, elapsed);
  }

  /** Actual focused time of the whole task (all finished rounds + current round). */
  function getTotalFocusedMs(session, now) {
    if (!session) return 0;
    const finished = (session.rounds || []).reduce((sum, r) => sum + roundFocusedMs(r), 0);
    return finished + getRoundElapsedMs(session, now);
  }

  function getCompletedRounds(session) {
    return session && Array.isArray(session.rounds) ? session.rounds.length : 0;
  }

  /** Current round number: 1-based while running, completed count while paused. */
  function getCurrentRoundNumber(session) {
    if (!session) return 1;
    return session.phase === 'running' ? getCompletedRounds(session) + 1 : getCompletedRounds(session);
  }

  function getTargetRemainingMs(session, now) {
    if (!session) return 0;
    return Math.max(0, session.targetMs - getTotalFocusedMs(session, now));
  }

  function getOvertimeMs(session, now) {
    if (!session) return 0;
    return Math.max(0, getTotalFocusedMs(session, now) - session.targetMs);
  }

  function getProgress(session, now) {
    if (!session || !session.targetMs) return 0;
    return clamp(getTotalFocusedMs(session, now) / session.targetMs, 0, 1);
  }

  function isTargetReached(session, now) {
    if (!session) return false;
    return getTotalFocusedMs(session, now) >= session.targetMs;
  }

  /** Finish the current round. Returns the extra rounds + whether a round was counted. */
  function endCurrentRound(session, now) {
    const rounds = (session.rounds || []).slice();
    if (session.phase !== 'running') {
      return { rounds: rounds, roundEnded: false, roundMs: 0 };
    }
    const elapsed = getRoundElapsedMs(session, now);
    if (elapsed < MIN_ROUND_MS) {
      return { rounds: rounds, roundEnded: false, roundMs: 0 };
    }
    const roundMs = Math.round(elapsed);
    rounds.push(makeRound(roundMs));
    return { rounds: rounds, roundEnded: true, roundMs: roundMs };
  }

  /**
   * Pause = stop the current round and count it, but keep the task alive.
   * @returns {{session: object, roundEnded: boolean, roundMs: number}}
   */
  function pauseSession(session, now) {
    if (!session || session.phase !== 'running') {
      return { session: session, roundEnded: false, roundMs: 0 };
    }
    const nowValue = isNum(now) ? now : Date.now();
    const ended = endCurrentRound(session, nowValue);
    return {
      roundEnded: ended.roundEnded,
      roundMs: ended.roundMs,
      session: {
        ...session,
        rounds: ended.rounds,
        phase: 'paused',
        roundElapsedMs: 0,
        roundStartedAt: null,
        savedAt: nowValue,
      },
    };
  }

  /** Resume a paused task by starting a new round. */
  function resumeSession(session, now) {
    if (!session || session.phase !== 'paused') return session;
    const nowValue = isNum(now) ? now : Date.now();
    return {
      ...session,
      phase: 'running',
      roundElapsedMs: 0,
      roundStartedAt: nowValue,
      savedAt: nowValue,
    };
  }

  /**
   * "Next round": finish the current round (counted) and immediately start a new one.
   * When the task is paused, it simply starts the next round.
   * @returns {{session: object, roundEnded: boolean, roundMs: number}}
   */
  function startNextRound(session, now) {
    if (!session) return { session: null, roundEnded: false, roundMs: 0 };
    const nowValue = isNum(now) ? now : Date.now();
    const ended = endCurrentRound(session, nowValue);
    return {
      roundEnded: ended.roundEnded,
      roundMs: ended.roundMs,
      session: {
        ...session,
        rounds: ended.rounds,
        phase: 'running',
        roundElapsedMs: 0,
        roundStartedAt: nowValue,
        savedAt: nowValue,
      },
    };
  }

  /**
   * Finish the task and turn it into a record with actual vs target time.
   * @returns {object|null} record, or null when nothing was focused.
   */
  function completeSession(session, now) {
    if (!session) return null;
    const nowValue = isNum(now) ? now : Date.now();
    const ended = endCurrentRound(session, nowValue);
    const rounds = ended.rounds;
    if (rounds.length === 0) return null;

    const totalFocusedMs = rounds.reduce((sum, r) => sum + roundFocusedMs(r), 0);
    if (totalFocusedMs <= 0) return null;

    return {
      v: VERSION,
      id: makeId('r'),
      taskName: session.taskName,
      targetMs: session.targetMs,
      totalFocusedMs: totalFocusedMs,
      roundsTotal: rounds.length,
      roundsCompleted: rounds.length,
      rounds: rounds.map((r) => Math.round(roundFocusedMs(r))),
      targetReached: totalFocusedMs >= session.targetMs,
      startedAt: session.startedAt,
      endedAt: nowValue,
      dateKey: dateKey(nowValue),
    };
  }

  /** Restore a persisted session after a reload: the open round is closed and counted. */
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
        roundElapsedMs: 0,
        roundStartedAt: null,
        restored: true,
      };
    }
    return session;
  }

  /* ------------------------------------------------------------------ *
   * validation + persistence
   * ------------------------------------------------------------------ */

  function normalizeRound(raw) {
    if (isNum(raw)) return makeRound(raw);
    if (!raw || typeof raw !== 'object') return null;
    if (!isNum(raw.focusedMs) || raw.focusedMs <= 0) return null;
    return makeRound(raw.focusedMs);
  }

  function normalizeSession(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const targetMs = clampTargetMs(raw.targetMs);
    const rounds = Array.isArray(raw.rounds)
      ? raw.rounds.map(normalizeRound).filter(Boolean)
      : [];

    // v1 compatibility: roundComplete becomes paused (the round is already in rounds),
    // and a v1 paused session may carry a partially finished round in roundElapsedMs.
    const rawPhase = raw.phase;
    let phase =
      rawPhase === 'running' ? 'running' : rawPhase === 'paused' || rawPhase === 'roundComplete' ? 'paused' : 'paused';
    let roundElapsedMs = isNum(raw.roundElapsedMs) ? Math.max(0, raw.roundElapsedMs) : 0;

    if (phase === 'paused' && rawPhase !== 'roundComplete' && roundElapsedMs >= MIN_ROUND_MS) {
      rounds.push(makeRound(roundElapsedMs));
      roundElapsedMs = 0;
    }
    if (phase === 'paused') roundElapsedMs = 0;

    return {
      v: VERSION,
      id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('s'),
      taskName:
        typeof raw.taskName === 'string' && raw.taskName.trim()
          ? raw.taskName.trim().slice(0, 60)
          : '专注',
      targetMs: targetMs,
      startedAt: isNum(raw.startedAt) ? raw.startedAt : Date.now(),
      rounds: rounds,
      phase: phase,
      roundElapsedMs: roundElapsedMs,
      roundStartedAt:
        phase === 'running' && isNum(raw.roundStartedAt) ? raw.roundStartedAt : null,
      savedAt: isNum(raw.savedAt) ? raw.savedAt : Date.now(),
      restored: false,
    };
  }

  function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.taskName !== 'string' || !raw.taskName.trim()) return null;
    if (!isNum(raw.endedAt) || !isNum(raw.startedAt)) return null;
    if (!isNum(raw.totalFocusedMs) || raw.totalFocusedMs <= 0) return null;

    const targetMs = clampTargetMs(raw.targetMs);
    const rounds = Array.isArray(raw.rounds)
      ? raw.rounds.map(normalizeRound).filter(Boolean).map((r) => r.focusedMs)
      : [];

    let roundsTotal = Math.max(
      0,
      Math.round(
        isNum(raw.roundsTotal) ? raw.roundsTotal : isNum(raw.roundsCompleted) ? raw.roundsCompleted : rounds.length
      )
    );
    if (roundsTotal === 0) roundsTotal = Math.max(1, rounds.length);

    let roundsCompleted = Math.max(
      0,
      Math.round(isNum(raw.roundsCompleted) ? raw.roundsCompleted : roundsTotal)
    );
    roundsCompleted = Math.min(roundsCompleted, roundsTotal);

    return {
      v: VERSION,
      id: typeof raw.id === 'string' && raw.id ? raw.id : makeId('r'),
      taskName: raw.taskName.trim().slice(0, 60),
      targetMs: targetMs,
      totalFocusedMs: Math.round(raw.totalFocusedMs),
      roundsTotal: roundsTotal,
      roundsCompleted: roundsCompleted,
      rounds: rounds,
      targetReached:
        typeof raw.targetReached === 'boolean'
          ? raw.targetReached
          : raw.totalFocusedMs >= targetMs,
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

  function summarize(records, now) {
    const nowValue = isNum(now) ? now : Date.now();
    const list = Array.isArray(records) ? records : [];
    const byDay = Object.create(null);

    list.forEach((r) => {
      const key = r.dateKey || dateKey(r.endedAt || nowValue);
      const entry = byDay[key] || (byDay[key] = { ms: 0, rounds: 0, sessions: 0 });
      entry.ms += r.totalFocusedMs || 0;
      entry.rounds += r.roundsTotal || 0;
      entry.sessions += 1;
    });

    const today = byDay[dateKey(nowValue)] || { ms: 0, rounds: 0, sessions: 0 };
    let totalMs = 0;
    let totalRounds = 0;
    list.forEach((r) => {
      totalMs += r.totalFocusedMs || 0;
      totalRounds += r.roundsTotal || 0;
    });

    const cursor = new Date(nowValue);
    cursor.setHours(12, 0, 0, 0);
    let streak = 0;
    if (!byDay[dateKey(cursor.getTime())]) {
      cursor.setDate(cursor.getDate() - 1);
    }
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
      last7.push({
        key: key,
        weekday: WEEKDAYS[d.getDay()],
        ms: byDay[key] ? byDay[key].ms : 0,
        isToday: i === 0,
      });
    }

    return {
      todayMs: today.ms,
      todayRounds: today.rounds,
      todaySessions: today.sessions,
      totalMs: totalMs,
      totalRounds: totalRounds,
      totalSessions: list.length,
      streak: streak,
      last7: last7,
    };
  }

  /* ------------------------------------------------------------------ *
   * storage
   * ------------------------------------------------------------------ */

  function safeStorage(storage) {
    if (storage) return storage;
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (err) {
      /* private mode / file restrictions */
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

  function loadRecords(storage) {
    return sanitizeRecords(readJSON(storage, STORAGE_KEYS.records, []));
  }

  function saveRecords(storage, records) {
    return writeJSON(storage, STORAGE_KEYS.records, sanitizeRecords(records));
  }

  function defaultSettings() {
    return { theme: 'dark', sound: true, defaultTargetMs: DEFAULT_TARGET_MS };
  }

  function normalizeSettings(raw) {
    const base = defaultSettings();
    if (!raw || typeof raw !== 'object') return base;
    return {
      theme: raw.theme === 'light' ? 'light' : 'dark',
      sound: raw.sound !== false,
      defaultTargetMs: clampTargetMs(raw.defaultTargetMs),
    };
  }

  function loadSettings(storage) {
    return normalizeSettings(readJSON(storage, STORAGE_KEYS.settings, null));
  }

  function saveSettings(storage, settings) {
    return writeJSON(storage, STORAGE_KEYS.settings, normalizeSettings(settings));
  }

  return {
    VERSION: VERSION,
    STORAGE_KEYS: STORAGE_KEYS,
    MIN_MINUTES: MIN_MINUTES,
    MAX_MINUTES: MAX_MINUTES,
    DEFAULT_TARGET_MS: DEFAULT_TARGET_MS,
    MAX_RECORDS: MAX_RECORDS,
    MIN_ROUND_MS: MIN_ROUND_MS,
    WEEKDAYS: WEEKDAYS,

    clampTargetMs: clampTargetMs,
    formatClock: formatClock,
    formatElapsed: formatElapsed,
    formatSpan: formatSpan,
    minutesLabel: minutesLabel,
    formatTimeOfDay: formatTimeOfDay,
    dateKey: dateKey,
    parseDateKey: parseDateKey,
    formatDayLabel: formatDayLabel,

    createSession: createSession,
    getRoundElapsedMs: getRoundElapsedMs,
    getTotalFocusedMs: getTotalFocusedMs,
    getCompletedRounds: getCompletedRounds,
    getCurrentRoundNumber: getCurrentRoundNumber,
    getTargetRemainingMs: getTargetRemainingMs,
    getOvertimeMs: getOvertimeMs,
    getProgress: getProgress,
    isTargetReached: isTargetReached,
    pauseSession: pauseSession,
    resumeSession: resumeSession,
    startNextRound: startNextRound,
    completeSession: completeSession,
    restoreSession: restoreSession,

    normalizeSession: normalizeSession,
    normalizeRecord: normalizeRecord,
    sanitizeRecords: sanitizeRecords,
    addRecord: addRecord,
    removeRecord: removeRecord,
    groupRecords: groupRecords,
    summarize: summarize,

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
