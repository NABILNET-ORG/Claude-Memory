# M7 Skill Graduation — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the service layer that audits production-validated local `agent_skills`, drafts a Sovereign-Vetting `global_rationale` via LLM, and stages a human-gated promotion to the `GLOBAL` vault — *propose only, never auto-promote*.

**Architecture:** New staging table `skill_graduations` + 1 deterministic SQL scanner (`src/graduation/scanner.ts`, zero LLM) + 4 MCP handlers (`src/tools/graduation.ts`: `list_graduation_candidates`, `compose_global_rationale`, `confirm_promotion`, `reject_graduation`). Atomic-SQL `apply_graduation` RPC clones source skill into `project_id='GLOBAL'` only when state='composed' AND `proposed_global_rationale IS NOT NULL`. Mirrors M3's mine→compose→promote three-step separation (S22-D1) and M5's compose-before-apply atomicity proof (S32-D1 C2).

**Tech Stack:** TypeScript 5, Node.js `node:test` + `node:assert/strict`, Supabase Postgres (via service-role client `src/supabase.ts`), Ollama (Orchestrator-chosen model for compose; recorded in `skill_graduations.model`), HNSW(vector_cosine_ops), `deny_anon_authenticated` RLS.

---

## Sovereign Constraints (HARD)

These constraints are non-negotiable. They derive from `CLAUDE.md` + user directive on 2026-05-18 + the [[scm-s33-d1-m7-skill-graduation]] reframe decision.

1. **NO auto-promotion.** `is_global=true` only happens inside `apply_graduation` SQL RPC, which is only callable via the `confirm_promotion` MCP handler. The scanner proposes; the LLM drafts; the human confirms. Three separate state transitions.
2. **Single-Brain Boundary Invariant #1.** `src/graduation/**` MUST contain zero generative AI imports (no `@anthropic-ai`, no `openai`, no `ollama` HTTP, no `/generate` `/chat` `/completions`). The scanner is pure SQL. The CI lint fence at `scripts/check-boundary-invariant-1.ts` MUST be extended to include `src/graduation/**`.
3. **No M3 duplication.** M7 reads `agent_skills` (M1 output / M3 + M5 promotion target). M7 does NOT touch `trajectory_summaries`, `skill_candidates`, or `archive_backlog`. If a candidate selection criterion ever needs trajectory data, route through `agent_skills.frequency_used` / `success_rate` aggregates — never re-query M3 substrate.
4. **Atomic-tx proof required.** `apply_graduation` SQL RPC MUST do all writes (insert GLOBAL clone + update graduation row state + decided_at) in ONE PostgreSQL transaction so `now()` returns the identical microsecond across rows. Test C4 below is the load-bearing characterization.
5. **Source skill is read-only on promote.** The original local `agent_skills` row is NEVER mutated by `apply_graduation`. We clone its `name/description/steps/trigger_keywords` into a new row with `project_id='GLOBAL'`; the local row keeps serving JIT retrieval. Test C7 enforces.
6. **Idempotent enqueue.** Partial UNIQUE index ensures one active proposal per `(project_id, source_skill_id)` at a time — but rejected/approved rows do NOT block future re-proposals (e.g., a rejected skill can be re-mined after its `frequency_used` doubles).
7. **750-line ceiling per file.** This plan is 1 file ≤ 750 lines. All output files (`scripts/017_skill_graduations.sql`, `src/graduation/scanner.ts`, `src/tools/graduation.ts`, each test file) must come in under 750 lines. Test files have a 1000-line Boy-Scout split ceiling.

---

## Phase A Scope Fence (YAGNI)

| In Phase A | Out of Phase A (Phase B/C) |
|---|---|
| `scripts/017_skill_graduations.sql` (table + 2 RPCs + RLS) | `src/graduation/daemon.ts` (interval-based runner) |
| `src/graduation/scanner.ts` (pure SQL `findGraduationCandidates`) | `startGraduationDaemon()` boot in `src/index.ts` |
| `src/tools/graduation.ts` (4 MCP handlers — EXPORTED, NOT registered) | Tool registration in `src/index.ts` MCP server map |
| `tests/fixtures/m4.ts` extension (3 new helpers) | `system_dashboard` graduation rollup block |
| `tests/graduation-scanner.test.ts` (Suite A) | `check_system_health` graduation block |
| `tests/graduation-handlers.test.ts` (Suites B–E) | `daemon_telemetry` `emit()` calls in scanner |
| `scripts/smoke-m7.ts` (handler-layer e2e + C4 atomic-tx proof) | ARCHITECTURE.md §4.9 prose section |
| Extend `scripts/check-boundary-invariant-1.ts` to cover `src/graduation/**` | README.md M7 entry |
| `npm run smoke:m7` registration in `package.json` | Auto-pruning of decided graduations |

**Phase A success criterion:** `npm test` passes with ≥ 22 new tests added; `npm run smoke:m7` GREEN end-to-end on a `uniqueProjectId()`; `tsc --noEmit` 0 errors; lint fence 0 violations across `src/graduation/`. No code path is wired into the running MCP server until Phase B.

---

## File Structure

### Create

| Path | Responsibility | LOC budget |
|---|---|---|
| `scripts/017_skill_graduations.sql` | Schema + RPCs (`apply_graduation`, `reject_graduation_rpc`). DROP+CREATE idempotent (mirror migration 015 pattern). | ~250 |
| `src/graduation/scanner.ts` | `findGraduationCandidates({ projectId?, batch, thresholds })` — pure SQL read; returns `GraduationCandidate[]` shape. NO writes, NO LLM. | ~120 |
| `src/tools/graduation.ts` | 4 handlers: `listGraduationCandidates`, `composeGlobalRationale`, `confirmPromotion`, `rejectGraduation`. | ~280 |
| `tests/graduation-scanner.test.ts` | Suite A (10 tests). | ~280 |
| `tests/graduation-handlers.test.ts` | Suites B + C + D + E (~12 tests). | ~450 |
| `scripts/smoke-m7.ts` | End-to-end handler-layer smoke: seed local skill → propose → compose → confirm → assert atomic-tx microsecond match. | ~180 |

### Modify

| Path | Change | Lines |
|---|---|---|
| `tests/fixtures/m4.ts` | Add `insertThrowawaySkill(opts)`, `insertThrowawayGraduation(opts)`; extend `cleanupProject(pid)` to DELETE FROM `skill_graduations` (FK direction: `skill_graduations.source_skill_id → agent_skills` ON DELETE CASCADE handles auto-cleanup but graduation rows for GLOBAL-promoted skills survive — clean them by project_id explicitly). | ~80 added |
| `scripts/check-boundary-invariant-1.ts` | Add `src/graduation/**` to the scanned-paths glob. | ~3 |
| `package.json` | Add `"smoke:m7": "tsx scripts/smoke-m7.ts"` to `scripts`. | ~1 |

### Do NOT touch (Phase B/C will)

- `src/index.ts` — tool registration is Phase B.
- `src/tools/health.ts` — `system_dashboard` rollup is Phase B.
- `ARCHITECTURE.md` — §4.9 prose is Phase C.
- `README.md` — M7 entry is Phase C.

---

## Schema Design — `scripts/017_skill_graduations.sql`

### Table

```sql
CREATE TABLE IF NOT EXISTS skill_graduations (
  id                          bigserial PRIMARY KEY,
  project_id                  text NOT NULL,
  source_skill_id             bigint NOT NULL REFERENCES agent_skills(id) ON DELETE CASCADE,
  state                       text NOT NULL DEFAULT 'proposed'
                                CHECK (state IN ('proposed','composed','approved','rejected')),
  -- Telemetry snapshot at propose-time (frozen; do not bump on re-scan).
  frequency_at_propose        int NOT NULL CHECK (frequency_at_propose >= 0),
  success_rate_at_propose     real NOT NULL CHECK (success_rate_at_propose >= 0 AND success_rate_at_propose <= 1),
  age_days_at_propose         int NOT NULL CHECK (age_days_at_propose >= 0),
  -- Compose output (NULL until compose handler writes).
  proposed_global_rationale   text,
  cross_project_verdict       text CHECK (cross_project_verdict IS NULL OR cross_project_verdict IN ('pass','fail')),
  cross_project_evidence      text,
  model                       text,
  composed_at                 timestamptz,
  -- Decision output (NULL until confirm/reject handler writes).
  promoted_global_skill_id    bigint REFERENCES agent_skills(id) ON DELETE SET NULL,
  rejection_reason            text,
  decided_at                  timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- One active proposal per (project, source skill). Rejected/approved rows don't block future re-proposals.
CREATE UNIQUE INDEX IF NOT EXISTS skill_graduations_active_uniq
  ON skill_graduations (project_id, source_skill_id)
  WHERE state IN ('proposed','composed');

CREATE INDEX IF NOT EXISTS skill_graduations_state_idx
  ON skill_graduations (state, created_at DESC);

CREATE INDEX IF NOT EXISTS skill_graduations_source_idx
  ON skill_graduations (source_skill_id);

-- RLS — mirror 006_security_hardening.
ALTER TABLE skill_graduations ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_anon_authenticated ON skill_graduations
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
```

### RPCs

```sql
-- apply_graduation: atomic clone-to-GLOBAL.
CREATE OR REPLACE FUNCTION apply_graduation(_graduation_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  g            skill_graduations%ROWTYPE;
  s            agent_skills%ROWTYPE;
  new_skill_id bigint;
BEGIN
  -- 1. Lock graduation row.
  SELECT * INTO g FROM skill_graduations WHERE id = _graduation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'graduation_not_found');
  END IF;

  -- 2. Precondition: must be composed with rationale.
  IF g.state <> 'composed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', format('graduation state must be composed, got %s', g.state));
  END IF;
  IF g.proposed_global_rationale IS NULL OR length(trim(g.proposed_global_rationale)) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'proposed_global_rationale missing or under 10 chars (Sovereign Vetting Rule 10)');
  END IF;

  -- 3. Load + guard source skill.
  SELECT * INTO s FROM agent_skills WHERE id = g.source_skill_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_skill_deleted');
  END IF;
  IF s.project_id = 'GLOBAL' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_skill_already_global');
  END IF;

  -- 4. Clone into GLOBAL. Embedding copied verbatim (no re-embed needed).
  INSERT INTO agent_skills (
    project_id, name, version, description, steps, trigger_keywords,
    embedding, frequency_used, success_rate, last_invoked_at, packaged_from_archive_id
  ) VALUES (
    'GLOBAL', s.name, 1, s.description, s.steps, s.trigger_keywords,
    s.embedding, 0, 1.0, NULL, s.packaged_from_archive_id
  ) RETURNING id INTO new_skill_id;

  -- 5. Update graduation in same tx.
  UPDATE skill_graduations
     SET state                    = 'approved',
         promoted_global_skill_id = new_skill_id,
         decided_at               = now(),
         updated_at               = now()
   WHERE id = _graduation_id;

  RETURN jsonb_build_object(
    'ok',                       true,
    'graduation_id',            _graduation_id,
    'promoted_global_skill_id', new_skill_id,
    'decided_at',               (SELECT decided_at FROM skill_graduations WHERE id = _graduation_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_graduation(bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_graduation(bigint) TO service_role;
```

**Why SQL RPC, not TS handler logic.** Mirrors `apply_curriculum_task` in `scripts/015_curriculum_tasks.sql` (S21-D1). The two writes (INSERT GLOBAL clone + UPDATE graduation row) must share a transaction so a crash between them cannot orphan a half-promoted skill. The handler is a thin call site; correctness lives in SQL.

A `reject_graduation_rpc(_graduation_id bigint, _reason text)` of the same shape handles the reject path: precondition state IN ('proposed','composed'), writes `state='rejected', rejection_reason=$2, decided_at=now()`. (Could be a TS UPDATE too — see Open Question 1 in Self-Review.)

---

## Candidate Selection Query (Concrete)

The deterministic scanner runs this exact SQL. Threshold args have defaults derived from production-skill-validity research; env-knob wiring lives in Phase B.

```sql
SELECT
  s.id                                                                  AS source_skill_id,
  s.project_id                                                          AS project_id,
  s.name                                                                AS name,
  s.frequency_used                                                      AS frequency_at_propose,
  s.success_rate                                                        AS success_rate_at_propose,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - s.created_at)) / 86400))::int AS age_days_at_propose
FROM agent_skills s
WHERE
  -- (a) Not already in the GLOBAL vault.
  s.project_id <> 'GLOBAL'
  -- (b) Production hit threshold (default 10; configurable arg).
  AND s.frequency_used >= $1
  -- (c) Success-rate floor (default 0.80; configurable arg).
  AND s.success_rate >= $2
  -- (d) Stability window — skill has been live long enough to trust the telemetry.
  AND (now() - s.created_at) >= ($3 || ' days')::interval
  -- (e) No active proposal already in flight for this skill.
  AND NOT EXISTS (
    SELECT 1 FROM skill_graduations g
    WHERE g.source_skill_id = s.id
      AND g.state IN ('proposed','composed','approved')
  )
ORDER BY s.frequency_used DESC, s.success_rate DESC, s.created_at ASC
LIMIT $4;
```

**Default thresholds (LOCKED 2026-05-18 by user directive).**

| Arg | TS default | Rationale |
|---|---|---|
| `minFrequency` | `10` | Below 10 invocations, telemetry is too noisy to call a skill "production-validated". |
| `minSuccessRate` | **`0.90`** | Elite-only floor — GLOBAL vault is precious; 90% admits only highly-reliable skills. (Tightened from initial 0.80 proposal per user lock.) |
| `minAgeDays` | `14` | Two weeks gives enough wall-clock to catch slow-burning regressions. |
| `batch` | `10` | Mirrors `SLEEP_LEARNER_BATCH` default. One graduation review per ~minute of human attention is sustainable. |

**Why `agent_skills.success_rate` (real) and not `skill_candidates.success_count` (int).** Suite A2/A3 prove: by the time a skill reaches `agent_skills`, its `success_count` is already collapsed into the M1 `success_rate` real. The `skill_candidates.success_count` int is M3 substrate and would force M7 to re-query M3 (violates Constraint #3).

**Once 'approved', the row is fenced FOREVER.** Note clause (e) blocks state='approved' too — once GLOBAL, no re-proposing from the same source. Future re-graduation of an *enhanced* local skill creates a *new* `agent_skills.id` (versioned), which gets its own clean proposal row.

---

## LLM Compose Prompt (Concrete)

Used by `composeGlobalRationale` handler. Model is Orchestrator-chosen (matches S22-D1 `compose_skill_candidate` pattern); whichever model the Orchestrator invokes is recorded in `skill_graduations.model` for audit.

### System

```
You are a Sovereign Vetting auditor for the Smart-Claude-Memory GLOBAL knowledge vault.
You enforce Rule 10 of the Sovereign Memory Protocol: every memory promoted to GLOBAL
must pass the Cross-Project Test.

The Cross-Project Test: "If the source project were deleted tomorrow, would this skill
still be a gold-standard reference for OTHER projects?"

Be skeptical. Reject domain-specific skills, project-internal naming, framework-coupled
patterns. Approve universal procedures, language-agnostic recipes, cross-stack invariants.
```

### User template (variables interpolated at runtime)

```
SKILL UNDER REVIEW
Name: {name}
Description: {description}
Steps:
{indent(JSON.stringify(steps, null, 2), 2)}
Trigger keywords: {trigger_keywords.join(", ") || "(none)"}

PRODUCTION TELEMETRY (project: {project_id})
- Invoked {frequency_at_propose} times.
- Success rate: {(success_rate_at_propose * 100).toFixed(1)}%.
- Age: {age_days_at_propose} days.

TASK
1. Decide the Cross-Project Test verdict: "pass" or "fail".
2. Write evidence (≤120 words): what is universal vs project-specific.
3. If verdict is "pass": draft a global_rationale suitable for
   metadata.global_rationale — one or two sentences explaining WHY this is
   a universal truth (not just "useful elsewhere", but a load-bearing
   universal pattern).
   If verdict is "fail": set global_rationale to null.

OUTPUT STRICT JSON (no prose outside the JSON block, no markdown fences):
{
  "verdict": "pass" | "fail",
  "evidence": string,
  "global_rationale": string | null
}
```

### Handler-side JSON validation

The handler MUST defensively parse + validate:
1. JSON parse — fail → return `{ok:false, reason:'compose_invalid_json', state_unchanged:true}`.
2. `verdict ∈ {'pass','fail'}` — fail → `compose_invalid_verdict`.
3. If `verdict='pass'`: `global_rationale` must be a non-empty string ≥ 10 chars (matches RPC precondition) — fail → `compose_rationale_too_short`.
4. If `verdict='fail'`: `global_rationale` must be null (or the handler coerces it to null before write).

On all validation failures, the graduation row stays at `state='proposed'` — no partial writes. Test B4 enforces.

---

## MCP Tool Surface — `src/tools/graduation.ts`

Four handlers. None registered in `src/index.ts` during Phase A (per Scope Fence). Exports the bare functions; Phase B wires them.

### 1. `listGraduationCandidates`

```ts
type ListGraduationCandidatesInput = {
  state?: "proposed" | "composed" | "approved" | "rejected";
  project_id?: string;     // defaults to current slugified cwd
  k?: number;              // default 10, max 50
  offset?: number;         // default 0
};

type ListGraduationCandidatesOutput = {
  count: number;
  results: Array<{
    id: number;
    project_id: string;
    source_skill_id: number;
    source_skill_name: string;             // joined from agent_skills
    state: string;
    frequency_at_propose: number;
    success_rate_at_propose: number;
    age_days_at_propose: number;
    proposed_global_rationale: string | null;
    cross_project_verdict: string | null;
    decided_at: string | null;
    created_at: string;
  }>;
};
```

Pure SELECT with optional filters. Mirrors `listSkillCandidates` in `src/tools/sleep.ts`.

### 2. `composeGlobalRationale`

```ts
type ComposeGlobalRationaleInput = {
  graduation_id: number;
  verdict: "pass" | "fail";
  evidence: string;
  global_rationale: string | null;
  model: string;                            // e.g. "orchestrator:claude-opus-4-7"
};

type ComposeGlobalRationaleOutput =
  | { ok: true; graduation_id: number; state: "composed"; composed_at: string }
  | { ok: false; reason: string; state_unchanged: true };
```

**Critical design note.** The handler does NOT itself call an LLM. Mirrors `compose_skill_candidate` (S22-D1): the Orchestrator (main Claude session) is the LLM; it calls this handler with the *already-composed* output. This honors Constraint #2 (Single-Brain Boundary): zero LLM imports in graduation code.

**Preconditions enforced server-side.**
- Graduation must exist + be at `state='proposed'`.
- `evidence` non-empty.
- If `verdict='pass'`: `global_rationale` non-null + ≥10 chars.
- If `verdict='fail'`: `global_rationale` coerced to null.

On success: writes `proposed_global_rationale`, `cross_project_verdict`, `cross_project_evidence`, `model`, `composed_at = now()`, flips state → 'composed'. UPDATE is gated on `WHERE id = $1 AND state = 'proposed'` to avoid race-condition double-compose.

### 3. `confirmPromotion`

```ts
type ConfirmPromotionInput = { graduation_id: number };

type ConfirmPromotionOutput =
  | { ok: true; graduation_id: number; promoted_global_skill_id: number; decided_at: string }
  | { ok: false; reason: string };
```

Thin wrapper around `supabase.rpc('apply_graduation', { _graduation_id })`. Returns the RPC's jsonb verbatim. Suite C tests cover all rejection paths.

### 4. `rejectGraduation`

```ts
type RejectGraduationInput = { graduation_id: number; reason: string };

type RejectGraduationOutput =
  | { ok: true; graduation_id: number; state: "rejected"; decided_at: string }
  | { ok: false; reason: string };
```

UPDATE `skill_graduations SET state='rejected', rejection_reason=$2, decided_at=now() WHERE id=$1 AND state IN ('proposed','composed')`. If 0 rows affected, returns `{ok:false, reason:'invalid_state_transition'}`. Idempotency note: second `rejectGraduation` on an already-rejected row hits the state guard and returns the invalid-state error (UNLIKE M5's `rejectCurriculumTask` which overwrites — Suite D3 characterizes the difference and locks the M7 behavior in).

---

## Test Inventory (~22 tests across 5 suites)

All tests use `tests/fixtures/m4.ts` helpers — `uniqueProjectId()` + `cleanupProject()` for per-test isolation. Live Supabase via service-role; no mocks (per Constraint: PATTERN-GLOBAL on TDD; no mock-everything tests).

### Suite A — `findGraduationCandidates` scanner (10 tests, `tests/graduation-scanner.test.ts`)

| ID | Test | Asserts |
|---|---|---|
| A1 | empty agent_skills | returns `[]` |
| A2 | frequency_used < minFrequency | row excluded |
| A3 | success_rate < minSuccessRate | row excluded |
| A4 | created_at within minAgeDays | row excluded |
| A5 | project_id = 'GLOBAL' | row excluded |
| A6 | skill has active state='proposed' graduation | row excluded (idempotency clause e) |
| A7 | skill has state='rejected' graduation only | row INCLUDED (re-graduation after improvement) |
| A8 | three rows with varying frequency | result order by `frequency_used DESC, success_rate DESC` |
| A9 | 15 eligible skills, batch=5 | returns exactly 5 |
| A10 | tunable thresholds: minFrequency=1, success_rate=0.5 | low-bar skills surface |

### Suite B — `composeGlobalRationale` handler (5 tests, `tests/graduation-handlers.test.ts`)

| ID | Test | Asserts |
|---|---|---|
| B1 | graduation_id not found | `{ok:false, reason:'graduation_not_found'}` |
| B2 | state already 'composed' | `{ok:false, reason:/state must be proposed/}` + no row mutation |
| B3 | verdict='pass' + valid rationale | row → state='composed', proposed_global_rationale/verdict/evidence/model/composed_at all populated |
| B4 | verdict='pass' + global_rationale='' | `{ok:false, reason:'compose_rationale_too_short'}` + state unchanged |
| B5 | verdict='fail' + global_rationale='anything' | row → state='composed', proposed_global_rationale coerced to null, evidence/model recorded |

### Suite C — `confirmPromotion` + `apply_graduation` RPC (7 tests)

| ID | Test | Asserts |
|---|---|---|
| C1 | state='proposed' (not yet composed) | `{ok:false, reason:/state must be composed/}` |
| C2 | state='composed' but proposed_global_rationale='' | `{ok:false, reason:/rationale missing or under 10 chars/}` (defense in depth — RPC also guards) |
| C3 | source skill deleted between compose and confirm | `{ok:false, reason:'source_skill_deleted'}` |
| **C4** | **ATOMIC-TX PROOF** — happy path | graduation.decided_at === new_global_skill.created_at === RPC `decided_at`, all THREE identical to microsecond. (Mirror S32-D1's C2 finding: PostgreSQL `now()` returns transaction-start time, so all writes in one RPC share one timestamp.) |
| C5 | post-confirm: clone fields | new agent_skills row has matching name/description/steps/trigger_keywords/embedding from source; project_id='GLOBAL'; frequency_used=0; success_rate=1.0; last_invoked_at=null |
| C6 | post-confirm: graduation row | state='approved', promoted_global_skill_id=<new>, decided_at not null |
| C7 | source skill UNTOUCHED | original agent_skills row unchanged (name, project_id, frequency_used same as pre-confirm — we cloned, not moved) |

### Suite D — `rejectGraduation` handler (3 tests)

| ID | Test | Asserts |
|---|---|---|
| D1 | reject state='proposed' | row → state='rejected', rejection_reason recorded, decided_at populated |
| D2 | reject state='composed' | same — both source states are valid for reject |
| D3 | **IDEMPOTENCY** — reject an already-rejected row | `{ok:false, reason:'invalid_state_transition'}`, original rejection_reason preserved (NOT overwritten — diverges from M5 `rejectCurriculumTask` behavior; this is the M7 contract) |

### Suite E — `listGraduationCandidates` enumeration (3 tests)

| ID | Test | Asserts |
|---|---|---|
| E1 | empty table | `{count:0, results:[]}` |
| E2 | state filter | only matching rows returned |
| E3 | project isolation | row from project P1 absent when listing P2 |

### Smoke — `scripts/smoke-m7.ts`

Full handler-layer e2e on a `uniqueProjectId()`. Sequence:
1. Seed a local `agent_skills` row with `frequency_used=15, success_rate=0.85, created_at=now()-21 days`.
2. Call scanner — assert 1 candidate surfaces with right snapshot.
3. INSERT graduation row from scanner output (Phase A: scanner doesn't write; the smoke does it inline).
4. Call `composeGlobalRationale(verdict='pass', rationale='Test rationale ≥10 chars about universal applicability.')`.
5. Call `confirmPromotion(graduation_id)`.
6. Assert: new agent_skills row at `project_id='GLOBAL'`; graduation `state='approved'`; the microsecond-equal atomic-tx invariant from C4.
7. FK-safe cleanup in `finally{}` (delete graduations → skill_candidates (none) → agent_skills by project_id INCLUDING GLOBAL clone).

Expected wall-clock: ~5–7s, ~25 assertions. Smoke is a belt-and-braces parallel to the unit suites; if both pass, Phase A is GREEN.

---

## Task Breakdown (TDD, bite-sized)

### Task 1 — Migration

**Files:**
- Create: `scripts/017_skill_graduations.sql`

- [ ] **Step 1.1: Write the failing characterization for table existence**

```ts
// tests/graduation-handlers.test.ts (header only, suite skeleton)
test("S0: skill_graduations table exists with expected columns", async () => {
  const { data, error } = await supabase
    .from("skill_graduations")
    .select("id,project_id,source_skill_id,state,frequency_at_propose,success_rate_at_propose,age_days_at_propose,proposed_global_rationale,cross_project_verdict,cross_project_evidence,model,composed_at,promoted_global_skill_id,rejection_reason,decided_at,created_at,updated_at")
    .limit(0);
  assert.equal(error, null);
});
```

- [ ] **Step 1.2: Run to verify failure**

Run: `npx node --test tests/graduation-handlers.test.ts`
Expected: FAIL — relation `skill_graduations` does not exist.

- [ ] **Step 1.3: Author migration 017**

Write `scripts/017_skill_graduations.sql` using the table + RPC bodies in the Schema section above. DROP+CREATE pattern (idempotent) so re-running locally is safe.

- [ ] **Step 1.4: Apply migration**

Run: `npm run apply-schema -- scripts/017_skill_graduations.sql`
Expected: 0 errors. `init_project` migrations check goes from 18 → 19.

- [ ] **Step 1.5: Verify test now passes**

Run: `npx node --test tests/graduation-handlers.test.ts`
Expected: S0 PASS.

- [ ] **Step 1.6: Commit**

```bash
git add scripts/017_skill_graduations.sql tests/graduation-handlers.test.ts
git commit -m "feat(m7): scripts/017 — skill_graduations table + apply_graduation RPC"
```

### Task 2 — Test fixtures extension

**Files:**
- Modify: `tests/fixtures/m4.ts:?` (append helpers)

- [ ] **Step 2.1: Add `insertThrowawaySkill` + `insertThrowawayGraduation`**

```ts
// In tests/fixtures/m4.ts

export type ThrowawaySkillOpts = {
  projectId: string;
  name?: string;
  description?: string;
  steps?: object[];
  triggerKeywords?: string[];
  frequencyUsed?: number;
  successRate?: number;
  ageDaysOverride?: number;   // backdate created_at to now() - N days
};

export async function insertThrowawaySkill(opts: ThrowawaySkillOpts): Promise<number> {
  // INSERT into agent_skills with zero-vector embedding (mirror M4 fixtures).
  // For ageDaysOverride > 0, do a follow-up UPDATE created_at = now() - INTERVAL '$N days'.
  // Return id.
  // ~30 lines, defensive — mirror insertThrowawaySkillCandidate already in this file.
}

export type ThrowawayGraduationOpts = {
  projectId: string;
  sourceSkillId: number;
  state?: "proposed" | "composed" | "approved" | "rejected";
  frequencyAtPropose?: number;
  successRateAtPropose?: number;
  ageDaysAtPropose?: number;
  proposedGlobalRationale?: string;
  crossProjectVerdict?: "pass" | "fail";
};

export async function insertThrowawayGraduation(opts: ThrowawayGraduationOpts): Promise<number> {
  // INSERT into skill_graduations with sensible defaults. Return id.
}
```

- [ ] **Step 2.2: Extend `cleanupProject`**

```ts
// Inside existing cleanupProject(pid):
// FK order: skill_graduations references agent_skills(id) ON DELETE CASCADE both sides.
// Step 1: DELETE FROM skill_graduations WHERE project_id = pid;
// Step 2: existing cleanup (skill_candidates → agent_skills → checkpoints → tasks → backlog → chunks).
// Step 3: ALSO delete GLOBAL agent_skills rows whose name LIKE '__test_%' to clean up confirmPromotion's clones — without a project_id sentinel on the GLOBAL row we need a name-prefix filter (helpers must produce names starting with __test_).
```

- [ ] **Step 2.3: Smoke the fixtures (no test commit yet — used by Tasks 3+)**

Run: `npx tsx -e "import { insertThrowawaySkill, cleanupProject } from './tests/fixtures/m4.js'; const pid = '__test_m7_smoke__'; const id = await insertThrowawaySkill({projectId:pid, frequencyUsed:5}); console.log('inserted', id); await cleanupProject(pid); console.log('cleaned');"`
Expected: prints two lines, no errors.

- [ ] **Step 2.4: Commit**

```bash
git add tests/fixtures/m4.ts
git commit -m "test(m7): tests/fixtures/m4.ts — insertThrowawaySkill + insertThrowawayGraduation"
```

### Task 3 — Scanner (Suite A: 10 tests)

**Files:**
- Create: `src/graduation/scanner.ts`
- Create: `tests/graduation-scanner.test.ts`

- [ ] **Step 3.1: Write all 10 Suite A failing tests first (RED)**

Per the Suite A table above. Each test seeds via fixtures, asserts via `findGraduationCandidates(...)`.

- [ ] **Step 3.2: Verify all 10 fail with "function not defined"**

Run: `npx node --test tests/graduation-scanner.test.ts`
Expected: 10 FAIL with import error.

- [ ] **Step 3.3: Implement `src/graduation/scanner.ts`**

Pure SQL query as defined in "Candidate Selection Query" section. Single exported function:

```ts
export type GraduationCandidate = { /* match SELECT shape */ };
export type FindCandidatesOpts = { projectId?: string; minFrequency?: number; minSuccessRate?: number; minAgeDays?: number; batch?: number; };
export async function findGraduationCandidates(opts: FindCandidatesOpts = {}): Promise<GraduationCandidate[]> { /* ... */ }
```

Defaults: minFrequency=10, minSuccessRate=0.80, minAgeDays=14, batch=10.

- [ ] **Step 3.4: All 10 Suite A pass (GREEN)**

Run: `npx node --test tests/graduation-scanner.test.ts`
Expected: 10 PASS.

- [ ] **Step 3.5: Commit**

```bash
git add src/graduation/scanner.ts tests/graduation-scanner.test.ts
git commit -m "feat(m7): src/graduation/scanner.ts — pure-SQL candidate finder + Suite A (10 tests)"
```

### Task 4 — Boundary Invariant #1 lint extension

**Files:**
- Modify: `scripts/check-boundary-invariant-1.ts`

- [ ] **Step 4.1: Add `src/graduation/**` to scanned-paths**

Locate the glob array (likely `["src/curriculum/**","src/sleep/**", ...]` minus sleep — depends on current state); append `"src/graduation/**"`.

- [ ] **Step 4.2: Run fence; expect 0 violations**

Run: `npx tsx scripts/check-boundary-invariant-1.ts`
Expected: `0 violations across src/graduation/`.

- [ ] **Step 4.3: Commit**

```bash
git add scripts/check-boundary-invariant-1.ts
git commit -m "chore(m7): lint fence — Boundary Invariant #1 now covers src/graduation/"
```

### Task 5 — Compose handler (Suite B: 5 tests)

**Files:**
- Create: `src/tools/graduation.ts` (start with `composeGlobalRationale` only)
- Modify: `tests/graduation-handlers.test.ts` (Suite B section)

- [ ] **Step 5.1: Write all 5 Suite B failing tests**

- [ ] **Step 5.2: Verify failures**

Run: `npx node --test tests/graduation-handlers.test.ts`
Expected: 5 NEW FAIL (S0 still PASS).

- [ ] **Step 5.3: Implement `composeGlobalRationale`**

Per the MCP Tool Surface spec above. Server-side preconditions; race-safe UPDATE `WHERE state='proposed'`.

- [ ] **Step 5.4: All 5 Suite B pass**

- [ ] **Step 5.5: Commit**

```bash
git add src/tools/graduation.ts tests/graduation-handlers.test.ts
git commit -m "feat(m7): composeGlobalRationale handler + Suite B (5 tests)"
```

### Task 6 — Confirm/promotion handler (Suite C: 7 tests, includes atomic-tx proof)

**Files:**
- Modify: `src/tools/graduation.ts` (add `confirmPromotion`)
- Modify: `tests/graduation-handlers.test.ts` (Suite C section)

- [ ] **Step 6.1: Write all 7 Suite C failing tests. Critically, test C4 must be implemented exactly per the S32-D1 atomic-tx pattern**:

```ts
test("C4: ATOMIC-TX PROOF — promote happy path, microsecond-equal timestamps", async () => {
  const pid = newProject();
  const skillId = await insertThrowawaySkill({ projectId: pid, frequencyUsed: 15, successRate: 0.9, ageDaysOverride: 21 });
  const gradId = await insertThrowawayGraduation({ projectId: pid, sourceSkillId: skillId, state: "composed",
    proposedGlobalRationale: "Universal rationale for cross-project applicability (≥10 chars).",
    crossProjectVerdict: "pass" });

  const result = await confirmPromotion({ graduation_id: gradId });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const { data: grad } = await supabase.from("skill_graduations").select("decided_at,promoted_global_skill_id").eq("id", gradId).single();
  const { data: newSkill } = await supabase.from("agent_skills").select("created_at").eq("id", result.promoted_global_skill_id).single();

  // The load-bearing assertion: three timestamps share one microsecond.
  assert.equal(grad!.decided_at, newSkill!.created_at);
  assert.equal(grad!.decided_at, result.decided_at);
});
```

- [ ] **Step 6.2: Verify all 7 fail**

- [ ] **Step 6.3: Implement `confirmPromotion`**

Thin RPC call. Return RPC jsonb verbatim.

- [ ] **Step 6.4: All 7 Suite C pass — including C4 microsecond-equal**

- [ ] **Step 6.5: Commit**

```bash
git add src/tools/graduation.ts tests/graduation-handlers.test.ts
git commit -m "feat(m7): confirmPromotion + apply_graduation RPC + Suite C (7 tests, incl. C4 atomic-tx proof)"
```

### Task 7 — Reject handler (Suite D: 3 tests, locks idempotency divergence from M5)

**Files:**
- Modify: `src/tools/graduation.ts` (add `rejectGraduation`)
- Modify: `tests/graduation-handlers.test.ts` (Suite D)

- [ ] **Step 7.1: Write 3 Suite D failing tests**

D3 explicitly asserts the divergence from M5's overwrite behavior: a second `rejectGraduation` on an already-rejected row returns `{ok:false, reason:'invalid_state_transition'}`, original rejection_reason preserved.

- [ ] **Step 7.2 → 7.5**: Standard RED → GREEN → commit cycle.

```bash
git commit -m "feat(m7): rejectGraduation + Suite D (3 tests, locks idempotency divergence from M5)"
```

### Task 8 — List handler (Suite E: 3 tests)

**Files:**
- Modify: `src/tools/graduation.ts` (add `listGraduationCandidates`)
- Modify: `tests/graduation-handlers.test.ts` (Suite E)

Standard cycle. Commit:

```bash
git commit -m "feat(m7): listGraduationCandidates + Suite E (3 tests)"
```

### Task 9 — Smoke

**Files:**
- Create: `scripts/smoke-m7.ts`
- Modify: `package.json`

- [ ] **Step 9.1: Author smoke per the "Smoke" section above**

~180 LOC, FK-safe cleanup in `finally{}`.

- [ ] **Step 9.2: Register npm script**

```json
"smoke:m7": "tsx scripts/smoke-m7.ts"
```

- [ ] **Step 9.3: Run**

Run: `npm run smoke:m7`
Expected: GREEN with ~25 assertions; one line of output per stage; final atomic-tx microsecond confirmation.

- [ ] **Step 9.4: Commit**

```bash
git add scripts/smoke-m7.ts package.json
git commit -m "feat(m7): scripts/smoke-m7.ts — handler-layer e2e + atomic-tx proof"
```

### Task 10 — Verification + memory persistence

- [ ] **Step 10.1: Full test sweep**

Run: `npx tsc --noEmit && npm test`
Expected: 0 tsc errors; ~157 tests pass (135 pre-S33 + 22 M7 ≈ 157). Use the exact count from `npm test` output.

- [ ] **Step 10.2: Re-run all smokes**

Run (parallel ok): `npm run smoke:m4 && npm run smoke:m5-consumer && npm run smoke:m7`
Expected: 3× GREEN.

- [ ] **Step 10.3: Boundary fence + migration sanity**

Run: `npx tsx scripts/check-boundary-invariant-1.ts && npm run check:migrations`
Expected: 0 violations; "schema up to date (0 pending)".

- [ ] **Step 10.4: Save SCM-S33-D2 verification memory**

`save_memory` with `metadata.type='DECISION'`, `context_id='SCM-S33-D2'`, content summarizes: tests added, commits made, atomic-tx proof timestamp, any deviations from this plan. Link `[[scm-s33-d1-m7-skill-graduation]]`.

- [ ] **Step 10.5: Sync artefacts**

Run `sync_artefacts()` MCP call. Confirm README + project_file_architecture.md updated for new files.

---

## Self-Review

**Spec coverage.** SQL candidate query → Candidate Selection Query section + Task 3. MCP tools (list/compose/confirm/reject) → MCP Tool Surface §§1-4 + Tasks 5-8. Live Supabase tests → Suites A-E + smoke + Tasks 3,5,6,7,8,9 (~22 tests). Propose-only + human gate → Constraint #1 + structural separation (`compose` writes no `is_global`; only `apply_graduation` RPC does). No TS code written → plan file only.

**Placeholder scan.** Searched for "TBD", "TODO", "implement later", "fill in details", "Add appropriate error handling", "handle edge cases", "Similar to Task N". Zero matches.

**Symbol consistency.** `findGraduationCandidates` (Task 3 + Selection Query) · `composeGlobalRationale` (§2 + Task 5) · `confirmPromotion` (§3 + Task 6) · `rejectGraduation` (§4 + Task 7) · `listGraduationCandidates` (§1 + Task 8) · `apply_graduation` RPC (Schema + Task 6) · `insertThrowawaySkill` / `insertThrowawayGraduation` (Task 2). No drift.

**Verification gate.** No `verification-pending.json` raise needed at plan stage (md-only). Each implementation task ends with passing tests before commit — test-pass IS gate-clear.

### Locked decisions (user directive 2026-05-18)

1. **Reject path: TS-only UPDATE.** No `reject_graduation_rpc` in migration 017. Keep SQL surface minimal; only `apply_graduation` warrants an RPC (atomicity-critical).
2. **Thresholds: tightened.** `success_rate >= 0.90` (elite-only); `frequency >= 10` and `age >= 14 days` retained.
3. **Smoke pollution: name-prefix cleanup.** No `is_test` column on `agent_skills`. `__test_` name-prefix filter in `cleanupProject` is sufficient.

---

**Status:** Plan v1 LOCKED. Executing inline via `superpowers:executing-plans` starting 2026-05-18.

