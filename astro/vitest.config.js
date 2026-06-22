import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        // Required so dynamically-appended <script> tags actually execute.
        runScripts: 'dangerously',
        resources: 'usable',
      },
    },
    include: ['tests/**/*.test.js'],
  },
});
