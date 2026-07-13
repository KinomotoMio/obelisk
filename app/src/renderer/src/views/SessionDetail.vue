<script setup>
import { ref, shallowRef, computed, onMounted, onUnmounted, nextTick, onActivated, onDeactivated, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { state, FOLDER_SVG } from '../store.js';
import { loadSessionDetail, isTextTruncated, loadFullText } from '../data.js';
import { clearSessionDirty, consumeGlobalSessionDirty } from '../session-live.mjs';
import { applySnapshot } from '../session-timeline.mjs';
import { getArgPreview, getToolIcon, renderTerminalTool } from '../tool-renderer.js';
import FlapNumber from '../components/FlapNumber.vue';
import {
  captureSessionViewState,
  createSessionDisclosureRegistry,
  createSessionDomIndex,
  findLastMessageAtOrAbove,
  isFollowingSessionTail,
  restoreSessionTail,
  restoreSessionViewState,
} from '../session-view-state.mjs';
import {
  escapeHTML,
  fmtRelative,
  fmtClockTime,
  renderMarkdown,
  formatProjectLabel
} from '../utils.js';

defineOptions({ name: 'SessionDetail' });
const props = defineProps({ id: String });

const router = useRouter();
const route = useRoute();

// --- Reactive state ---
const session = computed(() => state.sessions.find(s => s.id === props.id));
const messages = shallowRef([]);
const loading = ref(false);
const progressPct = ref(0);
const active = ref(false);
let removeSessionUpdated = null;
let keydownAttached = false;
let scrollRevision = 0;

// DOM refs
const wrapRef = ref(null);
const detailRef = ref(null);
let sessionDomIndex = createSessionDomIndex(null);
let disclosureRegistry = createSessionDisclosureRegistry();

// --- Load session on mount or when id changes ---
const FONT_SIZE_KEY = 'obelisk:session-font-size';
const FONT_SIZES = [12, 13, 14, 15, 16, 18];
const fontSizeIdx = ref(FONT_SIZES.indexOf(parseInt(localStorage.getItem(FONT_SIZE_KEY)) || 14));
if (fontSizeIdx.value < 0) fontSizeIdx.value = 2;
const fontSize = computed(() => FONT_SIZES[fontSizeIdx.value] + 'px');

function adjustFont(delta) {
  const next = fontSizeIdx.value + delta;
  if (next >= 0 && next < FONT_SIZES.length) {
    fontSizeIdx.value = next;
    localStorage.setItem(FONT_SIZE_KEY, FONT_SIZES[next]);
  }
}

function handleZoom(e) {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === '=' || e.key === '+') {
    e.preventDefault();
    if (fontSizeIdx.value < FONT_SIZES.length - 1) fontSizeIdx.value++;
    localStorage.setItem(FONT_SIZE_KEY, FONT_SIZES[fontSizeIdx.value]);
  } else if (e.key === '-') {
    e.preventDefault();
    if (fontSizeIdx.value > 0) fontSizeIdx.value--;
    localStorage.setItem(FONT_SIZE_KEY, FONT_SIZES[fontSizeIdx.value]);
  } else if (e.key === '0') {
    e.preventDefault();
    fontSizeIdx.value = 2;
    localStorage.setItem(FONT_SIZE_KEY, FONT_SIZES[fontSizeIdx.value]);
  }
}

function attachKeydown() {
  if (keydownAttached) return;
  window.addEventListener('keydown', handleZoom);
  keydownAttached = true;
}

function detachKeydown() {
  if (!keydownAttached) return;
  window.removeEventListener('keydown', handleZoom);
  keydownAttached = false;
}

const HINT_KEY = 'obelisk:font-hint-shown';
const showFontHint = ref(false);

onMounted(async () => {
  active.value = true;
  attachKeydown();
  if (route.query.focus) {
    state.pendingFocusUuid = route.query.focus;
  }
  removeSessionUpdated = window.obelisk?.onSessionUpdated?.(async ({ sessionId } = {}) => {
    if (!active.value || !props.id || sessionId !== props.id) return;
    clearSessionDirty(props.id);
    await loadMessages({ force: true });
  }) || null;
  if (!localStorage.getItem(HINT_KEY)) {
    showFontHint.value = true;
    localStorage.setItem(HINT_KEY, '1');
    setTimeout(() => { showFontHint.value = false; }, 4000);
  }
  await loadMessages({ force: consumeGlobalSessionDirty(props.id) });
});

onActivated(async () => {
  active.value = true;
  attachKeydown();
  if (route.query.focus) {
    state.pendingFocusUuid = route.query.focus;
  }
  if (props.id && (messages.value.length === 0 || consumeGlobalSessionDirty(props.id))) {
    await loadMessages({ force: true });
  } else if (state.pendingFocusUuid) {
    await focusPendingMessage();
  }
});

onDeactivated(() => {
  active.value = false;
  detachKeydown();
});

onUnmounted(() => {
  active.value = false;
  detachKeydown();
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
  scrollFrame = null;
  removeSessionUpdated?.();
  removeSessionUpdated = null;
});

watch(() => props.id, async (newId, oldId) => {
  if (newId && newId !== oldId) {
    messages.value = [];
    disclosureRegistry = createSessionDisclosureRegistry();
    progressPct.value = 0;
    currentMsgIdx.value = 0;
    await loadMessages({ force: consumeGlobalSessionDirty(newId) });
  }
});

async function loadMessages({ force = false } = {}) {
  if (!props.id) return;
  const hadContent = messages.value.length > 0;
  let reconciliation;
  let viewState = null;
  let followTailBeforePatch = false;
  let scrollRevisionBeforePatch = scrollRevision;

  loading.value = !hadContent;
  try {
    const s = state.sessions.find(x => x.id === props.id);
    let latest = s;
    if (s && (force || !s.messages || s.messages.length === 0)) {
      latest = await loadSessionDetail(props.id);
    }
    const incoming = latest?.messages || [];
    reconciliation = applySnapshot(messages.value, incoming);
    if (reconciliation.changed) {
      followTailBeforePatch = hadContent && isFollowingSessionTail(wrapRef.value);
      scrollRevisionBeforePatch = scrollRevision;
      if (hadContent && !reconciliation.tailOnly) {
        viewState = captureSessionViewState({
          wrap: wrapRef.value,
          domIndex: sessionDomIndex,
        });
      }
      messages.value = reconciliation.messages;
    }
  } finally {
    loading.value = false;
  }

  if (!reconciliation.changed) {
    if (state.pendingFocusUuid) await focusPendingMessage();
    return;
  }

  await nextTick();
  syncTimelineDom();
  disclosureRegistry.reconcile(sessionDomIndex, reconciliation);
  if (!state.pendingFocusUuid) {
    if (reconciliation.tailOnly) {
      restoreSessionTail({
        wrap: wrapRef.value,
        followTail: followTailBeforePatch,
        restoreScroll: scrollRevision === scrollRevisionBeforePatch,
      });
    } else {
      restoreSessionViewState(viewState, {
        wrap: wrapRef.value,
        domIndex: sessionDomIndex,
        restoreScroll: scrollRevision === scrollRevisionBeforePatch,
      });
    }
    onScroll();
  }

  // Focus pending uuid if any
  if (state.pendingFocusUuid) {
    await focusPendingMessage();
  }
}

async function focusPendingMessage() {
  const targetUuid = state.pendingFocusUuid;
  if (!targetUuid) return;
  state.pendingFocusUuid = null;
  await nextTick();
  const target = detailRef.value?.querySelector(`.msg[data-uuid="${targetUuid}"], .skill-card[data-uuid="${targetUuid}"], .wf-card[data-uuid="${targetUuid}"]`);
  if (target && wrapRef.value) {
    const navHeight = 52;
    const msgBottom = target.offsetTop + target.offsetHeight;
    const scrollTarget = msgBottom - wrapRef.value.clientHeight + navHeight;
    wrapRef.value.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'instant' });
    target.classList.add('is-focused');
    setTimeout(() => target.classList.remove('is-focused'), 2000);
    // Update nav position
    await nextTick();
    onScroll();
  }
}

// --- Scroll / progress tracking ---
const currentMsgIdx = ref(0);
const totalMsgs = ref(0);
let navLock = false;
let scrollFrame = null;

function syncTimelineDom() {
  sessionDomIndex = createSessionDomIndex(detailRef.value);
  totalMsgs.value = sessionDomIndex.items.length;
}

function onScroll(event) {
  if (event) scrollRevision++;
  if (navLock) return;
  if (scrollFrame !== null) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    updateScrollProgress();
  });
}

function setMessagePosition(index, total) {
  currentMsgIdx.value = index;
  progressPct.value = total <= 1 ? 100 : Math.round((index / (total - 1)) * 100);
}

function updateScrollProgress() {
  if (!wrapRef.value) return;
  const msgs = sessionDomIndex.items;
  if (!msgs.length) {
    currentMsgIdx.value = 0;
    progressPct.value = 0;
    return;
  }

  const el = wrapRef.value;
  const navHeight = 52;
  const bottomLine = el.getBoundingClientRect().bottom - navHeight;
  const bottomMsgIdx = findLastMessageAtOrAbove(msgs, bottomLine);
  setMessagePosition(bottomMsgIdx, msgs.length);
}

function navTo(target) {
  if (!wrapRef.value) return;
  const msgs = sessionDomIndex.items;
  if (!msgs.length) return;
  let idx;
  if (target === 'first') idx = 0;
  else if (target === 'last') idx = msgs.length - 1;
  else if (target === 'prev') idx = Math.max(0, currentMsgIdx.value - 1);
  else if (target === 'next') idx = Math.min(msgs.length - 1, currentMsgIdx.value + 1);
  else return;
  setMessagePosition(idx, msgs.length);
  navLock = true;
  const navHeight = 52;
  const el = wrapRef.value;
  const msgEl = msgs[idx];
  if (!msgEl) return;
  const msgBottom = msgEl.offsetTop + msgEl.offsetHeight;
  const scrollTarget = msgBottom - el.clientHeight + navHeight;
  el.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'instant' });
  setTimeout(() => { navLock = false; }, 50);
}

// --- Toggle helpers ---
function toggleDisclosure(event, selector, className = 'open') {
  const element = event.currentTarget?.closest(selector);
  if (!element) return;
  element.classList.toggle(className);
  disclosureRegistry.remember(element);
}

// --- Full text loading ---
async function handleLoadFullText(event, uuid) {
  const btn = event.currentTarget;
  btn.textContent = 'Loading...';
  const fullText = await loadFullText(uuid);
  if (fullText) {
    const msgEl = btn.closest('.msg');
    const bodyEl = msgEl.querySelector('.markdown-msg') || msgEl.querySelector('.markdown-compact');
    const variant = bodyEl?.classList.contains('markdown-compact') ? 'compact' : 'msg';
    const rendered = renderMarkdown(fullText, { variant, query: state.query });
    if (bodyEl) bodyEl.outerHTML = rendered;
    btn.remove();
  } else {
    btn.textContent = 'Failed to load full text';
  }
}

// --- Subagent navigation ---
function navigateToSubagent(agentId, description) {
  router.push({
    name: 'SubagentDetail',
    params: { id: props.id, agentId }
  });
}

// --- Render helpers (produce raw HTML strings like the vanilla version) ---

function formatToolInput(tc) {
  try {
    const j = JSON.parse(tc.input_json || '{}');
    return JSON.stringify(j, null, 2);
  } catch {
    return tc.input_json || '';
  }
}

function escapeH(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderPrettyTool(tc) {
  let args;
  try { args = JSON.parse(tc.input_json || '{}'); } catch { args = {}; }
  const result = tc.result || {};
  const isError = !!result.is_error;
  const out = result.content || '';

  if (tc.name === 'Read') {
    const path = args.file_path || args.path || '?';
    if (!out) return '<div style="color:var(--muted);font-size:11px;font-style:italic;">No content returned.</div>';
    return renderFileContent(out);
  }

  if (tc.name === 'Write') {
    const path = args.file_path || args.path || '?';
    const header = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span class="tool-action-label">Writing</span>
      <span class="file-ref">${escapeH(path)}</span>
    </div>`;
    let content = '';
    if (args.content) {
      const lines = args.content.split('\n');
      const gutter = lines.map((_, i) => i + 1).join('\n');
      content = `<div class="file-content">
        <div class="file-content-head"><span class="label">New file</span><span class="meta">${lines.length} lines</span></div>
        <div class="file-content-body collapsed"><div class="gutter">${gutter}</div><div class="code">${escapeH(args.content)}</div></div>
      </div>`;
    }
    const chip = `<div class="result-chip ${isError ? 'error' : ''}">${escapeH(out)}</div>`;
    return header + content + chip;
  }

  if (tc.name === 'Edit') {
    let diff = '';
    if (args.old_string && args.new_string) diff = renderDiff(args.old_string, args.new_string);
    const chip = `<div class="result-chip ${isError ? 'error' : ''}">${escapeH(out)}</div>`;
    return diff + chip;
  }

  const terminal = renderTerminalTool(tc.name, args, out, isError);
  if (terminal !== null) return terminal;

  return `<div class="body-section"><div class="body-label">Input</div>${renderFieldGrid(args)}</div>` +
    (out ? `<div class="body-section" style="margin-top:12px;"><div class="body-label">Output</div>${renderOutput(out, isError)}</div>` : '');
}

function renderFileContent(text) {
  let lines = text.split('\n');
  // Detect if content already has line numbers (e.g. "  1\tcode" from cat -n / Read tool)
  const hasLineNums = lines.length > 1 && lines.slice(0, 5).every(l => /^\s*\d+\t/.test(l) || l === '');
  let gutter;
  if (hasLineNums) {
    const parsed = lines.map(l => {
      const m = l.match(/^\s*(\d+)\t(.*)$/);
      return m ? { num: m[1], code: m[2] } : { num: '', code: l };
    });
    gutter = parsed.map(p => p.num).join('\n');
    lines = parsed.map(p => p.code);
  } else {
    gutter = lines.map((_, i) => i + 1).join('\n');
  }
  const total = lines.length;
  const collapsed = total > 12;
  return `<div class="file-content">
    <div class="file-content-head"><span class="label">File contents</span><span class="meta">${total} lines</span></div>
    <div class="file-content-body ${collapsed ? 'collapsed' : ''}"><div class="gutter">${gutter}</div><div class="code">${escapeH(lines.join('\n'))}</div></div>
    ${collapsed ? `<button class="file-content-expand" onclick="this.previousElementSibling.classList.toggle('collapsed');this.textContent=this.previousElementSibling.classList.contains('collapsed')?'Show all ${total} lines':'Collapse'">Show all ${total} lines</button>` : ''}
  </div>`;
}

function renderDiff(oldStr, newStr) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;

  const result = [];
  for (let i = 0; i < prefix; i++) result.push({ kind: 'context', text: oldLines[i], oldNo: i + 1, newNo: i + 1 });
  for (let i = prefix; i < oldLines.length - suffix; i++) result.push({ kind: 'del', text: oldLines[i], oldNo: i + 1, newNo: null });
  for (let i = prefix; i < newLines.length - suffix; i++) result.push({ kind: 'add', text: newLines[i], oldNo: null, newNo: i + 1 });
  for (let i = 0; i < suffix; i++) {
    result.push({ kind: 'context', text: oldLines[oldLines.length - suffix + i], oldNo: oldLines.length - suffix + i + 1, newNo: newLines.length - suffix + i + 1 });
  }

  const adds = result.filter(d => d.kind === 'add').length;
  const dels = result.filter(d => d.kind === 'del').length;

  const rows = result.map(line => {
    const oldN = line.oldNo == null ? ' ' : String(line.oldNo);
    const newN = line.newNo == null ? ' ' : String(line.newNo);
    return `<div class="diff-gutter ${line.kind}">${oldN.padStart(3)} ${newN.padStart(3)}</div><div class="diff-line ${line.kind}">  ${escapeH(line.text)}</div>`;
  }).join('');

  return `<div class="diff-view">
    <div class="diff-view-head"><span class="label">Diff</span><div class="stats"><span class="stat-add">+${adds}</span><span class="stat-del">−${dels}</span></div></div>
    <div class="diff-body">${rows}</div>
  </div>`;
}

function renderFieldGrid(obj) {
  const entries = Object.entries(obj);
  if (!entries.length) return '';
  const rows = entries.map(([k, v]) => {
    return `<div class="field-key">${escapeH(k)}</div><div class="field-val">${renderValue(v)}</div>`;
  }).join('');
  return `<div class="field-grid">${rows}</div>`;
}

function renderValue(v) {
  if (v === null || v === undefined) return '<span class="literal-null">null</span>';
  if (typeof v === 'boolean') return `<span class="literal-bool">${v}</span>`;
  if (typeof v === 'number') return `<span class="literal-num">${v}</span>`;
  if (typeof v === 'string') {
    if (/^https?:\/\//.test(v)) return `<span class="literal-string">${escapeH(v)}</span>`;
    if (v.length > 120) {
      return `<span class="lit-string-long" onclick="this.classList.toggle('open')">"${escapeH(v.slice(0, 120))}<span class="long-rest">${escapeH(v.slice(120))}</span>"<button class="more-btn">+${v.length - 120}</button></span>`;
    }
    return `<span class="literal-string">"${escapeH(v)}"</span>`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '<span class="literal-null">[]</span>';
    if (v.length <= 4 && v.every(x => typeof x !== 'object')) return `<span class="literal-string">[${v.map(x => renderValue(x)).join(', ')}]</span>`;
    return `<span class="literal-null">Array(${v.length})</span>`;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    return `<span class="literal-null">Object(${keys.length})</span>`;
  }
  return `<span>${escapeH(String(v))}</span>`;
}

function renderOutput(out, isError) {
  if (!out) return '<div style="padding:8px;color:var(--muted-2);font-style:italic;font-size:11px;">No output.</div>';

  let parsed = null;
  try { parsed = JSON.parse(out); } catch {}

  if (parsed !== null && typeof parsed === 'object') {
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      return renderAutoTable(parsed);
    }
    if (Array.isArray(parsed)) {
      return renderFieldGrid(Object.fromEntries(parsed.map((x, i) => [i, x])));
    }
    return renderObjectOutput(parsed);
  }

  if (out.includes('\n')) {
    const lines = out.split('\n');
    const total = lines.length;
    const collapsed = total > 10;
    const gutter = lines.map((_, i) => i + 1).join('\n');
    return `<div class="file-content">
      <div class="file-content-body ${collapsed ? 'collapsed' : ''}"><div class="gutter">${gutter}</div><div class="code">${escapeH(out)}</div></div>
      ${collapsed ? `<button class="file-content-expand" onclick="this.previousElementSibling.classList.toggle('collapsed');this.textContent=this.previousElementSibling.classList.contains('collapsed')?'Show all ${total} lines':'Collapse'">Show all ${total} lines</button>` : ''}
    </div>`;
  }

  return `<div class="result-chip ${isError ? 'error' : ''}">${escapeH(out)}</div>`;
}

function renderObjectOutput(obj) {
  const hero = extractHero(obj);
  let rest = obj;
  if (hero) {
    rest = { ...obj };
    if (hero.titleKey) delete rest[hero.titleKey];
    if (hero.urlKey) delete rest[hero.urlKey];
    if (hero.idKey) delete rest[hero.idKey];
  }
  let html = '';
  if (hero) {
    html += `<div style="margin-bottom:10px;padding:8px 12px;border-left:2px solid var(--accent-soft);background:rgba(167,139,250,0.04);border-radius:0 5px 5px 0;">`;
    if (hero.titleKey) html += `<div style="font-size:14px;font-weight:600;color:var(--fg);margin-bottom:2px;">${escapeH(obj[hero.titleKey])}</div>`;
    const sub = [];
    if (hero.idKey) sub.push(escapeH(obj[hero.idKey]));
    if (hero.urlKey) sub.push(escapeH(obj[hero.urlKey]));
    if (sub.length) html += `<div style="font-family:var(--font-mono);font-size:11px;color:var(--muted);">${sub.join(' · ')}</div>`;
    html += '</div>';
  }
  if (Object.keys(rest).length) html += renderFieldGrid(rest);
  return html;
}

function extractHero(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const titleKey = ['title', 'name', 'summary'].find(k => typeof obj[k] === 'string');
  const urlKey = ['url', 'permalink', 'href', 'link'].find(k => typeof obj[k] === 'string' && /^https?:/.test(obj[k]));
  const idKey = ['id', 'identifier', 'uuid', 'key'].find(k => typeof obj[k] === 'string');
  if (!titleKey && !urlKey && !idKey) return null;
  return { titleKey, urlKey, idKey };
}

function renderAutoTable(rows) {
  const sample = rows.slice(0, 5);
  const allKeys = new Set();
  for (const row of sample) Object.keys(row).forEach(k => allKeys.add(k));
  const cols = Array.from(allKeys);
  const head = cols.map(c => `<th>${escapeH(c)}</th>`).join('');
  const body = rows.slice(0, 50).map(row =>
    `<tr>${cols.map(c => {
      const v = row[c];
      if (v == null) return '<td><span class="literal-null">—</span></td>';
      if (typeof v === 'string' && v.length > 60) return `<td title="${escapeH(v)}">${escapeH(v.slice(0, 60))}…</td>`;
      if (typeof v === 'object') return `<td>${renderValue(v)}</td>`;
      return `<td>${escapeH(String(v))}</td>`;
    }).join('')}</tr>`
  ).join('');
  return `<div class="auto-table-wrap">
    <div class="auto-table-head"><span class="h-label">Result</span><span class="h-meta">${rows.length} items · ${cols.length} columns</span></div>
    <div class="auto-table-scroll"><table class="auto-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
  </div>`;
}

function toggleRaw(event) {
  const body = event.target.closest('.toolcall-body');
  if (!body) return;
  const pretty = body.querySelector('.toolcall-pretty');
  const raw = body.querySelector('.toolcall-raw');
  const btn = body.querySelector('.raw-toggle');
  if (!pretty || !raw) return;
  const showing = raw.classList.toggle('show');
  pretty.classList.toggle('hidden', showing);
  btn?.classList.toggle('active', showing);
  disclosureRegistry.remember(body.closest('[data-view-key]'));
}

function getSkillMd(msg) {
  return msg?._skillMd || null;
}

function getToolCallParsedInput(tc) {
  try {
    return JSON.parse(tc.input_json || '{}');
  } catch {
    return {};
  }
}
</script>

<template>
  <div class="detail-wrap" ref="wrapRef" @scroll="onScroll" :style="{ '--text-base': fontSize, '--text-md': fontSize }">
    <div class="detail" ref="detailRef">
      <!-- Progress bar -->
      <div class="session-progress">
        <div class="session-progress-fill" :style="{ width: progressPct + '%' }"></div>
      </div>

      <!-- Loading state -->
      <div v-if="loading" class="empty" style="padding: 60px 0; text-align: center; color: var(--muted);">
        Loading session...
      </div>

      <!-- Session header -->
      <template v-if="session && !loading">
        <div class="session-header">
          <div class="session-eyebrow">
            <span class="project-icon" v-html="FOLDER_SVG"></span>
            <span class="project-name">{{ formatProjectLabel(session.project) }}</span>
            <span class="sep">&middot;</span>
            <span class="project-path">{{ session.project_path || '' }}</span>
            <span class="via">
              <span class="via-dot" :class="session.source || 'claude'"></span>
              via {{ (session.source || 'claude') === 'codex' ? 'Codex' : 'Claude Code' }}
            </span>
          </div>
          <div class="session-title">{{ session.title || '(untitled)' }}</div>
          <div class="session-meta-inline">
            <span>created {{ fmtRelative(new Date(session.started_at || 0).getTime()) }}</span>
            <span class="dot"></span>
            <span>last active {{ fmtRelative(new Date(session.ended_at || session.started_at || 0).getTime()) }}</span>
            <span class="dot"></span>
            <span>{{ session.message_count || 0 }} messages</span>
            <template v-if="session.git_branch">
              <span class="dot"></span>
              <span>{{ session.git_branch }}</span>
            </template>
          </div>
        </div>

        <!-- Message timeline -->
        <div class="timeline" v-memo="[messages, state.query]">
          <template v-for="msg in messages" :key="msg.uuid" v-memo="[msg, state.query]">

            <!-- Meta messages: collapsed system indicator -->
            <template v-if="msg.is_meta === 1">
              <div class="msg meta" :data-uuid="msg.uuid" :data-message-uuid="msg.uuid">
                <div class="msg-meta-collapsed" :data-view-key="`meta:${msg.uuid}`">
                  <button class="meta-toggle" @click="toggleDisclosure($event, '.msg-meta-collapsed')">
                    <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                    <span class="meta-label">System</span>
                    <span class="meta-preview">{{ (msg.text || '').replace(/<[^>]+>/g, '').slice(0, 80) }}</span>
                  </button>
                  <div class="meta-body">
                    <div v-html="renderMarkdown(msg.text, { variant: 'compact', query: state.query })"></div>
                    <button
                      v-if="isTextTruncated(msg.text)"
                      class="truncated-btn"
                      @click="handleLoadFullText($event, msg.uuid)"
                    >Message truncated — click to load full text</button>
                  </div>
                </div>
              </div>
            </template>

            <!-- Workflow card (standalone, outside assistant bubble) -->
            <template v-else-if="!msg.type || msg.type !== 'user' ? (msg.tool_calls || []).find(tc => tc.name === 'Workflow' && tc.workflow) : false">
              <template v-if="(() => { const wfCall = (msg.tool_calls || []).find(tc => tc.name === 'Workflow' && tc.workflow); return wfCall && msg.type !== 'user'; })()">
                <div class="wf-card" :data-uuid="msg.uuid" :data-message-uuid="msg.uuid">
                  <div class="wf-card-header">
                    <span class="wf-card-icon">&#x2699;</span>
                    <span class="wf-card-name">{{ ((msg.tool_calls || []).find(tc => tc.name === 'Workflow' && tc.workflow)).workflow.workflow_name || 'Workflow' }}</span>
                    <span class="wf-card-count">{{ ((msg.tool_calls || []).find(tc => tc.name === 'Workflow' && tc.workflow)).workflow.agents?.length || 0 }} agents</span>
                    <span
                      v-if="((msg.tool_calls || []).find(tc => tc.name === 'Workflow' && tc.workflow)).workflow.status"
                      class="wf-card-status"
                      :class="((msg.tool_calls || []).find(tc => tc.name === 'Workflow' && tc.workflow)).workflow.status"
                    >{{ ((msg.tool_calls || []).find(tc => tc.name === 'Workflow' && tc.workflow)).workflow.status }}</span>
                  </div>
                  <div class="wf-card-body">
                    <!-- Group agents by phase -->
                    <template v-for="(phaseAgents, phase) in (() => {
                      const wf = ((msg.tool_calls || []).find(tc => tc.name === 'Workflow' && tc.workflow)).workflow;
                      const phases = {};
                      for (const a of (wf.agents || [])) {
                        const p = a.phase || 'Other';
                        if (!phases[p]) phases[p] = [];
                        phases[p].push(a);
                      }
                      return phases;
                    })()" :key="phase">
                      <div class="wf-card-phase">
                        <div class="wf-card-phase-title">{{ phase }}</div>
                        <button
                          v-for="a in phaseAgents"
                          :key="a.agent_id"
                          class="wf-card-agent"
                          @click="navigateToSubagent(a.agent_id, a.label || '')"
                        >
                          <span class="wf-card-agent-label">{{ a.label || a.agent_id }}</span>
                          <span v-if="a.state === 'error'" class="wf-card-agent-state error">error</span>
                          <span class="wf-card-agent-arrow">&rarr;</span>
                        </button>
                      </div>
                    </template>
                  </div>
                </div>
                <!-- Other tool calls (non-workflow) for this message -->
                <template v-if="(msg.tool_calls || []).filter(tc => !(tc.name === 'Workflow' && tc.workflow)).length > 0">
                  <div class="msg assistant" :data-uuid="msg.uuid + '-tools'" :data-message-uuid="msg.uuid">
                    <div class="msg-tools">
                      <template v-for="tc in (msg.tool_calls || []).filter(tc2 => !(tc2.name === 'Workflow' && tc2.workflow))" :key="tc.id">
                        <!-- Render non-workflow tool calls -->
                        <div class="msg-tool" :class="{ 'is-error': tc.result && tc.result.is_error }" :data-view-key="`tool:${tc.id}`">
                          <button class="toolcall-toggle" @click="toggleDisclosure($event, '.msg-tool')">
                            <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                            <span v-if="getToolIcon(tc.name)" class="tool-icon" v-html="getToolIcon(tc.name)"></span>
                            <span class="tool-name">{{ tc.name }}</span>
                            <span class="tool-arg">{{ getArgPreview(tc) }}</span>
                            <span v-if="tc.result && tc.result.is_error" class="tool-error">error</span>
                          </button>
                          <div class="toolcall-body">
                            <div class="toolcall-body-strip">
                              <span class="strip-label">{{ tc.name }}</span>
                              <span class="spacer"></span>
                              <button class="raw-toggle" @click.stop="toggleRaw">{ } Raw</button>
                            </div>
                            <div class="toolcall-pretty" v-html="renderPrettyTool(tc)"></div>
                            <div class="toolcall-raw">
                              <div class="tc-section">Input</div>
                              <pre>{{ formatToolInput(tc) }}</pre>
                              <template v-if="tc.result">
                                <div class="tc-section">{{ tc.result.is_error ? 'Error' : 'Output' }}</div>
                                <pre>{{ tc.result.content || '(empty)' }}</pre>
                              </template>
                            </div>
                          </div>
                        </div>
                      </template>
                    </div>
                  </div>
                </template>
              </template>
            </template>

            <!-- Skill card (standalone, like workflow) -->
            <template v-else-if="msg.type === 'assistant' && (msg.tool_calls || []).length === 1 && msg.tool_calls[0].name === 'Skill' && !msg.text">
              <div class="skill-card" :data-uuid="msg.uuid" :data-message-uuid="msg.uuid" :data-view-key="`skill:${msg.uuid}`">
                <div class="skill-card-icon">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5h6M5 9h4"/></svg>
                </div>
                <div class="skill-card-body">
                  <div class="skill-card-header">
                    <span class="skill-card-badge">Skill</span>
                    <span class="skill-card-name">{{ getToolCallParsedInput(msg.tool_calls[0]).skill || '?' }}</span>
                  </div>
                  <div class="skill-card-args">{{ getToolCallParsedInput(msg.tool_calls[0]).args || '' }}</div>
                  <div v-if="getSkillMd(msg)" class="skill-card-md">
                    <button class="skill-md-toggle" @click="toggleDisclosure($event, '.skill-card', 'skill-md-open')">
                      <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                      <span>SKILL.md</span>
                    </button>
                    <div class="skill-md-body" v-html="renderMarkdown(getSkillMd(msg), { variant: 'compact' })"></div>
                  </div>
                </div>
              </div>
            </template>

            <!-- Standalone thinking message -->
            <template v-else-if="msg.type === 'assistant' && msg.content_type === 'thinking'">
              <div class="msg assistant" :data-uuid="msg.uuid" :data-message-uuid="msg.uuid">
                <div class="msg-thinking" :data-view-key="`thinking:${msg.uuid}`">
                  <button class="thinking-toggle" @click="toggleDisclosure($event, '.msg-thinking')">
                    <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                    <span class="thinking-label">Thinking</span>
                  </button>
                  <div class="thinking-body" v-html="renderMarkdown(msg.text, { variant: 'msg', query: state.query })"></div>
                </div>
              </div>
            </template>

            <!-- Normal message (user or assistant) -->
            <template v-else>
              <div
                class="msg"
                :class="msg.type === 'user' ? 'user' : 'assistant'"
                :data-uuid="msg.uuid"
                :data-message-uuid="msg.uuid"
              >
                <!-- Message header -->
                <div class="msg-head">
                  <span class="role">{{ msg.type === 'user' ? 'You' : 'Assistant' }}</span>
                  <span class="when">{{ msg.timestamp ? fmtClockTime(msg.timestamp) : '' }}</span>
                </div>

                <!-- Attached thinking block (merged from preceding thinking messages) -->
                <div v-if="msg._thinking" class="msg-thinking" :data-view-key="`thinking:${msg.uuid}`">
                    <button class="thinking-toggle" @click="toggleDisclosure($event, '.msg-thinking')">
                    <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                    <span class="thinking-label">Thinking</span>
                  </button>
                  <div class="thinking-body" v-html="renderMarkdown(msg._thinking, { variant: 'msg', query: state.query })"></div>
                </div>

                <!-- Message text body -->
                <template v-if="msg.text">
                  <div v-html="renderMarkdown(msg.text, { variant: 'msg', query: state.query })"></div>
                  <button
                    v-if="isTextTruncated(msg.text)"
                    class="truncated-btn"
                    @click="handleLoadFullText($event, msg.uuid)"
                  >Message truncated — click to load full text</button>
                </template>
                <template v-else-if="!(msg.tool_calls && msg.tool_calls.length)">
                  <div class="msg-text empty-text">(no text content)</div>
                </template>

                <!-- Tool calls -->
                <div v-if="msg.tool_calls && msg.tool_calls.length" class="msg-tools">
                  <template v-for="tc in msg.tool_calls" :key="tc.id">

                    <!-- Skill loaded — agent equipped a capability -->
                    <template v-if="tc.name === 'Skill'">
                      <div class="skill-badge">
                        <span class="skill-label">skill</span>
                        <span class="skill-name">{{ getToolCallParsedInput(tc).skill || '?' }}</span>
                      </div>
                    </template>

                    <!-- Agent/Task tool call (subagent) -->
                    <template v-else-if="tc.name === 'Agent' || tc.name === 'Task'">
                      <div class="msg-tool agent-call" :data-view-key="`tool:${tc.id}`">
                        <button class="toolcall-toggle" @click="toggleDisclosure($event, '.msg-tool')">
                          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                          <span class="tool-name">{{ getToolCallParsedInput(tc).subagent_type || getToolCallParsedInput(tc).agentType || 'Agent' }}</span>
                          <span class="tool-arg">{{ getToolCallParsedInput(tc).description || (getToolCallParsedInput(tc).prompt || '').slice(0, 80) }}</span>
                          <span v-if="tc.result && tc.result.is_error" class="tool-error">error</span>
                          <button
                            v-if="tc.subagent?.agent_id"
                            class="agent-nav-btn"
                            @click.stop="navigateToSubagent(tc.subagent.agent_id, getToolCallParsedInput(tc).description || '')"
                          >View conversation &rarr;</button>
                        </button>
                        <div class="toolcall-body" style="padding:10px 12px;">
                          <template v-if="getToolCallParsedInput(tc).prompt">
                            <div class="tc-section">Prompt</div>
                            <div class="agent-prompt">{{ (getToolCallParsedInput(tc).prompt || '').slice(0, 500) }}{{ (getToolCallParsedInput(tc).prompt || '').length > 500 ? '...' : '' }}</div>
                          </template>
                          <template v-if="tc.result?.content">
                            <div class="tc-section">Result</div>
                            <div class="agent-result" v-html="renderMarkdown(tc.result.content, { variant: 'compact' })"></div>
                          </template>
                        </div>
                      </div>
                    </template>

                    <!-- Workflow tool call (inside assistant bubble) -->
                    <template v-else-if="tc.name === 'Workflow'">
                      <div class="msg-tool agent-call" :data-view-key="`tool:${tc.id}`">
                        <button class="toolcall-toggle" @click="toggleDisclosure($event, '.msg-tool')">
                          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                          <span class="tool-name">Workflow</span>
                          <span class="tool-arg">{{ tc.workflow?.workflow_name || getToolCallParsedInput(tc).name || 'Workflow' }}</span>
                          <span
                            v-if="tc.workflow?.status"
                            class="workflow-status"
                            :class="tc.workflow.status"
                          >{{ tc.workflow.status }}</span>
                          <span v-if="tc.result && tc.result.is_error" class="tool-error">error</span>
                        </button>
                        <div class="toolcall-body" style="padding:10px 12px;">
                          <template v-if="tc.workflow?.agents?.length">
                            <div class="tc-section">Agents &middot; {{ tc.workflow.agents.length }}</div>
                            <div class="workflow-agent-list">
                              <template v-for="(phaseAgents, phase) in (() => {
                                const phases = {};
                                for (const a of (tc.workflow.agents || [])) {
                                  const p = a.phase || 'Other';
                                  if (!phases[p]) phases[p] = [];
                                  phases[p].push(a);
                                }
                                return phases;
                              })()" :key="phase">
                                <div class="workflow-phase-group">
                                  <div class="workflow-phase-header">{{ phase }}</div>
                                  <div class="workflow-phase-agents">
                                    <button
                                      v-for="a in phaseAgents"
                                      :key="a.agent_id"
                                      class="workflow-agent-row"
                                      @click.stop="navigateToSubagent(a.agent_id, a.label || '')"
                                    >
                                      <span class="workflow-agent-label">{{ a.label || a.agent_id }}</span>
                                      <span class="workflow-agent-state" :class="a.state || ''">{{ a.state || '' }}</span>
                                    </button>
                                  </div>
                                </div>
                              </template>
                            </div>
                          </template>
                        </div>
                      </div>
                    </template>

                    <!-- Generic tool call -->
                    <template v-else>
                      <div class="msg-tool" :class="{ 'is-error': tc.result && tc.result.is_error }" :data-view-key="`tool:${tc.id}`">
                        <button class="toolcall-toggle" @click="toggleDisclosure($event, '.msg-tool')">
                          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                          <span v-if="getToolIcon(tc.name)" class="tool-icon" v-html="getToolIcon(tc.name)"></span>
                          <span class="tool-name">{{ tc.name }}</span>
                          <span class="tool-arg">{{ getArgPreview(tc) }}</span>
                          <span v-if="tc.result && tc.result.is_error" class="tool-error">error</span>
                        </button>
                        <div class="toolcall-body">
                          <div class="toolcall-body-strip">
                            <span class="strip-label">{{ tc.name }}</span>
                            <span class="spacer"></span>
                            <button class="raw-toggle" @click.stop="toggleRaw">{ } Raw</button>
                          </div>
                          <div class="toolcall-pretty" v-html="renderPrettyTool(tc)"></div>
                          <div class="toolcall-raw">
                            <div class="tc-section">Input</div>
                            <pre>{{ formatToolInput(tc) }}</pre>
                            <template v-if="tc.result">
                              <div class="tc-section">{{ tc.result.is_error ? 'Error' : 'Output' }}</div>
                              <pre>{{ tc.result.content || '(empty)' }}</pre>
                            </template>
                          </div>
                        </div>
                      </div>
                    </template>

                  </template>
                </div>

                <!-- Summary block -->
                <div v-if="msg.summary" class="msg-summary" :data-view-key="`summary:${msg.uuid}`">
                  <button class="summary-toggle" @click="toggleDisclosure($event, '.msg-summary')">
                    <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                    <span class="label">Session summary</span>
                    <span class="source">{{ msg.summary.source || '' }}</span>
                  </button>
                  <div class="summary-body" v-html="renderMarkdown(msg.summary.content, { variant: 'compact' })"></div>
                </div>
              </div>
            </template>

          </template>
        </div>
      </template>
    </div>

    <!-- Pagination nav -->
    <div class="msg-nav" v-if="totalMsgs > 0">
      <button class="msg-nav-btn" @click="navTo('first')" :disabled="currentMsgIdx === 0" title="First">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v8M7 8l4-4v8z"/></svg>
      </button>
      <button class="msg-nav-btn" @click="navTo('prev')" :disabled="currentMsgIdx === 0" title="Previous">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4l-4 4 4 4"/></svg>
      </button>
      <span class="msg-nav-pos"><span class="msg-nav-current">{{ currentMsgIdx + 1 }}</span> / <FlapNumber :value="totalMsgs" /></span>
      <button class="msg-nav-btn" @click="navTo('next')" :disabled="currentMsgIdx >= totalMsgs - 1" title="Next">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>
      </button>
      <button class="msg-nav-btn" @click="navTo('last')" :disabled="currentMsgIdx >= totalMsgs - 1" title="Last">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v8M9 8l-4-4v8z"/></svg>
      </button>
    </div>

    <Transition name="toast">
      <div v-if="showFontHint" class="font-toast">
        ⌘ +/- to adjust font size
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.detail-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  position: relative;
}
.font-toast {
  position: fixed;
  bottom: 48px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.75);
  border: 1px solid var(--hairline-strong);
  backdrop-filter: blur(12px);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg-2);
  pointer-events: none;
  z-index: 100;
}
.toast-enter-active { transition: opacity 0.3s, transform 0.3s; }
.toast-leave-active { transition: opacity 0.6s, transform 0.6s; }
.toast-enter-from { opacity: 0; transform: translateX(-50%) translateY(8px); }
.toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(-4px); }
</style>
