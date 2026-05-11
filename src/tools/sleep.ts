// Sleep Learning tool handlers (Agentic OS 2026 / Mission 3 / SCM-S19-D1).
// Three handlers — review queue interaction for skill_candidates:
//   * list_skill_candidates    → SELECT from skill_candidates (filterable)
//   * promote_skill_candidate  → promote_candidate_to_skill RPC
//   * reject_skill_candidate   → UPDATE state='rejected' + notes
//
// Parameter validation + error envelope mirror src/tools/skills.ts.

import { z } from "zod";
import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";

// ─── list_skill_candidates ────────────────────────────────────────────────

export const listSkillCandidatesInputShape = {
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace filter. Defaults to the slugified current working directory ('${currentProjectId}'). ` +
        "Pass 'GLOBAL' to surface promoted-to-global candidates (mining itself is per-project).",
    ),
  state: z
    .enum(["mined", "promoted", "rejected"])
    .optional()
    .describe(
      "Lifecycle filter. Omit to surface all states. Default review queue is state='mined'.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .default(50)
    .describe("Hard cap on rows returned. Default 50."),
};

const listSkillCandidatesSchema = z.object(listSkillCandidatesInputShape);
export type ListSkillCandidatesInput = z.infer<typeof listSkillCandidatesSchema>;

export type SkillCandidateRow = {
  id: number;
  project_id: string;
  pattern_hash: string;
  source_summary_ids: number[];
  source_backlog_ids: number[];
  frequency: number;
  success_count: number;
  proposed_name: string | null;
  proposed_steps: unknown;
  state: "mined" | "promoted" | "rejected";
  promoted_skill_id: number | null;
  rejection_reason: string | null;
  model: string | null;
  strategy: string;
  created_at: string;
  updated_at: string;
};

export type ListSkillCandidatesResult = {
  count: number;
  candidates: SkillCandidateRow[];
};

export async function listSkillCandidates(
  args: ListSkillCandidatesInput,
): Promise<ListSkillCandidatesResult> {
  const parsed = listSkillCandidatesSchema.parse(args);
  const projectId = parsed.project_id ?? currentProjectId;
  const limit = parsed.limit ?? 50;

  let q = supabase
    .from("skill_candidates")
    .select(
      "id, project_id, pattern_hash, source_summary_ids, source_backlog_ids, " +
        "frequency, success_count, proposed_name, proposed_steps, state, " +
        "promoted_skill_id, rejection_reason, model, strategy, created_at, updated_at",
    )
    .eq("project_id", projectId)
    .order("frequency", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (parsed.state) q = q.eq("state", parsed.state);

  const { data, error } = await q;
  if (error) {
    throw new Error(`list_skill_candidates failed: ${error.message}`);
  }
  const rows = (data ?? []) as unknown as SkillCandidateRow[];
  return { count: rows.length, candidates: rows };
}

// ─── promote_skill_candidate ──────────────────────────────────────────────

export const promoteSkillCandidateInputShape = {
  candidate_id: z
    .number()
    .int()
    .positive()
    .describe("skill_candidates.id of the row to promote."),
  description: z
    .string()
    .optional()
    .describe(
      "Optional override for the agent_skills.description. Defaults to the candidate's " +
        "proposed_name + first 200 chars of joined steps so the M1 retrieval surface has " +
        "something to embed.",
    ),
  trigger_keywords: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      "Optional lexical hints for the M1 detector (mirror packageSkill). Stored verbatim.",
    ),
};

const promoteSkillCandidateSchema = z.object(promoteSkillCandidateInputShape);
export type PromoteSkillCandidateInput = z.infer<typeof promoteSkillCandidateSchema>;

export type PromoteSkillCandidateResult = {
  candidate_id: number;
  skill_id: number;
  skill_version: number;
  promoted_at: string;
};

export async function promoteSkillCandidate(
  args: PromoteSkillCandidateInput,
): Promise<PromoteSkillCandidateResult> {
  const parsed = promoteSkillCandidateSchema.parse(args);

  // Fetch the candidate so we can synthesize a description if the caller
  // didn't supply one. The RPC will re-validate state/eligibility — this
  // round-trip just provides good defaults.
  const description = await resolveDescription(parsed);

  const { data, error } = await supabase.rpc("promote_candidate_to_skill", {
    p_candidate_id: parsed.candidate_id,
    p_description: description,
    p_trigger_keywords: parsed.trigger_keywords,
  });

  if (error) {
    throw new Error(`promote_candidate_to_skill failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{
    candidate_id: number;
    skill_id: number;
    skill_version: number;
    promoted_at: string;
  }>;
  if (rows.length === 0) {
    throw new Error("promote_candidate_to_skill returned no rows");
  }
  const head = rows[0];
  return {
    candidate_id: head.candidate_id,
    skill_id: head.skill_id,
    skill_version: head.skill_version,
    promoted_at: head.promoted_at,
  };
}

async function resolveDescription(
  parsed: PromoteSkillCandidateInput,
): Promise<string> {
  if (parsed.description && parsed.description.trim().length > 0) {
    return parsed.description.trim();
  }
  const { data, error } = await supabase
    .from("skill_candidates")
    .select("proposed_name, proposed_steps")
    .eq("id", parsed.candidate_id)
    .maybeSingle();
  if (error) {
    throw new Error(`resolve_description failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`candidate ${parsed.candidate_id} not found`);
  }
  const name = (data.proposed_name as string | null) ?? `candidate-${parsed.candidate_id}`;
  let stepsBlurb = "";
  const steps = data.proposed_steps;
  if (Array.isArray(steps)) {
    const actions: string[] = [];
    for (const s of steps) {
      if (s && typeof s === "object" && "action" in s && typeof (s as { action: unknown }).action === "string") {
        actions.push((s as { action: string }).action);
      }
    }
    stepsBlurb = actions.join("; ").slice(0, 200);
  }
  return `${name}: ${stepsBlurb}`.slice(0, 500);
}

// ─── reject_skill_candidate ───────────────────────────────────────────────

export const rejectSkillCandidateInputShape = {
  candidate_id: z
    .number()
    .int()
    .positive()
    .describe("skill_candidates.id of the row to reject."),
  reason: z
    .string()
    .min(1)
    .describe(
      "Why this candidate is not skill-worthy. Persisted in rejection_reason for audit; " +
        "future re-mining of the same (project_id, pattern_hash) preserves the rejection.",
    ),
};

const rejectSkillCandidateSchema = z.object(rejectSkillCandidateInputShape);
export type RejectSkillCandidateInput = z.infer<typeof rejectSkillCandidateSchema>;

export type RejectSkillCandidateResult = {
  candidate_id: number;
  state: "rejected";
  rejection_reason: string;
  updated_at: string;
};

export async function rejectSkillCandidate(
  args: RejectSkillCandidateInput,
): Promise<RejectSkillCandidateResult> {
  const parsed = rejectSkillCandidateSchema.parse(args);

  const { data, error } = await supabase
    .from("skill_candidates")
    .update({
      state: "rejected",
      rejection_reason: parsed.reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.candidate_id)
    .select("id, state, rejection_reason, updated_at")
    .maybeSingle();

  if (error) {
    throw new Error(`reject_skill_candidate failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`candidate ${parsed.candidate_id} not found`);
  }
  return {
    candidate_id: data.id as number,
    state: "rejected",
    rejection_reason: (data.rejection_reason as string) ?? parsed.reason,
    updated_at: data.updated_at as string,
  };
}
