// Entry point -- wires data, rendering, and event handlers together.
// No exports; this is the bootstrap module.

import { loadInitialData } from './data.js';
import { state, IS_MAC } from './state.js';
import {
  renderAll,
  renderMemoryList,
  renderSessionList,
  setRoute,
  setView,
  setProject,
  enterDetail,
  archive,
  restore,
  setCursor,
  navigateToSession,
  switchView
} from './render.js';
import { initKeyboard } from './keys.js';

// -- Helpers ----------------------------------------------------------------

let searchDebounceTimer = null;

function debounce(fn, ms) {
  return (...args) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => fn(...args), ms);
  };
}

// -- Boot -------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  await loadInitialData();
  initKeyboard();

  // -- Sidebar navigation (route switching + project filter) ----------------

  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    sidebar.addEventListener('click', e => {
      const item = e.target.closest('.sidebar-item');
      if (!item) return;

      const route = item.dataset.route;
      const project = item.dataset.project;
      const view = item.dataset.view;

      if (route) {
        setRoute(route);
      } else if (view) {
        setView(view);
      } else if (project !== undefined) {
        setProject(project);
      }
    });
  }

  // -- Sidebar search (filter projects list) --------------------------------

  const sidebarSearch = document.querySelector('.sidebar-search input');
  if (sidebarSearch) {
    sidebarSearch.addEventListener('input', e => {
      state.projectSearch = e.target.value;
      renderAll();
    });
  }

  // -- Breadcrumb click (navigate back to list) -----------------------------

  const breadcrumb = document.querySelector('.breadcrumb');
  if (breadcrumb) {
    breadcrumb.addEventListener('click', e => {
      const crumb = e.target.closest('[data-action]');
      if (!crumb) return;
      const action = crumb.dataset.action;
      if (action === 'goto-sessions') { state.projectFilter = 'all'; setRoute('sessions'); }
      else if (action === 'goto-memory') { state.projectFilter = 'all'; setView('active'); }
      else if (action === 'goto-session-detail') { state.subagentId = null; state.subagentDescription = null; switchView(); renderAll(); }
    });
  }

  // -- Toolbar search with debounce -----------------------------------------

  const searchInput = document.getElementById('search');
  if (searchInput) {
    const handleSearch = debounce(value => {
      state.query = value;
      if (state.route === 'sessions') renderSessionList();
      else renderMemoryList();
    }, 200);

    searchInput.addEventListener('input', e => {
      handleSearch(e.target.value);
    });
  }

  // -- Sort toggle -----------------------------------------------------------

  const sortToggle = document.querySelector('.sort-group');
  if (sortToggle) {
    sortToggle.addEventListener('click', () => {
      state.sortDesc = !state.sortDesc;
      sortToggle.classList.toggle('desc', state.sortDesc);
      sortToggle.classList.toggle('asc', !state.sortDesc);
      if (state.route === 'sessions') renderSessionList();
      else renderMemoryList();
    });
  }

  // -- Search messages toggle ------------------------------------------------

  const searchMsgsToggle = document.querySelector('.filter-toggle');
  if (searchMsgsToggle) {
    searchMsgsToggle.addEventListener('click', () => {
      state.includeMessageBodies = !state.includeMessageBodies;
      searchMsgsToggle.classList.toggle('active', state.includeMessageBodies);
      if (state.query) {
        if (state.route === 'sessions') renderSessionList();
        else renderMemoryList();
      }
    });
  }

  // -- #list click (memory rows: selection, actions, navigation) ------------

  const list = document.getElementById('list');
  if (list) {
    list.addEventListener('click', e => {
      // Action buttons (archive/restore)
      const action = e.target.closest('.row-action');
      if (action) {
        e.stopPropagation();
        const row = action.closest('.row');
        const id = row?.dataset.id;
        if (!id) return;
        if (action.classList.contains('restore')) {
          restore([id]);
        } else {
          archive([id]);
        }
        return;
      }

      // Checkbox toggling
      const checkbox = e.target.closest('.row-checkbox');
      if (checkbox) {
        e.stopPropagation();
        const row = checkbox.closest('.row');
        const id = row?.dataset.id;
        if (!id) return;

        if (e.shiftKey && state.cursorId) {
          // Range select between cursor and clicked
          const rows = Array.from(list.querySelectorAll('.row'));
          const ids = rows.map(r => r.dataset.id);
          const fromIdx = ids.indexOf(state.cursorId);
          const toIdx = ids.indexOf(id);
          const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
          for (let i = lo; i <= hi; i++) {
            state.selection.add(ids[i]);
          }
        } else if (e.metaKey || e.ctrlKey) {
          // Toggle single
          if (state.selection.has(id)) state.selection.delete(id);
          else state.selection.add(id);
        } else {
          // Simple toggle
          if (state.selection.has(id)) state.selection.delete(id);
          else state.selection.add(id);
        }
        setCursor(id);
        renderMemoryList();
        return;
      }

      // Row click (navigate cursor / open detail)
      const row = e.target.closest('.row');
      if (!row) return;
      const id = row.dataset.id;
      if (!id) return;

      if (e.shiftKey && state.cursorId) {
        // Shift-click: range select
        const rows = Array.from(list.querySelectorAll('.row'));
        const ids = rows.map(r => r.dataset.id);
        const fromIdx = ids.indexOf(state.cursorId);
        const toIdx = ids.indexOf(id);
        const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
        for (let i = lo; i <= hi; i++) {
          state.selection.add(ids[i]);
        }
        renderMemoryList();
      } else if ((IS_MAC ? e.metaKey : e.ctrlKey)) {
        // Cmd/Ctrl-click: toggle selection
        if (state.selection.has(id)) state.selection.delete(id);
        else state.selection.add(id);
        setCursor(id);
        renderMemoryList();
      } else {
        // Plain click: move cursor
        setCursor(id);
        renderMemoryList();
      }
    });

    // -- #list dblclick (open detail) -----------------------------------------

    list.addEventListener('dblclick', e => {
      const row = e.target.closest('.row');
      if (!row) return;
      const id = row.dataset.id;
      if (id) enterDetail(id);
    });
  }

  // -- #session-list click (session rows) ------------------------------------

  const sessionList = document.getElementById('session-list');
  if (sessionList) {
    sessionList.addEventListener('click', e => {
      const srow = e.target.closest('.srow');
      if (!srow) return;
      const id = srow.dataset.sessionId;
      if (id) navigateToSession(id);
    });
  }

  // -- Start on memory view -------------------------------------------------

  setRoute('memory');
  renderAll();
});
