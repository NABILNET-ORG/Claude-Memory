import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { currentProjectId } from "../project.js";
import {
  supabase,
  listFileOriginsForProject,
  deleteChunksForFile,
} from "../supabase.js";

export interface PruneArgs {
  explicit_paths: string[];
  project_id?: string;
  confirm?: boolean;
}

export type SkippedReason = "inline_origin" | "not_in_db" | "still_on_disk";

export interface PruneCandidate {
  file_origin: string;
  exists_on_disk: boolean;
  chunk_count: number;
  skipped_reason?: SkippedReason;
}

export interface PruneResult {
  mode: "dry_run" | "deleted" | "aborted";
  project_id: string;
  candidates: PruneCandidate[];
  deleted_total: number;
  manifest_path?: string;
}

export async function pruneMemory(args: PruneArgs): Promise<PruneResult> {
  if (!Array.isArray(args?.explicit_paths) || args.explicit_paths.length === 0) {
    throw new Error("explicit_paths is required and must be a non-empty array");
  }

  const projectId = args.project_id ?? currentProjectId;
  if (projectId === "GLOBAL") {
    throw new Error("project_id='GLOBAL' is not allowed for prune_memory");
  }

  const dbOrigins = new Set(await listFileOriginsForProject(projectId));
  const candidates: PruneCandidate[] = [];
  for (const raw of args.explicit_paths) {
    candidates.push(await classifyCandidate(raw, projectId, dbOrigins));
  }

  if (!args.confirm) {
    return {
      mode: "dry_run",
      project_id: projectId,
      candidates,
      deleted_total: 0,
    };
  }

  let deletedTotal = 0;
  const deletedItems: ManifestItem[] = [];
  for (const c of candidates) {
    if (c.skipped_reason) continue;
    const n = await deleteChunksForFile(projectId, c.file_origin);
    deletedTotal += n;
    deletedItems.push({
      file_origin: c.file_origin,
      chunk_count: n,
      was_orphan: true,
    });
  }

  let manifestPath: string | undefined;
  if (deletedItems.length > 0) {
    manifestPath = await writeManifest(projectId, deletedItems);
  }

  return {
    mode: "deleted",
    project_id: projectId,
    candidates,
    deleted_total: deletedTotal,
    manifest_path: manifestPath,
  };
}

async function classifyCandidate(
  raw: string,
  projectId: string,
  dbOrigins: Set<string>,
): Promise<PruneCandidate> {
  if (raw.startsWith("inline:")) {
    return {
      file_origin: raw,
      exists_on_disk: false,
      chunk_count: 0,
      skipped_reason: "inline_origin",
    };
  }

  const abs = resolve(raw);
  const inDbAsRaw = dbOrigins.has(raw);
  const inDbAsAbs = dbOrigins.has(abs);

  if (!inDbAsRaw && !inDbAsAbs) {
    return {
      file_origin: raw,
      exists_on_disk: existsSync(abs),
      chunk_count: 0,
      skipped_reason: "not_in_db",
    };
  }

  const fileOrigin = inDbAsRaw ? raw : abs;
  const onDisk = existsSync(abs);
  const chunkCount = await countChunks(projectId, fileOrigin);

  if (onDisk) {
    return {
      file_origin: fileOrigin,
      exists_on_disk: true,
      chunk_count: chunkCount,
      skipped_reason: "still_on_disk",
    };
  }

  return {
    file_origin: fileOrigin,
    exists_on_disk: false,
    chunk_count: chunkCount,
  };
}

async function countChunks(projectId: string, fileOrigin: string): Promise<number> {
  const { count, error } = await supabase
    .from("memory_chunks")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("file_origin", fileOrigin);
  if (error) throw new Error(`countChunks failed: ${error.message}`);
  return count ?? 0;
}

interface ManifestItem {
  file_origin: string;
  chunk_count: number;
  was_orphan: true;
}

async function writeManifest(
  projectId: string,
  items: ManifestItem[],
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(homedir(), ".claude-memory", "prune-backups", `${stamp}-${projectId}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  const body = {
    project_id: projectId,
    prune_at: stamp,
    items,
  };
  await writeFile(path, JSON.stringify(body, null, 2), "utf8");
  return path;
}
