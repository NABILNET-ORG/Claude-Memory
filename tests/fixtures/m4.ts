// Per-test setup/teardown for M4 checkpoint tests.
// Every test creates rows under a unique project_id namespace so cleanup is
// exhaustive: a single DELETE on that project_id wipes ALL test artefacts.

import { createHash, randomUUID } from "node:crypto";
import { supabase } from "../../src/supabase.js";

export function uniqueProjectId(): string {
  return `__test_m4_${randomUUID().slice(0, 8)}__`;
}

// memory_chunks NOT NULL columns we have to satisfy:
//   * embedding   vector(768)  → zero vector
//   * content_hash text         → sha256(content) hex
const ZERO_EMBEDDING = JSON.stringify(new Array(768).fill(0));

export async function insertThrowawayChunk(projectId: string): Promise<number> {
  // Use the project_id in the content so each test's chunk hashes uniquely,
  // dodging any (file_origin, content_hash) uniqueness constraint between runs.
  const content = `m4-test-chunk-${projectId}`;
  const contentHash = createHash("sha256").update(content).digest("hex");
  const { data, error } = await supabase
    .from("memory_chunks")
    .insert({
      project_id: projectId,
      file_origin: "__m4_test__",
      chunk_index: 0,
      content,
      content_hash: contentHash,
      embedding: ZERO_EMBEDDING,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`insertThrowawayChunk failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

export async function insertThrowawayBacklogRow(projectId: string): Promise<number> {
  const { data, error } = await supabase
    .from("cloud_backlog")
    .insert({
      project_id: projectId,
      title: "__m4_test_task__",
      status: "todo",
      metadata: {},
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`insertThrowawayBacklogRow failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

export type ThrowawayCheckpointOpts = {
  stepLabel: string;
  status?: "open" | "committed" | "rolledback";
  skillId?: number | null;
  parentId?: number | null;
  sourceChunkId?: number | null;
  rollbackReason?: string | null;
  // ISO timestamp string. When omitted, server default `now()` is used.
  // Use to test the rollback_repro 30-day window: pass an old timestamp
  // to verify out-of-window rows are excluded from the aggregate.
  createdAt?: string;
};

export async function insertThrowawayCheckpoint(
  projectId: string,
  opts: ThrowawayCheckpointOpts,
): Promise<number> {
  const row: Record<string, unknown> = {
    project_id: projectId,
    step_label: opts.stepLabel,
    status: opts.status ?? "open",
    skill_id: opts.skillId ?? null,
    parent_id: opts.parentId ?? null,
    source_chunk_id: opts.sourceChunkId ?? null,
    rollback_reason: opts.rollbackReason ?? null,
  };
  if (opts.createdAt !== undefined) {
    row.created_at = opts.createdAt;
  }
  const { data, error } = await supabase
    .from("workflow_checkpoints")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertThrowawayCheckpoint failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id;
}

export type ThrowawaySkillCandidateOpts = {
  // pattern_hash defaults to a uuid-derived value so tests don't collide
  // on the (project_id, pattern_hash) unique constraint. Pass explicitly
  // when a test asserts on the derived target_path = `skill_candidate:${pattern_hash}`.
  patternHash?: string;
  state?: "mined" | "promoted" | "rejected";
  frequency?: number;
  successCount?: number;
  proposedName?: string | null;
  // promote_candidate_to_skill (012_sleep_learning.sql:295) raises on NULL
  // proposed_name OR proposed_steps. Tests that drive apply_curriculum_task
  // through the success+linked_candidate atomic-promote path MUST set both.
  // Pass `null` explicitly to characterize the NULL-aborts path (S32 C4).
  proposedSteps?: unknown[] | null;
  // ISO timestamp string. When omitted, server default `now()` is used.
  // Use to test the staleCandidateMinAgeDays window.
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
    proposed_name:
      opts.proposedName === null ? null : (opts.proposedName ?? `__m5_test_${patternHash.slice(-8)}`),
    proposed_steps:
      opts.proposedSteps === null ? null : (opts.proposedSteps ?? null),
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

// ─── insertThrowawayCurriculumTask ────────────────────────────────────────
// M5 Consumer (S32) fixture. Inserts a single curriculum_tasks row under the
// test's project_id namespace. Default kind='refactor' + status='queued' so
// the row is immediately pullable. Pass linkedCandidateId to exercise the
// auto-promote bridge in apply_curriculum_task.

export type ThrowawayCurriculumTaskOpts = {
  kind?: "test_gap" | "refactor" | "rollback_repro";
  targetPath?: string;
  rationale?: string;
  signalSource?: Record<string, unknown>;
  linkedCandidateId?: number | null;
  status?: "queued" | "pulled" | "attempted" | "verified" | "rejected" | "expired";
  createdAt?: string;
};

export async function insertThrowawayCurriculumTask(
  projectId: string,
  opts: ThrowawayCurriculumTaskOpts = {},
): Promise<number> {
  const kind = opts.kind ?? "refactor";
  // target_path must be unique per (project, target, kind) WHEN status='queued'
  // (partial unique index curriculum_tasks_queued_target_kind_uniq).
  // Random suffix dodges this when tests stack multiple queued rows.
  const targetPath = opts.targetPath ?? `__m5_test_${randomUUID().slice(0, 8)}`;
  const row: Record<string, unknown> = {
    project_id: projectId,
    kind,
    target_path: targetPath,
    rationale: opts.rationale ?? `__m5_consumer_test:${kind}`,
    signal_source: opts.signalSource ?? {},
    linked_candidate_id: opts.linkedCandidateId ?? null,
    status: opts.status ?? "queued",
  };
  if (opts.createdAt !== undefined) {
    row.created_at = opts.createdAt;
  }
  const { data, error } = await supabase
    .from("curriculum_tasks")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertThrowawayCurriculumTask failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id;
}

// ─── insertThrowawaySkill ─────────────────────────────────────────────────
// M7 fixture. Inserts an agent_skills row under the test's project_id.
// Default name embeds the SOURCE project_id as a prefix so the GLOBAL clone
// (created by apply_graduation copying name verbatim) is uniquely
// attributable to this test's pid — even though it lives at
// project_id='GLOBAL'. This is what makes cleanupProject's GLOBAL sweep
// safe under parallel node:test file execution (each file's child process
// only sweeps GLOBAL clones whose name starts with ITS pid).

export type ThrowawaySkillOpts = {
  name?: string;
  description?: string;
  steps?: unknown[];
  triggerKeywords?: string[];
  frequencyUsed?: number;
  successRate?: number;
  // Backdate created_at by N days. Used by Suite A4 + smoke to satisfy the
  // minAgeDays threshold without waiting wall-clock time.
  ageDaysOverride?: number;
};

export async function insertThrowawaySkill(
  projectId: string,
  opts: ThrowawaySkillOpts = {},
): Promise<number> {
  // Default name embeds the pid for parallel-test cleanup safety. Callers
  // passing a custom name must include the pid as a prefix themselves to
  // get the same isolation — see C5/C7 in graduation-handlers.test.ts.
  const name = opts.name ?? `${projectId}__m7skill_${randomUUID().slice(0, 8)}`;
  const row: Record<string, unknown> = {
    project_id: projectId,
    name,
    version: 1,
    description: opts.description ?? `__m7_test description for ${name}`,
    steps: opts.steps ?? [],
    trigger_keywords: opts.triggerKeywords ?? [],
    embedding: ZERO_EMBEDDING,
    frequency_used: opts.frequencyUsed ?? 0,
    success_rate: opts.successRate ?? 1.0,
  };
  if (opts.ageDaysOverride !== undefined && opts.ageDaysOverride > 0) {
    row.created_at = new Date(
      Date.now() - opts.ageDaysOverride * 86_400_000,
    ).toISOString();
  }
  const { data, error } = await supabase
    .from("agent_skills")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`insertThrowawaySkill failed: ${error?.message ?? "no row returned"}`);
  }
  return data.id;
}

// ─── insertThrowawayGraduation ────────────────────────────────────────────
// M7 fixture. Inserts a skill_graduations row. Defaults state='proposed' with
// NULL compose/decision columns — the test then drives composeGlobalRationale
// / confirmPromotion / rejectGraduation to flip state through the lifecycle.

export type ThrowawayGraduationOpts = {
  state?: "proposed" | "composed" | "approved" | "rejected";
  frequencyAtPropose?: number;
  successRateAtPropose?: number;
  ageDaysAtPropose?: number;
  proposedGlobalRationale?: string | null;
  crossProjectVerdict?: "pass" | "fail" | null;
  crossProjectEvidence?: string | null;
  model?: string | null;
  composedAt?: string;
  rejectionReason?: string | null;
};

export async function insertThrowawayGraduation(
  projectId: string,
  sourceSkillId: number,
  opts: ThrowawayGraduationOpts = {},
): Promise<number> {
  const state = opts.state ?? "proposed";
  const row: Record<string, unknown> = {
    project_id: projectId,
    source_skill_id: sourceSkillId,
    state,
    frequency_at_propose: opts.frequencyAtPropose ?? 10,
    success_rate_at_propose: opts.successRateAtPropose ?? 0.95,
    age_days_at_propose: opts.ageDaysAtPropose ?? 14,
  };
  // Compose-output columns are only meaningful for state in ('composed','approved','rejected').
  if (opts.proposedGlobalRationale !== undefined) {
    row.proposed_global_rationale = opts.proposedGlobalRationale;
  }
  if (opts.crossProjectVerdict !== undefined) {
    row.cross_project_verdict = opts.crossProjectVerdict;
  }
  if (opts.crossProjectEvidence !== undefined) {
    row.cross_project_evidence = opts.crossProjectEvidence;
  }
  if (opts.model !== undefined) {
    row.model = opts.model;
  }
  if (opts.composedAt !== undefined) {
    row.composed_at = opts.composedAt;
  }
  if (opts.rejectionReason !== undefined) {
    row.rejection_reason = opts.rejectionReason;
  }
  const { data, error } = await supabase
    .from("skill_graduations")
    .insert(row)
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertThrowawayGraduation failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id;
}

export async function cleanupProject(projectId: string): Promise<void> {
  // Order matters. FK direction map (children → parents):
  //   * skill_graduations.source_skill_id → agent_skills.id (CASCADE)
  //   * skill_graduations.promoted_global_skill_id → agent_skills.id (SET NULL)
  //   * curriculum_tasks → workflow_checkpoints + skill_candidates (SET NULL)
  //   * skill_candidates.promoted_skill_id → agent_skills.id (SET NULL)
  //   * workflow_checkpoints.skill_id → agent_skills.id (SET NULL)
  //   * workflow_checkpoints.source_chunk_id → memory_chunks.id (SET NULL)
  //
  // We DELETE children before parents to keep the trace clean even if
  // CASCADE would also handle it. The GLOBAL sweep at the end clears
  // confirm_promotion-minted clones (project_id='GLOBAL') by the
  // `__m7_test_` name prefix — keeps live GLOBAL vault rows safe.
  await supabase.from("skill_graduations").delete().eq("project_id", projectId);
  await supabase.from("curriculum_tasks").delete().eq("project_id", projectId);
  await supabase.from("skill_candidates").delete().eq("project_id", projectId);
  await supabase.from("agent_skills").delete().eq("project_id", projectId);
  await supabase.from("workflow_checkpoints").delete().eq("project_id", projectId);
  await supabase.from("cloud_backlog").delete().eq("project_id", projectId);
  await supabase.from("memory_chunks").delete().eq("project_id", projectId);
  // GLOBAL clones minted by confirm_promotion. Sweep is pid-scoped — only
  // rows whose name begins with this test's projectId get cleaned. This
  // makes cleanupProject safe under parallel node:test file execution
  // (different files' cleanup hooks don't trample each other's clones).
  await supabase
    .from("agent_skills")
    .delete()
    .eq("project_id", "GLOBAL")
    .like("name", `${projectId}__%`);
}
