<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { state, FOLDER_SVG } from '../store.js';
import { loadMemoryMarkdown, archiveMemory, restoreMemory, isTextTruncated } from '../data.js';
import { escapeHTML, fmtRelative, renderMarkdown, formatProjectLabel } from '../utils.js';

defineOptions({ name: 'MemoryDetail' });
const props = defineProps({ id: String });
const router = useRouter();

const memory = computed(() => state.memories.find(m => m.id === props.id));
const markdown = ref(null);
const showSource = ref(false);
const loading = ref(false);

onMounted(async () => { await loadContent(); });
watch(() => props.id, async () => { markdown.value = null; showSource.value = false; await loadContent(); });

async function loadContent() {
  const m = memory.value;
  if (!m) return;
  if (m.markdown != null) { markdown.value = m.markdown; return; }
  if (m.path) {
    loading.value = true;
    const content = await loadMemoryMarkdown(m.path);
    m.markdown = content;
    markdown.value = content;
    loading.value = false;
  }
}

async function handleArchive() {
  const m = memory.value;
  if (!m) return;
  if (m.archived) await restoreMemory(m.id);
  else await archiveMemory(m.id);
  router.push('/memory');
}

function goToSession() {
  const m = memory.value;
  if (m?.session_id) router.push(`/sessions/${m.session_id}`);
}
</script>

<template>
  <div class="detail" v-if="memory">
    <div class="detail-header">
      <div class="detail-eyebrow">
        <span class="project-icon" v-html="FOLDER_SVG"></span>
        <span class="project-name">{{ formatProjectLabel(memory.project) }}</span>
        <span v-if="memory.archived" class="archived-tag">archived</span>
      </div>
      <div class="detail-path">{{ memory.path }}</div>
      <div class="detail-summary">{{ memory.summary }}</div>
      <div class="detail-meta">
        <button v-if="memory.session_id" class="session-link" @click="goToSession">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" style="width:11px;height:11px;">
            <path d="M3 4h10v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4z"/>
            <path d="M5.5 7h5M5.5 9.5h3" stroke-linecap="round"/>
          </svg>
          <span>Source session</span>
        </button>
        <span class="dot" v-if="memory.session_id"></span>
        <span>created {{ fmtRelative(memory.ts) }}</span>
        <template v-if="memory.message_start">
          <span class="dot"></span>
          <span style="font-family:var(--font-mono);font-size:11px;">{{ memory.message_start.slice(0, 8) }}…→ {{ (memory.message_end || '').slice(0, 8) }}…</span>
        </template>
      </div>
    </div>

    <div class="markdown-section">
      <div class="markdown-toolbar">
        <span class="markdown-toolbar-label">Body</span>
        <button
          class="source-toggle"
          :class="{ active: showSource }"
          :disabled="markdown == null"
          @click="showSource = !showSource"
        >{{ showSource ? 'Show rendered' : 'Show source' }}</button>
      </div>
      <div v-if="loading" style="color:var(--muted);padding:20px;text-align:center;">Loading…</div>
      <div v-else-if="markdown == null" style="color:var(--muted-2);font-style:italic;padding:20px;text-align:center;border:1px dashed var(--hairline);border-radius:6px;">File not found or empty.</div>
      <pre v-else-if="showSource" class="markdown-source">{{ markdown }}</pre>
      <div v-else v-html="renderMarkdown(markdown, { variant: 'body' })"></div>
    </div>

    <div v-if="memory.anchors && memory.anchors.length" class="detail-section-divider" id="anchors-section">
      <span>Anchors</span><span class="count">{{ memory.anchors.length }}</span>
    </div>
    <div v-if="memory.anchors && memory.anchors.length" class="anchor-list">
      <button
        v-for="a in memory.anchors"
        :key="a.path + ':' + a.line"
        class="anchor-link"
        :disabled="a.exists === false"
        :title="a.exists === false ? 'File no longer exists' : 'Open in editor'"
      >
        <span class="anchor-icon">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M3.5 2h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9.5 2v3h3"/></svg>
        </span>
        <span class="anchor-path">{{ a.path }}</span>
        <span class="anchor-line" v-if="a.line">:{{ a.line }}</span>
      </button>
    </div>

    <div class="detail-actions">
      <button class="btn" @click="router.push('/memory')">Back</button>
      <button class="btn" :class="memory.archived ? 'primary' : 'danger'" @click="handleArchive">
        {{ memory.archived ? 'Restore' : 'Archive' }}
      </button>
    </div>
  </div>
</template>
