import { defineConfig } from 'astro/config';

// Phase 1: static parity build of the original single-file applet.
// Output is a folder of plain files so file:// usage still works.
export default defineConfig({
  output: 'static',
  build: { format: 'file' },
  compressHTML: false,
});
