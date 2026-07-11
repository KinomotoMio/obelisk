<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { state, toggleSort, setQuery, toggleIncludeMessageBodies } from '../store.js';
import { formatProjectLabel } from '../utils.js';

// --- Route info ---
const route = useRoute();

const isListView = computed(() => {
  return route.name === 'SessionList' || route.name === 'MemoryList';
});

const showSearchMsgsToggle = computed(() => {
  return route.name === 'SessionList';
});

// --- Breadcrumb computation ---
const breadcrumbs = computed(() => {
  const name = route.name;
  const crumbs = [];

  if (name === 'SessionList') {
    crumbs.push({ label: 'Sessions', terminal: true });
    if (state.projectFilter !== 'all') {
      crumbs.push({ label: formatProjectLabel(state.projectFilter), terminal: true });
    }
  } else if (name === 'SessionDetail') {
    crumbs.push({ label: 'Sessions', to: '/sessions' });
    const s = state.sessions.find(x => x.id === route.params.id);
    crumbs.push({ label: s?.title || route.params.id, terminal: true });
  } else if (name === 'SubagentDetail') {
    crumbs.push({ label: 'Sessions', to: '/sessions' });
    const s = state.sessions.find(x => x.id === route.params.id);
    crumbs.push({ label: (s?.title || '').slice(0, 30) || route.params.id, to: `/sessions/${route.params.id}` });
    crumbs.push({ label: route.params.agentId, terminal: true });
  } else if (name === 'MemoryList') {
    crumbs.push({ label: 'Memory', terminal: true });
    if (state.projectFilter !== 'all') {
      crumbs.push({ label: formatProjectLabel(state.projectFilter), terminal: true });
    }
  } else if (name === 'MemoryDetail') {
    crumbs.push({ label: 'Memory', to: '/memory' });
    const m = state.memories.find(x => x.id === route.params.id);
    const filename = (m?.path || '').split('/').pop();
    crumbs.push({ label: filename, terminal: true, filename: true });
  } else if (name === 'Activity') {
    crumbs.push({ label: 'Activity', terminal: true });
  } else if (name === 'Recap') {
    crumbs.push({ label: 'Recap', terminal: true });
  }

  return crumbs;
});

// --- Search ---
const searchInput = ref(null);
let searchTimer = null;

function handleSearch(e) {
  const value = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    setQuery(value);
  }, 200);
}

// --- Keyboard shortcut: / to focus search ---
function handleKeydown(e) {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    searchInput.value?.focus();
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  clearTimeout(searchTimer);
});

// --- Sort ---
function handleToggleSort() {
  toggleSort();
}

function handleToggleSearchMsgs() {
  toggleIncludeMessageBodies();
}
</script>

<template>
  <div class="toolbar">
    <div class="breadcrumb">
      <template v-for="(crumb, i) in breadcrumbs" :key="i">
        <span v-if="i > 0" class="crumb-sep">/</span>
        <router-link
          v-if="crumb.to"
          class="crumb"
          :to="crumb.to"
        >
          {{ crumb.label }}
        </router-link>
        <span
          v-else
          class="crumb terminal"
          :class="{ filename: crumb.filename }"
        >
          {{ crumb.label }}
        </span>
      </template>
    </div>

    <div class="toolbar-spacer"></div>

    <!-- Search + sort controls (list views only) -->
    <template v-if="isListView">
      <div class="toolbar-search">
        <svg class="toolbar-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="6.5" cy="6.5" r="4"/>
          <path d="M10 10l3.5 3.5"/>
        </svg>
        <input
          ref="searchInput"
          type="text"
          placeholder="Search..."
          @input="handleSearch"
        />
        <span class="toolbar-search-kbd">/</span>
      </div>

      <button
        v-if="showSearchMsgsToggle"
        class="filter-toggle"
        :class="{ active: state.includeMessageBodies }"
        @click="handleToggleSearchMsgs"
        title="Include message bodies in search"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <rect x="2" y="3" width="12" height="10" rx="1.5"/>
          <path d="M2 5.5l6 3.5 6-3.5"/>
        </svg>
      </button>

      <button
        class="sort-group"
        :class="{ desc: state.sortDesc, asc: !state.sortDesc }"
        @click="handleToggleSort"
      >
        <span class="label">{{ state.sortDesc ? 'newest' : 'oldest' }}</span>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
          <path class="arrow-up" d="M8 3v5M5.5 5.5L8 3l2.5 2.5"/>
          <path class="arrow-down" d="M8 8v5M5.5 10.5L8 13l2.5-2.5"/>
        </svg>
      </button>
    </template>
  </div>
</template>

<style scoped>
.toolbar {
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--hairline-strong);
  background: rgba(0, 0, 0, 0.15);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.crumb {
  font-size: var(--text-md);
  color: var(--muted);
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.1s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  line-height: 1;
  border: 0;
  background: transparent;
  white-space: nowrap;
  text-decoration: none;
}

.crumb:hover {
  background: var(--surface-strong);
  color: var(--fg-2);
}

.crumb.terminal {
  color: var(--fg);
  font-weight: 600;
  cursor: default;
}

.crumb.terminal:hover {
  background: transparent;
}

.crumb svg {
  width: 13px;
  height: 13px;
  color: var(--muted);
}

.crumb.filename {
  font-family: var(--font-mono);
  font-weight: 500;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.crumb-sep {
  color: var(--muted-2);
  font-size: var(--text-md);
  user-select: none;
}

.toolbar-spacer {
  flex: 1;
}

.toolbar-search {
  width: 220px;
  position: relative;
}

.toolbar-search input {
  width: 100%;
  height: 26px;
  padding: 0 30px 0 26px;
  border: 1px solid var(--hairline);
  border-radius: 5px;
  background: var(--surface);
  font-size: var(--text-base);
  color: var(--fg);
  transition: all 0.12s;
}

.toolbar-search input::placeholder {
  color: var(--muted-2);
}

.toolbar-search input:focus {
  outline: 0;
  border-color: var(--accent);
  background: var(--surface-strong);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.toolbar-search-icon {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 12px;
  height: 12px;
  color: var(--muted);
  pointer-events: none;
}

.toolbar-search-kbd {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted-2);
  padding: 1px 5px;
  border: 1px solid var(--hairline);
  border-radius: 3px;
  pointer-events: none;
  line-height: 1.2;
}

.toolbar-search input:focus ~ .toolbar-search-kbd,
.toolbar-search input:not(:placeholder-shown) ~ .toolbar-search-kbd {
  opacity: 0;
}

.filter-toggle {
  height: 26px;
  width: 26px;
  border-radius: 5px;
  color: var(--muted);
  display: inline-grid;
  place-items: center;
  transition: all 0.1s;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
}

.filter-toggle:hover {
  color: var(--fg-2);
  background: var(--surface-strong);
}

.filter-toggle.active {
  color: var(--accent-2);
  background: var(--accent-soft);
  border-color: var(--accent-soft);
}

.filter-toggle svg {
  width: 13px;
  height: 13px;
}

.sort-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 26px;
  padding: 0 4px 0 8px;
  border-radius: 5px;
  cursor: pointer;
  color: var(--muted);
  font-size: var(--text-sm);
  transition: background 0.1s, color 0.1s;
  border: none;
  background: transparent;
}

.sort-group:hover {
  background: var(--surface-strong);
  color: var(--fg-2);
}

.sort-group .label {
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
}

.sort-group svg {
  width: 13px;
  height: 13px;
}

.sort-group .arrow-up,
.sort-group .arrow-down {
  transition: opacity 0.12s;
}

.sort-group.desc .arrow-up {
  opacity: 0.25;
}

.sort-group.desc .arrow-down {
  opacity: 1;
}

.sort-group.asc .arrow-up {
  opacity: 1;
}

.sort-group.asc .arrow-down {
  opacity: 0.25;
}
</style>
