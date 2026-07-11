// Vue 3 application entry point for Obelisk.

import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import { loadInitialData } from './data.js';
import { noteSessionUpdated, sessionLiveState } from './session-live.mjs';

// Import shared renderer CSS globally
import '../styles/base.css';
import '../styles/sidebar.css';
import '../styles/toolbar.css';
import '../styles/list.css';
import '../styles/detail.css';

const app = createApp(App);

app.use(router);

// Load data on startup
router.isReady().then(() => {
  loadInitialData();
});

// Refresh data when window regains focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadInitialData();
  }
});

window.obelisk?.onIndexUpdated?.(() => {
  loadInitialData();
});

window.obelisk?.onSessionUpdated?.(({ sessionId } = {}) => {
  const route = router.currentRoute.value;
  const currentSessionId = route.name === 'SessionDetail' ? String(route.params.id || '') : null;
  noteSessionUpdated(sessionLiveState, sessionId, currentSessionId);
});

app.mount('#app');
