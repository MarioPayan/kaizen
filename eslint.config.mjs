import js from '@eslint/js';

// Plain Node ESM throughout.
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/target/**'] },
  js.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'packages/core/**/*.mjs'],
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
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
];
