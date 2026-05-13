import { checkSystemHealth } from "../src/tools/health.js";

async function main() {
  const report: any = await checkSystemHealth();

  for (const d of ["sleep_learner", "curriculum_scanner", "trajectory_compactor"]) {
    const block = report[d] ?? report.daemons?.[d];
    if (!block) throw new Error(`missing daemon block: ${d}`);
    if (!block.derived || typeof block.derived !== "object") {
      throw new Error(`${d}: missing derived block`);
    }
    const s = block.derived.status;
    if (!["healthy", "degraded", "down"].includes(s)) {
      throw new Error(`${d}: invalid derived.status: ${s}`);
    }
    if (typeof block.derived.reason !== "string") {
      throw new Error(`${d}: missing derived.reason`);
    }
    if (typeof block.derived.error_rate_1h !== "number") {
      throw new Error(`${d}: missing error_rate_1h`);
    }
  }
  if (!report.overall) throw new Error("missing report.overall");

  console.log("ok: derived block present for all 3 daemons");
  console.log("overall:", report.overall);
  for (const d of ["sleep_learner", "curriculum_scanner", "trajectory_compactor"]) {
    const b = report[d] ?? report.daemons?.[d];
    console.log(
      `  ${d}: derived=${b.derived.status} reason="${b.derived.reason}" err_rate=${b.derived.error_rate_1h.toFixed(3)} stale=${b.derived.staleness_ms}ms`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
