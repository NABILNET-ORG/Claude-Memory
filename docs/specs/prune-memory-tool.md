# prune_memory Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a typed `prune_memory` MCP tool that deletes orphan rows from `memory_chunks` for explicit on-disk file paths only, with a `dry_run` default and a forensic manifest backup — paying off the documented deferral at [README.md:489](../../README.md).

**Architecture:** Single-file tool at `src/tools/prune.ts` exporting `pruneMemory(args)`. Reuses the existing `deleteChunksForFile(projectId, fileOrigin)` helper at [src/supabase.ts:199-210](../../src/supabase.ts) and a new `listFileOriginsForProject(projectId)` helper. Hard-filters `inline:*` origins (created by `save_memory`) and refuses `project_id='GLOBAL'`. Registration mirrors `save_memory` in [src/index.ts:231-270](../../src/index.ts). Tests live in `tests/prune.test.ts` using `node:test` + `node:assert/strict` with a unique-per-test `project_id` and live Supabase access — same shape as [tests/curriculum-scanner.test.ts](../../tests/curriculum-scanner.test.ts).

**Tech Stack:** TypeScript (NodeNext modules), `@modelcontextprotocol/sdk`, `zod` for input schema, `@supabase/supabase-js`, `node:fs`, `node:path`, `node:test`, `tsx` test loader.

---

## Decision Pins (must hold across all tasks)

| Pin | Value | Rationale |
|---|---|---|
| **Input contract** | `explicit_paths: string[]` (required, non-empty) | User mandate: no wildcard scans. README:489 — "never silent". |
| **Default mode** | `confirm: false` → dry-run; nothing deleted | Mirrors [src/tools/sync.ts:218-331](../../src/tools/sync.ts) `runPurge` shape. |
| **Inline filter** | `if (fileOrigin.startsWith("inline:")) skip` | Silently wiping `save_memory` rows is the highest-severity foreseeable bug. |
| **GLOBAL guard** | `if (projectId === "GLOBAL") throw` | GLOBAL rows have no on-disk file_origin to verify. |
| **Disk re-check** | Every candidate must fail `existsSync(absPath)` AND have ≥1 row matching `(project_id, file_origin)` before delete | Inverse of `verifyFileSynced`. |
| **Delete helper** | Reuse `deleteChunksForFile(projectId, fileOrigin)` | Already pinned on `project_id` + `file_origin`; returns exact count. No new SQL. |
| **Manifest** | `~/.claude-memory/prune-backups/<ISO-stamp>-<project>/manifest.json` with `{ project_id, prune_at, items: [{ file_origin, chunk_count, was_orphan: true }] }` | Forensic reversal via re-sync. No ZIP needed (orphan = no disk content to back up). |
| **Constitution** | "Archive, never delete" bans mutation, not orphan reaping. README:489 pre-authorises. FK CASCADE at ARCHITECTURE.md:343 anticipates `memory_chunks` deletes. | Already vetted in investigation. |

---

## File Structure

**Create:**
- `src/tools/prune.ts` — `pruneMemory()` entry point, dry-run logic, manifest writer.
- `tests/prune.test.ts` — characterization tests.

**Modify:**
- `src/supabase.ts` — add `listFileOriginsForProject(projectId): Promise<string[]>` (≤15 LOC).
- `src/index.ts` — register `prune_memory` next to `sync_local_memory`.
- `README.md` — replace the deferral note at line 489 with the new tool's user-facing doc; add `prune_memory` row to the Toolbox table.
- `ARCHITECTURE.md` — short subsection under §4 documenting the safety architecture (≤30 LOC).

**No changes:**
- `src/tools/sync.ts` — `orphan_files` reporting stays as-is; `prune_memory` is the deletion counterpart, not a sync extension.
- `src/project.ts` — no new export. Default `project_id` resolution mirrors the inline `slugify(basename(process.cwd()) || "default")` pattern already used at [src/tools/backlog.ts:174](../../src/tools/backlog.ts) and [src/tools/backlog.ts:246](../../src/tools/backlog.ts). Implementer MUST grep `src/tools/backlog.ts` for the actual `slugify` import path used in this repo and mirror it verbatim — do NOT invent a new dependency.
- Database schema — no migration needed.

---

## API Surface (locked)

```ts
// src/tools/prune.ts
export interface PruneArgs {
  explicit_paths: string[];           // REQUIRED, min 1, absolute or repo-relative
  project_id?: string;                // defaults to slugified cwd
  confirm?: boolean;                  // default false (dry-run)
}

export interface PruneCandidate {
  file_origin: string;                // exact DB value, post-normalisation
  exists_on_disk: boolean;
  chunk_count: number;                // rows that would be / were deleted
  skipped_reason?: "inline_origin" | "not_in_db" | "still_on_disk";
}

export interface PruneResult {
  mode: "dry_run" | "deleted" | "aborted";
  project_id: string;
  candidates: PruneCandidate[];
  deleted_total: number;              // 0 in dry_run
  manifest_path?: string;             // only when mode==="deleted"
}

export async function pruneMemory(args: PruneArgs): Promise<PruneResult>;
```

**MCP tool description (verbatim — used in `server.tool()`):**

> Delete `memory_chunks` rows for explicit on-disk file paths whose source files have been removed locally. Pays off the deferred `prune_memory` from README. Safety: `explicit_paths` is REQUIRED (no wildcard scans), `confirm:false` is the default and returns a dry-run preview, `inline:*` file_origins are always skipped (they have no disk file), `project_id='GLOBAL'` is rejected. Every confirmed delete is mirrored to a manifest under `~/.claude-memory/prune-backups/<stamp>-<project>/manifest.json` for forensic reversal via re-sync.

---

## Characterization Tests (locked behaviors)

These tests pin the contract **before** any implementation lands. All use `node:test`, live Supabase, unique `project_id` per `describe`, `after()` cleanup via `deleteChunksForFile` for any rows the test itself inserted.

| # | Test name | What it pins |
|---|---|---|
| T1 | `dry_run returns candidates without deleting any rows` | `confirm:false` is non-destructive; result.mode === "dry_run"; row count in DB unchanged. |
| T2 | `requires non-empty explicit_paths` | Zod rejects `explicit_paths:[]` and missing arg. Zero DB calls. |
| T3 | `skips inline: file_origins even when explicit_paths matches them` | Inserting `inline:abc123` then prune with `explicit_paths:["inline:abc123"]` → skipped with `reason:"inline_origin"`; row survives. |
| T4 | `refuses project_id GLOBAL` | Throws synchronously before any DB call. |
| T5 | `dry_run flags still-on-disk path as skipped` | If the file at `explicit_paths[0]` exists, candidate is `skipped_reason:"still_on_disk"` even in dry_run. |
| T6 | `dry_run flags not-in-db path as skipped` | If the file_origin has no rows, candidate is `skipped_reason:"not_in_db"`. |
| T7 | `confirm:true deletes only confirmed-orphan rows` | Insert 2 chunks for path A (file deleted from disk), 1 chunk for path B (file still on disk), call with both paths and `confirm:true` → A's 2 rows gone, B's 1 row survives. |
| T8 | `confirm:true writes manifest with exact deleted file_origins` | Manifest JSON exists at returned `manifest_path`, contains exactly path A's entry with `chunk_count:2`. |
| T9 | `deleted_total matches sum of chunk_counts for non-skipped candidates` | Numerical invariant — never report deletes you didn't perform. |
| T10 | `does not touch rows from other project_ids` | Insert orphan chunk under projectA and same file_origin under projectB; prune projectA → projectB row untouched. |

**Fixtures (additions to [tests/fixtures/m4.js](../../tests/fixtures/m4.js) or new `tests/fixtures/prune.ts`):**
- `insertThrowawayChunkForFile(projectId, fileOrigin, content)` — inserts one `memory_chunks` row with a dummy embedding (mirror existing throwaway-insert helpers).
- `tmpRepoFile(content)` → returns `{ path, cleanup }` — writes a temp file inside `os.tmpdir()`, returns the path and a delete callback.

---

## Implementation Tasks

### Task 1: Supabase helper — list project file_origins

**Files:**
- Modify: `src/supabase.ts` (add new export below `deleteChunksForFile`)

- [ ] **Step 1: Write the failing test**

In `tests/prune.test.ts`:

```ts
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { listFileOriginsForProject, deleteChunksForFile } from "../src/supabase.js";
import { insertThrowawayChunkForFile } from "./fixtures/prune.js";

describe("listFileOriginsForProject", () => {
  const projectId = `prune-test-${randomUUID()}`;
  after(async () => {
    for (const fo of ["/tmp/a.md", "/tmp/b.md"]) {
      await deleteChunksForFile(projectId, fo);
    }
  });

  test("returns distinct file_origins for the project only", async () => {
    await insertThrowawayChunkForFile(projectId, "/tmp/a.md", "x");
    await insertThrowawayChunkForFile(projectId, "/tmp/a.md", "y"); // 2nd chunk same file
    await insertThrowawayChunkForFile(projectId, "/tmp/b.md", "z");
    const origins = await listFileOriginsForProject(projectId);
    assert.deepEqual(origins.sort(), ["/tmp/a.md", "/tmp/b.md"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/prune.test.ts`
Expected: FAIL — `listFileOriginsForProject is not a function`.

- [ ] **Step 3: Add the helper in src/supabase.ts**

Insert immediately below `deleteChunksForFile`:

```ts
export async function listFileOriginsForProject(
  projectId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("memory_chunks")
    .select("file_origin")
    .eq("project_id", projectId);
  if (error) throw new Error(`listFileOriginsForProject failed: ${error.message}`);
  return Array.from(new Set((data ?? []).map((r) => r.file_origin as string)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/prune.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supabase.ts tests/prune.test.ts tests/fixtures/prune.ts
git commit -m "feat(prune): add listFileOriginsForProject helper + test"
```

---

### Task 2: pruneMemory — dry-run skeleton + input validation (T1, T2, T4)

**Files:**
- Create: `src/tools/prune.ts`
- Modify: `tests/prune.test.ts` (append)

- [ ] **Step 1: Write failing tests T1, T2, T4**

Append to `tests/prune.test.ts`:

```ts
import { pruneMemory } from "../src/tools/prune.js";

describe("pruneMemory — input validation", () => {
  test("T2: rejects empty explicit_paths", async () => {
    await assert.rejects(
      () => pruneMemory({ explicit_paths: [], project_id: "x" }),
      /explicit_paths/,
    );
  });

  test("T4: refuses project_id='GLOBAL'", async () => {
    await assert.rejects(
      () => pruneMemory({ explicit_paths: ["/tmp/x"], project_id: "GLOBAL" }),
      /GLOBAL/,
    );
  });

  test("T1: dry_run returns mode='dry_run' and deletes nothing", async () => {
    const projectId = `prune-dry-${randomUUID()}`;
    await insertThrowawayChunkForFile(projectId, "/tmp/missing.md", "x");
    after(async () => deleteChunksForFile(projectId, "/tmp/missing.md"));

    const r = await pruneMemory({
      explicit_paths: ["/tmp/missing.md"],
      project_id: projectId,
    });
    assert.equal(r.mode, "dry_run");
    assert.equal(r.deleted_total, 0);
    const stillThere = await listFileOriginsForProject(projectId);
    assert.ok(stillThere.includes("/tmp/missing.md"));
  });
});
```

- [ ] **Step 2: Verify they fail**

Run: `npm test -- tests/prune.test.ts`
Expected: 3 failures (module not found).

- [ ] **Step 3: Create `src/tools/prune.ts` with skeleton**

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { currentProjectId } from "../project.js";
import { listFileOriginsForProject, deleteChunksForFile } from "../supabase.js";

export interface PruneArgs {
  explicit_paths: string[];
  project_id?: string;
  confirm?: boolean;
}

export interface PruneCandidate {
  file_origin: string;
  exists_on_disk: boolean;
  chunk_count: number;
  skipped_reason?: "inline_origin" | "not_in_db" | "still_on_disk";
}

export interface PruneResult {
  mode: "dry_run" | "deleted" | "aborted";
  project_id: string;
  candidates: PruneCandidate[];
  deleted_total: number;
  manifest_path?: string;
}

export async function pruneMemory(args: PruneArgs): Promise<PruneResult> {
  if (!Array.isArray(args.explicit_paths) || args.explicit_paths.length === 0) {
    throw new Error("explicit_paths is required and must be a non-empty array");
  }
  const projectId = args.project_id ?? currentProjectId();
  if (projectId === "GLOBAL") {
    throw new Error("project_id='GLOBAL' is not allowed for prune_memory");
  }
  const dbOrigins = new Set(await listFileOriginsForProject(projectId));
  const candidates: PruneCandidate[] = [];
  for (const raw of args.explicit_paths) {
    const candidate = await classifyCandidate(raw, projectId, dbOrigins);
    candidates.push(candidate);
  }
  return {
    mode: "dry_run",
    project_id: projectId,
    candidates,
    deleted_total: 0,
  };
}

async function classifyCandidate(
  raw: string,
  projectId: string,
  dbOrigins: Set<string>,
): Promise<PruneCandidate> {
  if (raw.startsWith("inline:")) {
    return { file_origin: raw, exists_on_disk: false, chunk_count: 0, skipped_reason: "inline_origin" };
  }
  const abs = resolve(raw);
  if (!dbOrigins.has(raw) && !dbOrigins.has(abs)) {
    return { file_origin: raw, exists_on_disk: existsSync(abs), chunk_count: 0, skipped_reason: "not_in_db" };
  }
  const fileOrigin = dbOrigins.has(raw) ? raw : abs;
  const onDisk = existsSync(abs);
  const chunkCount = await countChunks(projectId, fileOrigin);
  if (onDisk) {
    return { file_origin: fileOrigin, exists_on_disk: true, chunk_count: chunkCount, skipped_reason: "still_on_disk" };
  }
  return { file_origin: fileOrigin, exists_on_disk: false, chunk_count: chunkCount };
}

async function countChunks(projectId: string, fileOrigin: string): Promise<number> {
  const { supabase } = await import("../supabase.js");
  const { count, error } = await supabase
    .from("memory_chunks")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("file_origin", fileOrigin);
  if (error) throw new Error(`countChunks failed: ${error.message}`);
  return count ?? 0;
}
```

- [ ] **Step 4: Verify T1, T2, T4 pass**

Run: `npm test -- tests/prune.test.ts`
Expected: PASS for 3 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/prune.ts tests/prune.test.ts
git commit -m "feat(prune): pruneMemory dry-run skeleton + input guards (T1/T2/T4)"
```

---

### Task 3: Inline-origin filter (T3) — the bug pre-empt

**Files:**
- Modify: `tests/prune.test.ts` (append T3)

- [ ] **Step 1: Write T3**

```ts
test("T3: skips inline:* origins even when explicit_paths names one", async () => {
  const projectId = `prune-inline-${randomUUID()}`;
  await insertThrowawayChunkForFile(projectId, "inline:abc123def", "ghost row");
  after(async () => deleteChunksForFile(projectId, "inline:abc123def"));

  const r = await pruneMemory({
    explicit_paths: ["inline:abc123def"],
    project_id: projectId,
    confirm: true, // even with confirm:true, must not delete inline
  });
  const c = r.candidates[0];
  assert.equal(c.skipped_reason, "inline_origin");
  assert.equal(c.chunk_count, 0);
  const survivors = await listFileOriginsForProject(projectId);
  assert.ok(survivors.includes("inline:abc123def"));
});
```

- [ ] **Step 2: Verify T3 passes (logic already in classifyCandidate)**

Run: `npm test -- tests/prune.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/prune.test.ts
git commit -m "test(prune): T3 confirms inline:* origins are never deleted"
```

---

### Task 4: Skipped-reason classification (T5, T6)

**Files:**
- Modify: `tests/prune.test.ts` (append T5, T6)

- [ ] **Step 1: Write T5, T6**

```ts
test("T5: file still on disk is skipped as still_on_disk", async () => {
  const projectId = `prune-ondisk-${randomUUID()}`;
  const { path: tmp, cleanup } = await tmpRepoFile("hello");
  await insertThrowawayChunkForFile(projectId, tmp, "x");
  after(async () => { await deleteChunksForFile(projectId, tmp); await cleanup(); });

  const r = await pruneMemory({ explicit_paths: [tmp], project_id: projectId, confirm: true });
  assert.equal(r.candidates[0].skipped_reason, "still_on_disk");
  assert.equal(r.deleted_total, 0);
});

test("T6: file_origin with no DB rows is skipped as not_in_db", async () => {
  const projectId = `prune-notindb-${randomUUID()}`;
  const r = await pruneMemory({
    explicit_paths: ["/nonexistent/never-stored.md"],
    project_id: projectId,
    confirm: true,
  });
  assert.equal(r.candidates[0].skipped_reason, "not_in_db");
});
```

- [ ] **Step 2: Verify T5, T6 pass (logic already in place)**

Run: `npm test -- tests/prune.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/prune.test.ts
git commit -m "test(prune): T5/T6 pin still_on_disk + not_in_db classifications"
```

---

### Task 5: Confirmed delete path + manifest (T7, T8, T9, T10)

**Files:**
- Modify: `src/tools/prune.ts` (replace return block with confirm-branch + manifest writer)
- Modify: `tests/prune.test.ts` (append T7–T10)

- [ ] **Step 1: Write T7–T10**

```ts
import { readFile } from "node:fs/promises";

test("T7: confirm:true deletes only confirmed-orphan rows", async () => {
  const projectId = `prune-confirm-${randomUUID()}`;
  const { path: aliveFile, cleanup: cleanA } = await tmpRepoFile("alive");
  const orphanPath = "/tmp/orphan-" + randomUUID() + ".md";
  await insertThrowawayChunkForFile(projectId, orphanPath, "o1");
  await insertThrowawayChunkForFile(projectId, orphanPath, "o2");
  await insertThrowawayChunkForFile(projectId, aliveFile, "a1");
  after(async () => {
    await deleteChunksForFile(projectId, orphanPath);
    await deleteChunksForFile(projectId, aliveFile);
    await cleanA();
  });

  const r = await pruneMemory({
    explicit_paths: [orphanPath, aliveFile],
    project_id: projectId,
    confirm: true,
  });
  assert.equal(r.mode, "deleted");
  assert.equal(r.deleted_total, 2);
  const survivors = await listFileOriginsForProject(projectId);
  assert.ok(!survivors.includes(orphanPath));
  assert.ok(survivors.includes(aliveFile));
});

test("T8: manifest contains deleted file_origins with exact chunk_counts", async () => {
  const projectId = `prune-manifest-${randomUUID()}`;
  const orphanPath = "/tmp/orphan-" + randomUUID() + ".md";
  await insertThrowawayChunkForFile(projectId, orphanPath, "o1");
  await insertThrowawayChunkForFile(projectId, orphanPath, "o2");
  after(async () => deleteChunksForFile(projectId, orphanPath));

  const r = await pruneMemory({
    explicit_paths: [orphanPath],
    project_id: projectId,
    confirm: true,
  });
  assert.ok(r.manifest_path);
  const manifest = JSON.parse(await readFile(r.manifest_path!, "utf8"));
  assert.equal(manifest.project_id, projectId);
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].file_origin, orphanPath);
  assert.equal(manifest.items[0].chunk_count, 2);
});

test("T9: deleted_total === sum(chunk_count) of non-skipped candidates", async () => {
  const projectId = `prune-sum-${randomUUID()}`;
  const o1 = "/tmp/o1-" + randomUUID();
  const o2 = "/tmp/o2-" + randomUUID();
  await insertThrowawayChunkForFile(projectId, o1, "x");
  await insertThrowawayChunkForFile(projectId, o2, "y");
  await insertThrowawayChunkForFile(projectId, o2, "z");
  after(async () => {
    await deleteChunksForFile(projectId, o1);
    await deleteChunksForFile(projectId, o2);
  });
  const r = await pruneMemory({ explicit_paths: [o1, o2], project_id: projectId, confirm: true });
  const expected = r.candidates
    .filter((c) => !c.skipped_reason)
    .reduce((s, c) => s + c.chunk_count, 0);
  assert.equal(r.deleted_total, expected);
  assert.equal(r.deleted_total, 3);
});

test("T10: never deletes rows under a different project_id", async () => {
  const projectA = `prune-A-${randomUUID()}`;
  const projectB = `prune-B-${randomUUID()}`;
  const sharedPath = "/tmp/shared-" + randomUUID() + ".md";
  await insertThrowawayChunkForFile(projectA, sharedPath, "a-row");
  await insertThrowawayChunkForFile(projectB, sharedPath, "b-row");
  after(async () => {
    await deleteChunksForFile(projectA, sharedPath);
    await deleteChunksForFile(projectB, sharedPath);
  });

  await pruneMemory({ explicit_paths: [sharedPath], project_id: projectA, confirm: true });
  const survivorsB = await listFileOriginsForProject(projectB);
  assert.ok(survivorsB.includes(sharedPath));
});
```

- [ ] **Step 2: Verify they all fail with `mode==="dry_run"` mismatch**

Run: `npm test -- tests/prune.test.ts`
Expected: FAIL on T7/T8/T9/T10.

- [ ] **Step 3: Replace return block in `src/tools/prune.ts`**

Replace the final `return { mode: "dry_run", ... }` with:

```ts
  if (!args.confirm) {
    return { mode: "dry_run", project_id: projectId, candidates, deleted_total: 0 };
  }
  let deletedTotal = 0;
  const deletedItems: { file_origin: string; chunk_count: number; was_orphan: true }[] = [];
  for (const c of candidates) {
    if (c.skipped_reason) continue;
    const n = await deleteChunksForFile(projectId, c.file_origin);
    deletedTotal += n;
    deletedItems.push({ file_origin: c.file_origin, chunk_count: n, was_orphan: true });
  }
  const manifestPath = await writeManifest(projectId, deletedItems);
  return { mode: "deleted", project_id: projectId, candidates, deleted_total: deletedTotal, manifest_path: manifestPath };
}

async function writeManifest(
  projectId: string,
  items: { file_origin: string; chunk_count: number; was_orphan: true }[],
): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(homedir(), ".claude-memory", "prune-backups", `${stamp}-${projectId}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  await writeFile(path, JSON.stringify({ project_id: projectId, prune_at: stamp, items }, null, 2), "utf8");
  return path;
}
```

- [ ] **Step 4: Verify T7–T10 pass**

Run: `npm test -- tests/prune.test.ts`
Expected: PASS on all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/prune.ts tests/prune.test.ts
git commit -m "feat(prune): confirmed delete branch + manifest writer (T7–T10)"
```

---

### Task 6: MCP registration

**Files:**
- Modify: `src/index.ts` (register `prune_memory`)

- [ ] **Step 1: Write integration test**

Append to `tests/prune.test.ts`:

```ts
import { z } from "zod";

test("MCP: zod schema matches PruneArgs contract", () => {
  const schema = z.object({
    explicit_paths: z.array(z.string()).min(1),
    project_id: z.string().optional(),
    confirm: z.boolean().optional(),
  });
  assert.doesNotThrow(() => schema.parse({ explicit_paths: ["/x"] }));
  assert.throws(() => schema.parse({ explicit_paths: [] }));
  assert.throws(() => schema.parse({}));
});
```

- [ ] **Step 2: Register in `src/index.ts`**

Locate the `server.tool("sync_local_memory", ...)` block and insert immediately after it:

```ts
import { pruneMemory } from "./tools/prune.js";

server.tool(
  "prune_memory",
  "Delete memory_chunks rows for explicit on-disk file paths whose source files have been removed locally. Pays off the deferred prune_memory from README. Safety: explicit_paths is REQUIRED (no wildcard scans), confirm:false is the default and returns a dry-run preview, inline:* file_origins are always skipped (they have no disk file), project_id='GLOBAL' is rejected. Every confirmed delete is mirrored to a manifest under ~/.claude-memory/prune-backups/<stamp>-<project>/manifest.json for forensic reversal via re-sync.",
  {
    explicit_paths: z.array(z.string()).min(1).describe("Required. File paths whose DB rows should be considered for deletion. No wildcards."),
    project_id: projectIdSchema,
    confirm: z.boolean().optional().describe("Default false (dry-run). Set true to actually delete."),
  },
  async (args) => ({
    content: [{ type: "text", text: JSON.stringify(await pruneMemory(args), null, 2) }],
  }),
);
```

- [ ] **Step 3: Verify build + tests**

Run: `npm run build && npm test -- tests/prune.test.ts`
Expected: zero tsc errors; all prune tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts tests/prune.test.ts
git commit -m "feat(prune): register prune_memory MCP tool"
```

---

### Task 7: README + ARCHITECTURE docs

**Files:**
- Modify: `README.md:489` (replace deferral note)
- Modify: `README.md` Toolbox table (add `prune_memory` row)
- Modify: `ARCHITECTURE.md` (short subsection under §4)

- [ ] **Step 1: README:489 — replace the deferral**

Old:
```
**Orphans are reported, not pruned.** Files removed from disk stay in the DB and show up in `orphan_files`. A dedicated `prune_memory` tool is deferred to a later release so deletions are never silent.
```

New:
```
**Orphans are reported by `sync_local_memory` and pruned by `prune_memory`.** Files removed from disk stay in the DB and show up in `orphan_files`. To clean them, call `prune_memory({ explicit_paths: [...], confirm: true })` — wildcards are rejected, `inline:*` origins are always skipped, and every delete writes a forensic manifest under `~/.claude-memory/prune-backups/`.
```

- [ ] **Step 2: README Toolbox table — add row after `sync_local_memory`**

```
| `prune_memory` | Memory | Delete `memory_chunks` rows for explicit on-disk paths whose source files are gone. `confirm:false` returns a dry-run; `inline:*` and `project_id='GLOBAL'` are hard-rejected; every delete writes a manifest to `~/.claude-memory/prune-backups/`. |
```

- [ ] **Step 3: ARCHITECTURE.md — add subsection under §4**

Pick the natural location (after the `sync_local_memory` subsection if present; otherwise as a new `### prune_memory` block under the Memory toolset section). Insert:

```markdown
### prune_memory — orphan reaping with explicit-paths gate

`prune_memory` is the deletion counterpart to `sync_local_memory`'s orphan reporting. It accepts a **required** non-empty `explicit_paths: string[]` argument — no wildcards, no scans — and verifies each path is (a) absent from disk and (b) present in `memory_chunks` under the caller's `project_id` before deleting any rows. Reuses `deleteChunksForFile(project_id, file_origin)` for the SQL (already pinned on both keys). `inline:*` file_origins (synthetic origins emitted by `save_memory`) are hard-filtered to prevent silent loss of inline memories; `project_id='GLOBAL'` is rejected for the same reason. Every confirmed delete writes `{ project_id, prune_at, items: [{ file_origin, chunk_count }] }` to `~/.claude-memory/prune-backups/<ISO-stamp>-<project>/manifest.json` — full reversal is a re-sync away.

This reconciles with the Constitution's "Archive, never delete" rule (SCM-S17-D1, SCM-S18-D1): that rule bans **mutation of immutable HNSW-indexed content**. Reaping rows whose source file is gone is row-level lifecycle (mirroring `ON DELETE CASCADE` at the FK layer, §4.5), not mutation. The manifest is the archive.
```

- [ ] **Step 4: Verify md-policy hook is happy**

Run: `npm run build`
Expected: zero hook violations (Edit-only on Core 3, line budgets respected).

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs(prune): document prune_memory + reconcile with 'Archive, never delete'"
```

---

### Task 8: Save DECISION memory + close out

**Files:**
- No file changes — memory-only.

- [ ] **Step 1: Persist the architectural decision**

Call `save_memory`:

```
{
  "content": "SCM-S31-D1 — prune_memory tool. Pays off README:489 deferral. Required explicit_paths:string[] (non-empty), confirm:false dry-run default, inline:* hard-filter (bug pre-empt: would silently wipe save_memory rows), GLOBAL refused. Reuses deleteChunksForFile (supabase.ts:199). Manifest to ~/.claude-memory/prune-backups/<stamp>-<project>/manifest.json. 10 characterization tests pinning: input validation, GLOBAL guard, inline-skip, still_on_disk, not_in_db, confirmed delete, manifest, deleted_total invariant, cross-project isolation. Constitution alignment: 'Archive, never delete' targets content mutation, not orphan row reaping; manifest is the archive.",
  "metadata": { "type": "DECISION", "status": "applied", "context_id": "SCM-S31-D1" }
}
```

- [ ] **Step 2: Final verification**

Run: `npm run build && npm test`
Expected: zero tsc errors, all tests PASS, total test count = prior + 10 (+1 zod schema test).

- [ ] **Step 3: Cross-Project Test for GLOBAL candidacy**

Apply the Sovereign Vetting test: "If the Claude-Memory project were deleted tomorrow, would 'explicit-paths-only + dry-run-default + inline-filter + manifest-backup' be a gold-standard reference for any other long-running agent project?" **YES** — every vector-DB-backed agent project will eventually need orphan reaping with the same safety architecture. Defer the actual GLOBAL save to a separate consent step (per Sovereign Scout Protocol — never write GLOBAL silently).

---

## Self-Review Checklist

Run before requesting human approval on this plan:

1. **Spec coverage:** User's 4 requirements — (a) new MCP tool, (b) explicit paths only, (c) dry_run safety, (d) characterization tests detailed. Covered in Tasks 2/3/6 (tool + registration), Decision Pin "Input contract" + T2 (explicit paths), Decision Pin "Default mode" + T1 (dry_run), and the 10-row Characterization Tests table.
2. **Placeholder scan:** Searched for "TODO", "TBD", "implement later", "appropriate", "handle edge cases", "similar to" — none present.
3. **Type consistency:** `PruneArgs` / `PruneCandidate` / `PruneResult` field names match across all task code blocks. Helper names (`listFileOriginsForProject`, `deleteChunksForFile`, `writeManifest`, `classifyCandidate`, `countChunks`, `pruneMemory`) used consistently.
4. **No prematurely-deleted code paths:** Every existing helper this plan touches (`deleteChunksForFile`, sync.ts orphan reporting) is preserved.

---

## Execution Handoff

Plan complete. Two execution options once approved:

1. **Subagent-Driven (recommended)** — fresh subagent per Task, review checkpoints between tasks.
2. **Inline Execution** — execute Tasks 1–8 in-session with verification checkpoints.

Awaiting approval + execution-mode selection before any TS lands.
