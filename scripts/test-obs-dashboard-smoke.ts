import { systemDashboardHandler } from "../src/tools/system_dashboard.js";

async function main() {
  const result = await systemDashboardHandler({});

  if (!result.daemons || typeof result.daemons !== "object") {
    throw new Error("missing daemons block");
  }
  for (const d of ["sleep_learner", "curriculum_scanner", "trajectory_compactor"] as const) {
    const block = (result.daemons as Record<string, any>)[d];
    if (!block) throw new Error(`missing daemon block: ${d}`);
    if (typeof block.rollup_1h?.runs !== "number") throw new Error(`${d}: rollup_1h.runs not a number`);
    if (typeof block.rollup_24h?.runs !== "number") throw new Error(`${d}: rollup_24h.runs not a number`);
    if (typeof block.rollup_24h?.items_processed !== "number") throw new Error(`${d}: rollup_24h.items_processed not a number`);
    if (typeof block.rollup_24h?.outcomes?.verified !== "number") throw new Error(`${d}: outcomes.verified not a number`);
    if (typeof block.error_rate_24h !== "number") throw new Error(`${d}: error_rate_24h not a number`);
    if (!Array.isArray(block.recent_runs)) throw new Error(`${d}: recent_runs not an array`);
  }
  if (typeof result.project_id !== "string") throw new Error("missing project_id");
  if (typeof result.window_hours !== "number") throw new Error("missing window_hours");
  if (typeof result.generated_at !== "string") throw new Error("missing generated_at");

  console.log("ok: system_dashboard returns full shape");
  for (const d of ["sleep_learner", "curriculum_scanner", "trajectory_compactor"] as const) {
    const b = (result.daemons as Record<string, any>)[d];
    console.log(`  ${d}: 24h runs=${b.rollup_24h.runs} errors=${b.rollup_24h.errors} items=${b.rollup_24h.items_processed} outcomes=${JSON.stringify(b.rollup_24h.outcomes)} err_rate=${b.error_rate_24h.toFixed(3)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
