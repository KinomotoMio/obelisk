// Memory list and detail rendering, extracted from render.js.

import { state, FOLDER_SVG } from './state.js';
import { loadMemoryMarkdown, isTextTruncated, loadFullText } from './data.js';
import registry from './registry.js';

// --- Utilities (local copies to avoid importing render.js) ---

function escapeHTML(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function pad2(n) { return String(n).padStart(2, '0'); }
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtListTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (isSameDay(d, now)) return hhmm;
  const mmdd = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) return `${mmdd} ${hhmm}`;
  return `${d.getFullYear()}/${mmdd} ${hhmm}`;
}
function fmtRelative(ts) {
  const diff = Date.now() - ts;
  const min = 60000, hr = 3600000, day = 86400000;
  if (diff < 0) return 'in the future';
  if (diff < min) return 'just now';
  if (diff < hr) return Math.floor(diff / min) + 'm ago';
  if (diff < day) return Math.floor(diff / hr) + 'h ago';
  if (diff < day * 30) return Math.floor(diff / day) + 'd ago';
  if (diff < day * 365) return Math.floor(diff / (day * 30)) + 'mo ago';
  return Math.floor(diff / (day * 365)) + 'y ago';
}

function highlightPlain(text, query) {
  if (!query) return escapeHTML(text);
  const safe = escapeHTML(text);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(q, 'gi'), m => `<mark>${m}</mark>`);
}

function sanitizeMarkdown(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '');
}

function highlightTextNodes(rootEl, query) {
  if (!query) return;
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!text) continue;
    const lower = text.toLowerCase();
    if (!lower.includes(q)) continue;
    const frag = document.createDocumentFragment();
    let last = 0, i = lower.indexOf(q);
    while (i !== -1) {
      if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(i, i + q.length);
      frag.appendChild(mark);
      last = i + q.length;
      i = lower.indexOf(q, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function renderMarkdown(text, opts = {}) {
  if (text == null) return '';
  const html = sanitizeMarkdown(marked.parse(text));
  const cls = opts.variant === 'msg' ? 'markdown-msg'
            : opts.variant === 'compact' ? 'markdown-compact'
            : 'markdown-body';
  const container = document.createElement('div');
  container.className = cls;
  container.innerHTML = html;
  if (opts.query) highlightTextNodes(container, opts.query.trim());
  return container.outerHTML;
}

// --- DOM helpers ---

const $ = sel => document.querySelector(sel);

function ensureVisible(el, wrapSel) {
  const wrap = $(wrapSel);
  if (!wrap || !el) return;
  const elRect = el.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  if (elRect.top < wrapRect.top + 30) wrap.scrollTop -= (wrapRect.top + 30 - elRect.top);
  else if (elRect.bottom > wrapRect.bottom - 10) wrap.scrollTop += (elRect.bottom - wrapRect.bottom + 10);
}

// --- Data filtering (mirrors render.js) ---

function dominantRowStatus(m) {
  if (m.health === 'broken') return 'broken';
  if (m.health === 'partial') return 'partial';
  if (m.archived) return 'archived';
  return null;
}

function statusGlyphHTML(status) {
  if (!status) return '';
  const glyphs = {
    broken: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1.5l5.5 9.5h-11z M7 5v3M7 9.2v.6"/></svg>`,
    partial: `<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="3.5"/></svg>`,
    archived: `<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="2.5"/></svg>`
  };
  return `<span class="row-status ${status}" title="${status}">${glyphs[status] || ''}</span>`;
}

function formatProjectLabel(slug) {
  if (!slug) return '(no project)';
  const session = state.sessions.find(s => s.project === slug && s.project_path);
  if (session?.project_path) {
    const parts = session.project_path.split('/');
    return parts.slice(-2).join('/');
  }
  return slug.replace(/^-/, '');
}

export function visibleMemories() {
  const q = state.query.trim().toLowerCase();
  return state.memories
    .filter(m => {
      if (state.view === 'archived') return m.archived;
      return !m.archived;
    })
    .filter(m => state.projectFilter === 'all' || m.project === state.projectFilter)
    .filter(m => !q || (m.path || '').toLowerCase().includes(q) || (m.summary || '').toLowerCase().includes(q))
    .sort((a, b) => state.sortDesc ? b.ts - a.ts : a.ts - b.ts);
}

// --- Memory list ---

export function renderMemoryList() {
  const items = visibleMemories();
  const list = $('#list');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<div class="empty">No memories${state.view === 'archived' ? ' archived' : ''} here.<span class="hint">${state.query ? 'Try a different search term.' : 'Press / to search.'}</span></div>`;
    return;
  }
  list.innerHTML = items.map(m => renderMemoryRow(m)).join('');
  if (state.cursorId) {
    const cursorEl = list.querySelector(`.row[data-id="${state.cursorId}"]`);
    if (cursorEl) ensureVisible(cursorEl, '#list-wrap');
  }
}

function renderMemoryRow(m) {
  const isCursor = state.cursorId === m.id;
  const isSelected = state.selection.has(m.id);
  const q = state.query.trim();
  const showProjectPrefix = state.projectFilter === 'all';
  const status = dominantRowStatus(m);
  const actionLabel = m.archived
    ? `<button class="row-action restore" data-action="restore">Restore<span class="kbd">D</span></button>`
    : `<button class="row-action danger" data-action="archive">Archive<span class="kbd">D</span></button>`;
  return `
    <div class="row ${isCursor ? 'cursor' : ''} ${isSelected ? 'selected' : ''} ${m.archived ? 'archived' : ''}" data-id="${m.id}">
      <button class="row-checkbox ${isSelected ? 'checked' : ''}" data-action="check" aria-label="Select">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M2.5 6.5l2.5 2.5 4.5-5"/></svg>
      </button>
      <div class="row-body">
        <div class="row-path">
          ${statusGlyphHTML(status)}
          ${showProjectPrefix ? `<span class="project-prefix">${escapeHTML(formatProjectLabel(m.project))}</span><span class="project-prefix-sep">/</span>` : ''}
          <span class="path-text">${highlightPlain(m.path || '', q)}</span>
        </div>
        <div class="row-summary">${highlightPlain(m.summary || '', q)}</div>
      </div>
      <div class="row-right">
        <div class="row-meta"><span>${fmtListTime(m.ts)}</span></div>
        <div class="row-actions">${actionLabel}</div>
      </div>
    </div>
  `;
}

// --- Memory detail ---

export async function renderMemoryDetail() {
  const m = state.memories.find(x => x.id === state.detailId);
  if (!m) return;
  const detail = $('#detail');
  if (!detail) return;

  // Load markdown on demand
  if (m.markdown === null && m.path) {
    m.markdown = await loadMemoryMarkdown(m.path);
  }

  const provenanceHTML = `
    <div class="detail-meta">
      ${m.session_id ? `<button class="session-link" data-action="open-session" data-session="${m.session_id}">
        ${FOLDER_SVG}<span>Source session</span>
      </button><span class="dot"></span>` : ''}
      <span>${fmtRelative(m.ts)}</span>
    </div>
  `;

  let markdownHTML;
  if (m.markdown == null) {
    markdownHTML = `<div style="color:var(--muted-2);font-style:italic;padding:20px;text-align:center;border:1px dashed var(--hairline);border-radius:6px;">File not found or empty.</div>`;
  } else if (state.showSource) {
    markdownHTML = `<pre class="markdown-source">${escapeHTML(m.markdown)}</pre>`;
  } else {
    markdownHTML = renderMarkdown(m.markdown, { variant: 'body' });
  }

  detail.innerHTML = `
    <div class="detail-header">
      <div class="detail-eyebrow">
        <span class="project-icon">${FOLDER_SVG}</span>
        <span class="project-name">${escapeHTML(formatProjectLabel(m.project))}</span>
        ${m.archived ? '<span class="archived-tag">archived</span>' : ''}
      </div>
      <div class="detail-path">${escapeHTML(m.path)}</div>
      <div class="detail-summary">${escapeHTML(m.summary)}</div>
      ${provenanceHTML}
    </div>
    <div class="markdown-section">
      <div class="markdown-toolbar">
        <span class="markdown-toolbar-label">Body</span>
        <button class="source-toggle ${state.showSource ? 'active' : ''}" data-action="toggle-source" ${m.markdown == null ? 'disabled' : ''}>
          ${state.showSource ? 'Show rendered' : 'Show source'}
        </button>
      </div>
      ${markdownHTML}
    </div>
    <div class="detail-actions">
      <button class="btn" id="detail-back">Back<span class="kbd">Esc</span></button>
      <button class="btn ${m.archived ? 'primary' : 'danger'}" id="detail-archive">
        ${m.archived ? 'Restore' : 'Archive'}<span class="kbd">D</span>
      </button>
    </div>
  `;

  // Wire event listeners via registry (avoids circular imports)
  $('#detail-back')?.addEventListener('click', () => {
    if (registry.exitDetail) registry.exitDetail();
  });
  $('#detail-archive')?.addEventListener('click', () => {
    if (m.archived) { if (registry.restore) registry.restore([m.id]); }
    else { if (registry.archive) registry.archive([m.id]); }
  });
  detail.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (el.dataset.action === 'toggle-source') {
        state.showSource = !state.showSource;
        renderMemoryDetail();
      } else if (el.dataset.action === 'open-session' && el.dataset.session) {
        if (registry.navigateToSession) registry.navigateToSession(el.dataset.session, null);
      }
    });
  });
}
