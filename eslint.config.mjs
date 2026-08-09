import js from '@eslint/js';

// Plain Node ESM throughout. The TypeScript and React blocks that used to live
// here went with the web app — the only front end now is the Rust TUI, which
// cargo clippy covers.
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/target/**'] },
  js.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'packages/core/**/*.mjs', 'packages/server/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Buffer: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
];
