import {
  getConfig, setConfig, hasSyncConfig,
  getDraft, saveDraft, clearDraft,
  getCachedHistory, setCachedHistory,
  getPending, addPending, setPending,
} from './storage.js';
import {
  loadAllLastSessions, loadLastSessionForRoutine,
  saveSession, testAuth,
} from './github.js';

const state = {
  routines: null,
  lastSessions: {},
};

const app = document.getElementById('app');
const screenTitle = document.getElementById('screen-title');
const backBtn = document.getElementById('back-btn');
const settingsBtn = document.getElementById('settings-btn');
const toastEl = document.getElementById('toast');

backBtn.addEventListener('click', () => history.back());
settingsBtn.addEventListener('click', () => { location.hash = '#/settings'; });
window.addEventListener('hashchange', route);
window.addEventListener('online', flushPending);

function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  setTimeout(() => toastEl.classList.add('hidden'), 2800);
  toastEl.classList.remove('hidden');
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function humanDate(iso) {
  if (!iso) return 'never';
  const then = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now - then) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return iso;
}

async function loadRoutines() {
  if (state.routines) return state.routines;
  const res = await fetch('./routines.json', { cache: 'no-cache' });
  const data = await res.json();
  state.routines = data.routines;
  return data.routines;
}

function getRoutine(id) {
  return state.routines?.find(r => r.id === id);
}

function themeFromRoutineId(id) {
  if (!id) return 'default';
  if (id.startsWith('arm_'))  return 'arm';
  if (id.startsWith('leg_'))  return 'leg';
  if (id.startsWith('full_')) return 'full';
  return 'default';
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
}

async function route() {
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\//, '').split('/');
  backBtn.classList.toggle('hidden', parts[0] === '' || parts[0] === undefined);
  if (parts[0] === '' || parts[0] === undefined) {
    backBtn.classList.add('hidden');
    applyTheme('default');
    await renderHome();
  } else if (parts[0] === 'session' && parts[1]) {
    applyTheme(themeFromRoutineId(parts[1]));
    await renderSession(parts[1]);
  } else if (parts[0] === 'settings') {
    applyTheme('default');
    renderSettings();
  } else {
    location.hash = '#/';
  }
}

async function renderHome() {
  screenTitle.textContent = 'Workouts';
  app.innerHTML = '<div class="empty-hint">Loading…</div>';
  const routines = await loadRoutines();

  const pending = getPending();
  let pendingBanner = '';
  if (pending.length > 0) {
    pendingBanner = `<div class="status-banner">⏳ ${pending.length} session${pending.length > 1 ? 's' : ''} pending sync. <a href="#" id="flush-now" style="color:var(--accent)">Try now</a></div>`;
  }

  if (!hasSyncConfig()) {
    pendingBanner += `<div class="status-banner">Configure GitHub sync to save history across devices. <a href="#/settings" style="color:var(--accent)">Open settings →</a></div>`;
  }

  for (const r of routines) {
    const cached = getCachedHistory(r.id);
    if (cached) state.lastSessions[r.id] = cached;
  }

  const render = () => {
    const groups = { full_body: [], split_arm_leg: [] };
    for (const r of routines) groups[r.category]?.push(r);

    const cardFor = r => {
      const last = state.lastSessions[r.id];
      const sub = last
        ? `Last: ${humanDate(last.date)} · ${last.exercises.length} exercises`
        : `${r.exercises.length} exercises`;
      return `
        <button class="card" data-routine="${r.id}">
          <div class="card-title">${r.name}</div>
          <div class="card-sub">${sub}</div>
        </button>`;
    };

    app.innerHTML = `
      ${pendingBanner}
      ${groups.full_body.length ? '<h2 class="section-title">Full Body</h2>' + groups.full_body.map(cardFor).join('') : ''}
      ${groups.split_arm_leg.length ? '<h2 class="section-title">Arm / Leg Split</h2>' + groups.split_arm_leg.map(cardFor).join('') : ''}
    `;
    app.querySelectorAll('[data-routine]').forEach(btn => {
      btn.addEventListener('click', () => {
        location.hash = `#/session/${btn.dataset.routine}`;
      });
    });
    const flush = document.getElementById('flush-now');
    if (flush) flush.addEventListener('click', e => { e.preventDefault(); flushPending(); });
  };

  render();

  if (hasSyncConfig() && navigator.onLine) {
    try {
      const sessions = await loadAllLastSessions();
      state.lastSessions = { ...state.lastSessions, ...sessions };
      render();
    } catch (err) {
      console.warn('bg refresh failed', err);
    }
  }
}

function buildInitialSession(routine, lastSession) {
  const lastByName = new Map();
  if (lastSession) {
    for (const ex of lastSession.exercises) lastByName.set(ex.name, ex);
  }
  return {
    date: todayISO(),
    routineId: routine.id,
    routineName: routine.name,
    startedAt: new Date().toISOString(),
    exercises: routine.exercises.map(ex => {
      const prev = lastByName.get(ex.name);
      const setCount = 3;
      let sets;
      if (ex.duration) {
        sets = [{ duration: ex.duration, done: false }];
      } else if (prev && prev.sets && prev.sets.length) {
        sets = prev.sets.slice(0, setCount).map((s, i) => ({
          weight: s.weight, unit: s.unit, reps: s.reps,
          warmup: !!s.warmup,
          restMinutes: i < setCount - 1 ? (s.restMinutes ?? 1.5) : null,
          done: false,
        }));
        while (sets.length < setCount) {
          const last = sets[sets.length - 1];
          const i = sets.length;
          sets.push({
            weight: last?.weight ?? ex.weight, unit: last?.unit ?? ex.unit, reps: last?.reps ?? ex.reps,
            warmup: false,
            restMinutes: i < setCount - 1 ? 1.5 : null,
            done: false,
          });
        }
      } else {
        const perSet = ex.perSet;
        const warmup = ex.warmup || [];
        sets = Array.from({ length: setCount }, (_, i) => ({
          weight: ex.bodyweight ? null : (perSet ? perSet[i] ?? perSet[perSet.length - 1] : ex.weight),
          unit: ex.unit,
          reps: ex.reps,
          warmup: !!warmup[i],
          restMinutes: i < setCount - 1 ? 1.5 : null,
          done: false,
        }));
      }
      return {
        name: ex.name,
        target: { reps: ex.reps, weight: ex.weight, unit: ex.unit, duration: ex.duration, bodyweight: !!ex.bodyweight },
        notes: '',
        routineNote: ex.notes || '',
        sets,
        previousSets: prev?.sets || null,
      };
    }),
  };
}

async function renderSession(routineId) {
  screenTitle.textContent = 'Session';
  app.innerHTML = '<div class="empty-hint">Loading…</div>';

  const routines = await loadRoutines();
  const routine = getRoutine(routineId);
  if (!routine) { location.hash = '#/'; return; }

  screenTitle.textContent = routine.name;

  let lastSession = state.lastSessions[routineId] || getCachedHistory(routineId);
  if (hasSyncConfig() && navigator.onLine && !lastSession) {
    try { lastSession = await loadLastSessionForRoutine(routineId); } catch {}
  }

  const draft = getDraft(routineId);
  const session = draft || buildInitialSession(routine, lastSession);

  const container = document.createElement('div');

  function fmtLast(prev) {
    if (!prev || !prev.sets) return '';
    const parts = prev.sets.map(s => {
      if (s.duration) return s.duration;
      if (s.weight == null) return `BW×${s.reps}`;
      return `${s.weight}${s.unit ? s.unit : ''}×${s.reps}`;
    });
    return `Last: ${parts.join(', ')}`;
  }

  function renderExercise(ex, idx) {
    const isTimed = !!ex.target.duration;
    const isBW = ex.target.bodyweight && !isTimed;

    const setsHtml = ex.sets.map((s, si) => {
      if (isTimed) {
        return `
          <div class="set-row">
            <div class="set-label">1</div>
            <div style="grid-column: span 3; color: var(--text-dim); font-size: 14px;">${ex.target.duration}</div>
            <input type="checkbox" class="set-done" data-ex="${idx}" data-set="${si}" data-field="done" ${s.done ? 'checked' : ''} />
          </div>`;
      }
      const label = s.warmup ? 'W' : String(si + 1);
      const labelClass = s.warmup ? 'set-label warmup' : 'set-label';
      const weightInput = isBW
        ? `<div style="color: var(--text-dim); font-size: 13px; text-align:center;">bodyweight</div>`
        : `<div class="input-suffix" data-suffix="${s.unit || ''}"><input type="number" inputmode="decimal" step="0.5" value="${s.weight ?? ''}" data-ex="${idx}" data-set="${si}" data-field="weight" /></div>`;
      const isLastSet = si === ex.sets.length - 1;
      const restInput = isLastSet
        ? `<div class="rest-placeholder">—</div>`
        : `<div class="input-suffix rest" data-suffix="min"><input type="number" inputmode="decimal" step="0.5" min="0" value="${s.restMinutes ?? ''}" data-ex="${idx}" data-set="${si}" data-field="restMinutes" /></div>`;
      return `
        <div class="set-row">
          <div class="${labelClass}">${label}</div>
          ${weightInput}
          <div class="input-suffix" data-suffix="reps"><input type="number" inputmode="numeric" step="1" value="${s.reps ?? ''}" data-ex="${idx}" data-set="${si}" data-field="reps" /></div>
          ${restInput}
          <input type="checkbox" class="set-done" data-ex="${idx}" data-set="${si}" data-field="done" ${s.done ? 'checked' : ''} />
        </div>`;
    }).join('');

    const target = isTimed
      ? ex.target.duration
      : (ex.target.bodyweight ? `${ex.target.reps} reps · BW` : `${ex.target.reps} reps · ${ex.target.weight ?? '?'}${ex.target.unit || ''}`);

    return `
      <div class="exercise" data-exercise="${idx}">
        <div class="exercise-header">
          <div class="exercise-name">${ex.name}</div>
          <div class="exercise-target">${target}</div>
        </div>
        ${ex.routineNote ? `<div class="exercise-notes">${ex.routineNote}</div>` : ''}
        ${ex.previousSets ? `<div class="last-summary">${fmtLast({ sets: ex.previousSets })}</div>` : ''}
        ${isTimed ? '' : `
        <div class="set-row set-header">
          <div class="set-label">#</div>
          <div class="col-head">${isBW ? '' : 'weight'}</div>
          <div class="col-head">reps</div>
          <div class="col-head">rest</div>
          <div class="col-head">✓</div>
        </div>`}
        ${setsHtml}
        <textarea class="notes-input" placeholder="Notes (optional)" data-ex="${idx}" data-field="notes">${ex.notes || ''}</textarea>
      </div>`;
  }

  const lastDateIso = lastSession?.completedAt || (lastSession?.date ? `${lastSession.date}T00:00:00` : null);
  let lastBanner;
  if (!lastDateIso) {
    lastBanner = `<div class="last-workout-banner"><span class="label">Last ${routine.name}:</span> <span class="value na">N/A</span></div>`;
  } else {
    const days = Math.max(0, Math.floor((Date.now() - new Date(lastDateIso).getTime()) / 86400000));
    const phrase = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
    lastBanner = `<div class="last-workout-banner"><span class="label">Last ${routine.name}:</span> <span class="value">${phrase}</span> <span class="date-aside">(${lastSession.date})</span></div>`;
  }

  container.innerHTML = `
    ${lastBanner}
    ${draft ? '<div class="status-banner ok">Draft restored — keep going.</div>' : ''}
    ${session.exercises.map((ex, i) => renderExercise(ex, i)).join('')}
    <div class="sticky-footer">
      <button class="primary-btn" id="save-btn">Save session</button>
      <button class="secondary-btn" id="discard-btn">Discard draft</button>
    </div>
  `;
  app.innerHTML = '';
  app.appendChild(container);

  const persist = () => saveDraft(session);

  container.addEventListener('input', e => {
    const t = e.target;
    const exIdx = t.dataset.ex;
    if (exIdx == null) return;
    const ex = session.exercises[+exIdx];
    if (t.dataset.set != null) {
      const set = ex.sets[+t.dataset.set];
      const field = t.dataset.field;
      if (field === 'done') set.done = t.checked;
      else if (field === 'weight') set.weight = t.value === '' ? null : Number(t.value);
      else if (field === 'reps') set.reps = t.value === '' ? null : Number(t.value);
      else if (field === 'restMinutes') set.restMinutes = t.value === '' ? null : Number(t.value);
    } else if (t.dataset.field === 'notes') {
      ex.notes = t.value;
    }
    persist();
  });

  container.addEventListener('change', e => {
    if (e.target.classList.contains('set-done')) persist();
  });

  document.getElementById('discard-btn').addEventListener('click', () => {
    if (!confirm('Discard this session?')) return;
    clearDraft();
    location.hash = '#/';
  });

  document.getElementById('save-btn').addEventListener('click', () => saveCurrent(session));
}

async function saveCurrent(session) {
  session.completedAt = new Date().toISOString();
  const payload = {
    date: session.date,
    routineId: session.routineId,
    routineName: session.routineName,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    exercises: session.exercises.map(ex => ({
      name: ex.name,
      target: ex.target,
      notes: ex.notes,
      sets: ex.sets
        .filter(s => s.done || s.weight != null || s.reps != null || s.duration)
        .map(s => {
          const out = {};
          if (s.duration) out.duration = s.duration;
          if (s.weight != null) { out.weight = s.weight; out.unit = s.unit; }
          if (s.reps != null) out.reps = s.reps;
          if (s.restMinutes != null) out.restMinutes = s.restMinutes;
          if (s.warmup) out.warmup = true;
          return out;
        }),
    })),
  };

  const saveBtn = document.getElementById('save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  if (!hasSyncConfig()) {
    addPending(payload);
    setCachedHistory(payload.routineId, payload);
    state.lastSessions[payload.routineId] = payload;
    clearDraft();
    toast('Saved locally — configure GitHub to sync', 'ok');
    location.hash = '#/';
    return;
  }

  try {
    await saveSession(payload);
    setCachedHistory(payload.routineId, payload);
    state.lastSessions[payload.routineId] = payload;
    clearDraft();
    toast('Session saved to GitHub', 'ok');
    location.hash = '#/';
  } catch (err) {
    console.error(err);
    addPending(payload);
    setCachedHistory(payload.routineId, payload);
    state.lastSessions[payload.routineId] = payload;
    clearDraft();
    toast('Offline — queued for sync', 'error');
    location.hash = '#/';
  }
}

async function flushPending() {
  const list = getPending();
  if (list.length === 0 || !hasSyncConfig() || !navigator.onLine) return;
  const remaining = [];
  for (const s of list) {
    try { await saveSession(s); }
    catch (err) { remaining.push(s); }
  }
  setPending(remaining);
  if (remaining.length < list.length) {
    toast(`Synced ${list.length - remaining.length} session(s)`, 'ok');
    if (location.hash === '#/' || location.hash === '') renderHome();
  }
}

function renderSettings() {
  screenTitle.textContent = 'Settings';
  const cfg = getConfig();
  app.innerHTML = `
    <div class="settings-group">
      <label>GitHub username / org</label>
      <input type="text" id="cfg-owner" value="${cfg.owner}" placeholder="your-github-username" autocomplete="off" />
    </div>
    <div class="settings-group">
      <label>Repository name</label>
      <input type="text" id="cfg-repo" value="${cfg.repo}" autocomplete="off" />
    </div>
    <div class="settings-group">
      <label>Branch</label>
      <input type="text" id="cfg-branch" value="${cfg.branch}" autocomplete="off" />
    </div>
    <div class="settings-group">
      <label>Personal access token (fine-grained)</label>
      <input type="password" id="cfg-pat" value="${cfg.pat}" placeholder="github_pat_..." autocomplete="off" />
      <div class="help">
        Needs <strong>Contents: read &amp; write</strong> scoped to this repo only.
        Create at github.com → Settings → Developer settings → Fine-grained tokens.
        Stored in this browser's localStorage only.
      </div>
    </div>
    <button class="primary-btn" id="save-cfg">Save settings</button>
    <button class="secondary-btn" id="test-cfg">Test connection</button>
  `;

  document.getElementById('save-cfg').addEventListener('click', () => {
    setConfig({
      owner: document.getElementById('cfg-owner').value.trim(),
      repo: document.getElementById('cfg-repo').value.trim(),
      branch: document.getElementById('cfg-branch').value.trim() || 'main',
      pat: document.getElementById('cfg-pat').value.trim(),
    });
    toast('Settings saved', 'ok');
    flushPending();
  });

  document.getElementById('test-cfg').addEventListener('click', async () => {
    setConfig({
      owner: document.getElementById('cfg-owner').value.trim(),
      repo: document.getElementById('cfg-repo').value.trim(),
      branch: document.getElementById('cfg-branch').value.trim() || 'main',
      pat: document.getElementById('cfg-pat').value.trim(),
    });
    try {
      await testAuth();
      toast('Connected ✓', 'ok');
    } catch (err) {
      console.error(err);
      toast(`Failed: ${err.message}`, 'error');
    }
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW failed', err));
  });
}

route();
flushPending();
