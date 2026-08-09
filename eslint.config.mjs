import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';

export default ts.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,

  // The engine and server are plain Node ESM.
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

  // The browser packages are TypeScript.
  ...ts.configs.recommended.map((c) => ({ ...c, files: ['packages/{ui,data,app}/**/*.{ts,tsx}'] })),
  {
    files: ['packages/{ui,data,app}/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // TypeScript resolves identifiers itself; the lint rule only duplicates it
      // and needs a hand-maintained list of every browser global in use.
      'no-undef': 'off',
    },
  },

  // "The app never touches Base UI directly" was prose with nothing behind it.
  // The whole thesis of this project is that a rule which keeps needing to be
  // remembered belongs in a check instead, so here it is as one.
  {
    files: ['packages/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@base-ui/react', '@base-ui/react/*'],
              message: 'Wrap it in @kaizen/ui first — the app composes the design system, not Base UI.',
            },
          ],
        },
      ],
    },
  },
);
