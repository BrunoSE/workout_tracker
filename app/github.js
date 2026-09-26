import { getConfig, hasSyncConfig, setCachedHistory, getCachedHistory } from './storage.js';

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

// Log filenames are `<date>_<routineId>.json`, with an optional `_tHHMM`
// suffix when the same routine is logged twice on one day, e.g.
// `2026-09-24_full_1.json` then `2026-09-24_full_1_t1830.json`.
// The `_t` marker keeps the suffix unambiguous (routine ids themselves
// contain underscores, e.g. `legh_1`).
export function parseLogName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})_(.+?)(?:_t(\d{4}))?\.json$/.exec(name || '');
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

async function fileSha(url) {
  try {
    const existing = await fetch(url, { headers: authHeaders() });
    if (existing.ok) return (await existing.json()).sha;
  } catch {}
  return undefined;
}

export async function saveSession(session) {
  if (!hasSyncConfig()) throw new Error('GitHub not configured');
  const { owner, repo, branch } = getConfig();
  const base = `${session.date}_${session.routineId}.json`;
  const baseUrl = `${API}/repos/${owner}/${repo}/contents/logs/${base}?ref=${encodeURIComponent(branch)}`;

  // Second workout of the same routine on the same day gets its own file
  // instead of silently overwriting the first one.
  let filename = base;
  let sha = await fileSha(baseUrl);
  if (sha) {
    const stamp = (() => {
      const d = new Date(session.completedAt || Date.now());
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `t${hh}${mm}`;
    })();
    filename = `${session.date}_${session.routineId}_${stamp}.json`;
    sha = await fileSha(
      `${API}/repos/${owner}/${repo}/contents/logs/${filename}?ref=${encodeURIComponent(branch)}`
    );
  }
  const url = `${API}/repos/${owner}/${repo}/contents/logs/${filename}`;

  const body = {
    message: `log: ${session.routineId} session ${session.date}`,
    content: b64encode(JSON.stringify(session, null, 2) + '\n'),
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
