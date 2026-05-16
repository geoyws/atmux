// ADR-050 §Brief generator (Tier 2 fallback): compose the cage brief
// that the Tier 2 cursor-agent receives at spawn time.
//
// Per ADR-050 §Brief generator (verbatim):
//   1. The member's pre-pause in-progress Task body
//   2. The member's brief template (templates/briefs/<role>.md)
//   3. Tier-2-specific guardrails inserted at top
//   4. Recent `git log --oneline -10` of the branch
//   5. Recent `.atmux/lead-outbox.md` tail (last 50 lines)
//
// Brief written to `<atmuxDir>/state/fallback-brief-<member>.md`;
// the cage spawn (src/abstractions/fallback-cage.ts) pipes it as the
// initial prompt to `cursor-agent --print`.
//
// **Pure-of-direct-IO**: every file read + git invocation is
// injectable via the `deps` parameter for unit testing. Production
// callers pass nothing → defaults route through `Bun.file` /
// `runSpawn` / `loadInbox`. The only side effect is the final
// `Bun.write` of the assembled brief to the state dir; tests pin
// the output path via `deps.atmuxDir`.

import { join } from "node:path";

import { readTextOrNull } from "../abstractions/fs.ts";
import { spawn as runSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { loadInbox } from "./inbox.ts";

/** Options for {@link composeFallbackBrief}. Mirrors the ADR-050
 *  §Brief generator inputs verbatim; every reader-shaped dep is
 *  injectable for unit tests. */
export interface ComposeFallbackBriefOpts {
  /** Member name whose pre-pause Task we're composing for. */
  member: string;
  /** Member's role — used to resolve the brief template path
   *  (`templates/briefs/<role>.md`). */
  role: string;
  /** Atmux dir (the `.atmux/` parent). Used to resolve the state-
   *  dir output path + the lead-outbox tail. */
  atmuxDir: string;
  /** Absolute path to the team's project root (for `git -C`). */
  projectRoot: string;
  /** Resolved at cage-create time — embedded in the Tier-2
   *  guardrails preface so the cursor-agent sees who it's pretending
   *  to be. */
  agent: string;
  /** Templates dir — usually `templates/briefs/` resolved from the
   *  atmux install. Tests pin to a tmpdir. */
  templatesDir: string;
  /** Optional: override the in-progress task body lookup. When
   *  unset, reads from `loadInbox(atmuxDir, member).inProgress[0]`
   *  via the canonical SQLite path. Tests pin directly to skip the
   *  state.db load. */
  taskBody?: string;
  /** Optional injection: git log lines reader. Default shells
   *  `git -C <projectRoot> log --oneline -10`. Tests pass a
   *  deterministic line list. */
  gitLog?: (projectRoot: string) => Promise<string[]>;
  /** Optional injection: brief-template reader. Default reads
   *  `templates/briefs/<role>.md`. Tests pass a fixed string. */
  readTemplate?: (templatesDir: string, role: string) => Promise<string | null>;
  /** Optional injection: lead-outbox tail reader. Default reads the
   *  last 50 lines of `<atmuxDir>/lead-outbox.md`. */
  readLeadOutboxTail?: (atmuxDir: string, lines: number) => Promise<string>;
  /** Optional injection: writer for the assembled brief. Default
   *  writes to `<atmuxDir>/state/fallback-brief-<member>.md` via
   *  `Bun.write`. Tests pass a recorder to assert the path + body. */
  writeBrief?: (path: string, body: string) => Promise<void>;
}

/** Result of a brief composition — the on-disk path + the assembled
 *  body (returned for caller-side logging / surface). */
export interface ComposeFallbackBriefResult {
  /** Absolute path of the written brief file. */
  path: string;
  /** Full assembled brief body (same content that was written to
   *  disk). Exposed so the caller can log a hash / tail to the
   *  audit log without re-reading. */
  body: string;
}

/** Resolved brief file path (`<atmuxDir>/state/fallback-brief-
 *  <member>.md`). Exported for non-composer call sites (cage
 *  cleanup, audit-log writers) that need to address the same path. */
export function fallbackBriefPath(atmuxDir: string, member: string): string {
  return join(atmuxDir, "state", `fallback-brief-${member}.md`);
}

/** Default git log reader: shells `git -C <projectRoot> log
 *  --oneline -10`. Fail-soft: any non-zero exit (missing .git,
 *  detached worktree, etc.) collapses to empty result so the brief
 *  composition still produces a coherent file. */
async function defaultGitLog(projectRoot: string): Promise<string[]> {
  try {
    const r: SpawnResult = await runSpawn({
      cmd: "git",
      argv: ["-C", projectRoot, "log", "--oneline", "-10"],
      expectExitCode: "any",
      timeoutMs: 5000,
    });
    if (r.exitCode !== 0) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/** Default brief-template reader. Returns null when the template
 *  doesn't exist (allowed — composer falls back to a one-line note
 *  noting the missing template). */
async function defaultReadTemplate(
  templatesDir: string,
  role: string,
): Promise<string | null> {
  const path = join(templatesDir, `${role}.md`);
  return await readTextOrNull(path);
}

/** Default lead-outbox tail reader: returns the last `lines` lines
 *  of `<atmuxDir>/lead-outbox.md`, or empty string when the file
 *  doesn't exist. */
async function defaultReadLeadOutboxTail(
  atmuxDir: string,
  lines: number,
): Promise<string> {
  const path = join(atmuxDir, "lead-outbox.md");
  const text = await readTextOrNull(path);
  if (text === null || text.length === 0) return "";
  const all = text.split("\n");
  const start = Math.max(0, all.length - lines);
  return all.slice(start).join("\n");
}

/** Default writer: ensures the state dir exists, then writes the
 *  brief via `Bun.write`. */
async function defaultWriteBrief(path: string, body: string): Promise<void> {
  // Bun.write creates the parent dir transparently when it's a
  // BunFile target — but to be defensive against older runtimes,
  // mkdir -p the parent first.
  const dir = path.replace(/\/[^/]+$/, "");
  await Bun.write(`${dir}/.keep`, "");
  await Bun.write(path, body);
}

/** Tier-2 guardrails preface — inserted at the TOP of every brief
 *  per ADR-050 §Brief generator step 3. Four lines verbatim from
 *  the ADR; the `<name>` + `model=claude-opus-4-7` substitution
 *  resolves at compose time. */
function renderTier2Guardrails(member: string, agent: string): string {
  return [
    `You are a Tier 2 fallback executor running as \`${agent}\`. ` +
      `The original member (\`${member}\`, model=claude-opus-4-7) is paused on a budget window.`,
    "Commit your work to the SAME branch the original member was on. " +
      "Use the SAME conventional-commit prefix. Reviewer will gate.",
    'When you finish or hit a natural commit boundary, run `atmux reply \'[fallback-cursor] <one-line summary>\'` and exit cleanly. Do NOT continue past the natural boundary.',
    "If the original member resumes mid-work, your cage will be torn down; commit early + often.",
  ].join("\n");
}

/** Resolve the in-progress Task body for `member` from state.db.
 *  Returns null when the member has no in-progress task (e.g.
 *  paused right after `atmux done` and before next `claim`). */
async function resolveInProgressTaskBody(
  atmuxDir: string,
  member: string,
): Promise<string | null> {
  const inbox = await loadInbox(atmuxDir, member);
  const ip = inbox.inProgress[0];
  if (ip === undefined) return null;
  // Inbox-row shape carries `subject` + `body`; the brief wants the
  // full body. Fall back to subject when body is empty so the brief
  // still has SOMETHING to anchor on.
  const body = ip.body ?? "";
  if (body.length > 0) return body;
  return ip.subject ?? null;
}

/**
 * Compose the Tier 2 fallback brief per ADR-050 §Brief generator
 * and write it to `<atmuxDir>/state/fallback-brief-<member>.md`.
 *
 * Order of concatenation (top → bottom):
 *
 *   1. `# Fallback brief — <member> (Tier 2)` header
 *   2. Tier-2 guardrails block (4 lines per ADR-050 §step 3)
 *   3. `## Pre-pause in-progress Task` section
 *   4. `## Member brief template (<role>.md)` section
 *   5. `## Recent git log` section (10 entries)
 *   6. `## Recent lead-outbox tail` section (50 lines)
 *
 * Missing inputs degrade to per-section notice lines ("no in-
 * progress task at pause time", "brief template not found", etc.) —
 * the composer NEVER throws on missing inputs; the cage agent
 * should see a coherent document even when state is partial.
 */
export async function composeFallbackBrief(
  opts: ComposeFallbackBriefOpts,
): Promise<ComposeFallbackBriefResult> {
  const gitLog = opts.gitLog ?? defaultGitLog;
  const readTemplate = opts.readTemplate ?? defaultReadTemplate;
  const readLeadOutboxTail =
    opts.readLeadOutboxTail ?? defaultReadLeadOutboxTail;
  const writeBrief = opts.writeBrief ?? defaultWriteBrief;

  const taskBody =
    opts.taskBody ?? (await resolveInProgressTaskBody(opts.atmuxDir, opts.member));
  const template = await readTemplate(opts.templatesDir, opts.role);
  const gitLines = await gitLog(opts.projectRoot);
  const leadOutbox = await readLeadOutboxTail(opts.atmuxDir, 50);

  const sections: string[] = [];
  sections.push(`# Fallback brief — ${opts.member} (Tier 2)`);
  sections.push("");
  sections.push(renderTier2Guardrails(opts.member, opts.agent));
  sections.push("");
  sections.push("## Pre-pause in-progress Task");
  sections.push("");
  if (taskBody === null || taskBody.length === 0) {
    sections.push("_no in-progress task at pause time — execute defensively_");
  } else {
    sections.push(taskBody);
  }
  sections.push("");
  sections.push(`## Member brief template (\`${opts.role}.md\`)`);
  sections.push("");
  if (template === null) {
    sections.push(
      `_brief template not found at \`${opts.templatesDir}/${opts.role}.md\` — Tier 2 executor relies on the in-progress Task body alone_`,
    );
  } else {
    sections.push(template);
  }
  sections.push("");
  sections.push("## Recent git log");
  sections.push("");
  if (gitLines.length === 0) {
    sections.push("_no git log entries (worktree missing .git or empty repo)_");
  } else {
    sections.push("```");
    sections.push(...gitLines);
    sections.push("```");
  }
  sections.push("");
  sections.push("## Recent lead-outbox tail");
  sections.push("");
  if (leadOutbox.length === 0) {
    sections.push("_lead-outbox empty or absent_");
  } else {
    sections.push("```");
    sections.push(leadOutbox);
    sections.push("```");
  }
  sections.push("");

  const body = sections.join("\n");
  const path = fallbackBriefPath(opts.atmuxDir, opts.member);
  await writeBrief(path, body);
  return { path, body };
}
