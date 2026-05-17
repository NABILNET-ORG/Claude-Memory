// Characterization tests for src/curriculum/scanner.ts —
// scanRollbackHotspots (rollback_repro source). Closes the autonomous
// learning loop: M4 produces rolledback checkpoints → M5 mines them into
// curriculum_tasks of kind 'rollback_repro' once threshold + window are met.
//
// Runtime: node:test + node:assert/strict via tsx. Live Supabase under
// unique per-test project_id namespaces.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { scanRollbackHotspots } from "../src/curriculum/scanner.js";
import { supabase } from "../src/supabase.js";
import {
  uniqueProjectId,
  insertThrowawayCheckpoint,
  cleanupProject,
} from "./fixtures/m4.js";

describe("scanRollbackHotspots — rollback_repro source", () => {
  const projectId = uniqueProjectId();
  after(async () => {
    await cleanupProject(projectId);
  });

  // ScannerConfig has 9 required fields (verified via Session 30 smoke).
  // Only rollback knobs vary per test; the rest are production-default
  // no-op values for this Epic.
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

  test("empty corpus → 0 enqueued", async () => {
    const r = await scanRollbackHotspots(makeCfg());
    assert.equal(r.source, "rollback_repro");
    assert.equal(r.enqueued, 0);
  });

  test("2 rolledbacks (threshold=3) → 0 enqueued", async () => {
    await insertThrowawayCheckpoint(projectId, {
      stepLabel: "src/below-threshold.ts",
      status: "rolledback",
      rollbackReason: "test-1",
    });
    await insertThrowawayCheckpoint(projectId, {
      stepLabel: "src/below-threshold.ts",
      status: "rolledback",
      rollbackReason: "test-2",
    });

    const r = await scanRollbackHotspots(makeCfg());
    assert.equal(r.enqueued, 0);

    const { count } = await supabase
      .from("curriculum_tasks")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("kind", "rollback_repro");
    assert.equal(count, 0);
  });

  test("3 rolledbacks at threshold → 1 enqueued with target_path=step_label", async () => {
    const stepLabel = "src/at-threshold.ts";
    for (let i = 0; i < 3; i++) {
      await insertThrowawayCheckpoint(projectId, {
        stepLabel,
        status: "rolledback",
        rollbackReason: `test-${i}`,
      });
    }

    const r = await scanRollbackHotspots(makeCfg());
    assert.equal(r.enqueued, 1);

    const { data, error } = await supabase
      .from("curriculum_tasks")
      .select("kind, target_path, status, rationale")
      .eq("project_id", projectId)
      .eq("kind", "rollback_repro")
      .eq("target_path", stepLabel)
      .single();
    assert.equal(error, null);
    assert.equal(data?.kind, "rollback_repro");
    assert.equal(data?.target_path, stepLabel);
    assert.equal(data?.status, "queued");
    assert.ok((data?.rationale ?? "").length > 0, "rationale should be non-empty");
  });

  test("two distinct step_labels both >= threshold → 2 enqueued", async () => {
    const subProjectId = uniqueProjectId();
    try {
      for (const label of ["src/groupA.ts", "src/groupB.ts"]) {
        for (let i = 0; i < 3; i++) {
          await insertThrowawayCheckpoint(subProjectId, {
            stepLabel: label,
            status: "rolledback",
            rollbackReason: `test-${label}-${i}`,
          });
        }
      }

      const r = await scanRollbackHotspots(makeCfg({ projectId: subProjectId }));
      assert.equal(r.enqueued, 2);

      const { count } = await supabase
        .from("curriculum_tasks")
        .select("id", { count: "exact", head: true })
        .eq("project_id", subProjectId)
        .eq("kind", "rollback_repro");
      assert.equal(count, 2);
    } finally {
      await cleanupProject(subProjectId);
    }
  });

  test("3 rolledbacks older than window → 0 enqueued", async () => {
    const subProjectId = uniqueProjectId();
    try {
      // 60 days ago = well outside the default 30-day window.
      const oldTimestamp = new Date(
        Date.now() - 60 * 24 * 60 * 60 * 1000,
      ).toISOString();
      for (let i = 0; i < 3; i++) {
        await insertThrowawayCheckpoint(subProjectId, {
          stepLabel: "src/old-rolledback.ts",
          status: "rolledback",
          rollbackReason: `test-old-${i}`,
          createdAt: oldTimestamp,
        });
      }

      const r = await scanRollbackHotspots(makeCfg({ projectId: subProjectId }));
      assert.equal(r.enqueued, 0);
    } finally {
      await cleanupProject(subProjectId);
    }
  });

  test("rolledbacks with whitespace-only step_label are skipped from aggregation", async () => {
    const subProjectId = uniqueProjectId();
    try {
      // Insert directly via supabase (the fixture would require a non-empty
      // string at the type level; we want to test the scanner's defensive skip).
      for (let i = 0; i < 3; i++) {
        const { error } = await supabase.from("workflow_checkpoints").insert({
          project_id: subProjectId,
          step_label: "   ",
          status: "rolledback",
          rollback_reason: `test-empty-${i}`,
        });
        assert.equal(error, null);
      }

      const r = await scanRollbackHotspots(makeCfg({ projectId: subProjectId }));
      // Defensive — accept either 0 (scanner trims & skips) or document the
      // current behavior. We assert 0 here per the plan's expectation; if the
      // scanner does NOT trim, this fails and the assertion needs to flip to
      // reflect current behavior + a hardening commit gets filed.
      assert.equal(r.enqueued, 0);
    } finally {
      await cleanupProject(subProjectId);
    }
  });

  test("re-running scan on same hotspot does not double-enqueue", async () => {
    const subProjectId = uniqueProjectId();
    try {
      const stepLabel = "src/dedup.ts";
      for (let i = 0; i < 3; i++) {
        await insertThrowawayCheckpoint(subProjectId, {
          stepLabel,
          status: "rolledback",
          rollbackReason: `test-dedup-${i}`,
        });
      }

      const r1 = await scanRollbackHotspots(makeCfg({ projectId: subProjectId }));
      assert.equal(r1.enqueued, 1);

      // Partial unique constraint (project_id, target_path, kind) WHERE
      // status='queued' should prevent a second queued row.
      const r2 = await scanRollbackHotspots(makeCfg({ projectId: subProjectId }));
      assert.equal(r2.enqueued, 0);

      const { count } = await supabase
        .from("curriculum_tasks")
        .select("id", { count: "exact", head: true })
        .eq("project_id", subProjectId)
        .eq("kind", "rollback_repro")
        .eq("target_path", stepLabel);
      assert.equal(count, 1);
    } finally {
      await cleanupProject(subProjectId);
    }
  });
});
