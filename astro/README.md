# rhyolite-MELTS Tracker — Astro port

Same applet, two deploy modes from one source tree:

| Mode    | Command               | Output                | Use case                          |
|---------|-----------------------|-----------------------|-----------------------------------|
| Static  | `npm run build`       | `dist/` (plain files) | file:// usage, GitHub Pages, etc. |
| Vercel  | `npm run build:vercel`| `.vercel/output/`     | Vercel deploy with cloud sync     |

`localStorage` is always the local source of truth. The Vercel build
adds opt-in **manual** cloud sync (Pull / Push / History buttons) backed
by Supabase Postgres. file:// builds skip the cloud entirely.

## Layout

    astro/
    ├── astro.config.mjs        hybrid output when DEPLOY_TARGET=vercel
    ├── docs/supabase-schema.sql  run once in Supabase SQL editor
    ├── public/
    │   ├── legacy.js           original applet (classic script)
    │   └── cloudSync.js        client-side cloud adapter
    └── src/
        ├── pages/index.astro   composed shell
        ├── components/…        26 extracted .astro components
        ├── api/                SSR endpoints (injected only on Vercel build)
        │   ├── auth.js                POST /api/auth   { token }
        │   ├── snapshot.js            GET, PUT /api/snapshot
        │   └── snapshot/
        │       ├── history.js         GET /api/snapshot/history
        │       └── restore.js         POST /api/snapshot/restore { id }
        ├── lib/
        │   ├── supabase.js     server-only Supabase client (service_role)
        │   └── admin.js        admin cookie + constant-time token check
        ├── styles/global.css
        └── tests/              vitest + jsdom (14 tests)

## Deploying to Vercel

1. **Create a Supabase project** → SQL editor → paste `docs/supabase-schema.sql` → run.
2. **Grab credentials** from Supabase settings:
   - Project URL → `SUPABASE_URL`
   - `service_role` key (secret) → `SUPABASE_SERVICE_ROLE_KEY`
3. **Generate an admin token** locally:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   This is your `ADMIN_TOKEN`. Treat it like a password.
4. **In Vercel**: project → Settings → Environment Variables. Add all three
   above, plus `DEPLOY_TARGET=vercel`. Set the project's Root Directory to
   `astro/`.
5. **Push** — Vercel runs `npm run build:vercel` (or set Build Command
   manually if needed). The static shell is prerendered; the `/api/*`
   routes run as serverless functions.

## Admin access

Open `https://<your-app>.vercel.app/?admin=<ADMIN_TOKEN>` once. The token
is exchanged for an httpOnly cookie and stripped from the URL. The
`☁ Push` and `⏱ History` buttons appear in the util bar. Public visitors
see only `☁ Pull` (read-only).

To revoke a device: `DELETE /api/auth` (or clear cookies). To revoke
globally: rotate `ADMIN_TOKEN` in Vercel.

## Sync model

- **Pull** (anyone): replaces local state with the cloud snapshot. Goes
  through `migrate()` for schema safety, then triggers a full render.
- **Push** (admin only): uploads the current `S` blob. The previous
  cloud row is auto-archived to `snapshot_history` via SQL trigger.
- **History** (admin only): lists recent archived rows and lets you
  restore one. Restore also archives the row it replaces — fully reversible.

No automatic background sync. You decide when local edits become public.

## Tests

    npm test
