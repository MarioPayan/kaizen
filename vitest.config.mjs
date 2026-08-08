import { defineConfig } from 'vitest/config';

// The engine and the app are separate packages with separate toolchains.
// `npm run check` covers the engine; `npm run app:check` covers the app.
export default defineConfig({
  test: {
    include: ['scripts/tests/**/*.test.mjs'],
    environment: 'node',
  },
});
