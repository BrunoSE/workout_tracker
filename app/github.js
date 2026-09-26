import { getConfig, hasSyncConfig, setCachedHistory, getCachedHistory, getCachedExerciseSeeds, setCachedExerciseSeeds, getPending } from './storage.js';
import { canonicalExerciseName } from './names.js';

const API = 'https://api.github.com';

function authHeaders() {
  const { pat } = getConfig();
  return {
    'Authorization': `Bearer ${pat}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64decode(str) {
  return decodeURIComponent(escape(atob(str.replace(/\s/g, ''))));
}

// Log filenames are `<date>_<routineId>.json`, with an optional `_tHHMMSS`
// suffix (plus `_2`, `_3`, …) when the same routine is logged twice on one
// day, e.g. `2026-09-24_full_1.json` then `2026-09-24_full_1_t183045.json`.
// The `_t` marker keeps the suffix unambiguous (routine ids themselves
// contain underscores, e.g. `legh_1`).
export function parseLogName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})_(.+?)(?:_t(\d{4}|\d{6})(?:_\d+)?)?\.json$/.exec(name || '');
  if (!m) return null;
  return { date: m[1], routineId: m[2] };
}

export async function listLogs() {
  if (!hasSyncConfig()) return [];
  const { owner, repo, branch } = getConfig();
  const url = `${API}/repos/${owner}/${repo}/contents/logs?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`listLogs ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.filter(f => f.type === 'file' && f.name.endsWith('.json'));
}

export async function fetchLog(path) {
  const { owner, repo, branch } = getConfig();
  const url = `${API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`fetchLog ${res.status}`);
  const data = await res.json();
  return JSON.parse(b64decode(data.content));
}

export async function loadLastSessionForRoutine(routineId) {
  if (!hasSyncConfig()) return getCachedHistory(routineId);
  try {
    const files = await listLogs();
    // parseLogName handles both `date_id.json` and `date_id_tHHMM.json`
    // (lexicographic order == chronological, so the first after sorting
    // desc is the newest, including any same-day second session).
    const matching = files
      .filter(f => parseLogName(f.name)?.routineId === routineId)
      .sort((a, b) => b.name.localeCompare(a.name));
    if (matching.length === 0) return getCachedHistory(routineId);
    const session = await fetchLog(matching[0].path);
    setCachedHistory(routineId, session);
    return session;
  } catch (err) {
    console.warn('loadLastSession failed, using cache', err);
    return getCachedHistory(routineId);
  }
}

export async function loadAllLastSessions() {
  if (!hasSyncConfig()) return {};
  try {
    const files = await listLogs();
    const byRoutine = {};
    for (const f of files) {
      const parsed = parseLogName(f.name);
      if (!parsed) continue;
      if (!byRoutine[parsed.routineId] || byRoutine[parsed.routineId].name < f.name) {
        byRoutine[parsed.routineId] = f;
      }
    }
    // Fetch each routine's latest file in parallel instead of one by one.
    const entries = await Promise.all(
      Object.entries(byRoutine).map(async ([routineId, file]) => {
        try {
          const session = await fetchLog(file.path);
          setCachedHistory(routineId, session);
          return [routineId, session];
        } catch (e) {
          console.warn('fetchLog failed', file.path, e);
          return null;
        }
      })
    );
    return Object.fromEntries(entries.filter(Boolean));
  } catch (err) {
    console.warn('loadAllLastSessions failed', err);
    return {};
  }
}

function seedFromExercise(ex, session) {
  if (!ex || !ex.name || !Array.isArray(ex.sets)) return null;
  return {
    sets: ex.sets,
    notes: ex.notes || '',
    date: session.date || '',
    routineId: session.routineId,
    routineName: session.routineName || session.routineId,
  };
}

// Pure merge: fold sessions into a seed map keyed by canonical exercise
// name (aliases like "Calf raise"/"Calf raises" share one entry), newest
// date wins per exercise. Same-date ties keep the existing entry, which
// gives the same-routine fallback (merged first) priority over other
// routines from the same day.
export function mergeExerciseSeeds(baseSeeds, sessions) {
  const merged = { ...(baseSeeds || {}) };
  for (const s of sessions || []) {
    if (!s || !Array.isArray(s.exercises)) continue;
    for (const ex of s.exercises) {
      const seed = seedFromExercise(ex, s);
      if (!seed) continue;
      const key = canonicalExerciseName(ex.name);
      const cur = merged[key];
      if (!cur || (seed.date || '') > (cur.date || '')) merged[key] = seed;
    }
  }
  return merged;
}

// Latest sets/weight per exercise across ALL routines (not just this one).
// `fallbackSession` is the routine's own last session (or its cache) so the
// same routine stays the tie-breaker and offline still seeds what it can.
// Result is cached for offline gym use. Caps GitHub reads to the most recent
// files so history growth doesn't slow down opening a session.
const SEED_FILE_LIMIT = 12;

export async function loadExerciseSeeds(fallbackSession) {
  const fb = fallbackSession ? [fallbackSession] : [];
  const cached = getCachedExerciseSeeds();
  // Sessions saved while offline sit in the pending queue before reaching
  // GitHub — they still happened, so they count as seeds.
  const pending = getPending();
  if (!hasSyncConfig() || typeof navigator === 'undefined' || !navigator.onLine) {
    return mergeExerciseSeeds(cached, [...pending, ...fb]);
  }
  try {
    const files = (await listLogs())
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, SEED_FILE_LIMIT);
    const sessions = (
      await Promise.all(
        files.map(async f => {
          try { return await fetchLog(f.path); }
          catch (e) { console.warn('fetchLog failed', f.path, e); return null; }
        })
      )
    ).filter(Boolean);
    const merged = mergeExerciseSeeds(cached, [...pending, ...fb, ...sessions]);
    setCachedExerciseSeeds(merged);
    return merged;
  } catch (err) {
    console.warn('loadExerciseSeeds failed, using cache', err);
    return mergeExerciseSeeds(cached, [...pending, ...fb]);
  }
}

async function fileInfo(url) {
  try {
    const existing = await fetch(url, { headers: authHeaders() });
    if (!existing.ok) return null;
    const data = await existing.json();
    return { sha: data.sha, content: String(data.content || '').replace(/\s/g, '') };
  } catch {
    return null;
  }
}

export async function saveSession(session) {
  if (!hasSyncConfig()) throw new Error('GitHub not configured');
  const { owner, repo, branch } = getConfig();
  const base = `${session.date}_${session.routineId}.json`;
  const baseUrl = `${API}/repos/${owner}/${repo}/contents/logs/${base}?ref=${encodeURIComponent(branch)}`;
  const newContent = b64encode(JSON.stringify(session, null, 2) + '\n');

  // Second workout of the same routine on the same day gets its own file
  // instead of silently overwriting the first one. A retry of an identical
  // payload reuses the existing file (same content → same sha update), so
  // failed uploads stay idempotent instead of duplicating.
  let filename = base;
  let sha;
  const baseInfo = await fileInfo(baseUrl);
  if (!baseInfo) {
    sha = undefined;
  } else if (baseInfo.content === newContent) {
    sha = baseInfo.sha;
  } else {
    const d = new Date(session.completedAt || Date.now());
    const p2 = n => String(n).padStart(2, '0');
    const stamp = `t${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    let done = false;
    for (let n = 0; n < 50 && !done; n++) {
      const candidate = n === 0
        ? `${session.date}_${session.routineId}_${stamp}.json`
        : `${session.date}_${session.routineId}_${stamp}_${n + 1}.json`;
      const info = await fileInfo(
        `${API}/repos/${owner}/${repo}/contents/logs/${candidate}?ref=${encodeURIComponent(branch)}`
      );
      if (!info || info.content === newContent) {
        filename = candidate;
        sha = info?.sha;
        done = true;
      }
    }
    if (!done) {
      // Practically unreachable (50 same-second saves); overwrite rather
      // than fail the save.
      filename = `${session.date}_${session.routineId}_${stamp}_x.json`;
      sha = (await fileInfo(
        `${API}/repos/${owner}/${repo}/contents/logs/${filename}?ref=${encodeURIComponent(branch)}`
      ))?.sha;
    }
  }
  const url = `${API}/repos/${owner}/${repo}/contents/logs/${filename}`;

  const body = {
    message: `log: ${session.routineId} session ${session.date}`,
    content: newContent,
    branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`saveSession ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function testAuth() {
  if (!hasSyncConfig()) throw new Error('Missing PAT / owner / repo');
  const { owner, repo } = getConfig();
  const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Auth test failed ${res.status}`);
  return res.json();
}
