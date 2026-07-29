import { SESSION_IMAGE_TAG } from './session-image-element.js';

const SAFE_IMAGE_PROTOCOLS = new Set(['blob:', 'file:', 'http:', 'https:']);
let configuredMarked = null;

function decodeMarkedAttribute(value) {
  const decoder = document.createElement('textarea');
  decoder.innerHTML = String(value ?? '');
  return decoder.value;
}

function isSafeImageSource(source) {
  try {
    const url = new URL(source, document.baseURI);
    return SAFE_IMAGE_PROTOCOLS.has(url.protocol)
      || (url.protocol === 'data:' && /^data:image\//i.test(source));
  } catch {
    return false;
  }
}

function imageFallback(alt) {
  const fallback = document.createElement('span');
  fallback.className = 'session-image-fallback';
  fallback.textContent = alt || 'Image unavailable';
  return fallback.outerHTML;
}

export function renderSessionMarkdownImage(href, title, text) {
  const source = decodeMarkedAttribute(href).trim();
  const alt = decodeMarkedAttribute(text);
  const accessibleTitle = decodeMarkedAttribute(title);
  if (!source || !isSafeImageSource(source)) return imageFallback(alt);

  const image = document.createElement(SESSION_IMAGE_TAG);
  image.setAttribute('src', source);
  image.setAttribute('alt', alt);
  if (accessibleTitle) image.setAttribute('title', accessibleTitle);
  return image.outerHTML;
}

export function configureMarkdownImages(marked) {
  if (!marked || configuredMarked === marked) return;
  marked.use({
    renderer: {
      image: renderSessionMarkdownImage,
    },
  });
  configuredMarked = marked;
}
