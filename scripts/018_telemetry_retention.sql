-- Migration 018: telemetry retention — extend daemon_telemetry CHECK
-- constraint to admit the 4th daemon `telemetry_pruner`, which performs
-- rolling DELETE of rows older than TELEMETRY_PRUNER_RETENTION_DAYS.
-- See docs/superpowers/specs/2026-05-13-telemetry-retention-design.md
-- and ARCHITECTURE.md §4.8 for the rationale (Foundation-First, isolated).

-- Idempotent re-apply: drop the auto-named column CHECK (Postgres names
-- column-level CHECKs '<table>_<col>_check' by default) and recreate as a
-- named table-level constraint so future extensions are explicit.
do $$
begin
  if exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'daemon_telemetry'
       and c.conname = 'daemon_telemetry_daemon_check'
  ) then
    alter table public.daemon_telemetry drop constraint daemon_telemetry_daemon_check;
  end if;
  if exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'daemon_telemetry'
       and c.conname = 'daemon_telemetry_daemon_allowed'
  ) then
    alter table public.daemon_telemetry drop constraint daemon_telemetry_daemon_allowed;
  end if;
end$$;

alter table public.daemon_telemetry
  add constraint daemon_telemetry_daemon_allowed
  check (daemon in (
    'sleep_learner',
    'curriculum_scanner',
    'trajectory_compactor',
    'telemetry_pruner'
  ));
