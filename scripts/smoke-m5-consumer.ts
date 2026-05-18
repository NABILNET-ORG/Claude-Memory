#!/usr/bin/env tsx
/**
 * Live end-to-end smoke for M5 Curriculum CONSUMER tools (S32).
 *
 * Fills the gap left by smoke-m5.ts (S21): that script exercises raw SQL
 * RPCs directly; this one exercises the MCP HANDLER LAYER imported from
 * src/tools/curriculum.ts so the verification gate path, error wrapping,
 * and daemon telemetry recordVerified/recordRejected hooks are all live.
 *
 * Two flows:
 *   1. Happy path with linked candidate — exercises the atomic auto-promote
 *      bridge end-to-end and asserts the three-timestamp equality.
 *   2. Reject path — exercises rejectCurriculumTask separately from apply.
 *
 * Both flows clean up under their own per-flow project_id namespace, so a
 * crash mid-flow at worst leaks rows under a uuid-suffixed project_id that
 * never collides with production.
 *
 * Run: npm run smoke:m5-consumer
 */

import {
  uniqueProjectId,
  cleanupProject,
  insertThrowawayCurriculumTask,
  insertThrowawaySkillCandidate,
  insertThrowawayCheckpoint,
} from "../tests/fixtures/m4.js";
import {
  listCurriculumTasks,
  pullCurriculumTask,
  applyCurriculumTask,
  rejectCurriculumTask,
} from "../src/tools/curriculum.js";
import { supabase } from "../src/supabase.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${msg}`);
  }
  console.log(`  ✓ ${msg}`);
}

async function happyPath(): Promise<void> {
  console.log("\n# smoke-m5-consumer: HAPPY PATH (enqueue → list → pull → apply auto-promote)");
  const projectId = uniqueProjectId();
  try {
    const candId = await insertThrowawaySkillCandidate(projectId, {
      frequency: 5,
      state: "mined",
      proposedName: `smoke-m5-consumer-${Date.now()}`,
      proposedSteps: [
        { step: 1, action: "noop", purpose: "smoke seed" },
      ],
    });
    const cpId = await insertThrowawayCheckpoint(projectId, {
      stepLabel: "smoke-m5-consumer-cp",
      status: "committed",
    });
    const taskId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: `skill_candidate:smoke-${candId}`,
      linkedCandidateId: candId,
      rationale: "smoke-m5-consumer: handler-layer e2e",
    });
    assert(taskId > 0, "seeded curriculum_tasks row");

    // list_curriculum_tasks (handler)
    const listed = await listCurriculumTasks({
      project_id: projectId,
      status: "queued",
    });
    assert(listed.count === 1, "list_curriculum_tasks returns the one queued row");
    assert(listed.tasks[0].id === taskId, "listed task id matches");

    // pull_curriculum_task (handler)
    const pulled = await pullCurriculumTask({
      project_id: projectId,
      session_id: "smoke-m5-consumer",
    });
    assert(pulled.claimed === true, "pull_curriculum_task claimed the row");
    assert(pulled.task !== null && pulled.task.id === taskId, "pulled task id matches");
    assert(pulled.task!.linked_candidate_id === candId, "linked_candidate_id carried through pull");

    // apply_curriculum_task SUCCESS with auto-promote (handler)
    const applied = await applyCurriculumTask({
      task_id: taskId,
      success: true,
      checkpoint_id: cpId,
      description: "smoke-m5-consumer: atomic auto-promote",
      bypass_verification_gate: true,
    });
    assert(applied.ok === true, "apply_curriculum_task ok");
    assert(applied.gate_clear === true, "gate clear (bypass=true)");
    assert(applied.result !== null, "apply result payload present");
    assert(applied.result!.applied_status === "verified", "applied_status=verified");
    assert(applied.result!.promoted_candidate_id === candId, "candidate id returned");
    assert(
      typeof applied.result!.promoted_skill_id === "number" &&
        applied.result!.promoted_skill_id > 0,
      "promoted_skill_id is a positive bigint",
    );

    // Atomic-tx proof: three timestamps identical to the microsecond.
    const skillId = applied.result!.promoted_skill_id!;
    const [{ data: task }, { data: cand }, { data: skill }] = await Promise.all([
      supabase
        .from("curriculum_tasks")
        .select("verified_at, linked_checkpoint_id, status")
        .eq("id", taskId)
        .single(),
      supabase
        .from("skill_candidates")
        .select("updated_at, state, promoted_skill_id")
        .eq("id", candId)
        .single(),
      supabase
        .from("agent_skills")
        .select("created_at, name, project_id")
        .eq("id", skillId)
        .single(),
    ]);
    assert(task !== null, "curriculum_tasks row readable");
    assert(cand !== null, "skill_candidates row readable");
    assert(skill !== null, "agent_skills row readable");
    assert(task!.status === "verified", "task.status = verified");
    assert(cand!.state === "promoted", "candidate.state = promoted");
    assert(cand!.promoted_skill_id === skillId, "candidate.promoted_skill_id wired");
    assert(skill!.project_id === projectId, "agent_skills.project_id matches");
    assert(
      task!.verified_at === cand!.updated_at,
      `ATOMIC: task.verified_at (${task!.verified_at}) === candidate.updated_at (${cand!.updated_at})`,
    );
    assert(
      cand!.updated_at === skill!.created_at,
      `ATOMIC: candidate.updated_at (${cand!.updated_at}) === skill.created_at (${skill!.created_at})`,
    );
    assert(
      applied.result!.promoted_at === task!.verified_at,
      `ATOMIC: RPC promoted_at (${applied.result!.promoted_at}) === task.verified_at (${task!.verified_at})`,
    );
  } finally {
    await cleanupProject(projectId);
  }
}

async function rejectPath(): Promise<void> {
  console.log("\n# smoke-m5-consumer: REJECT PATH (enqueue → reject → verify)");
  const projectId = uniqueProjectId();
  try {
    const taskId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "smoke-reject",
    });
    const result = await rejectCurriculumTask({
      task_id: taskId,
      reason: "smoke-m5-consumer: reject smoke",
    });
    assert(result.ok === true, "reject ok");
    assert(result.status === "rejected", "status=rejected");

    const { data: row } = await supabase
      .from("curriculum_tasks")
      .select("status, rejection_reason, verified_at")
      .eq("id", taskId)
      .single();
    assert(row !== null && row.status === "rejected", "row status persisted");
    assert(row!.rejection_reason === "smoke-m5-consumer: reject smoke", "reason persisted");
    assert(row!.verified_at === null, "verified_at not stamped on reject");
  } finally {
    await cleanupProject(projectId);
  }
}

(async () => {
  const t0 = Date.now();
  try {
    await happyPath();
    await rejectPath();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`\n✓ smoke-m5-consumer: ALL ASSERTIONS PASSED (${elapsed}s)`);
    process.exit(0);
  } catch (err) {
    console.error(`\n✗ smoke-m5-consumer: FAILED`, err);
    process.exit(1);
  }
})();
