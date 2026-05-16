// MCP tool: list_global_patterns
//
// Browse-only enumeration of the reserved 'GLOBAL' Knowledge Vault.
// Pure SQL — no embedding work, no Ollama call. See ARCHITECTURE.md §4.3.1
// for the spec and acceptance criteria.
//
// STAGED ROLLOUT: this commit ships the stub (returns the empty-result
// envelope unconditionally). The real SELECT lands in the next commit
// (Task 5) so the MCP wiring is validated separately from the logic.

import { z } from "zod";
import { metadataFilterSchema } from "./shared-schemas.js";

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

export async function listGlobalPatterns(
  args: ListGlobalPatternsArgs,
): Promise<ListGlobalPatternsResponse> {
  const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = args.offset ?? 0;

  // STUB — Task 5 replaces this body with the real SELECT.
  return {
    project_id: "GLOBAL",
    count: 0,
    results: [],
    limit,
    offset,
    summary: "GLOBAL vault is empty.",
  };
}
