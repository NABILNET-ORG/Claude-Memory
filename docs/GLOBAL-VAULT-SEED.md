# GLOBAL Knowledge Vault — Seed v2.0.0-rc1

Three universal patterns promoted to GLOBAL scope so every project using this
MCP inherits them.

---

## The 3 Rules

**PATTERN-1 · Mermaid Modularity**
One Mermaid block per ## subsystem, ≤40 nodes each. GitHub silently drops
oversized graphs; a monolithic flowchart renders blank. Split diagrams at
subsystem boundaries and regenerate per-section on session end.

**PATTERN-2 · SQL Security**
Every Postgres function must: pin `set search_path = public, extensions,
pg_temp`; place `project_id` as first WHERE predicate; index JSONB with
`GIN (col jsonb_path_ops)` (not default jsonb_ops) for `@>` containment.

**PATTERN-3 · Core 3 Sync Gate**
CLAUDE.md, README.md, ARCHITECTURE.md are load-bearing. mtime drift must be
≤30 days. If init_project returns core3.in_sync=false, delegate a Core-3
audit before any other work begins.

---

## Prerequisites

- `SUPABASE_POOLER_URL` (or `SUPABASE_DB_URL`) in environment.
- Local Ollama on `OLLAMA_HOST` (default `http://localhost:11434`).
- `npm install` already run.

---

## Run the Seed Script

```bash
npx tsx scripts/seed-global-patterns.ts
```

Success prints each slug + row id; exits 0. Script is idempotent — re-running
updates existing rows via dedup key `(project_id, file_origin, chunk_index)`.

---

## Verify

```ts
search_memory({ query: "Mermaid diagram size limit",
  include_global: true, metadata_filter: { type: "PATTERN", is_global: true } })

search_memory({ query: "Postgres search_path security",
  include_global: true, metadata_filter: { type: "PATTERN", is_global: true } })

search_memory({ query: "Core 3 sync gate",
  include_global: true, metadata_filter: { type: "PATTERN", is_global: true } })
```

Each result should carry `context_id: "v2.0.0-rc1-seed"`.
