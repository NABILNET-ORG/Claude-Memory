// Sleep Learning Daemon (Agentic OS 2026 / Mission 3 / SCM-S19-D1).
// Idle miner: every SLEEP_LEARNER_INTERVAL_MS, calls mineClusters() over the
// current project's trajectory_summaries ⋈ archive_backlog (success), emits
// skill_candidates via upsert_skill_candidate RPC. Optionally auto-promotes
// brand-new rows via promote_candidate_to_skill (gated by AUTO_PROMOTE env).
//
// Mirrors src/trajectory/daemon.ts: module-level state, .unref()'d interval,
// re-entrancy guard, try/finally tick so the loop NEVER throws.

import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";
import { mineClusters, type CandidateStub } from "./miner.js";
import { proposeSkill } from "./proposer.js";

const DEFAULT_INTERVAL_MS = 3_600_000;
const DEFAULT_BATCH = 10;
const DEFAULT_MIN_FREQ = 3;
const DEFAULT_AUTO_PROMOTE = false;

const state = {
  enabled: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  batch: DEFAULT_BATCH,
  minFreq: DEFAULT_MIN_FREQ,
  autoPromote: DEFAULT_AUTO_PROMOTE,
  lastRunAt: null as string | null,
  lastRunMined: 0,
  lastRunPromoted: 0,
  lastRunSkipped: 0,
  lastRunErrored: 0,
  lastRunDurationMs: 0,
  candidatesMinedTotal: 0,
  candidatesPromotedTotal: 0,
  timer: null as NodeJS.Timeout | null,
  running: false,
};

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const lc = raw.toLowerCase();
  if (lc === "1" || lc === "true" || lc === "yes" || lc === "on") return true;
  if (lc === "0" || lc === "false" || lc === "no" || lc === "off") return false;
  return fallback;
}

function resolveConfig(): {
  intervalMs: number;
  batch: number;
  minFreq: number;
  autoPromote: boolean;
} {
  return {
    intervalMs: readIntEnv("SLEEP_LEARNER_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    batch: readIntEnv("SLEEP_LEARNER_BATCH", DEFAULT_BATCH),
    minFreq: readIntEnv("SLEEP_LEARNER_MIN_FREQ", DEFAULT_MIN_FREQ),
    autoPromote: readBoolEnv("SLEEP_LEARNER_AUTO_PROMOTE", DEFAULT_AUTO_PROMOTE),
  };
}

// ─── per-cluster mining ───────────────────────────────────────────────────

export type MineOneResult = {
  ok: boolean;
  candidate_id: number | null;
  is_new: boolean;
  promoted: boolean;
  skill_id: number | null;
  reason?: string;
};

/**
 * Process one cluster: ask the proposer for a name+steps, upsert via the
 * RPC, optionally auto-promote when AUTO_PROMOTE=true AND the row is brand-
 * new (is_new=true from the RPC). Per-cluster try/catch — one bad cluster
 * never breaks the batch.
 */
export async function mineOneCluster(
  stub: CandidateStub,
  opts: { autoPromote?: boolean } = {},
): Promise<MineOneResult> {
  let proposal: { proposed_name: string; proposed_steps: unknown; model: string };
  try {
    proposal = await proposeSkill(stub);
  } catch (e) {
    return {
      ok: false,
      candidate_id: null,
      is_new: false,
      promoted: false,
      skill_id: null,
      reason: `propose_failed: ${(e as Error).message}`,
    };
  }

  const { data: upsertData, error: upsertError } = await supabase.rpc(
    "upsert_skill_candidate",
    {
      p_project_id: stub.project_id,
      p_pattern_hash: stub.pattern_hash,
      p_source_summary_ids: stub.source_summary_ids,
      p_source_backlog_ids: stub.source_backlog_ids,
      p_frequency: stub.frequency,
      p_success_count: stub.success_count,
      p_candidate_embedding: stub.candidate_embedding,
      p_proposed_name: proposal.proposed_name,
      p_proposed_steps: proposal.proposed_steps,
      p_model: proposal.model,
      p_strategy: "centroid+ngram",
    },
  );

  if (upsertError) {
    return {
      ok: false,
      candidate_id: null,
      is_new: false,
      promoted: false,
      skill_id: null,
      reason: `upsert_failed: ${upsertError.message}`,
    };
  }

  // upsert_skill_candidate returns SETOF (id, state, frequency, success_count, is_new).
  const rows = (upsertData ?? []) as Array<{
    id: number;
    state: string;
    is_new: boolean;
  }>;
  if (rows.length === 0) {
    return {
      ok: false,
      candidate_id: null,
      is_new: false,
      promoted: false,
      skill_id: null,
      reason: "upsert_returned_no_rows",
    };
  }
  const head = rows[0];

  const shouldPromote =
    (opts.autoPromote ?? state.autoPromote) === true &&
    head.is_new === true &&
    head.state === "mined";

  if (!shouldPromote) {
    return {
      ok: true,
      candidate_id: head.id,
      is_new: head.is_new,
      promoted: false,
      skill_id: null,
    };
  }

  // Auto-promote path. Build a description from the representative summary —
  // it's what powers semantic recall via match_agent_skills (M1).
  const description = stub.representative_summary.slice(0, 500);
  const { data: promoteData, error: promoteError } = await supabase.rpc(
    "promote_candidate_to_skill",
    {
      p_candidate_id: head.id,
      p_description: description,
      p_trigger_keywords: [],
    },
  );

  if (promoteError) {
    return {
      ok: true,
      candidate_id: head.id,
      is_new: head.is_new,
      promoted: false,
      skill_id: null,
      reason: `promote_failed: ${promoteError.message}`,
    };
  }

  const promoteRows = (promoteData ?? []) as Array<{ skill_id: number }>;
  const skillId = promoteRows.length > 0 ? promoteRows[0].skill_id : null;

  return {
    ok: true,
    candidate_id: head.id,
    is_new: head.is_new,
    promoted: true,
    skill_id: skillId,
  };
}

// ─── per-run orchestration ────────────────────────────────────────────────

export type RunOnceResult = {
  mined: number;
  promoted: number;
  skipped: number;
  errored: number;
  duration_ms: number;
};

export async function runMiningOnce(
  opts: { projectId?: string; batch?: number; minFreq?: number; autoPromote?: boolean } = {},
): Promise<RunOnceResult> {
  const t0 = Date.now();
  const cfg = resolveConfig();
  const projectId = opts.projectId ?? currentProjectId;
  const batch = opts.batch ?? cfg.batch;
  const minFreq = opts.minFreq ?? cfg.minFreq;
  const autoPromote = opts.autoPromote ?? cfg.autoPromote;

  let mined = 0;
  let promoted = 0;
  let skipped = 0;
  let errored = 0;

  try {
    const stubs = await mineClusters({ projectId, batch, minFreq });
    for (const stub of stubs) {
      try {
        const r = await mineOneCluster(stub, { autoPromote });
        if (r.ok) {
          if (r.is_new) mined++;
          else skipped++;
          if (r.promoted) promoted++;
        } else {
          errored++;
        }
      } catch {
        errored++;
      }
    }
  } catch {
    errored++;
  }

  return {
    mined,
    promoted,
    skipped,
    errored,
    duration_ms: Date.now() - t0,
  };
}

// ─── daemon lifecycle ─────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const r = await runMiningOnce({
      batch: state.batch,
      minFreq: state.minFreq,
      autoPromote: state.autoPromote,
    });
    state.lastRunMined = r.mined;
    state.lastRunPromoted = r.promoted;
    state.lastRunSkipped = r.skipped;
    state.lastRunErrored = r.errored;
    state.lastRunDurationMs = r.duration_ms;
    state.lastRunAt = new Date().toISOString();
    state.candidatesMinedTotal += r.mined;
    state.candidatesPromotedTotal += r.promoted;
  } catch {
    state.lastRunErrored++;
    state.lastRunAt = new Date().toISOString();
  } finally {
    state.running = false;
  }
}

export function startSleepLearner(): void {
  if (state.timer) return;
  const cfg = resolveConfig();
  state.intervalMs = cfg.intervalMs;
  state.batch = cfg.batch;
  state.minFreq = cfg.minFreq;
  state.autoPromote = cfg.autoPromote;
  state.enabled = true;
  state.timer = setInterval(() => {
    if (state.running) return;
    void tick();
  }, state.intervalMs);
  state.timer.unref();
}

export function stopSleepLearner(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.enabled = false;
}

export type SleepLearnerStatus = {
  running: boolean;
  enabled: boolean;
  interval_ms: number;
  batch: number;
  min_freq: number;
  auto_promote: boolean;
  last_run_at: string | null;
  last_run_mined: number;
  last_run_promoted: number;
  last_run_skipped: number;
  last_run_errored: number;
  last_run_duration_ms: number;
  candidates_mined_total: number;
  candidates_promoted_total: number;
};

export function getSleepLearnerStatus(): SleepLearnerStatus {
  return {
    running: state.running,
    enabled: state.enabled,
    interval_ms: state.intervalMs,
    batch: state.batch,
    min_freq: state.minFreq,
    auto_promote: state.autoPromote,
    last_run_at: state.lastRunAt,
    last_run_mined: state.lastRunMined,
    last_run_promoted: state.lastRunPromoted,
    last_run_skipped: state.lastRunSkipped,
    last_run_errored: state.lastRunErrored,
    last_run_duration_ms: state.lastRunDurationMs,
    candidates_mined_total: state.candidatesMinedTotal,
    candidates_promoted_total: state.candidatesPromotedTotal,
  };
}
