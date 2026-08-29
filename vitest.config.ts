import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Local repair acceptance creates isolated repository copies. Their tests
    // are not additional test suites and must not inflate the reported count.
    exclude: [...configDefaults.exclude, '**/.local/**', '**/.next/**'],
  },
});
