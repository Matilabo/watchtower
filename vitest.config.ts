import { defineConfig } from 'vitest/config';

/**
 * The domain layer is deliberately free of Angular imports, so its tests need
 * no browser, no TestBed and no zone.js -- plain node is enough and fast.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/app/domain/**/*.spec.ts', 'src/app/data/**/*.spec.ts', 'src/app/ui/palette.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/app/domain/**/*.ts', 'src/app/data/**/*.ts'],
      exclude: ['**/*.spec.ts', 'src/app/data/fixtures/**'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
