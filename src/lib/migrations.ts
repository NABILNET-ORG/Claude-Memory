// src/lib/migrations.ts — schema_migrations ledger helpers (Task 2, Marketplace
// Packaging epic). Shared module imported by:
//   - scripts/apply-schema.ts (CLI: `npm run schema`)
//   - src/tools/init_project.ts (Task 3 — auto-applies pending migrations on
//     first MCP call so BYO-Supabase users don't have to run the CLI manually)
//
// Contract (per spec §4.2):
//   schema_migrations(filename text PRIMARY KEY, sha256 text NOT NULL,
//                     applied_at timestamptz NOT NULL DEFAULT now())
//
//   apply algorithm:
//     1. ensureLedger() — CREATE TABLE IF NOT EXISTS
//     2. listPendingMigrations() — diff fs vs ledger
//     3. for each pending: BEGIN → exec body → INSERT ledger → COMMIT
//        (ROLLBACK + throw on any error; abort the rest of the batch)
//
// Idempotency: re-running applyPendingMigrations against a fully-applied DB
// returns { applied: 0, skipped: N, total: N }.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Absolute path to the directory containing the SQL migration files.
 * Resolves to `<repo>/scripts` from both `src/lib/migrations.ts` (dev,
 * via tsx) and `dist/lib/migrations.js` (built). Both layouts sit two
 * levels deep under the repo root.
 */
export const MIGRATIONS_DIR: string = resolve(__dirname, "..", "..", "scripts");

/** Regex anchoring a real, numbered migration: 001_schema.sql, 017_foo.sql, etc. */
const MIGRATION_RE = /^0\d{2}_.+\.sql$/;

export interface MigrationFile {
  filename: string;
  sha256: string;
  body: string;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  total: number;
  appliedFiles: string[];
  skippedFiles: string[];
}

/**
 * Scan MIGRATIONS_DIR for files matching /^0\d{2}_.+\.sql$/, lex-sorted.
 * Reads each file body and computes its sha256 (hex). Pure FS — no DB.
 *
 * Excludes companion artefacts that share the 0NN prefix but are NOT
 * migrations (e.g. `006_smoke.sql`, `006_verify.sql`). The regex itself
 * is permissive on these — we filter them explicitly below.
 */
export function loadMigrationFiles(): MigrationFile[] {
  const excluded = new Set(["006_smoke.sql", "006_verify.sql"]);
  const entries = readdirSync(MIGRATIONS_DIR);
  const files = entries
    .filter((name) => MIGRATION_RE.test(name) && !excluded.has(name))
    .sort();

  return files.map((filename) => {
    const body = readFileSync(resolve(MIGRATIONS_DIR, filename), "utf8");
    const sha256 = createHash("sha256").update(body).digest("hex");
    return { filename, sha256, body };
  });
}

/**
 * Ensure the schema_migrations ledger table exists. Idempotent —
 * uses CREATE TABLE IF NOT EXISTS so repeated calls are no-ops.
 *
 * Note: this respects the caller's current `search_path`. Tests pin
 * search_path to a temporary schema; production callers leave it at
 * the default (`public`), which is where the ledger lives.
 */
export async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Return the subset of MigrationFiles whose filename is NOT yet in the
 * schema_migrations ledger. Ordering matches loadMigrationFiles().
 *
 * Calls ensureLedger() first so an empty/fresh DB returns the full list
 * rather than throwing on a missing table.
 */
export async function listPendingMigrations(
  client: Client,
): Promise<MigrationFile[]> {
  await ensureLedger(client);
  const { rows } = await client.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  const applied = new Set(rows.map((r) => r.filename));
  return loadMigrationFiles().filter((f) => !applied.has(f.filename));
}

/**
 * Apply every pending migration, one transaction per file. On any error:
 * ROLLBACK that file and throw — subsequent files are NOT attempted, so
 * the ledger always reflects DB reality.
 *
 * Re-runnable: when nothing is pending, returns `{ applied: 0, skipped:
 * N, total: N }` and does no DB writes beyond the idempotent ensureLedger.
 */
export async function applyPendingMigrations(
  client: Client,
): Promise<ApplyResult> {
  await ensureLedger(client);
  const all = loadMigrationFiles();
  const { rows } = await client.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  const alreadyApplied = new Set(rows.map((r) => r.filename));

  const skippedFiles = all
    .filter((f) => alreadyApplied.has(f.filename))
    .map((f) => f.filename);
  const pending = all.filter((f) => !alreadyApplied.has(f.filename));

  const appliedFiles: string[] = [];

  for (const file of pending) {
    try {
      await client.query("BEGIN");
      await client.query(file.body);
      await client.query(
        "INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)",
        [file.filename, file.sha256],
      );
      await client.query("COMMIT");
      appliedFiles.push(file.filename);
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ROLLBACK can fail if the connection itself died; surface the
        // ORIGINAL error rather than masking it with the rollback fault.
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${file.filename} failed: ${msg}`);
    }
  }

  return {
    applied: appliedFiles.length,
    skipped: skippedFiles.length,
    total: all.length,
    appliedFiles,
    skippedFiles,
  };
}
