-- Migration 017: M7 Skill Graduation to GLOBAL.
--
-- Agentic OS 2026 / Mission 7 / SCM-S33-D1 (premise-correction + reframe from
-- the originally-requested "M6 Trajectory Distillation" — see SCM-S33-D1).
-- Implements the staging table that audits production-validated local
-- agent_skills and the atomic SQL RPC that clones an approved skill into the
-- GLOBAL vault.
--
-- Phase A scope (this migration):
--   * skill_graduations table   — staging rows, one per proposal.
--   * apply_graduation RPC      — atomic clone-to-GLOBAL + state flip.
--   * RLS deny_anon_authenticated (mirror 006/010/011/012/014/015/016).
--   * Grants: service_role only.
--
-- Design rules honored:
--   * NEVER edit prior migrations — this file is additive only.
--   * Idempotent: every CREATE uses IF NOT EXISTS or DROP IF EXISTS first.
--   * Single-Brain Boundary: zero LLM in src/graduation/** (Boundary Invariant
--     #1, enforced by scripts/lint-boundaries.ts in Task 4 of the plan).
--   * NO auto-promotion: the only path to is_global=true is via
--     apply_graduation RPC, which is only callable from the confirm_promotion
--     MCP handler (Phase A) — and confirm_promotion is human-driven.
--   * Atomic clone: INSERT into agent_skills (GLOBAL) + UPDATE skill_graduations
--     share ONE transaction → all three timestamps (graduation.decided_at,
--     new_skill.created_at, RPC return decided_at) collapse to one microsecond
--     because PostgreSQL now() returns transaction-start time. This is the
--     load-bearing C4 atomic-tx proof characterization from the plan.

-- ============ 1. skill_graduations relation ============

create table if not exists public.skill_graduations (
  id                          bigserial primary key,
  project_id                  text   not null,
  source_skill_id             bigint not null
                              references public.agent_skills(id) on delete cascade,
  state                       text   not null default 'proposed'
                              check (state in ('proposed','composed','approved','rejected')),
  -- Telemetry snapshot at propose-time (frozen; never bumped on re-scan).
  frequency_at_propose        int    not null check (frequency_at_propose >= 0),
  success_rate_at_propose     real   not null
                              check (success_rate_at_propose >= 0
                                     and success_rate_at_propose <= 1),
  age_days_at_propose         int    not null check (age_days_at_propose >= 0),
  -- Compose output (NULL until compose handler writes).
  proposed_global_rationale   text   null,
  cross_project_verdict       text   null
                              check (cross_project_verdict is null
                                     or cross_project_verdict in ('pass','fail')),
  cross_project_evidence      text   null,
  model                       text   null,
  composed_at                 timestamptz null,
  -- Decision output (NULL until confirm/reject handler writes).
  promoted_global_skill_id    bigint null
                              references public.agent_skills(id) on delete set null,
  rejection_reason            text   null,
  decided_at                  timestamptz null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table public.skill_graduations is
  'M7 Skill Graduation staging (Agentic OS 2026 / SCM-S33-D1). One row per '
  'proposal to promote a local agent_skill to the GLOBAL vault. Lifecycle: '
  'proposed → composed (LLM rationale draft) → approved (apply_graduation RPC '
  'clones to GLOBAL) | rejected (TS-only UPDATE). The agent does NOT '
  'auto-promote — every is_global=true write goes through human-driven '
  'confirm_promotion → apply_graduation RPC.';

comment on column public.skill_graduations.source_skill_id is
  'FK to the local agent_skill being evaluated. ON DELETE CASCADE so '
  'cleanupProject(pid) on test runs clears graduation rows automatically '
  'when the source skill goes away.';

comment on column public.skill_graduations.promoted_global_skill_id is
  'FK to the NEW GLOBAL agent_skill row minted by apply_graduation. NULL '
  'until state=approved. ON DELETE SET NULL so removing the GLOBAL clone '
  'leaves an audit trail in skill_graduations.';

comment on column public.skill_graduations.proposed_global_rationale is
  'LLM-drafted justification for Sovereign Vetting Rule 10. The RPC '
  'apply_graduation refuses promotion when this is NULL or shorter than '
  '10 chars — defense in depth against half-composed rows reaching GLOBAL.';

-- ============ 2. Indexes ============

-- Idempotent enqueue: one active proposal per (project, source skill).
-- 'rejected'/'approved' rows are intentionally NOT covered — a rejected skill
-- can be re-proposed later (e.g., after its frequency_used doubles), and an
-- approved skill could in principle be re-proposed for a later version.
create unique index if not exists skill_graduations_active_uniq
  on public.skill_graduations (project_id, source_skill_id)
  where state in ('proposed','composed');

-- State-window scans (the scanner picks 'proposed', the UI lists 'composed',
-- audit reads 'approved'/'rejected').
create index if not exists skill_graduations_state_created_idx
  on public.skill_graduations (state, created_at desc);

-- Reverse-lookup: "what's the graduation history of skill X?"
create index if not exists skill_graduations_source_skill_idx
  on public.skill_graduations (source_skill_id);

-- ============ 3. Row-Level Security ============
-- Same posture as 006, 010, 011, 012, 014, 015, 016: service_role bypasses;
-- anon and authenticated are denied unconditionally.

alter table public.skill_graduations enable row level security;

drop policy if exists deny_anon_authenticated on public.skill_graduations;
create policy deny_anon_authenticated on public.skill_graduations
  for all to anon, authenticated using (false) with check (false);

-- ============ 4. RPC: apply_graduation ============
-- The atomic clone-to-GLOBAL. Three writes in ONE transaction:
--   (a) INSERT a clone row into agent_skills with project_id='GLOBAL'.
--   (b) UPDATE the graduation row: state='approved', promoted_global_skill_id,
--       decided_at=now().
-- All preconditions are checked inside the transaction with FOR UPDATE on the
-- graduation row to prevent races between two concurrent confirm calls.
--
-- Result shape (jsonb, polymorphic):
--   { ok:true,  graduation_id, promoted_global_skill_id, decided_at }
--   { ok:false, reason }

drop function if exists public.apply_graduation(bigint);

create or replace function public.apply_graduation(
  p_graduation_id bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_grad         public.skill_graduations%rowtype;
  v_src          public.agent_skills%rowtype;
  v_new_skill_id bigint;
  v_decided_at   timestamptz;
begin
  if p_graduation_id is null then
    return jsonb_build_object('ok', false, 'reason', 'graduation_id required');
  end if;

  -- 1. Lock the graduation row. SELECT FOR UPDATE prevents two concurrent
  -- confirm_promotion calls from racing on the same graduation.
  select * into v_grad
    from public.skill_graduations
   where id = p_graduation_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'graduation_not_found');
  end if;

  -- 2. State precondition: must be 'composed' (compose handler ran).
  if v_grad.state <> 'composed' then
    return jsonb_build_object(
      'ok', false,
      'reason', format('graduation state must be composed, got %s', v_grad.state)
    );
  end if;

  -- 3. Rationale precondition: Sovereign Vetting Rule 10 fence. Defense in
  -- depth — the compose handler also validates, but we re-check here so the
  -- RPC is safe to call from any future surface.
  if v_grad.proposed_global_rationale is null
     or length(btrim(v_grad.proposed_global_rationale)) < 10 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'proposed_global_rationale missing or under 10 chars (Sovereign Vetting Rule 10)'
    );
  end if;

  -- 4. Load + guard source skill. Two ways the source could fail:
  --   (a) deleted between compose and confirm (race with skill cleanup).
  --   (b) source already at project_id='GLOBAL' (shouldn't happen if the
  --       scanner did its job, but the RPC is the last line of defense).
  select * into v_src
    from public.agent_skills
   where id = v_grad.source_skill_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'source_skill_deleted');
  end if;

  if v_src.project_id = 'GLOBAL' then
    return jsonb_build_object('ok', false, 'reason', 'source_skill_already_global');
  end if;

  -- 5. Atomic clone. The new GLOBAL row carries:
  --   * name / description / steps / trigger_keywords / embedding copied verbatim.
  --   * project_id='GLOBAL'.
  --   * Telemetry reset (version=1, frequency_used=0, success_rate=1.0,
  --     last_invoked_at=NULL). The GLOBAL row starts fresh — its telemetry
  --     accrues independently from the local row's history.
  --   * packaged_from_archive_id copied for provenance.
  insert into public.agent_skills (
    project_id, name, version, description, steps, trigger_keywords,
    embedding, frequency_used, success_rate, last_invoked_at,
    packaged_from_archive_id
  ) values (
    'GLOBAL',
    v_src.name,
    1,
    v_src.description,
    v_src.steps,
    v_src.trigger_keywords,
    v_src.embedding,
    0,
    1.0,
    null,
    v_src.packaged_from_archive_id
  )
  returning id, created_at into v_new_skill_id, v_decided_at;

  -- 6. Update graduation row IN THE SAME TX. The decided_at timestamp here
  -- MUST equal the new agent_skill's created_at because PostgreSQL now()
  -- returns the transaction-start time — this is the C4 atomic-tx proof
  -- characterization that the test suite locks in.
  update public.skill_graduations
     set state                    = 'approved',
         promoted_global_skill_id = v_new_skill_id,
         decided_at               = v_decided_at,
         updated_at               = v_decided_at
   where id = p_graduation_id;

  return jsonb_build_object(
    'ok',                       true,
    'graduation_id',            p_graduation_id,
    'promoted_global_skill_id', v_new_skill_id,
    'decided_at',               v_decided_at
  );
end;
$$;

comment on function public.apply_graduation(bigint) is
  'M7 atomic clone-to-GLOBAL. Validates state=composed AND '
  'proposed_global_rationale present + >=10 chars (Sovereign Vetting Rule 10) '
  'AND source skill not already GLOBAL. On pass: clones source agent_skill '
  'into agent_skills with project_id=GLOBAL, flips graduation to approved. '
  'All writes share one transaction so decided_at = new_skill.created_at '
  'to the microsecond (C4 atomic-tx proof). Returns jsonb '
  '{ok, [reason | graduation_id+promoted_global_skill_id+decided_at]}.';

-- ============ 5. Trigger: keep updated_at honest ============
-- The Postgres-canonical pattern. Mirrors what other M-series migrations
-- assume but make implicit (most other M-tables rely on hand-rolled UPDATE
-- statements to bump updated_at). For skill_graduations we have multiple
-- write paths (compose, reject TS-only UPDATE, apply_graduation RPC), so a
-- BEFORE UPDATE trigger is the simplest belt-and-braces invariant.

drop function if exists public.skill_graduations_touch_updated_at();

create or replace function public.skill_graduations_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  -- apply_graduation already sets updated_at=v_decided_at explicitly to keep
  -- the atomic-tx invariant. Respect that: only auto-bump when NEW.updated_at
  -- equals OLD.updated_at (i.e., caller didn't set it).
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists skill_graduations_touch_updated_at on public.skill_graduations;
create trigger skill_graduations_touch_updated_at
  before update on public.skill_graduations
  for each row execute function public.skill_graduations_touch_updated_at();

-- ============ 6. Grants ============
-- service_role only — same posture as 006/010/011/012/014/015/016.

revoke all on function public.apply_graduation(bigint) from public;
grant execute on function public.apply_graduation(bigint) to service_role;

grant select, insert, update, delete on public.skill_graduations to service_role;
grant usage, select on sequence public.skill_graduations_id_seq to service_role;
