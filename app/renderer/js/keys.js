// Keyboard shortcut handling -- ported from the HTML mock.
// Registers a single document-level keydown listener that dispatches
// all navigation, mutation, and route-switching shortcuts.

import { state, IS_MAC } from './state.js';
import {
  renderAll,
  renderMemoryList,
  renderSessionList,
  renderStatus,
  enterDetail,
  exitDetail,
  setRoute,
  setView,
  toggleSort,
  moveCursor,
  archive,
  restore,
  doUndo,
  navigateToSession
} from './render.js';

export function initKeyboard() {
  document.addEventListener('keydown', e => {
    const inInput =
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA';
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;

    // -- Route switching: Cmd+1/2/3/4 --
    if (mod && e.key === '1') { e.preventDefault(); setRoute('sessions'); return; }
    if (mod && e.key === '2') { e.preventDefault(); setView('active'); return; }
    if (mod && e.key === '3') { e.preventDefault(); setView('archived'); return; }
    if (mod && e.key === '4') { e.preventDefault(); setView('broken'); return; }

    // -- Undo: Cmd+Z --
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (state.lastArchiveSnapshot) { e.preventDefault(); doUndo(); }
      return;
    }

    // -- When inside an input, only Escape is handled (to blur) --
    if (inInput) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }

    // -- Search focus: / --
    if (e.key === '/') {
      e.preventDefault();
      const searchInput = document.getElementById('search');
      if (searchInput) { searchInput.focus(); searchInput.select(); }
      return;
    }

    // -- Detail mode shortcuts --
    if (state.mode === 'detail') {
      if (e.key === 'Escape') { e.preventDefault(); exitDetail(); return; }
      if (state.route === 'memory' && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        const m = state.memories.find(x => x.id === state.detailId);
        if (m && m.archived) restore([m.id]);
        else if (m) archive([m.id]);
        return;
      }
      return;
    }

    // -- List mode shortcuts --

    // Navigation: j/k/arrows
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.route === 'memory') moveCursor(1, e.shiftKey);
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.route === 'memory') moveCursor(-1, e.shiftKey);
      return;
    }

    // Open detail: Enter
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.route === 'memory' && state.cursorId) enterDetail(state.cursorId);
      return;
    }

    // Archive / Restore: d/D
    if (state.route === 'memory' && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      const ids = state.selection.size > 0
        ? Array.from(state.selection)
        : state.cursorId ? [state.cursorId] : [];
      if (!ids.length) return;
      const m = state.memories.find(x => x.id === ids[0]);
      if (state.view === 'archived' || (m && m.archived)) restore(ids);
      else archive(ids);
      return;
    }

    // Undo: u
    if (e.key === 'u') {
      e.preventDefault();
      if (state.lastArchiveSnapshot) doUndo();
      return;
    }

    // Sort toggle: s
    if (e.key === 's') { e.preventDefault(); toggleSort(); return; }

    // Escape: clear selection or search
    if (e.key === 'Escape') {
      if (state.selection.size) {
        state.selection.clear();
        renderMemoryList();
        renderStatus();
      } else if (state.query) {
        state.query = '';
        const searchInput = document.getElementById('search');
        if (searchInput) searchInput.value = '';
        if (state.route === 'sessions') renderSessionList();
        else renderMemoryList();
      }
      return;
    }
  });
}
