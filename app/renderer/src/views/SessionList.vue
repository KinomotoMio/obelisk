<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { state } from '../store.js';
import { highlightPlain, escapeHTML, formatProjectLabel, fmtListTime, fmtRelative } from '../utils.js';

defineOptions({ name: 'SessionList' });

const router = useRouter();
const debugEmpty = ref(false);

function onKeydown(e) {
  if (e.key === 'm' && !e.metaKey && !e.ctrlKey && e.target.tagName !== 'INPUT') {
    debugEmpty.value = !debugEmpty.value;
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

const homePath = (typeof process !== 'undefined' && process.env?.HOME) || '~';

const visibleSessions = computed(() => {
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
      const ta = new Date(a.ended_at || a.started_at || 0).getTime();
      const tb = new Date(b.ended_at || b.started_at || 0).getTime();
      return state.sortDesc ? tb - ta : ta - tb;
    });
});

const showProjectPrefix = computed(() => state.projectFilter === 'all');

function titleHTML(session) {
  return highlightPlain(session.title || '(untitled)', state.query.trim());
}

function projectLabel(session) {
  return escapeHTML(formatProjectLabel(session.project));
}

function timeLabel(session) {
  const ts = new Date(session.ended_at || session.started_at || 0).getTime();
  return fmtListTime(ts);
}

function lastActiveLabel(session) {
  const ts = new Date(session.ended_at || session.started_at || 0).getTime();
  return fmtListTime(ts);
}

function createdLabel(session) {
  const ts = new Date(session.started_at || 0).getTime();
  return fmtRelative(ts);
}

function openSession(session) {
  router.push({ name: 'SessionDetail', params: { id: session.id } });
}

function obeliskStyle(session) {
  const created = new Date(session.started_at || 0).getTime();
  const days = Math.max(0, (Date.now() - created) / 86400000);
  const height = Math.min(1, Math.log(1 + days) / Math.log(1 + 365));

  let color;
  if (days < 7) color = '#a855f7';
  else if (days < 30) color = '#6366f1';
  else if (days < 90) color = '#64748b';
  else color = '#475569';

  const glow = days < 7 ? `0 0 4px ${color}` : 'none';
  const maxHeight = 36; // px, roughly the row height minus padding

  return {
    height: `${Math.max(4, Math.round(height * maxHeight))}px`,
    background: color,
    boxShadow: glow,
  };
}
</script>

<template>
  <div class="session-list-wrap">
    <!-- Empty state: no data source / debug toggle -->
    <div v-if="state.loaded && (debugEmpty || (!visibleSessions.length && !state.query))" class="empty-content">
      <div class="empty-eyebrow">
        <span class="diamond"></span>
        <span>No data source connected</span>
      </div>
      <div class="empty-title">Obelisk reads your Claude Code session history.</div>
      <div class="empty-body">
        We didn't find <code>~/.claude</code> on this machine. If you've already used
        Claude Code, point Obelisk at where its data lives in
        <button class="inline-link" @click="router.push('/settings')">Settings</button>. If you haven't,
        <strong>install Claude Code first</strong> — Obelisk has nothing to read until
        sessions exist.
      </div>
      <div class="empty-actions">
        <button class="toolbar-action primary" @click="router.push('/settings')">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
            <path d="M2.5 3.5h3.5l1.2 1.2h4.3a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/>
          </svg>
          Choose folder…
        </button>
      </div>
      <div class="empty-divider"></div>
      <div class="empty-help">
        <div class="help-row">
          <span class="label">expected</span>
          <code>~/.claude</code>
        </div>
        <div class="help-row">
          <span class="label">searched</span>
          <code>{{ homePath }}</code>
        </div>
      </div>
    </div>

    <!-- Empty state: search returned nothing -->
    <div v-else-if="state.loaded && !visibleSessions.length" class="empty">
      No sessions here.
      <span class="hint">{{ state.query ? 'Try a different search term.' : 'Press / to search.' }}</span>
    </div>

    <div v-else class="session-list">
      <div
        v-for="s in visibleSessions"
        :key="s.id"
        class="srow"
        :class="{ cursor: state.cursorId === s.id }"
        :data-session-id="s.id"
        @click="openSession(s)"
      >
        <div class="srow-obelisk" :style="obeliskStyle(s)"></div>
        <div class="srow-body">
          <div class="srow-title" v-html="titleHTML(s)"></div>
          <div class="srow-meta">
            <template v-if="showProjectPrefix">
              <span class="project-tag" v-html="projectLabel(s)"></span>
              <span class="dot"></span>
            </template>
            <span>{{ s.message_count || 0 }} msg</span>
          </div>
        </div>
        <div class="srow-right">{{ timeLabel(s) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-list-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.srow {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: start;
  column-gap: 12px;
  padding: 12px 16px;
  min-height: var(--row-h-session);
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid var(--hairline);
  transition: background 0.06s;
  position: relative;
}
.srow:hover {
  background: rgba(255, 255, 255, 0.025);
}
.srow.cursor {
  background: var(--surface);
}
.srow.cursor::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--muted-2);
}

.srow-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.srow-title {
  font-size: var(--text-md);
  font-weight: 500;
  color: var(--fg);
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow-title :deep(mark) {
  background: var(--accent-soft);
  color: var(--accent-2);
  padding: 0 2px;
  border-radius: 2px;
}

.srow-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.srow-meta .project-tag {
  color: var(--fg-2);
  font-weight: 500;
}
.srow-meta .dot {
  width: 2px;
  height: 2px;
  background: var(--muted-2);
  border-radius: 50%;
  flex-shrink: 0;
}

.srow-right {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-2);
  text-align: right;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  padding-top: 2px;
  white-space: nowrap;
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-2);
  font-size: var(--text-sm);
  padding: 60px 20px;
  text-align: center;
  flex-direction: column;
  gap: 8px;
}
.empty .hint {
  font-size: 11px;
  color: var(--muted-2);
}

/* Onboarding empty state */
.empty-content {
  flex: 1;
  display: flex; flex-direction: column; gap: 16px;
  max-width: 520px;
  margin: 0 auto;
  justify-content: center;
  padding: 40px;
}
.empty-eyebrow {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--muted); letter-spacing: 0.04em;
}
.empty-eyebrow .diamond {
  width: 6px; height: 6px;
  background: var(--accent, #a78bfa); transform: rotate(45deg);
  box-shadow: 0 0 6px rgba(167,139,250,0.4); flex-shrink: 0;
}
.empty-title {
  font-family: var(--font-serif, Georgia); font-size: 22px;
  font-weight: 500; color: var(--fg);
  letter-spacing: -0.015em; line-height: 1.2;
}
.empty-body {
  font-family: var(--font-serif, Georgia); font-style: italic;
  font-size: 14px; color: var(--fg-3); line-height: 1.6; max-width: 460px;
}
.empty-body code {
  font-family: var(--font-mono); font-style: normal; font-size: 12.5px;
  color: var(--accent-2, #c4b5fd); background: rgba(167,139,250,0.12);
  padding: 1px 6px; border-radius: 3px;
}
.empty-body strong { color: var(--fg); font-weight: 600; font-style: normal; }
.empty-body .inline-link {
  color: var(--accent-2, #c4b5fd); background: none;
  border: none; border-bottom: 1px solid rgba(167,139,250,0.4);
  padding: 0 0 1px; font: inherit; cursor: pointer; transition: all 0.12s;
}
.empty-body .inline-link:hover { color: var(--accent, #a78bfa); border-bottom-color: var(--accent); }
.empty-actions { display: flex; gap: 8px; margin-top: 6px; }
.empty-actions .toolbar-action {
  display: inline-flex; align-items: center; gap: 6px;
  height: 32px; padding: 0 14px; border-radius: 5px;
  font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.12s;
}
.empty-actions .toolbar-action.primary {
  border: 1px solid rgba(167,139,250,0.35); background: rgba(167,139,250,0.12); color: #c4b5fd;
}
.empty-actions .toolbar-action.primary:hover {
  background: rgba(167,139,250,0.18); border-color: #a78bfa; color: var(--fg);
  box-shadow: 0 0 12px rgba(167,139,250,0.2);
}
.empty-actions .toolbar-action svg { width: 13px; height: 13px; }
.empty-divider { width: 100%; height: 1px; background: var(--hairline); margin: 6px 0; }
.empty-help {
  display: flex; flex-direction: column; gap: 6px;
  font-family: var(--font-mono); font-size: 11px; color: var(--muted);
}
.empty-help .help-row { display: flex; align-items: baseline; gap: 8px; }
.empty-help .help-row .label { color: var(--muted-2); letter-spacing: 0.04em; width: 76px; flex-shrink: 0; }
.empty-help code {
  font-family: var(--font-mono); color: var(--fg-2);
  background: rgba(0,0,0,0.3); padding: 1px 6px; border-radius: 3px;
}
</style>
