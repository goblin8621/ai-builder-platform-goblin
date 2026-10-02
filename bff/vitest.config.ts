import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['../tests/bff/**/*.test.ts', '../tests/contract/**/*.test.ts', '../tests/e2e/**/*.test.ts'],
    environment: 'node',
    // Tests create real Skills/Documents/Workspaces as fixtures and mostly
    // don't clean up after themselves — pointed at the same DB the Web UI
    // uses, repeated `npm test` runs silently filled "My Skills" with
    // dozens of dummy entries. A dedicated test database keeps every test
    // fixture fully isolated from whatever the user is actually building
    // in the Playground. Set up once via:
    //   CREATE DATABASE ai_builder_platform_test;  + run db/migrations/*.sql + db/seeds/*.sql against it
    // An explicit DATABASE_URL in the real shell environment still wins —
    // this only fills in a default for a plain `npm test`.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://ai_builder:ai_builder@localhost:5477/ai_builder_platform_test',
    },
  },
});
