import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['js/tiles.bundle.js', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.browser },
  },
  {
    files: ['*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
  },
  {
    // Playwright tests: Node code plus callbacks that run inside the page.
    files: ['e2e/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
