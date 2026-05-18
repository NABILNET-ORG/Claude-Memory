# M5 Curriculum Scanner — `scanStaleCandidates` Verification & Test Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (Inline Execution chosen by user for the prior two Epics this session) or `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close M5 Curriculum Scanner test coverage end-to-end by adding characterization tests + a live smoke for `scanStaleCandidates` — the third (and last) curriculum source. This is the M3 auto-promote trigger surface: stale `skill_candidates` rows in state `'mined'` with `frequency ≥ minFreq` and `age ≥ staleCandidateMinAgeDays` become `curriculum_tasks` rows of kind `'refactor'` with `linked_candidate_id` set, which the Orchestrator later applies via `apply_curriculum_task` (auto-firing `promote_candidate_to_skill` in the same SQL transaction).

**Architecture:** Black-box tests at the scanner function boundary (`scanStaleCandidates(cfg)` in `src/curriculum/scanner.ts:266-320`), hitting live Supabase under unique per-test `project_id` namespaces. A new `insertThrowawaySkillCandidate()` fixture seeds `skill_candidates` rows with arbitrary `state`, `frequency`, `created_at`, and `proposed_name`. **Tests STRICTLY scope to enqueue behavior — never call `apply_curriculum_task`** because that would fire the M3 auto-promote into `agent_skills` (the GLOBAL skill vault), which is shared production state we must not mutate from a test.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict` via tsx, Supabase JS service-role, existing `EnqueueResult` shape `{source, scanned, enqueued, skipped, errored}`. Reuses Session 30 fixture `tests/fixtures/m4.ts` + `makeCfg()` helper pattern in `tests/curriculum-scanner.test.ts`.

---

## ⚠ Mission Scope Pivot (read before starting)

Same pattern as M5 rollback_repro: the scanner is **already shipped**. Discovery via Phase 1 Explore:

| Artifact | Status | Evidence |
|---|---|---|
| `scanStaleCandidates(cfg)` | **Production code, lines 266-320** | `src/curriculum/scanner.ts` — queries `skill_candidates WHERE state='mined' AND frequency >= cfg.minFreq AND created_at <= ageCutoff` where `ageCutoff = now() - staleCandidateMinAgeDays days`. Calls `enqueue_curriculum_task` with `linkedCandidateId: row.id`. Reads `id, project_id, pattern_hash, proposed_name, frequency, success_count, created_at` (line 279). |
| Daemon wiring | **Live in scan loop** | Daemon calls `scanStaleCandidates` after `scanRollbackHotspots`. Env var: `CURRICULUM_STALE_CANDIDATE_MIN_AGE_DAYS` (default 7) at `daemon.ts:98`. |
| `tests/curriculum-scanner.test.ts` | **Has 1 describe block** | Only `scanRollbackHotspots — rollback_repro source` exists (commit `ec69f48`). NO `scanStaleCandidates` block. |
| `scripts/smoke-m5-stale.ts` | **DOES NOT EXIST** | Only `smoke-m5-rollback.ts` was added this session. |
| `insertThrowawaySkillCandidate` helper | **DOES NOT EXIST** | `tests/fixtures/m4.ts` exports `uniqueProjectId`/`insertThrowawayChunk`/`insertThrowawayBacklogRow`/`insertThrowawayCheckpoint`/`cleanupProject` only. |

**Doc/code drift findings (smoke-confirmed Session 30):**
- `r.source === 'stale_candidate'` (string literal). NOT 'refactor', NOT 'stale'.
- **`target_path` is `` `skill_candidate:${pattern_hash}` ``, NOT `proposed_name`** (scanner.ts:299). Scanner deliberately refuses to invent filesystem paths; the deterministic stable identifier is `pattern_hash` prefixed with `skill_candidate:`. `proposed_name` lands in `signal_source.proposed_name` JSONB instead. **This is a real ARCHITECTURE.md doc drift** — Task 11 fixes it.
- `kind === 'refactor'` (the discriminator on `curriculum_tasks.kind` CHECK constraint).
- `rationale` shape: `` `mined candidate freq=${freq}, success=${success}, age>${minAgeDays}d` ``.
- ARCHITECTURE.md §557 says `frequency ≥ 5`. Daemon `DEFAULT_MIN_FREQ=3` — likely editorial recommendation, not enforced floor. Task 1 audit confirms; Task 11 amends if needed.

**Therefore this Epic = verify + add fixture + add 7 characterization tests + 1 smoke + optionally fix 1 doc drift line.** Same playbook as Sessions 30's M4 Phase B and M5 rollback_repro Epics.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `tests/fixtures/m4.ts` | **MODIFY** | Add `insertThrowawaySkillCandidate(projectId, opts)` helper + add `skill_candidates` delete to `cleanupProject` in FK-safe order. ~50 lines added. |
| `tests/curriculum-scanner.test.ts` | **MODIFY** | Add a second `describe("scanStaleCandidates — refactor source", ...)` block with 7 tests + an extension to the existing `makeCfg` helper (already has `staleCandidateMinAgeDays` — just need to surface it as an override param). ~220 lines added. |
| `scripts/smoke-m5-stale.ts` | **CREATE** | Live end-to-end: insert 3 stale candidates (state='mined', freq≥minFreq, age>window) → call `scanStaleCandidates` → assert curriculum_tasks row of kind='refactor' with `linked_candidate_id` set + `target_path` = proposed_name. Cleans up always. ~110 lines. |
| `package.json` | **MODIFY** | Add `"smoke:m5-stale": "tsx scripts/smoke-m5-stale.ts"` next to existing smoke entries. |
| `ARCHITECTURE.md` | **MAYBE MODIFY** | Only if Task 1 surfaces a real doc drift (e.g. `frequency ≥ 5` vs daemon default 3). Surgical 1-line Edit if needed. |
| `src/curriculum/scanner.ts` | **DO NOT TOUCH** | Read-only. Any production bug = separate fix commit. |
| `src/curriculum/daemon.ts` | **DO NOT TOUCH** | Same. |

---

## Read-First References

Read once before Task 1:
- `src/curriculum/scanner.ts:266-320` (the function under test)
- `src/curriculum/scanner.ts:30-90` (the `enqueue` wrapper + EnqueueResult shape — same one used by rollback_repro tests)
- `src/curriculum/daemon.ts:85-120` (env var resolution for `staleCandidateMinAgeDays` + `minFreq`)
- `scripts/012_sleep_learning.sql` (skill_candidates schema — note NOT NULL columns: `project_id`, `pattern_hash`, `source_summary_ids`, `source_backlog_ids`)
- `scripts/015_curriculum_tasks.sql` (curriculum_tasks — partial unique on `(project_id, target_path, kind) WHERE status='queued'` applies to kind='refactor' the same way it applies to 'rollback_repro')
- `tests/fixtures/m4.ts` (the helpers we extend)
- `tests/curriculum-scanner.test.ts` (the file we extend — note the existing `makeCfg` helper)

---

## Task 1: Audit `scanStaleCandidates` body vs ARCHITECTURE.md spec (read-only)

**Files:**
- Read: `src/curriculum/scanner.ts:266-320`
- Read: `src/curriculum/daemon.ts:85-120`
- Read: `scripts/012_sleep_learning.sql`
- Read: ARCHITECTURE.md §M5 (around line 557)

- [ ] **Step 1: Read `scanner.ts:266-320`** — confirm the SQL filter is `state='mined' AND frequency >= cfg.minFreq AND created_at <= (now() - cfg.staleCandidateMinAgeDays days)`. Note exactly which column becomes `target_path` in the enqueue call (Explore synthesis says it's `proposed_name`).

- [ ] **Step 2: Read `scanner.ts:30-90`** — confirm `enqueue_curriculum_task` RPC takes `linkedCandidateId` as the 7th positional param. Confirm the RPC is the same one rollback_repro uses (single shared enqueue path means dedup behavior is identical).

- [ ] **Step 3: Read `daemon.ts:85-120`** — confirm env vars + defaults: `CURRICULUM_MIN_FREQ` (default 3), `CURRICULUM_STALE_CANDIDATE_MIN_AGE_DAYS` (default 7). Note whether the daemon enforces a minimum-of-5 floor on top of cfg.minFreq, OR whether the spec "≥5" is just an editorial recommendation.

- [ ] **Step 4: Read `012_sleep_learning.sql`** — capture skill_candidates schema: PK `id bigserial`, NOT NULL columns `project_id`, `pattern_hash`, `source_summary_ids bigint[]`, `source_backlog_ids bigint[]`, defaults on `frequency`/`success_count`/`state`/timestamps. Unique `(project_id, pattern_hash)`. Also confirm whether `proposed_name` is nullable (the worker said scanner SELECTs it, but doesn't say if it's required).

- [ ] **Step 5: Read ARCHITECTURE.md §557** — capture the exact spec wording and confirm whether the doc + code agree on (a) the frequency threshold value, (b) the age threshold value, (c) the state filter value, (d) the target_path source.

- [ ] **Step 6: Scratch audit note (no commit)** — one paragraph summarizing the answers to steps 1-5. Flag any drift between doc and code that warrants a Task 11 Edit (or close it explicitly: "doc and code agree").

> **If reading surfaces a real production bug** (e.g. the scanner queries `state='promoted'` instead of `'mined'`): STOP and surface to the Orchestrator. Do not write tests around buggy code.

---

## Task 2: Extend `tests/fixtures/m4.ts` with `insertThrowawaySkillCandidate`

**Files:**
- Modify: `tests/fixtures/m4.ts` (append helper + update cleanup)

- [ ] **Step 1: Add the new helper at the end of the file**

```typescript
export type ThrowawaySkillCandidateOpts = {
  // pattern_hash defaults to a uuid-derived value so tests don't collide
  // on the (project_id, pattern_hash) unique constraint.
  patternHash?: string;
  state?: "mined" | "promoted" | "rejected";
  frequency?: number;
  successCount?: number;
  proposedName?: string | null;
  // ISO timestamp string. When omitted, server default `now()` is used.
  // Use to test the staleCandidateMinAgeDays window: pass an old timestamp
  // to verify the scanner picks up sufficiently-aged candidates.
  createdAt?: string;
};

export async function insertThrowawaySkillCandidate(
  projectId: string,
  opts: ThrowawaySkillCandidateOpts = {},
): Promise<number> {
  const patternHash = opts.patternHash ?? `m5_test_${randomUUID().slice(0, 12)}`;
  const row: Record<string, unknown> = {
    project_id: projectId,
    pattern_hash: patternHash,
    source_summary_ids: [],
    source_backlog_ids: [],
    state: opts.state ?? "mined",
    frequency: opts.frequency ?? 1,
    success_count: opts.successCount ?? 0,
    proposed_name: opts.proposedName ?? `__m5_test_${patternHash.slice(-8)}`,
  };
  if (opts.createdAt !== undefined) {
    row.created_at = opts.createdAt;
  }
  const { data, error } = await supabase
    .from("skill_candidates")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertThrowawaySkillCandidate failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id;
}
```

- [ ] **Step 2: Update `cleanupProject` to also wipe `skill_candidates`**

`curriculum_tasks.linked_candidate_id` FKs to `skill_candidates(id)`. The existing cleanup already deletes curriculum_tasks first, so skill_candidates can safely go right after curriculum_tasks (before workflow_checkpoints). Replace:

```typescript
export async function cleanupProject(projectId: string): Promise<void> {
  // Order matters: curriculum_tasks first (FKs to workflow_checkpoints via
  // linked_checkpoint_id), then workflow_checkpoints (FKs to memory_chunks
  // via source_chunk_id), then cloud_backlog, then memory_chunks.
  await supabase.from("curriculum_tasks").delete().eq("project_id", projectId);
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
  await supabase.from("cloud_backlog").delete().eq("project_id", projectId);
  await supabase.from("memory_chunks").delete().eq("project_id", projectId);
}
```

With:

```typescript
export async function cleanupProject(projectId: string): Promise<void> {
  // Order matters: curriculum_tasks first (FKs to workflow_checkpoints via
  // linked_checkpoint_id AND skill_candidates via linked_candidate_id),
  // then skill_candidates, then workflow_checkpoints, then cloud_backlog,
  // then memory_chunks.
  await supabase.from("curriculum_tasks").delete().eq("project_id", projectId);
  await supabase.from("skill_candidates").delete().eq("project_id", projectId);
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
  await supabase.from("cloud_backlog").delete().eq("project_id", projectId);
  await supabase.from("memory_chunks").delete().eq("project_id", projectId);
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: M4 + M5 rollback_repro regression check (no skill_candidates used in those — both should still be 12/7)**

```bash
node --import tsx --no-warnings --test tests/checkpoint.test.ts
node --import tsx --no-warnings --test tests/curriculum-scanner.test.ts
```

Expected: 12/12 + 7/7 still pass.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/m4.ts
git commit -m "test(m5): extend fixtures with insertThrowawaySkillCandidate + skill_candidates cleanup"
```

---

## Task 3: Extend `makeCfg` helper in `tests/curriculum-scanner.test.ts` to accept `minFreq` / `staleCandidateMinAgeDays` overrides

**Files:**
- Modify: `tests/curriculum-scanner.test.ts`

- [ ] **Step 1: Read the existing `makeCfg` definition (lines ~25-45 of the file)**. It currently accepts `projectId` / `rollbackThreshold` / `rollbackWindowDays` overrides.

- [ ] **Step 2: Extend the override type and the function body to accept `minFreq` and `staleCandidateMinAgeDays`**

Replace the existing `makeCfg`:

```typescript
function makeCfg(overrides: {
  projectId?: string;
  rollbackThreshold?: number;
  rollbackWindowDays?: number;
} = {}) {
  return {
    projectId: overrides.projectId ?? projectId,
    workspace: process.cwd(),
    minFreq: 3,
    ttlDays: 14,
    testGapCoveragePctCeiling: 80,
    testGapMinLines: 5,
    rollbackThreshold: overrides.rollbackThreshold ?? 3,
    rollbackWindowDays: overrides.rollbackWindowDays ?? 30,
    staleCandidateMinAgeDays: 30,
  };
}
```

With:

```typescript
function makeCfg(overrides: {
  projectId?: string;
  rollbackThreshold?: number;
  rollbackWindowDays?: number;
  minFreq?: number;
  staleCandidateMinAgeDays?: number;
} = {}) {
  return {
    projectId: overrides.projectId ?? projectId,
    workspace: process.cwd(),
    minFreq: overrides.minFreq ?? 3,
    ttlDays: 14,
    testGapCoveragePctCeiling: 80,
    testGapMinLines: 5,
    rollbackThreshold: overrides.rollbackThreshold ?? 3,
    rollbackWindowDays: overrides.rollbackWindowDays ?? 30,
    staleCandidateMinAgeDays: overrides.staleCandidateMinAgeDays ?? 7,
  };
}
```

> Note: changed default `staleCandidateMinAgeDays` from 30 → 7 to match the daemon's `DEFAULT_STALE_CANDIDATE_MIN_AGE_DAYS=7`. The rollback_repro tests don't read this knob so they're unaffected.

- [ ] **Step 3: Compile-check** — `npx tsc --noEmit` → exit 0.

- [ ] **Step 4: Run the rollback_repro suite to confirm zero regression**

`node --import tsx --no-warnings --test tests/curriculum-scanner.test.ts`
Expected: 7/7 still pass.

- [ ] **Step 5: Do NOT commit yet** — batch with Tasks 4-9 in one stale_candidates tests commit.

---

## Task 4: Test — empty corpus → 0 enqueued (`scanStaleCandidates`)

**Files:**
- Modify: `tests/curriculum-scanner.test.ts` (add new describe block)

- [ ] **Step 1: At the end of the existing file (after the closing `});` of the rollback_repro describe), add a new describe block**

```typescript
describe("scanStaleCandidates — refactor source", () => {
  const projectId = uniqueProjectId();
  after(async () => {
    await cleanupProject(projectId);
  });

  test("empty corpus → 0 enqueued", async () => {
    const r = await scanStaleCandidates(makeCfg());
    assert.equal(r.source, "stale_candidate");
    assert.equal(r.enqueued, 0);
  });
});
```

> **Source string is locked:** smoke confirmed `r.source === 'stale_candidate'` (literal — not 'refactor'). The `kind` on the curriculum_tasks row IS 'refactor' (the table's discriminator); `EnqueueResult.source` is the source name. Don't confuse them.

- [ ] **Step 2: Add the new import at the top of the file**

```diff
-import { scanRollbackHotspots } from "../src/curriculum/scanner.js";
+import {
+  scanRollbackHotspots,
+  scanStaleCandidates,
+} from "../src/curriculum/scanner.js";
```

- [ ] **Step 3: Also import `insertThrowawaySkillCandidate`**

```diff
 import {
   uniqueProjectId,
   insertThrowawayCheckpoint,
+  insertThrowawaySkillCandidate,
   cleanupProject,
 } from "./fixtures/m4.js";
```

- [ ] **Step 4: Run only the new describe** — `node --import tsx --no-warnings --test tests/curriculum-scanner.test.ts` → Expected: 7 prior + 1 new = 8 pass.

---

## Task 5: Test — below frequency threshold → 0 enqueued

```typescript
test("below minFreq threshold → 0 enqueued", async () => {
  // minFreq defaults to 3 in makeCfg. Seed a candidate with frequency=2.
  await insertThrowawaySkillCandidate(projectId, {
    state: "mined",
    frequency: 2,
    createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const r = await scanStaleCandidates(makeCfg());
  assert.equal(r.enqueued, 0);

  const { count } = await supabase
    .from("curriculum_tasks")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("kind", "refactor");
  assert.equal(count, 0);
});
```

Expected: PASS.

---

## Task 6: Test — wrong state (`'promoted'` / `'rejected'`) → 0 enqueued

```typescript
test("candidates in state 'promoted' or 'rejected' are skipped", async () => {
  const subProjectId = uniqueProjectId();
  try {
    await insertThrowawaySkillCandidate(subProjectId, {
      state: "promoted",
      frequency: 10,
      createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await insertThrowawaySkillCandidate(subProjectId, {
      state: "rejected",
      frequency: 10,
      createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const r = await scanStaleCandidates(makeCfg({ projectId: subProjectId }));
    assert.equal(r.enqueued, 0);
  } finally {
    await cleanupProject(subProjectId);
  }
});
```

Expected: PASS.

---

## Task 7: Test — too young (within age window) → 0 enqueued

```typescript
test("candidates younger than staleCandidateMinAgeDays are skipped", async () => {
  const subProjectId = uniqueProjectId();
  try {
    // 2 days ago — younger than the default 7-day stale window.
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    await insertThrowawaySkillCandidate(subProjectId, {
      state: "mined",
      frequency: 10,
      createdAt: recent,
    });
    const r = await scanStaleCandidates(
      makeCfg({ projectId: subProjectId, staleCandidateMinAgeDays: 7 }),
    );
    assert.equal(r.enqueued, 0);
  } finally {
    await cleanupProject(subProjectId);
  }
});
```

Expected: PASS.

---

## Task 8: Test — happy path → 1 enqueued with kind=refactor, linked_candidate_id set, target_path=proposed_name

```typescript
test("stale candidate (mined + freq>=minFreq + age>=window) → 1 enqueued with refactor binding", async () => {
  const subProjectId = uniqueProjectId();
  try {
    const proposedName = "src/__test_m5stale__/refactor-me.ts";
    const patternHash = `m5_test_${randomUUID().slice(0, 12)}`;
    const stale = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const candidateId = await insertThrowawaySkillCandidate(subProjectId, {
      patternHash,
      state: "mined",
      frequency: 7,
      proposedName,
      createdAt: stale,
    });

    const r = await scanStaleCandidates(
      makeCfg({ projectId: subProjectId, minFreq: 3, staleCandidateMinAgeDays: 7 }),
    );
    assert.equal(r.source, "stale_candidate");
    assert.equal(r.enqueued, 1);

    const { data, error } = await supabase
      .from("curriculum_tasks")
      .select("kind, target_path, status, linked_candidate_id, rationale, signal_source")
      .eq("project_id", subProjectId)
      .eq("kind", "refactor")
      .single();
    assert.equal(error, null);
    assert.equal(data?.kind, "refactor");
    // Smoke-confirmed: target_path is `skill_candidate:${pattern_hash}`,
    // NOT proposed_name. Scanner refuses to invent filesystem paths.
    assert.equal(data?.target_path, `skill_candidate:${patternHash}`);
    assert.equal(data?.status, "queued");
    assert.equal(data?.linked_candidate_id, candidateId);
    assert.ok((data?.rationale ?? "").length > 0, "rationale should be non-empty");
    // proposed_name lives in signal_source.proposed_name JSONB.
    const signalSource = data?.signal_source as { proposed_name?: string } | null;
    assert.equal(signalSource?.proposed_name, proposedName);
  } finally {
    await cleanupProject(subProjectId);
  }
});
```

> **Note:** add `import { randomUUID } from "node:crypto";` at the top of the test file (needed for `patternHash` in this test). The fixture generates a `patternHash` if you don't supply one, but this test asserts on the exact value of `target_path` derived from it, so we control it explicitly.

Expected: PASS (matches smoke worker findings). **If FAIL on `target_path` or `linked_candidate_id`: scanner divergence — surface immediately.**

---

## Task 9: Test — dedup (re-running on same stale candidate does not double-enqueue)

```typescript
test("re-running scan on same stale candidate does not double-enqueue", async () => {
  const subProjectId = uniqueProjectId();
  try {
    const patternHash = `m5_test_${randomUUID().slice(0, 12)}`;
    await insertThrowawaySkillCandidate(subProjectId, {
      patternHash,
      state: "mined",
      frequency: 7,
      proposedName: "src/__test_m5stale__/dedup.ts",
      createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const r1 = await scanStaleCandidates(
      makeCfg({ projectId: subProjectId, minFreq: 3, staleCandidateMinAgeDays: 7 }),
    );
    assert.equal(r1.enqueued, 1);

    // Partial unique constraint (project_id, target_path, kind) WHERE
    // status='queued' should prevent a second queued row.
    const r2 = await scanStaleCandidates(
      makeCfg({ projectId: subProjectId, minFreq: 3, staleCandidateMinAgeDays: 7 }),
    );
    assert.equal(r2.enqueued, 0);

    // Filter by target_path = `skill_candidate:${patternHash}` (smoke-confirmed).
    const { count } = await supabase
      .from("curriculum_tasks")
      .select("id", { count: "exact", head: true })
      .eq("project_id", subProjectId)
      .eq("kind", "refactor")
      .eq("target_path", `skill_candidate:${patternHash}`);
    assert.equal(count, 1);
  } finally {
    await cleanupProject(subProjectId);
  }
});

test("commit Tasks 4-9", () => {
  // Placeholder — real commit happens via git below.
  assert.ok(true);
});
```

Drop the placeholder test before committing — it's just a reminder. **Real commit step:**

```bash
git add tests/curriculum-scanner.test.ts
git commit -m "test(m5): characterize scanStaleCandidates — empty, freq, state, age, happy, dedup"
```

Expected: 7 prior rollback_repro tests + 6 new stale_candidate tests = **13/13 pass** in the test file.

---

## Task 10: Live smoke `scripts/smoke-m5-stale.ts` + npm script

**Files:**
- Create: `scripts/smoke-m5-stale.ts`
- Modify: `package.json`

```typescript
// scripts/smoke-m5-stale.ts — live end-to-end smoke for the M3→M5 binding.
// Seed 1 stale skill_candidates row (state=mined, freq>=minFreq, age>=7d),
// run scanStaleCandidates, verify a curriculum_tasks row of kind=refactor
// materialises with linked_candidate_id set and target_path=proposed_name.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import { scanStaleCandidates } from "../src/curriculum/scanner.js";

const projectId = `__smoke_m5st_${randomUUID().slice(0, 8)}__`;
const proposedName = `src/__smoke_m5st__/${randomUUID().slice(0, 6)}.ts`;

const patternHash = `smoke_m5st_${randomUUID().slice(0, 12)}`;

async function seedStaleCandidate(): Promise<number> {
  const stale = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("skill_candidates")
    .insert({
      project_id: projectId,
      pattern_hash: patternHash,
      source_summary_ids: [],
      source_backlog_ids: [],
      state: "mined",
      frequency: 7,
      proposed_name: proposedName,
      created_at: stale,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedStaleCandidate: ${error?.message}`);
  return data.id;
}

async function cleanup(): Promise<void> {
  await supabase.from("curriculum_tasks").delete().eq("project_id", projectId);
  await supabase.from("skill_candidates").delete().eq("project_id", projectId);
}

async function main(): Promise<void> {
  console.log(`[M5-ST-SMOKE] start project=${projectId} proposedName=${proposedName}`);
  const candidateId = await seedStaleCandidate();
  console.log(`[M5-ST-SMOKE] seeded candidate id=${candidateId}`);

  const r = await scanStaleCandidates({
    projectId,
    workspace: process.cwd(),
    minFreq: 3,
    ttlDays: 14,
    testGapCoveragePctCeiling: 80,
    testGapMinLines: 5,
    rollbackThreshold: 3,
    rollbackWindowDays: 30,
    staleCandidateMinAgeDays: 7,
  });
  console.log(`[M5-ST-SMOKE] scan result:`, r);
  if (r.enqueued !== 1) {
    throw new Error(`[M5-ST-SMOKE] FAIL: expected enqueued=1, got ${r.enqueued}`);
  }

  const { data, error } = await supabase
    .from("curriculum_tasks")
    .select("kind, target_path, status, linked_candidate_id")
    .eq("project_id", projectId)
    .eq("kind", "refactor")
    .single();
  if (error || !data) {
    throw new Error(
      `[M5-ST-SMOKE] FAIL: curriculum_tasks lookup: ${error?.message ?? "no row"}`,
    );
  }
  const expectedTargetPath = `skill_candidate:${patternHash}`;
  if (data.target_path !== expectedTargetPath)
    throw new Error(`[M5-ST-SMOKE] FAIL: target_path expected '${expectedTargetPath}', got '${data.target_path}'`);
  if (data.linked_candidate_id !== candidateId)
    throw new Error(`[M5-ST-SMOKE] FAIL: linked_candidate_id expected ${candidateId}, got ${data.linked_candidate_id}`);
  if (data.status !== "queued")
    throw new Error(`[M5-ST-SMOKE] FAIL: status expected 'queued', got '${data.status}'`);

  console.log("[M5-ST-SMOKE] PASS");
}

main()
  .catch((err) => {
    console.error(`[M5-ST-SMOKE] FAIL: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
```

- [ ] **Step 1: Add npm script** — `"smoke:m5-stale": "tsx scripts/smoke-m5-stale.ts"` next to existing smoke entries.

- [ ] **Step 2: Compile** — `npx tsc --noEmit` → exit 0.

- [ ] **Step 3: Run** — `npm run smoke:m5-stale` → expect `[M5-ST-SMOKE] PASS`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-m5-stale.ts package.json
git commit -m "test(m5): live smoke for stale_candidates — 1 stale → curriculum_tasks refactor row with linked_candidate_id"
```

---

## Task 11: ARCHITECTURE.md doc drift fix (conditional)

**Files:**
- Maybe modify: `ARCHITECTURE.md` (line ~557 stale_candidate spec)

- [ ] **Step 1: Re-read ARCHITECTURE.md line 557** in light of Task 1's audit findings. Decide:
  - If doc says `frequency ≥ 5` AND code uses `cfg.minFreq` (default 3 in daemon) AND there's no hardcoded ≥5 floor in the scanner: the doc is editorial/aspirational. Add a clarifier (e.g. "≥ minFreq, env-overridable via `CURRICULUM_MIN_FREQ`; production default 3, ARCHITECTURE recommendation 5").
  - If the code hardcodes a 5-floor on top of cfg.minFreq: doc and code agree, no edit needed.
  - If neither — there's a real drift; the safe fix is to mirror M5 rollback_repro's pattern and quote what the code actually does, not the spec.

- [ ] **Step 2: If an Edit is needed, make it surgical** (1-3 lines max). Don't restructure adjacent prose.

- [ ] **Step 3: Verify no other `stale_candidate` doc drift**

`grep -nE "stale_candidate|state='promoted'|state='mined'" ARCHITECTURE.md` — confirm all uses are correct.

- [ ] **Step 4: If an Edit was applied, commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(m5): clarify stale_candidate frequency threshold matches cfg.minFreq"
```

If no edit was needed: skip this task; document the audit verdict in the DECISION memory.

---

## Task 12: Full suite + gate

- [ ] **Step 1: Full npm test** — Expected: 91 baseline + 7 rollback_repro + 6 stale_candidates = **104/104 pass**.

- [ ] **Step 2: refactor_guard tsc gate** — Expected: `ok: true`.

- [ ] **Step 3: Re-run all three smokes**

```bash
npm run smoke:m4
npm run smoke:m5-rollback
npm run smoke:m5-stale
```

All three → exit 0.

- [ ] **Step 4: If anything red — STOP** and use `superpowers:systematic-debugging`. Do not paper over.

---

## Task 13: DECISION memory + final wrap

- [ ] **Step 1: `git status`** — clean.

- [ ] **Step 2: `git log --oneline -6`** — expected: `test(m5): extend fixtures with insertThrowawaySkillCandidate`, `test(m5): characterize scanStaleCandidates`, `test(m5): live smoke for stale_candidates`, and conditionally `docs(m5): clarify stale_candidate frequency`.

- [ ] **Step 3: Save DECISION memory via `save_memory`**

```
Content: SCM-S30-D6: M5 scanStaleCandidates (refactor source / M3 auto-promote trigger) verified end-to-end. Closes M5 Curriculum Scanner test coverage hat-trick (rollback_repro + stale_candidates + the test_gap source is out of scope for this Epic). Added 6 characterization tests (empty, below-freq, wrong-state, too-young, happy-path-with-linked_candidate_id, dedup) + 1 live smoke (npm run smoke:m5-stale) + fixture helper insertThrowawaySkillCandidate. Tests STRICTLY scope to scanner.enqueue — never call apply_curriculum_task — to avoid mutating agent_skills via the auto-promote SQL transaction. Full npm test 104/104; tsc gate clean; all three smokes (m4 + m5-rollback + m5-stale) PASS.

Metadata: { type: "DECISION", status: "verified", session: 30, mission: "M5-stale_candidates" }
```

- [ ] **Step 4: Synthesis to Orchestrator** — 2 paragraphs covering (a) what shipped + commit list, (b) anything surfaced unexpectedly. End with `skill_applied:` per Phase 3 contract.

---

## Test Strategy Summary

| Test | Inputs | Expected | Why |
|---|---|---|---|
| empty corpus | 0 candidates | `enqueued=0` | baseline / no-op safety |
| below freq | 1 mined candidate, frequency=2 (cfg.minFreq=3) | `enqueued=0` | frequency-threshold inclusive boundary |
| wrong state | 1 promoted + 1 rejected, freq=10 each | `enqueued=0` | state filter is real |
| too young | 1 mined candidate, freq=10, age=2d (window=7d) | `enqueued=0` | age filter is real |
| happy path | 1 mined candidate, freq=7, age=14d, proposed_name set | `enqueued=1`, `kind='refactor'`, `target_path=proposed_name`, `linked_candidate_id=row.id`, `status='queued'`, rationale non-empty | the full M3→M5 binding |
| dedup | scan twice on same stale candidate | exactly 1 curriculum_tasks row | partial unique constraint enforces idempotency |

**Total: 6 tests, ~150 lines added. Expected wall-clock: ~10-15s.**

**Safety guarantee:** Tests NEVER call `apply_curriculum_task` — only `scanStaleCandidates`. The M3 auto-promote into `agent_skills` cannot fire from this test surface.

---

## Self-Review

**1. Spec coverage** — every ARCHITECTURE.md heuristic clause has a corresponding test:
- state='mined' filter → Task 6 (wrong-state)
- frequency >= minFreq → Task 5 (below) + Task 8 (at)
- age >= staleCandidateMinAgeDays → Task 7 (too young) + Task 8 (sufficiently old)
- target_path = proposed_name → Task 8
- linked_candidate_id set → Task 8 (the M3 auto-promote binding)
- dedup via partial unique constraint → Task 9
- doc drift (conditional) → Task 11

**2. Placeholder scan** — no "TODO", no "similar to Task N" without code, no "add appropriate handling". ✓

**3. Type consistency** — `EnqueueResult` shape `{source, scanned, enqueued, skipped, errored}` (Task 4 + 5 + 7 + 8 + 9 + 10). `ScannerConfig` 9-field shape unchanged from M5 rollback_repro (`makeCfg` reuses the same definition). `ThrowawaySkillCandidateOpts` (Task 2) fields: `patternHash`, `state`, `frequency`, `successCount`, `proposedName`, `createdAt` — all used consistently in Tasks 5-10. ✓

---

## Execution Handoff

**Recommended execution mode:** `superpowers:executing-plans` inline (same as prior two Epics this session — tight control between commits).

**Estimated wall-clock:** 25-40 minutes including live Supabase + 3 smoke runs + optional doc edit.

**Estimated commits:** 3-4
1. `test(m5): extend fixtures with insertThrowawaySkillCandidate + skill_candidates cleanup`
2. `test(m5): characterize scanStaleCandidates — empty, freq, state, age, happy, dedup`
3. `test(m5): live smoke for stale_candidates — 1 stale → curriculum_tasks refactor row with linked_candidate_id`
4. (conditional) `docs(m5): clarify stale_candidate frequency threshold matches cfg.minFreq`

**Hard blocker before kickoff:** user approval of the scope (verify-not-build) + the **auto-promote safety contract** (tests only call scanner.enqueue, never apply_curriculum_task). If you want the test to ALSO exercise the apply→promote→agent_skills flow (much more invasive — uses test_skills namespacing or a transaction rollback), surface that and we'll redraft Task 8 to bracket it safely.

**Phase 3 contract:** any sub-agent dispatched for these tasks must follow the `request_skill` + `skill_applied:` synthesis contract. Inline orchestrator execution does not need the contract.

**Recommendation: quick oneshot smoke first** (same as prior two Epics) to flush any schema/RPC surprises in `enqueue_curriculum_task`'s 7-param signature + the `skill_candidates` NOT NULL surface BEFORE we invest in the full 6-test suite.
