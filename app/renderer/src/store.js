// Reactive store -- Vue 3 reactive() replaces the plain object from state.js.
// All state fields are ported; action functions mutate the reactive state.

import { reactive, markRaw } from 'vue';

export const state = reactive({
  memories: [],
  sessions: [],
  projects: [],
  stats: {},
  route: 'memory',
  view: 'active',          // 'active' | 'archived'
  mode: 'list',            // 'list' | 'detail'
  detailId: null,
  subagentId: null,
  subagentDescription: null,
  pendingFocusUuid: null,
  query: '',
  projectFilter: 'all',
  projectSearch: '',
  sortDesc: true,
  includeMessageBodies: false,
  cursorId: null,
  selection: markRaw(new Set()),
  showSource: false,
  lastArchiveSnapshot: null,
  undoTimer: null,
  undoExpires: 0,
  loaded: false
});

// Platform detection
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

// SVG icon constants
export const FOLDER_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 4h4l1.5 1.5h5.5v7a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-8z"/></svg>`;
export const FILE_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M3.5 2h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9.5 2v3h3"/></svg>`;

// --- Action functions ---

export function setRoute(route) {
  state.route = route;
  state.mode = 'list';
  state.detailId = null;
  state.cursorId = null;
  state.selection = markRaw(new Set());
  state.query = '';
}

export function setView(v) {
  state.route = 'memory';
  state.view = v;
  state.mode = 'list';
  state.detailId = null;
  state.cursorId = null;
  state.selection = markRaw(new Set());
  state.projectFilter = 'all';
}

export function setProject(p) {
  state.projectFilter = p;
  state.cursorId = null;
  state.selection = markRaw(new Set());
  state.mode = 'list';
  state.detailId = null;
}

export function toggleSort() {
  state.sortDesc = !state.sortDesc;
}

export function enterDetail(id) {
  state.detailId = id;
  state.mode = 'detail';
  state.showSource = false;
}

export function exitDetail() {
  if (state.subagentId) {
    state.subagentId = null;
    state.subagentDescription = null;
    return;
  }
  state.mode = 'list';
  state.detailId = null;
  state.pendingFocusUuid = null;
}

export function navigateToSession(sessionId, focusUuid) {
  state.route = 'sessions';
  state.mode = 'detail';
  state.detailId = sessionId;
  state.subagentId = null;
  state.subagentDescription = null;
  state.pendingFocusUuid = focusUuid || null;
  state.query = '';
}

export function navigateToSubagent(agentId, description) {
  state.subagentId = agentId;
  state.subagentDescription = description || agentId;
}

export function setCursor(id, opts = {}) {
  state.cursorId = id;
  if (!opts.keepSelection) {
    state.selection = markRaw(new Set());
  }
}

export function setQuery(q) {
  state.query = q;
}

export function setProjectSearch(q) {
  state.projectSearch = q;
}

export function toggleIncludeMessageBodies() {
  state.includeMessageBodies = !state.includeMessageBodies;
}

export function clearUndo() {
  state.lastArchiveSnapshot = null;
  if (state.undoTimer) {
    clearInterval(state.undoTimer);
    state.undoTimer = null;
  }
}
