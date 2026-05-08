# Session 15 — v2.1.5 Lean Revolution + update_rule Deprecation + E2E Repair

**Date:** 2026-05-08
**Branch / commits:** `main` — `3a5e7d2` (v2.1.5 DNA, local-only) + `206ef05` (PR #5 squash merge: deprecation + bundled v2.1.5) + this wrap-up commit
**Bound protocol:** Sovereign Memory Protocol v2.1.4 → **v2.1.5**

---

## Mission

Three sequential missions, each completed in this session:

1. **v2.1.5 Lean Revolution** — compact the Sovereign DNA, inject three new constitutional directives (Efficiency Imperative, Refined Purge Triggers, Active Memory Hygiene), promote the Lean Logic to GLOBAL.
2. **Deprecate `update_rule`** — eliminate the legacy MCP tool that overlapped `save_memory`. Open a clean PR, merge, reconcile.
3. **Repair the e2e factory** — fix the 1-line pre-existing bug (and a sibling) blocking `tsx scripts/e2e-test.ts`, achieve a 100% green factory.

---

## Code Changes

| File | Change | Why |
|---|---|---|
| `src/tools/sovereign-constitution.ts` | Header `(v2.1.4)` → `(v2.1.5)`; entire `SOVEREIGN_CONSTITUTION_TEMPLATE` body rewritten in dense bullet form via single surgical Edit. Three new sections: `[Efficiency — Tokens Are Currency]` (4th Execution Imperative), `Purge Triggers` (refined), `Active Memory Hygiene`. | Canonical DNA template every sovereign-bound repo inherits via `ensureSovereignConstitution`. |
| `CLAUDE.md` | Mirrored identically via single surgical Edit (Core 3 Integrity preserved — no `Write`). | Local repo's operating manual must match the canonical template it ships. |
| `src/tools/update-rule.ts` | **Deleted** (29-line wrapper around `embed()` + `upsertRule()`). | Functionality fully subsumed by `save_memory`; removing eliminates tool redundancy. |
| `src/index.ts` | Removed `updateRule` import (L7) + `server.tool("update_rule", ...)` registration block (L145–156). | Drop the deprecated MCP tool from the surface. |
| `hooks/md-policy.py` | L297: `"...via update_rule or sync_local_memory."` → `"...via save_memory or sync_local_memory."` | Keep the Zero-Local-MD error message pointing to the canonical write path. |
| `README.md` | Removed tool-table row for `update_rule`, file-tree entry `update-rule.ts`, and Mermaid graph node `n60` (with its incoming edge). | Docs reflect the current tool surface. |
| `ARCHITECTURE.md` | Removed §4.2 trailing sentence about legacy `update_rule`; removed Mermaid graph node `n60`. | Architecture reflects single-write-path reality. |
| `scripts/e2e-test.ts` | L25: added `"__e2e_test__"` as first arg to `upsertChunks`. L38: added `"__e2e_test__"` as first arg to `searchChunks`. | Both functions require `projectId` first; the test was missing it. |

`npm run build` clean (zero tsc errors) after every round. CLAUDE.md compaction: 2232 → **1531 tokens (−31%)**.

---

## The v2.1.5 New Directives (verbatim)

1. **Efficiency Imperative** (4th Execution Imperative) — "10,000 tokens is a HARD CEILING, not a target. Target context size is 2,000 - 3,000 tokens. Every token must justify its existence. Efficiency = Intelligence."
2. **Refined Purge Triggers** — "Purge is NOT automatic. Trigger ONLY on: (1) Context Saturation (>10k tokens or >50% window) OR (2) Mission Completion. Active mission context MUST be preserved; legacy context MUST be offloaded to vectors."
3. **Active Memory Hygiene** — "Surgically clean MEMORY.md every session wrap-up. Keep only 'Current Focus' and 'Pending Tasks'. Archive everything else."

---

## Decisions

- **SCM-S15-D1** (id `11467`, project-local) — Sovereign DNA upgraded to v2.1.5 with three new directives. Constitution body compacted to ~1500 tokens while gaining new sections (DNA demonstrates its own thesis: "Efficiency = Intelligence").
- **SCM-S15-D1 GLOBAL** (id `11468`, `project_id='GLOBAL'`) — The Lean Logic promoted to the Knowledge Vault. Rationale: *"Token-as-currency + bounded purge triggers + active memory hygiene is the minimum viable context-discipline for any long-running LLM agent harness — Claude Code, Cursor, Cline, Aider, Codex, custom RAG systems."* Passed Sovereign Vetting + Cross-Project Test.
- **SCM-S15-D2** (id `11471`, project-local) — `update_rule` MCP tool fully deprecated in favor of `save_memory`. PR #5 merged to `main` as commit `206ef05`. `save_memory` is a strict superset (typed metadata + Sovereign Vetting + optional `file_origin`/`chunk_index` defaults). Five files changed, net −48 lines. Repo-wide grep audit: zero lingering references.

---

## Hurdles & Solutions

- **`Edit` precondition surprise.** Initial parallel Edit batch failed with "File has not been read yet" because `ctx_execute_file` reads do NOT satisfy the Edit tool's per-file Read tracker. Fix: targeted `Read(path, offset, limit)` per file before any Edit. Going forward: `Read` is required for Edit prep, even when content was previewed via ctx.
- **Mermaid node leakage.** First grep for `update_rule` (snake_case) missed the `update-rule.ts` Mermaid nodes in README/ARCHITECTURE. Caught by a follow-up grep that included the filename pattern. Lesson: when deprecating a tool, audit all three name forms — snake_case (tool name), camelCase (function), and the actual filename.
- **PR squash bundling artifact.** Local commit `3a5e7d2` (v2.1.5) was committed but never `git push`-ed before the deprecation PR was opened. The PR diff against `origin/main` (= `9eaafe4` at the time) included BOTH change sets, so the squash merged them under the deprecation title. Both changesets are on `origin/main` intact; only the commit message is misleading. Lesson for next session: `git push` after major feature commits to keep PR diffs scoped to the intended change.
- **E2E was hiding TWO bugs of the same class, not one.** User flagged 1-line `upsertChunks` fix; running it surfaced an identical signature mismatch on `searchChunks`. Both fixed identically (pass `"__e2e_test__"` as first arg). Lesson: e2e-test.ts had no project_id awareness end-to-end — the migration to project-scoped functions left it stranded. Worth a v2.1.6 candidate: a typecheck or lint rule that flags multi-arg functions where `projectId` is missing in tests.
- **Wrap-Up tool numbering off-by-one.** `manage_backlog session_end` emitted "Session 15" in the next-session command, but Session 15 is the one we're closing — next is 16. Cause: tool computes N from `max(existing SESSION-N-REPORT.md) + 1`, but the current session's report doesn't exist yet at Step 0 (it's written in Step 1). Workaround in this session: override the emitted markdown manually. v2.1.6 candidate: tool should read the in-flight session number from the wrap-up trigger context.

---

## Pre-Wrap Checklist

- `npm run build` → zero tsc errors. dist/ rebuilt.
- `tsx scripts/e2e-test.ts` → ALL 5 steps green ("ALL GOOD"). 100% factory.
- Repo-wide grep across `*.ts/*.js/*.py/*.md/*.json` → ZERO references to `update_rule` / `updateRule` / `update-rule.ts`.
- `git status` pre-wrap → only intentional changes (CLAUDE.md, sovereign-constitution.ts, scripts/e2e-test.ts, README.md auto-progress, docs/session-reports/SESSION-15-REPORT.md).
- `manage_backlog({ action: "session_end" })` → `readme_sync.updated === true`, `architecture_sync.updated === true`. Bloat audit: CLAUDE.md = 1531 tok, MEMORY.md = 94 tok.
- Backlog: empty (0 todo / 0 in-progress / 0 blocked).
- No `sovereign_purge_recommendation`.

---

## Drift / Follow-up

- **MEMORY.md auto-memory framework conflict.** v2.1.5's "Active Memory Hygiene — keep only Current Focus and Pending Tasks" was conceived assuming MEMORY.md is a free-form scratchpad. The actual auto-memory MEMORY.md uses a Memory Index format with reference pointers to detail files. Restructuring it into Current Focus / Pending Tasks would conflict with the framework's own conventions. v2.1.6 candidate: reconcile the rule with the auto-memory framework — likely "Surgically prune any STALE entries; new sessions don't accumulate clutter" rather than a fixed two-section schema.
- **`manage_backlog session_end` next-session numbering bug.** Documented above. Tool over-reports the current session as the next session.
- **No tests cover the MCP tool surface.** `e2e-test.ts` only exercises `upsertChunks` / `searchChunks` (Supabase RPC layer). Tool registration changes (like deleting `update_rule`) had no automated test catching them. v2.1.6 candidate: a minimal MCP-tool-list smoke test that asserts the registered tool names against a frozen allowlist.
