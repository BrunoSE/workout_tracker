import {
  getConfig, setConfig, hasSyncConfig,
  getDraft, saveDraft, clearDraft,
  getCachedHistory, setCachedHistory,
  getPending, addPending, setPending,
} from './storage.js';
import {
  loadAllLastSessions, loadLastSessionForRoutine, loadExerciseSeeds,
  saveSession, testAuth,
} from './github.js';
import { canonicalExerciseName } from './names.js';

const APP_VERSION = 'v21';

const state = {
  routines: null,
  lastSessions: {},
  routeId: 0,
};

const app = document.getElementById('app');
const screenTitle = document.getElementById('screen-title');
const backBtn = document.getElementById('back-btn');
const settingsBtn = document.getElementById('settings-btn');
const toastEl = document.getElementById('toast');

backBtn.addEventListener('click', () => {
  // Landing directly on a session URL (bookmark/PWA) leaves no in-app
  // history — history.back() would exit the app, so go home instead.
  if (window.history.length > 1) history.back();
  else location.hash = '#/';
});
settingsBtn.addEventListener('click', () => { location.hash = '#/settings'; });
window.addEventListener('hashchange', route);
window.addEventListener('online', flushPending);

let toastTimer = 0;

function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
    toastTimer = 0;
  }, 2800);
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function parseLocalDate(iso) {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function startOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Notes and set values are user input persisted to GitHub and re-rendered
// as HTML — escape everything interpolated into markup (stored-XSS guard).
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&#39;'
  ));
}

function humanDate(iso) {
  if (!iso) return 'never';
  const then = parseLocalDate(iso);
  if (!then) return iso;
  const diffDays = Math.round((startOfLocalDay() - startOfLocalDay(then)) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays > 1 && diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 0) return iso;
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
  if (id === 'armh' || id.startsWith('legh_')) return 'hyrox';
  if (id.startsWith('arm_'))  return 'arm';
  if (id.startsWith('leg_'))  return 'leg';
  if (id.startsWith('full_')) return 'full';
  return 'default';
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
}

// Folders group routines that aren't part of the everyday lineup.
// The usual Legs/Arms/Full Body routines render inline on home; every
// other category shows as a folder card leading to a folder view.
const FOLDERS = [
  { key: 'hyrox', name: 'Hyrox', theme: 'hyrox' },
  { key: 'tmp_upper_lower', name: 'Upper / Lower · Test', theme: 'default' },
  { key: 'tmp_body_part_split', name: 'Body Part Split · Test', theme: 'default' },
  { key: 'tmp_full_body', name: 'Full Body · Test', theme: 'default' },
];

function folderMeta(key) {
  const known = FOLDERS.find(f => f.key === key);
  if (known) return known;
  const name = key.replace(/^tmp_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return { key, name, theme: 'default' };
}

function routineCard(r) {
  const last = state.lastSessions[r.id];
  const sub = last
    ? `Last: ${humanDate(last.date)} · ${last.exercises.length} exercises`
    : `${r.exercises.length} exercises`;
  const theme = themeFromRoutineId(r.id);
  return `
    <button class="card" data-theme="${theme}" data-routine="${r.id}">
      <div class="card-title">${escapeHtml(r.name)}</div>
      <div class="card-sub">${sub}</div>
    </button>`;
}

function bindRoutineCards(root = app) {
  root.querySelectorAll('[data-routine]').forEach(btn => {
    btn.addEventListener('click', () => {
      location.hash = `#/session/${btn.dataset.routine}`;
    });
  });
}

function folderLastText(key) {
  let best = null;
  for (const r of state.routines || []) {
    if (r.category !== key) continue;
    const d = state.lastSessions[r.id]?.date;
    if (typeof d === 'string' && (!best || d > best)) best = d;
  }
  return best ? `Last: ${humanDate(best)}` : 'Not started yet';
}

function folderCard(folder, count) {
  return `
    <button class="card folder-card" data-theme="${folder.theme}" data-folder="${folder.key}">
      <div class="card-title">🗂 ${escapeHtml(folder.name)}</div>
      <div class="card-sub">${count} workout${count === 1 ? '' : 's'} · ${folderLastText(folder.key)}</div>
    </button>`;
}

function bindFolderCards(root = app) {
  root.querySelectorAll('[data-folder]').forEach(btn => {
    btn.addEventListener('click', () => {
      location.hash = `#/folder/${btn.dataset.folder}`;
    });
  });
}

// Fill last-session state from localStorage cache without clobbering
// fresher network data already in state (avoids transient stale subtitles).
function primeLastSessionsFromCache(routines) {
  for (const r of routines) {
    if (state.lastSessions[r.id]) continue;
    const cached = getCachedHistory(r.id);
    if (cached) state.lastSessions[r.id] = cached;
  }
}

async function refreshLastSessions(routeId, rerender) {
  if (!hasSyncConfig() || !navigator.onLine) return;
  try {
    const sessions = await loadAllLastSessions();
    if (routeId !== state.routeId) return;
    state.lastSessions = { ...state.lastSessions, ...sessions };
    rerender();
  } catch (err) {
    console.warn('bg refresh failed', err);
  }
}

async function route() {
  const routeId = ++state.routeId;
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\//, '').split('/');
  backBtn.classList.toggle('hidden', parts[0] === '' || parts[0] === undefined);
  if (parts[0] === '' || parts[0] === undefined) {
    backBtn.classList.add('hidden');
    applyTheme('default');
    await renderHome(routeId);
  } else if (parts[0] === 'session' && parts[1]) {
    applyTheme(themeFromRoutineId(parts[1]));
    await renderSession(parts[1], routeId);
  } else if (parts[0] === 'folder' && parts[1]) {
    let folderKey = parts[1];
    try { folderKey = decodeURIComponent(folderKey); } catch { /* keep raw key */ }
    const folder = folderMeta(folderKey);
    applyTheme(folder.theme);
    await renderFolder(folder, routeId);
  } else if (parts[0] === 'settings') {
    applyTheme('default');
    renderSettings();
  } else {
    location.hash = '#/';
  }
}

async function renderHome(routeId = state.routeId) {
  screenTitle.textContent = 'Workouts';
  app.innerHTML = '<div class="empty-hint">Loading…</div>';
  const routines = await loadRoutines();
  if (routeId !== state.routeId) return;

  const pending = getPending();
  let pendingBanner = '';
  if (pending.length > 0) {
    pendingBanner = `<div class="status-banner">⏳ ${pending.length} session${pending.length > 1 ? 's' : ''} pending sync. <a href="#" id="flush-now" style="color:var(--accent)">Try now</a></div>`;
  }

  if (!hasSyncConfig()) {
    pendingBanner += `<div class="status-banner">Configure GitHub sync to save history across devices. <a href="#/settings" style="color:var(--accent)">Open settings →</a></div>`;
  }

  primeLastSessionsFromCache(routines);

  const render = () => {
    if (routeId !== state.routeId) return;
    const legs  = routines.filter(r => r.id.startsWith('leg_')).sort((a, b) => a.id.localeCompare(b.id));    const arms  = routines.filter(r => r.id.startsWith('arm_')).sort((a, b) => a.id.localeCompare(b.id));
    const full  = routines.filter(r => r.id.startsWith('full_')).sort((a, b) => a.id.localeCompare(b.id));

    const section = (title, list) => list.length
      ? `<h2 class="section-title">${title}</h2>${list.map(routineCard).join('')}`
      : '';

    // Folders: known ones first, then any other category not shown inline
    // (future test folders appear automatically).
    const inlineIds = new Set([...legs, ...arms, ...full].map(r => r.id));
    const extraKeys = [...new Set(
      routines.filter(r => !inlineIds.has(r.id)).map(r => r.category)
    )];
    const folderKeys = [
      ...FOLDERS.map(f => f.key).filter(k => extraKeys.includes(k)),
      ...extraKeys.filter(k => !FOLDERS.some(f => f.key === k)).sort(),
    ];
    const foldersHtml = folderKeys.length
      ? `<h2 class="section-title">Folders</h2>${folderKeys.map(k => {
          const folder = folderMeta(k);
          const count = routines.filter(r => r.category === k).length;
          return folderCard(folder, count);
        }).join('')}`
      : '';

    app.innerHTML = `
      ${pendingBanner}
      ${section('Legs', legs)}
      ${section('Arms', arms)}
      ${section('Full Body', full)}
      ${foldersHtml}
    `;
    bindRoutineCards();
    bindFolderCards();
    const flush = document.getElementById('flush-now');
    if (flush) flush.addEventListener('click', e => { e.preventDefault(); flushPending(); });
  };

  render();

  await refreshLastSessions(routeId, render);
}

async function renderFolder(folder, routeId = state.routeId) {
  screenTitle.textContent = folder.name;
  app.innerHTML = '<div class="empty-hint">Loading…</div>';
  const routines = await loadRoutines();
  if (routeId !== state.routeId) return;

  primeLastSessionsFromCache(routines);

  const render = () => {
    if (routeId !== state.routeId) return;
    const list = routines
      .filter(r => r.category === folder.key)
      .sort((a, b) => a.id.localeCompare(b.id));
    app.innerHTML = list.length
      ? list.map(routineCard).join('')
      : '<div class="empty-hint">No workouts in this folder yet.</div>';
    bindRoutineCards();
  };

  render();

  await refreshLastSessions(routeId, render);
}

function exerciseType(ex) {
  if (ex.distance) return 'distance';
  if (ex.duration) return 'duration';
  return 'reps';
}

function buildInitialSession(routine, lastSession, seeds) {
  // Seeds are the latest known sets per exercise across ALL routines
  // (Bench press done in Full Body 1 seeds Bench press in Arm 1).
  // The routine's own last session is always merged in as the fallback,
  // so exercises with no cross-routine seed still seed from it.
  const lastByName = new Map();
  const seedMeta = new Map();
  const fromSession = session => {
    if (!session || !Array.isArray(session.exercises)) return;
    for (const ex of session.exercises) {
      if (!ex || !ex.name || !Array.isArray(ex.sets)) continue;
      const key = canonicalExerciseName(ex.name);
      if (!lastByName.has(key)) lastByName.set(key, ex);
    }
  };
  if (seeds && Object.keys(seeds).length) {
    for (const [name, seed] of Object.entries(seeds)) {
      if (!seed || !Array.isArray(seed.sets)) continue;
      const key = canonicalExerciseName(name);
      lastByName.set(key, { sets: seed.sets, notes: seed.notes || '' });
      if (seed.routineId && seed.routineId !== routine.id) {
        seedMeta.set(key, seed.routineName || seed.routineId);
      }
    }
    // Fill gaps the seed map doesn't cover (e.g. seed cache predates an
    // exercise) from the routine's own last session.
    fromSession(lastSession);
  } else {
    fromSession(lastSession);
  }
  return {
    date: todayISO(),
    routineId: routine.id,
    routineName: routine.name,
    startedAt: new Date().toISOString(),
    exercises: routine.exercises.map(ex => {
      const key = canonicalExerciseName(ex.name);
      const prev = lastByName.get(key);
      const type = exerciseType(ex);
      const setCount = ex.sets ?? 3;
      let sets;

      if (type === 'reps') {
        if (prev && prev.sets && prev.sets.length) {
          sets = prev.sets.slice(0, setCount).map((s, i) => ({
            weight: s.weight, unit: s.unit, reps: s.reps,
            warmup: !!s.warmup,
            restMinutes: i < setCount - 1 ? (s.restMinutes ?? 2) : null,
            done: false,
          }));
          while (sets.length < setCount) {
            const last = sets[sets.length - 1];
            const i = sets.length;
            sets.push({
              weight: last?.weight ?? ex.weight, unit: last?.unit ?? ex.unit, reps: last?.reps ?? ex.reps,
              warmup: false,
              restMinutes: i < setCount - 1 ? 2 : null,
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
            restMinutes: i < setCount - 1 ? 2 : null,
            done: false,
          }));
        }
      } else if (type === 'distance') {
        const seedWeight = prev?.sets?.[0]?.weight ?? ex.weight;
        const seedDistance = prev?.sets?.[0]?.distance ?? ex.distance;
        sets = Array.from({ length: setCount }, (_, i) => ({
          distance: prev?.sets?.[i]?.distance ?? seedDistance,
          weight: ex.bodyweight ? null : (prev?.sets?.[i]?.weight ?? seedWeight),
          unit: ex.unit,
          restMinutes: i < setCount - 1 ? (prev?.sets?.[i]?.restMinutes ?? 2) : null,
          done: false,
        }));
      } else { // duration
        const seedDuration = prev?.sets?.[0]?.duration ?? ex.duration;
        const seedWeight = prev?.sets?.[0]?.weight ?? ex.weight;
        sets = Array.from({ length: setCount }, (_, i) => ({
          duration: prev?.sets?.[i]?.duration ?? seedDuration,
          weight: ex.bodyweight ? null : (prev?.sets?.[i]?.weight ?? seedWeight),
          unit: ex.unit,
          restMinutes: i < setCount - 1 ? (prev?.sets?.[i]?.restMinutes ?? 2) : null,
          done: false,
        }));
      }

      return {
        name: ex.name,
        type,
        target: {
          reps: ex.reps, weight: ex.weight, unit: ex.unit,
          duration: ex.duration, distance: ex.distance,
          bodyweight: !!ex.bodyweight,
        },
        notes: '',
        routineNote: ex.notes || '',
        sets,
        previousSets: prev?.sets || null,
        previousNotes: prev?.notes || '',
        previousFrom: seedMeta.get(key) || null,
      };
    }),
  };
}

async function renderSession(routineId, routeId = state.routeId) {
  screenTitle.textContent = 'Session';
  app.innerHTML = '<div class="empty-hint">Loading…</div>';

  const routines = await loadRoutines();
  if (routeId !== state.routeId) return;
  const routine = getRoutine(routineId);
  if (!routine) { location.hash = '#/'; return; }

  screenTitle.textContent = routine.name;

  let lastSession = state.lastSessions[routineId] || getCachedHistory(routineId);
  if (hasSyncConfig() && navigator.onLine && !lastSession) {
    try { lastSession = await loadLastSessionForRoutine(routineId); } catch {}
  }
  if (routeId !== state.routeId) return;

  const draft = getDraft(routineId);
  // Latest weight/sets per exercise across all routines (cached offline).
  // Skipped when resuming a draft — seeds only feed fresh sessions, so
  // opening a draft costs no network (listLogs + up to 12 file fetches).
  let seeds = null;
  if (!draft) {
    try { seeds = await loadExerciseSeeds(lastSession); } catch {}
    if (routeId !== state.routeId) return;
  }

  const session = draft || buildInitialSession(routine, lastSession, seeds);
  if (draft && session.date !== todayISO()) {
    session.date = todayISO();
    saveDraft(session);
  }

  const container = document.createElement('div');

  function fmtLast(prev, label = 'Last') {
    if (!prev || !prev.sets) return '';
    const parts = prev.sets.map(s => {
      const w = (s.weight != null) ? `${s.weight}${s.unit || ''}` : (s.bodyweight === false ? '?' : 'BW');
      if (s.distance) return `${s.distance}@${w}`;
      if (s.duration) return s.weight != null ? `${s.duration}@${w}` : String(s.duration);
      if (s.weight == null) return `BW×${s.reps}`;
      return `${w}×${s.reps}`;
    });
    return escapeHtml(`${label}: ${parts.join(', ')}`);
  }

  function renderExercise(ex, idx) {
    const type = ex.type || 'reps';
    const isBW = ex.target.bodyweight;
    const measureCol = type === 'distance' ? 'distance' : type === 'duration' ? 'time' : 'reps';

    const weightCell = (s, si) => isBW
      ? `<div style="color: var(--text-dim); font-size: 13px; text-align:center;">BW</div>`
      : `<div class="input-suffix" data-suffix="${escapeHtml(s.unit || '')}"><input type="number" inputmode="decimal" step="0.5" value="${escapeHtml(s.weight ?? '')}" data-ex="${idx}" data-set="${si}" data-field="weight" /></div>`;

    const measureCell = (s, si) => {
      if (type === 'distance') {
        return `<div class="input-suffix" data-suffix="m"><input type="text" inputmode="text" value="${escapeHtml(s.distance ?? '')}" placeholder="200m" data-ex="${idx}" data-set="${si}" data-field="distance" /></div>`;
      }
      if (type === 'duration') {
        return `<div class="input-suffix" data-suffix="time"><input type="text" inputmode="text" value="${escapeHtml(s.duration ?? '')}" placeholder="30s" data-ex="${idx}" data-set="${si}" data-field="duration" /></div>`;
      }
      return `<div class="input-suffix" data-suffix="reps"><input type="number" inputmode="numeric" step="1" value="${escapeHtml(s.reps ?? '')}" data-ex="${idx}" data-set="${si}" data-field="reps" /></div>`;
    };

    const restCell = (s, si) => {
      const isLastSet = si === ex.sets.length - 1;
      return isLastSet
        ? `<div class="rest-placeholder">—</div>`
        : `<div class="input-suffix rest" data-suffix="min"><input type="number" inputmode="decimal" step="0.5" min="0" value="${escapeHtml(s.restMinutes ?? '')}" data-ex="${idx}" data-set="${si}" data-field="restMinutes" /></div>`;
    };

    const setsHtml = ex.sets.map((s, si) => {
      const label = s.warmup ? 'W' : String(si + 1);
      const labelClass = s.warmup ? 'set-label warmup' : 'set-label';
      return `
        <div class="set-row">
          <div class="${labelClass}">${label}</div>
          ${weightCell(s, si)}
          ${measureCell(s, si)}
          ${restCell(s, si)}
          <input type="checkbox" class="set-done" data-ex="${idx}" data-set="${si}" data-field="done" ${s.done ? 'checked' : ''} />
        </div>`;
    }).join('');

    let target;
    if (type === 'distance') {
      target = `${ex.target.distance} · ${isBW ? 'BW' : (ex.target.weight ?? '?') + (ex.target.unit || '')}`;
    } else if (type === 'duration') {
      target = isBW
        ? ex.target.duration
        : `${ex.target.duration} · ${(ex.target.weight ?? '?')}${ex.target.unit || ''}`;
    } else {
      target = isBW
        ? `${ex.target.reps} reps · BW`
        : `${ex.target.reps} reps · ${ex.target.weight ?? '?'}${ex.target.unit || ''}`;
    }

    return `
      <div class="exercise" data-exercise="${idx}">
        <div class="exercise-header">
          <div class="exercise-name">${escapeHtml(ex.name)}</div>
          <div class="exercise-target">${escapeHtml(target)}</div>
        </div>
        ${ex.routineNote ? `<div class="exercise-notes">${escapeHtml(ex.routineNote)}</div>` : ''}
        ${ex.previousSets ? `<div class="last-summary">${fmtLast({ sets: ex.previousSets }, ex.previousFrom ? `Last (${ex.previousFrom})` : 'Last')}</div>` : ''}
        ${ex.previousNotes ? `<div class="prev-notes">📝 ${escapeHtml(ex.previousNotes)}</div>` : ''}
        <div class="set-row set-header">
          <div class="set-label">#</div>
          <div class="col-head">${isBW ? '' : 'weight'}</div>
          <div class="col-head">${measureCol}</div>
          <div class="col-head">rest</div>
          <div class="col-head">✓</div>
        </div>
        ${setsHtml}
        <textarea class="notes-input" placeholder="Notes (optional)" data-ex="${idx}" data-field="notes">${escapeHtml(ex.notes || '')}</textarea>
      </div>`;
  }

  const lastDate = parseLocalDate(lastSession?.date) || parseLocalDate(lastSession?.completedAt);
  let lastBanner;
  if (!lastDate) {
    lastBanner = `<div class="last-workout-banner"><span class="label">Last ${escapeHtml(routine.name)}:</span> <span class="value na">N/A</span></div>`;
  } else {
    const days = Math.max(0, Math.round((startOfLocalDay() - startOfLocalDay(lastDate)) / 86400000));
    const phrase = days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
    lastBanner = `<div class="last-workout-banner"><span class="label">Last ${escapeHtml(routine.name)}:</span> <span class="value">${phrase}</span> <span class="date-aside">(${escapeHtml(lastSession.date)})</span></div>`;
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

  function applyField(t) {
    const exIdx = t.dataset.ex;
    if (exIdx == null) return false;
    const ex = session.exercises[+exIdx];
    if (!ex) return false;
    if (t.dataset.set != null) {
      const set = ex.sets[+t.dataset.set];
      if (!set) return false;
      const field = t.dataset.field;
      if (field === 'done') set.done = !!t.checked;
      else if (field === 'weight') {
        const n = Number(t.value);
        set.weight = t.value === '' || Number.isNaN(n) ? null : n;
      } else if (field === 'reps') {
        const n = Number(t.value);
        set.reps = t.value === '' || Number.isNaN(n) ? null : n;
      } else if (field === 'restMinutes') {
        const n = Number(t.value);
        set.restMinutes = t.value === '' || Number.isNaN(n) ? null : n;
      } else if (field === 'distance') set.distance = t.value === '' ? null : t.value;
      else if (field === 'duration') set.duration = t.value === '' ? null : t.value;
      else return false;
    } else if (t.dataset.field === 'notes') {
      ex.notes = t.value;
    } else {
      return false;
    }
    return true;
  }

  container.addEventListener('input', e => {
    if (applyField(e.target)) persist();
  });

  container.addEventListener('change', e => {
    if (applyField(e.target)) persist();
  });

  document.getElementById('discard-btn').addEventListener('click', () => {
    if (!confirm('Discard this session?')) return;
    clearDraft(routineId);
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
        .filter(s => s.done || s.weight != null || s.reps != null || s.duration || s.distance)
        .map(s => {
          const out = {};
          if (s.distance) out.distance = s.distance;
          if (s.duration) out.duration = s.duration;
          if (s.weight != null) { out.weight = s.weight; out.unit = s.unit; }
          if (s.reps != null) out.reps = s.reps;
          if (s.restMinutes != null) out.restMinutes = s.restMinutes;
          if (s.warmup) out.warmup = true;
          if (s.done) out.done = true;
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
    clearDraft(session.routineId);
    toast('Saved locally — configure GitHub to sync', 'ok');
    location.hash = '#/';
    return;
  }

  try {
    await saveSession(payload);
    setCachedHistory(payload.routineId, payload);
    state.lastSessions[payload.routineId] = payload;
    clearDraft(session.routineId);
    toast('Session saved to GitHub', 'ok');
    location.hash = '#/';
  } catch (err) {
    console.error(err);
    addPending(payload);
    setCachedHistory(payload.routineId, payload);
    state.lastSessions[payload.routineId] = payload;
    clearDraft(session.routineId);
    toast('Offline — queued for sync', 'error');
    location.hash = '#/';
  }
}

let flushing = false;

async function flushPending() {
  if (flushing) return;
  const list = getPending();
  if (list.length === 0 || !hasSyncConfig() || !navigator.onLine) return;
  flushing = true;
  try {
    const remaining = [];
    for (const s of list) {
      try { await saveSession(s); }
      catch (err) { remaining.push(s); }
    }
    setPending(remaining);
    if (remaining.length < list.length) {
      toast(`Synced ${list.length - remaining.length} session(s)`, 'ok');
      if (location.hash === '#/' || location.hash === '') renderHome(state.routeId);
    }
  } finally {
    flushing = false;
  }
}

function renderSettings() {
  screenTitle.textContent = 'Settings';
  const cfg = getConfig();
  app.innerHTML = `
    <div class="settings-group">
      <label>GitHub username / org</label>
      <input type="text" id="cfg-owner" value="${escapeHtml(cfg.owner)}" placeholder="your-github-username" autocomplete="off" />
    </div>
    <div class="settings-group">
      <label>Repository name</label>
      <input type="text" id="cfg-repo" value="${escapeHtml(cfg.repo)}" autocomplete="off" />
    </div>
    <div class="settings-group">
      <label>Branch</label>
      <input type="text" id="cfg-branch" value="${escapeHtml(cfg.branch)}" autocomplete="off" />
    </div>
    <div class="settings-group">
      <label>Personal access token (fine-grained)</label>
      <input type="password" id="cfg-pat" value="${escapeHtml(cfg.pat)}" placeholder="github_pat_..." autocomplete="off" />
      <div class="help">
        Needs <strong>Contents: read &amp; write</strong> scoped to this repo only.
        Create at github.com → Settings → Developer settings → Fine-grained tokens.
        Stored in this browser's localStorage only.
      </div>
    </div>
    <button class="primary-btn" id="save-cfg">Save settings</button>
    <button class="secondary-btn" id="test-cfg">Test connection</button>
    <div class="app-version">App version ${APP_VERSION}</div>
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
