# Session 17 — Agentic OS 2026: Roadmap Injection + Mission 1 (JIT Skill Retrieval)

**Date:** 2026-05-11
**Branch:** main
**M1 feature commit:** `cfb73bb`
**Wrap-up commit:** *(this commit)*

---

## Mission

Two-phase mandate:

1. **Phase 1 — Roadmap Injection.** Stand up the *Agentic OS 2026 Upgrade* epic in the backlog. Five missions spanning JIT skill retrieval, trajectory compression, sleep learning, transactional workflows, and autonomous curriculum.
2. **Phase 2 — Mission 1 execution.** Design, ship, and verify JIT Skill Retrieval end-to-end: schema decision, migration, MCP tools, smoke test.

Both phases shipped this session.

---

## Phase 1 — Backlog Injection

| ID | Priority | Mission |
|---|---|---|
| 111 | P1 | M1 — JIT Skill Retrieval (Zero-Bloat RAG) |
| 112 | P2 | M2 — Trajectory Compression (AgentDiet) |
| 113 | P3 | M3 — Sleep Learning (Idle Daemon) |
| 114 | P3 | M4 — Transactional Workflows |
| 115 | P4 | M5 — Autonomous Curriculum |

Item 111 closed at session end (smoke green). Items 112–115 carry into Session 18+.

---

## Phase 2 — Mission 1 Delivery (JIT Skill Retrieval)

### Architectural Decision (SCM-S17-D1, memory 11505)

**Storage:** dedicated `agent_skills` table — NOT a `metadata.type='SKILL'` extension of `memory_chunks`.

**Single decisive reason:** skill telemetry (`frequency_used`, `last_invoked_at`, `success_rate`) is high-churn mutable state. Co-locating it with immutable `memory_chunks` HNSW(vector_cosine_ops) rows would dirty vector pages on every skill invocation via PostgreSQL MVCC and degrade recall latency for every other retrieval path (DECISION / PATTERN / ERROR / LOG search). PostgreSQL MVCC creates a new row version on every UPDATE, the old vector tuple lingers until VACUUM, and HNSW graph locality assumptions degrade. Separating skills isolates churn to a skill-only HNSW page set.

Secondary drivers:
- UNIQUE(project_id, name) is semantically wrong for `memory_chunks` (whose key is `project_id, file_origin, chunk_index`).
- FK to `archive_backlog` for Sleep-Learning provenance (M3) is cleaner as a column than as JSONB.
- `trigger_keywords text[]` benefits from its own GIN for literal triggers separate from semantic match.

Documented in [ARCHITECTURE.md §4.4](../../ARCHITECTURE.md).

### What Shipped

- **`scripts/010_agent_skills.sql`** — table (14 columns), 5 idempotent indexes (UNIQUE, HNSW, GIN, last_invoked, project_id), RLS `deny_anon_authenticated` (reuses migration 006 policy), 3 SECURITY DEFINER RPCs:
  - `match_agent_skills` — dual-scope (project + GLOBAL), weighted rank = `0.85 * cosine_similarity + 0.15 * recency_decay`
  - `upsert_agent_skill` — ON CONFLICT bumps version, preserves telemetry
  - `bump_skill_telemetry` — EMA(α=0.1) on `success_rate`
- **`src/tools/skills.ts`** — `packageSkill` + `requestSkill` handlers with Zod schemas. Telemetry bumps via fire-and-forget `Promise.allSettled` — never blocks retrieval.
- **`src/index.ts`** — both tools registered in ListTools + CallTool dispatch.
- **`scripts/smoke-010.ts`** — 17 assertions across 5 test groups.

### Smoke Test Result

`npx tsx scripts/smoke-010.ts` — **17/17 green in 9.29s**:

| Test | Coverage | Result |
|---|---|---|
| A | `package_skill` write × 3 (project scope), version=1 | 3/3 |
| B | `request_skill` semantic match — top hit + steps payload | 3/3 |
| C | Version bump preserves telemetry | 4/4 |
| D | Telemetry — frequency_used + last_invoked_at | 3/3 |
| E | GLOBAL scope routing + dual-scope visibility | 4/4 |

---

## Hurdles + Solutions

### 1. SECURITY DEFINER search_path missing `extensions` schema

**Symptom:** First migration apply failed with `operator does not exist: extensions.vector <=> extensions.vector`.

**Root cause:** After migration 006 (security hardening), the `vector` type and its operators (`<=>`, `<->`) moved to the `extensions` schema. SECURITY DEFINER functions reset `search_path` to whatever the function declares. Using `SET search_path = public, pg_catalog` made `<=>` unresolvable at CREATE FUNCTION parse time.

**Fix:** Replicate the pattern from migrations 008/009 — every SECURITY DEFINER RPC that touches `vector` types or operators must declare `SET search_path = public, extensions, pg_catalog`. Healing loop fixed in one attempt.

**Captured as:** ERROR memory `11507`. Going forward, any new SECURITY DEFINER RPC operating on pgvector types MUST include `extensions` in the search_path.

---

## Memories Produced

| ID | Type | Scope | Subject |
|---|---|---|---|
| 11505 | DECISION | project | SCM-S17-D1 — Skill storage: dedicated `agent_skills` table |
| 11506 | PATTERN | **GLOBAL** | Vector-DB telemetry isolation principle (universal architecture rule) |
| 11507 | ERROR | project | search_path bug — SECURITY DEFINER RPCs touching pgvector need `extensions` in path |

### Cross-Project Promotion (Sovereign Vetting passed)

Memory `11506` was promoted to the GLOBAL vault with explicit user consent. Rationale: "isolate high-churn mutable telemetry from immutable HNSW-indexed embedding rows" is a textbook vector-DB principle that applies to every project using pgvector / Weaviate / Pinecone / etc. — not specific to SCM. Future projects boot with this lesson pre-loaded via dual-scope retrieval.

---

## Invariants Verified

- **Zero-Bloat:** skills are never preloaded into the orchestrator's system prompt. Only `request_skill` calls carry the `steps` payload into context. Vault scales to 10 000+ skills at zero context cost until invoked.
- **RLS:** anon and authenticated roles DENIED on `agent_skills`. Service-role only.
- **GLOBAL routing:** explicit `is_global: true` input only — never silent promotion.
- **Telemetry isolation:** fire-and-forget `Promise.allSettled` — telemetry failure never blocks retrieval.
- **Version semantics:** `upsert_agent_skill` ON CONFLICT bumps `version`, replaces content + embedding, **preserves** `frequency_used` / `success_rate` / `last_invoked_at`.

---

## DECISION IDs (this session)

- **SCM-S17-D1** — Skill storage: dedicated `agent_skills` table over `metadata.type='SKILL'` extension (memory 11505).
- **SCM-S17-D2** (implicit) — Promote vector-DB telemetry isolation pattern to GLOBAL vault (memory 11506).

---

## Next Session — Mission 2

**M2 — Trajectory Compression (AgentDiet).** Background compressor that summarizes long operational logs into dense ~50-token semantic summaries to save the orchestrator's context window. Boots fresh on Session 18 to start that mission with a clean context, given M2 directly addresses context-limit pressure.

Backlog top: id `112` (P2).
