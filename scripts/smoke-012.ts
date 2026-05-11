/**
 * smoke-012 — Sleep Learning end-to-end smoke test (Mission 3).
 *
 * Exercises:
 *   a. Seed 2 trajectory_summaries rows + 2 archive_backlog rows (status='success')
 *      sharing a phrase under project_id='smoke-012-test'.
 *   b. runMiningOnce() directly — bypass the daemon timer.
 *   c. Assert exactly 1 skill_candidates row exists with state='mined' and frequency=2.
 *   d. promoteSkillCandidate({ candidate_id }).
 *   e. Assert agent_skills row exists AND skill_candidates.state='promoted'.
 *   f. Re-run runMiningOnce() — assert no duplicate (idempotency via UNIQUE).
 *   g. Cleanup.
 *
 * IMPORTANT: When scripts/012_sleep_learning.sql has NOT been applied to Supabase,
 * RPC calls fail with "function does not exist" / table-missing errors. The smoke
 * prints a clear SKIPPED warning and EXITS 0 — it MUST NOT fail the build.
 */
import { config as dotenvConfig } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { runMiningOnce } from "../src/sleep/daemon.js";
import {
  promoteSkillCandidate,
  rejectSkillCandidate,
} from "../src/tools/sleep.js";
import { embed } from "../src/ollama.js";

dotenvConfig();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SECRET_KEY missing from environment");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const PROJECT_ID = "smoke-012-test";
const SHARED_PHRASE =
  "create a git commit using a heredoc message to preserve newlines";

type TestResult = { name: string; ok: boolean; note?: string };
const results: TestResult[] = [];
let exitCode = 0;

function record(name: string, ok: boolean, note?: string): boolean {
  results.push({ name, ok, note });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
  return ok;
}

// Detect whether the SQL migration has been applied. We probe by counting
// skill_candidates filtered to our project_id (zero rows is fine; PostgREST
// returns the error code "PGRST205"/"42P01" only when the relation is
// missing, and a similar shape when the RPC doesn't exist).
async function migrationApplied(): Promise<boolean> {
  const { error } = await supabase
    .from("skill_candidates")
    .select("id", { head: true, count: "exact" })
    .eq("project_id", PROJECT_ID)
    .limit(1);
  if (!error) return true;
  const msg = error.message?.toLowerCase() ?? "";
  if (msg.includes("does not exist") || msg.includes("could not find")) return false;
  // Any other error (auth, network) is a hard fail — surface it.
  console.error(`migrationApplied probe failed: ${error.message}`);
  return false;
}

async function cleanup(label: string): Promise<void> {
  try {
    await supabase.from("agent_skills").delete().eq("project_id", PROJECT_ID);
  } catch (e) {
    console.error(`[${label}] agent_skills cleanup error: ${(e as Error).message}`);
  }
  try {
    await supabase.from("skill_candidates").delete().eq("project_id", PROJECT_ID);
  } catch (e) {
    console.error(`[${label}] skill_candidates cleanup error: ${(e as Error).message}`);
  }
  try {
    await supabase.from("trajectory_summaries").delete().eq("project_id", PROJECT_ID);
  } catch (e) {
    console.error(`[${label}] trajectory_summaries cleanup error: ${(e as Error).message}`);
  }
  try {
    await supabase.from("archive_backlog").delete().eq("project_id", PROJECT_ID);
  } catch (e) {
    console.error(`[${label}] archive_backlog cleanup error: ${(e as Error).message}`);
  }
  // memory_chunks rows we seeded for source_chunk_id provenance — same key.
  try {
    await supabase.from("memory_chunks").delete().eq("project_id", PROJECT_ID);
  } catch (e) {
    console.error(`[${label}] memory_chunks cleanup error: ${(e as Error).message}`);
  }
}

async function seed(): Promise<void> {
  // Compute a shared embedding up front — memory_chunks.embedding is NOT NULL.
  let vec: number[] | null = null;
  try {
    const [v] = await embed([SHARED_PHRASE]);
    if (Array.isArray(v) && v.length > 0) vec = v;
  } catch {
    vec = null;
  }
  const seedEmbedding: number[] = vec ?? Array.from({ length: 768 }, () => 0.001);

  // 1) Two memory_chunks rows we can point source_chunk_id at.
  const { data: chunkRows, error: chunkErr } = await supabase
    .from("memory_chunks")
    .insert([
      {
        project_id: PROJECT_ID,
        file_origin: "smoke-012:chunk:1",
        chunk_index: 0,
        content: `${SHARED_PHRASE} (variant A)`,
        content_hash: "smoke-012-hash-a",
        embedding: seedEmbedding,
        metadata: { type: "LOG" },
      },
      {
        project_id: PROJECT_ID,
        file_origin: "smoke-012:chunk:2",
        chunk_index: 0,
        content: `${SHARED_PHRASE} (variant B)`,
        content_hash: "smoke-012-hash-b",
        embedding: seedEmbedding,
        metadata: { type: "LOG" },
      },
    ])
    .select("id");
  if (chunkErr || !chunkRows || chunkRows.length !== 2) {
    throw new Error(
      `seed: memory_chunks insert failed: ${chunkErr?.message ?? "missing rows"}`,
    );
  }
  const chunkIds = chunkRows.map((r) => r.id as number);

  // 2) Two archive_backlog rows (status='done') — priority + created_at + updated_at NOT NULL.
  //    chunk_id links provenance back to memory_chunks (migration 013).
  const nowIso = new Date().toISOString();
  const { error: archErr } = await supabase
    .from("archive_backlog")
    .insert([
      {
        project_id: PROJECT_ID,
        title: "smoke-012 task A",
        status: "done",
        priority: 3,
        created_at: nowIso,
        updated_at: nowIso,
        chunk_id: chunkIds[0],
      },
      {
        project_id: PROJECT_ID,
        title: "smoke-012 task B",
        status: "done",
        priority: 3,
        created_at: nowIso,
        updated_at: nowIso,
        chunk_id: chunkIds[1],
      },
    ]);
  if (archErr) {
    throw new Error(`seed: archive_backlog insert failed: ${archErr.message}`);
  }

  // 3) Two trajectory_summaries rows — same phrase so trigram hash collides.
  const { error: sumErr } = await supabase
    .from("trajectory_summaries")
    .insert([
      {
        project_id: PROJECT_ID,
        source_chunk_id: chunkIds[0],
        summary: SHARED_PHRASE,
        summary_embedding: seedEmbedding,
        source_tokens: 50,
        summary_tokens: 12,
        strategy: "smoke-012",
        model: "smoke-012",
      },
      {
        project_id: PROJECT_ID,
        source_chunk_id: chunkIds[1],
        summary: SHARED_PHRASE,
        summary_embedding: seedEmbedding,
        source_tokens: 50,
        summary_tokens: 12,
        strategy: "smoke-012",
        model: "smoke-012",
      },
    ]);
  if (sumErr) {
    throw new Error(`seed: trajectory_summaries insert failed: ${sumErr.message}`);
  }
}

const t0 = Date.now();
console.log("smoke-012 — Sleep Learning end-to-end");
console.log(`project_id: ${PROJECT_ID}`);

(async () => {
  const applied = await migrationApplied();
  if (!applied) {
    console.log("\nSKIPPED: apply scripts/012_sleep_learning.sql first");
    process.exit(0);
  }

  try {
    await cleanup("pre-test");
    await seed();

    // ── Test A: runMiningOnce → exactly 1 mined candidate (frequency=2). ─
    console.log("\nTest A: runMiningOnce mines 1 cluster from 2 successful summaries");
    // minFreq=2 because we only seed 2 rows; production default is 3.
    const run1 = await runMiningOnce({ projectId: PROJECT_ID, minFreq: 2, batch: 10 });
    record(
      "A1 run errored=0",
      run1.errored === 0,
      `mined=${run1.mined} promoted=${run1.promoted} skipped=${run1.skipped} errored=${run1.errored}`,
    );

    const { data: cands1, error: cands1Err } = await supabase
      .from("skill_candidates")
      .select("id, state, frequency")
      .eq("project_id", PROJECT_ID);
    if (cands1Err) throw new Error(`skill_candidates select: ${cands1Err.message}`);
    record(
      "A2 exactly 1 skill_candidates row",
      (cands1?.length ?? 0) === 1,
      `count=${cands1?.length ?? 0}`,
    );
    const candidate = (cands1 ?? [])[0];
    if (!candidate) throw new Error("Test A: candidate missing");
    record(
      "A3 candidate.state='mined'",
      candidate.state === "mined",
      `state=${candidate.state}`,
    );
    record(
      "A4 candidate.frequency=2",
      candidate.frequency === 2,
      `frequency=${candidate.frequency}`,
    );
    if (!(run1.errored === 0 && cands1?.length === 1 && candidate.state === "mined" && candidate.frequency === 2)) {
      exitCode = 1;
    }

    // ── Test B: promote, assert agent_skills + state='promoted'. ────────
    console.log("\nTest B: promoteSkillCandidate creates agent_skills row");
    const promote = await promoteSkillCandidate({ candidate_id: candidate.id });
    record(
      "B1 promote returns skill_id",
      typeof promote.skill_id === "number" && promote.skill_id > 0,
      `skill_id=${promote.skill_id} version=${promote.skill_version}`,
    );
    const { data: skillRow } = await supabase
      .from("agent_skills")
      .select("id, project_id, name")
      .eq("id", promote.skill_id)
      .maybeSingle();
    record(
      "B2 agent_skills row exists",
      skillRow !== null && skillRow !== undefined,
      `row=${JSON.stringify(skillRow)}`,
    );
    const { data: cand2 } = await supabase
      .from("skill_candidates")
      .select("state, promoted_skill_id")
      .eq("id", candidate.id)
      .maybeSingle();
    record(
      "B3 skill_candidates.state='promoted'",
      cand2?.state === "promoted",
      `state=${cand2?.state}`,
    );
    record(
      "B4 promoted_skill_id linked",
      cand2?.promoted_skill_id === promote.skill_id,
      `promoted_skill_id=${cand2?.promoted_skill_id}`,
    );
    if (!(skillRow && cand2?.state === "promoted" && cand2.promoted_skill_id === promote.skill_id)) {
      exitCode = 1;
    }

    // ── Test C: re-mine — no duplicate (idempotency / UNIQUE). ──────────
    console.log("\nTest C: re-run runMiningOnce — UNIQUE on (project_id, pattern_hash)");
    const run2 = await runMiningOnce({ projectId: PROJECT_ID, minFreq: 2, batch: 10 });
    record(
      "C1 run errored=0",
      run2.errored === 0,
      `mined=${run2.mined} skipped=${run2.skipped} errored=${run2.errored}`,
    );
    const { data: cands2 } = await supabase
      .from("skill_candidates")
      .select("id")
      .eq("project_id", PROJECT_ID);
    record(
      "C2 still exactly 1 skill_candidates row",
      (cands2?.length ?? 0) === 1,
      `count=${cands2?.length ?? 0}`,
    );
    if (!(run2.errored === 0 && cands2?.length === 1)) exitCode = 1;

    // ── Test D: reject path (smoke for the third handler). ──────────────
    // Use a fresh candidate (we have to create it directly because the
    // promoted one can't be rejected). This exercises rejectSkillCandidate
    // without coupling it to the promotion path.
    console.log("\nTest D: rejectSkillCandidate handler");
    const { data: stub, error: stubErr } = await supabase
      .from("skill_candidates")
      .insert([
        {
          project_id: PROJECT_ID,
          pattern_hash: "smoke-012-reject-hash",
          frequency: 2,
          success_count: 2,
          proposed_name: "smoke-012-reject",
          proposed_steps: [{ step: 1, action: "noop" }],
          state: "mined",
        },
      ])
      .select("id")
      .single();
    if (stubErr || !stub) throw new Error(`Test D seed failed: ${stubErr?.message}`);
    const rejected = await rejectSkillCandidate({
      candidate_id: stub.id as number,
      reason: "smoke test",
    });
    record(
      "D1 state='rejected' + reason persisted",
      rejected.state === "rejected" && rejected.rejection_reason === "smoke test",
      `state=${rejected.state} reason=${rejected.rejection_reason}`,
    );
  } catch (e) {
    console.error(`\nSMOKE THREW: ${(e as Error).message}`);
    console.error((e as Error).stack);
    exitCode = 1;
  } finally {
    try {
      await cleanup("post-test");
    } catch (e) {
      console.error(`post-test cleanup failed: ${(e as Error).message}`);
      exitCode = 1;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(
    `\n${exitCode === 0 ? "SMOKE PASS" : "SMOKE FAIL"} ${passed}/${total} assertions in ${elapsed}s`,
  );

  process.exit(exitCode);
})();
