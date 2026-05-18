# SESSION 36 — M8.1 Mega-Epic (Graph Automation + GUI Expansion)

**Mission**: Activate the M8 Knowledge Graph substrate end-to-end. Turn the dormant `kg_*` tables + RPCs into a load-bearing retrieval layer (Hybrid RAG) and surface the graph itself in the Sovereign Command Center as an interactive, zero-dependency SVG visualization. Two strictly sequential phases, no GUI work before the backend is 100% green, no merge before both phases are 100% green.

**Decision ID**: `SCM-S36-D1` (memory chunk 12859, project-scoped — not global; this is SCM-specific feature work).

**Outcome**: ✅ Shipped. Build clean. **241/241 tests passing** (+34 from the 207 baseline of Session 35). Boundary Invariant #1 unbroken. M1–M7 business logic untouched.

---

## 1. Phase 1 — Graph Automation (Backend)

### 1.1 Graph Extractor — `src/graph/extractor.ts` (188 lines, pure function)

A deterministic, LLM-free miner that turns a single `memory_chunks` row into a `{ nodes, edges, skipped, reason }` extraction result. The contract is intentionally narrow so the heavy lifting (upsert + edge resolution) lives in the daemon, not here.

**Extraction rules**:
1. Skip `metadata.type === 'LOG'` and content shorter than 20 chars (`reason: 'log_or_too_short'`).
2. Emit **one primary node** per chunk: `type = metadata.type ?? 'NOTE'`, `label = sanitizeLabel(firstNonEmptyLine(content), 200)`, carries `source_chunk_id`, `embedding` (passed through), and `properties.decision_id` if the content contains a `SCM-S\d+-D\d+` match.
3. **File-reference edges**: regex-match file paths matching `[\w./-]+\.(?:ts|tsx|js|jsx|sql|md|py|json)\b`, dedupe, cap at 10. Drop paths containing `node_modules` and URLs (matches preceded by `://` are rejected — this catches `http://x.com/a.js` slipping past the char-class regex). For each match: a `FILE` node + a `MENTIONS` edge (weight 1.0).
4. **Decision-reference edges**: regex-match `SCM-S\d+-D\d+`, dedupe, cap at 5. Skip if equal to the primary's own `decision_id`. For each match: a `DECISION` node + a `REFERENCES` edge (weight 1.5).
5. `sanitizeLabel(s, max=200)`: trim → collapse whitespace → strip leading `#`/`*`/`-`/` ` → slice. Empty result falls back to `chunk:<id>`.

**Design rationale**: pure function + zero I/O + zero LLM means it's trivially testable, fast, and respects Boundary Invariant #1 voluntarily even though `src/graph` is not in the protected boundary list.

### 1.2 Graph Extractor Daemon — `src/graph/daemon.ts` (393 lines)

Mirrors the `trajectory/daemon.ts` shape exactly so it slots into the existing telemetry/health story without bespoke wiring. Module-state + idempotent `startGraphExtractor()` / `stopGraphExtractor()` / `getGraphExtractorStatus()`, plus an exported `runGraphExtractorOnce()` for unit tests.

**Tick logic**:
1. Read env each tick: `SCM_GRAPH_EXTRACTOR_ENABLED` (default `'1'`), `SCM_GRAPH_EXTRACTOR_INTERVAL_MS` (default `120000`), `SCM_GRAPH_EXTRACTOR_BATCH` (default `10`). Disabled → no-op.
2. **Two-step antijoin** (no Postgres `NOT IN`): page `kg_nodes.source_chunk_id IS NOT NULL` into an in-memory `Set<number>` (capped at 10k for now), overfetch `memory_chunks` (5× batch) ordered by `id DESC`, filter client-side. Cheap, explicit, scales to the active chunk window.
3. Parse pgvector embedding repr if Supabase returns it as a `string` (defensive — current driver returns `number[]`).
4. For each chunk: call `extractFromChunk`. If `skipped`, upsert a **sentinel `NOTE:skipped:<id>` node** so the chunk is anchored and never re-queried. Otherwise upsert primary node first (carries embedding + source_chunk_id), then secondary nodes, then build a `Map<"${type}|${label}", number>` to resolve edge endpoints. Per-chunk try/catch — failure increments `errored` and continues.
5. Counters update atomically at end of tick. The `derived` status block mirrors the trajectory/sleep convention: `pending` before first run, `degraded` if `error_rate_1h > 0.2` or staleness > 4× interval, else `healthy`.
6. Timer is `.unref()`'d so it never blocks process exit.

**Registered in `src/index.ts`** after `startTelemetryPruner()` (line 159 area). **Surfaced via `src/tools/health.ts`** as the `graph_extractor` field alongside `telemetry_pruner` / `graduation_scanner` etc.

### 1.3 Hybrid RAG Splice — `src/tools/search.ts`

The single most important wire of this epic. In the **semantic branch only** (line ~222), the code now runs:

```
const [chunksResult, graphResult] = await Promise.allSettled([
  searchChunks(projectId, queryVec, …),
  kgHybridSearch({ project_id: projectId, query_embedding: queryVec,
                   seed_limit: 3, neighbor_hops: 1, min_similarity: 0.3 }),
]);
```

If `graphResult.status === 'fulfilled'` AND `graphResult.value.ok === true`, the response gets an additional `graph_context: { seeds, neighbors }` field. Any other outcome (reject, `ok:false`) is silently dropped — graph failure MUST NOT break semantic retrieval. Env opt-out via `SCM_GRAPH_RAG_DISABLED=1`. Non-semantic branches (id, context_id, archive, backlog) skip the graph call entirely.

**Why `Promise.allSettled` over `Promise.all`**: graceful degradation. A pgvector hiccup on `kg_nodes.embedding` (HNSW index temporarily unavailable) must not cascade into a `search_memory` 500.

### 1.4 Phase 1 Verification

- Tests: `tests/graph-extractor.test.ts` (8), `tests/graph-daemon.test.ts` (6 with `mock.module` on `../src/supabase.js` + `../src/tools/kg.js`), `tests/search-graph-rag.test.ts` (5).
- All test files appended to `package.json` "test" script (`node --test`).
- `npm run build`: clean.
- `npm test`: **227/227** (207 baseline + 20 net, with one extra fallback-label case the worker added).

---

## 2. Phase 2 — GUI Expansion (Frontend)

### 2.1 `GET /api/graph` — `src/gui/server.ts` (+127 lines, 252→379)

Mirrors the `/api/graduations` shape: token-gated (same auth as the existing authed endpoints), JSON-only, clean error envelope.

**Query params**:
- `project_id` — falls back through `SMART_CLAUDE_MEMORY_PROJECT_ID` → `claude-memory`.
- `node_limit` — clamped 1–200 (default 60).
- `edge_limit` — clamped 1–500 (default 120).
- `type` / `label_prefix` — passthrough to `listKgNodes`.

**Flow**: `Promise.all([listKgNodes, listKgEdges])` → build node-id `Set` → filter edges so only those whose source AND target are in the returned node set survive (self-consistent subgraph guarantee) → compute `stats: { node_count, edge_count, type_breakdown }` → return.

Inner failure (`{ok:false}` from either kg call) → `500 { ok:false, reason }`.

### 2.2 SVG Renderer — `src/gui/static.ts` (+353 lines, 350→703, under 750 ceiling)

100% pure DOM/SVG/CSS. Zero external libraries. `textContent` and `setAttribute` everywhere — no `innerHTML` on the dynamic path, so the panel inherits the rest of the file's XSS-safe-by-construction posture.

**HTML**: a new `<section class="graph-panel">` after the existing 4-lane dashboard, containing:
- Header with controls (`node_limit`, `edge_limit`, `type` filter inputs + reload button + stats span).
- 1000×600 `<svg viewBox>` with `preserveAspectRatio="xMidYMid meet"`.
- Right-side detail drawer (hidden by default; revealed on node click).

**CSS**: per-type colours keyed off existing CSS vars (`--accent`, `--ok`, `--err`, `--warn`, `--muted`) so the panel inherits theme automatically. `REFERENCES` edges are dashed; `MENTIONS` are solid.

**Layout — bounded force-directed**:
- Constants: `k_rep = 1500`, `k_attr = 0.02`, `ideal = 100`, `max_iter = 120`, cooling `0.985`.
- Seeded RNG keyed on `node.id` so the layout is **stable across reloads** — re-loading the same graph produces the same picture.
- O(n²) pairwise repulsion + linear-on-edges attraction. Distance clamped at min 5 to avoid singularities. Each step: `pos += force * temp`, then `temp *= 0.985`, then clip into the padded viewport.
- Interactive: clicking a node opens the detail drawer with `label`, `type`, `source_chunk_id`, and `properties` JSON.

**Wired via an IIFE** at the end of the existing `<script>` block — no edits to the dashboard's existing functions.

### 2.3 Phase 2 Verification

- Tests: `tests/gui-graph.test.ts` (14 tests across 8 suites).
- Coverage: empty graph, clamp passthrough, upper/lower clamp, `type` / `label_prefix` forwarding, edge filtering (single + double dangling endpoint), `type_breakdown` arithmetic, `{ok:false}` → 500, thrown error → 500, token gate 401/200, dashboard wiring sanity assertions.
- `npm test`: **241/241 passing**, 0 fail, ~32.5s. Zero healing attempts needed on Phase 2.

---

## 3. Exit Criteria

| Criterion | Result |
| --- | --- |
| Both phases fully built | ✅ |
| Phase 1 100% green before Phase 2 began | ✅ (227/227 after Phase 1, 241/241 after Phase 2) |
| Hybrid RAG actively retrieving | ✅ — semantic `search_memory` attaches `graph_context` when KG returns seeds/neighbors |
| GUI actively rendering the graph | ✅ — `/graph` panel + `/api/graph` endpoint + force-directed SVG |
| Zero external frontend libs | ✅ — pure DOM/SVG/CSS only |
| M1–M7 business logic strictly protected | ✅ — no edits in `src/curriculum/**`, `src/sleep/**`, `src/graduation/**`, or M1–M7 tool files; boundary lint confirms |
| 207+ tests passing | ✅ — **241/241** |
| `npm run build` clean | ✅ — `lint:boundaries` OK, `tsc` exit 0 |
| Sequential execution, no parallel cheats | ✅ |

---

## 4. Hurdles + Resolutions

**H1 — Worker hand-off thrash on test infrastructure**. The first Phase 1 worker assumed `vitest` and shut down mid-investigation when it realized the project uses `node:test`. Resolution: re-dispatched a fresh worker with the corrected test conventions (`node --test` + `--experimental-test-module-mocks` flag + `.js` ESM imports + the exact `package.json` "test" script that the new files must be appended to). Second worker landed Phase 1 in one pass with one self-heal attempt.

**H2 — URL false-positive in file-reference regex**. The first test run of the extractor reported 2 failures: (a) decision-cap test counted the primary DECISION node alongside its secondaries (test bug); (b) `http://x.com/a.js` slipped past `!path.startsWith("http")` because the regex char class can't include `:`, so it matched the bare `x.com/a.js`. Fixed in the extractor with a `matchAll`-based scan that drops any match whose preceding three characters are `://`. Both fixes landed within Phase 1's healing budget.

**H3 — `manage_backlog.session_end` reported `next_task: null`**. Backlog has been empty since Session 35's clean close-out. Not a defect — accurately reflects state. The Living-Docs sync (README + ARCHITECTURE) still ran and updated successfully.

---

## 5. Files Changed

**New** (4 source + 4 test):
- `src/graph/extractor.ts` (188 L)
- `src/graph/daemon.ts` (393 L)
- `tests/graph-extractor.test.ts`
- `tests/graph-daemon.test.ts`
- `tests/search-graph-rag.test.ts`
- `tests/gui-graph.test.ts`

**Modified** (additive only):
- `src/index.ts` — `startGraphExtractor()` registration after `startTelemetryPruner()`.
- `src/tools/health.ts` — `graph_extractor` status field.
- `src/tools/search.ts` — `Promise.allSettled` splice in semantic branch, `kgHybridSearch` import.
- `src/gui/server.ts` (+127 L, 252→379) — `GET /api/graph` route.
- `src/gui/static.ts` (+353 L, 350→703) — `<section class="graph-panel">`, CSS, IIFE renderer.
- `package.json` — 4 new test files appended to the `"test"` script.

**Implementation commit**: `feat(m8): implement Hybrid RAG graph daemon and SVG command center visualization` (`ae3b935`) — 12 files, +2035 / -9.

---

## 6. Open Items

**Visual QA of the SVG layout in the browser.** The force-directed renderer is structurally test-covered (server endpoint + data plumbing) but has NOT been visually verified in a live browser yet. Recommended Session 37 first action:

```
SCM_GUI_ENABLED=1 npm run gui
```

Open the dashboard, scroll to the Knowledge Graph panel, watch the force-directed layout settle, click a node to validate the detail drawer, toggle the `type=FILE` filter to confirm passthrough. If the layout looks chaotic at 60+ nodes, the tuning constants (`k_rep`, `k_attr`, `ideal`, `max_iter`) are the knobs.

No other open items. v2.1.2 still cleared for `npm publish` (M8.1 is additive — no breaking changes to the publishable surface).

Decision ID for the wrap-up: `SCM-S36-D1` (M8.1 Mega-Epic).
