import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: false },
  // Workspace packages ship TypeScript source; Vite compiles them like app code
  // rather than pre-bundling, so a change in @kaizen/ui hot-reloads here.
  optimizeDeps: { exclude: ['@kaizen/ui', '@kaizen/data'] },
  server: {
    port: 7778,
    proxy: { '/api': 'http://127.0.0.1:7777' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
