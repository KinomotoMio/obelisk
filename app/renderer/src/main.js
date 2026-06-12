// Vue 3 application entry point for Obelisk.

import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import { loadInitialData } from './data.js';

// Import all original CSS globally
import '../styles/base.css';
import '../styles/sidebar.css';
import '../styles/toolbar.css';
import '../styles/list.css';
import '../styles/detail.css';
import '../styles/statusbar.css';

const app = createApp(App);

app.use(router);

// Load data before the first render completes
router.isReady().then(() => {
  loadInitialData();
});

app.mount('#app');
