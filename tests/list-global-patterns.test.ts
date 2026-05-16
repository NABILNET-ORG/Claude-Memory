// Unit tests for src/tools/list-global-patterns.ts — browse-only MCP tool
// over the reserved 'GLOBAL' project_id.
//
// Runtime: node:test + node:assert/strict (Node 24+, loaded via tsx).
//
// Test isolation: the stub commit (Task 4) tests only the contract shape
// — empty result envelope. Real DB tests land in Task 5 once the SELECT
// is implemented.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { listGlobalPatterns } from "../src/tools/list-global-patterns.js";

describe("listGlobalPatterns — stub contract", () => {
  test("returns the empty-result envelope when no rows match", async () => {
    const result = await listGlobalPatterns({});
    assert.equal(result.project_id, "GLOBAL");
    assert.equal(result.count, 0);
    assert.deepEqual(result.results, []);
    assert.equal(result.summary, "GLOBAL vault is empty.");
  });

  test("echoes pagination args in the response", async () => {
    const result = await listGlobalPatterns({ limit: 25, offset: 0 });
    assert.equal(result.limit, 25);
    assert.equal(result.offset, 0);
  });

  test("clamps limit > 50 down to 50", async () => {
    const result = await listGlobalPatterns({ limit: 100 });
    assert.equal(result.limit, 50);
  });

  test("defaults limit to 10 when omitted", async () => {
    const result = await listGlobalPatterns({});
    assert.equal(result.limit, 10);
  });
});
