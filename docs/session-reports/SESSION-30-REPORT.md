# Session 30 Report — Smart Claude Memory

**Date:** 2026-05-17
**Theme:** Verify, don't build. Two heavy Epics (M4 Phase B + M5 rollback_repro) closed end-to-end after planning discovered both targets were already shipped — the gap each time was zero test coverage.

---

## 1. Headline Wins

- **M4 Phase B (Transactional Workflow Checkpoints) — production-validated.** 12 live-Supabase characterization tests cover all 4 MCP tool handlers (`checkpoint_create` / `_commit` / `_rollback` / `_list`) + the `stampCheckpointRootIdOnBacklog` helper. Live smoke `npm run smoke:m4` green. ARCHITECTURE.md M4 table flipped from "4 deferred-Phase-B tools" to "Production-validated Session 30".
- **M5 rollback_repro — production-validated + 2 silent doc bugs fixed.** 7 characterization tests cover `scanRollbackHotspots` across empty/threshold/window/multi-group/empty-label/dedup. Live smoke `npm run smoke:m5-rollback` green. Closed the autonomous learning loop end-to-end: an M4-produced rolledback checkpoint deterministically materializes a `curriculum_tasks` row of kind `rollback_repro` once 3 rolledbacks for the same `step_label` land within 30 days.
- **Two real doc bugs corrected** in ARCHITECTURE.md (lines 556 + 576): `status='rolled_back'` → `'rolledback'` (CHECK constraint allows only the no-underscore spelling; the wrong spelling matches zero rows silently); `target_path` source from `agent_skills.steps[].path` → `workflow_checkpoints.step_label` (the smarter design — no LLM interpretation, documented inline at scanner.ts:195-198).
- **Session 29 cleanup tasks resolved:** deleted duplicate `agent_skills` row id=13 (project-scope `systematic-debugging`; GLOBAL row 20 survives); validated Phase 3 orchestrator improvement via real worker dispatch (smoke test passed); deferred v2.1.2 npm publish per user (internal-only change).

---

## 2. Source Material (analyzed; never imported)

- `src/tools/checkpoint.ts` (385 lines, production code wrapping `src/transactions/checkpoint.ts`).
- `src/curriculum/scanner.ts:185-249` + `:330+` (the `scanRollbackHotspots` body + scan-loop wrapper).
- `src/curriculum/daemon.ts:25-141` (env knobs + invocation pattern).
- `scripts/014_workflow_checkpoints.sql` + `scripts/015_curriculum_tasks.sql` (schema constraints).
- `tests/orchestrator.test.ts` + `tests/health.test.ts` (canonical live-Supabase test pattern).
- Two sub-agent research dispatches via `delegate_task` (M4 foundation research + M5 scanner-state research) + two sub-agent oneshot smoke dispatches (one per Epic, prior to investing in full test suites).

---

## 3. DECISIONs (saved to project memory)

- **SCM-S30-D1** (id 12147): Deleted duplicate `agent_skills` row id=13 (`systematic-debugging`, project-scope, never invoked). GLOBAL row 20 remains. Triple-pinned DELETE predicate; auto-classifier required explicit in-session user authorization.
- **SCM-S30-D2** (id 12148): Deferred v2.1.2 npm publish — Phase 3 orchestrator improvement is internal worker-prompt only, no user-facing API delta. Bundle with next user-visible change.
- **SCM-S30-D3** (id 12149): Phase 3 Skill Discovery prelude + skill_applied synthesis contract validated end-to-end on a real `delegate_task` worker dispatch (MEMORY.md staleness audit). Worker called `request_skill`, reported `skill_applied: false` in synthesis (top match below JIT floor), gate green first try.
- **SCM-S30-D4** (id 12164): M4 Phase B verified end-to-end. 12 characterization tests + live smoke. Two schema gotchas surfaced and fixed (memory_chunks.embedding vector(768) NOT NULL caught at plan-time via smoke worker; memory_chunks.content_hash text NOT NULL caught at execution time via separate Foundation-First commit before commit-handler tests).
- **SCM-S30-D5** (id 12172): M5 rollback_repro verified end-to-end. 7 characterization tests + live smoke + 2 doc bugs fixed. ScannerConfig has 9 required camelCase fields (caught via smoke worker before any test code was written — saved 7 broken-compile rounds).

---

## 4. Hurdles + Solutions

- **Mission framing was wrong twice** (user's M4 + M5 prompts both framed as "build"; reality was "already shipped"). Caught at planning time via [Imperative 4 — Think Before Coding]: read the actual code before writing the plan. Outcome: pivoted both Epics to verify-not-build; surfaced explicitly to user for approval before writing any code. Saved an unknown but large amount of wasted implementation work.
- **Auto-classifier blocked the duplicate-row DELETE on first try** (no in-transcript authorization visible to the classifier). Surfaced as `AskUserQuestion`; user approved in plain chat; second attempt succeeded. Lesson: destructive shared-infra operations need user authorization in the actual user-typed transcript, not just AskUserQuestion answers.
- **Two NOT NULL constraints on memory_chunks** broke fixtures at execution time. `embedding vector(768)` caught at M4 plan-time (smoke worker hit it on the throwaway script); fixed in plan before Task 2 ran. `content_hash text` caught at M4 commit-handler test time when the `before` hook crashed all tests in the block. Both fixed in the fixture; second one shipped as a separate Foundation-First commit (`8fc5ffa`) per "No Entangled Commits".
- **ScannerConfig has 9 required fields, not 3.** My M5 plan assumed a partial `{projectId, rollbackThreshold, rollbackWindowDays}` literal — would have failed TypeScript on every test. Caught by the M5 smoke worker (surfaced exact field list); plan patched inline before any test code was written. Tests use a `makeCfg(overrides)` helper to keep call sites clean.
- **ARCHITECTURE.md had two real doc bugs** that the M5 research worker surfaced: status spelling (`'rolled_back'` vs reality `'rolledback'`) and target_path source (`steps[].path` vs reality `step_label`). Both included in the M5 Epic scope; user approved the inclusion. Fix shipped as `f4140c7`.

---

## 5. Files Changed

**New files (5):**
- `tests/fixtures/m4.ts` — per-test unique project_id namespace + throwaway chunk/backlog/checkpoint helpers + FK-safe cleanup.
- `tests/checkpoint.test.ts` — 12 M4 characterization tests across 4 describe blocks.
- `tests/curriculum-scanner.test.ts` — 7 M5 rollback_repro characterization tests.
- `scripts/smoke-m4.ts` — live M4 lifecycle smoke (`npm run smoke:m4`).
- `scripts/smoke-m5-rollback.ts` — live M5 rollback_repro smoke (`npm run smoke:m5-rollback`).
- `docs/specs/m4-checkpoints-phase-b.md` + `docs/specs/m5-rollback-repro.md` — plan docs (writing-plans discipline).

**Modified files (5):**
- `package.json` — added 2 test files to `npm test` enumeration; added `smoke:m4` and `smoke:m5-rollback` scripts.
- `ARCHITECTURE.md` — M4 Phase B status flip (line ~508); M5 rollback_repro status spelling + target_path source corrections (lines 556 + 576).
- `C:\Users\saeee\.claude\projects\.../memory/sovereign-orchestrator-protocol.md` — refreshed to v2.1.0 + Phase 3 deltas + `list_global_patterns` browse (4 surgical Edits in the boot phase).

**Cumulative commits this session (13):**
```
a6ffa92  docs: sync README + ARCHITECTURE after session_end re-run
f4140c7  docs(m5): correct status='rolledback' spelling + target_path source
8b0626a  test(m5): live smoke for rollback_repro
ec69f48  test(m5): characterize scanRollbackHotspots
5bf4874  test(m5): extend m4 fixtures
ce70d52  docs(m4): mark Phase B production-validated
22a2782  test(m4): add live-Supabase smoke script
578546c  test(m4): characterize checkpoint_list
8557972  test(m4): characterize checkpoint_rollback
1029351  test(m4): characterize checkpoint_commit
8fc5ffa  fix(test-fixtures): satisfy memory_chunks.content_hash NOT NULL
da2225c  test(m4): characterize checkpoint_create
605f786  test(m4): add fixtures for live-Supabase checkpoint tests
```

---

## 6. System State at Wrap

- **Test suite:** 98/98 pass (was 79 at session start; +19 from M4 + M5).
- **refactor_guard tsc gate:** ok (2976 ms).
- **Smokes:** `smoke:m4` PASS, `smoke:m5-rollback` PASS.
- **Migrations:** 18/18 applied, 0 pending.
- **Memory chunks corpus:** ~8020 rows.
- **agent_skills:** GLOBAL row 20 (`systematic-debugging`) remains as canonical; project-scope duplicate id 13 deleted.
- **MEMORY.md (hidden user-scope):** 94 tokens, lean — no purge needed.
- **CLAUDE.md:** 2631 tokens, well under the 10k bloat threshold.

---

## 7. Open Items / Loose Ends

- **Next M5 source:** `scanStaleCandidates` (refactor / stale-candidate auto-promote trigger) is the obvious Session 31 target — same verify+test pattern as rollback_repro should close the third curriculum source. The M5 research worker already mapped its signature (it lives alongside `scanRollbackHotspots` in `src/curriculum/scanner.ts` with the same `ScannerConfig` shape).
- **`scanTestGaps`** is the first M5 source — already in the scan loop but its test surface is different (depends on `coverage-summary.json` on disk, not Supabase row counts). Out of scope for the rollback_repro Epic; needs its own plan when ready.
- **v2.1.2 npm publish** remains deferred. Next user-visible API change is the natural trigger for a version bump.
- **Plan files** (`docs/specs/m4-checkpoints-phase-b.md` + `docs/specs/m5-rollback-repro.md`) are committed and live. They're a useful pattern — keep using `docs/specs/` for future Epic plans.

---

## 8. Sovereign Constitution Compliance

- ✅ **[Planning — Think Before Coding]:** Both Epics produced a writing-plans-discipline doc BEFORE any TS was written. Both surfaced "already shipped" findings during planning and proposed the verify-not-build pivot for explicit user approval before kicking off implementation.
- ✅ **[Execution Engine — Production-Ready Only]:** No placeholders, no TODOs in any new file. Every commit ships green tests. `confirm_verification` never called — gate evidence was direct test output.
- ✅ **[Surgical Editing]:** Doc fixes were 1-line Edits with explicit line:range citations. No restructuring. Existing code untouched (handlers, scanner, daemon, schema all read-only this session).
- ✅ **[Tokens Are Currency]:** All read-heavy research routed through `delegate_task` → 2-paragraph synthesis. Full ARCHITECTURE.md / scanner / checkpoint sources never loaded into orchestrator context. ctx_execute used for shell + analysis throughout. Orchestrator's own context stayed lean across two heavy Epics.
- ✅ **[Foundation First — No Broken Windows]:** M4's `content_hash` NOT NULL discovery shipped as its own commit (`8fc5ffa`) BEFORE the dependent test commit. No entangled commits anywhere in the 13-commit log.
- ✅ **[Sovereign Vetting]:** All 5 DECISIONs project-scope — none promoted to GLOBAL. The Cross-Project Test would fail for project-specific verification commits.
- ✅ **[Wrap-Up Ritual]:** `manage_backlog({action:"session_end"})` ran FIRST (commit `a6ffa92` auto-synced README + ARCHITECTURE), then this report, then commit, then next-session command.
- ✅ **[Strategic Context Policy]:** Four sub-agent dispatches this session (2 research + 2 oneshot smoke). All returned 2-paragraph syntheses. All honored Phase 3 contract (Skill Discovery + skill_applied:). No raw file dumps in orchestrator context.

---

## 9. Next-Session Command

See bottom of synthesis (chat output).
