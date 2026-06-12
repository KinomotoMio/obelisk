<script setup>
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import {
  state,
  FOLDER_SVG,
  setRoute,
  setView,
  setProject,
  setProjectSearch
} from '../store.js';
import { formatProjectLabel } from '../utils.js';

const router = useRouter();
const route = useRoute();

// --- Counts ---

const sessionCount = computed(() => state.sessions.length);
const activeCount = computed(() => state.memories.filter(m => !m.archived).length);
const archivedCount = computed(() => state.memories.filter(m => m.archived).length);
const totalMemoryCount = computed(() => state.memories.length);

// --- Projects list ---

const sidebarProjects = computed(() => {
  const items = state.route === 'sessions' ? state.sessions : state.memories;
  const filtered = items.filter(item => {
    if (state.route === 'sessions') return true;
    return state.view === 'archived' ? item.archived : !item.archived;
  });
  let projects = [...new Set(filtered.map(item => item.project).filter(Boolean))];
  if (state.projectSearch) {
    const q = state.projectSearch.toLowerCase();
    projects = projects.filter(p => p.toLowerCase().includes(q));
  }
  projects.sort((a, b) => formatProjectLabel(a).localeCompare(formatProjectLabel(b)));

  // Count per project
  const counts = {};
  for (const item of filtered) {
    if (item.project) counts[item.project] = (counts[item.project] || 0) + 1;
  }

  return projects.map(p => ({
    slug: p,
    label: formatProjectLabel(p),
    count: counts[p] || 0
  }));
});

// --- Active state helpers ---

function isSessionsActive() {
  return state.route === 'sessions' && state.projectFilter === 'all';
}

function isMemoryViewActive(view) {
  return state.route === 'memory' && state.view === view && state.projectFilter === 'all';
}

function isUsageActive() {
  return state.route === 'usage';
}

function isProjectActive(slug) {
  return state.projectFilter === slug;
}

// --- Navigation handlers ---

function handleSidebarRoute(routeName) {
  setRoute(routeName);
  if (routeName === 'sessions') {
    router.push('/sessions');
  } else if (routeName === 'usage') {
    router.push('/usage');
  } else {
    router.push('/memory');
  }
}

function handleSidebarView(view) {
  setView(view);
  router.push('/memory');
}

function handleSidebarProject(slug) {
  setProject(slug);
  if (state.route === 'sessions') router.push('/sessions');
  else router.push('/memory');
}

function handleProjectSearch(e) {
  setProjectSearch(e.target.value);
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-brand">
      <svg viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
        <path d="M10 4 L10 16" stroke="url(#obelisk-grad)" stroke-width="2.5" stroke-linecap="round"/>
        <defs>
          <linearGradient id="obelisk-grad" x1="10" y1="4" x2="10" y2="16" gradientUnits="userSpaceOnUse">
            <stop stop-color="#a78bfa"/>
            <stop offset="1" stop-color="#6366f1"/>
          </linearGradient>
        </defs>
      </svg>
      <span class="name">Obelisk</span>
    </div>

    <!-- Library section -->
    <div class="sidebar-section">
      <div class="sidebar-section-title"><span>Library</span></div>

      <button
        class="sidebar-item"
        :class="{ active: isSessionsActive() }"
        @click="handleSidebarRoute('sessions')"
      >
        <span class="icon">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <rect x="2" y="3" width="12" height="10" rx="1.5"/>
            <path d="M5 1v4M11 1v4"/>
          </svg>
        </span>
        <span class="label">Sessions</span>
        <span class="badge">{{ sessionCount }}</span>
      </button>

      <!-- Memory parent (non-clickable label) -->
      <div class="sidebar-section-title" style="padding-top: 8px;">
        <span>Memory</span>
        <span class="badge">{{ totalMemoryCount }}</span>
      </div>

      <button
        class="sidebar-item sub"
        :class="{ active: isMemoryViewActive('active') }"
        @click="handleSidebarView('active')"
      >
        <span class="icon">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <circle cx="8" cy="8" r="5.5"/>
            <path d="M8 5v3l2 1.5"/>
          </svg>
        </span>
        <span class="label">Active</span>
        <span class="badge">{{ activeCount }}</span>
      </button>

      <button
        class="sidebar-item sub"
        :class="{ active: isMemoryViewActive('archived') }"
        @click="handleSidebarView('archived')"
      >
        <span class="icon">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M2.5 5h11v7.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V5z"/>
            <path d="M1.5 3.5h13v2h-13z"/>
            <path d="M6 8h4"/>
          </svg>
        </span>
        <span class="label">Archived</span>
        <span class="badge">{{ archivedCount }}</span>
      </button>
    </div>

    <!-- Stats section -->
    <div class="sidebar-section">
      <div class="sidebar-section-title"><span>Stats</span></div>

      <button
        class="sidebar-item"
        :class="{ active: isUsageActive() }"
        @click="handleSidebarRoute('usage')"
      >
        <span class="icon">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M2 13h12M4 9v4M7 6v7M10 8v5M13 4v9"/>
          </svg>
        </span>
        <span class="label">Usage</span>
      </button>
    </div>

    <!-- Projects section -->
    <div class="sidebar-section projects">
      <div class="sidebar-section-title">
        <span>Projects</span>
      </div>
      <div class="sidebar-search">
        <svg class="sidebar-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="7" cy="7" r="4.5"/>
          <path d="M10.5 10.5L14 14"/>
        </svg>
        <input
          type="text"
          placeholder="Filter..."
          :value="state.projectSearch"
          @input="handleProjectSearch"
        />
      </div>
      <div class="sidebar-list">
        <button
          v-for="p in sidebarProjects"
          :key="p.slug"
          class="sidebar-item"
          :class="{ active: isProjectActive(p.slug) }"
          @click="handleSidebarProject(p.slug)"
        >
          <span class="icon" v-html="FOLDER_SVG"></span>
          <span class="label">{{ p.label }}</span>
          <span class="badge">{{ p.count }}</span>
        </button>
        <div v-if="!sidebarProjects.length" class="sidebar-empty">
          No projects
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  border-right: 1px solid var(--hairline-strong);
  background: rgba(0,0,0,0.2);
  display: flex; flex-direction: column;
  min-height: 0;
}
.sidebar-brand {
  display: flex; align-items: center; gap: 8px;
  padding: 0 14px; height: 36px;
  border-bottom: 1px solid var(--hairline);
  flex-shrink: 0;
}
.sidebar-brand svg { width: 18px; height: 18px; filter: drop-shadow(0 0 8px rgba(167,139,250,0.4)); }
.sidebar-brand .name { font-size: var(--text-base); font-weight: 600; color: var(--fg-2); }
.sidebar-section { padding: 8px 6px; flex-shrink: 0; }
.sidebar-section.projects { flex: 1; min-height: 0; display: flex; flex-direction: column; padding-bottom: 0; }
.sidebar-section + .sidebar-section { border-top: 1px solid var(--hairline); }
.sidebar-section-title {
  padding: 4px 10px 6px;
  font-size: 10.5px; color: var(--muted);
  font-weight: 500; letter-spacing: 0.04em;
  display: flex; justify-content: space-between;
  flex-shrink: 0;
}
.sidebar-search { position: relative; padding: 0 6px 6px; flex-shrink: 0; }
.sidebar-search input {
  width: 100%; height: 24px;
  padding: 0 8px 0 24px;
  border: 1px solid var(--hairline); border-radius: 4px;
  background: var(--surface);
  font-size: var(--text-sm); color: var(--fg);
  transition: all 0.1s;
}
.sidebar-search input::placeholder { color: var(--muted-2); }
.sidebar-search input:focus { outline: 0; border-color: var(--accent); background: var(--surface-strong); }
.sidebar-search-icon {
  position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
  width: 11px; height: 11px; color: var(--muted); pointer-events: none;
}
.sidebar-list { overflow-y: auto; padding: 2px 0 8px; flex: 1; min-height: 0; }
.sidebar-item {
  display: flex; align-items: center; gap: 8px;
  padding: 0 10px; height: var(--row-h-compact);
  border-radius: 5px;
  color: var(--fg-2); font-size: var(--text-base);
  cursor: pointer; user-select: none;
  transition: background 0.08s; position: relative;
  width: 100%; text-align: left;
  border: none; background: none;
}
.sidebar-item:hover { background: var(--surface-strong); color: var(--fg); }
.sidebar-item.active { background: var(--accent-soft); color: var(--fg); }
.sidebar-item.active::before {
  content: ''; position: absolute; left: -6px; top: 4px; bottom: 4px;
  width: 2px; background: var(--accent); border-radius: 1px;
  box-shadow: 0 0 8px var(--accent-glow);
}
.sidebar-item .icon { width: 14px; height: 14px; color: var(--muted); flex-shrink: 0; transition: all 0.08s; }
.sidebar-item.active .icon { color: var(--accent-2); filter: drop-shadow(0 0 4px var(--accent-glow)); }
.sidebar-item.warning .icon { color: var(--danger); }
.sidebar-item .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-item .badge {
  font-family: var(--font-mono); font-size: 10.5px;
  color: var(--muted); font-variant-numeric: tabular-nums;
  line-height: 1; min-width: 22px; text-align: right;
  flex-shrink: 0; padding: 2px 0;
}
.sidebar-item.active .badge { color: var(--fg-2); }
.sidebar-item.warning .badge {
  color: var(--danger); background: var(--danger-soft);
  padding: 2px 6px; border-radius: 8px;
  margin-right: -6px; min-width: 22px;
}
.sidebar-item.sub { padding-left: 30px; height: 26px; font-size: var(--text-sm); }
.sidebar-item.sub .icon { width: 12px; height: 12px; }
.sidebar-empty {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--muted-2);
}
</style>
