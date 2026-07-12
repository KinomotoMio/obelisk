export function activitySourceKey(session) {
  const source = typeof session?.source === 'string' ? session.source.trim().toLowerCase() : '';
  return source || 'claude';
}

export function activitySourceLabel(session) {
  const source = activitySourceKey(session);
  if (source === 'codex') return 'Codex';
  if (source === 'claude') return 'Claude Code';
  return source.charAt(0).toUpperCase() + source.slice(1);
}

export function activityGroupSessions(split) {
  return [...(split?.normal || []), ...(split?.noise || [])];
}

export function activityGroupHasMixedSources(split) {
  return new Set(activityGroupSessions(split).map(activitySourceKey)).size > 1;
}

export function activitySessionMetaParts(session, {
  mixedSources = false,
  projectLabel = '',
  includeProject = true,
} = {}) {
  const parts = [];
  if (mixedSources) parts.push({ kind: 'source', text: activitySourceLabel(session) });
  if (includeProject && projectLabel) parts.push({ kind: 'project', text: projectLabel });
  parts.push({
    kind: 'count',
    text: `${Number(session?.message_count || 0).toLocaleString('en-US')} msg`,
  });
  return parts;
}
