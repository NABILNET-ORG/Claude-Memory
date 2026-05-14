# Backlog #124 — `daemon_telemetry` Rolling Retention Policy

**Session 24 · 2026-05-13 · Owner: Orchestrator (Claude)**

## Problem

`daemon_telemetry` is append-only (migration `scripts/016_daemon_telemetry.sql`).
At ~500k rows it begins to bite — and the read paths only ever look at the last
24h (`system_dashboard`) or last 1h (`check_system_health`). Long-term rows are
unobservable dead weight. Captured as backlog item #124 during the Session 23
OBS-EPIC wrap-up; YAGNI'd from the main epic but flagged for follow-up before
cardinality becomes a real correctness concern.

## Decision

**Hard DELETE older than `RETENTION_DAYS` (default 30), driven by a 4th
in-process daemon `telemetry_pruner`, ticked every 6h.**

### Rejected alternatives

| Option | Why rejected |
|---|---|
| Roll up to daily summary table | New table, new RPC, new schema — for zero downstream consumer. Read paths max-out at 24h, so >30d data is already unused. Pure YAGNI; revisit if/when long-term trend analysis is requested. |
| `pg_cron` extension | Adds runtime dependency the system doesn't currently have. Counter-pattern (no other SCM feature uses pg_cron). Requires extension install + migration. Marginal benefit (survives MCP restart) doesn't outweigh the new failure surface. |
| Manual MCP tool invocation | Defeats the purpose. Retention has to be hands-off. |
| 24h interval | Would yield exactly one `run_ended` per day → falls outside the 1h health window most of the time → permanent false-positive "down" status (see derivation rule 2 in §4.8). |

### Why 6h interval

4 ticks/day ⇒ guaranteed `run_ended` row inside the 1h health window ⇒ clean
`deriveDaemonStatus()` integration. Cheap: each DELETE bounded by retention
window, not full-table scan-friendly.

## Architecture fit (ARCHITECTURE.md §4.8)

The pruner is the 4th daemon alongside `sleep_learner`, `curriculum_scanner`,
`trajectory_compactor`. It emits the same `run_started` / `run_ended` /
`run_errored` event taxonomy through the existing `src/telemetry/emit.ts`
fire-and-forget surface. It is consumed by both decoupled read paths
(`system_dashboard` + `check_system_health`) for free — no new read code.

```
sleep_learner    ─┐
curriculum_scanner ─┼─→ emit ─→ daemon_telemetry ─→ system_dashboard
trajectory_compactor┤                            ─→ check_system_health
telemetry_pruner ─┘                                            ↑
                       (also emits)                           PRUNES here
```

### `run_ended` payload

```ts
{ deleted: number, retention_days: number, duration_ms: number }
```

`deleted` is the row count returned by the DELETE; `retention_days` echoes the
config so historical telemetry can be replayed even if the env var changes.

## File-by-file scope

| File | Action |
|---|---|
| `scripts/018_telemetry_retention.sql` | NEW — idempotent: `ALTER TABLE daemon_telemetry DROP CONSTRAINT daemon_telemetry_daemon_check; ADD CONSTRAINT … CHECK (daemon IN ('sleep_learner','curriculum_scanner','trajectory_compactor','telemetry_pruner'));` Wrap in DO block per the migration-006 pattern. |
| `src/telemetry/pruner.ts` | NEW — mirrors `src/trajectory/daemon.ts:1-273`: module-level `state`, `readIntEnv` helper, `resolveConfig`, `runPruneOnce` (DELETE + count), `startTelemetryPruner` (idempotent + `.unref()` + re-entrancy guard), `stopTelemetryPruner`, `getPrunerStatus`. |
| `src/telemetry/types.ts` | Extend `Daemon` union to include `'telemetry_pruner'`; add `RunEndedPrunerPayload`; ensure existing `TrajectoryEndedPayload` etc. discriminator pattern is mirrored. |
| `src/index.ts` (or wherever the other 3 daemons start) | `startTelemetryPruner()` call. |
| `src/tools/health.ts` | Add `telemetry_pruner` to the daemon-status rollup; reuse `deriveDaemonStatus()` exactly. |
| `src/tools/system_dashboard.ts` | Confirm rollup query returns the new daemon (the existing query is daemon-agnostic — should "just work", but verify and add a row in the test snapshot). |
| `scripts/test-obs-pruner-smoke.ts` | NEW — insert N old rows (created_at backdated), run `runPruneOnce()` with `RETENTION_DAYS=0`, assert all rows deleted + `run_ended` emitted with `deleted=N`. |
| `ARCHITECTURE.md §4.8` | Add 4th daemon row to event-source table; refresh the Mermaid `Daemons` subgraph to include `TP[telemetry_pruner.tick]`. |
| `.env.example` (if exists) | Document `TELEMETRY_PRUNER_INTERVAL_MS=21600000` and `TELEMETRY_PRUNER_RETENTION_DAYS=30`. |

## Env contract

| Var | Default | Notes |
|---|---|---|
| `TELEMETRY_PRUNER_INTERVAL_MS` | `21_600_000` (6h) | Mirrors `*_INTERVAL_MS` pattern. |
| `TELEMETRY_PRUNER_RETENTION_DAYS` | `30` | Inclusive: rows with `created_at < now() - INTERVAL 'N days'` are deleted. |

## Out of scope (explicit)

- **No new index** on `daemon_telemetry(created_at)`. The existing
  `(daemon, created_at desc)` indexes don't help the predicate, but seqscan is
  fine until the table is genuinely large. Add the index in a separate commit
  if/when the pruner's `duration_ms` regresses.
- **No roll-up table.** If long-term trend analysis becomes a need, that's a
  new spec, not a creep into this one.
- **#125 (compactor token aggregation) is a separate commit.** Foundation-First
  forbids entangling.

## Verification gates

1. `npm run build` — zero TS errors.
2. `tsx scripts/test-obs-pruner-smoke.ts` — passes against live Supabase
   (requires `RETENTION_DAYS=0` env override + cleanup of the seeded rows).
3. `tsx scripts/apply-schema.ts scripts/018_telemetry_retention.sql` — idempotent
   re-apply yields no error.
4. Manual `check_system_health` after first tick: `telemetry_pruner` reports
   `healthy` with non-null `last_run_ended_at`.
5. `confirm_verification({ success: true })` only after all four pass.

## Risks

- **CHECK constraint migration on a populated table.** Postgres re-validates the
  CHECK across all existing rows; with 7545 chunks total but probably <50k
  telemetry rows, this is sub-second. Idempotent DO-block guard prevents
  re-entry pain.
- **Cold-start health flap.** First boot after the migration: pruner has zero
  `run_ended` rows for the first 6h ⇒ derivation rule 2 marks it `down`. This
  is identical to the existing `curriculum_scanner` "down" cold-start state
  observed in this very session — accepted as benign per §4.8 derivation rules.

## Why this passes the Sovereign Vetting (Cross-Project Test)

The retention policy itself is project-local. The PATTERN — "every append-only
telemetry table needs a paired in-process pruner before cardinality bites,
ticked at a frequency that keeps the daemon inside its own health window" —
**does** pass the Cross-Project Test and will be saved as a global PATTERN
after the implementation lands.
