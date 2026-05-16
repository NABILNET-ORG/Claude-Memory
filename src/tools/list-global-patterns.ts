// MCP tool: list_global_patterns
//
// Browse-only enumeration of the reserved 'GLOBAL' Knowledge Vault.
// Pure SQL — no embedding work, no Ollama call. See ARCHITECTURE.md §4.3.1
// for the spec and acceptance criteria.
//
// Task 5: real SELECT against memory_chunks WHERE project_id='GLOBAL',
// optional jsonb @> filter via supabase-js `.contains()` (hits the
// GIN(jsonb_path_ops) index from migration 007), ORDER BY updated_at
// DESC, id DESC, paginated via inclusive `.range()`.
//
// NOTE on the recency column: memory_chunks has NO `created_at` column —
// `updated_at` is the only recency signal (set on insert via
// `default now()` and on upsert via the helper). We physically ORDER BY
// `updated_at` but surface it under the `created_at` response field to
// keep the public tool contract stable.

import { z } from "zod";
import { metadataFilterSchema } from "./shared-schemas.js";
import { supabase } from "../supabase.js";

export const listGlobalPatternsInputShape = {
  metadata_filter: metadataFilterSchema,
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe(
      "Maximum rows to return. Default 10, hard cap 50 (mirrors search_memory).",
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Pagination offset. Default 0."),
  include_content: z
    .boolean()
    .optional()
    .describe(
      "When true, each row includes the full `content` field; otherwise only a content_preview (≤120 chars) is returned. Default false (tiered output).",
    ),
};

export type ListGlobalPatternsArgs = {
  metadata_filter?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  include_content?: boolean;
};

export type ListGlobalPatternsRow = {
  id: number;
  type: string | null;
  global_rationale: string | null;
  created_at: string;
  file_origin: string;
  content_preview: string;
  content?: string;
};

export type ListGlobalPatternsResponse = {
  project_id: "GLOBAL";
  count: number;
  results: ListGlobalPatternsRow[];
  limit: number;
  offset: number;
  summary: string;
};

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
const PREVIEW_CHARS = 120;
const GLOBAL_PROJECT_ID = "GLOBAL";

export async function listGlobalPatterns(
  args: ListGlobalPatternsArgs,
): Promise<ListGlobalPatternsResponse> {
  const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = args.offset ?? 0;
  const includeContent = args.include_content ?? false;

  let query = supabase
    .from("memory_chunks")
    .select("id, content, metadata, file_origin, updated_at", {
      count: "exact",
    })
    .eq("project_id", GLOBAL_PROJECT_ID)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  if (args.metadata_filter && Object.keys(args.metadata_filter).length > 0) {
    // @>-style JSONB containment: Supabase JS exposes this via the
    // `contains` operator. Hits the existing GIN(jsonb_path_ops) index on
    // memory_chunks.metadata.
    query = query.contains("metadata", args.metadata_filter);
  }

  const { data, error, count } = await query;
  if (error) {
    throw new Error(`list_global_patterns SELECT failed: ${error.message}`);
  }

  const rows = (data ?? []).map((r): ListGlobalPatternsRow => {
    const metadata = (r.metadata ?? {}) as Record<string, unknown>;
    const content = (r.content ?? "") as string;
    const preview =
      content.length <= PREVIEW_CHARS
        ? content
        : `${content.slice(0, PREVIEW_CHARS)}…`;
    const row: ListGlobalPatternsRow = {
      id: r.id as number,
      type: typeof metadata.type === "string" ? metadata.type : null,
      global_rationale:
        typeof metadata.global_rationale === "string"
          ? metadata.global_rationale
          : null,
      created_at: r.updated_at as string,
      file_origin: (r.file_origin ?? "") as string,
      content_preview: preview,
    };
    if (includeContent) {
      row.content = content;
    }
    return row;
  });

  const total = count ?? rows.length;
  const summary =
    total === 0
      ? "GLOBAL vault is empty."
      : `Returned ${rows.length} of ${total} GLOBAL row(s).`;

  return {
    project_id: "GLOBAL",
    count: total,
    results: rows,
    limit,
    offset,
    summary,
  };
}
