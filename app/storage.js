const KEY = {
  pat: 'wt.github.pat',
  owner: 'wt.github.owner',
  repo: 'wt.github.repo',
  branch: 'wt.github.branch',
  draftPrefix: 'wt.draft.',
  draftLegacy: 'wt.draft',
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

function readJSON(key, fallback) {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function draftKey(routineId) {
  return `${KEY.draftPrefix}${routineId}`;
}

export function getDraft(routineId) {
  // Per-routine key (current).
  const d = readJSON(draftKey(routineId), null);
  if (d) return d;
  // Migrate legacy single global draft once: adopt it if it belongs to
  // this routine, otherwise leave other routines' drafts untouched.
  const legacy = readJSON(KEY.draftLegacy, null);
  if (legacy && legacy.routineId === routineId) {
    try { localStorage.setItem(draftKey(routineId), JSON.stringify(legacy)); } catch {}
    return legacy;
  }
  return null;
}

export function saveDraft(draft) {
  if (!draft || !draft.routineId) return;
  localStorage.setItem(draftKey(draft.routineId), JSON.stringify(draft));
}

export function clearDraft(routineId) {
  if (routineId) {
    localStorage.removeItem(draftKey(routineId));
    // Also drop a legacy global draft for the same routine, if present.
    const legacy = readJSON(KEY.draftLegacy, null);
    if (legacy && legacy.routineId === routineId) {
      localStorage.removeItem(KEY.draftLegacy);
    }
    return;
  }
  localStorage.removeItem(KEY.draftLegacy);
}

export function getCachedHistory(routineId) {
  const all = readJSON(KEY.history, null);
  if (!all || typeof all !== 'object') return null;
  return all[routineId] || null;
}

export function setCachedHistory(routineId, session) {
  const all = readJSON(KEY.history, {});
  const next = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  next[routineId] = session;
  localStorage.setItem(KEY.history, JSON.stringify(next));
}

export function getPending() {
  const list = readJSON(KEY.pending, []);
  return Array.isArray(list) ? list : [];
}

export function addPending(session) {
  const list = getPending();
  list.push(session);
  localStorage.setItem(KEY.pending, JSON.stringify(list));
}

export function setPending(list) {
  localStorage.setItem(KEY.pending, JSON.stringify(Array.isArray(list) ? list : []));
}

export function markSynced() {
  localStorage.setItem(KEY.lastSync, new Date().toISOString());
}
