import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel/serverless';
import { fileURLToPath } from 'node:url';

// Two deploy modes from the same source tree:
//   • Default  (npm run build)         → fully static, file://-compatible.
//   • Vercel   (DEPLOY_TARGET=vercel)  → hybrid: static shell + SSR /api/*.
// API route source lives in src/api/ (outside src/pages/), so the static
// build never sees it; the Vercel integration injects routes explicitly.
const isVercel = process.env.DEPLOY_TARGET === 'vercel';

const url = (p) => fileURLToPath(new URL(p, import.meta.url));

const injectApi = {
  name: 'inject-api-on-vercel',
  hooks: {
    'astro:config:setup': ({ injectRoute }) => {
      if (!isVercel) return;
      injectRoute({ pattern: '/api/auth',              entrypoint: url('./src/api/auth.js') });
      injectRoute({ pattern: '/api/snapshot',          entrypoint: url('./src/api/snapshot.js') });
      injectRoute({ pattern: '/api/snapshot/history',  entrypoint: url('./src/api/snapshot/history.js') });
      injectRoute({ pattern: '/api/snapshot/restore',  entrypoint: url('./src/api/snapshot/restore.js') });
    },
  },
};

export default defineConfig({
  output: isVercel ? 'hybrid' : 'static',
  adapter: isVercel ? vercel() : undefined,
  integrations: [injectApi],
  build: { format: 'file' },
  compressHTML: false,
});
