// Utility functions extracted from render.js
// Pure helpers with no side-effects on global state (except formatProjectLabel which reads state).

import { state } from './state.js';

// --- Time / formatting ---

export function pad2(n) { return String(n).padStart(2, '0'); }

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function fmtListTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (isSameDay(d, now)) return hhmm;
  const mmdd = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) return `${mmdd} ${hhmm}`;
  return `${d.getFullYear()}/${mmdd} ${hhmm}`;
}

export function fmtRelative(ts) {
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

export function fmtClockTime(iso) {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  return (bytes / 1024 / 1024).toFixed(1) + 'M';
}

// --- HTML / Markdown ---

export function escapeHTML(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function highlightPlain(text, query) {
  if (!query) return escapeHTML(text);
  const safe = escapeHTML(text);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(q, 'gi'), m => `<mark>${m}</mark>`);
}

export function sanitizeMarkdown(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '');
}

export function highlightTextNodes(rootEl, query) {
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

export function renderMarkdown(text, opts = {}) {
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

// --- Duration / tokens / tooltip ---

export function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec || !parts.length) parts.push(`${sec}s`);
  return parts.join(' ');
}

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function fmtTooltipDate(isoDay) {
  const d = new Date(isoDay + 'T00:00:00');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const day = d.getDate();
  const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
  const thisYear = new Date().getFullYear();
  if (d.getFullYear() === thisYear) return `${months[d.getMonth()]} ${day}${suffix}`;
  return `${months[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
}

export function positionTooltip(el, x, y) {
  const pad = 12;
  const rect = el.getBoundingClientRect();
  let left = x + pad;
  if (left + rect.width > window.innerWidth - pad) left = x - rect.width - pad;
  el.style.left = left + 'px';
  el.style.top = (y - 28) + 'px';
}

// --- DOM helpers ---

export const $ = sel => document.querySelector(sel);
export const $$ = sel => Array.from(document.querySelectorAll(sel));

export function ensureVisible(el, wrapSel) {
  const wrap = $(wrapSel);
  if (!wrap || !el) return;
  const elRect = el.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  if (elRect.top < wrapRect.top + 30) wrap.scrollTop -= (wrapRect.top + 30 - elRect.top);
  else if (elRect.bottom > wrapRect.bottom - 10) wrap.scrollTop += (elRect.bottom - wrapRect.bottom + 10);
}

// --- Project label ---

export function formatProjectLabel(slug) {
  if (!slug) return '(no project)';
  // Use project_path if available from sessions, otherwise show slug as-is
  const session = state.sessions.find(s => s.project === slug && s.project_path);
  if (session?.project_path) {
    const parts = session.project_path.split('/');
    return parts.slice(-2).join('/');
  }
  return slug.replace(/^-/, '');
}

// --- Row status ---

export function dominantRowStatus(m) {
  if (m.health === 'broken') return 'broken';
  if (m.health === 'partial') return 'partial';
  if (m.archived) return 'archived';
  return null;
}

export function statusGlyphHTML(status) {
  if (!status) return '';
  const glyphs = {
    broken: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1.5l5.5 9.5h-11z M7 5v3M7 9.2v.6"/></svg>`,
    partial: `<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="3.5"/></svg>`,
    archived: `<svg viewBox="0 0 14 14" fill="currentColor"><circle cx="7" cy="7" r="2.5"/></svg>`
  };
  return `<span class="row-status ${status}" title="${status}">${glyphs[status] || ''}</span>`;
}
