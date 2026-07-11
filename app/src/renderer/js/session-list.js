// Session list and detail rendering module.
// Extracted from render.js -- all session/subagent DOM generation.

import { state } from './state.js';
import { loadSessionDetail, loadSubagentDetail, isTextTruncated, loadFullText } from './data.js';
import { escapeHTML, highlightPlain, fmtListTime, fmtRelative, fmtClockTime, renderMarkdown, formatProjectLabel, $ } from './utils.js';
import { FOLDER_SVG } from './state.js';
import registry from './registry.js';

// --- Session list ---

export function renderSessionList() {
  const items = visibleSessions();
  const list = $('#session-list');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<div class="empty">No sessions here.<span class="hint">${state.query ? 'Try a different search term.' : 'Press / to search.'}</span></div>`;
    return;
  }
  list.innerHTML = items.map(s => renderSessionRow(s)).join('');
}

function renderSessionRow(s) {
  const q = state.query.trim();
  const showProjectPrefix = state.projectFilter === 'all';
  const startedTs = new Date(s.started_at || 0).getTime();
  return `
    <div class="srow ${state.cursorId === s.id ? 'cursor' : ''}" data-session-id="${s.id}">
      <div class="srow-body">
        <div class="srow-title">${highlightPlain(s.title || '(untitled)', q)}</div>
        <div class="srow-meta">
          ${showProjectPrefix ? `<span class="project-tag">${escapeHTML(formatProjectLabel(s.project))}</span><span class="dot"></span>` : ''}
          <span>${s.message_count || 0} msg</span>
        </div>
      </div>
      <div class="srow-right">${fmtListTime(startedTs)}</div>
    </div>
  `;
}

// --- Session detail ---

export async function renderSessionDetail() {
  // If viewing a subagent, render that instead
  if (state.subagentId) {
    return renderSubagentDetail();
  }

  const s = state.sessions.find(x => x.id === state.detailId);
  if (!s) return;
  const detail = $('#session-detail');
  if (!detail) return;
  const wrap = $('#session-detail-wrap');

  // If DOM was already built for this session, skip rebuild
  if (detail.dataset.renderedSession === state.detailId) {
    return;
  }

  // Load messages on demand
  if (!s.messages || s.messages.length === 0) {
    const loaded = await loadSessionDetail(s.id);
    if (loaded) Object.assign(s, loaded);
  }

  const startedTs = new Date(s.started_at || 0).getTime();
  const headerHTML = `
    <div class="session-header">
      <div class="session-eyebrow">
        <span class="project-icon">${FOLDER_SVG}</span>
        <span class="project-name">${escapeHTML(formatProjectLabel(s.project))}</span>
        <span class="sep">·</span>
        <span class="project-path">${escapeHTML(s.project_path || '')}</span>
      </div>
      <div class="session-title">${escapeHTML(s.title || '(untitled)')}</div>
      <div class="session-meta-inline">
        <span>${fmtRelative(startedTs)}</span>
        <span class="dot"></span>
        <span>${s.message_count || 0} messages</span>
        ${s.git_branch ? `<span class="dot"></span><span>${escapeHTML(s.git_branch)}</span>` : ''}
      </div>
    </div>
  `;

  const messagesHTML = (s.messages || []).map((msg, idx) => renderMessage(msg, idx)).join('');
  detail.innerHTML = `<div class="session-progress"><div class="session-progress-fill" id="session-progress-fill"></div></div>${headerHTML}<div class="timeline">${messagesHTML}</div>`;
  detail.dataset.renderedSession = state.detailId;

  // Progress bar: track scroll position relative to messages
  const progressFill = detail.querySelector('#session-progress-fill');
  if (wrap && progressFill) {
    const updateProgress = () => {
      const msgs = detail.querySelectorAll('.msg, .wf-card');
      if (!msgs.length) return;
      const wrapTop = wrap.getBoundingClientRect().top;
      let topMsgIdx = 0;
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].getBoundingClientRect().top <= wrapTop + 50) topMsgIdx = i;
        else break;
      }
      const pct = msgs.length <= 1 ? 100 : Math.round((topMsgIdx / (msgs.length - 1)) * 100);
      progressFill.style.width = pct + '%';

      // Show/hide back-to-top button
      const topBtn = detail.querySelector('#back-to-top');
      if (topBtn) topBtn.classList.toggle('show', wrap.scrollTop > 300);
    };
    wrap.addEventListener('scroll', updateProgress);
    updateProgress();
  }

  // Back to top button
  const topBtn = document.createElement('button');
  topBtn.id = 'back-to-top';
  topBtn.className = 'back-to-top';
  topBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12V4M4 7l4-4 4 4"/></svg>`;
  topBtn.addEventListener('click', () => { if (wrap) wrap.scrollTo({ top: 0, behavior: 'smooth' }); });
  detail.appendChild(topBtn);

  // Wire up tool call toggles
  detail.querySelectorAll('.toolcall-toggle').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); btn.closest('.msg-tool').classList.toggle('open'); });
  });
  detail.querySelectorAll('.summary-toggle').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); btn.closest('.msg-summary').classList.toggle('open'); });
  });
  detail.querySelectorAll('.thinking-toggle').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); btn.closest('.msg-thinking').classList.toggle('open'); });
  });
  detail.querySelectorAll('.meta-toggle').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); btn.closest('.msg-meta-collapsed').classList.toggle('open'); });
  });
  detail.querySelectorAll('.truncated-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const uuid = btn.dataset.uuid;
      btn.textContent = 'Loading…';
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
    });
  });

  // Subagent navigation
  detail.querySelectorAll('[data-action="open-subagent"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      registry.navigateToSubagent(btn.dataset.agentId, btn.dataset.agentDesc);
    });
  });

  // Focus on pending message
  if (state.pendingFocusUuid) {
    const targetUuid = state.pendingFocusUuid;
    requestAnimationFrame(() => {
      const target = detail.querySelector(`.msg[data-uuid="${targetUuid}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        requestAnimationFrame(() => {
          target.classList.add('is-focused');
          setTimeout(() => target.classList.remove('is-focused'), 1200);
        });
      }
    });
    state.pendingFocusUuid = null;
  }
}

async function renderSubagentDetail() {
  const detail = $('#subagent-detail');
  if (!detail) return;
  const wrap = $('#subagent-detail-wrap');
  if (wrap) wrap.scrollTop = 0;

  const messages = await loadSubagentDetail(state.subagentId);

  const headerHTML = `
    <div class="session-header">
      <div class="session-eyebrow">
        <span class="meta-label" style="font-size:11px;">SUBAGENT</span>
      </div>
      <div class="session-title">${escapeHTML(state.subagentDescription || state.subagentId)}</div>
      <div class="session-meta-inline">
        <span>${messages.length} messages</span>
      </div>
    </div>
  `;

  const messagesHTML = messages.map((msg, idx) => {
    return renderMessage(msg, idx, { isSubagent: true });
  }).join('');

  detail.innerHTML = `<div class="session-progress"><div class="session-progress-fill" id="session-progress-fill"></div></div>${headerHTML}<div class="timeline">${messagesHTML}</div>`;

  // Wire up toggles
  detail.querySelectorAll('.toolcall-toggle').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); btn.closest('.msg-tool').classList.toggle('open'); });
  });
  detail.querySelectorAll('.summary-toggle').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); btn.closest('.msg-summary').classList.toggle('open'); });
  });
  detail.querySelectorAll('.thinking-toggle').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); btn.closest('.msg-thinking').classList.toggle('open'); });
  });
  detail.querySelectorAll('.meta-toggle').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); btn.closest('.msg-meta-collapsed').classList.toggle('open'); });
  });
  detail.querySelectorAll('.truncated-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const uuid = btn.dataset.uuid;
      btn.textContent = 'Loading…';
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
    });
  });
  // Nested subagent navigation
  detail.querySelectorAll('[data-action="open-subagent"]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      registry.navigateToSubagent(btn.dataset.agentId, btn.dataset.agentDesc);
    });
  });

  // Progress bar
  const progressFill = detail.querySelector('#session-progress-fill');
  if (wrap && progressFill) {
    const updateProgress = () => {
      const msgs = detail.querySelectorAll('.msg');
      if (!msgs.length) return;
      const wrapTop = wrap.getBoundingClientRect().top;
      let topMsgIdx = 0;
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].getBoundingClientRect().top <= wrapTop + 50) topMsgIdx = i;
        else break;
      }
      const pct = msgs.length <= 1 ? 100 : Math.round((topMsgIdx / (msgs.length - 1)) * 100);
      progressFill.style.width = pct + '%';
    };
    wrap.addEventListener('scroll', updateProgress);
    updateProgress();
  }
}

function renderMessage(msg, idx, opts = {}) {
  const isUser = msg.type === 'user';
  const isThinking = msg.content_type === 'thinking';
  const isMeta = msg.is_meta === 1;
  const tools = (msg.tool_calls || []).map(renderToolCall).join('');

  // In subagent context, all user text messages are prompts (from main agent or human)
  let roleLabel = isUser ? 'You' : 'Assistant';
  if (opts.isSubagent && isUser) {
    roleLabel = 'Prompt';
  }

  // Meta messages: collapsed by default, shown as a small system indicator
  if (isMeta) {
    const preview = (msg.text || '').replace(/<[^>]+>/g, '').slice(0, 80);
    const truncated = isTextTruncated(msg.text);
    return `
      <div class="msg meta" data-uuid="${msg.uuid}">
        <div class="msg-meta-collapsed">
          <button class="meta-toggle">
            <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
            <span class="meta-label">System</span>
            <span class="meta-preview">${escapeHTML(preview)}</span>
          </button>
          <div class="meta-body">
            ${renderMarkdown(msg.text, { variant: 'compact', query: state.query })}
            ${truncated ? `<button class="truncated-btn" data-action="load-full" data-uuid="${msg.uuid}">Message truncated — click to load full text</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  // Workflow as standalone card (not inside assistant bubble)
  const workflowCall = (msg.tool_calls || []).find(tc => tc.name === 'Workflow' && tc.workflow);
  if (workflowCall && !isUser) {
    const wf = workflowCall.workflow;
    const wfName = wf.workflow_name || 'Workflow';
    const agents = wf.agents || [];

    const phases = {};
    for (const a of agents) {
      const phase = a.phase || 'Other';
      if (!phases[phase]) phases[phase] = [];
      phases[phase].push(a);
    }

    const phasesHTML = Object.entries(phases).map(([phase, agentList]) => `
      <div class="wf-card-phase">
        <div class="wf-card-phase-title">${escapeHTML(phase)}</div>
        ${agentList.map(a => `
          <button class="wf-card-agent" data-action="open-subagent" data-agent-id="${a.agent_id}" data-agent-desc="${escapeHTML(a.label || '')}">
            <span class="wf-card-agent-label">${escapeHTML(a.label || a.agent_id)}</span>
            ${a.state === 'error' ? `<span class="wf-card-agent-state error">error</span>` : ''}
            <span class="wf-card-agent-arrow">→</span>
          </button>
        `).join('')}
      </div>
    `).join('');

    // Render other tool calls (non-workflow) if any
    const otherTools = (msg.tool_calls || []).filter(tc => tc !== workflowCall).map(renderToolCall).join('');

    return `
      <div class="wf-card" data-uuid="${msg.uuid}">
        <div class="wf-card-header">
          <span class="wf-card-icon">⚙</span>
          <span class="wf-card-name">${escapeHTML(wfName)}</span>
          <span class="wf-card-count">${agents.length} agents</span>
          ${wf.status ? `<span class="wf-card-status ${wf.status}">${escapeHTML(wf.status)}</span>` : ''}
        </div>
        <div class="wf-card-body">${phasesHTML}</div>
      </div>
      ${otherTools ? `<div class="msg assistant" data-uuid="${msg.uuid}-tools"><div class="msg-tools">${otherTools}</div></div>` : ''}
    `;
  }

  // Standalone thinking message (no following assistant to attach to)
  if (isThinking) {
    return `
      <div class="msg assistant" data-uuid="${msg.uuid}">
        <div class="msg-thinking">
          <button class="thinking-toggle">
            <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
            <span class="thinking-label">Thinking</span>
          </button>
          <div class="thinking-body">${renderMarkdown(msg.text, { variant: 'msg', query: state.query })}</div>
        </div>
      </div>
    `;
  }

  // Thinking block attached to this message (merged from preceding thinking messages)
  let thinkingHTML = '';
  if (msg._thinking) {
    thinkingHTML = `
      <div class="msg-thinking">
        <button class="thinking-toggle">
          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
          <span class="thinking-label">Thinking</span>
        </button>
        <div class="thinking-body">${renderMarkdown(msg._thinking, { variant: 'msg', query: state.query })}</div>
      </div>
    `;
  }

  const truncated = isTextTruncated(msg.text);
  let textHTML = msg.text ? renderMarkdown(msg.text, { variant: 'msg', query: state.query }) : (tools ? '' : '<div class="msg-text empty-text">(no text content)</div>');
  if (truncated) {
    textHTML += `<button class="truncated-btn" data-action="load-full" data-uuid="${msg.uuid}">Message truncated — click to load full text</button>`;
  }

  let summaryHTML = '';
  if (msg.summary) {
    summaryHTML = `
      <div class="msg-summary">
        <button class="summary-toggle">
          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
          <span class="label">Session summary</span>
          <span class="source">${escapeHTML(msg.summary.source || '')}</span>
        </button>
        <div class="summary-body">${renderMarkdown(msg.summary.content, { variant: 'compact' })}</div>
      </div>
    `;
  }

  return `
    <div class="msg ${isUser ? 'user' : 'assistant'}" data-uuid="${msg.uuid}">
      <div class="msg-head">
        <span class="role">${roleLabel}</span>
        <span class="when">${msg.timestamp ? fmtClockTime(msg.timestamp) : ''}</span>
      </div>
      ${thinkingHTML}
      ${textHTML}
      ${tools ? `<div class="msg-tools">${tools}</div>` : ''}
      ${summaryHTML}
    </div>
  `;
}

function renderToolCall(tc) {
  const isError = tc.result && tc.result.is_error;

  // Special rendering for Agent/Task tool calls (subagents)
  if (tc.name === 'Agent' || tc.name === 'Task') {
    let parsed = {};
    try { parsed = JSON.parse(tc.input_json || '{}'); } catch {}
    const agentType = parsed.subagent_type || parsed.agentType || 'Agent';
    const description = parsed.description || parsed.prompt?.slice(0, 80) || '';
    const resultContent = tc.result?.content || '';
    const subagentId = tc.subagent?.agent_id || null;

    return `
      <div class="msg-tool agent-call">
        <button class="toolcall-toggle">
          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
          <span class="tool-name">${escapeHTML(agentType)}</span>
          <span class="tool-arg">${escapeHTML(description)}</span>
          ${isError ? '<span class="tool-error">error</span>' : ''}
          ${subagentId ? `<button class="agent-nav-btn" data-action="open-subagent" data-agent-id="${subagentId}" data-agent-desc="${escapeHTML(description)}">View conversation →</button>` : ''}
        </button>
        <div class="toolcall-body">
          ${parsed.prompt ? `<div class="tc-section">Prompt</div><div class="agent-prompt">${escapeHTML(parsed.prompt.slice(0, 500))}${parsed.prompt.length > 500 ? '…' : ''}</div>` : ''}
          ${resultContent ? `<div class="tc-section">Result</div><div class="agent-result">${renderMarkdown(resultContent, { variant: 'compact' })}</div>` : ''}
        </div>
      </div>
    `;
  }

  // Special rendering for Workflow tool calls
  if (tc.name === 'Workflow') {
    let parsed = {};
    try { parsed = JSON.parse(tc.input_json || '{}'); } catch {}
    const wf = tc.workflow;
    const wfName = wf?.workflow_name || parsed.name || 'Workflow';
    const wfStatus = wf?.status || '';
    const agents = wf?.agents || [];

    // Group agents by phase
    const phases = {};
    for (const a of agents) {
      const phase = a.phase || 'Other';
      if (!phases[phase]) phases[phase] = [];
      phases[phase].push(a);
    }

    const phasesHTML = Object.entries(phases).map(([phase, agentList]) => `
      <div class="workflow-phase-group">
        <div class="workflow-phase-header">${escapeHTML(phase)}</div>
        <div class="workflow-phase-agents">
          ${agentList.map(a => `
            <button class="workflow-agent-row" data-action="open-subagent" data-agent-id="${a.agent_id}" data-agent-desc="${escapeHTML(a.label || '')}">
              <span class="workflow-agent-label">${escapeHTML(a.label || a.agent_id)}</span>
              <span class="workflow-agent-state ${a.state || ''}">${escapeHTML(a.state || '')}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `).join('');

    const agentListHTML = agents.length ? `
      <div class="tc-section">Agents · ${agents.length}</div>
      <div class="workflow-agent-list">${phasesHTML}</div>
    ` : '';

    return `
      <div class="msg-tool agent-call">
        <button class="toolcall-toggle">
          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
          <span class="tool-name">Workflow</span>
          <span class="tool-arg">${escapeHTML(wfName)}</span>
          ${wfStatus ? `<span class="workflow-status ${wfStatus}">${escapeHTML(wfStatus)}</span>` : ''}
          ${isError ? '<span class="tool-error">error</span>' : ''}
        </button>
        <div class="toolcall-body">
          ${agentListHTML}
        </div>
      </div>
    `;
  }

  let argPreview = '';
  try {
    const j = JSON.parse(tc.input_json || '{}');
    if (j.file_path) argPreview = j.file_path;
    else if (j.command) argPreview = j.command;
    else if (j.path) argPreview = j.path;
    else if (j.description) argPreview = j.description;
    else argPreview = JSON.stringify(j).slice(0, 100);
  } catch { argPreview = (tc.input_json || '').slice(0, 100); }

  return `
    <div class="msg-tool ${isError ? 'is-error' : ''}">
      <button class="toolcall-toggle">
        <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
        <span class="tool-name">${escapeHTML(tc.name)}</span>
        <span class="tool-arg">${escapeHTML(argPreview)}</span>
        ${isError ? '<span class="tool-error">error</span>' : ''}
      </button>
      <div class="toolcall-body">
        <div class="tc-section">Input</div>
        <pre>${escapeHTML(tc.input_json || '')}</pre>
        ${tc.result ? `<div class="tc-section">${isError ? 'Error' : 'Output'}</div><pre>${escapeHTML(tc.result.content || '(empty)')}</pre>` : ''}
      </div>
    </div>
  `;
}

// --- Private helper: visibleSessions (same logic as render.js) ---

function visibleSessions() {
  const q = state.query.trim().toLowerCase();
  return state.sessions
    .filter(s => state.projectFilter === 'all' || s.project === state.projectFilter)
    .map(s => {
      if (!q) return { ...s, messageHit: null };
      const topMatch = (s.title || '').toLowerCase().includes(q) ||
                       (s.project || '').toLowerCase().includes(q) ||
                       (s.git_branch || '').toLowerCase().includes(q);
      if (topMatch) return { ...s, messageHit: null };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ta = new Date(a.started_at || 0).getTime();
      const tb = new Date(b.started_at || 0).getTime();
      return state.sortDesc ? tb - ta : ta - tb;
    });
}
