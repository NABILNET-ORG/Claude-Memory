// M7 Skill Graduation — handler-layer characterization tests.
//
// Suites B (composeGlobalRationale) + C (confirmPromotion + apply_graduation RPC)
// + D (rejectGraduation) + E (listGraduationCandidates) land here as Tasks 5-8.
// S0 ships first and only checks that migration 017 is applied (schema exists).

import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { supabase } from "../src/supabase.js";
import { uniqueProjectId, cleanupProject } from "./fixtures/m4.js";

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

// ─── S0: migration 017 sanity ─────────────────────────────────────────────
// Probes the full column list with limit(0) so PostgREST validates the schema
// without reading rows. Any column missing from the table → error from the
// API layer. This is the failing test that drives Task 1's migration.

test("S0: skill_graduations table exists with the expected column shape", async () => {
  const columns = [
    "id",
    "project_id",
    "source_skill_id",
    "state",
    "frequency_at_propose",
    "success_rate_at_propose",
    "age_days_at_propose",
    "proposed_global_rationale",
    "cross_project_verdict",
    "cross_project_evidence",
    "model",
    "composed_at",
    "promoted_global_skill_id",
    "rejection_reason",
    "decided_at",
    "created_at",
    "updated_at",
  ].join(",");

  const { error } = await supabase.from("skill_graduations").select(columns).limit(0);
  assert.equal(
    error,
    null,
    `S0 schema check failed — migration 017 not applied or column shape drifted: ${
      error?.message ?? "(no message)"
    }`,
  );
});
