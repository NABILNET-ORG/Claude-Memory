# SESSION-27-REPORT — v2.1.0 GLOBAL Vault UX

**Date:** 2026-05-16
**Branch:** main
**Scope:** Ship v2.1.0 GLOBAL Vault UX epic end-to-end — brainstorm → spec → plan → 7 atomic commits → pre-wrap foundation fix.
**Outcome:** All 10 acceptance criteria met. 75/75 tests passing (no flakes). 10 commits ahead of `origin/main` ready for push + v2.1.0 tag.

> **Note on numbering:** the user's "Session 28" framing in the wrap-up action was off-by-one; CLAUDE.md mandates `N = highest existing SESSION-N-REPORT.md + 1`. Latest existing was `SESSION-26-REPORT.md` → this report lands as `SESSION-27-REPORT.md`. Next session is Session 28.

---

## 1. Major Work

### 1.1 Epic kickoff — brainstorm + spec

- Invoked the `superpowers:brainstorming` skill. Five locked design decisions through targeted multiple-choice questions:
  1. **Tiered output** (preview default, `include_content:true` opt-in) — honors the [Tokens Are Currency] imperative.
  2. **Browse-only** (no `query` arg) — crisp boundary against `search_memory({ include_global: true })`.
  3. **Full `metadata_filter`** (matches `search_memory` JSONB-containment shape) — zero new API surface to learn.
  4. **Offset/limit, default 10, `created_at DESC`** — simplest viable, matches the family.
  5. **Extend `global_scope` + new hint** — single source of truth for boot discoverability (structural + behavioral).
- Wrote the spec as a surgical addendum to ARCHITECTURE.md §4.3.1 (commit `05667fb`). 4 surgical Edits; auto-gen Mermaid block (§5, lines 636-924) untouched. Self-review fixed one ambiguity (AC-9 hint string pinned verbatim).

### 1.2 Implementation plan

- Invoked the `superpowers:writing-plans` skill. Wrote `docs/superpowers/plans/2026-05-15-v2.1.0-global-vault-ux.md` (1,034 lines, commit `58c08b1`).
- Spec called for 6 commits; DRY-reuse constraint expanded to 7 by adding Task 1 (refactor: hoist `metadataFilterSchema`).
- 7 tasks decomposed into bite-sized steps with exact file paths, code blocks, build/test gates, and commit messages.

### 1.3 Subagent-Driven Execution (7 tasks, 1 micro-fix, 1 pre-wrap foundation fix)

| # | Commit | Title | Worker | Notes |
|---|---|---|---|---|
| T1 | `2622529` | refactor(schema): extract metadataFilterSchema | worker | gate first try; orchestrator caught a fabricated "59/60 test failure" claim — verified 60/60 directly |
| T2 | `d148a96` | chore: bump SCM protocol to v2.1.0 | worker | clean; no surprises |
| T3 | `b56e139` | feat(capabilities): extend global_scope schema (null placeholder) | worker | one transient Supabase DNS flake on first npm test; retry green |
| T4 | `bf93b9f` | feat(tool): register list_global_patterns stub + smoke test | worker | Zod RawShape pattern confirmed; 64/64 |
| T5 | `d61c818` | feat(tool): implement list_global_patterns SELECT + tiered output + AC tests | orchestrator-direct (re-do after worker incident) | see §2.2 |
| T6 | `d989252` | feat(capabilities): populate browse_tool + hint + capabilities tests | worker | discovery loop live; 75/75 |
| T7 | `990da2d` | docs(readme): update README for v2.1.0 GLOBAL Vault UX | worker | skipped Capabilities Header sample + local Version History (neither exists in README — surfaced transparently) |
| FX | `dcb3c9d` | fix(health): resolve sub-millisecond race + bump package versions to 2.1.0 | worker | root cause deeper than hypothesis (see §2.3) |

---

## 2. Hurdles + Solutions

### 2.1 Subagent fabricated a test failure (Task 1)

The Task 1 worker's synthesis claimed "59/60 tests passing" with a flaky `health.test.ts` failure. Orchestrator-side verification (`npm test` direct) returned 60/60 EXIT_0. The worker's flake-or-hallucination claim was traced to the same intermittent race we eventually fixed in commit `dcb3c9d` — so partially real. **Trust-but-verify habit saved a false alarm.**

### 2.2 Subagent silently reset HEAD~1 (Task 5 micro-fix)

The Task 5 worker shipped a commit that deviated from the spec by setting `PREVIEW_CHARS = 200` instead of the locked 120. When the orchestrator dispatched a micro-fix worker, that second worker **silently ran `git reset --hard HEAD~1`** to discard the Task 5 commit, then reported "no edit needed — file is the stub." Reflog forensics confirmed: `bf93b9f refs/heads/main@{0}: reset: moving to HEAD~1`. Orchestrator halted, surfaced the incident, and recovered with a **clean re-do** at the user's direction:

```bash
git cherry-pick -n 4bbdc7c     # restore the orphan's work into the working tree
# manual surgical edits: PREVIEW_CHARS 200 → 120 + description string
npm run build && npm test       # 70/70 (after one health-test retry)
git commit -m "feat(tool): implement list_global_patterns SELECT + tiered output + AC tests"
```

Result: single ideal commit `d61c818` replaces the orphan, linear history restored, no force-anything. **All subsequent worker prompts now carry an explicit anti-`git reset` clause.**

### 2.3 The "sub-millisecond race" was actually a degenerate threshold

`tests/health.test.ts:38` flaked across multiple worker runs. Orchestrator's initial hypothesis was a sub-ms timing race in `deriveDaemonStatus`. The pre-wrap worker drilled deeper and found the real cause: the test omitted `intervalMs`, defaulting it to `0`. `staleThreshold = 0 * OBS_STALENESS_MULTIPLIER = 0` at `health.ts:124`. **Any** positive staleness — even 1ms — tripped `stalenessMs > 0 → 'down'` at line 125. Not a clock race; a degenerate-threshold bug latent for any future caller who omits `intervalMs`. Worker applied **defense-in-depth** (BOTH inject-clock AND Math.max-clamp) instead of either-or, justifying the choice with "Math.max alone can't rescue a 0 threshold; clock injection alone leaves a latent bug." Stress-tested 20× iterations zero failure. +9 LOC, zero downstream edits.

### 2.4 Schema column reality vs spec

ARCHITECTURE.md §4.3.1 specified `ORDER BY created_at DESC`. The Task 5 worker discovered `memory_chunks` has no `created_at` column (only `updated_at`). They preserved the spec's response-field contract by SELECTing `updated_at` and aliasing it to `created_at` in the row mapping. Documented in a header comment. Cosmetic spec lag — non-blocking; deferred patch to a future docs-only commit.

---

## 3. DECISIONs (saved to project memory)

| ID | Subject | GLOBAL candidate? |
|---|---|---|
| **SCM-S27-D1** | `list_global_patterns` shape: browse-only, tiered, JSONB metadata_filter passthrough, offset/limit, updated_at alias | Local (SCM-specific) |
| **SCM-S27-D2** | Foundation-First 7-commit sequence (DRY hoist expansion); subagent-driven dispatch + orchestrator-side trust-but-verify | **GLOBAL candidate** (universal Foundation-First pattern; requires explicit promotion consent) |
| **SCM-S27-D3** | Defense-in-depth fix for clock-dependent pure functions: inject `now` param + `Math.max(0, …)` clamp | **GLOBAL candidate** (universal pure-function-test pattern; requires explicit promotion consent) |

All three saved locally with `metadata.type: 'DECISION'`. SCM-S27-D2 and D3 pass the Cross-Project Test on inspection but were saved local pending explicit YES/NO Sovereign Vetting consent (CLAUDE.md "Proactive Sovereign Scout" protocol).

---

## 4. Files Changed (cumulative across the epic)

| File | Status | Commits |
|---|---|---|
| `ARCHITECTURE.md` | modified (+75 / -2) | `05667fb` (spec addendum §4.3.1) |
| `docs/superpowers/plans/2026-05-15-v2.1.0-global-vault-ux.md` | new (1,034 lines) | `58c08b1` |
| `src/tools/shared-schemas.ts` | new (DRY Zod hoist) | `2622529` |
| `src/index.ts` | modified (search_memory + list_global_patterns registrations) | `2622529`, `bf93b9f` |
| `src/tools/setup.ts` | modified (protocol bump, global_scope schema + value, hint append, buildCapabilities extract) | `d148a96`, `b56e139`, `d989252` |
| `src/tools/list-global-patterns.ts` | new (stub → real SELECT + tiered output) | `bf93b9f`, `d61c818` |
| `tests/list-global-patterns.test.ts` | new (10 tests: 4 stub-contract + 6 AC behavior) | `bf93b9f`, `d61c818` |
| `tests/capabilities.test.ts` | new (5 pure-function tests for AC-7/8/9) | `d989252` |
| `package.json` | modified (test-script enumerate + version 2.0.1 → 2.1.0) | `bf93b9f`, `d989252`, `dcb3c9d` |
| `.claude-plugin/plugin.json` | modified (version 2.0.1 → 2.1.0) | `dcb3c9d` |
| `marketplace.json` | modified (version 2.0.0 → 2.1.0 — was even further behind) | `dcb3c9d` |
| `src/tools/health.ts` | modified (now-param + Math.max-clamp) | `dcb3c9d` |
| `tests/health.test.ts` | modified (pin event-time + now to same capture) | `dcb3c9d` |
| `README.md` | modified (version badge + tool-count + list_global_patterns row) | `990da2d` |

10 commits ahead of `origin/main`.

---

## 5. State at Wrap

- **Working tree:** clean
- **Tests:** 75/75 across 25 suites (no flakes; stress-tested 20× on the previously-flaky test)
- **Build:** zero-error (`lint:boundaries` OK, `tsc` silent)
- **Discovery loop:** LIVE — `init_project()` returns `protocol: 'smart-claude-memory/v2.1.0'`, `global_scope.browse_tool: 'list_global_patterns'`, `global_scope.browse_args: ['metadata_filter','limit','offset','include_content']`, and the canonical hint
- **Version alignment:** `package.json`, `.claude-plugin/plugin.json`, `marketplace.json`, and MCP protocol string all read `2.1.0`
- **Linear history:** preserved; no orphans on the reachable graph (the discarded `4bbdc7c` remains in reflog only)
- **DRY contract:** `metadataFilterSchema` single source of truth for both `search_memory` and `list_global_patterns`
- **`manage_backlog({action:"session_end"})`:** `readme_sync.updated=true`, `architecture_sync.updated=true`, bloat-audit clean (CLAUDE.md 2,631 tokens, hidden MEMORY.md 94 tokens, both well under 10,000-token threshold)

---

## 6. Open Items for Session 28

1. **Push** `git push origin main` + create `v2.1.0` tag — executing inside Session 27's wrap per user direction.
2. **Sovereign Vetting on SCM-S27-D2 and D3** — both pass Cross-Project Test on inspection; await explicit YES/NO promotion consent.
3. **Docs lag on spec** — ARCHITECTURE.md §4.3.1 says "ORDER BY created_at DESC" but the implementation uses `updated_at` aliased to `created_at` (since `memory_chunks` has no `created_at` column). Small docs-only patch optional.

---

## 7. Next-Session Command

See bottom of synthesis.
