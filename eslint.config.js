// Flat ESLint config for the Obelisk root (Core + skill runtime + tests).
// Scope: the ESM sources under scripts/ and tests/. The Electron app has its own
// package and toolchain and is intentionally excluded (see docs/adr/0003).
// typescript-eslint is deferred to Phase 4, when the first .ts files land.

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'app/**',
      'dist/**',
      'release/**',
      '.dev.docs/**',
      '.obelisk/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Empty catch is an intentional pattern here (best-effort JSON.parse etc.).
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
