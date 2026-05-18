// M8.1 Phase 2 — GUI /api/graph endpoint contract tests.
//
// Spins up createGuiServer() against a fresh port for each suite. Stubs the
// listKgNodes / listKgEdges handlers via the GuiHandlers seam so the suite
// stays hermetic (no Supabase). Verifies param clamping, edge filtering,
// type breakdown, token gate, and failure surface.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import {
  createGuiServer,
  type GuiHandlers,
} from "../src/gui/server.js";
import type {
  ListGraduationCandidatesInput,
  ComposeGlobalRationaleInput,
  ConfirmPromotionInput,
  RejectGraduationInput,
} from "../src/tools/graduation.js";
import type {
  ListKgNodesInput,
  ListKgEdgesInput,
  KgNodeRow,
  KgEdgeRow,
} from "../src/tools/kg.js";

type StubState = {
  lastNodesInput?: ListKgNodesInput;
  lastEdgesInput?: ListKgEdgesInput;
  nodes: KgNodeRow[];
  edges: KgEdgeRow[];
  nodesFailure?: { ok: false; reason: string };
  edgesFailure?: { ok: false; reason: string };
  nodesThrow?: Error;
};

function emptyGraduationHandlers(): Pick<
  GuiHandlers,
  "listGraduationCandidates" | "composeGlobalRationale" | "confirmPromotion" | "rejectGraduation"
> {
  return {
    listGraduationCandidates: async (_input: ListGraduationCandidatesInput) => ({
      count: 0,
      results: [],
    }),
    composeGlobalRationale: async (input: ComposeGlobalRationaleInput) => ({
      ok: true,
      graduation_id: input.graduation_id,
      state: "composed",
      composed_at: new Date().toISOString(),
    }),
    confirmPromotion: async (input: ConfirmPromotionInput) => ({
      ok: true,
      graduation_id: input.graduation_id,
      promoted_global_skill_id: 1,
      decided_at: new Date().toISOString(),
    }),
    rejectGraduation: async (input: RejectGraduationInput) => ({
      ok: true,
      graduation_id: input.graduation_id,
      state: "rejected",
      decided_at: new Date().toISOString(),
    }),
  };
}

function makeHandlers(state: StubState): GuiHandlers {
  return {
    ...emptyGraduationHandlers(),
    listKgNodes: async (input: ListKgNodesInput) => {
      state.lastNodesInput = input;
      if (state.nodesThrow) throw state.nodesThrow;
      if (state.nodesFailure) return state.nodesFailure;
      return { count: state.nodes.length, results: state.nodes };
    },
    listKgEdges: async (input: ListKgEdgesInput) => {
      state.lastEdgesInput = input;
      if (state.edgesFailure) return state.edgesFailure;
      return { count: state.edges.length, results: state.edges };
    },
  };
}

function makeNode(overrides: Partial<KgNodeRow> & { id: number }): KgNodeRow {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    project_id: overrides.project_id ?? "claude-memory",
    type: overrides.type ?? "NOTE",
    label: overrides.label ?? `node-${overrides.id}`,
    properties: overrides.properties ?? {},
    source_chunk_id: overrides.source_chunk_id ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

function makeEdge(overrides: Partial<KgEdgeRow> & { id: number; source_id: number; target_id: number }): KgEdgeRow {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    project_id: overrides.project_id ?? "claude-memory",
    source_id: overrides.source_id,
    target_id: overrides.target_id,
    relation: overrides.relation ?? "RELATES_TO",
    weight: overrides.weight ?? 1.0,
    properties: overrides.properties ?? {},
    created_at: overrides.created_at ?? now,
  };
}

async function startTestServer(handlers: GuiHandlers, token: string | null = null) {
  const server = createGuiServer({ handlers, token });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ─── empty graph ──────────────────────────────────────────────────────────

describe("gui /api/graph — empty graph", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = { nodes: [], edges: [] };

  before(async () => {
    const started = await startTestServer(makeHandlers(state));
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("returns 200 with empty nodes/edges and zero stats", async () => {
    const r = await fetch(`${baseUrl}/api/graph`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      ok: boolean;
      project_id: string;
      nodes: unknown[];
      edges: unknown[];
      stats: { node_count: number; edge_count: number; type_breakdown: Record<string, number> };
    };
    assert.equal(body.ok, true);
    assert.deepEqual(body.nodes, []);
    assert.deepEqual(body.edges, []);
    assert.equal(body.stats.node_count, 0);
    assert.equal(body.stats.edge_count, 0);
    assert.deepEqual(body.stats.type_breakdown, {});
  });
});

// ─── param clamping ───────────────────────────────────────────────────────

describe("gui /api/graph — param clamping", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = { nodes: [], edges: [] };

  before(async () => {
    const started = await startTestServer(makeHandlers(state));
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("passes valid node_limit=200, edge_limit=500 through unchanged", async () => {
    const r = await fetch(`${baseUrl}/api/graph?node_limit=200&edge_limit=500`);
    assert.equal(r.status, 200);
    assert.equal(state.lastNodesInput?.k, 200);
    assert.equal(state.lastEdgesInput?.k, 500);
    const body = (await r.json()) as { params: { node_limit: number; edge_limit: number } };
    assert.equal(body.params.node_limit, 200);
    assert.equal(body.params.edge_limit, 500);
  });

  it("clamps node_limit=999 to 200", async () => {
    const r = await fetch(`${baseUrl}/api/graph?node_limit=999`);
    assert.equal(r.status, 200);
    assert.equal(state.lastNodesInput?.k, 200);
  });

  it("clamps node_limit=0 to 1", async () => {
    const r = await fetch(`${baseUrl}/api/graph?node_limit=0`);
    assert.equal(r.status, 200);
    assert.equal(state.lastNodesInput?.k, 1);
  });

  it("clamps edge_limit=-5 to 1 (lower bound)", async () => {
    const r = await fetch(`${baseUrl}/api/graph?edge_limit=-5`);
    assert.equal(r.status, 200);
    assert.equal(state.lastEdgesInput?.k, 1);
  });

  it("forwards type filter to listKgNodes", async () => {
    const r = await fetch(`${baseUrl}/api/graph?type=FILE`);
    assert.equal(r.status, 200);
    assert.equal(state.lastNodesInput?.type, "FILE");
  });

  it("forwards label_prefix filter to listKgNodes", async () => {
    const r = await fetch(`${baseUrl}/api/graph?label_prefix=auth`);
    assert.equal(r.status, 200);
    assert.equal(state.lastNodesInput?.label_prefix, "auth");
  });
});

// ─── edge filtering ───────────────────────────────────────────────────────

describe("gui /api/graph — edge filtering", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = {
    nodes: [makeNode({ id: 1, type: "DECISION" }), makeNode({ id: 2, type: "FILE" })],
    edges: [
      makeEdge({ id: 10, source_id: 1, target_id: 2, relation: "MENTIONS" }),
      // dangling edge — source 1 exists, target 999 NOT in node set:
      makeEdge({ id: 11, source_id: 1, target_id: 999, relation: "REFERENCES" }),
      // double-dangling:
      makeEdge({ id: 12, source_id: 888, target_id: 999, relation: "RELATES_TO" }),
    ],
  };

  before(async () => {
    const started = await startTestServer(makeHandlers(state));
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("drops edges whose endpoints are not in the node set", async () => {
    const r = await fetch(`${baseUrl}/api/graph`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      ok: boolean;
      edges: Array<{ id: number }>;
      stats: { node_count: number; edge_count: number };
    };
    assert.equal(body.edges.length, 1);
    assert.equal(body.edges[0].id, 10);
    assert.equal(body.stats.edge_count, 1);
    assert.equal(body.stats.node_count, 2);
  });
});

// ─── type breakdown ───────────────────────────────────────────────────────

describe("gui /api/graph — stats.type_breakdown", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = {
    nodes: [
      makeNode({ id: 1, type: "DECISION" }),
      makeNode({ id: 2, type: "DECISION" }),
      makeNode({ id: 3, type: "PATTERN" }),
      makeNode({ id: 4, type: "FILE" }),
    ],
    edges: [],
  };

  before(async () => {
    const started = await startTestServer(makeHandlers(state));
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("counts node types correctly", async () => {
    const r = await fetch(`${baseUrl}/api/graph`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      stats: { type_breakdown: Record<string, number> };
    };
    assert.equal(body.stats.type_breakdown.DECISION, 2);
    assert.equal(body.stats.type_breakdown.PATTERN, 1);
    assert.equal(body.stats.type_breakdown.FILE, 1);
  });
});

// ─── failure surface ──────────────────────────────────────────────────────

describe("gui /api/graph — failure surface", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = {
    nodes: [],
    edges: [],
    nodesFailure: { ok: false, reason: "list_kg_nodes_db_error" },
  };

  before(async () => {
    const started = await startTestServer(makeHandlers(state));
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("returns 500 with {ok:false, reason} when listKgNodes returns ok:false", async () => {
    const r = await fetch(`${baseUrl}/api/graph`);
    assert.equal(r.status, 500);
    const body = (await r.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "list_kg_nodes_db_error");
  });
});

describe("gui /api/graph — handler throw", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = {
    nodes: [],
    edges: [],
    nodesThrow: new Error("supabase unreachable"),
  };

  before(async () => {
    const started = await startTestServer(makeHandlers(state));
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("returns 500 with the thrown error message when handler throws", async () => {
    const r = await fetch(`${baseUrl}/api/graph`);
    assert.equal(r.status, 500);
    const body = (await r.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "supabase unreachable");
  });
});

// ─── token gate ───────────────────────────────────────────────────────────

describe("gui /api/graph — token gate", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = { nodes: [], edges: [] };
  const TOKEN = "graph-token-xyz";

  before(async () => {
    const started = await startTestServer(makeHandlers(state), TOKEN);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("returns 401 when no token header is sent", async () => {
    const r = await fetch(`${baseUrl}/api/graph`);
    assert.equal(r.status, 401);
    const body = (await r.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "unauthorized");
  });

  it("returns 200 when correct token header is sent", async () => {
    const r = await fetch(`${baseUrl}/api/graph`, {
      headers: { "x-scm-gui-token": TOKEN },
    });
    assert.equal(r.status, 200);
  });
});

// ─── dashboard panel wired in ─────────────────────────────────────────────

describe("dashboard HTML — graph panel wired in", () => {
  it("DASHBOARD_HTML contains graph panel hooks", async () => {
    const { DASHBOARD_HTML } = await import("../src/gui/static.js");
    assert.match(DASHBOARD_HTML, /graph-panel/);
    assert.match(DASHBOARD_HTML, /graph-svg/);
    assert.match(DASHBOARD_HTML, /loadGraph/);
  });
});
