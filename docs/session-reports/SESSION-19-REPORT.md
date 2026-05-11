# Session 19 — M3 Sleep Learning (Idle Daemon) Deployed

**Date.** 2026-05-11
**Mission.** Agentic OS 2026 Mission 3 (backlog #113, P3). Background daemon that mines successful task patterns from `archive_backlog` ⨝ `trajectory_summaries` and proposes them as `skill_candidates` for curated promotion into M1's `agent_skills` vault.
**Status.** Shipped + verified end-to-end. Migration applied, daemon wired, smoke 11/11 GREEN. M4 (Transactional Workflows) is the next backlog item.

---

## 1. What changed

### 1.1 Sovereign Decisions
- **SCM-S19-D1** (memory id 11512) — storage decision: a dedicated `skill_candidates` table, not a `state` column on `agent_skills`. Recall purity for the M1 retrieval surface drove the split — candidates are unpromoted, high-churn mining state with provenance arrays; the retrieval table only ever sees curated, promoted skills.
- **SCM-S19-D2** (memory id 11526) — provenance link: `archive_backlog.chunk_id bigint NULL REFERENCES memory_chunks(id) ON DELETE SET NULL`. Surfaced by smoke-012's first run; the original M3 proposal silently assumed this column existed. Without it the miner's INNER JOIN is unsatisfiable and mining returns zero regardless of activity.

### 1.2 Files created
- `scripts/012_sleep_learning.sql` — `skill_candidates` table, three RPCs (`match_skill_candidates`, `upsert_skill_candidate`, `promote_candidate_to_skill`), HNSW(cosine) on `candidate_embedding`, UNIQUE(`project_id`, `pattern_hash`), btree on (`state`, `frequency DESC`), `deny_anon_authenticated` RLS, RPCs `SECURITY DEFINER` with `search_path` including `'extensions'` (ERROR-11507 lesson preserved).
- `scripts/013_archive_backlog_chunk_link.sql` — additive nullable FK + partial btree index.
- `src/sleep/miner.ts` — pure clusterer (INNER JOIN trajectory_summaries × archive_backlog `status='done'`, cosine ≥ 0.85, 3-gram trigram hash, mean-vector centroid).
- `src/sleep/proposer.ts` — Ollama `gemma4:e2b` JSON-mode skill name + steps proposer; defensive parse + preamble strip mirroring `src/trajectory/summarizer.ts`.
- `src/sleep/daemon.ts` — `setInterval(...).unref()`, module-level re-entrancy guard, per-cluster try/catch. Env knobs: `SLEEP_LEARNER_INTERVAL_MS=3600000`, `SLEEP_LEARNER_BATCH=10`, `SLEEP_LEARNER_MIN_FREQ=3`, `SLEEP_LEARNER_AUTO_PROMOTE=false`.
- `src/tools/sleep.ts` — `listSkillCandidates`, `promoteSkillCandidate` (wraps `package_skill`), `rejectSkillCandidate` (soft-reject, audit-preserving).
- `scripts/smoke-012.ts` — assertion-style end-to-end: seed → mine → assert candidate → promote → assert agent_skills row + state transition → idempotency re-run → reject.

### 1.3 Files modified
- `src/index.ts` — 3 new tools registered alongside M1/M2; `startSleepLearner()` called next to `startKeepAlive()` / `startCompactor()`.
- `src/tools/health.ts` — new `sleep_learner` block on `check_system_health`, mirroring `trajectory_compactor` shape.
- `ARCHITECTURE.md` — §4.6 inserted (Goal, storage-decision rationale, schema table, tool surface, daemon shape, env knobs, health block, two Mermaid diagrams for write+read paths, curator invariant, forward links to M4/M5). §4.5's M3 forward-link bullet reconciled to remove the now-incorrect "calls package_skill autonomously" overstatement.

---

## 2. Hurdles + solutions

| Hurdle | Root cause | Fix |
|---|---|---|
| Worker A returned mid-task (only SQL migration created) | Likely tool-budget/return condition. | Re-spawned Worker B with explicit reference paths (no exploration phase). |
| Worker B returned mid-task again (TS files done, wiring missing) | Same. | Spawned a tighter Worker C scoped to just `src/index.ts` + `src/tools/health.ts` + the gate. |
| Worker C reported `TS2352` on `src/tools/sleep.ts:91` from Supabase `GenericStringError[]` cast | Pre-existing in Worker B's output; outside Worker C's allowed-edit set. | Surgical Orchestrator-direct Edit: `(data ?? []) as SkillCandidateRow[]` → `as unknown as SkillCandidateRow[]`. Gate flipped to GREEN. |
| Smoke seed failed: `memory_chunks.embedding` NOT NULL | Smoke didn't supply embedding. | Hoisted the `embed([SHARED_PHRASE])` call to top of `seed()`; used the result for both `memory_chunks` and `trajectory_summaries`; fallback to `Array(768).fill(0.001)` when embed unavailable. |
| Smoke seed failed: `archive_backlog.chunk_id` column not found, then `priority`/`created_at`/`updated_at` NOT NULL with no defaults | Schema mismatch with M3 proposal's assumptions. | Stripped `chunk_id` from seed temporarily, added `priority: 3`, `created_at: nowIso`, `updated_at: nowIso`. |
| Smoke seed failed: `archive_backlog_status_check` rejected `'success'` | Enum is `{todo, in_progress, blocked, done}` — not `{success, ...}`. | Changed `src/sleep/miner.ts:132` filter to `.eq("status", "done")`; smoke seeds also flipped to `'done'`. |
| Mining returned 0 candidates despite valid seed | Miner does INNER JOIN on `archive_backlog.chunk_id` ↔ `memory_chunks.id` ↔ `trajectory_summaries.source_chunk_id`. Without `chunk_id` on archive_backlog the JOIN is unsatisfiable. | **SCM-S19-D2**: migration 013 adds `archive_backlog.chunk_id` (nullable FK to memory_chunks). Re-seeded with `chunk_id: chunkIds[N]`; smoke went 11/11 GREEN. |

---

## 3. Verification trail

```
npx tsc --noEmit              GREEN  (1912 ms → 2122 ms after 013)
npm run build                 GREEN  (dist/ emitted twice — pre- and post-013)
npx tsx apply-schema 012      OK     (skill_candidates + 3 RPCs live)
npx tsx apply-schema 013      OK     (archive_backlog.chunk_id + partial index live)
npx tsx scripts/smoke-012.ts  11/11  PASS in 9.07 s
  A1–A4 mining writes one candidate with frequency=2, state='mined'
  B1–B4 promotion creates agent_skills row, links promoted_skill_id, flips state='promoted'
  C1–C2 idempotency: re-running mining adds 0 (UNIQUE on project_id, pattern_hash)
  D1    rejectSkillCandidate transitions state='rejected' + persists reason
```

The proposer (`gemma4:e2b`) actually generated a coherent name during smoke: `"auto-create-a-git-commit-using-a-heredoc-message"`, derived from the shared seed phrase. The proposer chain is therefore live, not stubbed.

---

## 4. Curator invariant (do not regress)

`SLEEP_LEARNER_AUTO_PROMOTE=false` by default. The daemon mines and proposes; promotion to the M1 `agent_skills` retrieval surface is always a curated event (`promote_skill_candidate`). M5 (Autonomous Curriculum) is the only mission permitted to flip this. Three tools (`list_skill_candidates`, `promote_skill_candidate`, `reject_skill_candidate`) form the curation surface for operators.

---

## 5. Open items / next session

1. **chunk_id backfill in session-end ritual.** Future `manage_backlog action:session_end` runs should record `chunk_id` on newly-archived rows so the M3 daemon has provenance for them. Not done in S19. Add to M4 scope.
2. **§4.6 Mermaid diagrams say "success-archive"; SQL filters on `done`.** Semantic identical, label drift. Reconcile if it confuses future readers — non-blocking.
3. **GLOBAL pattern candidacy.** "Offline pattern-mining over compressed trajectories + success-archive, with a dedicated `*_candidates` staging table and human-curated promotion to the clean retrieval surface" passes the Cross-Project Test. Propose Sovereign Vetting in S20 after the daemon has run idly for at least one full interval (1 h) and produced real candidates against the live corpus.
4. **Daemon-tick observability.** `check_system_health.sleep_learner` exposes counters but there is no aggregate dashboard. Could be added in M5 alongside autonomy gating.

Next backlog item: **M4 — Transactional Workflows** (id 114, P3). Auto-rollback checkpoints for multi-step agent tasks — no restart-from-scratch on failure.
