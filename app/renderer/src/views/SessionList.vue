<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { state } from '../store.js';
import { highlightPlain, escapeHTML, formatProjectLabel, fmtListTime } from '../utils.js';

defineOptions({ name: 'SessionList' });

const router = useRouter();

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
      const ta = new Date(a.started_at || 0).getTime();
      const tb = new Date(b.started_at || 0).getTime();
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
  const ts = new Date(session.started_at || 0).getTime();
  return fmtListTime(ts);
}

function openSession(session) {
  router.push({ name: 'SessionDetail', params: { id: session.id } });
}
</script>

<template>
  <div class="session-list-wrap">
    <div v-if="!visibleSessions.length" class="empty">
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
</style>
