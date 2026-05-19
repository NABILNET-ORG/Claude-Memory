// GUI server contract tests — exercise every route with stubbed M7 handlers
// so the suite stays hermetic (no Supabase, no Ollama, no real DB).
//
// Strategy: spin up createGuiServer() against a fresh port for each suite,
// fetch real HTTP requests, assert the wire shape + status code + payload.
// Stub handlers record their last call so we can verify the server forwards
// inputs faithfully.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import {
  createGuiServer,
  GUI_VERSION,
  type GuiHandlers,
} from "../src/gui/server.js";
import type {
  ListGraduationCandidatesInput,
  ComposeGlobalRationaleInput,
  ConfirmPromotionInput,
  RejectGraduationInput,
  GraduationListRow,
} from "../src/tools/graduation.js";

type StubState = {
  lastListInput?: ListGraduationCandidatesInput;
  lastComposeInput?: ComposeGlobalRationaleInput;
  lastConfirmInput?: ConfirmPromotionInput;
  lastRejectInput?: RejectGraduationInput;
};

function makeHandlers(state: StubState, rows: GraduationListRow[]): GuiHandlers {
  return {
    listGraduationCandidates: async (input) => {
      state.lastListInput = input;
      return { count: rows.length, results: rows };
    },
    composeGlobalRationale: async (input) => {
      state.lastComposeInput = input;
      return {
        ok: true,
        graduation_id: input.graduation_id,
        state: "composed",
        composed_at: new Date().toISOString(),
      };
    },
    confirmPromotion: async (input) => {
      state.lastConfirmInput = input;
      return {
        ok: true,
        graduation_id: input.graduation_id,
        promoted_global_skill_id: 999,
        decided_at: new Date().toISOString(),
      };
    },
    rejectGraduation: async (input) => {
      state.lastRejectInput = input;
      return {
        ok: true,
        graduation_id: input.graduation_id,
        state: "rejected",
        decided_at: new Date().toISOString(),
      };
    },
  };
}

const SAMPLE_ROW: GraduationListRow = {
  id: 1,
  project_id: "alpha",
  source_skill_id: 42,
  state: "proposed",
  frequency_at_propose: 12,
  success_rate_at_propose: 0.95,
  age_days_at_propose: 18,
  proposed_global_rationale: null,
  cross_project_verdict: null,
  decided_at: null,
  created_at: new Date().toISOString(),
};

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

describe("gui server — health + static", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = {};

  before(async () => {
    const handlers = makeHandlers(state, []);
    const started = await startTestServer(handlers);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("GET / returns the dashboard HTML from public/index.html", async () => {
    const r = await fetch(`${baseUrl}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const body = await r.text();
    // Anchors that should survive future cosmetic edits to index.html.
    assert.match(body, /<title>Smart Claude Memory/);
    assert.match(body, /M7 GRADUATIONS/);
  });

  it("GET /style.css returns CSS with text/css content-type", async () => {
    const r = await fetch(`${baseUrl}/style.css`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/css/);
    const body = await r.text();
    assert.ok(body.length > 0, "style.css body should not be empty");
  });

  it("GET /app.js returns JS with application/javascript content-type", async () => {
    const r = await fetch(`${baseUrl}/app.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /application\/javascript/);
    const body = await r.text();
    assert.ok(body.length > 0, "app.js body should not be empty");
  });

  it("GET /missing-asset.png returns 404 with ok:false", async () => {
    const r = await fetch(`${baseUrl}/missing-asset.png`);
    assert.equal(r.status, 404);
    const body = (await r.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "not_found");
  });

  it("blocks URL-encoded path traversal (%2E%2E%2F → ../)", async () => {
    // Real-world traversal attack vector: percent-encode ../ to skirt naive
    // prefix checks. serveStatic decodes then checks containment via path.relative.
    const r = await fetch(`${baseUrl}/%2E%2E%2Fpackage.json`);
    assert.equal(r.status, 404);
    const body = (await r.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "not_found");
  });

  it("GET /api/health returns ok:true and a version", async () => {
    const r = await fetch(`${baseUrl}/api/health`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean; service: string; version: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "scm-gui");
    assert.equal(body.version, GUI_VERSION);
  });

  it("GET /unknown returns 404 with ok:false", async () => {
    const r = await fetch(`${baseUrl}/nope`);
    assert.equal(r.status, 404);
    const body = (await r.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "not_found");
  });

  it("response carries hardened security headers", async () => {
    const r = await fetch(`${baseUrl}/api/health`);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  });
});

describe("gui server — list route", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = {};

  before(async () => {
    const handlers = makeHandlers(state, [SAMPLE_ROW]);
    const started = await startTestServer(handlers);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("forwards query params to listGraduationCandidates", async () => {
    const r = await fetch(`${baseUrl}/api/graduations?project_id=alpha&state=proposed&k=5&offset=2`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { count: number; results: unknown[] };
    assert.equal(body.count, 1);
    assert.equal(body.results.length, 1);
    assert.deepEqual(state.lastListInput, {
      project_id: "alpha",
      state: "proposed",
      k: 5,
      offset: 2,
    });
  });

  it("rejects invalid state filter silently (no crash)", async () => {
    const r = await fetch(`${baseUrl}/api/graduations?state=bogus`);
    assert.equal(r.status, 200);
    assert.equal(state.lastListInput?.state, undefined);
  });

  it("supports an empty query string", async () => {
    const r = await fetch(`${baseUrl}/api/graduations`);
    assert.equal(r.status, 200);
    assert.deepEqual(state.lastListInput, {});
  });
});

describe("gui server — mutation routes", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = {};

  before(async () => {
    const handlers = makeHandlers(state, [SAMPLE_ROW]);
    const started = await startTestServer(handlers);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("POST /api/graduations/:id/confirm forwards graduation_id", async () => {
    const r = await fetch(`${baseUrl}/api/graduations/7/confirm`, { method: "POST" });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean; graduation_id: number };
    assert.equal(body.ok, true);
    assert.equal(body.graduation_id, 7);
    assert.equal(state.lastConfirmInput?.graduation_id, 7);
  });

  it("POST /api/graduations/:id/reject forwards id + reason from JSON body", async () => {
    const r = await fetch(`${baseUrl}/api/graduations/9/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "duplicate" }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean };
    assert.equal(body.ok, true);
    assert.deepEqual(state.lastRejectInput, { graduation_id: 9, reason: "duplicate" });
  });

  it("POST /api/graduations/:id/compose forwards all compose fields", async () => {
    const r = await fetch(`${baseUrl}/api/graduations/11/compose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verdict: "pass",
        evidence: "ev",
        global_rationale: "this is a universal pattern",
        model: "test:model",
      }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(state.lastComposeInput, {
      graduation_id: 11,
      verdict: "pass",
      evidence: "ev",
      global_rationale: "this is a universal pattern",
      model: "test:model",
    });
  });

  it("coerces invalid verdict to 'fail' (server-side defensive)", async () => {
    const r = await fetch(`${baseUrl}/api/graduations/12/compose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "garbage", evidence: "ev", model: "m" }),
    });
    assert.equal(r.status, 200);
    assert.equal(state.lastComposeInput?.verdict, "fail");
  });
});

describe("gui server — failure surface", () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  before(async () => {
    const failingHandlers: GuiHandlers = {
      listGraduationCandidates: async () => {
        throw new Error("db unreachable");
      },
      composeGlobalRationale: async (input) => ({
        ok: false,
        reason: "compose_evidence_required",
        state_unchanged: true,
        graduation_id: input.graduation_id,
      }),
      confirmPromotion: async () => ({ ok: false, reason: "graduation_not_found" }),
      rejectGraduation: async () => ({ ok: false, reason: "invalid_state_transition" }),
    };
    const started = await startTestServer(failingHandlers);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("returns 500 when a handler throws (no leaked stack)", async () => {
    const r = await fetch(`${baseUrl}/api/graduations`);
    assert.equal(r.status, 500);
    const body = (await r.json()) as { ok: boolean; reason: string; detail: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "server_error");
    assert.equal(body.detail, "db unreachable");
  });

  it("returns 400 when handler returns ok:false", async () => {
    const r = await fetch(`${baseUrl}/api/graduations/5/confirm`, { method: "POST" });
    assert.equal(r.status, 400);
    const body = (await r.json()) as { ok: boolean; reason: string };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "graduation_not_found");
  });

  it("returns 400 when reject handler refuses", async () => {
    const r = await fetch(`${baseUrl}/api/graduations/5/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "x" }),
    });
    assert.equal(r.status, 400);
    const body = (await r.json()) as { ok: boolean; reason: string };
    assert.equal(body.reason, "invalid_state_transition");
  });
});

describe("gui server — token auth", () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  const state: StubState = {};
  const TOKEN = "test-token-abc";

  before(async () => {
    const handlers = makeHandlers(state, [SAMPLE_ROW]);
    const started = await startTestServer(handlers, TOKEN);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  it("rejects mutation route without token (401)", async () => {
    const r = await fetch(`${baseUrl}/api/graduations/1/confirm`, { method: "POST" });
    assert.equal(r.status, 401);
    const body = (await r.json()) as { reason: string };
    assert.equal(body.reason, "unauthorized");
  });

  it("rejects list route without token (401)", async () => {
    const r = await fetch(`${baseUrl}/api/graduations`);
    assert.equal(r.status, 401);
  });

  it("accepts mutation route with correct token", async () => {
    const r = await fetch(`${baseUrl}/api/graduations/2/confirm`, {
      method: "POST",
      headers: { "x-scm-gui-token": TOKEN },
    });
    assert.equal(r.status, 200);
  });

  it("health endpoint stays open even with token configured", async () => {
    const r = await fetch(`${baseUrl}/api/health`);
    assert.equal(r.status, 200);
  });

  it("root HTML stays open even with token configured", async () => {
    const r = await fetch(`${baseUrl}/`);
    assert.equal(r.status, 200);
  });

  it("static assets stay open even with token configured", async () => {
    // Stylesheets and scripts loaded by the dashboard can't send a custom
    // token header — they must remain unauthenticated. Token guards /api/* only.
    const css = await fetch(`${baseUrl}/style.css`);
    assert.equal(css.status, 200);
    const js = await fetch(`${baseUrl}/app.js`);
    assert.equal(js.status, 200);
  });
});
