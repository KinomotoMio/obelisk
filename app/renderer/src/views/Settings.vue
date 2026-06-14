<script setup>
import { ref, onMounted, watch } from 'vue';

defineOptions({ name: 'Settings' });

const claudePath = ref('');
const dbPath = ref('');
const recapPath = ref('');
const autoRefresh = ref(true);
const status = ref('ok');
const statusText = ref('Connected');
const sessionCount = ref(0);
const memoryCount = ref(0);
const lastIndexed = ref('');
const rebuilding = ref(false);
const version = ref('0.1.0');

onMounted(async () => {
  await loadSettings();
});

async function loadSettings() {
  if (!window.obelisk?.getSettings) return;
  const s = await window.obelisk.getSettings();
  claudePath.value = s.claudeDir || '~/.claude';
  dbPath.value = s.dbPath || '';
  recapPath.value = s.recapDir || '~/.obelisk/recap';
  autoRefresh.value = s.autoRefresh !== false;
  sessionCount.value = s.sessionCount || 0;
  memoryCount.value = s.memoryCount || 0;
  lastIndexed.value = s.lastIndexed || '';
  status.value = s.status || 'ok';
  statusText.value = s.statusText || 'Connected';
}

async function browsePath() {
  if (!window.obelisk?.browseFolder) return;
  const result = await window.obelisk.browseFolder();
  if (result) {
    claudePath.value = result;
    await saveSetting('claudeDir', result);
    await loadSettings();
  }
}

async function browseRecapPath() {
  if (!window.obelisk?.browseFolder) return;
  const result = await window.obelisk.browseFolder();
  if (result) {
    recapPath.value = result;
    await saveSetting('recapDir', result);
  }
}

async function resetPath() {
  await saveSetting('claudeDir', null);
  await loadSettings();
}

async function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;
  await saveSetting('autoRefresh', autoRefresh.value);
}

async function saveSetting(key, value) {
  if (window.obelisk?.setSetting) {
    await window.obelisk.setSetting(key, value);
  }
}

async function commitClaudePath() {
  await saveSetting('claudeDir', claudePath.value);
  await loadSettings();
}

async function commitRecapPath() {
  await saveSetting('recapDir', recapPath.value);
}

async function rebuildIndex() {
  if (rebuilding.value || !window.obelisk?.rebuildIndex) return;
  rebuilding.value = true;
  statusText.value = 'Rebuilding…';
  try {
    await window.obelisk.rebuildIndex();
    await loadSettings();
  } finally {
    rebuilding.value = false;
  }
}

async function revealDb() {
  if (window.obelisk?.revealPath) {
    window.obelisk.revealPath(dbPath.value);
  }
}

function fmtRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
</script>

<template>
  <div class="settings-wrap">
    <div class="settings-content">

      <!-- Data Source -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Data Source</h2>
          <p>Where Obelisk reads your Claude Code session history.</p>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Claude Code path</div>
            <div class="form-label-hint">Default <code>~/.claude</code> on macOS &amp; Linux.</div>
          </div>
          <div class="form-control">
            <div class="path-input">
              <input
                class="path-field"
                :class="{ error: status === 'error' }"
                type="text"
                v-model="claudePath"
                spellcheck="false"
                @keydown.enter="commitClaudePath"
                @blur="commitClaudePath"
              />
              <button class="btn" @click="browsePath">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
                  <path d="M2.5 3.5h3.5l1.2 1.2h4.3a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/>
                </svg>
                Browse…
              </button>
              <button class="btn subtle" @click="resetPath" title="Reset to default">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12.5 6.5A5 5 0 1 0 12 9.5"/>
                  <path d="M12.5 2v4.5h-4.5"/>
                </svg>
              </button>
            </div>

            <div class="status-row" :class="status">
              <span class="status-dot" :class="status"></span>
              <span class="status-text">{{ statusText }}</span>
              <div class="status-meta" v-if="sessionCount || lastIndexed">
                <template v-if="lastIndexed">
                  <span>last read <strong>{{ fmtRelative(lastIndexed) }}</strong></span>
                  <span class="sep">·</span>
                </template>
                <span><strong>{{ sessionCount }}</strong> sessions</span>
                <span class="sep">·</span>
                <span><strong>{{ memoryCount }}</strong> memories</span>
              </div>
            </div>
          </div>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Index location</div>
            <div class="form-label-hint">SQLite database where Obelisk caches the session index.</div>
          </div>
          <div class="form-control">
            <div class="path-input">
              <input class="path-field" type="text" :value="dbPath" spellcheck="false" readonly/>
              <button class="btn" @click="revealDb">Reveal</button>
            </div>
          </div>
        </div>

        <div class="form-row">
          <div>
            <div class="form-label">Auto-refresh</div>
            <div class="form-label-hint">Obelisk re-reads when new session files appear.</div>
          </div>
          <div class="form-control">
            <label class="toggle-label" @click.prevent="toggleAutoRefresh">
              <span class="toggle-track" :class="{ on: autoRefresh }">
                <span class="toggle-thumb"></span>
              </span>
              <span class="toggle-text">Watch <code>.claude</code> for changes</span>
            </label>
          </div>
        </div>
      </section>

      <!-- Recap -->
      <section class="settings-section">
        <div class="settings-section-head">
          <h2>Recap</h2>
          <p>Where generated weekly and monthly recap files live.</p>
        </div>
        <div class="form-row">
          <div>
            <div class="form-label">Recap output directory</div>
            <div class="form-label-hint">Watched by Obelisk for new <code>recap-*.json</code> files.</div>
          </div>
          <div class="form-control">
            <div class="path-input">
              <input
                class="path-field"
                type="text"
                v-model="recapPath"
                spellcheck="false"
                @keydown.enter="commitRecapPath"
                @blur="commitRecapPath"
              />
              <button class="btn" @click="browseRecapPath">Browse…</button>
            </div>
          </div>
        </div>
      </section>

      <!-- About -->
      <section class="settings-section last">
        <div class="settings-section-head">
          <h2>About</h2>
          <p>The kind of details you don't usually need.</p>
        </div>
        <div class="form-row">
          <div class="form-label">Version</div>
          <div class="form-control version-text">
            Obelisk {{ version }}
          </div>
        </div>
        <div class="form-row">
          <div class="form-label">Reset</div>
          <div class="form-control">
            <div class="reset-actions">
              <button class="btn" :disabled="rebuilding" @click="rebuildIndex">
                {{ rebuilding ? 'Rebuilding…' : 'Rebuild index' }}
              </button>
            </div>
            <div class="reset-hint">
              Rebuilding only re-reads your Claude Code data. It does not delete memories or recaps.
            </div>
          </div>
        </div>
      </section>

    </div>
  </div>
</template>

<style scoped>
.settings-wrap { flex: 1; overflow-y: auto; min-height: 0; }
.settings-content { max-width: 720px; margin: 0 auto; padding: 36px 32px 80px; }

.settings-section { margin-bottom: 44px; }
.settings-section.last { margin-bottom: 0; }
.settings-section-head {
  margin-bottom: 16px; padding-bottom: 10px;
  border-bottom: 1px solid var(--hairline);
}
.settings-section-head h2 {
  font-size: 18px; font-weight: 600;
  color: var(--fg); letter-spacing: -0.01em; margin-bottom: 2px;
}
.settings-section-head p {
  font-size: 13px; color: var(--muted);
}

.form-row {
  display: grid; grid-template-columns: 180px 1fr;
  gap: 24px; padding: 14px 0; align-items: start;
}
.form-row + .form-row { border-top: 1px solid var(--hairline); }
.form-label { font-size: 13px; color: var(--fg-2); font-weight: 500; padding-top: 6px; }
.form-label-hint {
  font-size: 11.5px; color: var(--muted); margin-top: 4px; font-weight: 400;
}
.form-label-hint code {
  font-family: var(--font-mono); font-style: normal; font-size: 10.5px;
  padding: 1px 4px; background: rgba(0,0,0,0.3); border-radius: 3px; color: var(--muted);
}
.form-control { display: flex; flex-direction: column; gap: 8px; }

.path-input { display: flex; gap: 6px; }
.path-field {
  flex: 1; height: 28px; padding: 0 10px;
  background: rgba(0,0,0,0.3); border: 1px solid var(--hairline-strong);
  border-radius: 5px; font-family: var(--font-mono); font-size: 12px;
  color: var(--fg); min-width: 0; transition: all 0.12s;
}
.path-field:focus { outline: 0; border-color: var(--accent); background: rgba(0,0,0,0.4); box-shadow: 0 0 0 2px rgba(167,139,250,0.12); }
.path-field.error { border-color: rgba(248,113,113,0.4); }
.path-field.error:focus { border-color: #f87171; box-shadow: 0 0 0 2px rgba(248,113,113,0.12); }
.tz-field { max-width: 240px; }

.btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 12px;
  border: 1px solid var(--hairline-strong); border-radius: 5px;
  background: var(--surface); color: var(--fg-2);
  font-size: 12px; font-weight: 500; cursor: pointer;
  transition: all 0.12s; white-space: nowrap;
}
.btn:hover { background: var(--surface-strong); color: var(--fg); border-color: var(--hairline-vivid); }
.btn:disabled { opacity: 0.4; cursor: default; }
.btn.subtle { background: transparent; border-color: transparent; color: var(--muted); }
.btn.subtle:hover { background: var(--surface); color: var(--fg-2); }
.btn svg { width: 13px; height: 13px; }

.status-row {
  display: flex; align-items: center; gap: 14px;
  padding: 8px 12px; background: rgba(0,0,0,0.2);
  border: 1px solid var(--hairline); border-radius: 5px;
  font-family: var(--font-mono); font-size: 11.5px; flex-wrap: wrap;
}
.status-row.ok { border-color: rgba(52,211,153,0.20); background: rgba(52,211,153,0.04); }
.status-row.warn { border-color: rgba(251,191,36,0.20); background: rgba(251,191,36,0.04); }
.status-row.error { border-color: rgba(248,113,113,0.20); background: rgba(248,113,113,0.04); }

.status-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  position: relative;
}
.status-dot.ok { background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.5); }
.status-dot.warn { background: #fbbf24; box-shadow: 0 0 6px rgba(251,191,36,0.5); }
.status-dot.error { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.5); }
.status-dot.ok::before {
  content: ''; position: absolute; inset: -3px;
  border-radius: 50%; border: 1px solid #34d399; opacity: 0.5;
  animation: pulse 1.6s ease-out infinite;
}
@keyframes pulse { 0% { transform: scale(0.8); opacity: 0.5; } 100% { transform: scale(1.6); opacity: 0; } }
.status-text { color: var(--fg-2); font-weight: 500; }
.status-text.error { color: #f87171; }
.status-meta { display: flex; gap: 6px; color: var(--muted); align-items: center; flex-wrap: wrap; }
.status-meta strong { color: var(--fg-2); font-weight: 500; }
.status-meta .sep { color: var(--muted-2); }

.toggle-label { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.toggle-input { position: absolute; opacity: 0; width: 0; height: 0; }
.toggle-track {
  position: relative; width: 30px; height: 16px;
  background: var(--surface-strong); border: 1px solid var(--hairline-strong);
  border-radius: 8px; transition: all 0.15s;
}
.toggle-track.on { background: rgba(167,139,250,0.12); border-color: rgba(167,139,250,0.5); }
.toggle-thumb {
  position: absolute; top: 2px; left: 2px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--muted); transition: all 0.15s;
}
.toggle-track.on .toggle-thumb {
  left: 16px; background: #c4b5fd;
  box-shadow: 0 0 6px rgba(167,139,250,0.5);
}
.toggle-text { font-size: 12.5px; color: var(--fg-2); }
.toggle-text code {
  font-family: var(--font-mono); font-size: 11px;
  padding: 1px 4px; background: rgba(0,0,0,0.3); border-radius: 3px;
}

.version-text {
  font-family: var(--font-mono); font-size: 12px; color: var(--fg-2); padding-top: 6px;
}
.reset-actions { display: flex; gap: 8px; }
.reset-hint {
  font-size: 11.5px; color: var(--muted); margin-top: 6px;
}
</style>
