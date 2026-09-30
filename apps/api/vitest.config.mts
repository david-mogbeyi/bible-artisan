import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC (not esbuild) so Nest's decorator metadata / constructor injection works in tests.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.int-spec.ts'],
          globalSetup: ['test/global-setup.ts'],
          // One real database: run files serially so tests can truncate safely.
          fileParallelism: false,
        },
      },
    ],
  },
});
