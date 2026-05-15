// Shared Zod fragments reused across MCP tool registrations.
//
// Hoisting rationale: when two tools accept the same input shape (e.g.,
// `metadata_filter` for both search_memory and list_global_patterns),
// duplicating the Zod definition is a DRY violation that drifts silently.
// Define once here; import at every server.tool() registration site.

import { z } from "zod";

/**
 * JSONB-containment filter against `memory_chunks.metadata`.
 *
 * Common shapes:
 *   - { type: 'DECISION' | 'PATTERN' | 'ERROR' | 'LOG' }
 *   - { type: 'ERROR', status: 'fixed' }
 *
 * The Postgres operator `@>` evaluates this against the GIN(jsonb_path_ops)
 * index on memory_chunks.metadata, so any number of keys composes for free.
 *
 * Reused by: search_memory, list_global_patterns.
 */
export const metadataFilterSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "JSONB containment filter against memory_chunks.metadata. Common shape: {type:'DECISION'|'PATTERN'|'ERROR'|'LOG'} or {type:'ERROR', status:'fixed'}. Matches Postgres `@>`.",
  );
