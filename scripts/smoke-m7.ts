// M7 Skill Graduation — handler-layer smoke (SCM-S33-D1 Phase A).
//
// End-to-end exercise of the 4-step pipeline:
//   seed agent_skill (eligible) → findGraduationCandidates → insert graduation
//   row → composeGlobalRationale → confirmPromotion → assert GLOBAL clone
//   minted, atomic-tx timestamps microsecond-identical, source untouched.
//
// Belt-and-braces parallel to Suites A–E. If both pass, Phase A is GREEN.
//
// Cleanup: FK-safe order in finally{}. The cleanupProject sweep includes
// the GLOBAL clone via the per-pid name-prefix scoping (m4 fixture).

import "dotenv/config";
import { supabase } from "../src/supabase.js";
import {
  uniqueProjectId,
  cleanupProject,
  insertThrowawaySkill,
  insertThrowawayGraduation,
} from "../tests/fixtures/m4.js";
import { findGraduationCandidates } from "../src/graduation/scanner.js";
import {
  composeGlobalRationale,
  confirmPromotion,
  rejectGraduation,
  listGraduationCandidates,
} from "../src/tools/graduation.js";

function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`✖ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✔ ${msg}`);
}

function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    console.error(`✖ ${msg}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✔ ${msg}`);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const pid = uniqueProjectId();
  console.log(`[smoke-m7] project_id = ${pid}`);

  try {
    // ── Stage 1: seed an eligible local agent_skill ────────────────────
    console.log("\n[stage 1] Seed an eligible local agent_skill");
    const skillId = await insertThrowawaySkill(pid, {
      frequencyUsed: 15,
      successRate: 0.92, // above 0.90 floor
      ageDaysOverride: 21, // above 14-day floor
    });
    ok(typeof skillId === "number" && skillId > 0, `skill seeded (id=${skillId})`);

    // ── Stage 2: scanner finds the seeded skill ────────────────────────
    console.log("\n[stage 2] Scanner finds the candidate");
    const candidates = await findGraduationCandidates({ projectId: pid });
    eq(candidates.length, 1, "exactly one candidate surfaces");
    const c = candidates[0]!;
    eq(c.source_skill_id, skillId, "candidate.source_skill_id matches seed");
    eq(c.frequency_at_propose, 15, "candidate.frequency_at_propose = 15");
    eq(c.success_rate_at_propose, 0.92, "candidate.success_rate_at_propose = 0.92");
    ok(c.age_days_at_propose >= 20 && c.age_days_at_propose <= 22, `age_days_at_propose ≈ 21 (got ${c.age_days_at_propose})`);

    // ── Stage 3: insert a graduation row from the candidate snapshot ───
    // Phase A: scanner doesn't write; the smoke (or Phase B daemon) does.
    console.log("\n[stage 3] Insert graduation row at state='proposed'");
    const gradId = await insertThrowawayGraduation(pid, skillId, {
      state: "proposed",
      frequencyAtPropose: c.frequency_at_propose,
      successRateAtPropose: c.success_rate_at_propose,
      ageDaysAtPropose: c.age_days_at_propose,
    });
    ok(typeof gradId === "number" && gradId > 0, `graduation seeded (id=${gradId})`);

    // ── Stage 4: list — proposed graduation appears ─────────────────────
    console.log("\n[stage 4] listGraduationCandidates surfaces the proposed row");
    const listed = await listGraduationCandidates({ project_id: pid, state: "proposed" });
    eq(listed.count, 1, "list returned exactly 1 proposed graduation");
    eq(listed.results[0]!.id, gradId, "listed graduation id matches seed");

    // ── Stage 5: compose the global_rationale (verdict='pass') ─────────
    console.log("\n[stage 5] composeGlobalRationale(verdict='pass')");
    const composeResult = await composeGlobalRationale({
      graduation_id: gradId,
      verdict: "pass",
      evidence: "Smoke-test pattern: universal idempotent-enqueue across stacks.",
      global_rationale: "Idempotent UNIQUE-index-driven enqueue is a universal database pattern.",
      model: "orchestrator:smoke-m7",
    });
    eq(composeResult.ok, true, "compose ok:true");
    if (!composeResult.ok) throw new Error("compose failed");
    eq(composeResult.state, "composed", "compose returned state='composed'");
    ok(typeof composeResult.composed_at === "string", `composed_at populated (${composeResult.composed_at})`);

    // ── Stage 6: confirmPromotion — atomic clone-to-GLOBAL ──────────────
    console.log("\n[stage 6] confirmPromotion → atomic clone-to-GLOBAL");
    const confirmResult = await confirmPromotion({ graduation_id: gradId });
    eq(confirmResult.ok, true, "confirm ok:true");
    if (!confirmResult.ok) throw new Error("confirm failed");
    ok(
      typeof confirmResult.promoted_global_skill_id === "number" &&
        confirmResult.promoted_global_skill_id > 0,
      `promoted_global_skill_id minted (${confirmResult.promoted_global_skill_id})`,
    );
    ok(typeof confirmResult.decided_at === "string", `decided_at populated (${confirmResult.decided_at})`);

    // ── Stage 7: ATOMIC-TX PROOF — microsecond-equal timestamps ────────
    console.log("\n[stage 7] ATOMIC-TX PROOF — fetch back and compare microsecond timestamps");
    const { data: grad } = await supabase
      .from("skill_graduations")
      .select("decided_at, state, promoted_global_skill_id")
      .eq("id", gradId)
      .single();
    const { data: globalSkill } = await supabase
      .from("agent_skills")
      .select("created_at, project_id, name, frequency_used, success_rate, last_invoked_at")
      .eq("id", confirmResult.promoted_global_skill_id)
      .single();
    eq(grad?.state, "approved", "graduation state='approved'");
    eq(grad?.promoted_global_skill_id, confirmResult.promoted_global_skill_id, "graduation.promoted_global_skill_id wired");
    eq(globalSkill?.project_id, "GLOBAL", "clone.project_id='GLOBAL'");
    eq(globalSkill?.frequency_used, 0, "clone.frequency_used reset to 0");
    eq(globalSkill?.success_rate, 1.0, "clone.success_rate reset to 1.0");
    eq(globalSkill?.last_invoked_at, null, "clone.last_invoked_at is null");
    eq(
      grad?.decided_at,
      globalSkill?.created_at,
      "ATOMIC-TX: graduation.decided_at === clone.created_at (microsecond)",
    );
    eq(
      grad?.decided_at,
      confirmResult.decided_at,
      "ATOMIC-TX: graduation.decided_at === RPC.decided_at (microsecond)",
    );
    console.log(
      `\n  [atomic-tx microsecond] grad.decided_at = clone.created_at = RPC.decided_at = ${confirmResult.decided_at}`,
    );

    // ── Stage 8: source skill UNTOUCHED ─────────────────────────────────
    console.log("\n[stage 8] Source agent_skill UNTOUCHED post-promotion");
    const { data: source } = await supabase
      .from("agent_skills")
      .select("project_id, frequency_used, success_rate")
      .eq("id", skillId)
      .single();
    eq(source?.project_id, pid, "source.project_id unchanged");
    eq(source?.frequency_used, 15, "source.frequency_used unchanged");
    eq(source?.success_rate, 0.92, "source.success_rate unchanged");

    // ── Stage 9: second confirmPromotion is rejected (state guard) ─────
    console.log("\n[stage 9] Second confirmPromotion on approved row is rejected");
    const dup = await confirmPromotion({ graduation_id: gradId });
    eq(dup.ok, false, "duplicate confirm ok:false");
    if (!dup.ok) {
      ok(/state must be composed/.test(dup.reason), `dup reason matches state guard: "${dup.reason}"`);
    }

    // ── Stage 10: rejectGraduation on approved row is also rejected ────
    console.log("\n[stage 10] rejectGraduation on approved row is rejected");
    const lateReject = await rejectGraduation({ graduation_id: gradId, reason: "too late, already approved" });
    eq(lateReject.ok, false, "late reject ok:false");
    if (!lateReject.ok) {
      eq(lateReject.reason, "invalid_state_transition", "late reject reason='invalid_state_transition'");
    }

    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[smoke-m7] GREEN  (${wall}s)`);
  } catch (e) {
    console.error("\n[smoke-m7] FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = process.exitCode || 1;
  } finally {
    console.log(`\n[smoke-m7] cleanup ${pid}`);
    await cleanupProject(pid);
  }
}

main().catch((e) => {
  console.error("[smoke-m7] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
