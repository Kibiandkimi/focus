/*
 * Focus — UI layer (schema v2).
 *
 * Semantics:
 *   - One task has one target duration for the whole task (hint + statistic).
 *   - The clock counts actual focused time UP; reaching the target never stops anything.
 *   - Pause ends the current round and counts it, but the task stays alive.
 *   - Continue / next round starts a new round inside the same task.
 *   - Finishing the task saves actual time and target time into the record.
 *
 * Depends on focus-core.js (window.FocusCore) and index.html.
 */
(function () {
  'use strict';

  const Core = window.FocusCore;
  if (!Core) {
    console.error('[Focus] FocusCore is missing.');
    return;
  }

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  const PRESET_MINUTES = [15, 25, 45, 60];
  const RING_RADIUS = 146;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  const SAVE_INTERVAL_MS = 4000;
  const CONFETTI_COLORS = ['#ffb170', '#ff8258', '#ffd9ad', '#7ee2b8', '#f3efe8', '#ff9d87'];

  const prefersReducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ui = {
    todayLabel: $('#todayLabel'),
    themeToggle: $('#themeToggle'),
    soundToggle: $('#soundToggle'),

    setupView: $('#setupView'),
    setupForm: $('#setupForm'),
    taskInput: $('#taskInput'),
    durationChips: $('#durationChips'),
    durationNote: $('#durationNote'),
    customChip: $('#customChip'),
    customMinutes: $('#customMinutes'),
    startBtn: $('#startBtn'),

    sessionView: $('#sessionView'),
    roundLabel: $('#roundLabel'),
    sessionTask: $('#sessionTask'),
    discardBtn: $('#discardBtn'),
    timerWrap: $('#timerWrap'),
    ringProgress: $('#ringProgress'),
    timeDisplay: $('#timeDisplay'),
    timerPhase: $('#timerPhase'),
    timerSub: $('#timerSub'),
    sessionFocus: $('#sessionFocus'),
    sessionRounds: $('#sessionRounds'),
    sessionProgress: $('#sessionProgress'),
    pauseBtn: $('#pauseBtn'),
    nextBtn: $('#nextBtn'),
    completeBtn: $('#completeBtn'),

    totalNote: $('#totalNote'),
    statTodayTime: $('#statTodayTime'),
    statTodayRounds: $('#statTodayRounds'),
    statStreak: $('#statStreak'),
    weekChart: $('#weekChart'),
    weekTotal: $('#weekTotal'),

    recordsList: $('#recordsList'),
    recordsCount: $('#recordsCount'),
    clearRecords: $('#clearRecords'),

    toastStack: $('#toastStack'),
    modalBackdrop: $('#modalBackdrop'),
    modalTitle: $('#modalTitle'),
    modalBody: $('#modalBody'),
    modalCancel: $('#modalCancel'),
    modalConfirm: $('#modalConfirm'),

    stage: $('.stage'),
    confettiCanvas: $('#confettiCanvas'),
  };

  const state = {
    settings: Core.loadSettings(localStorage),
    records: Core.loadRecords(localStorage),
    session: null,
    setupTargetMs: Core.DEFAULT_TARGET_MS,
    dayKey: '',
    lastSavedAt: 0,
    targetAnnounced: false,
    modal: null,
    lastFocus: null,
    audio: null,
    confetti: null,
  };

  /* ==================================================================== *
   * boot
   * ==================================================================== */

  function init() {
    ui.ringProgress.style.strokeDasharray = `${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`;
    ui.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE);

    applySettings();
    state.dayKey = Core.dateKey(Date.now());
    renderDateLabel();

    const stored = Core.loadSession(localStorage);
    if (stored) {
      state.session = Core.restoreSession(stored, Date.now());
      if (state.session) {
        persistSession();
        state.targetAnnounced = Core.isTargetReached(state.session, Date.now());
      }
    }

    resetSetupForm();
    renderAll();
    bindEvents();
    window.setInterval(tick, 200);

    if (state.session) {
      window.setTimeout(() => {
        toast('已恢复上次专注 · 本轮已结束，任务已暂停');
      }, 500);
    }
  }

  function applySettings() {
    const root = document.documentElement;
    root.dataset.theme = state.settings.theme;

    ui.soundToggle.classList.toggle('is-muted', !state.settings.sound);
    ui.soundToggle.setAttribute('aria-pressed', String(state.settings.sound));
    ui.soundToggle.setAttribute('aria-label', state.settings.sound ? '关闭提示音' : '开启提示音');
    ui.themeToggle.setAttribute(
      'aria-label',
      state.settings.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'
    );

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.settings.theme === 'dark' ? '#0a0b0e' : '#f4f0e9');
  }

  /* ==================================================================== *
   * setup
   * ==================================================================== */

  function resetSetupForm() {
    ui.taskInput.value = '';
    ui.taskInput.classList.remove('is-invalid');
    ui.customMinutes.value = '';
    selectTarget(state.settings.defaultTargetMs);
  }

  function selectTarget(targetMs) {
    state.setupTargetMs = Core.clampTargetMs(targetMs);
    const minutes = Math.round(state.setupTargetMs / 60000);
    const isPreset = PRESET_MINUTES.indexOf(minutes) !== -1;

    $$('.chip[data-minutes]', ui.durationChips).forEach((chip) => {
      const active = isPreset && Number(chip.dataset.minutes) === minutes;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-checked', String(active));
    });

    ui.customChip.classList.toggle('is-active', !isPreset);
    ui.customMinutes.value = isPreset ? '' : String(minutes);
    updateDurationNote();
  }

  function updateDurationNote() {
    const minutes = Math.round(state.setupTargetMs / 60000);
    ui.durationNote.textContent = `整个任务 ${minutes} 分钟`;
    ui.durationNote.classList.remove('is-warning');
  }

  function onCustomInput() {
    const raw = ui.customMinutes.value.trim();
    if (raw === '') {
      selectTarget(state.settings.defaultTargetMs);
      return;
    }
    const minutes = Number(raw);
    const valid = Number.isFinite(minutes) && minutes >= 1 && minutes <= 480;

    $$('.chip[data-minutes]', ui.durationChips).forEach((chip) => {
      chip.classList.remove('is-active');
      chip.setAttribute('aria-checked', 'false');
    });
    ui.customChip.classList.toggle('is-active', valid);
    ui.customChip.classList.remove('is-invalid');

    if (!valid) {
      ui.durationNote.textContent = '需在 1–480 分钟之间';
      ui.durationNote.classList.add('is-warning');
      return;
    }

    state.setupTargetMs = Core.clampTargetMs(minutes * 60000);
    updateDurationNote();
  }

  function onStart(event) {
    event.preventDefault();
    if (state.session) return;

    const taskName = ui.taskInput.value.replace(/\s+/g, ' ').trim();
    if (!taskName) {
      markInvalid(ui.taskInput);
      toast('先写下这个任务要专注做的事');
      ui.taskInput.focus();
      return;
    }

    const customRaw = ui.customMinutes.value.trim();
    let targetMs = state.setupTargetMs;
    if (customRaw) {
      const minutes = Number(customRaw);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) {
        markInvalid(ui.customChip);
        toast('自定义时长需在 1–480 分钟之间');
        ui.customMinutes.focus();
        return;
      }
      targetMs = Math.round(minutes) * 60000;
    }
    targetMs = Core.clampTargetMs(targetMs);

    state.session = Core.createSession({ taskName: taskName, targetMs: targetMs, now: Date.now() });
    state.targetAnnounced = false;
    state.settings.defaultTargetMs = targetMs;
    Core.saveSettings(localStorage, state.settings);
    persistSession();

    renderAll();
    ensureAudio();
    playChime('start');
    toast(`任务开始 · 目标 ${Math.round(targetMs / 60000)} 分钟 · 暂停会结束当前轮`);
    window.setTimeout(() => {
      try {
        ui.sessionView.focus({ preventScroll: true });
      } catch (error) {
        /* older browsers */
      }
    }, 30);
  }

  /* ==================================================================== *
   * task controls
   * ==================================================================== */

  function onPauseToggle() {
    const session = state.session;
    if (!session) return;
    const now = Date.now();

    if (session.phase === 'running') {
      const result = Core.pauseSession(session, now);
      state.session = result.session;
      persistSession();
      renderAll();
      if (result.roundEnded) {
        toast(
          `第 ${result.session.rounds.length} 轮结束 · ${Core.formatSpan(
            result.roundMs
          )} · 任务已暂停`
        );
      } else {
        toast('已暂停 · 继续将开始新一轮');
      }
    } else if (session.phase === 'paused') {
      state.session = Core.resumeSession(session, now);
      persistSession();
      renderAll();
      ensureAudio();
      toast(`第 ${Core.getCurrentRoundNumber(state.session)} 轮开始`);
    }
  }

  function doNextRound() {
    if (!state.session) return;
    const result = Core.startNextRound(state.session, Date.now());
    state.session = result.session;
    persistSession();
    renderAll();
    ensureAudio();
    playChime('start');
    toast(`第 ${Core.getCurrentRoundNumber(state.session)} 轮开始`);
    try {
      ui.sessionView.focus({ preventScroll: true });
    } catch (error) {
      /* ignore */
    }
  }

  function onNextRound() {
    if (!state.session) return;
    doNextRound();
  }

  function onComplete() {
    const session = state.session;
    if (!session) return;

    const record = Core.completeSession(session, Date.now());
    if (!record) {
      openModal({
        title: '结束这个任务？',
        body: '还没有产生专注时长，不会生成记录。',
        confirmText: '结束',
        onConfirm: () => endSession('已结束本次任务'),
      });
      return;
    }

    const actual = Core.formatSpan(record.totalFocusedMs);
    const target = Core.formatSpan(record.targetMs);
    const diff = Math.abs(record.totalFocusedMs - record.targetMs);
    const summary = record.targetReached
      ? `实际专注 ${actual}，已达到目标 ${target}`
      : `实际专注 ${actual}，距目标 ${target} 还差 ${Core.formatSpan(diff)}`;

    openModal({
      title: '完成任务并保存记录？',
      body: `「${record.taskName}」\n${summary} · 共 ${record.roundsTotal} 轮\n保存后会出现在完成记录中。`,
      confirmText: '保存记录',
      onConfirm: () => saveRecord(record),
    });
  }

  function saveRecord(record) {
    state.records = Core.addRecord(state.records, record);
    Core.saveRecords(localStorage, state.records);
    state.session = null;
    state.targetAnnounced = false;
    Core.clearSession(localStorage);

    resetSetupForm();
    renderAll();
    ensureAudio();
    playChime('success');
    celebrate('record');
    toast(
      `已保存 · 实际 ${Core.formatSpan(record.totalFocusedMs)} / 目标 ${Core.formatSpan(
        record.targetMs
      )}`
    );
  }

  function endSession(message) {
    state.session = null;
    state.targetAnnounced = false;
    Core.clearSession(localStorage);
    resetSetupForm();
    renderAll();
    if (message) toast(message);
  }

  function onDiscard() {
    const session = state.session;
    if (!session) return;
    const hasProgress = Core.getTotalFocusedMs(session, Date.now()) >= 1000;

    openModal({
      title: '放弃这个任务？',
      body: hasProgress
        ? '本次任务的实际专注时长不会被保存。\n确定要放弃吗？'
        : '确定要结束这个任务吗？',
      confirmText: '放弃',
      cancelText: '继续任务',
      tone: 'danger',
      onConfirm: () => endSession('已放弃本次任务'),
    });
  }

  function tick() {
    const now = Date.now();
    const currentDay = Core.dateKey(now);
    if (currentDay !== state.dayKey) {
      state.dayKey = currentDay;
      renderDateLabel();
      renderRecords();
    }

    const session = state.session;
    if (!session || session.phase !== 'running') return;

    if (!state.targetAnnounced && Core.isTargetReached(session, now)) {
      state.targetAnnounced = true;
      ensureAudio();
      playChime('target');
      toast(
        `已达到目标 ${Math.round(session.targetMs / 60000)} 分钟 · 计时继续，可随时暂停或完成`
      );
      renderSession();
    }

    if (now - state.lastSavedAt >= SAVE_INTERVAL_MS) persistSession();
    renderTimer();
  }

  function persistSession() {
    if (state.session) {
      Core.saveSession(localStorage, state.session, Date.now());
      state.lastSavedAt = Date.now();
    } else {
      Core.clearSession(localStorage);
    }
  }

  /* ==================================================================== *
   * rendering
   * ==================================================================== */

  function renderAll() {
    renderSession();
    renderTimer();
    renderRecords();
  }

  function renderDateLabel() {
    const now = new Date();
    ui.todayLabel.textContent = `${now.getMonth() + 1}月${now.getDate()}日 · 周${
      Core.WEEKDAYS[now.getDay()]
    }`;
  }

  function renderSession() {
    const session = state.session;
    const hasSession = Boolean(session);

    ui.setupView.classList.toggle('is-hidden', hasSession);
    ui.sessionView.classList.toggle('is-hidden', !hasSession);
    document.body.dataset.view = hasSession ? 'session' : 'idle';

    if (!hasSession) {
      delete document.body.dataset.phase;
      return;
    }

    const now = Date.now();
    const isPaused = session.phase === 'paused';
    const rounds = Core.getCompletedRounds(session);
    const reached = Core.isTargetReached(session, now);

    ui.sessionView.dataset.phase = session.phase;
    ui.sessionView.dataset.targetReached = String(reached);
    document.body.dataset.phase = session.phase;
    document.body.dataset.targetReached = String(reached);

    ui.sessionTask.textContent = session.taskName;
    ui.sessionTask.title = session.taskName;
    ui.roundLabel.textContent = isPaused
      ? rounds > 0
        ? `已完成 ${rounds} 轮 · 已暂停`
        : '任务已暂停'
      : `第 ${Core.getCurrentRoundNumber(session)} 轮 · 专注中`;

    ui.pauseBtn.textContent = isPaused ? '继续' : '暂停';
    ui.pauseBtn.className = 'btn btn-primary';
    ui.pauseBtn.title = isPaused ? '开始新的一轮' : '结束当前轮并暂停任务';
    ui.pauseBtn.setAttribute(
      'aria-label',
      isPaused ? '继续任务，开始新的一轮' : '暂停任务，结束并计入当前轮'
    );

    ui.nextBtn.hidden = isPaused;
    ui.nextBtn.className = 'btn btn-ghost';

    ui.completeBtn.className = 'btn btn-ghost';
  }

  function renderTimer() {
    const session = state.session;
    if (!session) {
      setDocumentTitle('Focus · 专注计时');
      return;
    }

    const now = Date.now();
    const total = Core.getTotalFocusedMs(session, now);
    const progress = Core.getProgress(session, now);
    const reached = Core.isTargetReached(session, now);
    const clock = Core.formatElapsed(total);

    if (ui.timeDisplay.textContent !== clock) ui.timeDisplay.textContent = clock;
    ui.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));

    ui.sessionView.dataset.targetReached = String(reached);
    document.body.dataset.targetReached = String(reached);

    ui.timerPhase.textContent =
      session.phase === 'paused' ? '已暂停' : reached ? '目标已达成' : '专注中';
    ui.timerSub.textContent = timerSubText(session, now);
    ui.sessionFocus.textContent = formatSessionFocus(total);
    ui.sessionRounds.textContent = `${Core.getCompletedRounds(session)} 轮`;
    ui.sessionProgress.textContent = `${Math.round(progress * 100)}%`;

    if (session.phase === 'paused') {
      setDocumentTitle(`⏸ ${clock} · ${session.taskName}`);
    } else {
      setDocumentTitle(`${clock} · ${session.taskName}`);
    }
  }

  function timerSubText(session, now) {
    const target = `${Math.round(session.targetMs / 60000)} 分钟`;
    const overtime = Core.getOvertimeMs(session, now);
    if (overtime >= 1000) return `目标 ${target} · 已超出 ${Core.formatClock(overtime)}`;
    return `目标 ${target} · 还剩 ${Core.formatClock(Core.getTargetRemainingMs(session, now))}`;
  }

  function formatSessionFocus(ms) {
    if (ms < 60000) return `${Math.max(0, Math.floor(ms / 1000))} 秒`;
    return `${Core.minutesLabel(ms)} 分钟`;
  }

  function setDocumentTitle(title) {
    if (document.title !== title) document.title = title;
  }

  function renderRecords() {
    const now = Date.now();
    const summary = Core.summarize(state.records, now);
    const weekMs = summary.last7.reduce((sum, day) => sum + day.ms, 0);

    ui.statTodayTime.textContent = Core.minutesLabel(summary.todayMs);
    ui.statTodayRounds.textContent = String(summary.todayRounds);
    ui.statStreak.textContent = String(summary.streak);
    ui.totalNote.textContent =
      summary.todaySessions > 0 ? `今天 ${summary.todaySessions} 次任务` : '今天还没有记录';
    ui.weekTotal.textContent = weekMs > 0 ? `共 ${Core.formatSpan(weekMs)}` : '暂无记录';

    ui.recordsCount.textContent = String(state.records.length);
    ui.clearRecords.hidden = state.records.length === 0;

    renderWeekChart(summary.last7);
    renderRecordsList(now);
  }

  function renderWeekChart(days) {
    ui.weekChart.textContent = '';
    const max = Math.max.apply(null, days.map((day) => day.ms).concat([1]));

    days.forEach((day) => {
      const column = document.createElement('div');
      column.className =
        'week-col' + (day.isToday ? ' is-today' : '') + (day.ms === 0 ? ' is-empty' : '');
      column.title = `${shortDate(day.key)} · ${day.ms > 0 ? Core.formatSpan(day.ms) : '无记录'}`;

      const bar = document.createElement('div');
      bar.className = 'week-bar';
      const fill = document.createElement('i');
      const percent = day.ms > 0 ? Math.max(8, Math.round((day.ms / max) * 100)) : 0;
      fill.style.height = `${percent}%`;
      bar.appendChild(fill);

      const label = document.createElement('span');
      label.className = 'week-day';
      label.textContent = day.weekday;

      column.appendChild(bar);
      column.appendChild(label);
      ui.weekChart.appendChild(column);
    });
  }

  function renderRecordsList(now) {
    ui.recordsList.textContent = '';

    if (state.records.length === 0) {
      ui.recordsList.appendChild(createEmptyState());
      return;
    }

    Core.groupRecords(state.records).forEach((group) => {
      const section = document.createElement('section');
      section.className = 'record-group';

      const header = document.createElement('div');
      header.className = 'record-date';
      const date = Core.parseDateKey(group.key);
      header.textContent =
        Core.formatDayLabel(group.key, now) +
        (date ? ` · 周${Core.WEEKDAYS[date.getDay()]}` : '');
      section.appendChild(header);

      group.records.forEach((record) => {
        section.appendChild(createRecordNode(record));
      });

      ui.recordsList.appendChild(section);
    });
  }

  function createRecordNode(record) {
    const item = document.createElement('article');
    item.className = 'record';
    item.dataset.id = record.id;

    const dot = document.createElement('span');
    dot.className = 'record-dot';
    dot.setAttribute('aria-hidden', 'true');

    const main = document.createElement('div');
    main.className = 'record-main';

    const task = document.createElement('p');
    task.className = 'record-task';
    task.textContent = record.taskName;
    task.title = record.taskName;

    const meta = document.createElement('p');
    meta.className = 'record-meta';
    meta.textContent = `${Core.formatTimeOfDay(record.startedAt)} – ${Core.formatTimeOfDay(
      record.endedAt
    )} · ${record.roundsTotal} 轮`;

    const targetLine = document.createElement('p');
    targetLine.className = 'record-target';
    targetLine.textContent = `实际 ${Core.formatSpan(record.totalFocusedMs)} / 目标 ${Core.formatSpan(
      record.targetMs
    )}`;

    const meter = document.createElement('div');
    meter.className = 'record-meter';
    if (record.totalFocusedMs >= record.targetMs) meter.classList.add('is-reached');
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(
      100,
      Math.max(2, Math.round((record.totalFocusedMs / record.targetMs) * 100))
    )}%`;
    meter.appendChild(fill);

    main.appendChild(task);
    main.appendChild(meta);
    main.appendChild(targetLine);
    main.appendChild(meter);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'record-delete';
    remove.setAttribute('aria-label', `删除「${record.taskName}」的记录`);
    remove.title = '删除记录';
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

    item.appendChild(dot);
    item.appendChild(main);
    item.appendChild(remove);
    return item;
  }

  function createEmptyState() {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML =
      '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
      '<circle cx="24" cy="24" r="17" opacity=".55"/>' +
      '<path d="M24 14v10l7 5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>' +
      '<div class="empty-title">还没有完成记录</div>' +
      '<div class="empty-hint">完成一个任务后，实际时长与目标时长会记录在这里。</div>';
    return empty;
  }

  function shortDate(key) {
    const date = Core.parseDateKey(key);
    return date ? `${date.getMonth() + 1}/${date.getDate()}` : '';
  }

  /* ==================================================================== *
   * records actions
   * ==================================================================== */

  function deleteRecord(id) {
    const record = state.records.filter((item) => item.id === id)[0];
    if (!record) return;

    state.records = Core.removeRecord(state.records, id);
    Core.saveRecords(localStorage, state.records);
    renderRecords();

    toast(`已删除「${record.taskName}」的记录`, {
      actionLabel: '撤销',
      duration: 7000,
      onAction: () => {
        state.records = Core.addRecord(state.records, record);
        Core.saveRecords(localStorage, state.records);
        renderRecords();
        toast('已恢复记录');
      },
    });
  }

  function onClearRecords() {
    if (state.records.length === 0) return;
    openModal({
      title: '清空全部完成记录？',
      body: `将删除 ${state.records.length} 条专注记录，此操作不可撤销。`,
      confirmText: '清空记录',
      tone: 'danger',
      onConfirm: () => {
        state.records = [];
        Core.saveRecords(localStorage, []);
        renderRecords();
        toast('已清空完成记录');
      },
    });
  }

  /* ==================================================================== *
   * theme / sound
   * ==================================================================== */

  function onThemeToggle() {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    applySettings();
    Core.saveSettings(localStorage, state.settings);
  }

  function onSoundToggle() {
    state.settings.sound = !state.settings.sound;
    applySettings();
    Core.saveSettings(localStorage, state.settings);
    if (state.settings.sound) {
      ensureAudio();
      playChime('start');
      toast('提示音已开启');
    } else {
      toast('提示音已关闭');
    }
  }

  /* ==================================================================== *
   * modal
   * ==================================================================== */

  function openModal(options) {
    state.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.modal = options;

    ui.modalTitle.textContent = options.title || '确认';
    ui.modalBody.textContent = options.body || '';
    ui.modalConfirm.textContent = options.confirmText || '确定';
    ui.modalCancel.textContent = options.cancelText || '取消';
    ui.modalConfirm.className = 'btn ' + (options.tone === 'danger' ? 'btn-danger' : 'btn-primary');
    ui.modalBackdrop.classList.remove('is-hidden');

    window.requestAnimationFrame(() => {
      try {
        ui.modalConfirm.focus();
      } catch (error) {
        /* ignore */
      }
    });
  }

  function closeModal() {
    if (!state.modal) return;
    state.modal = null;
    ui.modalBackdrop.classList.add('is-hidden');

    const target = state.lastFocus;
    state.lastFocus = null;
    if (target && document.contains(target) && typeof target.focus === 'function') {
      try {
        target.focus({ preventScroll: true });
      } catch (error) {
        /* ignore */
      }
    }
  }

  function confirmModal() {
    const onConfirm = state.modal && state.modal.onConfirm;
    closeModal();
    if (typeof onConfirm === 'function') onConfirm();
  }

  function trapModalFocus(event) {
    const focusables = [ui.modalCancel, ui.modalConfirm].filter((node) => node && !node.disabled);
    if (focusables.length === 0) return;
    const index = focusables.indexOf(document.activeElement);

    if (event.shiftKey) {
      if (index <= 0) {
        event.preventDefault();
        focusables[focusables.length - 1].focus();
      }
    } else if (index === focusables.length - 1) {
      event.preventDefault();
      focusables[0].focus();
    }
  }

  /* ==================================================================== *
   * toast
   * ==================================================================== */

  function toast(message, options) {
    const settings = options || {};
    const node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status');

    const text = document.createElement('span');
    text.textContent = message;
    node.appendChild(text);

    let timer = null;
    let dismissed = false;

    function dismiss(fromAction) {
      if (dismissed || !node.isConnected) return;
      dismissed = true;
      window.clearTimeout(timer);
      node.classList.add('is-leaving');
      window.setTimeout(() => node.remove(), 220);
      if (fromAction && typeof settings.onAction === 'function') settings.onAction();
    }

    if (settings.actionLabel) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'toast-action';
      action.textContent = settings.actionLabel;
      action.addEventListener('click', () => dismiss(true));
      node.appendChild(action);
    }

    ui.toastStack.appendChild(node);
    while (ui.toastStack.children.length > 3) {
      ui.toastStack.firstElementChild.remove();
    }
    timer = window.setTimeout(() => dismiss(false), settings.duration || 4200);
  }

  /* ==================================================================== *
   * sound
   * ==================================================================== */

  function ensureAudio() {
    if (!state.settings.sound) return;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;

    if (!state.audio) {
      try {
        state.audio = new AudioCtor();
      } catch (error) {
        state.audio = null;
        return;
      }
    }
    if (state.audio.state === 'suspended' && typeof state.audio.resume === 'function') {
      state.audio.resume().catch(() => {});
    }
  }

  function playChime(kind) {
    if (!state.settings.sound || !state.audio) return;
    const audio = state.audio;
    const notes =
      kind === 'record'
        ? [523.25, 659.25, 783.99, 1046.5]
        : kind === 'target'
        ? [659.25, 880, 1046.5]
        : [523.25, 659.25];
    const amplitude = kind === 'start' ? 0.05 : 0.1;
    const baseline = audio.currentTime + 0.02;

    notes.forEach((frequency, index) => {
      const start = baseline + index * (kind === 'record' ? 0.105 : 0.12);
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(amplitude, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.55);
    });
  }

  /* ==================================================================== *
   * confetti
   * ==================================================================== */

  function getConfettiContext() {
    const canvas = ui.confettiCanvas;
    if (!canvas) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(window.innerWidth * dpr));
    const height = Math.max(1, Math.round(window.innerHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    }
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return context;
  }

  function celebrate(kind) {
    if (prefersReducedMotion) return;
    const context = getConfettiContext();
    if (!context) return;

    if (!state.confetti) state.confetti = { particles: [], raf: 0 };

    let originX = window.innerWidth / 2;
    let originY = window.innerHeight * 0.42;
    const visibleCard = ui.stage && ui.stage.querySelector('.card:not(.is-hidden)');
    if (visibleCard) {
      const rect = visibleCard.getBoundingClientRect();
      originX = rect.left + rect.width / 2;
      originY = rect.top + rect.height * 0.4;
    }

    const count = kind === 'record' ? 130 : 55;
    for (let i = 0; i < count; i += 1) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const speed = 4 + Math.random() * 8;
      state.confetti.particles.push({
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed * (0.7 + Math.random() * 0.7),
        vy: Math.sin(angle) * speed * 0.85 - 3 - Math.random() * 3,
        size: 3 + Math.random() * 5,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
        life: 1,
        decay: 0.01 + Math.random() * 0.012,
        shape: Math.random() > 0.55 ? 'rect' : 'circle',
      });
    }

    if (!state.confetti.raf) {
      state.confetti.raf = window.requestAnimationFrame(stepConfetti);
    }
  }

  function stepConfetti() {
    const confetti = state.confetti;
    if (!confetti) return;
    const context = getConfettiContext();
    if (!context) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    context.clearRect(0, 0, width, height);

    confetti.particles = confetti.particles.filter(
      (particle) => particle.life > 0 && particle.y < height + 50
    );

    confetti.particles.forEach((particle) => {
      particle.vy += 0.14;
      particle.vx *= 0.995;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.rotation += particle.spin;
      particle.life -= particle.decay;

      context.save();
      context.globalAlpha = Math.max(0, Math.min(1, particle.life * 1.8));
      context.translate(particle.x, particle.y);
      context.rotate(particle.rotation);
      context.fillStyle = particle.color;

      if (particle.shape === 'rect') {
        context.fillRect(-particle.size / 2, -particle.size / 4, particle.size, particle.size / 2);
      } else {
        context.beginPath();
        context.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    });

    if (confetti.particles.length > 0) {
      confetti.raf = window.requestAnimationFrame(stepConfetti);
    } else {
      context.clearRect(0, 0, width, height);
      confetti.raf = 0;
    }
  }

  /* ==================================================================== *
   * events
   * ==================================================================== */

  function bindEvents() {
    ui.setupForm.addEventListener('submit', onStart);

    ui.taskInput.addEventListener('input', () => {
      ui.taskInput.classList.remove('is-invalid');
    });

    ui.durationChips.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip[data-minutes]');
      if (!chip) return;
      ui.customMinutes.value = '';
      ui.customChip.classList.remove('is-invalid');
      selectTarget(Number(chip.dataset.minutes) * 60000);
    });

    ui.customMinutes.addEventListener('input', onCustomInput);
    ui.customMinutes.addEventListener('focus', () => {
      ui.customMinutes.select();
    });

    ui.pauseBtn.addEventListener('click', onPauseToggle);
    ui.nextBtn.addEventListener('click', onNextRound);
    ui.completeBtn.addEventListener('click', onComplete);
    ui.discardBtn.addEventListener('click', onDiscard);

    ui.recordsList.addEventListener('click', (event) => {
      const button = event.target.closest('.record-delete');
      if (!button) return;
      const item = button.closest('.record');
      if (item && item.dataset.id) deleteRecord(item.dataset.id);
    });

    ui.clearRecords.addEventListener('click', onClearRecords);
    ui.themeToggle.addEventListener('click', onThemeToggle);
    ui.soundToggle.addEventListener('click', onSoundToggle);

    ui.modalCancel.addEventListener('click', closeModal);
    ui.modalConfirm.addEventListener('click', confirmModal);
    ui.modalBackdrop.addEventListener('click', (event) => {
      if (event.target === ui.modalBackdrop) closeModal();
    });

    document.addEventListener('keydown', onKeydown);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.session) {
        tick();
        renderTimer();
      }
    });

    window.addEventListener('storage', (event) => {
      if (!event.key || event.key === Core.STORAGE_KEYS.records) {
        state.records = Core.loadRecords(localStorage);
        renderRecords();
      }
    });

    window.addEventListener('beforeunload', () => {
      if (state.session) persistSession();
    });
  }

  function onKeydown(event) {
    if (state.modal) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
      } else if (event.key === 'Tab') {
        trapModalFocus(event);
      }
      return;
    }

    const target = event.target;
    if (target && target.closest) {
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!state.session) return;

    const onButton = target && target.closest && target.closest('button, a[href]');
    if (onButton) return;

    if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault();
      onPauseToggle();
    } else if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      onNextRound();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onComplete();
    }
  }

  function markInvalid(element) {
    if (!element) return;
    element.classList.remove('is-invalid');
    void element.offsetWidth;
    element.classList.add('is-invalid');
    window.setTimeout(() => element.classList.remove('is-invalid'), 700);
  }

  init();
})();
