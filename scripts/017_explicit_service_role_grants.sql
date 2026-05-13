-- Migration 017: Explicit service_role grants — May 30 2026 Supabase compliance.
--
-- Context: Supabase is removing implicit service_role permissions on default
-- public-schema objects (see github.com/orgs/supabase/discussions/45329). Any
-- table or sequence created without explicit grants will become unreachable
-- from the MCP server's service-role connection after the cut-over date.
--
-- This migration is a Foundation Fix per CLAUDE.md Imperative 5 (Foundation
-- First — No Broken Windows). It is intentionally isolated from feature work.
--
-- What it does:
--   1. GRANT ALL on every existing table and sequence in `public` to service_role.
--   2. ALTER DEFAULT PRIVILEGES so future tables and sequences inherit the grants
--      automatically — no per-migration boilerplate needed going forward.
--
-- Idempotency: GRANT ALL and ALTER DEFAULT PRIVILEGES are both safe to re-run.
-- Existing grants are not modified; new ones are added. Re-applying produces no
-- warnings and no behavior change.

grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
