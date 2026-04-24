const KEY = {
  pat: 'wt.github.pat',
  owner: 'wt.github.owner',
  repo: 'wt.github.repo',
  branch: 'wt.github.branch',
  draft: 'wt.draft',
  history: 'wt.history',
  pending: 'wt.pending',
  lastSync: 'wt.lastSync',
};

export function getConfig() {
  return {
    pat: localStorage.getItem(KEY.pat) || '',
    owner: localStorage.getItem(KEY.owner) || '',
    repo: localStorage.getItem(KEY.repo) || 'workout_tracker',
    branch: localStorage.getItem(KEY.branch) || 'main',
  };
}

export function setConfig({ pat, owner, repo, branch }) {
  if (pat !== undefined)    localStorage.setItem(KEY.pat, pat);
  if (owner !== undefined)  localStorage.setItem(KEY.owner, owner);
  if (repo !== undefined)   localStorage.setItem(KEY.repo, repo);
  if (branch !== undefined) localStorage.setItem(KEY.branch, branch);
}

export function hasSyncConfig() {
  const c = getConfig();
  return !!(c.pat && c.owner && c.repo);
}

export function getDraft(routineId) {
  const raw = localStorage.getItem(KEY.draft);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    if (d.routineId !== routineId) return null;
    return d;
  } catch { return null; }
}

export function saveDraft(draft) {
  localStorage.setItem(KEY.draft, JSON.stringify(draft));
}

export function clearDraft() {
  localStorage.removeItem(KEY.draft);
}

export function getCachedHistory(routineId) {
  const raw = localStorage.getItem(KEY.history);
  if (!raw) return null;
  try {
    const all = JSON.parse(raw);
    return all[routineId] || null;
  } catch { return null; }
}

export function setCachedHistory(routineId, session) {
  const raw = localStorage.getItem(KEY.history);
  const all = raw ? JSON.parse(raw) : {};
  all[routineId] = session;
  localStorage.setItem(KEY.history, JSON.stringify(all));
}

export function getPending() {
  const raw = localStorage.getItem(KEY.pending);
  return raw ? JSON.parse(raw) : [];
}

export function addPending(session) {
  const list = getPending();
  list.push(session);
  localStorage.setItem(KEY.pending, JSON.stringify(list));
}

export function setPending(list) {
  localStorage.setItem(KEY.pending, JSON.stringify(list));
}

export function markSynced() {
  localStorage.setItem(KEY.lastSync, new Date().toISOString());
}
