import { embed } from "../ollama.js";
import {
  supabase,
  searchChunks,
  listBacklog,
  listArchive,
  type BacklogRow,
  type ArchiveRow,
} from "../supabase.js";
import { currentProjectId } from "../project.js";

/** Pure-number queries (e.g. "11468") -> direct SQL fetch by id. Bypasses
 *  vector ranking, which can fail to surface a known row when its embedding
 *  is squeezed out of top-K by stronger lexical neighbors in a 7k+ row set.
 *  Dual-scope is enforced at the app layer: project_id IN (current, GLOBAL?). */
const ID_PATTERN = /^\s*(\d{1,12})\s*$/;

/** Sovereign Decision-ID handles like SCM-S15-D1 or SCM-S15-D1-GLOBAL.
 *  Routed through metadata.context_id @> match (no vector embedding). */
const CONTEXT_ID_PATTERN = /^\s*(SCM-S\d+-D\d+(?:-GLOBAL)?)\s*$/i;

/** Narrow patterns for queries that unambiguously ask for the ARCHIVE. */
const ARCHIVE_PATTERNS: RegExp[] = [
  /\barchive[sd]?\b/i,
  /\bcompleted\s+tasks?\b/i,
  /\bdone\s+tasks?\b/i,
  /\bfinished\s+tasks?\b/i,
  /\bpast\s+tasks?\b/i,
];

/** Narrow patterns for queries that ask for the ACTIVE backlog. */
const BACKLOG_PATTERNS: RegExp[] = [
  /\b(active|pending|current|my|open)\s+backlog\b/i,
  /\bbacklog\s+(tasks?|items?|list|snapshot)\b/i,
  /^\s*backlog\s*$/i,
  /^\s*pending\s+tasks?\s*$/i,
  /^\s*what'?s?\s+next\??\s*$/i,
];

function matches(patterns: RegExp[], q: string): boolean {
  return patterns.some((re) => re.test(q));
}

function sortByPriorityThenAge(rows: BacklogRow[]): BacklogRow[] {
  return [...rows].sort(
    (a, b) => a.priority - b.priority || Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

export async function searchMemory(args: {
  query: string;
  limit?: number;
  min_similarity?: number;
  project_id?: string;
  metadata_filter?: Record<string, unknown>;
  include_global?: boolean;
}) {
  const projectId = args.project_id ?? currentProjectId;
  const limit = args.limit ?? 5;
  // Default behavior: dual-scope across the current project AND the reserved
  // 'GLOBAL' bucket. Pass include_global:false to restrict to project_id only.
  const includeGlobal = args.include_global ?? true;

  // Precedence: id > context_id > archive > backlog > semantic.
  //
  // ID fallthrough — a query that is JUST a number is almost certainly a
  // direct lookup ("show me row 11468"), not a semantic ask. Vector ranking
  // on numeric tokens is meaningless and can hide rows whose neighbors won
  // the cosine race. Direct SQL fetch is exact and respects dual-scope
  // (current project_id OR 'GLOBAL' when include_global is true).
  const idMatch = args.query.match(ID_PATTERN);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const projectFilter = includeGlobal
      ? `project_id.eq.${projectId},project_id.eq.GLOBAL`
      : `project_id.eq.${projectId}`;
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("id, content, file_origin, chunk_index, metadata, project_id")
      .eq("id", id)
      .or(projectFilter)
      .limit(1);
    if (error) {
      throw new Error(`Supabase id-lookup failed: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{
      id: number;
      content: string;
      file_origin: string;
      chunk_index: number;
      metadata: Record<string, unknown>;
      project_id: string;
    }>;
    return {
      project_id: projectId,
      query: args.query,
      mode: "id" as const,
      include_global: includeGlobal,
      count: rows.length,
      results: rows.map((r) => ({
        id: r.id,
        content: r.content,
        file_origin: r.file_origin,
        chunk_index: r.chunk_index,
        metadata: r.metadata,
        similarity: 1.0,
        project_id: r.project_id,
      })),
    };
  }

  // Context-ID fallthrough — Sovereign Decision IDs like "SCM-S15-D1" or
  // "SCM-S15-D1-GLOBAL". Use metadata.context_id @> containment (uses GIN)
  // so the lookup is exact, dual-scope-aware, and never embedding-bottlenecked.
  const ctxMatch = args.query.match(CONTEXT_ID_PATTERN);
  if (ctxMatch) {
    const contextId = ctxMatch[1];
    const projectFilter = includeGlobal
      ? `project_id.eq.${projectId},project_id.eq.GLOBAL`
      : `project_id.eq.${projectId}`;
    const { data, error } = await supabase
      .from("memory_chunks")
      .select("id, content, file_origin, chunk_index, metadata, project_id")
      .contains("metadata", { context_id: contextId })
      .or(projectFilter)
      .limit(Math.max(limit, 5));
    if (error) {
      throw new Error(`Supabase context_id-lookup failed: ${error.message}`);
    }
    const rows = (data ?? []) as Array<{
      id: number;
      content: string;
      file_origin: string;
      chunk_index: number;
      metadata: Record<string, unknown>;
      project_id: string;
    }>;
    return {
      project_id: projectId,
      query: args.query,
      mode: "context_id" as const,
      include_global: includeGlobal,
      count: rows.length,
      results: rows.map((r) => ({
        id: r.id,
        content: r.content,
        file_origin: r.file_origin,
        chunk_index: r.chunk_index,
        metadata: r.metadata,
        similarity: 1.0,
        project_id: r.project_id,
      })),
    };
  }

  if (matches(ARCHIVE_PATTERNS, args.query)) {
    const rows: ArchiveRow[] = await listArchive(projectId, { limit: Math.max(limit, 20) });
    const summary =
      rows.length === 0
        ? "Archive is empty for this project."
        : `${rows.length} archived task${rows.length === 1 ? "" : "s"}. Most recent: "${rows[0].title}" (archived ${rows[0].archived_at}).`;
    return {
      project_id: projectId,
      query: args.query,
      mode: "archive" as const,
      count: rows.length,
      results: [],
      archive: rows.map((t) => ({
        id: t.id,
        cloud_backlog_id: t.cloud_backlog_id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        notes: t.notes,
        created_at: t.created_at,
        archived_at: t.archived_at,
      })),
      summary,
    };
  }

  if (matches(BACKLOG_PATTERNS, args.query)) {
    const [inProg, todo, blocked] = await Promise.all([
      listBacklog(projectId, { status: "in_progress" }),
      listBacklog(projectId, { status: "todo" }),
      listBacklog(projectId, { status: "blocked" }),
    ]);
    const active = sortByPriorityThenAge([...inProg, ...todo, ...blocked]);
    const top = active.slice(0, Math.max(limit, 20));
    const head = active[0];
    const summary =
      active.length === 0
        ? "Backlog is empty for this project."
        : `${active.length} active task${active.length === 1 ? "" : "s"}. ` +
          `Next: [P${head.priority}] ${head.title} (${head.status}).`;
    return {
      project_id: projectId,
      query: args.query,
      mode: "backlog" as const,
      count: top.length,
      results: [],
      backlog: top.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        notes: t.notes,
        created_at: t.created_at,
      })),
      summary,
    };
  }

  // Default semantic path. Archived backlog rows are NEVER mixed into
  // semantic results — they live in a different table and only surface via
  // the archive-intent fast path above.
  //
  // `metadata_filter` (when present) flows through to match_memory_chunks's
  // `p_metadata_filter` arg — the GIN(jsonb_path_ops) index narrows the
  // candidate set BEFORE pgvector ranks. Project-id filtering is structural
  // at the SQL level (first WHERE predicate) and is never relaxed.
  const [queryVec] = await embed([args.query]);
  const results = await searchChunks(
    projectId,
    queryVec,
    limit,
    args.min_similarity ?? 0.0,
    args.metadata_filter ?? null,
    includeGlobal,
  );
  return {
    project_id: projectId,
    query: args.query,
    mode: "semantic" as const,
    include_global: includeGlobal,
    count: results.length,
    results,
  };
}
