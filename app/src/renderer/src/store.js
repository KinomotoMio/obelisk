// Shared renderer state. Navigation state belongs to Vue Router; this store
// holds only data and cross-view UI preferences.

import { reactive, markRaw } from 'vue';

export const state = reactive({
  memories: [],
  sessions: [],
  projects: [],
  stats: {},
  view: 'active',          // 'active' | 'archived'
  pendingFocusUuid: null,
  query: '',
  projectFilter: 'all',
  sourceFilter: 'all',
  projectSearch: '',
  sortDesc: true,
  includeMessageBodies: false,
  cursorId: null,
  selection: markRaw(new Set()),
  loaded: false
});

// SVG icon constants
export const FOLDER_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 4h4l1.5 1.5h5.5v7a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-8z"/></svg>`;

// --- Action functions ---

export function setSelection(ids) {
  state.selection = markRaw(new Set(ids));
}

export function clearSelection() {
  setSelection([]);
}

export function resetListState() {
  state.cursorId = null;
  clearSelection();
  state.query = '';
}

export function setView(v) {
  state.view = v;
  state.cursorId = null;
  clearSelection();
  state.projectFilter = 'all';
}

export function setProject(p) {
  state.projectFilter = p;
  state.cursorId = null;
  clearSelection();
}

export function toggleSort() {
  state.sortDesc = !state.sortDesc;
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
