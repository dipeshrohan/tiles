import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['js/tiles.bundle.js', 'node_modules/**', 'api/**', 'edge/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['**/*.ts'] })),
  {
    files: ['js/**/*.{js,ts}'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.browser },
  },
  {
    // Native dialogs can't be styled, explained or tested well: use confirmDialog() (js/lib/overlay.ts).
    files: ['js/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['confirm', 'alert', 'prompt'].map((name) => ({
          name,
          message: 'Use confirmDialog() from js/lib/overlay.ts',
        })),
      ],
      'no-restricted-properties': [
        'error',
        ...['confirm', 'alert', 'prompt'].map((property) => ({
          object: 'window',
          property,
          message: 'Use confirmDialog()',
        })),
      ],
    },
  },
  {
    files: ['*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
  },
  {
    // Playwright tests: Node code plus callbacks that run inside the page.
    files: ['e2e/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['**/*.js'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }] } },
];
