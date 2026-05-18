import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { listFileOriginsForProject, deleteChunksForFile } from "../src/supabase.js";
import { insertThrowawayChunkForFile, uniqueProjectId } from "./fixtures/prune.js";

describe("listFileOriginsForProject", () => {
  const projectId = uniqueProjectId();
  const fileA = "/tmp/prune-list-a.md";
  const fileB = "/tmp/prune-list-b.md";

  after(async () => {
    await deleteChunksForFile(projectId, fileA);
    await deleteChunksForFile(projectId, fileB);
  });

  test("returns distinct file_origins scoped to the project", async () => {
    await insertThrowawayChunkForFile(projectId, fileA, "alpha-chunk-1", 0);
    await insertThrowawayChunkForFile(projectId, fileA, "alpha-chunk-2", 1);
    await insertThrowawayChunkForFile(projectId, fileB, "beta-chunk", 0);

    const origins = await listFileOriginsForProject(projectId);

    assert.deepEqual(origins.sort(), [fileA, fileB].sort());
  });

  test("returns empty array for project with no rows", async () => {
    const empty = uniqueProjectId();
    const origins = await listFileOriginsForProject(empty);
    assert.deepEqual(origins, []);
  });
});
