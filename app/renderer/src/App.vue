<script setup>
import { computed, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import {
  state,
  IS_MAC,
  FOLDER_SVG,
  setRoute,
  setView,
  setProject,
  setQuery,
  setProjectSearch,
  toggleSort,
  toggleIncludeMessageBodies
} from './store.js';
import { formatProjectLabel } from './utils.js';

const router = useRouter();
const route = useRoute();

// --- Sidebar data ---

const activeCount = computed(() => state.memories.filter(m => !m.archived).length);
const archivedCount = computed(() => state.memories.filter(m => m.archived).length);
const totalMemoryCount = computed(() => state.memories.length);
const sessionCount = computed(() => state.sessions.length);

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

// --- Toolbar visibility ---

const showToolbar = computed(() => {
  const r = route.name;
  return r === 'SessionList' || r === 'MemoryList';
});

const showSearchMsgsToggle = computed(() => {
  return route.name === 'SessionList';
});

// --- Window title ---

const windowTitle = computed(() => {
  const appName = 'Obelisk';
  let scopeText = '';
  if (route.name === 'Usage') {
    scopeText = 'Usage';
  } else if (route.name?.startsWith('Session')) {
    if (route.name === 'SessionDetail' || route.name === 'SubagentDetail') {
      const s = state.sessions.find(x => x.id === route.params.id);
      scopeText = s ? `Sessions · ${s.title}` : 'Sessions';
    } else {
      const proj = state.projectFilter !== 'all' ? ` · ${formatProjectLabel(state.projectFilter)}` : '';
      scopeText = `Sessions${proj}`;
    }
  } else {
    if (route.name === 'MemoryDetail') {
      const m = state.memories.find(x => x.id === route.params.id);
      scopeText = m ? `Memory · ${m.path.split('/').pop()}` : 'Memory';
    } else {
      const viewLabel = state.view === 'archived' ? 'Archived' : 'Active';
      const proj = state.projectFilter !== 'all' ? ` · ${formatProjectLabel(state.projectFilter)}` : '';
      scopeText = `Memory · ${viewLabel}${proj}`;
    }
  }
  return { appName, scopeText };
});

watch(() => windowTitle.value.scopeText, (scopeText) => {
  document.title = `${windowTitle.value.appName} — ${scopeText}`;
}, { immediate: true });

// --- Navigation helpers ---

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
  // Stay on current list route
  if (state.route === 'sessions') router.push('/sessions');
  else router.push('/memory');
}

function handleProjectSearch(e) {
  setProjectSearch(e.target.value);
}

// --- Search ---

let searchTimer = null;
function handleSearch(e) {
  const value = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    setQuery(value);
  }, 200);
}

function handleToggleSort() {
  toggleSort();
}

function handleToggleSearchMsgs() {
  toggleIncludeMessageBodies();
}

// --- Keep-alive includes ---
const keepAliveIncludes = ['SessionDetail'];
</script>

<template>
  <div class="app-shell">
    <!-- Titlebar (macOS traffic-light region) -->
    <div class="titlebar" :class="{ mac: IS_MAC }">
      <div class="titlebar-drag"></div>
      <div id="titlebar-text" class="titlebar-text">
        <span class="app-name">{{ windowTitle.appName }}</span>
        <span class="sep">—</span>
        <span class="scope">{{ windowTitle.scopeText }}</span>
      </div>
    </div>

    <!-- Columns: sidebar + main -->
    <div class="columns">
      <!-- Sidebar -->
      <aside class="sidebar">
        <div class="sidebar-brand">
          <svg viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.2" opacity="0.6"/>
            <path d="M10 4 L10 16" stroke="url(#obelisk-grad)" stroke-width="2.5" stroke-linecap="round"/>
            <defs><linearGradient id="obelisk-grad" x1="10" y1="4" x2="10" y2="16" gradientUnits="userSpaceOnUse"><stop stop-color="#a78bfa"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs>
          </svg>
          <span class="name">Obelisk</span>
        </div>

        <!-- Navigation section -->
        <div class="sidebar-section">
          <button
            class="sidebar-item"
            :class="{ active: state.route === 'sessions' && state.projectFilter === 'all' }"
            @click="handleSidebarRoute('sessions')"
          >
            <span class="icon">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 1v4M11 1v4"/></svg>
            </span>
            <span class="label">Sessions</span>
            <span class="badge">{{ sessionCount }}</span>
          </button>

          <button
            class="sidebar-item sub"
            :class="{ active: state.route === 'memory' && state.view === 'active' && state.projectFilter === 'all' }"
            @click="handleSidebarView('active')"
          >
            <span class="icon">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/></svg>
            </span>
            <span class="label">Active</span>
            <span class="badge">{{ activeCount }}</span>
          </button>

          <button
            class="sidebar-item sub"
            :class="{ active: state.route === 'memory' && state.view === 'archived' && state.projectFilter === 'all' }"
            @click="handleSidebarView('archived')"
          >
            <span class="icon">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 5h11v7.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5V5z"/><path d="M1.5 3.5h13v2h-13z"/><path d="M6 8h4"/></svg>
            </span>
            <span class="label">Archived</span>
            <span class="badge">{{ archivedCount }}</span>
          </button>

          <button
            class="sidebar-item"
            :class="{ active: state.route === 'usage' }"
            @click="handleSidebarRoute('usage')"
          >
            <span class="icon">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 13h12M4 9v4M7 6v7M10 8v5M13 4v9"/></svg>
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
            <input
              type="text"
              placeholder="Filter..."
              :value="state.projectSearch"
              @input="handleProjectSearch"
            />
          </div>
          <div id="sidebar-projects" class="sidebar-projects-list">
            <button
              v-for="p in sidebarProjects"
              :key="p.slug"
              class="sidebar-item"
              :class="{ active: state.projectFilter === p.slug }"
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

      <!-- Main content area -->
      <div class="main">
        <!-- Toolbar with search + sort (only on list views) -->
        <div v-if="showToolbar" class="toolbar">
          <div class="breadcrumb">
            <span class="crumb terminal">
              {{ state.route === 'sessions' ? 'Sessions' : 'Memory' }}
            </span>
            <template v-if="state.projectFilter !== 'all'">
              <span class="crumb-sep">/</span>
              <span class="crumb terminal">{{ formatProjectLabel(state.projectFilter) }}</span>
            </template>
          </div>
          <div class="spacer"></div>
          <div id="search-wrap" class="search-wrap">
            <input
              id="search"
              type="text"
              class="search-input"
              placeholder="Search..."
              @input="handleSearch"
            />
            <button
              v-if="showSearchMsgsToggle"
              class="filter-toggle"
              :class="{ active: state.includeMessageBodies }"
              @click="handleToggleSearchMsgs"
              title="Include message bodies in search"
            >
              Msgs
            </button>
          </div>
          <button
            id="sort-toggle"
            class="sort-group"
            :class="{ desc: state.sortDesc, asc: !state.sortDesc }"
            @click="handleToggleSort"
          >
            <span id="sort-label">{{ state.sortDesc ? 'newest' : 'oldest' }}</span>
          </button>
        </div>

        <!-- Toolbar for detail views (breadcrumb only) -->
        <div v-if="!showToolbar" class="toolbar">
          <div class="breadcrumb">
            <router-link class="crumb" to="/sessions" v-if="route.name === 'SessionDetail' || route.name === 'SubagentDetail'">
              Sessions
            </router-link>
            <template v-if="route.name === 'SubagentDetail'">
              <span class="crumb-sep">/</span>
              <router-link class="crumb" :to="`/sessions/${route.params.id}`">
                {{ (state.sessions.find(s => s.id === route.params.id)?.title || '').slice(0, 30) || route.params.id }}
              </router-link>
            </template>
            <template v-if="route.name === 'SessionDetail'">
              <span class="crumb-sep">/</span>
              <span class="crumb terminal">
                {{ state.sessions.find(s => s.id === route.params.id)?.title || route.params.id }}
              </span>
            </template>
            <template v-if="route.name === 'SubagentDetail'">
              <span class="crumb-sep">/</span>
              <span class="crumb terminal">{{ route.params.agentId }}</span>
            </template>
            <router-link class="crumb" to="/memory" v-if="route.name === 'MemoryDetail'">
              Memory
            </router-link>
            <template v-if="route.name === 'MemoryDetail'">
              <span class="crumb-sep">/</span>
              <span class="crumb terminal filename">
                {{ (state.memories.find(m => m.id === route.params.id)?.path || '').split('/').pop() }}
              </span>
            </template>
            <span v-if="route.name === 'Usage'" class="crumb terminal">Usage</span>
          </div>
        </div>

        <!-- Router view with keep-alive for SessionDetail -->
        <router-view v-slot="{ Component }">
          <keep-alive :include="keepAliveIncludes">
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </div>
    </div>

    <!-- Status bar -->
    <div class="statusbar">
      <div id="status-left" class="status-left"></div>
      <div id="status-right" class="status-right"></div>
    </div>
  </div>
</template>

<style>
@import '../styles/base.css';
@import '../styles/sidebar.css';
@import '../styles/toolbar.css';
@import '../styles/list.css';
@import '../styles/detail.css';
@import '../styles/statusbar.css';
</style>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.titlebar {
  height: 38px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  -webkit-app-region: drag;
  background: var(--bg-2);
  border-bottom: 1px solid var(--hairline);
}

.titlebar.mac {
  padding-left: 78px;
}

.titlebar-drag {
  position: absolute;
  inset: 0;
}

.titlebar-text {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}

.titlebar-text .app-name {
  font-weight: 600;
  color: var(--fg-2);
}

.titlebar-text .sep {
  opacity: 0.4;
}

.columns {
  display: flex;
  flex: 1;
  min-height: 0;
}

.spacer {
  flex: 1;
}

.statusbar {
  height: 26px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--bg-2);
  border-top: 1px solid var(--hairline);
  font-size: 11px;
  color: var(--muted);
}

.sidebar-empty {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--muted-2);
}

.sidebar-projects-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
</style>
