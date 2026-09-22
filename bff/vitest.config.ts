import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['../tests/bff/**/*.test.ts', '../tests/contract/**/*.test.ts'],
    environment: 'node',
  },
});
