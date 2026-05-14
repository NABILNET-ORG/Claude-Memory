# Changelog

## [2.0.1] — 2026-05-14

**v2.0.1 — Tech-Debt & Operational-Hygiene Patch**

Pays off two pieces of debt carried out of v2.0.0 so the BYO-Supabase boot path becomes mathematically re-runnable. Zero schema-shape change, zero new features, zero new tool surface.

### Fixed
- **Migrations are now strictly idempotent (Backlog #131).** Session 26 read-only audit inventoried 6 of 18 migrations carrying non-idempotent statements. Patched 12 lines across 6 files: 10 `CREATE FUNCTION` → `CREATE OR REPLACE FUNCTION` in `010_agent_skills.sql`, `011_trajectory_compaction.sql`, `012_sleep_learning.sql`, `015_curriculum_tasks.sql`; and bare `ON CONFLICT DO NOTHING` added to the lone seed `INSERT INTO archive_backlog` in `005_archive_backlog.sql` and `014_workflow_checkpoints.sql`. Every other DDL class (extensions, tables, indexes, schemas, types, policies, triggers, ADD COLUMN, ADD CONSTRAINT) was already guarded.
- **Migration ledger denylist removed (Backlog #130).** `006_smoke.sql` and `006_verify.sql` were companion validation scripts that shared `scripts/` with real numbered migrations, forcing `loadMigrationFiles()` to maintain an explicit `excluded` Set. Both fixtures now live under `tests/sql_fixtures/`; `loadMigrationFiles()` collapsed to a single regex filter. The "every `0NN_*.sql` in `scripts/` is a migration" contract is now structural, not denylist-enforced.

### Added
- Opt-in idempotency proof test in `tests/migrations.test.ts`. Gated on `RUN_IDEMPOTENCY_TEST=1` (destructive — truncates `public.schema_migrations`, re-applies all 18 migrations against the already-migrated DB, asserts `applied === 18` and `skipped === 0`, then UPSERT-restores the snapshot in a `finally` block so the dev ledger never ends half-broken). `search_path` pinned to `public, extensions` so pgvector operator classes (`vector_cosine_ops` on `hnsw`) resolve under the pooler role.

### Notes
- `schema_migrations.sha256` values for the 6 patched files diverge from what is recorded on already-applied dev DBs. This is silent and harmless: `applyPendingMigrations()` acts on filename presence only — applied rows are not re-validated — and fresh BYO-Supabase installs ship with the new hashes.
- The MCP server's tool surface is unchanged at 39 tools.
- The 18 schema migrations remain at version 18; only their re-runnability has improved.

## [2.0.0] — 2026-05-14

**v2.0.0 GA — Plugin Marketplace Release**

Smart-Claude-Memory is now installable as a Claude Code Plugin. Zero manual `~/.claude.json` edits, zero manual schema apply, zero hand-edited `~/.claude/settings.json` — first `init_project()` bootstraps an empty Supabase DB and verifies your Ollama models in one call.

### Added
- `.claude-plugin/plugin.json` manifest — installable via Claude Code marketplace; auto-wires the MCP server (with env passthrough for the 7 SCM vars) and the `md-policy.py` PreToolUse hook (`Write|Edit|Bash` matcher).
- `schema_migrations(filename, sha256, applied_at)` ledger table + idempotent apply-all CLI (`npm run schema`); re-runs are no-ops. Legacy single-file mode preserved for emergencies.
- `src/lib/migrations.ts` shared helper (`ensureLedger`, `loadMigrationFiles`, `listPendingMigrations`, `applyPendingMigrations`).
- `init_project` auto-applies pending migrations on first call against a fresh `pg.Client`. Surfaces a new `migrations` check + top-level `migrations: { applied, skipped, total }` block. Errors gracefully convert to `not_ready` without crashing the MCP server.
- `init_project` Ollama models preflight: queries `${OLLAMA_HOST}/api/tags` and verifies `moondream` + `nomic-embed-text` are pulled. Missing models surface a `partial` status with the exact `Run: ollama pull <names>` command. 5s timeout via `AbortController`.
- `scripts/backfill-ledger.ts` one-shot operational utility to sync `schema_migrations` for pre-existing DBs.
- `marketplace.json` for Claude Code marketplace publication.

### Changed
- Health enum extended: `"healthy" | "pending" | "degraded" | "down"`. Daemons within a 15-minute boot grace window report `pending` instead of `down`. Top-level `overall` no longer falsely promoted to `down` on cold boot. `pending` ranks below `degraded` (SEVERITY 0.5).
- `pg` promoted from `devDependencies` → `dependencies` (runtime use in `init_project`).
- README install ritual reduced from 5 steps to 3 (plugin install → empty Supabase + pull Ollama models → set 3 env vars).
- ARCHITECTURE.md gains a `## 7. Plugin Distribution` section covering manifest semantics, the migration ledger boot path, hook injection, and the pending/grace health state.

### Fixed
- `tests/trajectory-daemon.test.ts` key-count assertion (7 → 9) brought in sync with the per-tick token counters added in `58dc6d1` (Session 24).

### Migrated from 2.0.0-rc1
- All Observability Epic work (4 daemons + GLOBAL Vault + system_dashboard) carried over unchanged.
- No breaking changes to existing tool surfaces.

### Notes
- The MCP server's tool surface is unchanged at 39 tools.
- The 18 schema migrations are unchanged; only the apply mechanism evolved.
