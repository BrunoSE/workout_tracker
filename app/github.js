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
    const matching = files
      .filter(f => f.name.endsWith(`_${routineId}.json`))
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
      const m = f.name.match(/^(\d{4}-\d{2}-\d{2})_(.+)\.json$/);
      if (!m) continue;
      const [, date, routineId] = m;
      if (!byRoutine[routineId] || byRoutine[routineId].name < f.name) {
        byRoutine[routineId] = f;
      }
    }
    const result = {};
    for (const [routineId, file] of Object.entries(byRoutine)) {
      try {
        const session = await fetchLog(file.path);
        setCachedHistory(routineId, session);
        result[routineId] = session;
      } catch (e) { console.warn('fetchLog failed', file.path, e); }
    }
    return result;
  } catch (err) {
    console.warn('loadAllLastSessions failed', err);
    return {};
  }
}

export async function saveSession(session) {
  if (!hasSyncConfig()) throw new Error('GitHub not configured');
  const { owner, repo, branch } = getConfig();
  const filename = `${session.date}_${session.routineId}.json`;
  const path = `logs/${filename}`;
  const url = `${API}/repos/${owner}/${repo}/contents/${path}`;

  let sha;
  try {
    const existing = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers: authHeaders() });
    if (existing.ok) sha = (await existing.json()).sha;
  } catch {}

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
