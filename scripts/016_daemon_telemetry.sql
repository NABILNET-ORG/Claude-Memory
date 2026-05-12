-- Migration 016: daemon_telemetry — append-only event log for background daemons.
-- One row per daemon tick: 'run_started' (no payload counters yet), 'run_ended' (with counters + duration_ms),
-- 'run_errored' (with error_message + duration_ms). Orchestrator state mutations
-- (curriculum verify/reject/auto-promote) emit 'task_outcome' events with delta payloads.
-- Read via the system_dashboard MCP tool.

create table if not exists public.daemon_telemetry (
  id              bigserial primary key,
  project_id      text        not null,
  daemon          text        not null check (daemon in ('sleep_learner','curriculum_scanner','trajectory_compactor')),
  event_type      text        not null check (event_type in ('run_started','run_ended','run_errored','task_outcome')),
  payload         jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists daemon_telemetry_project_daemon_created_idx
  on public.daemon_telemetry (project_id, daemon, created_at desc);

create index if not exists daemon_telemetry_daemon_created_idx
  on public.daemon_telemetry (daemon, created_at desc);

create index if not exists daemon_telemetry_payload_gin
  on public.daemon_telemetry using gin (payload jsonb_path_ops);

alter table public.daemon_telemetry enable row level security;

drop policy if exists deny_anon_authenticated_daemon_telemetry on public.daemon_telemetry;
create policy deny_anon_authenticated_daemon_telemetry
  on public.daemon_telemetry
  for all
  to anon, authenticated
  using (false)
  with check (false);

grant select, insert on public.daemon_telemetry to service_role;
grant usage, select on sequence public.daemon_telemetry_id_seq to service_role;
