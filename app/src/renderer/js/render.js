// Rendering coordinator -- thin orchestration layer.
// Delegates to extracted modules; keeps only cross-module functions locally.

import { state } from './state.js';
import { archiveMemory, restoreMemory } from './data.js';
import registry from './registry.js';

// --- Module imports ---
import { escapeHTML, $ } from './utils.js';
import { renderSidebar, renderBreadcrumb, updateWindowTitle } from './sidebar.js';
import { visibleMemories as _visibleMemories, renderMemoryList, renderMemoryDetail } from './memory-list.js';
import { renderSessionList, renderSessionDetail } from './session-list.js';
import { renderUsage } from './usage.js';

// --- Data filtering (coordinator owns the cross-module view) ---

export function visibleMemories() { return _visibleMemories(); }

export function visibleSessions() {
  const q = state.query.trim().toLowerCase();
  return state.sessions
    .filter(s => state.projectFilter === 'all' || s.project === state.projectFilter)
    .map(s => {
      if (!q) return { ...s, messageHit: null };
      const topMatch = (s.title || '').toLowerCase().includes(q) ||
                       (s.project || '').toLowerCase().includes(q) ||
                       (s.git_branch || '').toLowerCase().includes(q);
      if (topMatch) return { ...s, messageHit: null };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ta = new Date(a.started_at || 0).getTime();
      const tb = new Date(b.started_at || 0).getTime();
      return state.sortDesc ? tb - ta : ta - tb;
    });
}

// --- Cursor / selection ---

export function flatList() { return visibleMemories(); }

export function cursorIndex() {
  const flat = flatList();
  if (!state.cursorId) return -1;
  return flat.findIndex(m => m.id === state.cursorId);
}

export function moveCursor(delta, extendSelection = false) {
  const flat = flatList();
  if (!flat.length) return;
  let idx = cursorIndex();
  if (idx === -1) idx = 0;
  else idx = Math.max(0, Math.min(flat.length - 1, idx + delta));
  const newId = flat[idx].id;
  if (extendSelection) { state.selection.add(state.cursorId); state.selection.add(newId); }
  state.cursorId = newId;
  renderMemoryList(); renderStatus();
}

export function setCursor(id, opts = {}) {
  state.cursorId = id;
  if (!opts.keepSelection) state.selection.clear();
  renderMemoryList(); renderStatus();
}

// --- Mutations ---

export function archive(ids) { if (!ids.length) return; doMutation(ids, true); }
export function restore(ids) { if (!ids.length) return; doMutation(ids, false); }

async function doMutation(ids, toArchived) {
  for (const id of ids) {
    if (toArchived) await archiveMemory(id);
    else await restoreMemory(id);
  }
  state.selection = new Set();
  if (state.mode === 'detail' && state.route === 'memory' && ids.includes(state.detailId)) exitDetail();
  const flat = flatList();
  if (state.cursorId && !flat.find(m => m.id === state.cursorId)) state.cursorId = flat[0]?.id ?? null;
  state.lastArchiveSnapshot = ids;
  state.undoExpires = Date.now() + 5000;
  clearInterval(state.undoTimer);
  state.undoTimer = setInterval(() => {
    if (Date.now() >= state.undoExpires) { state.lastArchiveSnapshot = null; clearInterval(state.undoTimer); }
    renderStatus();
  }, 500);
  renderAll();
}

export async function doUndo() {
  if (!state.lastArchiveSnapshot) return;
  for (const id of state.lastArchiveSnapshot) {
    const m = state.memories.find(x => x.id === id);
    if (m) {
      if (m.archived) await restoreMemory(id);
      else await archiveMemory(id);
    }
  }
  state.lastArchiveSnapshot = null;
  clearInterval(state.undoTimer);
  renderAll();
}

// --- Navigation ---

export function navigateToSession(sessionId, focusUuid) {
  state.route = 'sessions'; state.mode = 'detail';
  state.detailId = sessionId;
  state.subagentId = null;
  state.subagentDescription = null;
  state.pendingFocusUuid = focusUuid || null;
  state.query = '';
  const searchEl = $('#search');
  if (searchEl) searchEl.value = '';
  switchView(); renderAll();
}

export function navigateToSubagent(agentId, description) {
  state.subagentId = agentId;
  state.subagentDescription = description || agentId;
  switchView(); renderAll();
}

export function enterDetail(id) { state.detailId = id; state.mode = 'detail'; state.showSource = false; switchView(); renderAll(); }

export function exitDetail() {
  if (state.subagentId) {
    state.subagentId = null;
    state.subagentDescription = null;
    switchView(); renderAll();
    return;
  }
  state.mode = 'list'; state.detailId = null; state.pendingFocusUuid = null; switchView(); renderAll();
}

export function setRoute(route) {
  state.route = route; state.mode = 'list'; state.detailId = null;
  state.cursorId = null; state.selection.clear();
  state.query = ''; const s = $('#search'); if (s) s.value = '';
  switchView(); renderAll();
  if (route === 'memory') { const flat = visibleMemories(); if (flat.length) state.cursorId = flat[0].id; }
}

export function setView(v) {
  state.route = 'memory'; state.view = v; state.mode = 'list'; state.detailId = null;
  state.cursorId = null; state.selection.clear(); state.projectFilter = 'all';
  switchView(); renderAll();
  const flat = visibleMemories();
  if (flat.length) state.cursorId = flat[0].id;
  renderMemoryList();
}

export function setProject(p) {
  state.projectFilter = p; state.cursorId = null; state.selection.clear();
  state.mode = 'list'; state.detailId = null;
  switchView(); renderAll();
  if (state.route === 'memory') { const flat = visibleMemories(); if (flat.length) state.cursorId = flat[0].id; }
}

export function toggleSort() {
  state.sortDesc = !state.sortDesc;
  const btn = $('#sort-toggle');
  if (btn) { btn.classList.toggle('desc', state.sortDesc); btn.classList.toggle('asc', !state.sortDesc); }
  const lbl = $('#sort-label');
  if (lbl) lbl.textContent = state.sortDesc ? 'newest' : 'oldest';
  if (state.route === 'sessions') renderSessionList();
  else renderMemoryList();
}

export function switchView() {
  const showList = state.mode === 'list';
  const showSessions = state.route === 'sessions';
  const showUsage = state.route === 'usage';
  const inSessionDetail = !showList && showSessions;
  const inSubagent = inSessionDetail && !!state.subagentId;
  const el = (id, show) => { const e = $(id); if (e) e.style.display = show ? '' : 'none'; };
  el('#list-wrap', showList && !showSessions && !showUsage);
  el('#detail-wrap', !showList && !showSessions && !showUsage);
  el('#session-list-wrap', showList && showSessions);
  el('#session-detail-wrap', inSessionDetail && !inSubagent);
  el('#subagent-detail-wrap', inSubagent);
  el('#usage-wrap', showUsage);
  el('#search-wrap', showList && !showUsage);
  el('#sort-toggle', showList && !showUsage);
  el('#search-msgs-toggle', showList && showSessions);
}

// --- Status bar ---

export function renderStatus() {
  const left = $('#status-left');
  const right = $('#status-right');
  if (!left || !right) return;

  if (state.route === 'sessions' && state.mode === 'list') {
    right.innerHTML = `<span class="kbd-hint"><span class="kbd">⏎</span> open</span><span class="kbd-hint secondary"><span class="kbd">/</span> search</span>`;
  } else if (state.route === 'sessions' && state.mode === 'detail') {
    right.innerHTML = `<span class="kbd-hint"><span class="kbd">Esc</span> back</span>`;
  } else if (state.mode === 'detail') {
    right.innerHTML = `<span class="kbd-hint"><span class="kbd">Esc</span> back</span><span class="kbd-hint"><span class="kbd">D</span> archive</span>`;
  } else {
    right.innerHTML = `<span class="kbd-hint"><span class="kbd">↑↓</span> nav</span><span class="kbd-hint"><span class="kbd">⏎</span> open</span><span class="kbd-hint secondary"><span class="kbd">D</span> archive</span><span class="kbd-hint secondary"><span class="kbd">/</span> search</span>`;
  }

  if (state.lastArchiveSnapshot && state.undoExpires > Date.now()) {
    const ids = state.lastArchiveSnapshot;
    const secs = Math.ceil((state.undoExpires - Date.now()) / 1000);
    const target = ids.length === 1 ? (state.memories.find(x => x.id === ids[0])?.path || '').split('/').pop() : `${ids.length} memories`;
    left.innerHTML = `<span class="status-pending">Action pending <strong>${escapeHTML(target)}</strong><button class="undo-btn" id="undo-btn">Undo</button><span class="timer">${secs}s</span></span>`;
    $('#undo-btn')?.addEventListener('click', doUndo);
    return;
  }
  left.textContent = '';
}

// --- Master render ---

export function renderAll() {
  renderSidebar();
  renderBreadcrumb();
  switchView();
  if (state.route === 'usage') {
    renderUsage();
  } else if (state.route === 'sessions') {
    if (state.mode === 'list') renderSessionList();
    else renderSessionDetail();
  } else {
    if (state.mode === 'list') renderMemoryList();
    else renderMemoryDetail();
  }
  renderStatus();
  updateWindowTitle();
}

// --- Registry (break circular deps for child modules) ---

registry.navigateToSession = navigateToSession;
registry.navigateToSubagent = navigateToSubagent;
registry.exitDetail = exitDetail;
registry.archive = archive;
registry.restore = restore;

// --- Re-exports for app.js and keys.js ---

export { renderMemoryList, renderSessionList, escapeHTML };
