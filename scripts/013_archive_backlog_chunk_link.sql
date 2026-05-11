-- 013_archive_backlog_chunk_link.sql
-- Session 19 / SCM-S19-D2 — M3 Sleep Learning provenance link.
--
-- M3 mines `trajectory_summaries` INNER JOIN `archive_backlog WHERE status='done'`
-- via a shared `chunk_id`. Without this column the miner's per-task provenance
-- cannot resolve (`source_backlog_ids` stays empty by construction), so M3
-- mining returns 0 candidates regardless of activity.
--
-- Additive, nullable, FK SET NULL — safe on the existing 7523-row corpus.

ALTER TABLE archive_backlog
  ADD COLUMN IF NOT EXISTS chunk_id bigint NULL
  REFERENCES memory_chunks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS archive_backlog_chunk_id_idx
  ON archive_backlog (chunk_id)
  WHERE chunk_id IS NOT NULL;

COMMENT ON COLUMN archive_backlog.chunk_id IS
  'M3 provenance link: the memory_chunks row that originated this archived task. '
  'NULL for legacy rows pre-013; populated by future wrap-up rituals so '
  'sleep-learning mining can join archive successes back to trajectory_summaries.';
