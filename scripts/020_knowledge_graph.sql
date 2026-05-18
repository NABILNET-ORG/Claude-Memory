-- 020_knowledge_graph.sql
-- M8 Phase 3 — Hybrid RAG Knowledge Graph
--
-- Adds the kg_nodes / kg_edges relations + idempotent upsert RPCs + a
-- vector-first hybrid search RPC that does:
--   1. ANN nearest-K over kg_nodes.embedding (vector retrieval).
--   2. 1-hop neighbour expansion through kg_edges (graph retrieval).
--   3. Returns a single jsonb { seeds, neighbours } payload — the consumer
--      blends scores client-side so re-ranking strategy stays in TS.
--
-- Conventions match prior migrations (002, 010, 011, 012, 014–017):
--   * project_id text NOT NULL tenancy; 'GLOBAL' reserved for cross-project facts.
--   * extensions.vector(768) — pgvector lives in the extensions schema since
--     007/010. vector_cosine_ops is qualified the same way for HNSW indexes.
--   * service_role bypasses RLS; anon + authenticated are denied unconditionally
--     (same posture as memory_chunks via 006_security_hardening.sql).
--
-- Idempotency guards: every CREATE uses IF NOT EXISTS, indexes drop+recreate
-- on conflict, RPCs use CREATE OR REPLACE. Re-running this migration is safe.

-- ============ 1. kg_nodes relation ============

create table if not exists public.kg_nodes (
  id              bigserial primary key,
  project_id      text   not null,
  type            text   not null,
  label           text   not null,
  properties      jsonb  not null default '{}'::jsonb,
  embedding       extensions.vector(768),
  source_chunk_id bigint references public.memory_chunks(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id, type, label)
);

comment on table public.kg_nodes is
  'M8 Knowledge Graph nodes — typed entities with optional vector embedding '
  'for hybrid RAG. (project_id, type, label) is the natural key. Nullable '
  'embedding lets the graph store both semantic (vector-indexed) and pure '
  'symbolic nodes (e.g., file paths, IDs).';

comment on column public.kg_nodes.source_chunk_id is
  'Optional provenance pointer back to the memory_chunks row this node was '
  'derived from. SET NULL on delete so the graph is durable across chunk '
  'churn (re-sync, re-embed, prune).';

create index if not exists kg_nodes_project_type_idx
  on public.kg_nodes (project_id, type);

create index if not exists kg_nodes_properties_idx
  on public.kg_nodes using gin (properties jsonb_path_ops);

create index if not exists kg_nodes_embedding_idx
  on public.kg_nodes using hnsw (embedding extensions.vector_cosine_ops);

-- ============ 2. kg_edges relation ============

create table if not exists public.kg_edges (
  id          bigserial primary key,
  project_id  text   not null,
  source_id   bigint not null references public.kg_nodes(id) on delete cascade,
  target_id   bigint not null references public.kg_nodes(id) on delete cascade,
  relation    text   not null,
  weight      double precision not null default 1.0,
  properties  jsonb  not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  check (source_id <> target_id),
  unique (project_id, source_id, target_id, relation)
);

comment on table public.kg_edges is
  'M8 Knowledge Graph edges — directed labelled relationships between nodes. '
  'CASCADE on both endpoints so deleting a node cleans up dangling edges in '
  'one statement. UNIQUE (project_id, source_id, target_id, relation) makes '
  'kg_upsert_edge truly idempotent.';

create index if not exists kg_edges_source_idx
  on public.kg_edges (source_id, relation);

create index if not exists kg_edges_target_idx
  on public.kg_edges (target_id, relation);

create index if not exists kg_edges_project_relation_idx
  on public.kg_edges (project_id, relation);

create index if not exists kg_edges_properties_idx
  on public.kg_edges using gin (properties jsonb_path_ops);

-- ============ 3. Row-Level Security ============

alter table public.kg_nodes enable row level security;
drop policy if exists deny_anon_authenticated on public.kg_nodes;
create policy deny_anon_authenticated on public.kg_nodes
  for all to anon, authenticated using (false) with check (false);

alter table public.kg_edges enable row level security;
drop policy if exists deny_anon_authenticated on public.kg_edges;
create policy deny_anon_authenticated on public.kg_edges
  for all to anon, authenticated using (false) with check (false);

-- ============ 4. updated_at touch trigger ============

create or replace function public.kg_nodes_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists kg_nodes_touch_updated_at on public.kg_nodes;
create trigger kg_nodes_touch_updated_at
  before update on public.kg_nodes
  for each row execute function public.kg_nodes_touch_updated_at();

-- ============ 5. RPC: kg_upsert_node ============

create or replace function public.kg_upsert_node(
  p_project_id      text,
  p_type            text,
  p_label           text,
  p_properties      jsonb default '{}'::jsonb,
  p_embedding       extensions.vector(768) default null,
  p_source_chunk_id bigint default null
) returns bigint
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  r_id bigint;
begin
  insert into public.kg_nodes (
    project_id, type, label, properties, embedding, source_chunk_id
  ) values (
    p_project_id, p_type, p_label, p_properties, p_embedding, p_source_chunk_id
  )
  on conflict (project_id, type, label) do update
    set properties      = excluded.properties,
        embedding       = coalesce(excluded.embedding, public.kg_nodes.embedding),
        source_chunk_id = coalesce(excluded.source_chunk_id, public.kg_nodes.source_chunk_id),
        updated_at      = now()
  returning id into r_id;
  return r_id;
end;
$$;

comment on function public.kg_upsert_node(
  text, text, text, jsonb, extensions.vector, bigint
) is
  'Idempotent node insert keyed by (project_id, type, label). On conflict, '
  'embedding and source_chunk_id are only overwritten when the caller passes '
  'non-null values — protects existing semantic anchors from being clobbered '
  'by a later non-embedded re-import.';

-- ============ 6. RPC: kg_upsert_edge ============

create or replace function public.kg_upsert_edge(
  p_project_id text,
  p_source_id  bigint,
  p_target_id  bigint,
  p_relation   text,
  p_weight     double precision default 1.0,
  p_properties jsonb default '{}'::jsonb
) returns bigint
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  r_id bigint;
begin
  if p_source_id = p_target_id then
    raise exception 'kg_upsert_edge: source_id and target_id must differ';
  end if;

  insert into public.kg_edges (
    project_id, source_id, target_id, relation, weight, properties
  ) values (
    p_project_id, p_source_id, p_target_id, p_relation, p_weight, p_properties
  )
  on conflict (project_id, source_id, target_id, relation) do update
    set weight     = excluded.weight,
        properties = excluded.properties
  returning id into r_id;
  return r_id;
end;
$$;

comment on function public.kg_upsert_edge(
  text, bigint, bigint, text, double precision, jsonb
) is
  'Idempotent edge insert keyed by (project_id, source_id, target_id, relation). '
  'Edges are directed; the consumer creates a second row for the reverse '
  'direction if needed.';

-- ============ 7. RPC: kg_hybrid_search ============

create or replace function public.kg_hybrid_search(
  p_project_id      text,
  p_query_embedding extensions.vector(768),
  p_seed_limit      int default 5,
  p_neighbor_hops   int default 1,
  p_min_similarity  double precision default 0.0
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_seeds     jsonb;
  v_neighbors jsonb;
begin
  -- Phase 1: vector-ranked seeds inside the project.
  select coalesce(jsonb_agg(t), '[]'::jsonb)
    into v_seeds
    from (
      select
        n.id,
        n.type,
        n.label,
        n.properties,
        n.source_chunk_id,
        (1 - (n.embedding <=> p_query_embedding))::double precision as similarity
      from public.kg_nodes n
      where n.project_id = p_project_id
        and n.embedding is not null
        and (1 - (n.embedding <=> p_query_embedding)) >= p_min_similarity
      order by n.embedding <=> p_query_embedding
      limit greatest(p_seed_limit, 1)
    ) t;

  if p_neighbor_hops < 1 or jsonb_array_length(v_seeds) = 0 then
    return jsonb_build_object('seeds', v_seeds, 'neighbors', '[]'::jsonb);
  end if;

  -- Phase 2: 1-hop neighbours from seed ids (in or out edges).
  with seed_ids as (
    select (s ->> 'id')::bigint as id
      from jsonb_array_elements(v_seeds) s
  ),
  hops as (
    select
      n2.id,
      n2.type,
      n2.label,
      n2.properties,
      e.relation,
      e.weight,
      case
        when e.source_id = si.id then 'outgoing'
        else 'incoming'
      end as direction,
      si.id as via_node_id
    from seed_ids si
    join public.kg_edges e
      on e.project_id = p_project_id
     and (e.source_id = si.id or e.target_id = si.id)
    join public.kg_nodes n2
      on n2.id = case when e.source_id = si.id then e.target_id else e.source_id end
     and n2.project_id = p_project_id
  )
  select coalesce(jsonb_agg(h), '[]'::jsonb)
    into v_neighbors
    from hops h;

  return jsonb_build_object('seeds', v_seeds, 'neighbors', v_neighbors);
end;
$$;

comment on function public.kg_hybrid_search(
  text, extensions.vector, int, int, double precision
) is
  'M8 hybrid RAG retrieval: ANN seeds → 1-hop neighbour expansion. Returns '
  'jsonb { seeds: [...], neighbors: [...] }. The consumer blends similarity '
  '(seeds) and edge weight (neighbors) when re-ranking — kept in TS so the '
  'ranking strategy can evolve without a migration.';
