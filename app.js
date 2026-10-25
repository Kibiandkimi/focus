/*
 * Focus — UI layer (schema v3).
 *
 * Task model:
 *   - Tasks are todo items with an expected completion duration and a planned
 *     focus duration per round.
 *   - A focus session consists of focus rounds. Pause ends/counts a round and
 *     keeps the task active; resume starts the next round.
 *   - Task duration = sum of actual focus time across rounds (pauses excluded).
 *   - Focus metrics = per-round planned vs actual focused time, average per round.
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

  const TASK_PRESETS = [30, 60, 120, 240]; // minutes
  const FOCUS_PRESETS = [15, 25, 45, 60]; // minutes
  const RING_RADIUS = 146;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  const SAVE_INTERVAL_MS = 4000;
  const DELTA_EPSILON_MS = 30000;
  const CONFETTI_COLORS = ['#ffb170', '#ff8258', '#ffd9ad', '#7ee2b8', '#f3efe8', '#ff9d87'];

  const prefersReducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ui = {
    todayLabel: $('#todayLabel'),
    themeToggle: $('#themeToggle'),
    soundToggle: $('#soundToggle'),

    tasksView: $('#tasksView'),
    tasksHeadline: $('#tasksHeadline'),
    taskForm: $('#taskForm'),
    taskTitleInput: $('#taskTitleInput'),
    taskExpectedChips: $('#taskExpectedChips'),
    taskExpectedNote: $('#taskExpectedNote'),
    taskCustomChip: $('#taskCustomChip'),
    taskCustomMinutes: $('#taskCustomMinutes'),
    focusExpectedChips: $('#focusExpectedChips'),
    focusExpectedNote: $('#focusExpectedNote'),
    focusCustomChip: $('#focusCustomChip'),
    focusCustomMinutes: $('#focusCustomMinutes'),
    addTaskBtn: $('#addTaskBtn'),
    taskList: $('#taskList'),
    taskCount: $('#taskCount'),
    taskListNote: $('#taskListNote'),

    sessionView: $('#sessionView'),
    roundLabel: $('#roundLabel'),
    sessionTask: $('#sessionTask'),
    sessionTaskMeta: $('#sessionTaskMeta'),
    discardBtn: $('#discardBtn'),
    timerWrap: $('#timerWrap'),
    ringProgress: $('#ringProgress'),
    timeDisplay: $('#timeDisplay'),
    timerPhase: $('#timerPhase'),
    timerSub: $('#timerSub'),
    sessionRoundFocus: $('#sessionRoundFocus'),
    sessionAvgFocus: $('#sessionAvgFocus'),
    sessionTaskElapsed: $('#sessionTaskElapsed'),
    sessionRounds: $('#sessionRounds'),
    nextFocusPanel: $('#nextFocusPanel'),
    nextFocusChips: $('#nextFocusChips'),
    nextFocusNote: $('#nextFocusNote'),
    nextCustomChip: $('#nextCustomChip'),
    nextCustomMinutes: $('#nextCustomMinutes'),
    pauseBtn: $('#pauseBtn'),
    nextBtn: $('#nextBtn'),
    completeBtn: $('#completeBtn'),
    backToListBtn: $('#backToListBtn'),

    totalNote: $('#totalNote'),
    statTodayFocus: $('#statTodayFocus'),
    statAvgFocus: $('#statAvgFocus'),
    statAvgFocusNote: $('#statAvgFocusNote'),
    statTodayTasks: $('#statTodayTasks'),
    statTodayTasksNote: $('#statTodayTasksNote'),
    statStreak: $('#statStreak'),
    effTaskActual: $('#effTaskActual'),
    effTaskExpected: $('#effTaskExpected'),
    effTaskDelta: $('#effTaskDelta'),
    effFocusActual: $('#effFocusActual'),
    effFocusExpected: $('#effFocusExpected'),
    effFocusDelta: $('#effFocusDelta'),
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
    tasks: Core.loadTasks(localStorage),
    records: Core.loadRecords(localStorage),
    session: null,
    view: 'tasks', // 'tasks' | 'session'
    form: { taskMs: 0, focusMs: 0 },
    roundAnnounced: false,
    dayKey: '',
    lastSavedAt: 0,
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
    initTaskForm();

    const stored = Core.loadSession(localStorage);
    if (stored) {
      state.session = Core.restoreSession(stored, Date.now());
      if (state.session) {
        ensureSessionTask();
        persistSession();
        state.view = 'session';
      }
    }

    bindEvents();
    renderAll();
    window.setInterval(tick, 200);

    if (state.session) {
      window.setTimeout(() => {
        toast('已恢复上次专注 · 本轮已结束，任务处于暂停状态');
      }, 500);
    }
  }

  function ensureSessionTask() {
    if (!state.session) return;
    if (Core.findTask(state.tasks, state.session.taskId)) return;
    const task = Core.createTask({
      title: state.session.taskTitle,
      expectedTaskMs: state.session.taskExpectedMs,
      expectedFocusMs: state.session.expectedFocusMs,
      now: state.session.startedAt,
    });
    task.id = state.session.taskId;
    state.tasks = Core.addTask(state.tasks, task);
    Core.saveTasks(localStorage, state.tasks);
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
   * task creation form
   * ==================================================================== */

  function initTaskForm() {
    state.form.taskMs = Core.clampExpectedTaskMs(state.settings.defaultExpectedTaskMs);
    state.form.focusMs = Core.clampExpectedFocusMs(state.settings.defaultExpectedFocusMs);
    syncTaskForm();
  }

  function syncTaskForm() {
    const taskMinutes = Math.round(state.form.taskMs / 60000);
    const focusMinutes = Math.round(state.form.focusMs / 60000);

    $$('.chip[data-task-minutes]', ui.taskExpectedChips).forEach((chip) => {
      const active = Number(chip.dataset.taskMinutes) === taskMinutes;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-checked', String(active));
    });
    ui.taskCustomChip.classList.toggle('is-active', TASK_PRESETS.indexOf(taskMinutes) === -1);
    ui.taskCustomMinutes.value =
      TASK_PRESETS.indexOf(taskMinutes) === -1 ? String(taskMinutes) : '';
    ui.taskExpectedNote.textContent = Core.formatSpan(state.form.taskMs);
    ui.taskExpectedNote.classList.remove('is-warning');

    $$('.chip[data-focus-minutes]', ui.focusExpectedChips).forEach((chip) => {
      const active = Number(chip.dataset.focusMinutes) === focusMinutes;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-checked', String(active));
    });
    ui.focusCustomChip.classList.toggle('is-active', FOCUS_PRESETS.indexOf(focusMinutes) === -1);
    ui.focusCustomMinutes.value =
      FOCUS_PRESETS.indexOf(focusMinutes) === -1 ? String(focusMinutes) : '';
    ui.focusExpectedNote.textContent = Core.formatSpan(state.form.focusMs);
    ui.focusExpectedNote.classList.remove('is-warning');
  }

  function onTaskCustomInput() {
    const raw = ui.taskCustomMinutes.value.trim();
    if (raw === '') {
      state.form.taskMs = Core.clampExpectedTaskMs(state.settings.defaultExpectedTaskMs);
      syncTaskForm();
      return;
    }
    const minutes = Number(raw);
    const valid =
      Number.isInteger(minutes) && minutes >= Core.MIN_TASK_MINUTES && minutes <= Core.MAX_TASK_MINUTES;
    $$('.chip[data-task-minutes]', ui.taskExpectedChips).forEach((chip) => {
      chip.classList.remove('is-active');
      chip.setAttribute('aria-checked', 'false');
    });
    ui.taskCustomChip.classList.toggle('is-active', valid);
    if (!valid) {
      ui.taskExpectedNote.textContent = `需在 ${Core.MIN_TASK_MINUTES}–${Core.MAX_TASK_MINUTES} 分钟之间`;
      ui.taskExpectedNote.classList.add('is-warning');
      return;
    }
    state.form.taskMs = Core.clampExpectedTaskMs(minutes * 60000);
    ui.taskExpectedNote.textContent = Core.formatSpan(state.form.taskMs);
    ui.taskExpectedNote.classList.remove('is-warning');
  }

  function onFocusCustomInput() {
    const raw = ui.focusCustomMinutes.value.trim();
    if (raw === '') {
      state.form.focusMs = Core.clampExpectedFocusMs(state.settings.defaultExpectedFocusMs);
      syncTaskForm();
      return;
    }
    const minutes = Number(raw);
    const valid =
      Number.isInteger(minutes) &&
      minutes >= Core.MIN_FOCUS_MINUTES &&
      minutes <= Core.MAX_FOCUS_MINUTES;
    $$('.chip[data-focus-minutes]', ui.focusExpectedChips).forEach((chip) => {
      chip.classList.remove('is-active');
      chip.setAttribute('aria-checked', 'false');
    });
    ui.focusCustomChip.classList.toggle('is-active', valid);
    if (!valid) {
      ui.focusExpectedNote.textContent = `需在 ${Core.MIN_FOCUS_MINUTES}–${Core.MAX_FOCUS_MINUTES} 分钟之间`;
      ui.focusExpectedNote.classList.add('is-warning');
      return;
    }
    state.form.focusMs = Core.clampExpectedFocusMs(minutes * 60000);
    ui.focusExpectedNote.textContent = Core.formatSpan(state.form.focusMs);
    ui.focusExpectedNote.classList.remove('is-warning');
  }

  function onAddTask(event) {
    event.preventDefault();

    const title = ui.taskTitleInput.value.replace(/\s+/g, ' ').trim();
    if (!title) {
      markInvalid(ui.taskTitleInput);
      toast('先写下任务名称');
      ui.taskTitleInput.focus();
      return;
    }

    let expectedTaskMs = state.form.taskMs;
    let expectedFocusMs = state.form.focusMs;
    const taskRaw = ui.taskCustomMinutes.value.trim();
    const focusRaw = ui.focusCustomMinutes.value.trim();

    if (taskRaw !== '') {
      const minutes = Number(taskRaw);
      if (!Number.isInteger(minutes) || minutes < Core.MIN_TASK_MINUTES || minutes > Core.MAX_TASK_MINUTES) {
        markInvalid(ui.taskCustomChip);
        toast(`预期完成时长需在 ${Core.MIN_TASK_MINUTES}–${Core.MAX_TASK_MINUTES} 分钟之间`);
        ui.taskCustomMinutes.focus();
        return;
      }
      expectedTaskMs = minutes * 60000;
    }
    if (focusRaw !== '') {
      const minutes = Number(focusRaw);
      if (!Number.isInteger(minutes) || minutes < Core.MIN_FOCUS_MINUTES || minutes > Core.MAX_FOCUS_MINUTES) {
        markInvalid(ui.focusCustomChip);
        toast(`单轮预期专注需在 ${Core.MIN_FOCUS_MINUTES}–${Core.MAX_FOCUS_MINUTES} 分钟之间`);
        ui.focusCustomMinutes.focus();
        return;
      }
      expectedFocusMs = minutes * 60000;
    }

    const task = Core.createTask({
      title: title,
      expectedTaskMs: expectedTaskMs,
      expectedFocusMs: expectedFocusMs,
      now: Date.now(),
    });
    state.tasks = Core.addTask(state.tasks, task);
    Core.saveTasks(localStorage, state.tasks);

    state.settings.defaultExpectedTaskMs = Core.clampExpectedTaskMs(expectedTaskMs);
    state.settings.defaultExpectedFocusMs = Core.clampExpectedFocusMs(expectedFocusMs);
    Core.saveSettings(localStorage, state.settings);

    ui.taskTitleInput.value = '';
    ui.taskTitleInput.classList.remove('is-invalid');
    syncTaskForm();
    renderTasks();
    toast(
      `已添加任务 · 预期完成 ${Core.formatSpan(expectedTaskMs)} · 单轮专注 ${Core.formatSpan(
        expectedFocusMs
      )}`
    );
    ui.taskTitleInput.focus();
  }

  /* ==================================================================== *
   * task list
   * ==================================================================== */

  function renderTasks() {
    const session = state.session;
    const ordered = state.tasks.slice();

    if (session) {
      const index = ordered.findIndex((task) => task.id === session.taskId);
      if (index > 0) {
        const [active] = ordered.splice(index, 1);
        ordered.unshift(active);
      } else if (index === -1) {
        ordered.unshift({
          id: session.taskId,
          title: session.taskTitle,
          expectedTaskMs: session.taskExpectedMs,
          expectedFocusMs: session.expectedFocusMs,
          createdAt: session.startedAt,
        });
      }
    }

    ui.taskList.textContent = '';
    ui.taskCount.textContent = String(state.tasks.length);
    ui.taskListNote.textContent = ordered.length > 0 ? '按创建时间' : '还没有任务';

    if (ordered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty task-empty';
      empty.innerHTML =
        '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
        '<rect x="10" y="9" width="28" height="32" rx="6" opacity=".55"/>' +
        '<path d="M17 18h14M17 25h14M17 32h8" stroke-linecap="round"/>' +
        '</svg>' +
        '<div class="empty-title">还没有待办任务</div>' +
        '<div class="empty-hint">在上方添加任务，设定预期完成时长与单轮专注时长。</div>';
      ui.taskList.appendChild(empty);
      return;
    }

    ordered.forEach((task) => {
      const isActive = Boolean(session && session.taskId === task.id);
      const blocked = Boolean(session && !isActive);
      const row = document.createElement('article');
      row.className = 'task-row' + (isActive ? ' is-active' : '');
      row.dataset.id = task.id;

      const main = document.createElement('div');
      main.className = 'task-row-main';

      const title = document.createElement('p');
      title.className = 'task-row-title';
      title.textContent = task.title;
      title.title = task.title;

      const meta = document.createElement('p');
      meta.className = 'task-row-meta';
      meta.textContent = `预期完成 ${Core.formatSpan(task.expectedTaskMs)} · 单轮专注 ${Core.formatSpan(
        task.expectedFocusMs
      )}`;

      main.appendChild(title);
      main.appendChild(meta);

      if (isActive) {
        const progress = document.createElement('p');
        progress.className = 'task-row-progress';
        const rounds = Core.getCompletedRounds(session);
        const focusTotal = Core.getFocusTotalMs(session);
        progress.textContent =
          rounds > 0
            ? `暂停中 · 已专注 ${Core.formatSpan(focusTotal)} · ${rounds} 轮`
            : '暂停中 · 尚未产生专注轮次';
        main.appendChild(progress);
      }

      const actions = document.createElement('div');
      actions.className = 'task-row-actions';

      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'btn btn-small btn-primary task-start' + (blocked ? ' is-disabled' : '');
      start.textContent = isActive ? '继续专注' : '开始专注';
      if (blocked) {
        start.setAttribute('aria-disabled', 'true');
        start.title = '请先完成或结束当前任务';
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn task-delete';
      remove.setAttribute('aria-label', `删除任务「${task.title}」`);
      remove.title = '删除任务';
      remove.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

      actions.appendChild(start);
      actions.appendChild(remove);
      row.appendChild(main);
      row.appendChild(actions);
      ui.taskList.appendChild(row);
    });
  }

  function onTaskListClick(event) {
    const row = event.target.closest('.task-row');
    if (!row) return;
    const task = Core.findTask(state.tasks, row.dataset.id);
    if (!task) return;

    if (event.target.closest('.task-delete')) {
      deleteTask(task);
      return;
    }

    const start = event.target.closest('.task-start');
    if (!start) return;
    if (start.classList.contains('is-disabled')) {
      toast('请先完成或结束当前任务，再开始其他任务');
      return;
    }
    openStartModal(task);
  }

  function deleteTask(task) {
    const active = Boolean(state.session && state.session.taskId === task.id);
    openModal({
      title: '删除任务？',
      body: active
        ? '该任务正在专注中。删除会结束当前专注，且不会生成完成记录。'
        : '任务会从待办清单移除，不会生成完成记录。',
      confirmText: '删除',
      tone: 'danger',
      onConfirm: () => {
        state.tasks = Core.removeTask(state.tasks, task.id);
        Core.saveTasks(localStorage, state.tasks);
        if (active) {
          state.session = null;
          Core.clearSession(localStorage);
          state.view = 'tasks';
        }
        renderAll();
        toast('已删除任务');
      },
    });
  }

  /* ==================================================================== *
   * start focus modal
   * ==================================================================== */

  function openStartModal(task) {
    const isResume = Boolean(state.session && state.session.taskId === task.id);
    if (state.session && !isResume) {
      toast('请先完成或结束当前任务');
      return;
    }

    const defaultMs = isResume ? state.session.nextExpectedFocusMs : task.expectedFocusMs;
    let selectedMs = Core.clampExpectedFocusMs(defaultMs);

    const wrap = document.createElement('div');
    wrap.className = 'start-modal';

    const name = document.createElement('p');
    name.className = 'start-task-name';
    name.textContent = `「${task.title}」`;

    const meta = document.createElement('p');
    meta.className = 'start-task-meta';
    meta.textContent = `预期完成 ${Core.formatSpan(task.expectedTaskMs)} · 计划单轮专注 ${Core.formatSpan(
      task.expectedFocusMs
    )}`;
    wrap.appendChild(name);
    wrap.appendChild(meta);

    if (isResume) {
      const progress = document.createElement('p');
      progress.className = 'start-task-meta';
      progress.textContent = `已专注 ${Core.formatSpan(
        Core.getFocusTotalMs(state.session)
      )} · ${Core.getCompletedRounds(state.session)} 轮 · 任务暂停中`;
      wrap.appendChild(progress);
    }

    const labelRow = document.createElement('div');
    labelRow.className = 'field-label-row start-focus-label';
    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = '本轮预期专注时长';
    const note = document.createElement('span');
    note.className = 'field-note';
    labelRow.appendChild(label);
    labelRow.appendChild(note);
    wrap.appendChild(labelRow);

    const chips = document.createElement('div');
    chips.className = 'chips chips-compact';
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', '本轮预期专注时长');

    const presetButtons = [];
    FOCUS_PRESETS.forEach((minutes) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.dataset.minutes = String(minutes);
      button.setAttribute('role', 'radio');
      button.textContent = `${minutes} 分钟`;
      button.addEventListener('click', () => {
        selectedMs = minutes * 60000;
        customInput.value = '';
        sync();
      });
      presetButtons.push(button);
      chips.appendChild(button);
    });

    const customChip = document.createElement('div');
    customChip.className = 'chip chip-custom';
    const customInput = document.createElement('input');
    customInput.type = 'number';
    customInput.min = String(Core.MIN_FOCUS_MINUTES);
    customInput.max = String(Core.MAX_FOCUS_MINUTES);
    customInput.step = '1';
    customInput.inputMode = 'numeric';
    customInput.placeholder = '自定义';
    customInput.setAttribute('aria-label', '自定义本轮预期专注分钟数');
    const unit = document.createElement('span');
    unit.textContent = '分钟';
    customChip.appendChild(customInput);
    customChip.appendChild(unit);
    chips.appendChild(customChip);
    wrap.appendChild(chips);

    function sync() {
      const minutes = Math.round(selectedMs / 60000);
      const isPreset = FOCUS_PRESETS.indexOf(minutes) !== -1;
      presetButtons.forEach((button) => {
        const active = isPreset && Number(button.dataset.minutes) === minutes;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', String(active));
      });
      customChip.classList.toggle('is-active', !isPreset);
      if (isPreset) customInput.value = '';
      else if (document.activeElement !== customInput) customInput.value = String(minutes);
      note.textContent = `本轮 ${minutes} 分钟`;
    }

    customInput.addEventListener('input', () => {
      const raw = customInput.value.trim();
      if (raw === '') {
        sync();
        return;
      }
      const minutes = Number(raw);
      const valid =
        Number.isInteger(minutes) &&
        minutes >= Core.MIN_FOCUS_MINUTES &&
        minutes <= Core.MAX_FOCUS_MINUTES;
      presetButtons.forEach((button) => {
        button.classList.remove('is-active');
        button.setAttribute('aria-checked', 'false');
      });
      customChip.classList.toggle('is-active', valid);
      if (valid) {
        selectedMs = minutes * 60000;
        note.textContent = `本轮 ${minutes} 分钟`;
      } else {
        note.textContent = `需在 ${Core.MIN_FOCUS_MINUTES}–${Core.MAX_FOCUS_MINUTES} 分钟`;
      }
    });

    sync();

    openModal({
      title: isResume ? '继续专注' : '开始专注',
      bodyNode: wrap,
      confirmText: isResume ? '继续专注' : '开始专注',
      validate: () => {
        const raw = customInput.value.trim();
        if (raw !== '') {
          const minutes = Number(raw);
          if (
            !Number.isInteger(minutes) ||
            minutes < Core.MIN_FOCUS_MINUTES ||
            minutes > Core.MAX_FOCUS_MINUTES
          ) {
            toast(`本轮预期专注需在 ${Core.MIN_FOCUS_MINUTES}–${Core.MAX_FOCUS_MINUTES} 分钟之间`);
            customInput.focus();
            return false;
          }
          selectedMs = minutes * 60000;
        }
        return true;
      },
      onConfirm: () => startFocusSession(task, selectedMs, isResume),
    });
  }

  function startFocusSession(task, expectedFocusMs, isResume) {
    const now = Date.now();
    if (isResume && state.session) {
      state.session = Core.resumeSession(
        Core.setNextExpectedFocusMs(state.session, expectedFocusMs),
        now
      );
    } else {
      state.session = Core.createSession({ task: task, expectedFocusMs: expectedFocusMs, now: now });
    }
    state.view = 'session';
    state.roundAnnounced = false;
    persistSession();
    renderAll();
    ensureAudio();
    playChime('start');
    const roundNumber = Core.getCompletedRounds(state.session) + 1;
    toast(`第 ${roundNumber} 轮 · 预期专注 ${Core.formatSpan(expectedFocusMs)}`);
    try {
      ui.sessionView.focus({ preventScroll: true });
    } catch (error) {
      /* ignore */
    }
  }

  /* ==================================================================== *
   * session controls
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
          `本轮结束 · 实际 ${Core.formatSpan(result.round.actualMs)} / 预期 ${Core.formatSpan(
            result.round.expectedMs
          )}`
        );
      } else {
        toast('已暂停 · 继续将开始新一轮');
      }
    } else if (session.phase === 'paused') {
      state.session = Core.resumeSession(session, now);
      persistSession();
      renderAll();
      state.roundAnnounced = false;
      ensureAudio();
      toast(
        `第 ${Core.getCompletedRounds(state.session) + 1} 轮开始 · 预期 ${Core.formatSpan(
          state.session.expectedFocusMs
        )}`
      );
    }
  }

  function onNextRound() {
    const session = state.session;
    if (!session) return;

    if (session.phase === 'paused') {
      onPauseToggle();
      return;
    }

    const result = Core.startNextRound(session, Date.now());
    state.session = result.session;
    persistSession();
    renderAll();
    state.roundAnnounced = false;
    ensureAudio();
    playChime('start');
    toast(
      `第 ${Core.getCompletedRounds(state.session) + 1} 轮开始 · 预期 ${Core.formatSpan(
        state.session.expectedFocusMs
      )}`
    );
    try {
      ui.sessionView.focus({ preventScroll: true });
    } catch (error) {
      /* ignore */
    }
  }

  function onBackToList() {
    if (!state.session || state.session.phase !== 'paused') return;
    state.view = 'tasks';
    renderAll();
    toast('已返回任务清单 · 任务保持暂停，可随时继续');
    window.setTimeout(() => {
      const activeStart = $('.task-row.is-active .task-start');
      if (activeStart) activeStart.focus({ preventScroll: true });
    }, 30);
  }

  function onDiscard() {
    if (!state.session) return;
    openModal({
      title: '结束本次专注？',
      body: '本次专注的轮次不会保存为完成记录，任务会保留在任务清单中，之后可以重新开始。',
      confirmText: '结束专注',
      cancelText: '继续专注',
      tone: 'danger',
      onConfirm: () => endSessionKeepTask('已结束专注，任务保留在清单中'),
    });
  }

  function endSessionKeepTask(message) {
    state.session = null;
    Core.clearSession(localStorage);
    state.view = 'tasks';
    renderAll();
    if (message) toast(message);
  }

  function onCompleteTask() {
    const session = state.session;
    if (!session) return;

    const record = Core.completeSession(session, Date.now());
    if (!record) {
      openModal({
        title: '结束任务？',
        body: '还没有产生专注轮次，不会生成完成记录。任务会保留在任务清单中。',
        confirmText: '结束专注',
        onConfirm: () => endSessionKeepTask('已结束专注，任务保留在清单中'),
      });
      return;
    }

    const metrics = Core.recordMetrics(record);
    const expectedFocusAvg =
      record.roundsWithExpected > 0
        ? record.expectedFocusTotalMs / record.roundsWithExpected
        : null;
    const taskDelta = formatTaskDelta(metrics.taskDeltaMs);
    const lines = [
      `「${record.title}」`,
      `任务耗时：实际 ${Core.formatSpan(record.taskDurationMs)} / 预期 ${Core.formatSpan(
        record.expectedTaskMs
      )}（${taskDelta.text}）`,
      `专注：${record.roundsTotal} 轮 · 共 ${Core.formatSpan(record.focusTotalMs)} · 平均 ${Core.formatSpan(
        metrics.avgFocusMs
      )}/轮${expectedFocusAvg != null ? `（预期 ${Core.formatSpan(expectedFocusAvg)}）` : ''}`,
      '任务耗时按各轮实际专注累计，不含暂停；保存后会出现在完成记录中。',
    ];

    openModal({
      title: '完成任务并保存记录？',
      body: lines.join('\n'),
      confirmText: '保存记录',
      onConfirm: () => saveRecord(record),
    });
  }

  function saveRecord(record) {
    state.records = Core.addRecord(state.records, record);
    Core.saveRecords(localStorage, state.records);
    state.tasks = Core.removeTask(state.tasks, record.taskId);
    Core.saveTasks(localStorage, state.tasks);

    state.session = null;
    Core.clearSession(localStorage);
    state.view = 'tasks';
    renderAll();
    ensureAudio();
    playChime('success');
    celebrate('record');
    toast(
      `任务完成 · 任务耗时 ${Core.formatSpan(record.taskDurationMs)} / 预期 ${Core.formatSpan(
        record.expectedTaskMs
      )}`
    );
  }

  /* ==================================================================== *
   * ticking
   * ==================================================================== */

  function tick() {
    const now = Date.now();
    const currentDay = Core.dateKey(now);
    if (currentDay !== state.dayKey) {
      state.dayKey = currentDay;
      renderDateLabel();
      renderSidebar();
    }

    const session = state.session;
    if (!session || state.view !== 'session') return;

    if (session.phase === 'running') {
      if (!state.roundAnnounced && Core.isRoundTargetReached(session, now)) {
        state.roundAnnounced = true;
        ensureAudio();
        playChime('target');
        toast(
          `本轮已达标 ${Core.formatSpan(session.expectedFocusMs)} · 可继续或暂停结束本轮`
        );
        renderSession();
      }
      if (now - state.lastSavedAt >= SAVE_INTERVAL_MS) persistSession();
    }
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
   * rendering: views
   * ==================================================================== */

  function renderAll() {
    renderView();
    renderSidebar();
  }

  function renderView() {
    const showSession = Boolean(state.view === 'session' && state.session);
    ui.tasksView.classList.toggle('is-hidden', showSession);
    ui.sessionView.classList.toggle('is-hidden', !showSession);
    document.body.dataset.view = showSession ? 'session' : 'tasks';

    if (showSession) {
      delete document.body.dataset.roundReached;
      renderSession();
      renderTimer();
    } else {
      delete document.body.dataset.phase;
      delete document.body.dataset.roundReached;
      renderTasks();
      setDocumentTitle('Focus · 任务与专注');
    }
  }

  function renderDateLabel() {
    const now = new Date();
    ui.todayLabel.textContent = `${now.getMonth() + 1}月${now.getDate()}日 · 周${
      Core.WEEKDAYS[now.getDay()]
    }`;
  }

  function renderSession() {
    const session = state.session;
    if (!session) return;
    const paused = session.phase === 'paused';
    const rounds = Core.getCompletedRounds(session);
    const nextExpected = Core.clampExpectedFocusMs(session.nextExpectedFocusMs);

    ui.sessionView.dataset.phase = session.phase;
    document.body.dataset.phase = session.phase;

    ui.sessionTask.textContent = session.taskTitle;
    ui.sessionTask.title = session.taskTitle;
    ui.roundLabel.textContent = paused
      ? rounds > 0
        ? `已完成 ${rounds} 轮 · 已暂停`
        : '已暂停 · 尚未产生专注轮次'
      : `第 ${rounds + 1} 轮 · 专注中`;

    ui.pauseBtn.textContent = paused ? '继续' : '暂停';
    ui.pauseBtn.className = 'btn btn-primary';
    ui.pauseBtn.title = paused ? '开始新的一轮' : '结束当前轮并暂停任务';
    ui.pauseBtn.setAttribute(
      'aria-label',
      paused ? '继续任务，开始新的一轮' : '暂停任务，结束并计入当前轮'
    );

    ui.nextBtn.hidden = paused;
    ui.nextBtn.className = 'btn btn-ghost';
    ui.completeBtn.className = 'btn btn-ghost';

    ui.nextFocusPanel.classList.toggle('is-hidden', !paused);
    ui.backToListBtn.classList.toggle('is-hidden', !paused);
    if (paused) syncNextFocusPanel(nextExpected);
  }

  function syncNextFocusPanel(nextExpectedMs) {
    const minutes = Math.round(nextExpectedMs / 60000);
    const isPreset = FOCUS_PRESETS.indexOf(minutes) !== -1;
    $$('.chip[data-next-minutes]', ui.nextFocusChips).forEach((chip) => {
      const active = isPreset && Number(chip.dataset.nextMinutes) === minutes;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-checked', String(active));
    });
    ui.nextCustomChip.classList.toggle('is-active', !isPreset);
    ui.nextCustomMinutes.value = isPreset ? '' : String(minutes);
    ui.nextFocusNote.textContent = `下一轮 ${minutes} 分钟`;
  }

  function renderTimer() {
    const session = state.session;
    if (!session) return;
    const now = Date.now();
    const paused = session.phase === 'paused';
    const rounds = Core.getCompletedRounds(session);

    let actual;
    let expected;
    let progress;
    let reached;
    if (paused) {
      const last = Core.getLastRound(session);
      actual = last ? last.actualMs : 0;
      expected = last ? Core.clampExpectedFocusMs(last.expectedMs || session.nextExpectedFocusMs) : session.nextExpectedFocusMs;
      progress = expected > 0 ? Math.min(1, actual / expected) : 0;
      reached = expected > 0 && actual >= expected;
    } else {
      actual = Core.getCurrentRoundActualMs(session, now);
      expected = session.expectedFocusMs;
      progress = Core.getRoundProgress(session, now);
      reached = Core.isRoundTargetReached(session, now);
    }

    const taskElapsed = Core.getTaskElapsedMs(session, now);
    const clock = Core.formatElapsed(actual);

    if (ui.timeDisplay.textContent !== clock) ui.timeDisplay.textContent = clock;
    ui.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));

    ui.sessionView.dataset.roundReached = String(reached);
    document.body.dataset.roundReached = String(reached);

    ui.timerPhase.textContent = paused ? '已暂停' : reached ? '本轮达标' : '专注中';
    ui.timerSub.textContent = paused
      ? rounds > 0
        ? `本轮实际 ${Core.formatSpan(actual)} / 预期 ${Core.formatSpan(expected)}`
        : '已暂停 · 继续开始新一轮'
      : roundSubText(session, now);

    ui.sessionRoundFocus.textContent = formatValue(actual);
    ui.sessionAvgFocus.textContent = rounds > 0 ? formatValue(Core.getAverageFocusMs(session)) : '—';
    ui.sessionTaskElapsed.textContent = formatValue(taskElapsed);
    ui.sessionRounds.textContent = `${rounds} 轮`;
    ui.sessionTaskMeta.textContent = `任务耗时 实际 ${formatValue(
      taskElapsed
    )} / 预期 ${Core.formatSpan(session.taskExpectedMs)}`;

    setDocumentTitle(
      paused ? `⏸ ${session.taskTitle} · Focus` : `${clock} · ${session.taskTitle}`
    );
  }

  function roundSubText(session, now) {
    const expected = Core.formatSpan(session.expectedFocusMs);
    const overtime = Core.getRoundOvertimeMs(session, now);
    if (overtime >= 1000) {
      return `本轮预期 ${expected} · 已超出 ${Core.formatClock(overtime)}`;
    }
    return `本轮预期 ${expected} · 还剩 ${Core.formatClock(Core.getRoundRemainingMs(session, now))}`;
  }

  function setDocumentTitle(title) {
    if (document.title !== title) document.title = title;
  }

  function formatValue(ms) {
    if (ms < 60000) return `${Math.max(0, Math.floor(ms / 1000))} 秒`;
    return Core.formatSpan(ms);
  }

  /* ==================================================================== *
   * rendering: sidebar
   * ==================================================================== */

  function renderSidebar() {
    const now = Date.now();
    const summary = Core.summarize(state.records, now);
    const today = summary.today;
    const weekMs = summary.last7.reduce((sum, day) => sum + day.ms, 0);

    ui.statTodayFocus.textContent = Core.minutesLabel(today.focusMs);
    ui.statAvgFocus.textContent = today.rounds > 0 ? Core.minutesLabel(today.avgFocusMs) : '—';
    ui.statAvgFocusNote.textContent =
      today.expectedFocusAvgMs != null
        ? `预期 ${Core.formatSpan(today.expectedFocusAvgMs)}`
        : '预期 —';
    ui.statTodayTasks.textContent = String(today.tasks);
    ui.statTodayTasksNote.textContent = `共 ${today.rounds} 轮`;
    ui.statStreak.textContent = String(summary.streak);
    ui.totalNote.textContent =
      today.tasks > 0 ? `今天 ${today.tasks} 个任务` : '今天还没有记录';

    if (today.tasks > 0) {
      ui.effTaskActual.textContent = Core.formatSpan(today.taskDurationMs);
      ui.effTaskExpected.textContent = Core.formatSpan(today.expectedTaskMs);
      applyDelta(ui.effTaskDelta, formatTaskDelta(today.taskDeltaMs));

      ui.effFocusActual.textContent =
        today.rounds > 0 ? Core.formatSpan(today.avgFocusMs) : '—';
      ui.effFocusExpected.textContent =
        today.expectedFocusAvgMs != null ? Core.formatSpan(today.expectedFocusAvgMs) : '—';
      applyDelta(ui.effFocusDelta, formatFocusDelta(today.focusDeltaMs));
    } else {
      ui.effTaskActual.textContent = '—';
      ui.effTaskExpected.textContent = '—';
      applyDelta(ui.effTaskDelta, { text: '', tone: 'none' });
      ui.effFocusActual.textContent = '—';
      ui.effFocusExpected.textContent = '—';
      applyDelta(ui.effFocusDelta, { text: '', tone: 'none' });
    }

    ui.weekTotal.textContent = weekMs > 0 ? `共 ${Core.formatSpan(weekMs)}` : '暂无记录';

    ui.recordsCount.textContent = String(state.records.length);
    ui.clearRecords.hidden = state.records.length === 0;

    renderWeekChart(summary.last7);
    renderRecordsList(now);
  }

  function applyDelta(element, info) {
    element.textContent = info.text || '';
    element.classList.remove('is-good', 'is-bad', 'is-neutral');
    if (info.tone && info.tone !== 'none') element.classList.add('is-' + info.tone);
  }

  function formatTaskDelta(deltaMs) {
    if (!Number.isFinite(deltaMs)) return { text: '', tone: 'none' };
    if (Math.abs(deltaMs) < DELTA_EPSILON_MS) return { text: '持平', tone: 'neutral' };
    if (deltaMs > 0) return { text: `快 ${Core.formatSpan(deltaMs)}`, tone: 'good' };
    return { text: `慢 ${Core.formatSpan(-deltaMs)}`, tone: 'bad' };
  }

  function formatFocusDelta(deltaMs) {
    if (deltaMs == null || !Number.isFinite(deltaMs)) return { text: '', tone: 'none' };
    if (Math.abs(deltaMs) < DELTA_EPSILON_MS) return { text: '持平', tone: 'neutral' };
    if (deltaMs > 0) return { text: `+${Core.formatSpan(deltaMs)}`, tone: 'good' };
    return { text: `-${Core.formatSpan(-deltaMs)}`, tone: 'bad' };
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
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML =
        '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
        '<circle cx="24" cy="24" r="17" opacity=".55"/>' +
        '<path d="M24 14v10l7 5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
        '<div class="empty-title">还没有完成记录</div>' +
        '<div class="empty-hint">完成任务后，任务耗时与每轮专注的预期/实际会记录在这里。</div>';
      ui.recordsList.appendChild(empty);
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

      group.records.forEach((record) => section.appendChild(createRecordNode(record)));
      ui.recordsList.appendChild(section);
    });
  }

  function createRecordNode(record) {
    const metrics = Core.recordMetrics(record);
    const item = document.createElement('article');
    item.className = 'record';
    item.dataset.id = record.id;

    const dot = document.createElement('span');
    dot.className = 'record-dot';
    dot.setAttribute('aria-hidden', 'true');

    const main = document.createElement('div');
    main.className = 'record-main';

    const title = document.createElement('p');
    title.className = 'record-task';
    title.textContent = record.title;
    title.title = record.title;

    const meta = document.createElement('p');
    meta.className = 'record-meta';
    meta.textContent = `${Core.formatTimeOfDay(record.startedAt)} – ${Core.formatTimeOfDay(
      record.endedAt
    )} · ${record.roundsTotal} 轮 · 总专注 ${Core.formatSpan(record.focusTotalMs)}`;

    const taskRow = document.createElement('div');
    taskRow.className = 'record-metric';
    const taskLabel = document.createElement('span');
    taskLabel.className = 'rm-label';
    taskLabel.textContent = '任务耗时';
    const taskValue = document.createElement('span');
    taskValue.className = 'rm-value';
    taskValue.textContent = `实际 ${Core.formatSpan(record.taskDurationMs)} / 预期 ${Core.formatSpan(
      record.expectedTaskMs
    )}`;
    const taskDelta = document.createElement('em');
    taskDelta.className = 'rm-delta';
    const taskDeltaInfo = formatTaskDelta(metrics.taskDeltaMs);
    taskDelta.textContent = taskDeltaInfo.text;
    if (taskDeltaInfo.tone !== 'none') taskDelta.classList.add('is-' + taskDeltaInfo.tone);
    taskRow.appendChild(taskLabel);
    taskRow.appendChild(taskValue);
    taskRow.appendChild(taskDelta);

    const focusRow = document.createElement('div');
    focusRow.className = 'record-metric';
    const focusLabel = document.createElement('span');
    focusLabel.className = 'rm-label';
    focusLabel.textContent = '专注均值';
    const focusValue = document.createElement('span');
    focusValue.className = 'rm-value';
    focusValue.textContent =
      `平均 ${Core.formatSpan(metrics.avgFocusMs)} / 轮` +
      (metrics.expectedFocusAvgMs != null
        ? ` · 预期 ${Core.formatSpan(metrics.expectedFocusAvgMs)}`
        : '');
    const focusDelta = document.createElement('em');
    focusDelta.className = 'rm-delta';
    const focusDeltaInfo = formatFocusDelta(metrics.focusDeltaMs);
    focusDelta.textContent = focusDeltaInfo.text;
    if (focusDeltaInfo.tone !== 'none') focusDelta.classList.add('is-' + focusDeltaInfo.tone);
    focusRow.appendChild(focusLabel);
    focusRow.appendChild(focusValue);
    focusRow.appendChild(focusDelta);

    main.appendChild(title);
    main.appendChild(meta);
    main.appendChild(taskRow);
    main.appendChild(focusRow);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'record-delete';
    remove.setAttribute('aria-label', `删除「${record.title}」的记录`);
    remove.title = '删除记录';
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

    item.appendChild(dot);
    item.appendChild(main);
    item.appendChild(remove);
    return item;
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
    renderSidebar();

    toast(`已删除「${record.title}」的记录`, {
      actionLabel: '撤销',
      duration: 7000,
      onAction: () => {
        state.records = Core.addRecord(state.records, record);
        Core.saveRecords(localStorage, state.records);
        renderSidebar();
        toast('已恢复记录');
      },
    });
  }

  function onClearRecords() {
    if (state.records.length === 0) return;
    openModal({
      title: '清空全部完成记录？',
      body: `将删除 ${state.records.length} 条完成记录，此操作不可撤销。`,
      confirmText: '清空记录',
      tone: 'danger',
      onConfirm: () => {
        state.records = [];
        Core.saveRecords(localStorage, []);
        ui.toastStack.textContent = '';
        renderSidebar();
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
    ui.modalBody.textContent = '';
    if (options.bodyNode) {
      ui.modalBody.appendChild(options.bodyNode);
    } else {
      ui.modalBody.textContent = options.body || '';
    }
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
    ui.modalBody.textContent = '';

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
    const options = state.modal;
    if (!options) return;
    if (typeof options.validate === 'function') {
      let valid = false;
      try {
        valid = options.validate();
      } catch (error) {
        valid = false;
      }
      if (!valid) return;
    }
    const onConfirm = options.onConfirm;
    closeModal();
    if (typeof onConfirm === 'function') onConfirm();
  }

  function getModalFocusables() {
    const bodyFocusables = $$(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
      ui.modalBody
    ).filter((node) => !node.disabled && node.offsetParent !== null);
    return bodyFocusables.concat([ui.modalCancel, ui.modalConfirm].filter((node) => node && !node.disabled));
  }

  function trapModalFocus(event) {
    const focusables = getModalFocusables();
    if (focusables.length === 0) return;
    const index = focusables.indexOf(document.activeElement);

    if (event.shiftKey) {
      if (index <= 0) {
        event.preventDefault();
        focusables[focusables.length - 1].focus();
      }
    } else if (index === -1 || index === focusables.length - 1) {
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
    ui.taskForm.addEventListener('submit', onAddTask);

    ui.taskTitleInput.addEventListener('input', () => {
      ui.taskTitleInput.classList.remove('is-invalid');
    });

    ui.taskExpectedChips.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip[data-task-minutes]');
      if (!chip) return;
      ui.taskCustomMinutes.value = '';
      ui.taskCustomChip.classList.remove('is-invalid');
      state.form.taskMs = Number(chip.dataset.taskMinutes) * 60000;
      syncTaskForm();
    });

    ui.focusExpectedChips.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip[data-focus-minutes]');
      if (!chip) return;
      ui.focusCustomMinutes.value = '';
      ui.focusCustomChip.classList.remove('is-invalid');
      state.form.focusMs = Number(chip.dataset.focusMinutes) * 60000;
      syncTaskForm();
    });

    ui.taskCustomMinutes.addEventListener('input', onTaskCustomInput);
    ui.taskCustomMinutes.addEventListener('focus', () => ui.taskCustomMinutes.select());
    ui.focusCustomMinutes.addEventListener('input', onFocusCustomInput);
    ui.focusCustomMinutes.addEventListener('focus', () => ui.focusCustomMinutes.select());

    ui.taskList.addEventListener('click', onTaskListClick);

    ui.pauseBtn.addEventListener('click', onPauseToggle);
    ui.nextBtn.addEventListener('click', onNextRound);
    ui.completeBtn.addEventListener('click', onCompleteTask);
    ui.discardBtn.addEventListener('click', onDiscard);
    ui.backToListBtn.addEventListener('click', onBackToList);

    ui.nextFocusChips.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip[data-next-minutes]');
      if (!chip) return;
      if (!state.session || state.session.phase !== 'paused') return;
      ui.nextCustomMinutes.value = '';
      state.session = Core.setNextExpectedFocusMs(
        state.session,
        Number(chip.dataset.nextMinutes) * 60000
      );
      persistSession();
      renderSession();
    });

    ui.nextCustomMinutes.addEventListener('input', () => {
      if (!state.session || state.session.phase !== 'paused') return;
      const raw = ui.nextCustomMinutes.value.trim();
      if (raw === '') return;
      const minutes = Number(raw);
      const valid =
        Number.isInteger(minutes) &&
        minutes >= Core.MIN_FOCUS_MINUTES &&
        minutes <= Core.MAX_FOCUS_MINUTES;
      $$('.chip[data-next-minutes]', ui.nextFocusChips).forEach((chip) => {
        chip.classList.remove('is-active');
        chip.setAttribute('aria-checked', 'false');
      });
      ui.nextCustomChip.classList.toggle('is-active', valid);
      if (valid) {
        state.session = Core.setNextExpectedFocusMs(state.session, minutes * 60000);
        persistSession();
        ui.nextFocusNote.textContent = `下一轮 ${minutes} 分钟`;
      } else {
        ui.nextFocusNote.textContent = `需在 ${Core.MIN_FOCUS_MINUTES}–${Core.MAX_FOCUS_MINUTES} 分钟`;
      }
    });
    ui.nextCustomMinutes.addEventListener('focus', () => ui.nextCustomMinutes.select());

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
      if (!document.hidden && state.session && state.view === 'session') {
        tick();
        renderTimer();
      }
    });

    window.addEventListener('storage', (event) => {
      if (!event.key) return;
      if (event.key === Core.STORAGE_KEYS.records) {
        state.records = Core.loadRecords(localStorage);
        renderSidebar();
      } else if (event.key === Core.STORAGE_KEYS.tasks && !state.session) {
        state.tasks = Core.loadTasks(localStorage);
        renderTasks();
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
    if (!state.session || state.view !== 'session') return;

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
      onCompleteTask();
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
