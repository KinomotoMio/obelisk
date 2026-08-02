import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMarkdownImageToken } from '../app/src/renderer/src/markdown-image-renderer.js';

// marked <= 14 calls renderer.image(href, title, text); marked >= 15 passes the
// token. Getting this wrong degrades silently: every session image turns into
// fallback text because the href is no longer a string.
test('accepts the positional renderer signature', () => {
  assert.deepEqual(
    normalizeMarkdownImageToken('http://example.test/a.png', 'A title', 'Alt text'),
    { href: 'http://example.test/a.png', title: 'A title', text: 'Alt text' },
  );
});

test('accepts the token renderer signature', () => {
  assert.deepEqual(
    normalizeMarkdownImageToken({
      type: 'image',
      href: 'http://example.test/a.png',
      title: 'A title',
      text: 'Alt text',
    }),
    { href: 'http://example.test/a.png', title: 'A title', text: 'Alt text' },
  );
});

test('fills in the fields marked leaves null', () => {
  assert.deepEqual(
    normalizeMarkdownImageToken({ href: 'http://example.test/a.png', title: null, text: '' }),
    { href: 'http://example.test/a.png', title: '', text: '' },
  );
  assert.deepEqual(
    normalizeMarkdownImageToken('http://example.test/a.png', null, null),
    { href: 'http://example.test/a.png', title: '', text: '' },
  );
});
