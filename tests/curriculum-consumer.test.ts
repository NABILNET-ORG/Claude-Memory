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
} from "./fixtures/m4.js";
import { listCurriculumTasks } from "../src/tools/curriculum.js";

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
