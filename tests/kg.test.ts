// M8 Phase 3 — Knowledge Graph live-DB integration tests.
//
// Same pattern as tests/graduation-handlers.test.ts: hit the live Supabase
// schema under a unique project_id namespace per suite so cleanup is just
// `DELETE FROM kg_nodes WHERE project_id = '__test_kg_…__'` (CASCADE wipes
// edges). The migration runner inside init_project applies 020 before this
// runs, so the schema is always present by test time.
//
// What we lock down:
//   * S0  — schema sanity: table column shapes from migration 020.
//   * N1+ — upsertKgNode  (validation, idempotency, embedding preservation).
//   * E1+ — upsertKgEdge  (validation, idempotency, self-loop block, CASCADE).
//   * H1+ — kgHybridSearch (vector seed + 1-hop expansion + min_similarity).
//   * L1+ — list helpers (filters + pagination).

import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { supabase } from "../src/supabase.js";
import {
  upsertKgNode,
  upsertKgEdge,
  kgHybridSearch,
  listKgNodes,
  listKgEdges,
} from "../src/tools/kg.js";

const createdProjectIds: string[] = [];

function newProject(): string {
  const id = `__test_kg_${randomUUID().slice(0, 8)}__`;
  createdProjectIds.push(id);
  return id;
}

function unitVector(seed: number): number[] {
  // Deterministic 768-dim near-unit vector keyed on `seed` so tests can
  // construct probes that are similar / dissimilar from anchors in a
  // reproducible way (no LLM, no Ollama needed).
  const v = new Array(768);
  let acc = 0;
  for (let i = 0; i < 768; i++) {
    const x = Math.sin((seed + 1) * (i + 1) * 0.013);
    v[i] = x;
    acc += x * x;
  }
  const norm = Math.sqrt(acc) || 1;
  for (let i = 0; i < 768; i++) v[i] /= norm;
  return v;
}

after(async () => {
  // CASCADE on kg_edges.source_id/target_id means the single DELETE on
  // kg_nodes also clears every edge that was anchored to this project.
  for (const pid of createdProjectIds) {
    await supabase.from("kg_nodes").delete().eq("project_id", pid);
    await supabase.from("kg_edges").delete().eq("project_id", pid);
  }
});

// ─── S0: migration 020 sanity ─────────────────────────────────────────────

test("S0: kg_nodes table has the migration-020 column shape", async () => {
  const cols = [
    "id",
    "project_id",
    "type",
    "label",
    "properties",
    "embedding",
    "source_chunk_id",
    "created_at",
    "updated_at",
  ].join(",");
  const { error } = await supabase.from("kg_nodes").select(cols).limit(0);
  assert.equal(error, null, `kg_nodes column shape drift: ${error?.message ?? "?"}`);
});

test("S0: kg_edges table has the migration-020 column shape", async () => {
  const cols = [
    "id",
    "project_id",
    "source_id",
    "target_id",
    "relation",
    "weight",
    "properties",
    "created_at",
  ].join(",");
  const { error } = await supabase.from("kg_edges").select(cols).limit(0);
  assert.equal(error, null, `kg_edges column shape drift: ${error?.message ?? "?"}`);
});

// ─── N: upsertKgNode ──────────────────────────────────────────────────────

test("N1: rejects missing project_id", async () => {
  const r = await upsertKgNode({ project_id: "", type: "decision", label: "x" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "project_id_required");
});

test("N2: rejects missing type / label", async () => {
  const pid = newProject();
  const r1 = await upsertKgNode({ project_id: pid, type: "", label: "x" });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, "type_required");

  const r2 = await upsertKgNode({ project_id: pid, type: "decision", label: "" });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "label_required");
});

test("N3: rejects wrong-dim embedding", async () => {
  const pid = newProject();
  const r = await upsertKgNode({
    project_id: pid,
    type: "decision",
    label: "wrong-dim",
    embedding: [0.1, 0.2, 0.3],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /embedding_dim_mismatch/);
});

test("N4: happy-path insert returns a positive node_id", async () => {
  const pid = newProject();
  const r = await upsertKgNode({
    project_id: pid,
    type: "decision",
    label: "use-postgres-rpc",
    properties: { rationale: "atomic", scm: "S22" },
    embedding: unitVector(1),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.node_id > 0);
});

test("N5: same (project_id, type, label) is idempotent and updates properties", async () => {
  const pid = newProject();
  const first = await upsertKgNode({
    project_id: pid,
    type: "decision",
    label: "idemp",
    properties: { v: 1 },
    embedding: unitVector(2),
  });
  const second = await upsertKgNode({
    project_id: pid,
    type: "decision",
    label: "idemp",
    properties: { v: 2 },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.node_id, second.node_id);
  }

  // Verify properties got the v:2 update AND embedding was preserved (null on
  // the second call should NOT clobber the original).
  const { data } = await supabase
    .from("kg_nodes")
    .select("properties, embedding")
    .eq("project_id", pid)
    .eq("type", "decision")
    .eq("label", "idemp")
    .single();
  assert.equal((data?.properties as { v: number }).v, 2);
  assert.ok(data?.embedding != null, "embedding should be preserved on null-embed re-upsert");
});

// ─── E: upsertKgEdge ──────────────────────────────────────────────────────

test("E1: rejects self-loop client-side", async () => {
  const pid = newProject();
  const r = await upsertKgEdge({
    project_id: pid,
    source_id: 5,
    target_id: 5,
    relation: "loops",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "self_loop_forbidden");
});

test("E2: rejects empty relation", async () => {
  const pid = newProject();
  const a = await upsertKgNode({ project_id: pid, type: "n", label: "a", embedding: unitVector(3) });
  const b = await upsertKgNode({ project_id: pid, type: "n", label: "b", embedding: unitVector(4) });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  const r = await upsertKgEdge({
    project_id: pid,
    source_id: a.node_id,
    target_id: b.node_id,
    relation: "",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "relation_required");
});

test("E3: happy-path insert + idempotent update", async () => {
  const pid = newProject();
  const a = await upsertKgNode({ project_id: pid, type: "n", label: "a", embedding: unitVector(5) });
  const b = await upsertKgNode({ project_id: pid, type: "n", label: "b", embedding: unitVector(6) });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;

  const e1 = await upsertKgEdge({
    project_id: pid,
    source_id: a.node_id,
    target_id: b.node_id,
    relation: "mentions",
    weight: 0.7,
  });
  const e2 = await upsertKgEdge({
    project_id: pid,
    source_id: a.node_id,
    target_id: b.node_id,
    relation: "mentions",
    weight: 0.9,
    properties: { note: "updated" },
  });
  assert.ok(e1.ok && e2.ok);
  if (e1.ok && e2.ok) {
    assert.equal(e1.edge_id, e2.edge_id);
  }

  const { data } = await supabase
    .from("kg_edges")
    .select("weight, properties")
    .eq("project_id", pid)
    .eq("source_id", a.node_id)
    .eq("target_id", b.node_id)
    .eq("relation", "mentions")
    .single();
  assert.equal(Number(data?.weight), 0.9);
  assert.deepEqual(data?.properties, { note: "updated" });
});

test("E4: deleting a node CASCADEs its incident edges", async () => {
  const pid = newProject();
  const a = await upsertKgNode({ project_id: pid, type: "n", label: "a", embedding: unitVector(7) });
  const b = await upsertKgNode({ project_id: pid, type: "n", label: "b", embedding: unitVector(8) });
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  const e = await upsertKgEdge({
    project_id: pid,
    source_id: a.node_id,
    target_id: b.node_id,
    relation: "links",
  });
  assert.ok(e.ok);

  await supabase.from("kg_nodes").delete().eq("id", a.node_id);

  const { data: surviving } = await supabase
    .from("kg_edges")
    .select("id")
    .eq("project_id", pid);
  assert.equal(surviving?.length ?? 0, 0);
});

// ─── H: kgHybridSearch ────────────────────────────────────────────────────

test("H1: rejects wrong-dim query embedding", async () => {
  const pid = newProject();
  const r = await kgHybridSearch({
    project_id: pid,
    query_embedding: [0.1, 0.2],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /query_embedding_dim_mismatch/);
});

test("H2: returns empty seeds when project has no embedded nodes", async () => {
  const pid = newProject();
  const r = await kgHybridSearch({
    project_id: pid,
    query_embedding: unitVector(9),
    seed_limit: 5,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.seeds, []);
    assert.deepEqual(r.neighbors, []);
  }
});

test("H3: anchor is the top seed when query matches anchor embedding exactly", async () => {
  const pid = newProject();
  const anchorVec = unitVector(42);
  const anchor = await upsertKgNode({
    project_id: pid,
    type: "concept",
    label: "anchor",
    embedding: anchorVec,
  });
  const distractor = await upsertKgNode({
    project_id: pid,
    type: "concept",
    label: "distractor",
    embedding: unitVector(999),
  });
  assert.ok(anchor.ok && distractor.ok);
  if (!anchor.ok || !distractor.ok) return;

  const r = await kgHybridSearch({
    project_id: pid,
    query_embedding: anchorVec,
    seed_limit: 5,
    neighbor_hops: 0,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.seeds.length >= 1);
  assert.equal(r.seeds[0].label, "anchor");
  assert.ok(r.seeds[0].similarity > 0.99, `anchor sim ${r.seeds[0].similarity} should be ~1.0`);
});

test("H4: 1-hop expansion surfaces neighbours of seed nodes", async () => {
  const pid = newProject();
  const seedVec = unitVector(77);
  const seed = await upsertKgNode({ project_id: pid, type: "concept", label: "seed", embedding: seedVec });
  const friend = await upsertKgNode({ project_id: pid, type: "concept", label: "friend", embedding: unitVector(123) });
  const stranger = await upsertKgNode({ project_id: pid, type: "concept", label: "stranger", embedding: unitVector(456) });
  assert.ok(seed.ok && friend.ok && stranger.ok);
  if (!seed.ok || !friend.ok || !stranger.ok) return;

  await upsertKgEdge({
    project_id: pid,
    source_id: seed.node_id,
    target_id: friend.node_id,
    relation: "links",
    weight: 0.8,
  });
  // 'stranger' is NOT connected → must not appear in neighbors.

  const r = await kgHybridSearch({
    project_id: pid,
    query_embedding: seedVec,
    seed_limit: 1,
    neighbor_hops: 1,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.seeds.length, 1);
  assert.equal(r.seeds[0].label, "seed");
  const labels = r.neighbors.map((n) => n.label);
  assert.ok(labels.includes("friend"), `expected friend in neighbors, got ${labels.join(",")}`);
  assert.ok(!labels.includes("stranger"), "stranger should NOT appear (no edge)");
  const friendN = r.neighbors.find((n) => n.label === "friend")!;
  assert.equal(friendN.direction, "outgoing");
  assert.equal(friendN.relation, "links");
  assert.equal(Number(friendN.weight.toFixed(2)), 0.8);
});

test("H5: neighbor_hops=0 suppresses graph expansion even when edges exist", async () => {
  const pid = newProject();
  const seedVec = unitVector(88);
  const seed = await upsertKgNode({ project_id: pid, type: "concept", label: "seed", embedding: seedVec });
  const friend = await upsertKgNode({ project_id: pid, type: "concept", label: "friend", embedding: unitVector(444) });
  assert.ok(seed.ok && friend.ok);
  if (!seed.ok || !friend.ok) return;
  await upsertKgEdge({
    project_id: pid,
    source_id: seed.node_id,
    target_id: friend.node_id,
    relation: "links",
  });

  const r = await kgHybridSearch({
    project_id: pid,
    query_embedding: seedVec,
    seed_limit: 5,
    neighbor_hops: 0,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.neighbors, []);
});

// ─── L: listKgNodes / listKgEdges ─────────────────────────────────────────

test("L1: listKgNodes scoped by project + filtered by type", async () => {
  const pid = newProject();
  await upsertKgNode({ project_id: pid, type: "concept", label: "c1", embedding: unitVector(11) });
  await upsertKgNode({ project_id: pid, type: "concept", label: "c2", embedding: unitVector(12) });
  await upsertKgNode({ project_id: pid, type: "decision", label: "d1", embedding: unitVector(13) });

  const all = await listKgNodes({ project_id: pid });
  assert.equal(all.count, 3);

  const concepts = await listKgNodes({ project_id: pid, type: "concept" });
  assert.equal(concepts.count, 2);
  assert.ok(concepts.results.every((r) => r.type === "concept"));
});

test("L2: listKgNodes label_prefix uses ILIKE matching", async () => {
  const pid = newProject();
  await upsertKgNode({ project_id: pid, type: "n", label: "alpha-1", embedding: unitVector(21) });
  await upsertKgNode({ project_id: pid, type: "n", label: "alpha-2", embedding: unitVector(22) });
  await upsertKgNode({ project_id: pid, type: "n", label: "beta-1", embedding: unitVector(23) });

  const alphas = await listKgNodes({ project_id: pid, label_prefix: "alpha" });
  assert.equal(alphas.count, 2);
  const betas = await listKgNodes({ project_id: pid, label_prefix: "beta" });
  assert.equal(betas.count, 1);
});

test("L3: listKgEdges filtered by relation", async () => {
  const pid = newProject();
  const a = await upsertKgNode({ project_id: pid, type: "n", label: "a", embedding: unitVector(31) });
  const b = await upsertKgNode({ project_id: pid, type: "n", label: "b", embedding: unitVector(32) });
  const c = await upsertKgNode({ project_id: pid, type: "n", label: "c", embedding: unitVector(33) });
  assert.ok(a.ok && b.ok && c.ok);
  if (!a.ok || !b.ok || !c.ok) return;
  await upsertKgEdge({ project_id: pid, source_id: a.node_id, target_id: b.node_id, relation: "mentions" });
  await upsertKgEdge({ project_id: pid, source_id: a.node_id, target_id: c.node_id, relation: "depends_on" });
  await upsertKgEdge({ project_id: pid, source_id: b.node_id, target_id: c.node_id, relation: "mentions" });

  const mentions = await listKgEdges({ project_id: pid, relation: "mentions" });
  assert.equal(mentions.count, 2);
  assert.ok(mentions.results.every((r) => r.relation === "mentions"));

  const fromA = await listKgEdges({ project_id: pid, source_id: a.node_id });
  assert.equal(fromA.count, 2);
});
