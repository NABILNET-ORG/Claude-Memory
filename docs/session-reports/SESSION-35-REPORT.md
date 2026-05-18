# SESSION 35 — M8 Mega-Epic (CI/CD + Sovereign Command Center + Knowledge Graph)

**Date:** 2026-05-18
**Branch:** `main` (HEAD `84d2ddf` at session start)
**Goal:** Execute the complete M8 Mega-Epic in three sequential phases — CI/CD, Sovereign Command Center, Knowledge Graph — with each phase 100% green before advancing to the next. Strictly protect M1-M7 business logic.
**Result:** **All 3 phases delivered. 207/207 tests passing (was 169 baseline). `npm run build` clean. Migration 020 applied to live Supabase. No M1-M7 source files modified.**

---

## 1. Phase 1 — CI/CD + Glob Tech-Debt

### Defects targeted

- No GitHub Actions workflow existed (`.github/workflows/` was empty).
- `npm install` emitted a `glob@10.5.0 deprecated` warning from the transitive chain `archiver@7.0.1 → archiver-utils@5.0.2 → glob@10.5.0` (flagged in Session 34 §7).

### Fixes shipped

| File | Change |
| --- | --- |
| `.github/workflows/ci.yml` (NEW) | Build & Test matrix (Node 20 × 22) on push/PR/manual_dispatch + a release-gate job on main. Each matrix run installs deps, audits the glob tree for any lingering `10.x`, runs `lint:boundaries`, `tsc`, `npm test`, asserts `dist/` artifacts exist, packs the tarball, and confirms ≥20 `scripts/*.sql` migrations ship inside it. |
| `package.json` | Added `overrides.archiver-utils.glob = "$glob"` — npm's "match the top-level glob version" sigil, which pins archiver-utils' transitive glob to `^13.0.6`. |

### Verification

```
glob tree (post-fix):
  smart-claude-memory-mcp@2.1.2
  ├─┬ archiver@7.0.1
  │ └─┬ archiver-utils@5.0.2
  │   └── glob@13.0.6 deduped
  └── glob@13.0.6
```

`npm install` deprecation count for glob: **0** (was 1 in Session 34).

Regression: **169/169 tests green** before moving to Phase 2.

---

## 2. Phase 2 — Sovereign Command Center

### Design

- Zero-dependency `node:http` server. No express, no react, no front-end build step. The dashboard is a single embedded HTML string exported from `src/gui/static.ts` and served byte-for-byte from `GET /`.
- Loopback-only by default (`127.0.0.1:7788`) — the service-role Supabase key lives in this process, so the GUI MUST NOT listen on a non-loopback interface without explicit opt-in. Optional bearer token via `SCM_GUI_TOKEN` for an extra layer.
- Boots alongside the MCP stdio server when `SCM_GUI_ENABLED=1`. With the flag off, the MCP server is unchanged.
- All handler calls go through a `GuiHandlers` seam so the test suite stubs M7 without ever touching Supabase.

### Files

| File | Purpose |
| --- | --- |
| `src/gui/server.ts` (NEW) | HTTP server, route table, JSON helpers, security headers (`X-Content-Type-Options`, `X-Frame-Options`, CSP), token middleware. Exports `createGuiServer`, `startGuiServer`, `GUI_VERSION`. Includes a standalone entry point so `npm run gui` can boot the dashboard without the MCP server. |
| `src/gui/static.ts` (NEW) | Embedded vanilla-JS dashboard. Four lifecycle lanes (proposed → composed → approved → rejected). Mutation forms (compose, reject, confirm) post JSON bodies and re-fetch. XSS posture: **no `innerHTML` on the dynamic render path** — every cell is `createElement` + `textContent`. |
| `src/index.ts` | Optional GUI startup block before `await server.connect(transport)`. Gated by `SCM_GUI_ENABLED`. |
| `tests/gui.test.ts` (NEW) | 19 test cases across health/static, list route, mutation routes, failure surface, and token-auth suites. Each suite spins up its own server on a random port with stubbed handlers; no Supabase, no Ollama. |

### Verification

`npm run build` clean. Smoke test (`startGuiServer({ port: 0 })` → `fetch /api/health` → `close()`) returns `{ ok: true, service: 'scm-gui', version: '1.0.0' }` and shuts down cleanly. After Phase 2: **188/188 tests green** (169 baseline + 19 GUI).

---

## 3. Phase 3 — Knowledge Graph (Hybrid RAG)

### Schema (migration 020_knowledge_graph.sql — applied to live Supabase)

```sql
public.kg_nodes (
  id bigserial PK,
  project_id text NOT NULL,
  type text NOT NULL,
  label text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  embedding extensions.vector(768),                -- nullable for symbolic nodes
  source_chunk_id bigint REFERENCES memory_chunks(id) ON DELETE SET NULL,
  created_at, updated_at,
  UNIQUE (project_id, type, label)
);

public.kg_edges (
  id bigserial PK,
  project_id text NOT NULL,
  source_id bigint REFERENCES kg_nodes(id) ON DELETE CASCADE,
  target_id bigint REFERENCES kg_nodes(id) ON DELETE CASCADE,
  relation text NOT NULL,
  weight double precision NOT NULL DEFAULT 1.0,
  properties jsonb NOT NULL DEFAULT '{}',
  CHECK (source_id <> target_id),
  UNIQUE (project_id, source_id, target_id, relation)
);
```

Indexes: HNSW on `kg_nodes.embedding`, GIN(`jsonb_path_ops`) on both `properties` columns, btree on tenancy + relation. RLS: `service_role` bypasses; `anon` + `authenticated` denied (matches the project-wide posture from migration 006).

### RPCs (all SECURITY DEFINER, search_path = public, extensions, pg_catalog)

- `kg_upsert_node(project_id, type, label, properties, embedding, source_chunk_id) → bigint` — idempotent on `(project_id, type, label)`. On conflict, `embedding` and `source_chunk_id` are only overwritten when the caller passes non-null values, so existing semantic anchors survive a later non-embedded re-import.
- `kg_upsert_edge(project_id, source_id, target_id, relation, weight, properties) → bigint` — idempotent on `(project_id, source_id, target_id, relation)`. Raises on self-loops.
- `kg_hybrid_search(project_id, query_embedding, seed_limit, neighbor_hops, min_similarity) → jsonb` — ANN nearest-K seeds + 1-hop neighbour expansion (configurable 0–2 hops). Returns `{ seeds: [...], neighbors: [...] }`. Re-ranking lives in TS so the strategy can evolve without a migration.

### TS access layer (`src/tools/kg.ts`)

`upsertKgNode`, `upsertKgEdge`, `kgHybridSearch`, `listKgNodes`, `listKgEdges` — each returns the discriminated-union shape used by M7 (`{ ok: true, … } | { ok: false, reason }`). Dim validation (768) at the TS boundary; identical SQL-level validation lives in the RPC for defense in depth.

### MCP wire-up

Five new tools registered in `src/index.ts`: `kg_upsert_node`, `kg_upsert_edge`, `kg_hybrid_search`, `list_kg_nodes`, `list_kg_edges`.

### Verification

`tests/kg.test.ts` (NEW) — 19 cases covering schema sanity, input validation, idempotency, CASCADE behavior, vector ranking (anchor returns sim ≈ 1.0 for the matching query), 1-hop expansion correctness (connected nodes appear, strangers don't), `neighbor_hops=0` suppression, and list filters. Uses live Supabase under a unique `__test_kg_<uuid>__` project_id namespace per suite; `after()` deletes by `project_id` (CASCADE wipes edges).

After Phase 3: **207/207 tests green**, `npm run build` clean.

---

## 4. Exit Criteria

| Criterion | Result |
| --- | --- |
| All 3 phases fully built | ✅ |
| Tested with 169+ tests passing | ✅ **207/207** (+38 net) |
| M1-M7 business logic strictly protected | ✅ — `src/index.ts` additions only; no edits inside `src/curriculum/**`, `src/sleep/**`, `src/graduation/**`, or any M1-M6 tool file |
| GUI lightweight + runs alongside MCP | ✅ zero deps, loopback-only, opt-in via `SCM_GUI_ENABLED=1` |
| 100% green before advancing each phase | ✅ Phase 1 → 169/169, Phase 2 → 188/188, Phase 3 → 207/207 |
| `npm run build` clean | ✅ `lint:boundaries` OK, `tsc` exit 0 |
| Sequential execution, no parallel cheats | ✅ |

---

## 5. Hurdles + Resolutions

- **`innerHTML` blocked by the security hook.** The first `src/gui/static.ts` draft used `innerHTML` for dynamic card rendering. The `hooks/security_reminder_hook.py` PreToolUse hook flagged it as an XSS surface. Resolved by rewriting `renderCard` to use `createElement` + `textContent` exclusively — same output, zero injection surface, no `DOMPurify` dependency needed.
- **`npm overrides` cache staleness.** First override attempt left `glob@11.1.0 invalid` in the tree because the existing `package-lock.json` had a stale resolution. Fixed by a clean `rm -rf node_modules package-lock.json && npm install` — the override is honoured only when npm rebuilds the lock from scratch.
- **Test runner cleanup ordering.** The KG suite registers a single `after()` hook that deletes by `project_id`. CASCADE on `kg_edges.source_id/target_id` means the one statement clears both tables — no need to call out edges separately.

---

## 6. Files Changed

```
A  .github/workflows/ci.yml
A  scripts/020_knowledge_graph.sql
A  src/gui/server.ts
A  src/gui/static.ts
A  src/tools/kg.ts
A  tests/gui.test.ts
A  tests/kg.test.ts
M  package.json   (overrides + test script + gui scripts)
M  package-lock.json  (regenerated from scratch for the glob override)
M  src/index.ts   (KG imports/registrations + optional GUI boot)
```

`dist/` regenerated as a side-effect of `npm run build`.

---

## 7. Open Items

**None.** All exit criteria met. v2.1.2 still cleared for `npm publish` (no changes to publishable surface besides the new RPCs/tools; the marketplace tarball still ships ≥20 `scripts/*.sql` and migration 020 is now part of that count when next packed).

Decision ID for the wrap-up: `SCM-S35-D1` (M8 Mega-Epic).
