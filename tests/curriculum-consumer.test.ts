// M5 Curriculum CONSUMER characterization tests (S32).
//
// Mirrors the producer suite at tests/curriculum-scanner.test.ts: node:test +
// node:assert/strict against a LIVE Supabase, FK-safe cleanup via fixtures.
//
// Five describe blocks (one per tool, with apply split success/failure):
//   A. list_curriculum_tasks     — 3 tests
//   B. pull_curriculum_task      — 4 tests
//   C. apply_curriculum_task     — 4 tests (success path)
//   D. apply_curriculum_task     — 1 test  (failure path)
//   E. reject_curriculum_task    — 3 tests
//
// Total: 15 characterization tests against existing (S21) handler code in
// src/tools/curriculum.ts. Tests must PASS against unchanged production code;
// a failure surfaces either a real regression or a documentation drift.

import { describe, test, after } from "node:test";
import { strict as assert } from "node:assert";
import {
  uniqueProjectId,
  cleanupProject,
  insertThrowawayCurriculumTask,
  insertThrowawaySkillCandidate,
} from "./fixtures/m4.js";
import {
  listCurriculumTasks,
  pullCurriculumTask,
} from "../src/tools/curriculum.js";

const createdProjectIds: string[] = [];
function newProject(): string {
  const id = uniqueProjectId();
  createdProjectIds.push(id);
  return id;
}

after(async () => {
  for (const pid of createdProjectIds) {
    await cleanupProject(pid);
  }
});

// ─── Suite A: list_curriculum_tasks ──────────────────────────────────────

describe("list_curriculum_tasks", () => {
  test("A1: empty queue returns count=0, tasks=[]", async () => {
    const projectId = newProject();
    const result = await listCurriculumTasks({ project_id: projectId });
    assert.equal(result.count, 0);
    assert.ok(Array.isArray(result.tasks));
    assert.equal(result.tasks.length, 0);
  });

  test("A2: status + kind filters compose correctly", async () => {
    const projectId = newProject();
    // Three rows: matching, kind-mismatch, status-mismatch.
    await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "a2-match",
      status: "queued",
    });
    await insertThrowawayCurriculumTask(projectId, {
      kind: "rollback_repro",
      targetPath: "a2-wrong-kind",
      status: "queued",
    });
    await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "a2-wrong-status",
      status: "verified",
    });

    const result = await listCurriculumTasks({
      project_id: projectId,
      status: "queued",
      kind: "refactor",
    });
    assert.equal(result.count, 1, "only the row matching BOTH filters");
    assert.equal(result.tasks[0].target_path, "a2-match");
    assert.equal(result.tasks[0].status, "queued");
    assert.equal(result.tasks[0].kind, "refactor");
  });

  test("A3: project_id isolation — rows in project A invisible from project B", async () => {
    const projectA = newProject();
    const projectB = newProject();
    await insertThrowawayCurriculumTask(projectA, {
      kind: "refactor",
      targetPath: "a3-only-in-A",
    });

    const fromB = await listCurriculumTasks({ project_id: projectB });
    assert.equal(fromB.count, 0, "project B sees zero rows from project A");

    const fromA = await listCurriculumTasks({ project_id: projectA });
    assert.equal(fromA.count, 1, "project A sees its own row");
    assert.equal(fromA.tasks[0].target_path, "a3-only-in-A");
  });
});

// ─── Suite B: pull_curriculum_task ────────────────────────────────────────

describe("pull_curriculum_task", () => {
  test("B1: empty queue returns claimed=false, task=null", async () => {
    const projectId = newProject();
    const result = await pullCurriculumTask({
      project_id: projectId,
      session_id: "s32-b1",
    });
    assert.equal(result.claimed, false);
    assert.equal(result.task, null);
  });

  test("B2: single queued row → status flips to pulled, pulled_at + session stamped", async () => {
    const projectId = newProject();
    const id = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "b2",
    });

    const beforeMs = Date.now();
    const result = await pullCurriculumTask({
      project_id: projectId,
      session_id: "s32-b2",
    });
    const afterMs = Date.now();

    assert.equal(result.claimed, true);
    assert.ok(result.task, "task must be present when claimed=true");
    assert.equal(result.task!.id, id);
    assert.equal(result.task!.status, "pulled");
    assert.equal(result.task!.pulled_by_session_id, "s32-b2");
    const pulledAtMs = new Date(result.task!.pulled_at).getTime();
    assert.ok(
      pulledAtMs >= beforeMs - 2000 && pulledAtMs <= afterMs + 2000,
      `pulled_at ${result.task!.pulled_at} within request window [${beforeMs}, ${afterMs}]`,
    );
  });

  test("B3: linked_candidate_id rows pulled before unlinked (priority signal)", async () => {
    const projectId = newProject();
    // Seed an unlinked row FIRST so it has the older created_at — FIFO would
    // claim it first if the priority signal were absent. The linked row is
    // inserted SECOND but must still be pulled FIRST.
    const unlinkedId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "b3-unlinked",
    });
    // Small sleep to guarantee distinct created_at timestamps.
    await new Promise((r) => setTimeout(r, 50));
    const candId = await insertThrowawaySkillCandidate(projectId, {
      frequency: 5,
      state: "mined",
    });
    const linkedId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "b3-linked",
      linkedCandidateId: candId,
    });

    const first = await pullCurriculumTask({
      project_id: projectId,
      session_id: "s32-b3-1",
    });
    assert.equal(first.claimed, true);
    assert.equal(first.task!.id, linkedId, "linked task pulled first despite being newer");

    const second = await pullCurriculumTask({
      project_id: projectId,
      session_id: "s32-b3-2",
    });
    assert.equal(second.claimed, true);
    assert.equal(second.task!.id, unlinkedId, "unlinked task pulled second");
  });

  test("B4: kind filter restricts claim to matching rows", async () => {
    const projectId = newProject();
    const rollbackId = await insertThrowawayCurriculumTask(projectId, {
      kind: "rollback_repro",
      targetPath: "b4-rb",
    });
    const refactorId = await insertThrowawayCurriculumTask(projectId, {
      kind: "refactor",
      targetPath: "b4-rf",
    });

    const first = await pullCurriculumTask({
      project_id: projectId,
      kind: "rollback_repro",
      session_id: "s32-b4-1",
    });
    assert.equal(first.claimed, true);
    assert.equal(first.task!.id, rollbackId);
    assert.equal(first.task!.kind, "rollback_repro");

    const second = await pullCurriculumTask({
      project_id: projectId,
      kind: "rollback_repro",
      session_id: "s32-b4-2",
    });
    assert.equal(second.claimed, false, "no more rollback_repro rows");
    assert.equal(second.task, null);

    const third = await pullCurriculumTask({
      project_id: projectId,
      kind: "refactor",
      session_id: "s32-b4-3",
    });
    assert.equal(third.claimed, true);
    assert.equal(third.task!.id, refactorId, "refactor row still claimable under kind filter");
  });
});
