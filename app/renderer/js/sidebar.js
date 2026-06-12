// Sidebar, breadcrumb, and window title rendering.
// Extracted from render.js for modularity.

import { state, FOLDER_SVG } from './state.js';
import { $, $$, escapeHTML, formatProjectLabel } from './utils.js';

// --- Data helpers (sidebar-local) ---

function projectCountsForCurrentRoute() {
  const counts = {};
  if (state.route === 'sessions') {
    for (const s of state.sessions) if (s.project) counts[s.project] = (counts[s.project] || 0) + 1;
  } else {
    for (const m of state.memories) {
      const matches = state.view === 'archived' ? m.archived : !m.archived;
      if (!matches) continue;
      if (m.project) counts[m.project] = (counts[m.project] || 0) + 1;
    }
  }
  return counts;
}

// --- Sidebar ---

export function renderSidebar() {
  const activeCount = state.memories.filter(m => !m.archived).length;
  const archivedCount = state.memories.filter(m => m.archived).length;
  const el = id => $(id);
  if (el('#count-sessions')) el('#count-sessions').textContent = state.sessions.length;
  if (el('#count-memory-total')) el('#count-memory-total').textContent = activeCount + archivedCount;
  if (el('#count-active')) el('#count-active').textContent = activeCount;
  if (el('#count-archived')) el('#count-archived').textContent = archivedCount;

  $$('.sidebar-item').forEach(item => {
    let isActive = false;
    if (item.dataset.route === 'sessions' && state.route === 'sessions' && state.projectFilter === 'all') isActive = true;
    else if (item.dataset.route === 'usage' && state.route === 'usage') isActive = true;
    else if (item.dataset.route === 'memory' && item.dataset.view === state.view && state.projectFilter === 'all') isActive = true;
    else if (item.dataset.project && item.dataset.project === state.projectFilter) isActive = true;
    if (item.dataset.route === 'memory' && !item.classList.contains('sub')) isActive = false;
    item.classList.toggle('active', isActive);
  });

  const counts = projectCountsForCurrentRoute();
  let projects = [...new Set(
    (state.route === 'sessions' ? state.sessions : state.memories)
      .filter(item => {
        if (state.route === 'sessions') return true;
        return state.view === 'archived' ? item.archived : !item.archived;
      })
      .map(item => item.project)
      .filter(Boolean)
  )];
  if (state.projectSearch) {
    const q = state.projectSearch.toLowerCase();
    projects = projects.filter(p => p.toLowerCase().includes(q));
  }
  projects.sort((a, b) => formatProjectLabel(a).localeCompare(formatProjectLabel(b)));
  const projectsEl = $('#sidebar-projects');
  if (projectsEl) {
    projectsEl.innerHTML = projects.map(p => `
      <button class="sidebar-item ${state.projectFilter === p ? 'active' : ''}" data-project="${p}">
        <span class="icon">${FOLDER_SVG}</span>
        <span class="label">${escapeHTML(formatProjectLabel(p))}</span>
        <span class="badge">${counts[p] || 0}</span>
      </button>
    `).join('') || `<div style="padding:8px 10px;font-size:11px;color:var(--muted-2);">No projects</div>`;
  }
}

// --- Breadcrumb ---

export function renderBreadcrumb() {
  const bc = $('#breadcrumb');
  if (!bc) return;
  if (state.route === 'sessions') {
    if (state.mode === 'detail') {
      const s = state.sessions.find(x => x.id === state.detailId);
      if (!s) return;
      if (state.subagentId) {
        bc.innerHTML = `<button class="crumb" data-action="goto-sessions">Sessions</button><span class="crumb-sep">/</span><button class="crumb" data-action="goto-session-detail">${escapeHTML((s.title || s.id).slice(0, 30))}</button><span class="crumb-sep">/</span><span class="crumb terminal">${escapeHTML((state.subagentDescription || '').slice(0, 40))}</span>`;
      } else {
        bc.innerHTML = `<button class="crumb" data-action="goto-sessions">Sessions</button><span class="crumb-sep">/</span><span class="crumb terminal">${escapeHTML(s.title || s.id)}</span>`;
      }
    } else {
      let html = `<button class="crumb ${state.projectFilter === 'all' ? 'terminal' : ''}" data-action="goto-sessions">Sessions</button>`;
      if (state.projectFilter !== 'all') html += `<span class="crumb-sep">/</span><span class="crumb terminal">${escapeHTML(formatProjectLabel(state.projectFilter))}</span>`;
      bc.innerHTML = html;
    }
  } else if (state.route === 'usage') {
    bc.innerHTML = `<span class="crumb terminal">Usage</span>`;
  } else {
    if (state.mode === 'detail') {
      const m = state.memories.find(x => x.id === state.detailId);
      if (!m) return;
      bc.innerHTML = `<button class="crumb" data-action="goto-memory">Memory</button><span class="crumb-sep">/</span><span class="crumb terminal filename">${escapeHTML(m.path.split('/').pop())}</span>`;
    } else {
      let html = `<button class="crumb ${state.projectFilter === 'all' ? 'terminal' : ''}" data-action="goto-memory">Memory</button>`;
      if (state.projectFilter !== 'all') html += `<span class="crumb-sep">/</span><span class="crumb terminal">${escapeHTML(formatProjectLabel(state.projectFilter))}</span>`;
      bc.innerHTML = html;
    }
  }
}

// --- Window title ---

export function updateWindowTitle() {
  const appName = 'Obelisk';
  let scopeText = '';
  if (state.route === 'usage') {
    scopeText = 'Usage';
  } else if (state.route === 'sessions') {
    if (state.mode === 'detail') {
      const s = state.sessions.find(x => x.id === state.detailId);
      scopeText = s ? `Sessions · ${s.title}` : 'Sessions';
    } else {
      const proj = state.projectFilter !== 'all' ? ` · ${formatProjectLabel(state.projectFilter)}` : '';
      scopeText = `Sessions${proj}`;
    }
  } else {
    if (state.mode === 'detail') {
      const m = state.memories.find(x => x.id === state.detailId);
      scopeText = m ? `Memory · ${m.path.split('/').pop()}` : 'Memory';
    } else {
      const viewLabel = state.view === 'archived' ? 'Archived' : 'Active';
      const proj = state.projectFilter !== 'all' ? ` · ${formatProjectLabel(state.projectFilter)}` : '';
      scopeText = `Memory · ${viewLabel}${proj}`;
    }
  }
  const titleEl = $('#titlebar-text');
  if (titleEl) {
    const truncated = scopeText.length > 50 ? scopeText.slice(0, 50) + '…' : scopeText;
    titleEl.innerHTML = `<span class="app-name">${appName}</span><span class="sep">—</span><span class="scope">${escapeHTML(truncated)}</span>`;
    titleEl.title = `${appName} — ${scopeText}`;
  }
  document.title = `${appName} — ${scopeText}`;
}
