// Sleep Learning — LLM proposer (Agentic OS 2026 / Mission 3 / SCM-S19-D1).
// Takes a mined CandidateStub, asks Ollama for a JSON-mode proposal of
// { name, steps: [...] }. Mirrors src/trajectory/summarizer.ts post-processing
// (preamble strip + defensive JSON parse) — the model occasionally prepends
// "Here is the JSON:" or fence markers despite the JSON-only instruction.
//
// NO side effects: returns the proposal, daemon decides what to do with it.

import { chat } from "../ollama.js";
import type { CandidateStub } from "./miner.js";

const DEFAULT_MODEL = process.env.OLLAMA_PROPOSER_MODEL ?? "gemma3:e2b";

const SYSTEM_PROMPT =
  "You are a Skill Proposer. You receive several related trajectory summaries describing a recurring successful task. " +
  "Produce a single executable Skill spec that captures the common pattern. " +
  "Output strictly JSON, no markdown, no preamble, no fences. Schema: " +
  "{\"name\": string (kebab-case, ≤ 60 chars), \"steps\": [{\"step\": number, \"action\": string}, ...]}. " +
  "Steps must be ordered, concrete, and executable verbatim by an agent. " +
  "Do not invent steps the source summaries do not support. Do not include explanations.";

const USER_PREFIX =
  "Cluster of related successful trajectory summaries (each line one summary):\n\n";

const USER_SUFFIX =
  "\n\nReturn the JSON spec describing the recurring skill. JSON ONLY.";

// Mirrors summarizer.ts:14 — same preamble shapes, plus fence markers.
const JSON_PREAMBLE_REGEX =
  /^(?:json|here(?:'s| is)(?:\s+(?:the|a))?(?:\s+json)?|the\s+(?:spec|json|skill))\s*[:\-—]?\s*/i;

const FENCE_RE = /```(?:json|JSON)?\s*([\s\S]*?)```/;

export type SkillProposal = {
  proposed_name: string;
  proposed_steps: unknown;
  model: string;
};

export type ProposerOptions = {
  model?: string;
  timeoutMs?: number;
};

function clusterToPrompt(stub: CandidateStub): string {
  // Cap at 8 summaries — preserves diversity but keeps the prompt under
  // ~2k tokens for the small (gemma3:e2b) model.
  const lines = stub.cluster_summaries.slice(0, 8).map((s, i) => `${i + 1}. ${s}`);
  return `${USER_PREFIX}${lines.join("\n")}${USER_SUFFIX}`;
}

function stripPreamble(raw: string): string {
  let s = raw.trim();
  // Strip fences first if present.
  const fence = s.match(FENCE_RE);
  if (fence && fence[1]) s = fence[1].trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(JSON_PREAMBLE_REGEX, "").trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Pull the first balanced JSON object from a string. The proposer is
 * instructed to emit JSON-only, but small models sometimes append a
 * trailing comment — this rescues those cases without a full parser.
 */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function fallbackName(stub: CandidateStub): string {
  // Derive a name from the representative summary's first 8 tokens.
  const tokens = stub.representative_summary.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const head = tokens.slice(0, 8).join(" ");
  const slug = slugify(head) || `pattern-${stub.pattern_hash.slice(0, 8)}`;
  return `auto-${slug}`;
}

function normalizeSteps(raw: unknown, stub: CandidateStub): unknown {
  if (Array.isArray(raw) && raw.length > 0) return raw;
  // Last-ditch fallback: one step that just records the recurring pattern.
  // This is rare (the model occasionally returns {steps: null}) but keeps
  // the daemon idempotent — we still produce a candidate row.
  return [
    {
      step: 1,
      action: `Recurring pattern from ${stub.frequency} successful tasks: ${stub.representative_summary.slice(0, 200)}`,
    },
  ];
}

export async function proposeSkill(
  stub: CandidateStub,
  opts: ProposerOptions = {},
): Promise<SkillProposal> {
  const model = opts.model ?? DEFAULT_MODEL;
  const user = clusterToPrompt(stub);

  let raw: string;
  try {
    raw = await chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      {
        model,
        temperature: 0.2,
        timeoutMs: opts.timeoutMs ?? 60_000,
      },
    );
  } catch (e) {
    // If the model is unreachable we still produce a usable candidate so
    // the curator can review/promote/reject — better than dropping the
    // cluster on the floor.
    return {
      proposed_name: fallbackName(stub),
      proposed_steps: normalizeSteps(null, stub),
      model,
    };
  }

  const stripped = stripPreamble(raw);
  const objectText = extractFirstJsonObject(stripped) ?? stripped;

  let parsed: { name?: unknown; steps?: unknown } | null = null;
  try {
    const candidate = JSON.parse(objectText);
    if (candidate && typeof candidate === "object") {
      parsed = candidate as { name?: unknown; steps?: unknown };
    }
  } catch {
    parsed = null;
  }

  const name =
    parsed && typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? slugify(parsed.name) || fallbackName(stub)
      : fallbackName(stub);

  const steps = normalizeSteps(parsed?.steps, stub);

  return { proposed_name: name, proposed_steps: steps, model };
}
