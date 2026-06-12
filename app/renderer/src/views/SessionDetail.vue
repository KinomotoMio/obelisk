<script setup>
import { ref, computed, onMounted, nextTick, onActivated, watch } from 'vue';
import { useRouter } from 'vue-router';
import { state, FOLDER_SVG } from '../store.js';
import { loadSessionDetail, isTextTruncated, loadFullText } from '../data.js';
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

// --- Reactive state ---
const session = computed(() => state.sessions.find(s => s.id === props.id));
const messages = ref([]);
const loading = ref(false);
const progressPct = ref(0);
const showBackToTop = ref(false);

// DOM refs
const wrapRef = ref(null);
const detailRef = ref(null);

// --- Load session on mount or when id changes ---
onMounted(async () => {
  await loadMessages();
});

onActivated(async () => {
  if (messages.value.length === 0 && props.id) {
    await loadMessages();
  }
});

watch(() => props.id, async (newId, oldId) => {
  if (newId && newId !== oldId) {
    messages.value = [];
    await loadMessages();
  }
});

async function loadMessages() {
  if (!props.id) return;
  loading.value = true;
  try {
    const s = state.sessions.find(x => x.id === props.id);
    if (s && (!s.messages || s.messages.length === 0)) {
      const loaded = await loadSessionDetail(props.id);
      if (loaded) Object.assign(s, loaded);
    }
    messages.value = s?.messages || [];
  } finally {
    loading.value = false;
  }

  // Focus pending uuid if any
  if (state.pendingFocusUuid) {
    const targetUuid = state.pendingFocusUuid;
    state.pendingFocusUuid = null;
    await nextTick();
    const target = detailRef.value?.querySelector(`.msg[data-uuid="${targetUuid}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      target.classList.add('is-focused');
      setTimeout(() => target.classList.remove('is-focused'), 1200);
    }
  }
}

// --- Scroll / progress tracking ---
function onScroll() {
  if (!wrapRef.value || !detailRef.value) return;
  const msgs = detailRef.value.querySelectorAll('.msg, .wf-card');
  if (!msgs.length) return;
  const wrapTop = wrapRef.value.getBoundingClientRect().top;
  let topMsgIdx = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].getBoundingClientRect().top <= wrapTop + 50) topMsgIdx = i;
    else break;
  }
  const pct = msgs.length <= 1 ? 100 : Math.round((topMsgIdx / (msgs.length - 1)) * 100);
  progressPct.value = pct;
  showBackToTop.value = wrapRef.value.scrollTop > 300;
}

function scrollToTop() {
  if (wrapRef.value) wrapRef.value.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Toggle helpers ---
function toggleToolCall(event) {
  const btn = event.currentTarget;
  btn.closest('.msg-tool').classList.toggle('open');
}

function toggleSummary(event) {
  const btn = event.currentTarget;
  btn.closest('.msg-summary').classList.toggle('open');
}

function toggleThinking(event) {
  const btn = event.currentTarget;
  btn.closest('.msg-thinking').classList.toggle('open');
}

function toggleMeta(event) {
  const btn = event.currentTarget;
  btn.closest('.msg-meta-collapsed').classList.toggle('open');
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

function getArgPreview(tc) {
  try {
    const j = JSON.parse(tc.input_json || '{}');
    if (j.file_path) return j.file_path;
    if (j.command) return j.command;
    if (j.path) return j.path;
    if (j.description) return j.description;
    return JSON.stringify(j).slice(0, 100);
  } catch {
    return (tc.input_json || '').slice(0, 100);
  }
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
  <div class="detail-wrap" ref="wrapRef" @scroll="onScroll">
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
        <div class="timeline">
          <template v-for="(msg, idx) in messages" :key="msg.uuid || idx">

            <!-- Meta messages: collapsed system indicator -->
            <template v-if="msg.is_meta === 1">
              <div class="msg meta" :data-uuid="msg.uuid">
                <div class="msg-meta-collapsed">
                  <button class="meta-toggle" @click="toggleMeta">
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
                <div class="wf-card" :data-uuid="msg.uuid">
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
                  <div class="msg assistant" :data-uuid="msg.uuid + '-tools'">
                    <div class="msg-tools">
                      <template v-for="tc in (msg.tool_calls || []).filter(tc2 => !(tc2.name === 'Workflow' && tc2.workflow))" :key="tc.id">
                        <!-- Render non-workflow tool calls -->
                        <div class="msg-tool" :class="{ 'is-error': tc.result && tc.result.is_error }">
                          <button class="toolcall-toggle" @click="toggleToolCall">
                            <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                            <span class="tool-name">{{ tc.name }}</span>
                            <span class="tool-arg">{{ getArgPreview(tc) }}</span>
                            <span v-if="tc.result && tc.result.is_error" class="tool-error">error</span>
                          </button>
                          <div class="toolcall-body">
                            <div class="tc-section">Input</div>
                            <pre>{{ tc.input_json || '' }}</pre>
                            <template v-if="tc.result">
                              <div class="tc-section">{{ tc.result.is_error ? 'Error' : 'Output' }}</div>
                              <pre>{{ tc.result.content || '(empty)' }}</pre>
                            </template>
                          </div>
                        </div>
                      </template>
                    </div>
                  </div>
                </template>
              </template>
            </template>

            <!-- Standalone thinking message -->
            <template v-else-if="msg.type === 'assistant' && msg.content_type === 'thinking'">
              <div class="msg assistant" :data-uuid="msg.uuid">
                <div class="msg-thinking">
                  <button class="thinking-toggle" @click="toggleThinking">
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
              >
                <!-- Message header -->
                <div class="msg-head">
                  <span class="role">{{ msg.type === 'user' ? 'You' : 'Assistant' }}</span>
                  <span class="when">{{ msg.timestamp ? fmtClockTime(msg.timestamp) : '' }}</span>
                </div>

                <!-- Attached thinking block (merged from preceding thinking messages) -->
                <div v-if="msg._thinking" class="msg-thinking">
                  <button class="thinking-toggle" @click="toggleThinking">
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

                    <!-- Agent/Task tool call (subagent) -->
                    <template v-if="tc.name === 'Agent' || tc.name === 'Task'">
                      <div class="msg-tool agent-call">
                        <button class="toolcall-toggle" @click="toggleToolCall">
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
                        <div class="toolcall-body">
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
                      <div class="msg-tool agent-call">
                        <button class="toolcall-toggle" @click="toggleToolCall">
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
                        <div class="toolcall-body">
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
                      <div class="msg-tool" :class="{ 'is-error': tc.result && tc.result.is_error }">
                        <button class="toolcall-toggle" @click="toggleToolCall">
                          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                          <span class="tool-name">{{ tc.name }}</span>
                          <span class="tool-arg">{{ getArgPreview(tc) }}</span>
                          <span v-if="tc.result && tc.result.is_error" class="tool-error">error</span>
                        </button>
                        <div class="toolcall-body">
                          <div class="tc-section">Input</div>
                          <pre>{{ tc.input_json || '' }}</pre>
                          <template v-if="tc.result">
                            <div class="tc-section">{{ tc.result.is_error ? 'Error' : 'Output' }}</div>
                            <pre>{{ tc.result.content || '(empty)' }}</pre>
                          </template>
                        </div>
                      </div>
                    </template>

                  </template>
                </div>

                <!-- Summary block -->
                <div v-if="msg.summary" class="msg-summary">
                  <button class="summary-toggle" @click="toggleSummary">
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

      <!-- Back to top button -->
      <button
        class="back-to-top"
        :class="{ show: showBackToTop }"
        @click="scrollToTop"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12V4M4 7l4-4 4 4"/></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.detail-wrap {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
</style>
