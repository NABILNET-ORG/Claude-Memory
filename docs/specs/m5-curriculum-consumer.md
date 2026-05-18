# M5 Curriculum Consumer — Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close M5 Curriculum Consumer test coverage with characterization tests (live Supabase) + a live smoke script that exercises the four consumer MCP tools end-to-end through their handler entry points (not raw RPCs).

**Architecture:** The four consumer tools are SHIPPED + REGISTERED + LIVE-VALIDATED (Session 21 smoke green, Session 22 atomic-apply observed). What is missing is the same characterization-test rigor that Session 30 added for the M5 PRODUCER scanners. This plan mirrors the producer-test pattern at `tests/curriculum-scanner.test.ts` and the FK-safe fixture conventions at `tests/fixtures/m4.ts`. NO new TypeScript handler code, NO new SQL RPCs — the audit confirmed zero schema drift since the original `scripts/015_curriculum_tasks.sql`.

**Tech Stack:** `node:test` (NOT Vitest) + `node:assert/strict`, live Supabase (`SUPABASE_URL` + `SUPABASE_SECRET_KEY` from `.env`), TypeScript via `tsx`, existing fixture helpers (`uniqueProjectId`, `insertThrowawayCheckpoint`, `insertThrowawaySkillCandidate`, `cleanupProject`).

---

## Current State (from Session 32 audit — see `delegate_task` synthesis)

| Tool | Handler | Registered | SQL Backing | Characterization Tests |
|------|---------|-----------|-------------|------------------------|
| `list_curriculum_tasks` | `src/tools/curriculum.ts:92-124` | `src/index.ts:446-453` | Direct `from().select()` | NONE |
| `pull_curriculum_task` | `src/tools/curriculum.ts:162-187` | `src/index.ts:455-462` | `pull_next_curriculum_task` RPC | NONE |
| `apply_curriculum_task` | `src/tools/curriculum.ts:239-308` | `src/index.ts:464-471` | `apply_curriculum_task` RPC | NONE |
| `reject_curriculum_task` | `src/tools/curriculum.ts:321-342` | `src/index.ts:473-481` | Direct `from().update()` | NONE |

Smoke baseline: `scripts/smoke-m5.ts` (S21, GREEN, 8 assertions) calls **raw SQL RPCs**, NOT the MCP handler wrappers — so the handler layer is unverified end-to-end. `smoke-m5-rollback.ts` + `smoke-m5-stale.ts` only exercise producer paths.

---

## File Structure

- **Create**: `tests/curriculum-consumer.test.ts` — characterization suite, ~14 tests across 5 `describe` blocks (one per tool, with apply split success/failure).
- **Modify**: `tests/fixtures/m4.ts` — add `insertThrowawayCurriculumTask(opts)` helper if not already present (audit didn't confirm — check before adding). Cleanup order already FK-safe; no change needed there.
- **Create**: `scripts/smoke-m5-consumer.ts` — live end-to-end smoke that imports the four tool **handler functions** (not the RPCs directly) and exercises a full enqueue → list → pull → apply success/failure cycle + a separate reject cycle. Mirrors `scripts/smoke-m5.ts` structure but at the handler layer.
- **Modify**: `package.json` — append `tests/curriculum-consumer.test.ts` to the `npm test` runner glob and add `smoke:m5-consumer` script.
- **Modify (if drift surfaces)**: `ARCHITECTURE.md` §4.7 — the audit found zero drift, but the smoke run may reveal Session 21 docs that misstate handler argument shapes. Only edit if drift is observed during smoke verification.

---

## Out of Scope (explicit YAGNI fence)

- **No new tool features.** Bypass flags, new arguments, new statuses — none. This is purely a verification pass.
- **No SQL changes.** RPCs are correct per S21 + S22 live verification. If a test fails, file an ERROR memory and investigate; do not preemptively patch SQL.
- **No producer-path retesting.** `tests/curriculum-scanner.test.ts` already covers `scanRollbackHotspots` + `scanStaleCandidates`. Do not duplicate.
- **No GLOBAL promotion.** Tests use unique per-test project IDs (`uniqueProjectId()`); never write to `project_id='GLOBAL'`.

---

## Test-by-test outline (15 tests total)

### Suite A — `list_curriculum_tasks` (3 tests)
1. **A1** Empty queue → `tasks: []`, `count: 0`.
2. **A2** Filter compose: 3 enqueued (queued/pulled/verified statuses, mixed kinds) → `status='queued'` + `kind='refactor'` returns only the matching subset.
3. **A3** Project isolation: rows in project `A` are not visible when listing with `project_id=B`.

### Suite B — `pull_curriculum_task` (4 tests)
1. **B1** Empty queue → handler returns `task: null` / `claimed: false` (characterize current shape).
2. **B2** Single queued row → claim flips `status: queued → pulled`, sets `pulled_at` (within ±5s of now), sets `pulled_by_session_id` to the passed value.
3. **B3** Priority: with one row having `linked_candidate_id IS NOT NULL` and another with NULL (both queued, same project), `pull_curriculum_task` claims the linked one first. Second pull claims the other.
4. **B4** Kind filter: seed `kind='rollback_repro'` + `kind='refactor'`, pull with `kind='rollback_repro'` claims only that row; subsequent pull with same filter returns null while the other row remains queued.

### Suite C — `apply_curriculum_task` SUCCESS path (4 tests)
1. **C1** No linked candidate, success=true: seed queued + pull + commit a throwaway checkpoint → `apply` flips status `pulled → verified`, `linked_checkpoint_id` set, NO `agent_skills` row minted, NO `skill_candidates` mutation.
2. **C2** With linked candidate, compose called, success=true: seed candidate `state='mined'` with `proposed_name='s32-consumer-test'` + 3 steps → enqueue task with `linked_candidate_id` → pull → commit checkpoint → apply → assert atomic: `curriculum_tasks.verified_at == skill_candidates.updated_at == agent_skills.created_at` (all three timestamps equal to the millisecond — proves single SQL tx).
3. **C3** Verification gate raised, `bypass_verification_gate=false`: pre-create `~/.claude-memory/verification-pending.json` (or call `raise_verification_gate`), pull task, attempt apply → handler returns error (characterize exact shape), task stays `pulled`, no promote. Clean up the gate file afterward.
4. **C4** Compose-before-apply mandate violated: seed candidate with NULL `proposed_name`, enqueue task with `linked_candidate_id`, pull, commit checkpoint, apply → SQL transaction aborts (NOT-NULL constraint), task stays `pulled`, no `agent_skills` row created, no `skill_candidates.state` flip. Characterize the error message surface.

### Suite D — `apply_curriculum_task` FAILURE path (1 test)
1. **D1** `success=false` + `failure_reason='regression observed in test C2'`: seed queued + pull + apply with success=false → task flips `pulled → rejected`, `failure_reason` persisted, no promote, no checkpoint required.

### Suite E — `reject_curriculum_task` (3 tests)
1. **E1** Reject a `queued` task → status flips to `rejected`, reason persisted, no promote, no checkpoint requirement.
2. **E2** Reject a `pulled` task → status flips to `rejected` (characterize: does the handler enforce a status precondition or accept any non-terminal?).
3. **E3** Idempotency: reject an already-`rejected` task → characterize current behavior (silent no-op? error? overwrite reason?). Do NOT prescribe — record observed behavior in the test.

---

## Bite-Sized Tasks

### Task 1 — Fixture helper sanity check

**Files:**
- Read: `tests/fixtures/m4.ts` (full file)

- [ ] **Step 1: Confirm `cleanupProject` deletes `curriculum_tasks` first**

Open `tests/fixtures/m4.ts` and verify the cleanup function's delete order. Expected (from audit): `curriculum_tasks → skill_candidates → workflow_checkpoints → cloud_backlog → memory_chunks`. If the order is different in the actual file, STOP and report — do not silently re-order; FK constraints will surface.

- [ ] **Step 2: Check whether `insertThrowawayCurriculumTask` exists**

Grep `tests/fixtures/m4.ts` for `insertThrowawayCurriculumTask`. If present, use it. If absent, proceed to Task 2.

- [ ] **Step 3: NO commit yet** — Task 1 is read-only.

---

### Task 2 — Add `insertThrowawayCurriculumTask` fixture helper (only if missing)

**Files:**
- Modify: `tests/fixtures/m4.ts`

- [ ] **Step 1: Append the helper**

Add this exported function near the existing `insertThrowawaySkillCandidate` (mirror its shape):

```typescript
export interface ThrowawayCurriculumTaskOpts {
  projectId: string;
  kind: 'test_gap' | 'rollback_repro' | 'refactor';
  targetPath: string;
  rationale?: string;
  signalSource?: Record<string, unknown>;
  linkedCandidateId?: number | null;
  status?: 'queued' | 'pulled' | 'verified' | 'rejected';
  createdAt?: string;
}

export async function insertThrowawayCurriculumTask(
  opts: ThrowawayCurriculumTaskOpts
): Promise<{ id: number }> {
  const supabase = getSupabaseClient();
  const row = {
    project_id: opts.projectId,
    kind: opts.kind,
    target_path: opts.targetPath,
    rationale: opts.rationale ?? `s32-consumer-test:${opts.kind}`,
    signal_source: opts.signalSource ?? {},
    linked_candidate_id: opts.linkedCandidateId ?? null,
    status: opts.status ?? 'queued',
    ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
  };
  const { data, error } = await supabase
    .from('curriculum_tasks')
    .insert(row)
    .select('id')
    .single();
  if (error) throw new Error(`insertThrowawayCurriculumTask: ${error.message}`);
  return { id: data.id as number };
}
```

- [ ] **Step 2: tsc gate**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/m4.ts
git commit -m "test(fixtures): add insertThrowawayCurriculumTask helper for M5 consumer tests"
```

---

### Task 3 — Suite A: `list_curriculum_tasks` (3 tests)

**Files:**
- Create: `tests/curriculum-consumer.test.ts`

- [ ] **Step 1: Scaffold the test file mirroring `tests/curriculum-scanner.test.ts:1-15`**

Create `tests/curriculum-consumer.test.ts` with:

```typescript
import { describe, test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { config as loadEnv } from 'dotenv';
import {
  uniqueProjectId,
  cleanupProject,
  insertThrowawayCurriculumTask,
  insertThrowawaySkillCandidate,
  insertThrowawayCheckpoint,
} from './fixtures/m4.js';
import { handleListCurriculumTasks } from '../src/tools/curriculum.js';

loadEnv();

const createdProjectIds: string[] = [];
function newProject(): string {
  const id = uniqueProjectId('s32-cc');
  createdProjectIds.push(id);
  return id;
}

after(async () => {
  for (const pid of createdProjectIds) await cleanupProject(pid);
});
```

**Note:** Replace `handleListCurriculumTasks` with the actual exported name found in `src/tools/curriculum.ts:92-124`. If the handler is not exported, export it before writing tests. Same applies for `handlePullCurriculumTask`, `handleApplyCurriculumTask`, `handleRejectCurriculumTask` in later tasks.

- [ ] **Step 2: Write test A1 (empty queue)**

Append:

```typescript
describe('list_curriculum_tasks', () => {
  test('A1: empty queue returns []', async () => {
    const projectId = newProject();
    const result = await handleListCurriculumTasks({ project_id: projectId });
    assert.equal(Array.isArray(result.tasks), true, 'tasks must be an array');
    assert.equal(result.tasks.length, 0, 'no tasks expected');
  });
});
```

- [ ] **Step 3: Run test A1, expect PASS**

Run: `npx tsx --test tests/curriculum-consumer.test.ts`
Expected: A1 passes. If it fails, the handler return shape differs from the assumption — adjust the test to characterize the actual shape (this is a CHARACTERIZATION suite, not a redesign suite).

- [ ] **Step 4: Write test A2 (status + kind filter compose)**

```typescript
  test('A2: status + kind filters compose correctly', async () => {
    const projectId = newProject();
    await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'a', status: 'queued' });
    await insertThrowawayCurriculumTask({ projectId, kind: 'rollback_repro', targetPath: 'b', status: 'queued' });
    await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'c', status: 'verified' });

    const result = await handleListCurriculumTasks({ project_id: projectId, status: 'queued', kind: 'refactor' });
    assert.equal(result.tasks.length, 1, 'only one row matches both filters');
    assert.equal(result.tasks[0].target_path, 'a');
  });
```

- [ ] **Step 5: Run A2, expect PASS**

Run: `npx tsx --test tests/curriculum-consumer.test.ts`

- [ ] **Step 6: Write test A3 (project isolation)**

```typescript
  test('A3: project_id isolation', async () => {
    const projectA = newProject();
    const projectB = newProject();
    await insertThrowawayCurriculumTask({ projectId: projectA, kind: 'refactor', targetPath: 'x' });

    const result = await handleListCurriculumTasks({ project_id: projectB });
    assert.equal(result.tasks.length, 0, 'project B sees zero rows from project A');
  });
```

- [ ] **Step 7: Run A3, expect PASS**

- [ ] **Step 8: Commit**

```bash
git add tests/curriculum-consumer.test.ts
git commit -m "test(curriculum-consumer): characterize list_curriculum_tasks (3 tests)"
```

---

### Task 4 — Suite B: `pull_curriculum_task` (4 tests)

**Files:**
- Modify: `tests/curriculum-consumer.test.ts`

- [ ] **Step 1: Import + write B1 (empty queue)**

Append `handlePullCurriculumTask` to the imports. Then append:

```typescript
describe('pull_curriculum_task', () => {
  test('B1: empty queue returns null/empty', async () => {
    const projectId = newProject();
    const result = await handlePullCurriculumTask({ project_id: projectId, session_id: 's32-b1' });
    assert.equal(result.task, null, 'no task expected when queue empty');
  });
});
```

If the handler returns a different empty-shape (e.g. `{ claimed: false }`), update the assertion to characterize the actual shape and add a comment quoting `src/tools/curriculum.ts:<line>` showing the return statement.

- [ ] **Step 2: Run B1, expect PASS**

- [ ] **Step 3: Write B2 (claim flips status)**

```typescript
  test('B2: claim flips status queued→pulled and stamps session', async () => {
    const projectId = newProject();
    const { id } = await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'b2' });

    const before = Date.now();
    const result = await handlePullCurriculumTask({ project_id: projectId, session_id: 's32-b2' });
    const after = Date.now();

    assert.notEqual(result.task, null, 'a task should be claimed');
    assert.equal(result.task.id, id);
    assert.equal(result.task.status, 'pulled');
    assert.equal(result.task.pulled_by_session_id, 's32-b2');
    const pulledAt = new Date(result.task.pulled_at).getTime();
    assert.ok(pulledAt >= before - 1000 && pulledAt <= after + 1000, 'pulled_at within request window');
  });
```

- [ ] **Step 4: Run B2, expect PASS**

- [ ] **Step 5: Write B3 (linked-candidate priority)**

```typescript
  test('B3: linked_candidate_id rows pulled before NULL ones', async () => {
    const projectId = newProject();
    const { id: candId } = await insertThrowawaySkillCandidate({ projectId, frequency: 5, state: 'mined' });
    const { id: unlinkedId } = await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'unlinked' });
    const { id: linkedId } = await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'linked', linkedCandidateId: candId });

    const first = await handlePullCurriculumTask({ project_id: projectId, session_id: 's32-b3-1' });
    const second = await handlePullCurriculumTask({ project_id: projectId, session_id: 's32-b3-2' });

    assert.equal(first.task.id, linkedId, 'linked task pulled first');
    assert.equal(second.task.id, unlinkedId, 'unlinked task pulled second');
  });
```

- [ ] **Step 6: Run B3, expect PASS**

- [ ] **Step 7: Write B4 (kind filter)**

```typescript
  test('B4: kind filter restricts claim to matching rows', async () => {
    const projectId = newProject();
    const { id: rollbackId } = await insertThrowawayCurriculumTask({ projectId, kind: 'rollback_repro', targetPath: 'rb' });
    const { id: refactorId } = await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'rf' });

    const result = await handlePullCurriculumTask({ project_id: projectId, kind: 'rollback_repro', session_id: 's32-b4' });
    assert.equal(result.task.id, rollbackId, 'only rollback_repro row claimed');

    const second = await handlePullCurriculumTask({ project_id: projectId, kind: 'rollback_repro', session_id: 's32-b4-2' });
    assert.equal(second.task, null, 'no more rollback_repro rows');

    const third = await handlePullCurriculumTask({ project_id: projectId, kind: 'refactor', session_id: 's32-b4-3' });
    assert.equal(third.task.id, refactorId, 'refactor row still claimable');
  });
```

- [ ] **Step 8: Run B4, expect PASS**

- [ ] **Step 9: Commit**

```bash
git add tests/curriculum-consumer.test.ts
git commit -m "test(curriculum-consumer): characterize pull_curriculum_task (4 tests, FOR UPDATE SKIP LOCKED priority)"
```

---

### Task 5 — Suite C: `apply_curriculum_task` SUCCESS path (4 tests)

**Files:**
- Modify: `tests/curriculum-consumer.test.ts`

- [ ] **Step 1: Add imports + C1 (no linked candidate)**

Add `handleApplyCurriculumTask` and `compose_skill_candidate` equivalent (or direct supabase update — see SCM-S22-D3 memory for the workaround). Then:

```typescript
describe('apply_curriculum_task — success path', () => {
  test('C1: success=true, no linked candidate → verified, no promote', async () => {
    const projectId = newProject();
    const { id: cpId } = await insertThrowawayCheckpoint({ projectId, status: 'committed', stepLabel: 'c1-cp' });
    const { id: taskId } = await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'c1' });
    await handlePullCurriculumTask({ project_id: projectId, session_id: 's32-c1' });

    const result = await handleApplyCurriculumTask({
      task_id: taskId,
      success: true,
      checkpoint_id: cpId,
      bypass_verification_gate: true,
    });

    assert.equal(result.applied_status, 'verified');
    assert.equal(result.promoted_candidate_id, null);
    assert.equal(result.promoted_skill_id, null);
  });
});
```

- [ ] **Step 2: Run C1, expect PASS**

- [ ] **Step 3: Write C2 (linked candidate, atomic promote)**

```typescript
  test('C2: success=true with linked candidate → atomic promote (3 timestamps equal)', async () => {
    const projectId = newProject();
    const { id: candId } = await insertThrowawaySkillCandidate({
      projectId,
      frequency: 5,
      state: 'mined',
      proposedName: 's32-c2-skill',
      proposedSteps: [{ action: 'noop', path: 'irrelevant' }],
    });
    const { id: cpId } = await insertThrowawayCheckpoint({ projectId, status: 'committed', stepLabel: 'c2-cp' });
    const { id: taskId } = await insertThrowawayCurriculumTask({
      projectId,
      kind: 'refactor',
      targetPath: 'c2',
      linkedCandidateId: candId,
    });
    await handlePullCurriculumTask({ project_id: projectId, session_id: 's32-c2' });

    const result = await handleApplyCurriculumTask({
      task_id: taskId,
      success: true,
      checkpoint_id: cpId,
      bypass_verification_gate: true,
    });

    assert.equal(result.applied_status, 'verified');
    assert.equal(result.promoted_candidate_id, candId);
    assert.ok(result.promoted_skill_id, 'a skill row was minted');

    // Atomic-tx proof: three timestamps must be equal to the millisecond.
    const supabase = getSupabaseClient();
    const [{ data: task }, { data: cand }, { data: skill }] = await Promise.all([
      supabase.from('curriculum_tasks').select('verified_at').eq('id', taskId).single(),
      supabase.from('skill_candidates').select('updated_at').eq('id', candId).single(),
      supabase.from('agent_skills').select('created_at').eq('id', result.promoted_skill_id).single(),
    ]);
    assert.equal(task.verified_at, cand.updated_at, 'verified_at == candidate.updated_at');
    assert.equal(cand.updated_at, skill.created_at, 'candidate.updated_at == skill.created_at');
  });
```

**Note:** Confirm `insertThrowawaySkillCandidate` accepts `proposedName` + `proposedSteps`. If not, extend it in Task 2 retroactively (commit separately) or call `compose_skill_candidate` via the supabase client between insert and pull.

- [ ] **Step 4: Run C2, expect PASS. Atomic timestamp equality is the load-bearing assertion.**

- [ ] **Step 5: Write C3 (verification gate blocks)**

```typescript
  test('C3: verification gate present → apply blocked', async () => {
    const projectId = newProject();
    const { id: cpId } = await insertThrowawayCheckpoint({ projectId, status: 'committed', stepLabel: 'c3-cp' });
    const { id: taskId } = await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'c3' });
    await handlePullCurriculumTask({ project_id: projectId, session_id: 's32-c3' });

    // Raise gate (mirror src/verification/gate.ts API)
    await raiseGate({ reason: 'test gate', file: 'c3' });
    try {
      await assert.rejects(
        handleApplyCurriculumTask({ task_id: taskId, success: true, checkpoint_id: cpId, bypass_verification_gate: false }),
        /verification.*gate/i,
        'gate must block apply when bypass=false'
      );
    } finally {
      await clearGate();
    }

    // Task should still be 'pulled' (not flipped to 'verified')
    const supabase = getSupabaseClient();
    const { data: row } = await supabase.from('curriculum_tasks').select('status').eq('id', taskId).single();
    assert.equal(row.status, 'pulled', 'task stays pulled when gate blocked');
  });
```

**Note:** Replace `raiseGate` / `clearGate` with the actual exports from `src/verification/gate.ts` or equivalent. If the gate is file-based (`~/.claude-memory/verification-pending.json`), write + delete the file directly with `fs/promises`.

- [ ] **Step 6: Run C3, expect PASS**

- [ ] **Step 7: Write C4 (NULL proposed_name aborts atomically)**

```typescript
  test('C4: linked candidate with NULL proposed_name → atomic rollback', async () => {
    const projectId = newProject();
    const { id: candId } = await insertThrowawaySkillCandidate({
      projectId, frequency: 5, state: 'mined',
      proposedName: null, proposedSteps: null,
    });
    const { id: cpId } = await insertThrowawayCheckpoint({ projectId, status: 'committed', stepLabel: 'c4-cp' });
    const { id: taskId } = await insertThrowawayCurriculumTask({
      projectId, kind: 'refactor', targetPath: 'c4', linkedCandidateId: candId,
    });
    await handlePullCurriculumTask({ project_id: projectId, session_id: 's32-c4' });

    await assert.rejects(
      handleApplyCurriculumTask({ task_id: taskId, success: true, checkpoint_id: cpId, bypass_verification_gate: true }),
      'apply must abort when proposed_name is NULL'
    );

    const supabase = getSupabaseClient();
    const { data: task } = await supabase.from('curriculum_tasks').select('status').eq('id', taskId).single();
    const { data: cand } = await supabase.from('skill_candidates').select('state').eq('id', candId).single();
    assert.equal(task.status, 'pulled', 'task stays pulled (no flip on aborted tx)');
    assert.equal(cand.state, 'mined', 'candidate stays mined (no flip on aborted tx)');

    const { data: skills } = await supabase.from('agent_skills').select('id').eq('name', 'never-promoted');
    assert.equal(skills.length, 0, 'no skill row created on aborted tx');
  });
```

- [ ] **Step 8: Run C4, expect PASS**

- [ ] **Step 9: Commit**

```bash
git add tests/curriculum-consumer.test.ts
git commit -m "test(curriculum-consumer): characterize apply_curriculum_task success path (4 tests, atomic-tx proof)"
```

---

### Task 6 — Suite D: `apply_curriculum_task` FAILURE path (1 test)

**Files:**
- Modify: `tests/curriculum-consumer.test.ts`

- [ ] **Step 1: Append D1**

```typescript
describe('apply_curriculum_task — failure path', () => {
  test('D1: success=false flips task to rejected, no promote', async () => {
    const projectId = newProject();
    const { id: taskId } = await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'd1' });
    await handlePullCurriculumTask({ project_id: projectId, session_id: 's32-d1' });

    const result = await handleApplyCurriculumTask({
      task_id: taskId,
      success: false,
      failure_reason: 'regression observed in test',
      bypass_verification_gate: true,
    });

    assert.equal(result.applied_status, 'rejected');
    assert.equal(result.promoted_candidate_id, null);
    assert.equal(result.promoted_skill_id, null);

    const supabase = getSupabaseClient();
    const { data: row } = await supabase
      .from('curriculum_tasks')
      .select('status, failure_reason')
      .eq('id', taskId)
      .single();
    assert.equal(row.status, 'rejected');
    assert.equal(row.failure_reason, 'regression observed in test');
  });
});
```

- [ ] **Step 2: Run D1, expect PASS**

- [ ] **Step 3: Commit**

```bash
git add tests/curriculum-consumer.test.ts
git commit -m "test(curriculum-consumer): characterize apply_curriculum_task failure path (1 test)"
```

---

### Task 7 — Suite E: `reject_curriculum_task` (3 tests)

**Files:**
- Modify: `tests/curriculum-consumer.test.ts`

- [ ] **Step 1: Append E1 + E2 + E3**

```typescript
describe('reject_curriculum_task', () => {
  test('E1: reject queued task → rejected with reason', async () => {
    const projectId = newProject();
    const { id: taskId } = await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'e1' });
    const result = await handleRejectCurriculumTask({ task_id: taskId, reason: 'out of scope for current sprint' });
    assert.equal(result.status, 'rejected');

    const supabase = getSupabaseClient();
    const { data: row } = await supabase
      .from('curriculum_tasks')
      .select('status, failure_reason')
      .eq('id', taskId)
      .single();
    assert.equal(row.status, 'rejected');
    assert.equal(row.failure_reason, 'out of scope for current sprint');
  });

  test('E2: reject pulled task → rejected', async () => {
    const projectId = newProject();
    const { id: taskId } = await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'e2' });
    await handlePullCurriculumTask({ project_id: projectId, session_id: 's32-e2' });
    const result = await handleRejectCurriculumTask({ task_id: taskId, reason: 'mid-pull abort' });
    assert.equal(result.status, 'rejected');
  });

  test('E3: reject already-rejected task is idempotent (characterize behavior)', async () => {
    const projectId = newProject();
    const { id: taskId } = await insertThrowawayCurriculumTask({ projectId, kind: 'refactor', targetPath: 'e3' });
    await handleRejectCurriculumTask({ task_id: taskId, reason: 'first reason' });
    // SECOND reject — characterize what handler does. Do NOT prescribe.
    const second = await handleRejectCurriculumTask({ task_id: taskId, reason: 'second reason' });
    // Record observed shape:
    assert.ok(second, 'second reject returned something (no exception)');
    // If handler errors on second reject, replace with assert.rejects() and document.
  });
});
```

- [ ] **Step 2: Run E1, E2, E3, expect PASS (E3 may reveal the actual idempotency behavior)**

If E3 throws, the characterization is "second reject raises". Convert to `assert.rejects(...)`. Document the observation as a code comment quoting `src/tools/curriculum.ts:321-342`.

- [ ] **Step 3: Commit**

```bash
git add tests/curriculum-consumer.test.ts
git commit -m "test(curriculum-consumer): characterize reject_curriculum_task (3 tests including idempotency)"
```

---

### Task 8 — Live smoke script

**Files:**
- Create: `scripts/smoke-m5-consumer.ts`

- [ ] **Step 1: Author the smoke script mirroring `scripts/smoke-m5.ts` structure**

Key differences from S21 smoke-m5.ts:
- **Imports the four HANDLER functions** from `src/tools/curriculum.ts`, NOT raw RPCs from supabase.
- **Single happy-path cycle**: enqueue → list (assert 1 row) → pull (assert claim) → apply success=true with linked candidate → assert atomic three-timestamp equality → cleanup.
- **Reject cycle**: enqueue → reject → assert status=rejected → cleanup.
- **Total**: ~10 assertions, ~150 lines.

Reference shape (skeleton — fill in based on actual handler signatures):

```typescript
#!/usr/bin/env tsx
/**
 * Live end-to-end smoke for M5 Curriculum CONSUMER tools.
 * Exercises the four MCP HANDLER functions (not raw RPCs).
 *
 * Run: npm run smoke:m5-consumer
 */
import { config as loadEnv } from 'dotenv';
import { uniqueProjectId, cleanupProject, insertThrowawayCheckpoint, insertThrowawaySkillCandidate } from '../tests/fixtures/m4.js';
import {
  handleListCurriculumTasks,
  handlePullCurriculumTask,
  handleApplyCurriculumTask,
  handleRejectCurriculumTask,
} from '../src/tools/curriculum.js';
import { getSupabaseClient } from '../src/db/supabase.js';

loadEnv();

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

async function happyPath() {
  const projectId = uniqueProjectId('smoke-m5-consumer-happy');
  try {
    const { id: candId } = await insertThrowawaySkillCandidate({
      projectId, frequency: 5, state: 'mined',
      proposedName: 'smoke-m5-consumer-skill',
      proposedSteps: [{ action: 'noop' }],
    });
    const { id: cpId } = await insertThrowawayCheckpoint({ projectId, status: 'committed', stepLabel: 'smoke-cp' });

    // Enqueue
    const supabase = getSupabaseClient();
    const { data: enq } = await supabase.from('curriculum_tasks').insert({
      project_id: projectId, kind: 'refactor', target_path: `skill_candidate:${candId}`,
      rationale: 'smoke', signal_source: {}, linked_candidate_id: candId, status: 'queued',
    }).select('id').single();
    assert(enq?.id, 'enqueued curriculum_tasks row');

    // List
    const list = await handleListCurriculumTasks({ project_id: projectId, status: 'queued' });
    assert(list.tasks.length === 1, 'list returns 1 queued row');

    // Pull
    const pulled = await handlePullCurriculumTask({ project_id: projectId, session_id: 'smoke' });
    assert(pulled.task?.id === enq.id, 'pulled the queued row');
    assert(pulled.task.status === 'pulled', 'status flipped to pulled');

    // Apply
    const applied = await handleApplyCurriculumTask({
      task_id: enq.id, success: true, checkpoint_id: cpId, bypass_verification_gate: true,
    });
    assert(applied.applied_status === 'verified', 'task verified');
    assert(applied.promoted_candidate_id === candId, 'candidate promoted');
    assert(applied.promoted_skill_id, 'skill row minted');

    // Atomic-tx proof
    const [{ data: task }, { data: cand }, { data: skill }] = await Promise.all([
      supabase.from('curriculum_tasks').select('verified_at').eq('id', enq.id).single(),
      supabase.from('skill_candidates').select('updated_at').eq('id', candId).single(),
      supabase.from('agent_skills').select('created_at').eq('id', applied.promoted_skill_id).single(),
    ]);
    assert(task.verified_at === cand.updated_at, 'verified_at == candidate.updated_at');
    assert(cand.updated_at === skill.created_at, 'candidate.updated_at == skill.created_at');
  } finally {
    await cleanupProject(projectId);
  }
}

async function rejectPath() {
  const projectId = uniqueProjectId('smoke-m5-consumer-reject');
  try {
    const supabase = getSupabaseClient();
    const { data: enq } = await supabase.from('curriculum_tasks').insert({
      project_id: projectId, kind: 'refactor', target_path: 'reject',
      rationale: 'smoke', signal_source: {}, status: 'queued',
    }).select('id').single();

    const result = await handleRejectCurriculumTask({ task_id: enq.id, reason: 'smoke-reject' });
    assert(result.status === 'rejected', 'reject flipped status');
  } finally {
    await cleanupProject(projectId);
  }
}

(async () => {
  console.log('# smoke-m5-consumer: happy path');
  await happyPath();
  console.log('# smoke-m5-consumer: reject path');
  await rejectPath();
  console.log('\n✓ ALL ASSERTIONS PASSED');
})().catch((err) => {
  console.error('✗ SMOKE FAILED:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run smoke once locally**

Run: `npx tsx scripts/smoke-m5-consumer.ts`
Expected: all assertions pass, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-m5-consumer.ts
git commit -m "feat(smoke): add smoke-m5-consumer.ts — handler-layer end-to-end + reject path"
```

---

### Task 9 — package.json wiring

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Append the new test file to the `npm test` script**

Open `package.json`. Find the `test` script (audit said line 44). It runs `node --test` against an explicit list. Add `tests/curriculum-consumer.test.ts` to the glob/list in the same style as `tests/curriculum-scanner.test.ts`.

- [ ] **Step 2: Add `smoke:m5-consumer` script**

Append to `scripts`:

```json
"smoke:m5-consumer": "tsx scripts/smoke-m5-consumer.ts"
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: previous 120 tests + 15 new tests = **135 pass**, zero failures.

- [ ] **Step 4: Run all smokes in sequence as a regression sweep**

Run sequentially:
```bash
npm run smoke:m4
npm run smoke:m5-rollback
npm run smoke:m5-stale
npm run smoke:m5-consumer
```
Expected: all four green.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore(test): register curriculum-consumer.test.ts in npm test + add smoke:m5-consumer"
```

---

### Task 10 — tsc gate + final regression sweep

**Files:** none (verification only)

- [ ] **Step 1: tsc gate**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: 135 pass.

- [ ] **Step 3: All four smokes**

Run each in turn, expect green.

- [ ] **Step 4: NO commit** — verification only. If anything fails, investigate before claiming complete.

---

### Task 11 — Documentation sync + DECISION memory

**Files:**
- Modify (only if drift observed): `ARCHITECTURE.md` §4.7
- Save DECISION via `save_memory`

- [ ] **Step 1: Skim ARCHITECTURE.md §4.7 (Autonomous Curriculum) — verify consumer-tool argument shapes match what the tests confirmed**

If any drift: edit ARCHITECTURE.md and commit separately as `docs(architecture): correct M5 consumer tool spec — drift observed in S32 chars`.

- [ ] **Step 2: Save DECISION memory**

```typescript
save_memory({
  content: "SCM-S32-D1: M5 Curriculum CONSUMER tools (list/pull/apply/reject) verified end-to-end via characterization suite. ...",
  metadata: { type: 'DECISION', context_id: 'SCM-S32-D1', session: 32, mission: 'M5-consumer' }
})
```

Include: tests count (15), atomic-tx proof tests (C2 + smoke), any characterized behaviors that differ from ARCHITECTURE.md spec, smoke wall-clock time, total npm test count delta.

- [ ] **Step 3: sync_artefacts**

Run the `sync_artefacts` MCP tool to refresh README + project_file_architecture.md.

---

## Verification Checklist (before claiming complete)

- [ ] `npx tsc --noEmit` — zero errors
- [ ] `npm test` — 135/135 pass (was 120, +15)
- [ ] `npm run smoke:m4` — green
- [ ] `npm run smoke:m5-rollback` — green
- [ ] `npm run smoke:m5-stale` — green
- [ ] `npm run smoke:m5-consumer` — green
- [ ] No orphan rows in `curriculum_tasks`, `skill_candidates`, `agent_skills`, `workflow_checkpoints` (cleanup verified)
- [ ] `agent_skills` table does NOT contain rows with project_id matching `s32-cc-*` after suite completes (only smoke-cleaned projects remain, and even those are cleaned)
- [ ] DECISION SCM-S32-D1 saved with type:'DECISION'
- [ ] `sync_artefacts` ran successfully
- [ ] No new `verification-pending.json` file left on disk after C3 / smoke

---

## Risk Register

1. **`agent_skills` is shared production state.** Tests C2 + smoke create real rows. The fixture `cleanupProject` must delete from `agent_skills` for the test's project_id (verify this is in the FK-safe order; the audit listed `agent_skills` as NOT explicitly cleaned — confirm in Task 1 Step 1 and extend cleanup if needed).
2. **Verification gate file is global.** C3 mutates `~/.claude-memory/verification-pending.json`. Run gate-cleanup in `finally` blocks. Smoke must NEVER leave the gate raised on exit (would block all subsequent Claude work).
3. **Live Supabase latency.** Suite wall-clock target: ≤ 30 s (scanner suite was ~9-14 s; consumer involves more cross-table writes). If > 60 s, profile.
4. **Handler exports.** If any of `handleListCurriculumTasks` / `handlePullCurriculumTask` / `handleApplyCurriculumTask` / `handleRejectCurriculumTask` are not exported from `src/tools/curriculum.ts`, export them as a Task 0 prerequisite commit. The current `src/index.ts:446-481` registrations import them somehow — verify the import shape and use the same names in tests.

---

## Status

**Planning complete. Awaiting approval before any TypeScript code is written.**
