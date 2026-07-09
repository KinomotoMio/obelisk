// App state -- single source of truth for the renderer process.
// Loaded collections (memories, sessions, projects) start empty and are
// populated from the DB at boot.

export const state = {
  memories: [],
  sessions: [],
  projects: [],
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
  selection: new Set(),
  showSource: false,
  lastArchiveSnapshot: null,
  undoTimer: null,
  undoExpires: 0
};

// Platform detection
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

// SVG icon constants
export const FOLDER_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 4h4l1.5 1.5h5.5v7a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-8z"/></svg>`;
export const FILE_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M3.5 2h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9.5 2v3h3"/></svg>`;
