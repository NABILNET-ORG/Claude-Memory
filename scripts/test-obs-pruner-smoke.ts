// Smoke test for the telemetry retention pruner (Backlog #124).
// Asserts:
//   1. Migration 018 is applied — daemon='telemetry_pruner' inserts succeed.
//   2. runPruneOnce deletes rows older than the retention window.
//   3. runPruneOnce preserves rows inside the retention window.
//   4. runTelemetryPrunerOnce (tick) emits a run_ended row with the
//      expected payload shape (deleted, retention_days, duration_ms).
// Self-cleans every row it inserts.

import { supabase } from "../src/supabase.js";
import { currentProjectId } from "../src/project.js";
import {
  runPruneOnce,
  runTelemetryPrunerOnce,
  startTelemetryPruner,
  stopTelemetryPruner,
} from "../src/telemetry/pruner.js";

const STAMP = `s24-pruner-smoke-${Date.now()}`;
const OLD_TAG = `${STAMP}-old`;
const FRESH_TAG = `${STAMP}-fresh`;
const TICK_TAG = `${STAMP}-tick`;

async function cleanup() {
  // Best-effort — do NOT throw, the smoke should still report its real result.
  for (const tag of [OLD_TAG, FRESH_TAG, TICK_TAG]) {
    await supabase
      .from("daemon_telemetry")
      .delete()
      .contains("payload", { smoke_tag: tag });
  }
}

async function main() {
  // -----------------------------------------------------------------
  // Assertion 1 — migration 018 applied (CHECK admits telemetry_pruner)
  // -----------------------------------------------------------------
  {
    // Insert 3 backdated rows with created_at = 2020-01-01.
    const oldRows = [1, 2, 3].map(() => ({
      project_id: currentProjectId,
      daemon: "telemetry_pruner",
      event_type: "run_ended",
      payload: { deleted: 0, retention_days: 30, duration_ms: 1, smoke_tag: OLD_TAG },
      created_at: "2020-01-01T00:00:00Z",
    }));
    const { error: oldErr } = await supabase.from("daemon_telemetry").insert(oldRows);
    if (oldErr) throw new Error(
      `migration 018 NOT applied — insert with daemon='telemetry_pruner' failed: ${oldErr.message}`,
    );
    console.log("ok: migration 018 admits daemon='telemetry_pruner'");
  }

  // Insert one fresh row that MUST survive a 1-day-retention prune.
  {
    const { error: freshErr } = await supabase.from("daemon_telemetry").insert({
      project_id: currentProjectId,
      daemon: "telemetry_pruner",
      event_type: "run_ended",
      payload: { deleted: 0, retention_days: 30, duration_ms: 1, smoke_tag: FRESH_TAG },
    });
    if (freshErr) throw new Error(`fresh-row insert failed: ${freshErr.message}`);
  }

  // -----------------------------------------------------------------
  // Assertion 2 — runPruneOnce deletes only the old rows
  // -----------------------------------------------------------------
  const result = await runPruneOnce({ retentionDays: 1 });
  if (result.errored !== 0) {
    throw new Error(`runPruneOnce reported errored=${result.errored}; expected 0`);
  }
  if (result.deleted < 3) {
    throw new Error(
      `runPruneOnce reported deleted=${result.deleted}; expected ≥3 (the 3 backdated smoke rows)`,
    );
  }
  console.log(`ok: runPruneOnce deleted ${result.deleted} row(s) older than 1d (≥3 expected)`);

  {
    const { data: oldStill } = await supabase
      .from("daemon_telemetry")
      .select("id")
      .contains("payload", { smoke_tag: OLD_TAG });
    if (oldStill && oldStill.length > 0) {
      throw new Error(`backdated rows survived prune: ${oldStill.length} still present`);
    }
    console.log("ok: backdated rows are gone");
  }

  // -----------------------------------------------------------------
  // Assertion 3 — fresh row survived
  // -----------------------------------------------------------------
  {
    const { data: freshStill } = await supabase
      .from("daemon_telemetry")
      .select("id")
      .contains("payload", { smoke_tag: FRESH_TAG });
    if (!freshStill || freshStill.length !== 1) {
      throw new Error(
        `fresh row missing after prune: expected 1, got ${freshStill?.length ?? 0}`,
      );
    }
    console.log("ok: fresh row survived 1-day-retention prune");
  }

  // -----------------------------------------------------------------
  // Assertion 4 — tick emits run_ended with the documented payload shape
  // -----------------------------------------------------------------
  // Seed one more backdated row tagged TICK_TAG so the tick has work to do.
  await supabase.from("daemon_telemetry").insert({
    project_id: currentProjectId,
    daemon: "telemetry_pruner",
    event_type: "run_ended",
    payload: { deleted: 0, retention_days: 30, duration_ms: 1, smoke_tag: TICK_TAG },
    created_at: "2020-01-01T00:00:00Z",
  });

  process.env.TELEMETRY_PRUNER_RETENTION_DAYS = "1";
  startTelemetryPruner();
  await runTelemetryPrunerOnce();
  stopTelemetryPruner();

  // The tick itself emits a run_ended event AFTER the delete via fire-and-forget
  // `void emit(...)`, so we must (a) wait briefly for the insert to land and
  // (b) disambiguate from the FRESH_TAG seed row by filtering on retention_days=1
  // (the seed rows all carry retention_days=30 in their payloads, so this
  // containment query uniquely targets the tick's emit).
  {
    let emitRow: { payload: Record<string, unknown>; created_at: string } | null = null;
    for (let attempt = 0; attempt < 10 && !emitRow; attempt++) {
      await new Promise((r) => setTimeout(r, 200));
      const { data, error } = await supabase
        .from("daemon_telemetry")
        .select("payload, created_at")
        .eq("project_id", currentProjectId)
        .eq("daemon", "telemetry_pruner")
        .eq("event_type", "run_ended")
        .contains("payload", { retention_days: 1 })
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`emit readback failed: ${error.message}`);
      emitRow = (data?.[0] as typeof emitRow) ?? null;
    }
    if (!emitRow) throw new Error("tick did not emit a run_ended row with retention_days=1 within 2s");
    const p = emitRow.payload;
    if (typeof p.deleted !== "number" || typeof p.retention_days !== "number" || typeof p.duration_ms !== "number") {
      throw new Error(
        `tick run_ended payload shape wrong: ${JSON.stringify(p)} (expected {deleted:number, retention_days:number, duration_ms:number})`,
      );
    }
    if (p.retention_days !== 1) {
      throw new Error(`tick used retention_days=${p.retention_days}; expected 1 from env`);
    }
    console.log(
      `ok: tick emitted run_ended with deleted=${p.deleted} retention_days=${p.retention_days} duration_ms=${p.duration_ms}`,
    );
  }

  console.log("All 4 pruner smoke assertions passed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
  });
