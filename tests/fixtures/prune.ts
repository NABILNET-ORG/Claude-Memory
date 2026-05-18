// Per-test setup/teardown for prune_memory tests.
// Mirrors fixtures/m4.ts shape: every test gets a unique project_id namespace
// and cleanup via cleanupProject() wipes ALL test artefacts under that id.

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supabase } from "../../src/supabase.js";

export function uniqueProjectId(): string {
  return `__test_prune_${randomUUID().slice(0, 8)}__`;
}

// memory_chunks NOT NULL columns: embedding vector(768), content_hash text.
const ZERO_EMBEDDING = JSON.stringify(new Array(768).fill(0));

export async function insertThrowawayChunkForFile(
  projectId: string,
  fileOrigin: string,
  content: string,
  chunkIndex = 0,
): Promise<number> {
  const contentHash = createHash("sha256").update(content).digest("hex");
  const { data, error } = await supabase
    .from("memory_chunks")
    .insert({
      project_id: projectId,
      file_origin: fileOrigin,
      chunk_index: chunkIndex,
      content,
      content_hash: contentHash,
      embedding: ZERO_EMBEDDING,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `insertThrowawayChunkForFile failed: ${error?.message ?? "no row returned"}`,
    );
  }
  return data.id;
}

export interface TmpRepoFile {
  path: string;
  cleanup: () => Promise<void>;
}

export async function tmpRepoFile(content: string): Promise<TmpRepoFile> {
  const dir = await mkdtemp(join(tmpdir(), "prune-test-"));
  const path = join(dir, "fixture.md");
  await writeFile(path, content, "utf8");
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
