import { z } from "zod";
import { embed } from "../ollama.js";
import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";

/**
 * JIT Skill Retrieval (Agentic OS 2026 / SCM-S17-D1 / ARCHITECTURE.md §4.4).
 *
 * Skills are EXECUTABLE artefacts persisted in the dedicated `agent_skills`
 * table — NOT a metadata.type extension of memory_chunks. The full `steps`
 * payload is injected at request time (JIT), never preloaded into the
 * system prompt. This keeps the agent's context window clean: only the
 * procedures the current task needs ever cross the wire.
 */

/** Reserved project_id for the GLOBAL Skill Vault (shared across all projects). */
export const GLOBAL_SKILL_PROJECT_ID = "GLOBAL";

// ─── package_skill ─────────────────────────────────────────────────────────

export const packageSkillInputShape = {
  name: z
    .string()
    .min(1)
    .describe("Unique skill name within the (project_id, name) identity. Reused names bump version, preserving telemetry."),
  description: z
    .string()
    .min(1)
    .describe("Natural-language summary of the skill's purpose. Embedded for semantic retrieval by request_skill."),
  steps: z
    .array(z.unknown())
    .min(1)
    .describe("Ordered array of executable steps (any JSON-serializable shape). Returned verbatim by request_skill."),
  trigger_keywords: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Lexical hints the agent's natural-language detector can short-circuit on. Not part of the ranking score."),
  is_global: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, the skill is stored under project_id='GLOBAL' (universal scope). STRICT RULE: only use for procedures " +
        "that apply to ALL projects (e.g., 'create a git commit', 'open a PR'). Never for project-specific logic. " +
        "Cross-Project Test: if the current project were deleted tomorrow, would this skill still be a gold-standard " +
        "reference for others? If no, keep it local.",
    ),
  packaged_from_archive_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional pointer to the archive_backlog row this skill was distilled from. Audit-only."),
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace override. Defaults to the slugified current working directory ('${currentProjectId}'). ` +
        "Ignored when is_global=true (the row is routed to 'GLOBAL').",
    ),
};

const packageSkillSchema = z.object(packageSkillInputShape);

export type PackageSkillInput = z.infer<typeof packageSkillSchema>;

export type PackageSkillResult = {
  id: number;
  project_id: string;
  name: string;
  version: number;
  scope: "project" | "global";
};

export async function packageSkill(args: PackageSkillInput): Promise<PackageSkillResult> {
  const parsed = packageSkillSchema.parse(args);

  const isGlobal = parsed.is_global === true;
  const projectId = isGlobal
    ? GLOBAL_SKILL_PROJECT_ID
    : (parsed.project_id ?? currentProjectId);

  // Embed the description — that's the natural retrieval surface. Steps are
  // executable JSON; embedding them would muddy semantic ranking.
  const [vec] = await embed([parsed.description]);

  const { data, error } = await supabase.rpc("upsert_agent_skill", {
    p_project_id: projectId,
    p_name: parsed.name,
    p_description: parsed.description,
    p_steps: parsed.steps,
    p_trigger_keywords: parsed.trigger_keywords,
    p_embedding: vec,
    p_packaged_from_archive_id: parsed.packaged_from_archive_id ?? null,
  });

  if (error) {
    throw new Error(`upsert_agent_skill failed: ${error.message}`);
  }

  // Supabase returns the SETOF as an array even when the function emits a
  // single row. Pick the head defensively.
  const rows = (data ?? []) as Array<{ id: number; version: number }>;
  if (rows.length === 0) {
    throw new Error("upsert_agent_skill returned no rows");
  }
  const head = rows[0];

  return {
    id: head.id,
    project_id: projectId,
    name: parsed.name,
    version: head.version,
    scope: isGlobal ? "global" : "project",
  };
}

// ─── request_skill ─────────────────────────────────────────────────────────

export const requestSkillInputShape = {
  query: z
    .string()
    .min(1)
    .describe("Natural-language task description. Embedded and matched against the skill description corpus."),
  k: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe("Maximum skills to return. Default 3 keeps the JIT injection minimal — most tasks need one."),
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("Cosine similarity floor. Below this, the skill isn't a real fit; the JIT bar refuses to inject noise."),
  include_global: z
    .boolean()
    .default(true)
    .describe("Default true. Dual-scopes across the current project_id AND the reserved 'GLOBAL' skill vault."),
  project_id: z
    .string()
    .optional()
    .describe(
      `Project namespace override. Defaults to the slugified current working directory ('${currentProjectId}').`,
    ),
  record_telemetry: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), every returned skill's frequency_used / last_invoked_at / success_rate is bumped " +
        "fire-and-forget. Pass false for read-only probes (e.g. introspection tooling) so the ranking surface " +
        "isn't perturbed by curiosity.",
    ),
};

const requestSkillSchema = z.object(requestSkillInputShape);

export type RequestSkillInput = z.infer<typeof requestSkillSchema>;

export type RequestSkillHit = {
  id: number;
  name: string;
  version: number;
  description: string;
  steps: unknown[];
  trigger_keywords: string[];
  similarity: number;
  rank_score: number;
  scope: "project" | "global";
};

export type RequestSkillResult = {
  query: string;
  count: number;
  skills: RequestSkillHit[];
};

type MatchAgentSkillRow = {
  id: number;
  project_id: string;
  name: string;
  version: number;
  description: string;
  steps: unknown[];
  trigger_keywords: string[];
  frequency_used: number;
  success_rate: number;
  last_invoked_at: string | null;
  packaged_from_archive_id: number | null;
  similarity: number;
  rank_score: number;
};

export async function requestSkill(args: RequestSkillInput): Promise<RequestSkillResult> {
  const parsed = requestSkillSchema.parse(args);
  const projectId = parsed.project_id ?? currentProjectId;

  const [queryVec] = await embed([parsed.query]);

  const { data, error } = await supabase.rpc("match_agent_skills", {
    query_embedding: queryVec,
    p_project_id: projectId,
    match_count: parsed.k,
    min_similarity: parsed.min_similarity,
    p_include_global: parsed.include_global,
  });

  if (error) {
    throw new Error(`match_agent_skills failed: ${error.message}`);
  }

  const rows = (data ?? []) as MatchAgentSkillRow[];

  const skills: RequestSkillHit[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    version: r.version,
    description: r.description,
    steps: r.steps,
    trigger_keywords: r.trigger_keywords,
    similarity: r.similarity,
    rank_score: r.rank_score,
    scope: r.project_id === GLOBAL_SKILL_PROJECT_ID ? "global" : "project",
  }));

  if (parsed.record_telemetry && rows.length > 0) {
    // Fire-and-forget. Telemetry failures must NEVER fail the retrieval —
    // a single failed bump should not block the LLM from receiving its skill.
    // Use Promise.allSettled and log non-throwing.
    void Promise.allSettled(
      rows.map((r) =>
        supabase.rpc("bump_skill_telemetry", { p_id: r.id, p_success: true }),
      ),
    ).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(
            `[smart-claude-memory] bump_skill_telemetry failed: ${String(result.reason)}`,
          );
        } else if (result.value.error) {
          console.error(
            `[smart-claude-memory] bump_skill_telemetry rpc error: ${result.value.error.message}`,
          );
        }
      }
    });
  }

  return {
    query: parsed.query,
    count: skills.length,
    skills,
  };
}
