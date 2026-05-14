import "dotenv/config";
import { Client } from "pg";
import { ensureLedger, loadMigrationFiles, listPendingMigrations } from "../src/lib/migrations.js";

async function main() {
  const cs = process.env.SUPABASE_POOLER_URL || process.env.SUPABASE_DB_URL;
  if (!cs) {
    console.error("Missing SUPABASE_POOLER_URL (or SUPABASE_DB_URL).");
    process.exit(1);
  }
  const client = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await ensureLedger(client);
    const files = loadMigrationFiles();
    console.log(`Backfilling ${files.length} migration(s) into schema_migrations…`);
    let inserted = 0;
    let skipped = 0;
    for (const f of files) {
      const r = await client.query(
        "INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING",
        [f.filename, f.sha256]
      );
      if (r.rowCount && r.rowCount > 0) {
        inserted++;
        console.log(`  ✓ inserted ${f.filename}`);
      } else {
        skipped++;
        console.log(`  ◦ already-present ${f.filename}`);
      }
    }
    console.log(`\nBackfill complete. inserted=${inserted} already_present=${skipped} total=${files.length}`);

    const pending = await listPendingMigrations(client);
    console.log(`\nVerification: listPendingMigrations() → ${pending.length} pending`);
    if (pending.length > 0) {
      console.error("BACKFILL VERIFICATION FAILED — pending list is not empty.");
      for (const p of pending) console.error(`  ! still pending: ${p.filename}`);
      process.exit(2);
    }
    console.log("✓ Ledger now reflects reality (0 pending).");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
