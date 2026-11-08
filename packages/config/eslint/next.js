import base from './base.js';

/**
 * ESLint config extension for the Next.js web app.
 * @type {import('eslint').Linter.Config[]}
 */
export default [
  ...base,
  {
    rules: {
      // The browser app legitimately uses console for client diagnostics in dev.
      'no-console': 'off',
    },
  },
];
