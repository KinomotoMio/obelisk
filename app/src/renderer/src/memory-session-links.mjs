const OBELISK_PROTOCOL = 'obelisk:';
const SESSION_HOST = 'session';

function isObeliskHref(href) {
  return typeof href === 'string' && href.trim().toLowerCase().startsWith(OBELISK_PROTOCOL);
}

export function parseObeliskSessionHref(href) {
  if (typeof href !== 'string' || !href.trim()) return null;

  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (
    url.protocol !== OBELISK_PROTOCOL
    || url.hostname !== SESSION_HOST
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
  ) {
    return null;
  }

  const encodedId = url.pathname.slice(1);
  if (!encodedId || encodedId.includes('/')) return null;

  try {
    const sessionId = decodeURIComponent(encodedId);
    if (!sessionId || sessionId.trim() !== sessionId || sessionId.includes('/')) return null;
    return sessionId;
  } catch {
    return null;
  }
}

export function collectObeliskSessionIds(root) {
  if (!root?.querySelectorAll) return [];
  const ids = new Set();
  for (const link of root.querySelectorAll('a[href]')) {
    const sessionId = parseObeliskSessionHref(link.getAttribute('href'));
    if (sessionId) ids.add(sessionId);
  }
  return [...ids];
}

function replaceWithReadableText(link) {
  const replacement = link.ownerDocument.createElement('span');
  replacement.className = 'markdown-session-reference-unavailable';
  while (link.firstChild) replacement.append(link.firstChild);
  link.replaceWith(replacement);
}

function sessionIcon(document) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const frame = document.createElementNS(namespace, 'path');
  frame.setAttribute('d', 'M3 4h10v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4z');
  const lines = document.createElementNS(namespace, 'path');
  lines.setAttribute('d', 'M5.5 7h5M5.5 9.5h3');
  lines.setAttribute('stroke-linecap', 'round');
  svg.append(frame, lines);
  return svg;
}

export function decorateObeliskSessionLinks(root, sessionsById) {
  if (!root?.querySelectorAll) return;
  const resolved = sessionsById instanceof Map ? sessionsById : new Map();

  for (const link of root.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (!isObeliskHref(href)) continue;

    const sessionId = parseObeliskSessionHref(href);
    const session = sessionId ? resolved.get(sessionId) : null;
    if (!sessionId || !session) {
      replaceWithReadableText(link);
      continue;
    }

    link.classList.add('session-link', 'markdown-session-link');
    link.dataset.obeliskSessionId = sessionId;
    link.title = session.title ? `Open session: ${session.title}` : `Open session: ${sessionId}`;
    link.prepend(sessionIcon(link.ownerDocument));
  }
}
