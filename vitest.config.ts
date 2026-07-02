import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // web/ has its own vitest config (jsdom + vue plugin) and its own `npm test`.
    exclude: ['**/node_modules/**', 'web/**'],
  },
});
