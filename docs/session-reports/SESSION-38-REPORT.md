# SESSION 38 — M8.2 GUI Architectural Refactor + Port Reclamation

**Date:** 2026-05-19
**Branch:** main
**Result:** ✅ M8.2 refactor lands · ✅ 246/246 tests pass · ✅ Dist-mode smoke 7/7 · ✅ GLOBAL pattern minted · ✅ Orphan node process reclaimed :7788

---

## 1. Mission

Session 36 shipped the M8.1 Knowledge Graph + Command Center as a single 26.6 KB `DASHBOARD_HTML` string in `src/gui/static.ts`. That worked for the spike but couldn't survive a real visual-design iteration — every CSS tweak inflated the diff, the syntax highlighter gave up around line 200, and there was no way to ship per-asset Content-Type or CSP reasoning.

Session 38's mandate (per the `/goal` command): refactor the GUI server to serve modular static files (`index.html`, `style.css`, `app.js`) from `src/gui/public/` — the operator had already authored the three files in place and instructed me NOT to overwrite them. Exit criteria:

1. Server correctly serves the modular files on localhost.
2. 241+ tests pass.
3. Build pipeline works end-to-end.
4. Zero external GUI dependencies introduced.

A follow-on wrap-up `/goal` extended scope to: kill the orphan node process holding `:7788`, mint a GLOBAL pattern via Sovereign Scout consent, commit, run living-docs sync, and author this report.

---

## 2. The Refactor

### Server (`src/gui/server.ts`)

**Removed:**
- `import { DASHBOARD_HTML } from "./static.js"` — the 703-line monolith.
- `sendHtml` helper (single caller, now redundant).

**Added:**
- Module-load resolution of the asset root:
  ```ts
  const PUBLIC_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "public",
  );
  ```
  Same logical path resolves to `src/gui/public/` in tsx-dev mode (`npm run gui`) AND `dist/gui/public/` in built mode (`node dist/gui/server.js`). No `process.cwd()`, no `__dirname` shim, no CommonJS bridge.
- 16-entry `MIME_TYPES` record: html, css, js, mjs, json, svg, png, jpg, jpeg, gif, ico, webp, woff, woff2, map, txt → explicit; everything else → `application/octet-stream`.
- `serveStatic(res, reqPath)`:
  - URI-decode (so percent-encoded URLs still resolve).
  - Strip leading slashes; `/` → `index.html`.
  - Resolve under `PUBLIC_DIR`, then check containment via `path.relative(PUBLIC_DIR, abs).startsWith("..")` — catches `%2E%2E%2F` traversal that prefix checks miss.
  - `readFile`, set Content-Type from MIME map, set Content-Length.
  - `ENOENT` / `EISDIR` → JSON 404; other errors re-throw to the outer 500 handler.
- Static fall-through: any GET that didn't match an `/api/*` route is attempted as a file.

**Changed:**
- CSP relaxed for the Google Fonts CDN the operator's `index.html` references:
  - `style-src` adds `https://fonts.googleapis.com`
  - new `font-src 'self' https://fonts.gstatic.com`
  - everything else stays `'self'`.
- Token-auth predicate scope: `path !== "/" && path !== "/api/health"` → `path.startsWith("/api/") && path !== "/api/health"`. Static assets stay open regardless of token configuration — browsers can't attach a custom header to a `<link rel=stylesheet>` request, so guarding them with a token would block the dashboard from loading.

### Build pipeline (`package.json` + new `scripts/copy-gui-public.ts`)

`tsc` does not copy non-`.ts` files. Added an explicit copy step:

```json
"copy:gui": "tsx scripts/copy-gui-public.ts",
"build":    "npm run lint:boundaries && tsc && npm run copy:gui"
```

`scripts/copy-gui-public.ts` (40 lines, zero deps):
- Resolves repo root relative to the script via `fileURLToPath(import.meta.url)`.
- `fs.rmSync(dest, { recursive: true, force: true })` then `fs.cpSync(src, dest, { recursive: true, force: true })` — Node-built-in (>=16.7), no `cpx` / `cpy` / `fs-extra`.
- Idempotent; reports file count.

### Tests (`tests/gui.test.ts` + `tests/gui-graph.test.ts`)

- Dropped dead `SOVEREIGN COMMAND CENTER` assertion (string no longer in the new HTML) — replaced with `<title>Smart Claude Memory`.
- Added 5 new tests in `gui.test.ts`:
  1. `GET /style.css` → 200 + `text/css` + non-empty body.
  2. `GET /app.js` → 200 + `application/javascript` + non-empty body.
  3. `GET /missing-asset.png` → 404 + `{ ok: false, reason: "not_found" }`.
  4. `GET /%2E%2E%2Fpackage.json` → 404 (URL-encoded `../` traversal blocked).
  5. Token-auth contract: static assets remain accessible with token configured.
- Retargeted the `DASHBOARD_HTML contains graph panel hooks` assertion in `gui-graph.test.ts` at `public/index.html` + `public/app.js`.

### Deletions

- `src/gui/static.ts` — the 703-line DASHBOARD_HTML monolith.
- `dist/gui/static.js`, `dist/gui/static.js.map` — stale build artefacts.

---

## 3. Verification

### Tests

```
ℹ tests 246
ℹ suites 63
ℹ pass 246
ℹ fail 0
ℹ duration_ms 34488.7
```

Exit criterion (241+): **exceeded by 5** — the five new static-serve tests landed.

### Build

```
[lint-boundaries] OK — scanned 6 file(s) under src/sleep, src/curriculum, src/graduation.
                  Boundary Invariant #1 holds (no LLM imports, no LLM endpoints).
[tsc]             clean (no diagnostics)
[copy-gui-public] 3 file(s) → dist\gui\public
```

### Smoke (dist-mode, against `dist/gui/server.js`)

| Probe | Status | Content-Type | Bytes |
|---|---|---|---|
| `/` | 200 | `text/html; charset=utf-8` | 12,446 |
| `/style.css` | 200 | `text/css; charset=utf-8` | 48,680 |
| `/app.js` | 200 | `application/javascript; charset=utf-8` | 40,868 |
| `/api/health` | 200 | `application/json; charset=utf-8` | 49 |
| `/missing-asset.png` | 404 | `application/json` | — |
| `/%2E%2E%2Fpackage.json` | 404 | `application/json` | — |
| CSP allows `fonts.googleapis.com` + `fonts.gstatic.com` | ✓ | — | — |

7/7 PASS — proves `PUBLIC_DIR` resolution works equally in dev mode and in the build output, which is what npm consumers actually run.

---

## 4. Port Reclamation

`npm run gui` initially failed with `EADDRINUSE: 127.0.0.1:7788` — the default port was held by `node.exe` PID `26824` (5,464 KB resident, console-attached), an orphaned Session 37 visual-QA process that never exited.

Action: workaround first (bind on `:7789` to keep the dashboard usable), then on the wrap-up `/goal` step the operator authorized `Stop-Process -Id 26824 -Force` and the port released cleanly. The interim `:7789` background task `bgpjozthm` was also stopped during wrap-up.

Lesson logged: the Sovereign Command Center should self-detect and exit on port conflict — Session 39 candidate for a tiny one-liner change.

---

## 5. Surprises + Hurdles

| Issue | Resolution |
|---|---|
| New `index.html` no longer contains `SOVEREIGN COMMAND CENTER` — the existing test assertion `/SOVEREIGN COMMAND CENTER/` would have hard-failed. | Read the new HTML first to identify a survivable anchor (`<title>Smart Claude Memory`); updated the assertion. |
| `index.html` references Google Fonts (`JetBrains Mono`) — the existing CSP `style-src 'self'` would silently block the stylesheet, and `font-src` fell back to `default-src 'self'` so the woff2 fetches would also fail. | Minimum-scope CSP relaxation: add the two specific Google Fonts hostnames. No other external origins permitted. |
| Token-auth predicate was scoped on path equality (`path !== "/" && path !== "/api/health"`) — would have demanded a token for `/style.css` and `/app.js`, which browsers can't supply. | Re-scoped to enforce token **only** on `/api/*` (minus health). Added explicit test locking the contract. |
| `tsc` does not copy non-`.ts` files. Naive build would leave `dist/gui/public/` empty. | Added `scripts/copy-gui-public.ts` (zero deps, `fs.cpSync`) chained after `tsc` in the build script. |
| First `save_memory` call with `metadata.is_global: true` returned `project_id: "claude-memory"` — routing to GLOBAL silently no-op'd despite valid metadata. | Re-issued with `project_id: "GLOBAL"` explicit at the top level. Row landed as chunk `12903`. Documented for future SCM tool review (Session 39 candidate). |
| Git-Bash mangled `taskkill /F /PID 26824` as `/F` → `F:/` path. | Used the `PowerShell` tool directly: `Stop-Process -Id 26824 -Force`. |

---

## 6. Files Changed

| File | Change | Net Lines |
|---|---|---|
| `src/gui/server.ts` | Static-serve refactor; CSP fonts; auth re-scope | +71 / −15 |
| `src/gui/static.ts` | **Deleted** (703-line DASHBOARD_HTML monolith) | −703 |
| `scripts/copy-gui-public.ts` | **New** — zero-dep build copy step | +44 |
| `package.json` | Added `copy:gui` script; chained into `build` | +1 / −1 |
| `tests/gui.test.ts` | +5 static-serve tests; replaced dead assertion | +47 / −2 |
| `tests/gui-graph.test.ts` | Retargeted DASHBOARD_HTML test at public/ files | +12 / −5 |
| `docs/session-reports/SESSION-38-*.md` | This report | new |
| `dist/gui/static.js` + `.map` | **Deleted** (stale artefacts) | — |
| `README.md` / `ARCHITECTURE.md` | Living-docs sync via `manage_backlog({ action: "session_end" })` | regenerated |

Net effect: **−532 LOC** (dashboard monolith deleted), surface decomposed into the 3 files the operator authored + 1 build script.

---

## 7. Memory Imprints

| Chunk | Type | Scope | Subject |
|---|---|---|---|
| 12901 | DECISION | claude-memory | SCM-S38-D1: M8.2 GUI refactor (monolithic → static-serve) |
| 12903 | PATTERN | **GLOBAL** | SCM-S38-P1: Cross-mode static asset serving in Node ESM services |

Sovereign Scout: cross-project test passed (any Node ≥16.7 ESM service with a tsc-based build that ships static assets benefits identically) — operator gave explicit YES on the `/goal` wrap-up.

---

## 8. Open Items

**None blocking.** v2.2.0 architecture is cleaner than at Session 37 close.

Candidates for Session 39:
- GUI port self-detection — bind to ephemeral port and print the actual URL when `:7788` is taken, instead of failing.
- `save_memory({ metadata: { is_global: true } })` routing audit — the metadata-only form should auto-promote `project_id` to `GLOBAL` without requiring an explicit top-level override.
- Cosmetic carryovers from Session 37: `favicon.ico` 404 in GUI console + `<label for>` associations on graduation form (5 a11y warnings).

---

## 9. Decision IDs

- `SCM-S38-D1` — M8.2 GUI architectural refactor (project-scoped, chunk 12901).
- `SCM-S38-P1` — Cross-mode static asset serving pattern (GLOBAL, chunk 12903).
