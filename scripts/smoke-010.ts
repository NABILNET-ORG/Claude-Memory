/**
 * smoke-010 — JIT Skill Retrieval end-to-end smoke test (Mission 1).
 *
 * Exercises:
 *   A. package_skill (project-local) for 3 distinct skills, asserts version: 1.
 *   B. request_skill semantic match — top-1 must be the commit skill, steps verbatim.
 *   C. Re-packaging bumps version to 2, telemetry preserved.
 *   D. Telemetry — request_skill bumps frequency_used / last_invoked_at.
 *   E. GLOBAL scope is dual-scoped into project-scope searches.
 *
 * Pre/post cleanup deletes every smoke-010-* row (project + GLOBAL).
 * Exits 0 on full pass, 1 on any failure.
 */
import { config as dotenvConfig } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { packageSkill, requestSkill } from "../src/tools/skills.js";
import { currentProjectId } from "../src/project.js";

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

type SkillRow = {
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
};

const SMOKE_PREFIX = "smoke-010-";

async function cleanup(label: string): Promise<void> {
  const { error } = await supabase
    .from("agent_skills")
    .delete()
    .like("name", `${SMOKE_PREFIX}%`);
  if (error) {
    console.error(`[${label}] cleanup error: ${error.message}`);
    throw new Error(error.message);
  }
}

async function fetchByName(name: string): Promise<SkillRow | null> {
  const { data, error } = await supabase
    .from("agent_skills")
    .select(
      "id, project_id, name, version, description, steps, trigger_keywords, frequency_used, success_rate, last_invoked_at",
    )
    .eq("name", name)
    .limit(2);
  if (error) throw new Error(`fetchByName(${name}) failed: ${error.message}`);
  const rows = (data ?? []) as SkillRow[];
  if (rows.length === 0) return null;
  // (project_id, name) is unique within scope, but two scopes (project +
  // GLOBAL) could carry the same name. Prefer the non-GLOBAL row.
  const project = rows.find((r) => r.project_id !== "GLOBAL");
  return project ?? rows[0];
}

type TestResult = { name: string; ok: boolean; note?: string };
const results: TestResult[] = [];

function record(name: string, ok: boolean, note?: string): boolean {
  results.push({ name, ok, note });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
  return ok;
}

const COMMIT_STEPS = [
  { step: 1, action: "git status" },
  { step: 2, action: "git add -p" },
  { step: 3, action: "git commit -m \"<message>\" using a heredoc to preserve newlines" },
];
const DEPLOY_STEPS = [
  { step: 1, action: "vercel pull --environment=production" },
  { step: 2, action: "vercel build --prod" },
  { step: 3, action: "vercel deploy --prebuilt --prod" },
];
const REFACTOR_STEPS = [
  { step: 1, action: "identify the duplicated logic" },
  { step: 2, action: "extract it into a private helper" },
  { step: 3, action: "rewrite call sites + run tsc --noEmit" },
];
const COMMIT_STEPS_V2 = [
  ...COMMIT_STEPS,
  { step: 4, action: "verify via git log --oneline -1" },
];
const GLOBAL_STEPS = [
  { step: 1, action: "format the diagnostic block" },
  { step: 2, action: "save_memory with metadata.type='DECISION'" },
];

const t0 = Date.now();
console.log("smoke-010 — JIT Skill Retrieval");
console.log(`project_id: ${currentProjectId}`);

let exitCode = 0;

try {
  // ── pre-test cleanup ────────────────────────────────────────────────────
  await cleanup("pre-test");

  // ── Test A: package_skill (project-local) ──────────────────────────────
  console.log("\nTest A: package_skill (project-local) x3");
  const commit = await packageSkill({
    name: `${SMOKE_PREFIX}commit`,
    description: "create a git commit with a heredoc message",
    steps: COMMIT_STEPS,
    trigger_keywords: ["commit", "git"],
  });
  const deploy = await packageSkill({
    name: `${SMOKE_PREFIX}deploy`,
    description: "deploy the Next.js app to Vercel production",
    steps: DEPLOY_STEPS,
    trigger_keywords: ["deploy", "vercel"],
  });
  const refactor = await packageSkill({
    name: `${SMOKE_PREFIX}refactor`,
    description: "refactor a TypeScript function to extract a helper",
    steps: REFACTOR_STEPS,
    trigger_keywords: ["refactor", "typescript"],
  });
  const aOk = record(
    "A1 commit version=1",
    commit.version === 1 && commit.scope === "project",
    `version=${commit.version}, scope=${commit.scope}`,
  );
  const aOk2 = record(
    "A2 deploy version=1",
    deploy.version === 1 && deploy.scope === "project",
    `version=${deploy.version}, scope=${deploy.scope}`,
  );
  const aOk3 = record(
    "A3 refactor version=1",
    refactor.version === 1 && refactor.scope === "project",
    `version=${refactor.version}, scope=${refactor.scope}`,
  );
  if (!(aOk && aOk2 && aOk3)) exitCode = 1;

  // ── Test B: request_skill semantic match ────────────────────────────────
  console.log("\nTest B: request_skill semantic match");
  const search = await requestSkill({
    query: "how do I make a git commit",
    k: 2,
    min_similarity: 0.3,
    include_global: true,
  });
  const bHasResults = record(
    "B1 >=1 result",
    search.count >= 1,
    `count=${search.count}`,
  );
  const top = search.skills[0];
  const bTopName = record(
    "B2 top.name=commit",
    top !== undefined && top.name === `${SMOKE_PREFIX}commit`,
    top ? `top=${top.name} similarity=${top.similarity.toFixed(3)}` : "no hit",
  );
  const bStepsMatch = record(
    "B3 steps verbatim",
    top !== undefined && JSON.stringify(top.steps) === JSON.stringify(COMMIT_STEPS),
    top ? `steps length=${top.steps.length}` : "no hit",
  );
  if (!(bHasResults && bTopName && bStepsMatch)) exitCode = 1;

  // ── Test C: version bump ───────────────────────────────────────────────
  console.log("\nTest C: version bump preserves telemetry");
  // Snapshot pre-bump telemetry (it may have been touched by Test B's bumps).
  const preBump = await fetchByName(`${SMOKE_PREFIX}commit`);
  if (!preBump) throw new Error("Test C: pre-bump row missing");
  // Sleep briefly so any in-flight fire-and-forget telemetry bump from Test B
  // has time to land before we snapshot — telemetry preservation is what we
  // assert below.
  await new Promise((r) => setTimeout(r, 500));
  const preBumpFinal = await fetchByName(`${SMOKE_PREFIX}commit`);
  if (!preBumpFinal) throw new Error("Test C: pre-bump-final row missing");

  const repackage = await packageSkill({
    name: `${SMOKE_PREFIX}commit`,
    description: "create a git commit with a heredoc message",
    steps: COMMIT_STEPS_V2,
    trigger_keywords: ["commit", "git"],
  });
  const cVersion = record(
    "C1 version=2",
    repackage.version === 2,
    `version=${repackage.version}`,
  );
  const postBump = await fetchByName(`${SMOKE_PREFIX}commit`);
  if (!postBump) throw new Error("Test C: post-bump row missing");
  const cFreqPreserved = record(
    "C2 frequency_used preserved",
    postBump.frequency_used === preBumpFinal.frequency_used,
    `pre=${preBumpFinal.frequency_used} post=${postBump.frequency_used}`,
  );
  const cRatePreserved = record(
    "C3 success_rate preserved",
    Math.abs(postBump.success_rate - preBumpFinal.success_rate) < 1e-6,
    `pre=${preBumpFinal.success_rate} post=${postBump.success_rate}`,
  );
  const cStepsUpdated = record(
    "C4 steps replaced (v2 has 4 entries)",
    Array.isArray(postBump.steps) && postBump.steps.length === COMMIT_STEPS_V2.length,
    `length=${(postBump.steps as unknown[])?.length ?? 0}`,
  );
  if (!(cVersion && cFreqPreserved && cRatePreserved && cStepsUpdated)) exitCode = 1;

  // ── Test D: telemetry bump ─────────────────────────────────────────────
  console.log("\nTest D: telemetry bump on retrieval");
  const preTelemetry = await fetchByName(`${SMOKE_PREFIX}commit`);
  if (!preTelemetry) throw new Error("Test D: pre-telemetry row missing");
  const tQuery0 = Date.now();
  await requestSkill({
    query: "how do I make a git commit",
    k: 2,
    min_similarity: 0.3,
    include_global: true,
  });
  // Fire-and-forget telemetry — give it a moment to land.
  await new Promise((r) => setTimeout(r, 1500));
  const postTelemetry = await fetchByName(`${SMOKE_PREFIX}commit`);
  if (!postTelemetry) throw new Error("Test D: post-telemetry row missing");
  const dFreq = record(
    "D1 frequency_used >= 1",
    postTelemetry.frequency_used >= 1,
    `frequency_used=${postTelemetry.frequency_used}`,
  );
  const lastTs = postTelemetry.last_invoked_at
    ? Date.parse(postTelemetry.last_invoked_at)
    : 0;
  const dRecent = record(
    "D2 last_invoked_at within 60s",
    lastTs > 0 && Math.abs(Date.now() - lastTs) < 60_000,
    `last_invoked_at=${postTelemetry.last_invoked_at} delta=${Date.now() - lastTs}ms`,
  );
  const dBumped = record(
    "D3 freq strictly > pre-D",
    postTelemetry.frequency_used > preTelemetry.frequency_used,
    `pre=${preTelemetry.frequency_used} post=${postTelemetry.frequency_used}`,
  );
  if (!(dFreq && dRecent && dBumped)) exitCode = 1;
  // Surface query timing for the orchestrator's synthesis.
  console.log(`  (request_skill round-trip: ${Date.now() - tQuery0}ms)`);

  // ── Test E: GLOBAL scope ───────────────────────────────────────────────
  console.log("\nTest E: GLOBAL scope dual-scoped into project search");
  const globalSkill = await packageSkill({
    name: `${SMOKE_PREFIX}global`,
    description: "Universal pattern: save a typed DECISION memory with global rationale",
    steps: GLOBAL_STEPS,
    trigger_keywords: ["decision", "memory", "save"],
    is_global: true,
  });
  const eGlobalScope = record(
    "E1 packaged under GLOBAL",
    globalSkill.scope === "global",
    `scope=${globalSkill.scope}`,
  );
  const globalRow = await fetchByName(`${SMOKE_PREFIX}global`);
  const eRowGlobal = record(
    "E2 row.project_id=GLOBAL",
    globalRow?.project_id === "GLOBAL",
    `project_id=${globalRow?.project_id}`,
  );
  const eSearch = await requestSkill({
    query: "save a DECISION memory that applies across projects",
    k: 5,
    min_similarity: 0.3,
    include_global: true,
  });
  const eHasGlobal = eSearch.skills.some(
    (s) => s.scope === "global" && s.name === `${SMOKE_PREFIX}global`,
  );
  const eGlobalSurfaces = record(
    "E3 GLOBAL skill surfaces in project search",
    eHasGlobal,
    `hits=${eSearch.count} scopes=${eSearch.skills.map((s) => s.scope).join(",")}`,
  );
  // Negative control: with include_global=false the GLOBAL row must NOT appear.
  const eSearchProject = await requestSkill({
    query: "save a DECISION memory that applies across projects",
    k: 5,
    min_similarity: 0.3,
    include_global: false,
  });
  const eIsolation = record(
    "E4 include_global=false hides GLOBAL",
    !eSearchProject.skills.some((s) => s.scope === "global"),
    `scopes=${eSearchProject.skills.map((s) => s.scope).join(",") || "(none)"}`,
  );
  if (!(eGlobalScope && eRowGlobal && eGlobalSurfaces && eIsolation)) exitCode = 1;
} catch (e) {
  console.error(`\nSMOKE THREW: ${(e as Error).message}`);
  console.error((e as Error).stack);
  exitCode = 1;
} finally {
  // ── post-test cleanup ───────────────────────────────────────────────────
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
