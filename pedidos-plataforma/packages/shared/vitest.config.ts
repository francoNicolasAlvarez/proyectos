import { defineConfig } from 'vitest/config';

// Config propia para que Vitest no busque un vite.config.js en carpetas superiores.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
