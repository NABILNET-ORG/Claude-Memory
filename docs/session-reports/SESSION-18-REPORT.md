# Session 18 — M2: AgentDiet (Trajectory Compression) Deployed

**Date:** 2026-05-11
**Branch:** main
**Headline commit:** `27aecaa` — feat(agentic-os-2026): M2 — Trajectory Compression
**Backlog:** #112 archived. Roadmap M2/5 complete; M3 (Sleep Learning, P3) next.

---

## 1. Changes shipped

### Schema — `scripts/011_trajectory_compaction.sql` (204 lines)

- `trajectory_summaries` table — 11 columns including `source_chunk_id BIGINT REFERENCES memory_chunks(id) ON DELETE CASCADE`, `summary_embedding vector(768)`, `compression_ratio` as STORED generated column with `NULLIF(source_tokens,0)` guard, and `model` / `strategy` audit columns.
- Indexes: UNIQUE `(project_id, source_chunk_id)`, btree `created_at DESC`, HNSW on `summary_embedding` (cosine).
- RLS enabled with `deny_anon_authenticated` policy mirrored verbatim from `006_security_hardening`.
- **`match_memory_chunks` RPC patched** — the load-bearing change. The function was recreated via `CREATE OR REPLACE` with byte-identical return signature, but the body now does `LEFT JOIN trajectory_summaries ts ON ts.source_chunk_id = mc.id AND ts.project_id = mc.project_id` and projects `COALESCE('[Compressed trajectory — call get_trajectory_summary({chunk_id: '||mc.id||'}) for raw.] '||ts.summary, mc.content) AS content`. Ranking still happens against the original embedding — recall is preserved; only the projected text changes.
- New RPC `get_trajectory_summary(p_chunk_id BIGINT)` returning `(summary, source_tokens, summary_tokens, compression_ratio, model, created_at)` — drill-down handle when raw is genuinely needed.

### Pipeline — `src/trajectory/` (469 lines across 3 modules)

- `stripper.ts` (119) — pure function `stripTrajectory(raw)` applying 7 heuristic rules in order: token estimation pre-mutation → ANSI strip → JSON-blob elision (>500c) → V8 stack-trace truncation (keep 5, append `[N more frames elided]`) → consecutive-line dedupe (`[× N repeats]`) → noise-level strip (`DEBUG:`/`TRACE:`/`VERBOSE:`) → 100k-char safety net. Zero I/O, zero deps.
- `summarizer.ts` (102) — `summarizeTrajectory(stripped, opts)` wrapping `chat()` from `src/ollama.ts`. Default model `gemma3:e2b` (env override `OLLAMA_TRAJECTORY_MODEL`). System prompt locked for ~50-token dense semantic summary emphasizing action/intent/key-identifiers. Post-process: preamble strip via regex, newline collapse, 400-char sentence-boundary truncation. Abort signal propagated via `raceAbort` wrapper.
- `daemon.ts` (248) — `startCompactor()`/`stopCompactor()`/`getCompactorStatus()`/`runCompactionOnce()`/`compactOneChunk()`. Mirrors `keepAlive` pattern from `src/supabase.ts:74-135`: module-level state, `setInterval(...).unref()`, re-entrancy `running` flag, idempotent start/stop, per-chunk error isolated. Env: `TRAJECTORY_COMPACTOR_INTERVAL_MS` (default 600 000), `TRAJECTORY_COMPACTOR_BATCH` (25), `TRAJECTORY_COMPACTOR_MIN_BYTES` (16 000).

### MCP surface — `src/tools/compact.ts` (110 lines)

- `compact_trajectory({ chunk_id?, dry_run?, batch? })` — single-chunk or batch tick. `dry_run` skips persistence.
- `get_trajectory_summary({ chunk_id })` — RPC wrapper; `{found:false}` on miss.

### Wiring

- `src/index.ts` — both tools registered after `request_skill` in a new "Trajectory Compaction (SCM-S18-D1)" section. `startCompactor()` boots beside `startKeepAlive()`.
- `src/tools/health.ts` — `trajectory_compactor` block added to `HealthReport`, projected from `getCompactorStatus()` alongside the existing `keep_alive` block.

### Tests — 42/42 green (`node:test` + `tsx`, no new deps)

- `tests/trajectory-stripper.test.ts` — 22 tests covering all 7 heuristic rules + token-count consistency + non-mutation + empty input.
- `tests/trajectory-summarizer.test.ts` — 12 tests with `mock.module` covering empty/whitespace guards, default + custom model, system prompt structure, preamble strip, newline collapse, 400-char truncation, abort propagation.
- `tests/trajectory-daemon.test.ts` — 8 tests covering idempotent start/stop, status shape, `runCompactionOnce` shape, `compactOneChunk` not_found / too_small_after_strip / dry-run.
- `package.json` — `--experimental-test-module-mocks` flag added to enable Node 22.3+ `mock.module`.

### Design doc — `ARCHITECTURE.md` §4.5

New subsection inserted between M1 forward-links and §5. Includes [TECH_STACK], 11-column schema table, two Mermaid workflows (compactor write path + read-path substitution), read-path invariant statement, and forward links to M3 and M4.

---

## 2. Hurdles & solutions

### H1 — Fatal read-path flaw caught mid-design (the load-bearing moment)

The initial design synthesis declared "Original retrievals remain identical pre/post-M2." The user immediately surfaced the contradiction: if `search_memory` still returns the 4 000-token raw chunk, AgentDiet saves **zero** context tokens. Compression without read-path substitution is a dead-end.

**Resolution:** rewrote §4.5's read path before any code shipped. The `match_memory_chunks` RPC now does a `LEFT JOIN trajectory_summaries` with `COALESCE` projection — when a summary exists, the result row carries `[Compressed trajectory — call get_trajectory_summary({chunk_id: N}) for raw.] ...summary...` in place of `content`. HNSW index + raw `memory_chunks` rows stay untouched (Constitution: "Archive, never delete"); the substitution is projection-only. Ranking is unchanged because the order still uses `mc.embedding <=> query_embedding`. Net: **~80× context savings per compressed row, compounding over thousands of past sessions.**

### H2 — Byte vs token metric in the threshold query

Original synthesis read `octet_length(content) > threshold` with `threshold = 4000` — confusing bytes and tokens. PostgreSQL `octet_length` returns bytes, and the project's token heuristic is `Math.ceil(len/4)` (≈4 bytes/token for English).

**Resolution:** threshold widened to `16 000` (4 000 tokens × 4 bytes). Encoded in env `TRAJECTORY_COMPACTOR_MIN_BYTES` so it's tunable without redeploy.

### H3 — `npm run schema` only applies `001_schema.sql`

When asked to apply migration 011, `npm run schema` showed `applying 001_schema.sql... Schema applied.` and stopped. Inspecting `scripts/apply-schema.ts` revealed it accepts a `process.argv[2]` filename override defaulting to `001_schema.sql`.

**Resolution:** invoked directly as `npx tsx scripts/apply-schema.ts 011_trajectory_compaction.sql`. Migration applied cleanly. Follow-up: the `schema` npm script could be enhanced to accept a positional argument or auto-discover unapplied files, but that's a foundation change deliberately deferred to keep M2 atomic.

### H4 — Ollama `chat()` lacks `num_predict` + `AbortSignal` knobs

The spec called for `num_predict: 120` at the Ollama API and a passed-through `AbortSignal`. The existing `chat()` wrapper exposes neither.

**Resolution:** rather than reimplement `fetch`, the summarizer enforces the cap post-hoc via the 400-char sentence-boundary truncation (`num_predict` was a soft target, not a hard contract) and wraps abort propagation in a local `raceAbort()` helper. Contract satisfied at the wrapper boundary; `src/ollama.ts` untouched. If future needs require true API-level control, that's a one-line addition to `chat()` opts — out of M2 scope.

### H5 — Client-side anti-join in candidate selection

The daemon's `fetchCandidates()` cannot push the `NOT EXISTS (SELECT 1 FROM trajectory_summaries WHERE source_chunk_id = mc.id)` predicate through PostgREST. It over-fetches `memory_chunks` 4× the batch limit and filters by `Buffer.byteLength(content)` and Set-membership in JS.

**Resolution:** acceptable for current corpus sizes. Documented as follow-up: when `trajectory_summaries` grows large enough to make the 4× over-fetch wasteful, migrate to a dedicated SQL RPC `select_compaction_candidates(p_limit, p_min_bytes)` doing the anti-join server-side. Not in scope for M2.

---

## 3. Decision IDs

- **SCM-S18-D1** — `trajectory_summaries` as dedicated table (not `metadata.type='SUMMARY'` on `memory_chunks`). Rationale: same as M1 — co-locating mutable derived data with the immutable HNSW vault would dirty vector pages and violate the Constitution's "Archive, never delete" rule. The raw row stays addressable for M3 mining; the summary is a derived projection.
- **SCM-S18-D2** — Read-path substitution via `match_memory_chunks` LEFT JOIN with `COALESCE` projection. The single architectural choice that converts M2 from a forensics tool into a context-saving feature. Ranking stays on the original embedding (recall preserved); only the returned text changes.
- **SCM-S18-D3** — Heuristic + LLM hybrid pipeline. Strip raw JSON / stack traces / ANSI / dupes deterministically *before* any LLM call. Rationale: wasting `gemma3:e2b` compute on raw JSON blobs is pure cost with no quality lift. The stripper alone often skips compaction entirely (`strippedTokens < 250` → `reason:'too_small_after_strip'`).
- **SCM-S18-D4** — Background daemon (10-min idle tick, `.unref()`'d) over inline-at-session-end or on-demand-only. Rationale: M2 should save context *during* a long mission, not just at handover. Inline-at-session-end would mean the active mission keeps paying the bloated-trajectory cost the whole time.

---

## 4. Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit` per worker | ✓ each module clean on first attempt |
| `npm run build` | ✓ clean (empty stdout) |
| `node --test` (42 tests) | ✓ 42/42 pass in 223 ms |
| Migration `011` applied via pooler | ✓ `Schema applied.` |
| `git status` post-commit | ✓ working tree clean |
| `manage_backlog session_end` | ✓ readme_sync + architecture_sync both `updated: true`, 1 archived |
| MEMORY.md token count | ✓ 94 tok (lean — no archiving needed) |
| CLAUDE.md token count | ✓ 1 704 tok (lean) |

---

## 5. Forward links

- **M3 (Sleep Learning, P3)** — now unblocked. The idle daemon will mine `trajectory_summaries` JOIN `archive_backlog` for repeated successful sequences and call `package_skill` autonomously. Compressed summaries are dramatically cheaper to scan than raw logs, making the mining pass feasible at scale.
- **M4 (Transactional Workflows, P3)** — per-step trajectory summaries become checkpoint deltas, enabling resume-from-step semantics without replaying raw operational logs.
- **M5 (Autonomous Curriculum, P4)** — depends on M3.
