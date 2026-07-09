import path from 'node:path';

function cleanRecapFilename(filename) {
  if (!filename) return '';
  return path.basename(String(filename));
}

function buildRecapExportQuery({ cardIdx = 0, archetype = '', filename = '' } = {}) {
  const params = new URLSearchParams();
  const cardNumber = Number(cardIdx);
  params.set('card', Number.isFinite(cardNumber) ? String(cardNumber) : '0');
  if (archetype) params.set('arch', String(archetype));
  const safeFilename = cleanRecapFilename(filename);
  if (safeFilename) params.set('file', safeFilename);
  return params.toString();
}

export { buildRecapExportQuery, cleanRecapFilename };
