#!/usr/bin/env tsx
/**
 * Seeds the GLOBAL Knowledge Vault with 3 universal patterns for v2.0.0-rc1.
 * Run: npx tsx scripts/seed-global-patterns.ts
 */

import pg from "pg";
import { embed } from "../src/ollama.js";

const { Client } = pg;

const RULES: Array<{ slug: string; content: string }> = [
  {
    slug: "mermaid-modularity",
    content:
      "One Mermaid block per ## subsystem, ≤40 nodes each. GitHub silently drops oversized graphs; a monolithic flowchart renders blank. Split diagrams at subsystem boundaries and regenerate per-section on session end.",
  },
  {
    slug: "sql-security",
    content:
      "Every Postgres function must: pin `set search_path = public, extensions, pg_temp`; place `project_id` as first WHERE predicate; index JSONB with `GIN (col jsonb_path_ops)` (not default jsonb_ops) for `@>` containment.",
  },
  {
    slug: "core3-sync-gate",
    content:
      "CLAUDE.md, README.md, ARCHITECTURE.md are load-bearing. mtime drift must be ≤30 days. If init_project returns core3.in_sync=false, delegate a Core-3 audit before any other work begins.",
  },
];

const METADATA = {
  type: "PATTERN",
  is_global: true,
  status: "verified",
  context_id: "v2.0.0-rc1-seed",
};

async function main() {
  const connectionString =
    process.env.SUPABASE_POOLER_URL ?? process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.error("SUPABASE_POOLER_URL or SUPABASE_DB_URL missing from environment");
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let exitCode = 0;

  for (const rule of RULES) {
    const fileOrigin = `global:patterns:${rule.slug}`;
    console.log(`\nSeeding: ${fileOrigin}`);
    console.log(`  Length: ${rule.content.length} chars`);

    if (rule.content.length > 300) {
      console.error(`  ERROR: rule exceeds 300-char limit (${rule.content.length})`);
      exitCode = 1;
      continue;
    }

    let embeddingVec: number[];
    try {
      const vecs = await embed([rule.content]);
      embeddingVec = vecs[0];
    } catch (err) {
      console.error(`  ERROR computing embedding: ${err}`);
      exitCode = 1;
      continue;
    }

    // Format as pgvector literal: [0.1, 0.2, ...]
    const vectorLiteral = JSON.stringify(embeddingVec);

    try {
      const result = await client.query<{ upsert_memory_rule: string }>(
        `SELECT upsert_memory_rule($1, $2, $3, $4, $5::vector, $6::jsonb) AS id`,
        [
          "GLOBAL",
          fileOrigin,
          0,
          rule.content,
          vectorLiteral,
          JSON.stringify(METADATA),
        ]
      );
      const id = result.rows[0]?.id;
      console.log(`  OK — row id: ${id}`);
    } catch (err) {
      console.error(`  ERROR upserting rule: ${err}`);
      exitCode = 1;
    }
  }

  await client.end();

  if (exitCode !== 0) {
    console.error("\nSeed completed with errors.");
  } else {
    console.log("\nSeed complete — all 3 patterns written to GLOBAL vault.");
  }
  process.exit(exitCode);
}

main();
