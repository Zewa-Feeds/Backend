/**
 * Test runner.
 *
 * The resolver is pure — it takes rows and returns a gallery — so it needs no
 * database, no network and no fixtures beyond plain objects. That is deliberate:
 * the rules that decide what a customer sees should be cheap enough to test
 * exhaustively.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
