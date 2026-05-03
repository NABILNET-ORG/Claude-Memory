import { promises as fs } from "node:fs";
import path from "node:path";

export const SOVEREIGN_CONSTITUTION_TEMPLATE = `---

## Sovereign Memory Protocol

This repository is bound to the Smart Claude Memory (SCM) Sovereign Memory Protocol. The agent operating here MUST follow these rules. They take precedence over generic boot prompts when in conflict.

### Key Definitions

- **SCM** = Smart-Claude-Memory MCP — the canonical shorthand used throughout this protocol and in all sovereign-bound repositories.

### Sovereign Taxonomy

Every \`save_memory\` call MUST set \`metadata.type\` to one of:

- \`DECISION\` — architectural choices + rationale
- \`PATTERN\` — code standards / cross-project conventions
- \`ERROR\` — bug post-mortems + fixes
- \`LOG\` — general session progress

Saves without a type lose the GIN-indexed pre-filter and become harder to retrieve.

### Rule 10 — Sovereign Vetting (runtime-enforced)

Setting \`metadata.is_global: true\` routes the row to \`project_id='GLOBAL'\`. The server REJECTS any global save whose \`metadata.global_rationale\` is missing, non-string, or under 10 trimmed characters with the error \`SOVEREIGN VETTING FAILED: ...\`. There is no soft path — provide a real rationale or keep the memory local.

**Cross-Project Test.** A memory qualifies as \`is_global\` only if: *with the current project deleted tomorrow, would this entry still be a gold-standard reference for other projects?* If no, keep it local.

### Proactive Sovereign Scout (active behavior)

The agent is not a passive storage handler — it actively scouts for global candidates. Whenever a session produces a major architectural decision, a branding change, or a universal bug fix, the agent MUST evaluate the work against the Cross-Project Test before closing the task or session. If it passes, the agent proposes promotion in this exact form before saving:

> "This looks like a Global Candidate. Should I save it to the GLOBAL vault? If so, I suggest this rationale: *[one- or two-sentence rationale tied to the universal truth]*."

The agent never writes to GLOBAL silently — promotion always waits on user confirmation.

### SCM Tool Conventions

- \`init_project()\` — first call of every session; verifies env, hook, MCP registration, dist, Core 3 sync, and binds this repo to the Sovereign Memory Protocol.
- \`sync_local_memory()\` — second call; aligns the vector DB with local notes (incremental, hash-gated).
- \`search_memory({ query, metadata_filter })\` — typed retrieval; default dual-scope (project + GLOBAL).
- \`save_memory({ content, metadata: { type } })\` — typed write; never set \`is_global: true\` without \`global_rationale\`.
- \`manage_backlog({ action: "session_end" })\` — session close; flushes backlog, regenerates diagrams, runs \`sync_artefacts\`, and emits \`next_session_command_markdown\` for the next boot.
- Mandatory delegation: any read-heavy investigation > 3 files OR > 100 lines of raw output goes through \`delegate_task\` with a 2-paragraph synthesis request.

### Session Handoff Protocol — Atomic Wrap-Up Ritual

At the end of every session, the Agent MUST execute these steps in order. No partial wrap-up.

**1. Mandatory Detailed Report.** Before calling \`manage_backlog({ action: "session_end" })\`, the Agent MUST write a comprehensive narrative report to \`docs/session-reports/SESSION-N-REPORT.md\` (where N is the current session number). The report MUST include:
- Summary of all code changes (files touched, what changed, why).
- Technical hurdles encountered and how they were solved.
- Logical decisions made, referencing DECISION IDs from \`save_memory\`.

**2. Mandatory Auto-Commit.** The Agent MUST stage and commit all session changes using the exact commit message format: \`session: wrap-up Session [N]\`. No session ends with uncommitted work in the tree.

**3. Dynamic Numbering.** Detect the current session number from the latest report (highest \`SESSION-N-REPORT.md\` in \`docs/session-reports/\`) and increment it for the next-session block (e.g., if current is Session 3, next is Session 4).

**4. Next Session Command — final output.** The block below MUST be the absolute final output of the session, formatted exactly as:

\`\`\`
🚀 NEXT SESSION START COMMAND (Copy-Paste)

init_project()
search_memory({ query: "Active Backlog", project_id: "[current_project_id]", k: 10 })
# Then read docs/NEXT-SESSION-PROMPT.md for the full Session [N+1] plan.
\`\`\`

---
`;

export type SovereignConstitutionResult =
  | { action: "created"; path: string; marker_present: true }
  | { action: "appended"; path: string; marker_present: true }
  | { action: "present"; path: string; marker_present: true }
  | { action: "error"; path: string; marker_present: false; error: string };

export async function ensureSovereignConstitution(
  workspace: string,
): Promise<SovereignConstitutionResult> {
  const claudeMdPath = path.join(workspace, "CLAUDE.md");
  try {
    let existing: string | null;
    try {
      existing = await fs.readFile(claudeMdPath, "utf8");
    } catch (readErr) {
      const code = (readErr as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        existing = null;
      } else {
        throw readErr;
      }
    }

    if (existing === null) {
      const body = `# CLAUDE.md\n\n${SOVEREIGN_CONSTITUTION_TEMPLATE}\n`;
      await fs.writeFile(claudeMdPath, body, "utf8");
      return { action: "created", path: claudeMdPath, marker_present: true };
    }

    if (existing.includes("Sovereign Memory Protocol")) {
      return { action: "present", path: claudeMdPath, marker_present: true };
    }

    const needsLeadingBlank = !existing.endsWith("\n\n");
    const prefix = existing.endsWith("\n")
      ? (needsLeadingBlank ? "\n" : "")
      : "\n\n";
    const appended = existing + prefix + SOVEREIGN_CONSTITUTION_TEMPLATE + "\n";
    await fs.writeFile(claudeMdPath, appended, "utf8");
    return { action: "appended", path: claudeMdPath, marker_present: true };
  } catch (err) {
    const message = (err as { message?: string })?.message ?? String(err);
    return {
      action: "error",
      path: claudeMdPath,
      marker_present: false,
      error: String(message),
    };
  }
}
