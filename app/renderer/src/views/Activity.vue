<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { state, navigateToSession } from '../store.js';
import { fmtTokens, fmtDuration, fmtTooltipDate, positionTooltip, escapeHTML, formatProjectLabel } from '../utils.js';

defineOptions({ name: 'Activity' });

// --- State ---
const activeTab = ref('daily');
const loading = ref(true);
const usageData = reactive({ daily: [], totalTokens: 0, peakDay: null, longestTurn: null });
const selectedDayKey = ref(null);
const loadedMonths = ref(0);
const monthBlocks = ref([]);

// Tooltip
const tooltip = reactive({ text: '', show: false, x: 0, y: 0 });

// --- Constants ---
const DAY_MS = 86400000;

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// --- Computed: heatmap grid ---
const heatmapGrid = computed(() => {
  const today = new Date();
  let startDate = new Date(today.getTime() - 364 * DAY_MS);
  startDate.setHours(0, 0, 0, 0);
  const daysUntilSunday = (7 - startDate.getDay()) % 7;
  startDate = new Date(startDate.getTime() + daysUntilSunday * DAY_MS);

  const dailyMap = {};
  for (const d of usageData.daily) dailyMap[d.day] = d.tokens;

  const values = usageData.daily.map(d => d.tokens).filter(Boolean);
  const maxTokens = Math.max(...values, 1);

  const cells = [];
  for (let i = 0; i < 371; i++) {
    const date = new Date(startDate.getTime() + i * DAY_MS);
    if (date > today) break;
    const key = date.toISOString().slice(0, 10);
    const tokens = dailyMap[key] || 0;
    const level = tokens === 0 ? 0 : Math.min(4, Math.ceil((tokens / maxTokens) * 4));
    const col = Math.floor(i / 7);
    const row = i % 7;
    cells.push({ key, tokens, level, col, row, date });
  }

  const maxCol = cells.length ? cells[cells.length - 1].col : 0;
  const cellSize = 11;
  const cellGap = 2;
  const step = cellSize + cellGap;
  const gridWidth = (maxCol + 1) * step + 20;
  const gridHeight = 7 * step;

  // Month labels
  const monthLabels = [];
  let lastMonth = -1;
  for (const c of cells) {
    const m = c.date.getMonth();
    if (m !== lastMonth && c.row === 0) {
      monthLabels.push({ col: c.col, label: MONTHS_SHORT[m] });
      lastMonth = m;
    }
  }

  return { cells, monthLabels, gridWidth, gridHeight, cellSize, step };
});

// --- Computed: streaks ---
const currentStreak = computed(() => {
  const today = new Date();
  const dailyMap = {};
  for (const d of usageData.daily) dailyMap[d.day] = d.tokens;

  let streak = 0;
  let startedCounting = false;
  for (let i = 0; i <= 365; i++) {
    const d = new Date(today.getTime() - i * DAY_MS).toISOString().slice(0, 10);
    if (dailyMap[d] && dailyMap[d] > 0) {
      startedCounting = true;
      streak++;
    } else if (startedCounting) {
      break;
    }
  }
  return streak;
});

const longestStreak = computed(() => {
  const sortedDays = [...usageData.daily]
    .filter(d => d.tokens > 0)
    .sort((a, b) => a.day.localeCompare(b.day));

  let longest = 0;
  let streak = 0;
  for (let i = 0; i < sortedDays.length; i++) {
    if (i === 0) {
      streak = 1;
    } else {
      const prev = new Date(sortedDays[i - 1].day).getTime();
      const curr = new Date(sortedDays[i].day).getTime();
      streak = (curr - prev === DAY_MS) ? streak + 1 : 1;
    }
    if (streak > longest) longest = streak;
  }
  return longest;
});

// --- Computed: weekly chart ---
const weeklyBars = computed(() => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let startDate = new Date(today.getTime() - 364 * DAY_MS);
  startDate.setHours(0, 0, 0, 0);
  // Align to Monday (ISO week start)
  const dayOfWeek = startDate.getDay(); // 0=Sun, 1=Mon...
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (dayOfWeek === 1 ? 0 : 8 - dayOfWeek);
  startDate = new Date(startDate.getTime() + daysUntilMonday * DAY_MS);

  const dailyMap = {};
  for (const d of usageData.daily) dailyMap[d.day] = d.tokens;

  const weeks = [];
  for (let w = 0; w < 53; w++) {
    const weekStart = new Date(startDate.getTime() + w * 7 * DAY_MS);
    if (weekStart > today) break;
    let tokens = 0;
    for (let d = 0; d < 7; d++) {
      const date = new Date(weekStart.getTime() + d * DAY_MS);
      if (date > today) break;
      const key = date.toISOString().slice(0, 10);
      tokens += dailyMap[key] || 0;
    }
    weeks.push({ weekStart, tokens, weekKey: localDateStr(weekStart) });
  }

  const maxVal = Math.max(...weeks.map(w => w.tokens), 1);
  const barWidth = 10;
  const barGap = 3;
  const chartHeight = 120;
  const chartWidth = weeks.length * (barWidth + barGap);

  const labels = [];
  let lastMonth = -1;
  for (let i = 0; i < weeks.length; i++) {
    const m = weeks[i].weekStart.getMonth();
    if (m !== lastMonth) { labels.push({ i, label: MONTHS_SHORT[m] }); lastMonth = m; }
  }

  const bars = weeks.map((w, i) => {
    const h = maxVal > 0 ? (w.tokens / maxVal) * chartHeight : 0;
    const x = i * (barWidth + barGap);
    return { x, y: chartHeight - h, width: barWidth, height: Math.max(h, 0.5), label: `Week of ${w.weekKey}: ${fmtTokens(w.tokens)}` };
  });

  return { bars, labels, chartWidth, chartHeight, barWidth, barGap };
});

// --- Computed: cumulative chart ---
const cumulativeData = computed(() => {
  const sorted = [...usageData.daily].sort((a, b) => a.day.localeCompare(b.day));
  if (!sorted.length) return null;

  let cumulative = 0;
  const points = sorted.map(d => { cumulative += d.tokens; return { day: d.day, total: cumulative }; });
  const maxVal = points[points.length - 1].total || 1;

  const chartWidth = 700;
  const chartHeight = 140;

  const xScale = (i) => (i / (points.length - 1)) * chartWidth;
  const yScale = (v) => chartHeight - (v / maxVal) * chartHeight;

  const pathParts = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(p.total).toFixed(1)}`);
  const linePath = pathParts.join(' ');
  const areaPath = linePath + ` L${chartWidth},${chartHeight} L0,${chartHeight} Z`;

  const labels = [];
  let lastMonth = -1;
  for (let i = 0; i < points.length; i++) {
    const m = new Date(points[i].day).getMonth();
    if (m !== lastMonth) { labels.push({ x: xScale(i), label: MONTHS_SHORT[m] }); lastMonth = m; }
  }

  const dots = points.map((p, i) => ({
    cx: xScale(i).toFixed(1),
    cy: yScale(p.total).toFixed(1),
    label: `${p.day}: ${fmtTokens(p.total)} total`
  }));

  return { linePath, areaPath, labels, dots, chartWidth, chartHeight };
});

// --- Computed: day sessions ---
const daySessions = computed(() => {
  if (!selectedDayKey.value) return null;
  const dateKey = selectedDayKey.value;
  const dayStart = dateKey + 'T00:00:00';
  const dayEnd = dateKey + 'T23:59:59';

  const sessions = state.sessions.filter(s => {
    if (!s.started_at) return false;
    const end = s.ended_at || s.started_at;
    return s.started_at <= dayEnd && end >= dayStart;
  });

  const classified = sessions.map(s => {
    const isNew = s.started_at.slice(0, 10) === dateKey;
    let kind = 'continued';
    if (isNew) {
      const hasEarlierSession = state.sessions.some(
        other => other.project === s.project && other.id !== s.id && other.started_at < s.started_at
      );
      kind = hasEarlierSession ? 'new-session' : 'new-workspace';
    }
    return { ...s, kind };
  });

  return {
    dateKey,
    dateLabel: fmtTooltipDate(dateKey),
    newWorkspaces: classified.filter(s => s.kind === 'new-workspace'),
    newSessions: classified.filter(s => s.kind === 'new-session'),
    continued: classified.filter(s => s.kind === 'continued'),
    isEmpty: classified.length === 0
  };
});

// --- Methods ---
function switchTab(view) {
  activeTab.value = view;
}

function onCellEnter(cell, event) {
  tooltip.text = `${fmtTokens(cell.tokens)} tokens on ${fmtTooltipDate(cell.key)}`;
  tooltip.show = true;
  updateTooltipPos(event);
}

function onCellMove(event) {
  updateTooltipPos(event);
}

function onCellLeave() {
  tooltip.show = false;
}

function onCellClick(cell) {
  selectedDayKey.value = cell.key;
}

function onBarEnter(bar, event) {
  tooltip.text = bar.label;
  tooltip.show = true;
  updateTooltipPos(event);
}

function onDotEnter(dot, event) {
  tooltip.text = dot.label;
  tooltip.show = true;
  updateTooltipPos(event);
}

function updateTooltipPos(event) {
  const pad = 12;
  let left = event.clientX + pad;
  if (left + 200 > window.innerWidth - pad) left = event.clientX - 200 - pad;
  tooltip.x = left;
  tooltip.y = event.clientY - 28;
}

function goToSession(sessionId) {
  navigateToSession(sessionId);
}

function buildMonthBlock(year, month) {
  const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const nextMonth = month === 11 ? `${year + 1}-01-01` : `${year}-${String(month + 2).padStart(2, '0')}-01`;

  const monthSessions = state.sessions.filter(s => {
    if (!s.started_at) return false;
    const end = s.ended_at || s.started_at;
    return s.started_at < nextMonth && end >= monthStart;
  });

  const classified = monthSessions.map(s => {
    const startedInMonth = s.started_at >= monthStart && s.started_at < nextMonth;
    let kind = 'continued';
    if (startedInMonth) {
      const hasEarlierSession = state.sessions.some(
        other => other.project === s.project && other.id !== s.id && other.started_at < s.started_at
      );
      kind = hasEarlierSession ? 'new-session' : 'new-workspace';
    }
    return { ...s, kind };
  });

  return {
    header: `${MONTHS_FULL[month]} ${year}`,
    newWorkspaces: classified.filter(s => s.kind === 'new-workspace'),
    newSessions: classified.filter(s => s.kind === 'new-session'),
    continued: classified.filter(s => s.kind === 'continued'),
    isEmpty: classified.length === 0
  };
}

function showNextMonth() {
  const today = new Date();
  const targetDate = new Date(today.getFullYear(), today.getMonth() - loadedMonths.value, 1);
  const block = buildMonthBlock(targetDate.getFullYear(), targetDate.getMonth());
  monthBlocks.value.push(block);
  loadedMonths.value++;
}

function projectLabel(project) {
  return formatProjectLabel(project);
}

function newSessionProjectCount(sessions) {
  const projects = new Set(sessions.map(s => s.project || '(none)'));
  return projects.size;
}

// --- Lifecycle ---
onMounted(async () => {
  try {
    const data = await window.obelisk.getUsageStats();
    usageData.daily = data.daily || [];
    usageData.totalTokens = data.totalTokens || 0;
    usageData.peakDay = data.peakDay || null;
    usageData.longestTurn = data.longestTurn || null;
  } catch (e) {
    console.error('Failed to load usage stats:', e);
  }
  loading.value = false;
  showNextMonth();
});
</script>

<template>
  <div class="usage-wrap" v-if="!loading">
    <div class="detail-wide">
      <!-- Header with tabs -->
      <div class="usage-header">
        <span class="usage-title">Token activity</span>
        <div class="usage-view-tabs">
          <button
            class="usage-tab"
            :class="{ active: activeTab === 'daily' }"
            @click="switchTab('daily')"
          >Daily</button>
          <button
            class="usage-tab"
            :class="{ active: activeTab === 'weekly' }"
            @click="switchTab('weekly')"
          >Weekly</button>
          <button
            class="usage-tab"
            :class="{ active: activeTab === 'cumulative' }"
            @click="switchTab('cumulative')"
          >Cumulative</button>
        </div>
      </div>

      <!-- Stats bar -->
      <div class="usage-stats">
        <div class="usage-stat">
          <span class="usage-stat-value">{{ fmtTokens(usageData.totalTokens) }}</span>
          <span class="usage-stat-label">Lifetime tokens</span>
        </div>
        <div class="usage-stat">
          <span class="usage-stat-value">{{ usageData.peakDay ? fmtTokens(usageData.peakDay.tokens) : '—' }}</span>
          <span class="usage-stat-label">Peak tokens</span>
        </div>
        <div class="usage-stat">
          <span class="usage-stat-value">{{ usageData.longestTurn ? fmtDuration(usageData.longestTurn.turn_duration_ms) : '—' }}</span>
          <span class="usage-stat-label">Longest task</span>
        </div>
        <div class="usage-stat">
          <span class="usage-stat-value">{{ currentStreak }}d</span>
          <span class="usage-stat-label">Current streak</span>
        </div>
        <div class="usage-stat">
          <span class="usage-stat-value">{{ longestStreak }}d</span>
          <span class="usage-stat-label">Longest streak</span>
        </div>
      </div>

      <!-- Daily heatmap -->
      <div class="heatmap-container" v-show="activeTab === 'daily'">
        <svg
          class="heatmap"
          :width="heatmapGrid.gridWidth"
          :height="heatmapGrid.gridHeight + 20"
          :viewBox="`0 0 ${heatmapGrid.gridWidth} ${heatmapGrid.gridHeight + 20}`"
        >
          <rect
            v-for="cell in heatmapGrid.cells"
            :key="cell.key"
            :x="cell.col * heatmapGrid.step"
            :y="cell.row * heatmapGrid.step"
            :width="heatmapGrid.cellSize"
            :height="heatmapGrid.cellSize"
            rx="2"
            :class="['heatmap-cell', `level-${cell.level}`, { selected: selectedDayKey === cell.key }]"
            @mouseenter="onCellEnter(cell, $event)"
            @mousemove="onCellMove"
            @mouseleave="onCellLeave"
            @click="onCellClick(cell)"
          />
          <text
            v-for="ml in heatmapGrid.monthLabels"
            :key="'ml-' + ml.col"
            :x="ml.col * heatmapGrid.step"
            :y="heatmapGrid.gridHeight + 14"
            class="heatmap-month"
          >{{ ml.label }}</text>
        </svg>
        <div class="heatmap-legend">
          <span class="heatmap-legend-label">Less</span>
          <svg width="70" height="11">
            <rect x="0" width="11" height="11" rx="2" class="heatmap-cell level-0"/>
            <rect x="14" width="11" height="11" rx="2" class="heatmap-cell level-1"/>
            <rect x="28" width="11" height="11" rx="2" class="heatmap-cell level-2"/>
            <rect x="42" width="11" height="11" rx="2" class="heatmap-cell level-3"/>
            <rect x="56" width="11" height="11" rx="2" class="heatmap-cell level-4"/>
          </svg>
          <span class="heatmap-legend-label">More</span>
        </div>
      </div>

      <!-- Weekly bar chart -->
      <div class="chart-container" v-show="activeTab === 'weekly'">
        <svg
          class="weekly-chart"
          :viewBox="`0 0 ${weeklyBars.chartWidth + 20} ${weeklyBars.chartHeight + 24}`"
          preserveAspectRatio="xMidYMid meet"
        >
          <rect
            v-for="(bar, i) in weeklyBars.bars"
            :key="'bar-' + i"
            :x="bar.x"
            :y="bar.y"
            :width="bar.width"
            :height="bar.height"
            rx="2"
            class="bar-fill"
            @mouseenter="onBarEnter(bar, $event)"
            @mousemove="onCellMove"
            @mouseleave="onCellLeave"
          />
          <text
            v-for="(lbl, i) in weeklyBars.labels"
            :key="'wlbl-' + i"
            :x="lbl.i * (weeklyBars.barWidth + weeklyBars.barGap)"
            :y="weeklyBars.chartHeight + 16"
            class="heatmap-month"
          >{{ lbl.label }}</text>
        </svg>
      </div>

      <!-- Cumulative line chart -->
      <div class="chart-container" v-show="activeTab === 'cumulative'">
        <template v-if="cumulativeData">
          <svg
            :viewBox="`0 0 ${cumulativeData.chartWidth} ${cumulativeData.chartHeight + 24}`"
            preserveAspectRatio="xMidYMid meet"
            class="cumulative-chart"
          >
            <path :d="cumulativeData.areaPath" class="cumulative-area"/>
            <path :d="cumulativeData.linePath" class="cumulative-line"/>
            <circle
              v-for="(dot, i) in cumulativeData.dots"
              :key="'dot-' + i"
              :cx="dot.cx"
              :cy="dot.cy"
              r="6"
              class="cumulative-dot"
              @mouseenter="onDotEnter(dot, $event)"
              @mousemove="onCellMove"
              @mouseleave="onCellLeave"
            />
            <text
              v-for="(lbl, i) in cumulativeData.labels"
              :key="'clbl-' + i"
              :x="lbl.x"
              :y="cumulativeData.chartHeight + 16"
              class="heatmap-month"
            >{{ lbl.label }}</text>
          </svg>
        </template>
        <div v-else class="empty">No data</div>
      </div>

      <!-- Day sessions panel (from heatmap click) -->
      <div class="day-sessions" v-if="daySessions">
        <div class="day-sessions-header">{{ daySessions.dateLabel }}<template v-if="daySessions.isEmpty"> — no sessions</template></div>
        <div class="day-activity-timeline" v-if="!daySessions.isEmpty">
          <!-- New workspaces -->
          <div class="activity-group" v-if="daySessions.newWorkspaces.length">
            <div class="activity-group-header">
              <span class="activity-icon workspace">&#9733;</span>
              <span class="activity-group-title">Created {{ daySessions.newWorkspaces.length }} new workspace{{ daySessions.newWorkspaces.length > 1 ? 's' : '' }}</span>
            </div>
            <div class="activity-group-items">
              <button
                v-for="s in daySessions.newWorkspaces"
                :key="s.id"
                class="activity-item"
                @click="goToSession(s.id)"
              >
                <span class="activity-item-name"><span class="activity-item-project">{{ projectLabel(s.project) }}</span> {{ s.title || '(untitled)' }}</span>
                <span class="activity-item-meta">{{ s.message_count || 0 }} msg</span>
              </button>
            </div>
          </div>
          <!-- New sessions -->
          <div class="activity-group" v-if="daySessions.newSessions.length">
            <div class="activity-group-header">
              <span class="activity-icon new">+</span>
              <span class="activity-group-title">Started {{ daySessions.newSessions.length }} session{{ daySessions.newSessions.length > 1 ? 's' : '' }} in {{ newSessionProjectCount(daySessions.newSessions) }} project{{ newSessionProjectCount(daySessions.newSessions) > 1 ? 's' : '' }}</span>
            </div>
            <div class="activity-group-items">
              <button
                v-for="s in daySessions.newSessions"
                :key="s.id"
                class="activity-item"
                @click="goToSession(s.id)"
              >
                <span class="activity-item-name">{{ s.title || '(untitled)' }}</span>
                <span class="activity-item-meta">{{ projectLabel(s.project) }} · {{ s.message_count || 0 }} msg</span>
              </button>
            </div>
          </div>
          <!-- Continued sessions -->
          <div class="activity-group continued" v-if="daySessions.continued.length">
            <div class="activity-group-header">
              <span class="activity-icon continued">&#8627;</span>
              <span class="activity-group-title">Continued {{ daySessions.continued.length }} session{{ daySessions.continued.length > 1 ? 's' : '' }}</span>
            </div>
            <div class="activity-group-items">
              <button
                v-for="s in daySessions.continued"
                :key="s.id"
                class="activity-item"
                @click="goToSession(s.id)"
              >
                <span class="activity-item-name">{{ s.title || '(untitled)' }}</span>
                <span class="activity-item-meta">{{ projectLabel(s.project) }} · {{ s.message_count || 0 }} msg</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Monthly activity blocks -->
      <div class="day-sessions" v-if="!selectedDayKey">
        <template v-for="(block, bi) in monthBlocks" :key="bi">
          <div class="day-sessions-header">{{ block.header }}</div>
          <div class="day-activity-timeline" v-if="!block.isEmpty">
            <div class="activity-group" v-if="block.newWorkspaces.length">
              <div class="activity-group-header">
                <span class="activity-icon workspace">&#9733;</span>
                <span class="activity-group-title">Created {{ block.newWorkspaces.length }} new workspace{{ block.newWorkspaces.length > 1 ? 's' : '' }}</span>
              </div>
              <div class="activity-group-items">
                <button
                  v-for="s in block.newWorkspaces"
                  :key="s.id"
                  class="activity-item"
                  @click="goToSession(s.id)"
                >
                  <span class="activity-item-name"><span class="activity-item-project">{{ projectLabel(s.project) }}</span> {{ s.title || '(untitled)' }}</span>
                  <span class="activity-item-meta">{{ s.message_count || 0 }} msg</span>
                </button>
              </div>
            </div>
            <div class="activity-group" v-if="block.newSessions.length">
              <div class="activity-group-header">
                <span class="activity-icon new">+</span>
                <span class="activity-group-title">Started {{ block.newSessions.length }} session{{ block.newSessions.length > 1 ? 's' : '' }} in {{ newSessionProjectCount(block.newSessions) }} project{{ newSessionProjectCount(block.newSessions) > 1 ? 's' : '' }}</span>
              </div>
              <div class="activity-group-items">
                <button
                  v-for="s in block.newSessions"
                  :key="s.id"
                  class="activity-item"
                  @click="goToSession(s.id)"
                >
                  <span class="activity-item-name">{{ s.title || '(untitled)' }}</span>
                  <span class="activity-item-meta">{{ projectLabel(s.project) }} · {{ s.message_count || 0 }} msg</span>
                </button>
              </div>
            </div>
            <div class="activity-group continued" v-if="block.continued.length">
              <div class="activity-group-header">
                <span class="activity-icon continued">&#8627;</span>
                <span class="activity-group-title">Continued {{ block.continued.length }} session{{ block.continued.length > 1 ? 's' : '' }}</span>
              </div>
              <div class="activity-group-items">
                <button
                  v-for="s in block.continued"
                  :key="s.id"
                  class="activity-item"
                  @click="goToSession(s.id)"
                >
                  <span class="activity-item-name">{{ s.title || '(untitled)' }}</span>
                  <span class="activity-item-meta">{{ projectLabel(s.project) }} · {{ s.message_count || 0 }} msg</span>
                </button>
              </div>
            </div>
          </div>
          <div v-else style="color:var(--muted);font-size:13px;padding:8px 0;">No sessions this month.</div>
        </template>
        <button class="show-more-btn" @click="showNextMonth">Show more activity</button>
      </div>

      <!-- Tooltip -->
      <div
        class="chart-tooltip"
        :class="{ show: tooltip.show }"
        :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
      >{{ tooltip.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.usage-wrap { flex: 1; overflow-y: auto; min-height: 0; }
.usage-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 24px;
}
.usage-title { font-size: 16px; font-weight: 600; color: var(--fg); letter-spacing: -0.01em; }

.usage-view-tabs { display: flex; gap: 0; }
.usage-tab {
  padding: 5px 12px; font-size: 12px; font-family: var(--font-mono);
  color: var(--muted); background: transparent;
  border: 1px solid var(--hairline); cursor: pointer;
  transition: all 0.1s;
}
.usage-tab:first-child { border-radius: 4px 0 0 4px; }
.usage-tab:last-child { border-radius: 0 4px 4px 0; }
.usage-tab:not(:first-child) { border-left: 0; }
.usage-tab:hover { color: var(--fg-2); background: var(--surface-strong); }
.usage-tab.active { color: var(--fg); background: var(--accent-soft); border-color: var(--accent-soft); }

.usage-stats {
  display: flex; gap: 0; margin-bottom: 32px;
  border-radius: 8px;
  background: var(--surface); border: 1px solid var(--hairline);
  overflow: hidden;
}
.usage-stat {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  gap: 4px; padding: 16px 12px;
  border-right: 1px solid var(--hairline);
}
.usage-stat:last-child { border-right: 0; }
.usage-stat-value { font-size: 18px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.usage-stat-label { font-size: 10.5px; color: var(--muted); font-family: var(--font-mono); text-align: center; }

.heatmap-container { margin-top: 8px; }
.heatmap { display: block; width: 100%; height: auto; }
.heatmap-cell { transition: opacity 0.08s; cursor: pointer; }
.heatmap-cell.level-0 { fill: var(--surface-strong); }
.heatmap-cell.level-1 { fill: rgba(99, 102, 241, 0.3); }
.heatmap-cell.level-2 { fill: rgba(99, 102, 241, 0.5); }
.heatmap-cell.level-3 { fill: rgba(139, 92, 246, 0.7); }
.heatmap-cell.level-4 { fill: rgba(168, 85, 247, 0.9); }
.heatmap-cell:hover { opacity: 0.7; }
.heatmap-cell.selected { stroke: var(--fg); stroke-width: 1.5; }
.heatmap-month { font-size: 10px; fill: var(--muted-2); font-family: var(--font-mono); }

.heatmap-legend {
  display: flex; align-items: center; gap: 6px;
  margin-top: 12px; justify-content: flex-end;
}
.heatmap-legend-label { font-size: 10px; color: var(--muted-2); font-family: var(--font-mono); }

/* Chart container (weekly / cumulative) */
.chart-container { margin-top: 8px; overflow-x: auto; }
.chart-container svg { display: block; width: 100%; max-height: 160px; }

.bar-fill { fill: var(--accent); opacity: 0.8; transition: opacity 0.08s; cursor: pointer; }
.bar-fill:hover { opacity: 1; }

.cumulative-area { fill: rgba(99, 102, 241, 0.12); }
.cumulative-line { fill: none; stroke: var(--accent); stroke-width: 1.5; }
.cumulative-dot { fill: var(--accent); opacity: 0; transition: opacity 0.08s; cursor: pointer; }
.cumulative-dot:hover { opacity: 1; }

/* Chart tooltip */
.chart-tooltip {
  position: fixed; z-index: 200;
  padding: 5px 10px; border-radius: 4px;
  background: rgba(30, 35, 50, 0.95);
  border: 1px solid var(--hairline-strong);
  color: var(--fg-2);
  font-family: var(--font-mono); font-size: 11px;
  pointer-events: none; opacity: 0;
  white-space: nowrap;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: opacity 0.1s;
}
.chart-tooltip.show { opacity: 1; }

/* Day sessions panel */
.day-sessions { margin-top: 24px; }
.day-sessions-header {
  font-size: 14px; font-weight: 600; color: var(--fg);
  margin-top: 28px; margin-bottom: 16px; padding-bottom: 10px;
  border-bottom: 1px solid var(--hairline);
}
.day-sessions-header:first-child { margin-top: 0; }

.day-activity-timeline {
  display: flex; flex-direction: column; gap: 20px;
  padding-left: 16px; border-left: 2px solid var(--hairline);
}

.activity-group { position: relative; }
.activity-group-header {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 8px; font-size: 14px; color: var(--fg);
  font-weight: 500;
}
.activity-icon {
  width: 24px; height: 24px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; flex-shrink: 0;
  margin-left: -28px;
  border: 2px solid var(--bg);
}
.activity-icon.workspace { background: rgba(245,158,11,0.2); color: #f59e0b; }
.activity-icon.new { background: var(--accent-soft); color: var(--accent-2); }
.activity-icon.continued { background: var(--surface-strong); color: var(--muted); }

.activity-group-title { font-size: 13px; }
.activity-group.continued .activity-group-title { color: var(--muted); }

.activity-group-items { display: flex; flex-direction: column; gap: 3px; padding-left: 6px; }
.activity-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-radius: 5px;
  background: transparent; border: 0;
  cursor: pointer; transition: background 0.08s;
  text-align: left; width: 100%;
  font: inherit; color: inherit;
}
.activity-item:hover { background: var(--surface-strong); }
.activity-item-name { font-size: 13px; color: var(--accent-2); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-item-name .activity-item-project { color: var(--muted); font-weight: 400; margin-right: 4px; }
.activity-item:hover .activity-item-name { text-decoration: underline; text-underline-offset: 2px; }
.activity-item-meta { font-size: 11px; color: var(--muted); font-family: var(--font-mono); flex-shrink: 0; }

.activity-group.continued .activity-item-name { color: var(--fg-2); }

.show-more-btn {
  display: block; width: 100%; margin-top: 20px;
  padding: 8px; border-radius: 4px;
  background: var(--accent-soft); border: 1px solid rgba(167,139,250,0.2);
  color: var(--accent-2); font-size: 12px; font-family: var(--font-mono);
  cursor: pointer; transition: all 0.1s; text-align: center;
}
.show-more-btn:hover { background: rgba(167,139,250,0.2); border-color: var(--accent); }

.empty { color: var(--muted); font-size: 13px; padding: 16px 0; text-align: center; }
</style>
