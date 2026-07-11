// Usage rendering module -- heatmap, weekly chart, cumulative chart.
// Extracted from render.js with identical logic.

import { state } from './state.js';
import { escapeHTML, fmtDuration, fmtTokens, fmtTooltipDate, positionTooltip, formatProjectLabel, $ } from './utils.js';
import registry from './registry.js';

function navigateToSession(sessionId, focusUuid) {
  if (registry.navigateToSession) {
    registry.navigateToSession(sessionId, focusUuid);
  }
}

export async function renderUsage() {
  const usage = $('#usage');
  if (!usage) return;

  const data = await window.obelisk.getUsageStats();
  const { daily, totalTokens, peakDay, longestTurn } = data;

  // Build heatmap: 52 weeks x 7 days grid
  const today = new Date();
  const dayMs = 86400000;
  // Start from the first Sunday on or after 364 days ago (full weeks only)
  let startDate = new Date(today.getTime() - 364 * dayMs);
  startDate.setHours(0, 0, 0, 0);
  const daysUntilSunday = (7 - startDate.getDay()) % 7;
  startDate = new Date(startDate.getTime() + daysUntilSunday * dayMs);

  const dailyMap = {};
  for (const d of daily) dailyMap[d.day] = d.tokens;

  const values = daily.map(d => d.tokens).filter(Boolean);
  const maxTokens = Math.max(...values, 1);

  // Generate cells (startDate is always a Sunday now)
  const cells = [];
  for (let i = 0; i < 371; i++) {
    const date = new Date(startDate.getTime() + i * dayMs);
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
  const gridWidth = (maxCol + 1) * step + 20; // extra padding for last month label
  const gridHeight = 7 * step;

  const cellsHTML = cells.map(c => {
    const x = c.col * step;
    const y = c.row * step;
    return `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" class="heatmap-cell level-${c.level}" data-label="${fmtTokens(c.tokens)} tokens on ${fmtTooltipDate(c.key)}"></rect>`;
  }).join('');

  // Month labels
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthLabels = [];
  let lastMonth = -1;
  for (const c of cells) {
    const m = c.date.getMonth();
    if (m !== lastMonth && c.row === 0) {
      monthLabels.push({ col: c.col, label: months[m] });
      lastMonth = m;
    }
  }
  const monthLabelsHTML = monthLabels.map(m =>
    `<text x="${m.col * step}" y="${gridHeight + 14}" class="heatmap-month">${m.label}</text>`
  ).join('');

  // Streak calculation — check gaps between consecutive active days
  let longestStreak = 0;
  let streak = 0;
  const sortedDays = [...daily].filter(d => d.tokens > 0).sort((a, b) => a.day.localeCompare(b.day));
  for (let i = 0; i < sortedDays.length; i++) {
    if (i === 0) {
      streak = 1;
    } else {
      const prev = new Date(sortedDays[i - 1].day).getTime();
      const curr = new Date(sortedDays[i].day).getTime();
      if (curr - prev === dayMs) {
        streak++;
      } else {
        streak = 1;
      }
    }
    if (streak > longestStreak) longestStreak = streak;
  }
  // Current streak: find the most recent active day, then count consecutive days backwards
  let currentStreak = 0;
  let startedCounting = false;
  for (let i = 0; i <= 365; i++) {
    const d = new Date(today.getTime() - i * dayMs).toISOString().slice(0, 10);
    if (dailyMap[d] && dailyMap[d] > 0) {
      startedCounting = true;
      currentStreak++;
    } else if (startedCounting) {
      break;
    }
  }

  usage.innerHTML = `
    <div class="usage-header">
      <span class="usage-title">Token activity</span>
      <div class="usage-view-tabs">
        <button class="usage-tab active" data-view="daily">Daily</button>
        <button class="usage-tab" data-view="weekly">Weekly</button>
        <button class="usage-tab" data-view="cumulative">Cumulative</button>
      </div>
    </div>

    <div class="usage-stats">
      <div class="usage-stat">
        <span class="usage-stat-value">${fmtTokens(totalTokens)}</span>
        <span class="usage-stat-label">Lifetime tokens</span>
      </div>
      <div class="usage-stat">
        <span class="usage-stat-value">${peakDay ? fmtTokens(peakDay.tokens) : '—'}</span>
        <span class="usage-stat-label">Peak tokens</span>
      </div>
      <div class="usage-stat">
        <span class="usage-stat-value">${longestTurn ? fmtDuration(longestTurn.turn_duration_ms) : '—'}</span>
        <span class="usage-stat-label">Longest task</span>
      </div>
      <div class="usage-stat">
        <span class="usage-stat-value">${currentStreak}d</span>
        <span class="usage-stat-label">Current streak</span>
      </div>
      <div class="usage-stat">
        <span class="usage-stat-value">${longestStreak}d</span>
        <span class="usage-stat-label">Longest streak</span>
      </div>
    </div>

    <div class="heatmap-container">
      <svg class="heatmap" width="${gridWidth}" height="${gridHeight + 20}" viewBox="0 0 ${gridWidth} ${gridHeight + 20}">
        ${cellsHTML}
        ${monthLabelsHTML}
      </svg>
      <div class="heatmap-legend">
        <span class="heatmap-legend-label">Less</span>
        <svg width="70" height="11"><rect x="0" width="11" height="11" rx="2" class="heatmap-cell level-0"/><rect x="14" width="11" height="11" rx="2" class="heatmap-cell level-1"/><rect x="28" width="11" height="11" rx="2" class="heatmap-cell level-2"/><rect x="42" width="11" height="11" rx="2" class="heatmap-cell level-3"/><rect x="56" width="11" height="11" rx="2" class="heatmap-cell level-4"/></svg>
        <span class="heatmap-legend-label">More</span>
      </div>
    </div>
    <div class="chart-container" id="usage-chart" style="display:none;"></div>
    <div class="day-sessions" id="day-sessions"></div>
  `;

  // Heatmap tooltip
  const heatmapTooltip = document.createElement('div');
  heatmapTooltip.className = 'chart-tooltip';
  usage.appendChild(heatmapTooltip);
  usage.querySelectorAll('.heatmap-cell[data-label]').forEach(cell => {
    cell.addEventListener('mouseenter', () => {
      heatmapTooltip.textContent = cell.dataset.label;
      heatmapTooltip.classList.add('show');
    });
    cell.addEventListener('mousemove', e => {
      positionTooltip(heatmapTooltip, e.clientX, e.clientY);
    });
    cell.addEventListener('mouseleave', () => heatmapTooltip.classList.remove('show'));
    cell.addEventListener('click', () => {
      usage.querySelectorAll('.heatmap-cell.selected').forEach(c => c.classList.remove('selected'));
      cell.classList.add('selected');
      const date = cell.dataset.label.match(/on (.+)$/)?.[1] || '';
      const dateKey = cell.getAttribute('data-label').split(' tokens')[0]; // not ideal
      // Extract ISO date from cells array by matching position
      const allCells = [...usage.querySelectorAll('.heatmap-cell[data-label]')];
      const idx = allCells.indexOf(cell);
      if (idx >= 0 && idx < cells.length) {
        showDaySessions(cells[idx].key);
      }
    });
  });

  async function showDaySessions(dateKey) {
    const panel = usage.querySelector('#day-sessions');
    if (!panel) return;
    const dayStart = dateKey + 'T00:00:00';
    const dayEnd = dateKey + 'T23:59:59';

    // Find sessions active on this day
    const daySessions = state.sessions.filter(s => {
      if (!s.started_at) return false;
      const end = s.ended_at || s.started_at;
      return s.started_at <= dayEnd && end >= dayStart;
    });

    // Classify each session
    const classified = daySessions.map(s => {
      const isNew = s.started_at.slice(0, 10) === dateKey;
      let kind = 'continued'; // default: session spans this day
      if (isNew) {
        // Check if this project had any session before this one
        const hasEarlierSession = state.sessions.some(
          other => other.project === s.project && other.id !== s.id && other.started_at < s.started_at
        );
        kind = hasEarlierSession ? 'new-session' : 'new-workspace';
      }
      return { ...s, kind };
    });

    if (!classified.length) {
      panel.innerHTML = `<div class="day-sessions-header">${fmtTooltipDate(dateKey)} — no sessions</div>`;
      return;
    }

    // Group by kind for visual hierarchy
    const newWorkspaces = classified.filter(s => s.kind === 'new-workspace');
    const newSessions = classified.filter(s => s.kind === 'new-session');
    const continued = classified.filter(s => s.kind === 'continued');

    let html = `<div class="day-sessions-header">${fmtTooltipDate(dateKey)}</div><div class="day-activity-timeline">`;

    if (newWorkspaces.length) {
      html += `
        <div class="activity-group">
          <div class="activity-group-header">
            <span class="activity-icon workspace">★</span>
            <span class="activity-group-title">Created ${newWorkspaces.length} new workspace${newWorkspaces.length > 1 ? 's' : ''}</span>
          </div>
          <div class="activity-group-items">
            ${newWorkspaces.map(s => `
              <button class="activity-item" data-session-id="${s.id}">
                <span class="activity-item-name"><span class="activity-item-project">${escapeHTML(formatProjectLabel(s.project))}</span> ${escapeHTML(s.title || '(untitled)')}</span>
                <span class="activity-item-meta">${s.message_count || 0} msg</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (newSessions.length) {
      // Group new sessions by project
      const byProject = {};
      for (const s of newSessions) {
        const p = s.project || '(none)';
        if (!byProject[p]) byProject[p] = [];
        byProject[p].push(s);
      }
      html += `
        <div class="activity-group">
          <div class="activity-group-header">
            <span class="activity-icon new">+</span>
            <span class="activity-group-title">Started ${newSessions.length} session${newSessions.length > 1 ? 's' : ''} in ${Object.keys(byProject).length} project${Object.keys(byProject).length > 1 ? 's' : ''}</span>
          </div>
          <div class="activity-group-items">
            ${newSessions.map(s => `
              <button class="activity-item" data-session-id="${s.id}">
                <span class="activity-item-name">${escapeHTML(s.title || '(untitled)')}</span>
                <span class="activity-item-meta">${escapeHTML(formatProjectLabel(s.project))} · ${s.message_count || 0} msg</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (continued.length) {
      html += `
        <div class="activity-group continued">
          <div class="activity-group-header">
            <span class="activity-icon continued">↳</span>
            <span class="activity-group-title">Continued ${continued.length} session${continued.length > 1 ? 's' : ''}</span>
          </div>
          <div class="activity-group-items">
            ${continued.map(s => `
              <button class="activity-item" data-session-id="${s.id}">
                <span class="activity-item-name">${escapeHTML(s.title || '(untitled)')}</span>
                <span class="activity-item-meta">${escapeHTML(formatProjectLabel(s.project))} · ${s.message_count || 0} msg</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }

    html += `</div>`;
    panel.innerHTML = html;
    panel.querySelectorAll('.activity-item').forEach(row => {
      row.addEventListener('click', () => navigateToSession(row.dataset.sessionId));
    });
  }

  // Tab switching
  usage.querySelectorAll('.usage-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      usage.querySelectorAll('.usage-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      const heatmap = usage.querySelector('.heatmap-container');
      const chart = usage.querySelector('#usage-chart');
      if (view === 'daily') {
        heatmap.style.display = ''; chart.style.display = 'none';
      } else {
        heatmap.style.display = 'none'; chart.style.display = '';
        if (view === 'weekly') renderWeeklyChart(chart, daily);
        else renderCumulativeChart(chart, daily);
      }
    });
  });

  // Default: show current month's activity with "show more" for previous months
  let loadedMonths = 0;
  showNextMonth();

  function showNextMonth() {
    const panel = usage.querySelector('#day-sessions');
    if (!panel) return;
    const targetDate = new Date(today.getFullYear(), today.getMonth() - loadedMonths, 1);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth();
    loadedMonths++;

    const monthHTML = buildMonthHTML(year, month);

    // Remove existing "show more" button
    const existing = panel.querySelector('.show-more-btn');
    if (existing) existing.remove();

    panel.insertAdjacentHTML('beforeend', monthHTML);

    // Add "show more" button
    const btn = document.createElement('button');
    btn.className = 'show-more-btn';
    btn.textContent = 'Show more activity';
    btn.addEventListener('click', () => showNextMonth());
    panel.appendChild(btn);

    // Wire up session links
    panel.querySelectorAll('.activity-item:not([data-wired])').forEach(row => {
      row.setAttribute('data-wired', '1');
      row.addEventListener('click', () => navigateToSession(row.dataset.sessionId));
    });
  }

  function buildMonthHTML(year, month) {
    const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const nextMonth = month === 11 ? `${year + 1}-01-01` : `${year}-${String(month + 2).padStart(2, '0')}-01`;
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

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

    const newWorkspaces = classified.filter(s => s.kind === 'new-workspace');
    const newSessions = classified.filter(s => s.kind === 'new-session');
    const continued = classified.filter(s => s.kind === 'continued');

    const headerText = `${monthNames[month]} ${year}`;
    let html = `<div class="day-sessions-header">${headerText}</div><div class="day-activity-timeline">`;

    if (newWorkspaces.length) {
      html += `
        <div class="activity-group">
          <div class="activity-group-header">
            <span class="activity-icon workspace">★</span>
            <span class="activity-group-title">Created ${newWorkspaces.length} new workspace${newWorkspaces.length > 1 ? 's' : ''}</span>
          </div>
          <div class="activity-group-items">
            ${newWorkspaces.map(s => `
              <button class="activity-item" data-session-id="${s.id}">
                <span class="activity-item-name"><span class="activity-item-project">${escapeHTML(formatProjectLabel(s.project))}</span> ${escapeHTML(s.title || '(untitled)')}</span>
                <span class="activity-item-meta">${s.message_count || 0} msg</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (newSessions.length) {
      const byProject = {};
      for (const s of newSessions) { const p = s.project || '(none)'; if (!byProject[p]) byProject[p] = []; byProject[p].push(s); }
      html += `
        <div class="activity-group">
          <div class="activity-group-header">
            <span class="activity-icon new">+</span>
            <span class="activity-group-title">Started ${newSessions.length} session${newSessions.length > 1 ? 's' : ''} in ${Object.keys(byProject).length} project${Object.keys(byProject).length > 1 ? 's' : ''}</span>
          </div>
          <div class="activity-group-items">
            ${newSessions.map(s => `
              <button class="activity-item" data-session-id="${s.id}">
                <span class="activity-item-name">${escapeHTML(s.title || '(untitled)')}</span>
                <span class="activity-item-meta">${escapeHTML(formatProjectLabel(s.project))} · ${s.message_count || 0} msg</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (continued.length) {
      html += `
        <div class="activity-group continued">
          <div class="activity-group-header">
            <span class="activity-icon continued">↳</span>
            <span class="activity-group-title">Continued ${continued.length} session${continued.length > 1 ? 's' : ''}</span>
          </div>
          <div class="activity-group-items">
            ${continued.map(s => `
              <button class="activity-item" data-session-id="${s.id}">
                <span class="activity-item-name">${escapeHTML(s.title || '(untitled)')}</span>
                <span class="activity-item-meta">${escapeHTML(formatProjectLabel(s.project))} · ${s.message_count || 0} msg</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }

    if (!classified.length) html += `<div style="color:var(--muted);font-size:13px;padding:8px 0;">No sessions this month.</div>`;
    html += `</div>`;
    return html;
  }
}

export function renderWeeklyChart(container, daily) {
  // Build 52 weekly buckets aligned to the same time range as the heatmap
  const today = new Date();
  const dayMs = 86400000;
  let startDate = new Date(today.getTime() - 364 * dayMs);
  startDate.setHours(0, 0, 0, 0);
  const daysUntilSunday = (7 - startDate.getDay()) % 7;
  startDate = new Date(startDate.getTime() + daysUntilSunday * dayMs);

  const dailyMap = {};
  for (const d of daily) dailyMap[d.day] = d.tokens;

  // Aggregate into weeks
  const weeks = [];
  for (let w = 0; w < 53; w++) {
    const weekStart = new Date(startDate.getTime() + w * 7 * dayMs);
    if (weekStart > today) break;
    let tokens = 0;
    for (let d = 0; d < 7; d++) {
      const date = new Date(weekStart.getTime() + d * dayMs);
      if (date > today) break;
      const key = date.toISOString().slice(0, 10);
      tokens += dailyMap[key] || 0;
    }
    weeks.push({ weekStart, tokens });
  }

  if (!weeks.length) { container.innerHTML = '<div class="empty">No data</div>'; return; }

  const maxVal = Math.max(...weeks.map(w => w.tokens), 1);
  const barWidth = 10;
  const barGap = 3;
  const chartHeight = 120;
  const chartWidth = weeks.length * (barWidth + barGap);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Month labels
  const labels = [];
  let lastMonth = -1;
  for (let i = 0; i < weeks.length; i++) {
    const m = weeks[i].weekStart.getMonth();
    if (m !== lastMonth) { labels.push({ i, label: months[m] }); lastMonth = m; }
  }

  const barsHTML = weeks.map((w, i) => {
    const h = maxVal > 0 ? (w.tokens / maxVal) * chartHeight : 0;
    const x = i * (barWidth + barGap);
    return `<rect x="${x}" y="${chartHeight - h}" width="${barWidth}" height="${Math.max(h, 0.5)}" rx="2" class="bar-fill" data-label="Week of ${w.weekStart.toISOString().slice(0, 10)}: ${fmtTokens(w.tokens)}"></rect>`;
  }).join('');

  const labelsHTML = labels.map(l => {
    const x = l.i * (barWidth + barGap);
    return `<text x="${x}" y="${chartHeight + 16}" class="heatmap-month">${l.label}</text>`;
  }).join('');

  container.innerHTML = `
    <div class="chart-tooltip" id="chart-tooltip"></div>
    <svg class="weekly-chart" viewBox="0 0 ${chartWidth + 20} ${chartHeight + 24}" preserveAspectRatio="xMidYMid meet">
      ${barsHTML}
      ${labelsHTML}
    </svg>
  `;

  // Tooltip on hover
  const tooltip = container.querySelector('#chart-tooltip');
  container.querySelectorAll('.bar-fill').forEach(bar => {
    bar.addEventListener('mouseenter', e => {
      tooltip.textContent = bar.dataset.label;
      tooltip.classList.add('show');
    });
    bar.addEventListener('mousemove', e => {
      positionTooltip(tooltip, e.clientX, e.clientY);
    });
    bar.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
  });
}

export function renderCumulativeChart(container, daily) {
  const sorted = [...daily].sort((a, b) => a.day.localeCompare(b.day));
  if (!sorted.length) { container.innerHTML = '<div class="empty">No data</div>'; return; }

  let cumulative = 0;
  const points = sorted.map(d => { cumulative += d.tokens; return { day: d.day, total: cumulative }; });
  const maxVal = points[points.length - 1].total;

  const chartWidth = 700;
  const chartHeight = 140;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Scale x by index, y by value
  const xScale = (i) => (i / (points.length - 1)) * chartWidth;
  const yScale = (v) => chartHeight - (v / maxVal) * chartHeight;

  // Build path
  const pathParts = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(p.total).toFixed(1)}`);
  const linePath = pathParts.join(' ');
  const areaPath = linePath + ` L${chartWidth},${chartHeight} L0,${chartHeight} Z`;

  // Month labels
  const labels = [];
  let lastMonth = -1;
  for (let i = 0; i < points.length; i++) {
    const m = new Date(points[i].day).getMonth();
    if (m !== lastMonth) { labels.push({ x: xScale(i), label: months[m] }); lastMonth = m; }
  }
  const labelsHTML = labels.map(l => `<text x="${l.x}" y="${chartHeight + 16}" class="heatmap-month">${l.label}</text>`).join('');

  // Invisible hover dots for tooltip
  const dotsHTML = points.map((p, i) => {
    return `<circle cx="${xScale(i).toFixed(1)}" cy="${yScale(p.total).toFixed(1)}" r="6" class="cumulative-dot" data-label="${p.day}: ${fmtTokens(p.total)} total"/>`;
  }).join('');

  container.innerHTML = `
    <div class="chart-tooltip" id="chart-tooltip-cum"></div>
    <svg viewBox="0 0 ${chartWidth} ${chartHeight + 24}" preserveAspectRatio="xMidYMid meet" class="cumulative-chart">
      <path d="${areaPath}" class="cumulative-area"/>
      <path d="${linePath}" class="cumulative-line"/>
      ${dotsHTML}
      ${labelsHTML}
    </svg>
  `;

  const tooltip = container.querySelector('#chart-tooltip-cum');
  container.querySelectorAll('.cumulative-dot').forEach(dot => {
    dot.addEventListener('mouseenter', e => {
      tooltip.textContent = dot.dataset.label;
      tooltip.classList.add('show');
    });
    dot.addEventListener('mousemove', e => {
      positionTooltip(tooltip, e.clientX, e.clientY);
    });
    dot.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
  });
}
