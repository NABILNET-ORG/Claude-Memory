import { supabase } from "../supabase.js";
import { currentProjectId } from "../project.js";
import { getSleepLearnerStatus } from "../sleep/daemon.js";
import { getCurriculumStatus } from "../curriculum/daemon.js";
import { getCompactorStatus } from "../trajectory/daemon.js";

type DaemonName = "sleep_learner" | "curriculum_scanner" | "trajectory_compactor";

export type DashboardInput = {
  window_hours?: number;
  daemon?: DaemonName;
};

type Row = {
  daemon: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type Rollup = {
  runs: number;
  errors: number;
  items_processed: number;
  outcomes: { verified: number; rejected: number; auto_promoted: number };
};

function rollupFor(rows: Row[], sinceMs: number): Rollup {
  const filtered = rows.filter((r) => Date.parse(r.created_at) >= sinceMs);
  let runs = 0;
  let errors = 0;
  let itemsProcessed = 0;
  const outcomes = { verified: 0, rejected: 0, auto_promoted: 0 };
  for (const r of filtered) {
    const p = r.payload ?? {};
    if (r.event_type === "run_ended") {
      runs++;
      const compacted = typeof p.compacted === "number" ? p.compacted : 0;
      const mined = typeof p.mined === "number" ? p.mined : 0;
      const queued = typeof p.queued === "number" ? p.queued : 0;
      itemsProcessed += compacted + mined + queued;
    } else if (r.event_type === "run_errored") {
      errors++;
    } else if (r.event_type === "task_outcome") {
      if (typeof p.verified === "number") outcomes.verified += p.verified;
      if (typeof p.rejected === "number") outcomes.rejected += p.rejected;
      if (typeof p.auto_promoted === "number") outcomes.auto_promoted += p.auto_promoted;
    }
  }
  return { runs, errors, items_processed: itemsProcessed, outcomes };
}

export async function systemDashboardHandler(input: DashboardInput) {
  const windowHours = input.window_hours ?? 24;
  const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();

  let q = supabase
    .from("daemon_telemetry")
    .select("daemon, event_type, payload, created_at")
    .eq("project_id", currentProjectId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (input.daemon) q = q.eq("daemon", input.daemon);

  const { data, error } = await q;
  if (error) throw new Error(`system_dashboard query failed: ${error.message}`);
  const rows = (data ?? []) as Row[];

  const live = {
    sleep_learner: getSleepLearnerStatus(),
    curriculum_scanner: getCurriculumStatus(),
    trajectory_compactor: getCompactorStatus(),
  };

  const now = Date.now();
  const oneHourAgo = now - 3600_000;
  const windowStart = now - windowHours * 3600_000;
  const daemons: Record<string, unknown> = {};

  for (const d of ["sleep_learner", "curriculum_scanner", "trajectory_compactor"] as const) {
    if (input.daemon && input.daemon !== d) continue;
    const daemonRows = rows.filter((r) => r.daemon === d);
    const r1h = rollupFor(daemonRows, oneHourAgo);
    const r24h = rollupFor(daemonRows, windowStart);
    const lastError = daemonRows.find((r) => r.event_type === "run_errored");
    const errDenominator = r24h.runs + r24h.errors;
    daemons[d] = {
      live: live[d],
      rollup_1h: r1h,
      rollup_24h: r24h,
      error_rate_24h: errDenominator === 0 ? 0 : r24h.errors / errDenominator,
      last_error_at: lastError?.created_at ?? null,
      last_error_message:
        (lastError?.payload as { error_message?: string } | undefined)?.error_message ?? null,
      recent_runs: daemonRows.slice(0, 20).map((r) => ({
        event_type: r.event_type,
        created_at: r.created_at,
        payload: r.payload,
      })),
    };
  }

  return {
    project_id: currentProjectId,
    window_hours: windowHours,
    generated_at: new Date().toISOString(),
    daemons,
  };
}
