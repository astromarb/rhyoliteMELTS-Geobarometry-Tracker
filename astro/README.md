# rhyolite-MELTS Tracker — Astro port (Phase 1)

Phase 1 goal: build the existing single-file applet through Astro **without
behavioural changes**, so later phases can split components, types, and
styles safely.

## Layout

    astro/
    ├── astro.config.mjs       static output, file routing, no HTML minify
    ├── package.json           astro dev/build/preview/check
    ├── tsconfig.json
    ├── public/
    │   └── legacy.js          original inline <script> (verbatim)
    └── src/
        ├── _body.html         original <body> contents (verbatim, raw import)
        ├── pages/index.astro  head + Fragment set:html={body} + <script src>
        └── styles/global.css  original <style> contents (verbatim)

`index.html` at the repo root is unchanged —
the Astro build is opt-in via `npm install && npm run build` inside this
folder. Output lands in `astro/dist/` as plain files (file:// still works).

## Next phases

2. Split each modal and `.page` div out of `_body.html` into `.astro` components.
3. Move `style="…"` attributes from JS templates into CSS classes; drop
   `'unsafe-inline'` for styles in the CSP meta.
4. Split `legacy.js` into modules (`state`, `persistence`, `render/*`, `actions`);
   convert to TS; replace `onclick="fn()"` with a delegated handler.
5. Apply the perf items from the review (debounced save, memoised renders,
   id-keyed Maps, configurable export DPR, schema-version short-circuit).
