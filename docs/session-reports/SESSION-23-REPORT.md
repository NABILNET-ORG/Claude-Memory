# Session 23 Report — Observability Epic & Supabase Foundation Fix

**Date:** 2026-05-13
**Theme:** Daemon telemetry persistence, decoupled monitoring surfaces, self-aware health derivation, May 30 Supabase compliance hotfix.

## TL;DR

Shipped the entire **Observability & Telemetry** epic (10 commits) plus one **isolated Foundation Fix** for May 30 2026 Supabase compliance. The three background daemons (`sleep_learner`, `curriculum_scanner`, `trajectory_compactor`) now persist every lifecycle event to an append-only `daemon_telemetry` table via a fire-and-forget `emit()` helper. A new `system_dashboard` MCP tool surfaces per-daemon rollups as **compressed Markdown — 4× token compression** vs JSON. `check_system_health` now derives per-daemon status (env-driven thresholds, staleness check, worst-of severity rollup) — the OS is **self-aware of its own health**. A separate Foundation Fix (Task #126) added explicit `service_role` grants + `ALTER DEFAULT PRIVILEGES`, securing the MCP connection against the imminent Supabase implicit-grant removal. Net change: **+711 LOC**, **5 backlog items closed**, **2 deferred** (P3 follow-ups #124/#125), **1 PATTERN memory saved**.

## What changed

| Backlog | DECISION | Outcome |
|---|---|---|
| #119 — Schema + types + emit module | SCM-S23-D1 | `scripts/016_daemon_telemetry.sql` (append-only, RLS, 3 indexes, 4-value event_type CHECK). `src/telemetry/types.ts` 6-variant discriminated union + `src/telemetry/emit.ts` fire-and-forget. Commits `f6d1660` + `c86afb3`. |
| #120 — Instrument 3 daemons | SCM-S23-D2 | Three commits (`bf23925` / `ceded71` / `eebdfd9`), one per daemon, identical run-start/end/error pattern. Curriculum additionally emits `task_outcome` events for orchestrator-side `recordVerified` / `recordRejected` (with conditional `auto_promoted` delta inside `recordVerified(autoPromoted=true)` — no new function invented). ZERO state mutations across all three. |
| #121 — `system_dashboard` MCP tool | SCM-S23-D3 | `src/tools/system_dashboard.ts` + registration in `src/index.ts:577`. Single Supabase query (2000-row cap, composite-index-aligned). Per-daemon rollups: `runs/errors/items_processed` (run_ended) + `outcomes{verified,rejected,auto_promoted}` (task_outcome). Commits `58ad9ed` + `6cd5ed0` (Markdown refinement → 1004 chars output vs multi-KB JSON). |
| #122 — Derived health in `check_system_health` | SCM-S23-D4 | `src/tools/health.ts` extended with `deriveDaemonStatus()` + env-driven thresholds. Disabled short-circuit FIRST. Worst-of severity rollup; daemon derivation can only WORSEN overall. **Decoupled from dashboard** — separate query, separate failure mode. Commit `ead2b85`. |
| #123 — ARCHITECTURE.md §4.8 docs | SCM-S23-D5 | `### 4.8 Observability & Telemetry` inserted at line 545–623, OUTSIDE the auto-regenerated `MEMORY:ARCH:START/END` marker block. 13-node Mermaid flowchart, 4-row event taxonomy, 3-row env-var config table, 6-rule derivation order. Commit `bcd792d`. |
| #126 — Foundation Fix: explicit service_role grants | SCM-S23-D6 | `scripts/017_explicit_service_role_grants.sql` — `GRANT ALL` on existing tables + sequences, `ALTER DEFAULT PRIVILEGES` so future objects inherit. Idempotent. Isolated commit per Imperative 5. Cut-over date **2026-05-30** is now safe. Commit `d562954`. |

## File map

**New artefacts:**

- [`scripts/016_daemon_telemetry.sql`](../../scripts/016_daemon_telemetry.sql) — append-only event log + RLS + 3 indexes
- [`scripts/017_explicit_service_role_grants.sql`](../../scripts/017_explicit_service_role_grants.sql) — Foundation Fix for May 30 Supabase compliance
- [`src/telemetry/types.ts`](../../src/telemetry/types.ts) — 6-variant `MetricEvent` discriminated union, 4-value `EventType`
- [`src/telemetry/emit.ts`](../../src/telemetry/emit.ts) — `Promise<void>` fire-and-forget helper, swallows Supabase + thrown errors
- [`src/tools/system_dashboard.ts`](../../src/tools/system_dashboard.ts) — `systemDashboardHandler` + `renderDashboardMarkdown` (4× compression)
- [`docs/superpowers/plans/2026-05-12-observability-telemetry.md`](../../docs/superpowers/plans/2026-05-12-observability-telemetry.md) — the 8-task implementation plan
- Six smoke scripts (`scripts/test-obs-*-smoke.ts`) — schema reachability, emit fire-and-forget contract, per-daemon instrumentation, dashboard shape + Markdown render, health derivation

**Modified:**

- [`src/sleep/daemon.ts`](../../src/sleep/daemon.ts) — emit import + 3 emit calls + `runSleepLearnerOnce` alias
- [`src/curriculum/daemon.ts`](../../src/curriculum/daemon.ts) — emit import + 6 emit calls (3 tick lifecycle + 3 `task_outcome` deltas) + `runCurriculumScannerOnce` alias
- [`src/trajectory/daemon.ts`](../../src/trajectory/daemon.ts) — emit import + 3 emit calls + `runTrajectoryCompactorOnce` alias
- [`src/tools/health.ts`](../../src/tools/health.ts) — env-driven thresholds + `deriveDaemonStatus` + worst-of rollup
- [`src/index.ts`](../../src/index.ts) — `system_dashboard` tool registration + Markdown rendering
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — §4.8 inserted at L545–623

## Hurdles + solutions

### 1. The `task_outcome` semantic correction (architectural pushback)

Original plan had `recordVerified` / `recordRejected` emitting `event_type: 'run_ended'` with delta payloads. User caught the semantic violation: a "run" is a time-bound daemon background tick; a verification is an orchestrator action. Mixing them poisons daemon run-rate rollups. **Fix:** introduced a fourth `event_type='task_outcome'` value, applied to migration CHECK constraint, types union, all three record* sites in curriculum daemon, dashboard rollup (kept `runs` as run_ended-only), and dashboard's separate `outcomes` rollup block. Refinement landed BEFORE any code was written.

### 2. Magic-number thresholds in health derivation

During plan presentation, I flagged the original Task 7 design's hardcoded `0.20 / 0.50 / ×2` thresholds as a real risk — production daemons under load would page on normal noise. **Fix:** added env vars at plan-edit time. The user specified literal `_DEFAULT`-suffixed names: `OBS_ERR_RATE_DEGRADED_DEFAULT`, `OBS_ERR_RATE_DOWN_DEFAULT`, `OBS_STALENESS_MULTIPLIER_DEFAULT`. The helper uses a never-throwing `envNum` parser; unparseable values fall back to defaults.

### 3. Decoupled monitoring read paths (architectural insight)

When designing Task 7, I caught that pulling `systemDashboardHandler` into `check_system_health` would create a shared point of failure — a slow dashboard rollup would delay every health check. **Fix:** each consumer issues its OWN Supabase query (`system_dashboard` 24h/2000 rows; `check_system_health` 1h/1000 rows). They do not import each other, do not share state, do not share latency budgets. Documented in §4.8 as a deliberate decision.

### 4. The token-efficient Markdown refinement (mid-flight scope evolution)

After Task 6 shipped returning JSON via `JSON.stringify(out, null, 2)`, the user injected a refinement: render the MCP surface as compressed Markdown to honor the [Efficiency — Tokens Are Currency] imperative. **Fix:** added `renderDashboardMarkdown` to the same module — handler stays structured for TS consumers, MCP surface gets the dense table + section format. Measured output: **1004 chars** (vs ~4-5KB pretty-printed JSON for the same data). Commit `6cd5ed0`.

### 5. May 30 Supabase compliance — pause-and-fix (Foundation First)

Mid-OBS-EPIC, the user surfaced an upcoming Supabase platform change: implicit `service_role` permissions on default-schema objects are being removed on 2026-05-30. Per Imperative 5 (Foundation First — No Broken Windows), we paused the Observability epic between Task 5 and Task 6 to ship the fix as an **isolated single-file commit** (`d562954`). `ALTER DEFAULT PRIVILEGES` was the forward-looking architectural win — all future migrations inherit the grants automatically, no per-migration boilerplate needed.

### 6. `recordAutoPromoted` ≠ separate function

Recon predicted `recordAutoPromoted` as a distinct export. Task 5 worker discovered it doesn't exist as such — auto-promotion is **folded into `recordVerified(autoPromoted: boolean)` via a flag**. Worker correctly emitted the `auto_promoted: 1` delta conditionally inside `recordVerified` rather than inventing a new function. Honors the "ZERO new functions" Surgical Editing imperative while still capturing the signal.

### 7. Compactor token aggregation deferred (Option 1 scope discipline)

Task 3 worker found `source_tokens / summary_tokens / compression_ratio` exist in `CompactOneResult` per-chunk but are never aggregated into module-level state. Including them would have required extending state — violating the "ZERO state mutations" hard constraint. Deferred to backlog **#125** for a separate, properly-scoped commit that mixes state design + telemetry wiring deliberately, not accidentally.

## End-state snapshot

- **Backlog:** #119, #120, #121, #122, #123, #126 done. Deferred: **#124** (telemetry retention rolling window) and **#125** (compactor token aggregation), both P3.
- **System health:** healthy (Supabase reachable, 7539+ rows; Ollama reachable; 255 frozen patterns active).
- **Core 3:** in sync. CLAUDE.md untouched, README.md regenerated by session_end, ARCHITECTURE.md +80 lines for §4.8 (outside marker block).
- **`npm run build`:** green throughout (lint:boundaries 4-file scope, tsc clean, refactor_guard gate exit 0 on every task).
- **Live telemetry:** daemon_telemetry has ~50 rows from smoke runs this session — 18 trajectory_compactor `run_ended` events, 3 sleep_learner, 1 curriculum_scanner + 1 `task_outcome{verified:1}` proving the fire-and-forget + readback contract end-to-end.
- **Memory saved:** PATTERN #11542 (`currentProjectId` + supabase singleton convention) — first time any new tool dev in this repo needs the resolver, they'll find it instead of re-discovering.
- **Migrations:** 001–017 all applied, all idempotent. Service_role access future-proof.
- **Boundary Invariant #1:** preserved — `src/sleep/**` and `src/curriculum/**` import only `../telemetry/emit.js` (local relative); the lint:boundaries fence still passes.

## Next session

Two natural directions:

1. **Drain deferred OBS follow-ups** (#124 retention, #125 compactor token aggregation) — small, well-scoped, finishes the epic's last loose threads.
2. **Pick the next epic** — packaging the MCP server as a Claude Code marketplace plugin, GLOBAL Vault UX tooling, or something else strategic.

Recommendation: drain #124 first (retention is a genuine correctness concern — append-only growth needs a cap before it bites), then evaluate epic options. The OS is now observable; the next move is hardening it for distribution OR widening its reach.
