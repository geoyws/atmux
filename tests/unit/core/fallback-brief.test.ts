// Unit tests for src/core/fallback-brief.ts (ADR-050 §Brief
// generator / t-d15b23da).
//
// Coverage focus: each ADR-050 §Brief generator input slot
// (in-progress task body, brief template, git log, lead-outbox
// tail) wired correctly; missing inputs degrade to per-section
// notice lines (never throws); Tier-2 guardrail preface inserted
// verbatim per ADR-050 §step 3.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeFallbackBrief, fallbackBriefPath } from "../../../src/core/fallback-brief.ts";

let atmuxDir: string;
let templatesDir: string;
let projectRoot: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-fb-brief-"));
  templatesDir = await mkdtemp(join(tmpdir(), "atmux-fb-templ-"));
  projectRoot = await mkdtemp(join(tmpdir(), "atmux-fb-root-"));
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
  await rm(templatesDir, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

describe("fallbackBriefPath — addressable from non-composer call sites", () => {
  test("returns <atmuxDir>/state/fallback-brief-<member>.md", () => {
    const p = fallbackBriefPath("/team/.atmux", "alpha");
    expect(p).toBe("/team/.atmux/state/fallback-brief-alpha.md");
  });
});

describe("composeFallbackBrief — happy path (all inputs present)", () => {
  test("composes a brief with all 5 ADR-050 §step sections + writes to disk", async () => {
    let writtenPath = "";
    let writtenBody = "";
    const result = await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
      taskBody: "Fix the foo bar at src/foo.ts:42",
      gitLog: async () => ["aaa1234 first commit", "bbb5678 second commit"],
      readTemplate: async () => "You are {{MEMBER}} on the {{TEAM}} team.",
      readLeadOutboxTail: async () =>
        "[20:30 MYT] alpha: shipped foo\n[21:00 MYT] beta: shipped bar",
      writeBrief: async (p, b) => {
        writtenPath = p;
        writtenBody = b;
      },
    });
    expect(result.path).toBe(`${atmuxDir}/state/fallback-brief-alpha.md`);
    expect(writtenPath).toBe(result.path);
    // Section headers
    expect(writtenBody).toContain("# Fallback brief — alpha (Tier 2)");
    expect(writtenBody).toContain("## Pre-pause in-progress Task");
    expect(writtenBody).toContain("## Member brief template (`member.md`)");
    expect(writtenBody).toContain("## Recent git log");
    expect(writtenBody).toContain("## Recent lead-outbox tail");
    // Content
    expect(writtenBody).toContain("Fix the foo bar at src/foo.ts:42");
    expect(writtenBody).toContain("You are {{MEMBER}} on the {{TEAM}} team.");
    expect(writtenBody).toContain("aaa1234 first commit");
    expect(writtenBody).toContain("[20:30 MYT] alpha: shipped foo");
  });
});

describe("composeFallbackBrief — Tier-2 guardrails preface (ADR-050 §step 3)", () => {
  test("inserts the 4 guardrail lines verbatim with member + agent substitutions", async () => {
    const recordedBodies: string[] = [];
    await composeFallbackBrief({
      member: "geoyws-whip-impl",
      role: "member",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
      taskBody: "task body",
      gitLog: async () => [],
      readTemplate: async () => null,
      readLeadOutboxTail: async () => "",
      writeBrief: async (_p, b) => {
        recordedBodies.push(b);
      },
    });
    const body = recordedBodies[0]!;
    // Line 1: "You are a Tier 2 fallback executor running as `<agent>`..."
    expect(body).toContain("You are a Tier 2 fallback executor running as `cursor-agent`");
    expect(body).toContain("`geoyws-whip-impl`");
    expect(body).toContain("model=claude-opus-4-7");
    // Line 2: commit to SAME branch + SAME conventional-commit prefix.
    expect(body).toContain("Commit your work to the SAME branch");
    expect(body).toContain("SAME conventional-commit prefix");
    // Line 3: atmux reply '[fallback-cursor] ...' + exit cleanly.
    expect(body).toContain("atmux reply '[fallback-cursor]");
    expect(body).toContain("Do NOT continue past the natural boundary");
    // Line 4: original member resumes → cage torn down → commit early + often.
    expect(body).toContain("If the original member resumes mid-work");
    expect(body).toContain("commit early + often");
  });
});

describe("composeFallbackBrief — missing inputs degrade per-section, never throws", () => {
  test("no in-progress task → notice line in Task section", async () => {
    let body = "";
    await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
      // Omit taskBody entirely so the default loader runs against
      // the fresh atmuxDir (no state.db, loadInbox returns empty)
      // → notice line.
      gitLog: async () => [],
      readTemplate: async () => null,
      readLeadOutboxTail: async () => "",
      writeBrief: async (_p, b) => {
        body = b;
      },
    });
    expect(body).toContain("_no in-progress task at pause time");
  });

  test("missing brief template → notice line in template section", async () => {
    let body = "";
    await composeFallbackBrief({
      member: "alpha",
      role: "reviewer",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
      taskBody: "task body",
      gitLog: async () => [],
      readTemplate: async () => null,
      readLeadOutboxTail: async () => "",
      writeBrief: async (_p, b) => {
        body = b;
      },
    });
    expect(body).toContain("_brief template not found");
    expect(body).toContain(`${templatesDir}/reviewer.md`);
  });

  test("empty git log → notice line in git-log section", async () => {
    let body = "";
    await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
      taskBody: "task body",
      gitLog: async () => [],
      readTemplate: async () => "template",
      readLeadOutboxTail: async () => "outbox",
      writeBrief: async (_p, b) => {
        body = b;
      },
    });
    expect(body).toContain("_no git log entries");
  });

  test("empty lead-outbox → notice line in outbox section", async () => {
    let body = "";
    await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
      taskBody: "task body",
      gitLog: async () => ["aaa first"],
      readTemplate: async () => "template",
      readLeadOutboxTail: async () => "",
      writeBrief: async (_p, b) => {
        body = b;
      },
    });
    expect(body).toContain("_lead-outbox empty or absent_");
  });

  test("all inputs missing → composer still returns valid brief (notice lines x4)", async () => {
    let body = "";
    await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
      taskBody: "",
      gitLog: async () => [],
      readTemplate: async () => null,
      readLeadOutboxTail: async () => "",
      writeBrief: async (_p, b) => {
        body = b;
      },
    });
    // All 4 notice lines should appear.
    expect(body).toContain("_no in-progress task at pause time");
    expect(body).toContain("_brief template not found");
    expect(body).toContain("_no git log entries");
    expect(body).toContain("_lead-outbox empty or absent_");
    // Header + guardrails still present — defensive shape preserved.
    expect(body).toContain("# Fallback brief — alpha (Tier 2)");
    expect(body).toContain("You are a Tier 2 fallback executor");
  });
});

describe("composeFallbackBrief — section ordering (ADR-050 §step 1-5)", () => {
  test("sections appear in ADR-prescribed order: guardrails → task → template → git → outbox", async () => {
    let body = "";
    await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
      taskBody: "TASK_MARKER",
      gitLog: async () => ["GIT_MARKER"],
      readTemplate: async () => "TEMPLATE_MARKER",
      readLeadOutboxTail: async () => "OUTBOX_MARKER",
      writeBrief: async (_p, b) => {
        body = b;
      },
    });
    const guardrailIdx = body.indexOf("Tier 2 fallback executor");
    const taskIdx = body.indexOf("TASK_MARKER");
    const templateIdx = body.indexOf("TEMPLATE_MARKER");
    const gitIdx = body.indexOf("GIT_MARKER");
    const outboxIdx = body.indexOf("OUTBOX_MARKER");
    expect(guardrailIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(guardrailIdx);
    expect(templateIdx).toBeGreaterThan(taskIdx);
    expect(gitIdx).toBeGreaterThan(templateIdx);
    expect(outboxIdx).toBeGreaterThan(gitIdx);
  });
});

describe("composeFallbackBrief — git log fail-soft", () => {
  test("default gitLog returns [] when projectRoot lacks .git (no throw)", async () => {
    // Use the real defaultGitLog by NOT passing the gitLog override.
    // projectRoot is a tmpdir with no .git — git exits non-zero,
    // collapses to empty result.
    let body = "";
    await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot, // tmpdir with no .git
      agent: "cursor-agent",
      templatesDir,
      taskBody: "task",
      readTemplate: async () => "template",
      readLeadOutboxTail: async () => "outbox",
      writeBrief: async (_p, b) => {
        body = b;
      },
    });
    expect(body).toContain("_no git log entries");
  });
});

describe("composeFallbackBrief — result shape contract", () => {
  test("result.path matches fallbackBriefPath(atmuxDir, member)", async () => {
    const result = await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
      taskBody: "task",
      gitLog: async () => [],
      readTemplate: async () => null,
      readLeadOutboxTail: async () => "",
      writeBrief: async () => {},
    });
    expect(result.path).toBe(fallbackBriefPath(atmuxDir, "alpha"));
  });

  test("result.body matches what was written to disk", async () => {
    let written = "";
    const result = await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
      taskBody: "task",
      gitLog: async () => [],
      readTemplate: async () => null,
      readLeadOutboxTail: async () => "",
      writeBrief: async (_p, b) => {
        written = b;
      },
    });
    expect(result.body).toBe(written);
  });
});

describe("composeFallbackBrief — default deps (t-a130e4c8)", () => {
  async function git(cwd: string, argv: string[]): Promise<void> {
    const p = Bun.spawn(["git", ...argv], { cwd, stdout: "ignore", stderr: "ignore" });
    const code = await p.exited;
    if (code !== 0) throw new Error(`git ${argv.join(" ")} failed with ${code}`);
  }

  async function seedFixtureRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "atmux-fb-git-"));
    try {
      await writeFile(join(root, "f.txt"), "one\n");
      await git(root, ["init", "-q"]);
      await git(root, ["add", "."]);
      await git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first"]);
      await writeFile(join(root, "f.txt"), "two\n");
      await git(root, ["add", "."]);
      await git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "second"]);
      return root;
    } catch (e) {
      await rm(root, { recursive: true, force: true });
      throw e;
    }
  }

  test("all defaults present: inbox body + template + git log + outbox tail land in the written brief", async () => {
    const gitRoot = await seedFixtureRepo();
    try {
      await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
      await writeFile(
        join(atmuxDir, "inboxes", "alpha.json"),
        JSON.stringify({
          pending: [],
          inProgress: [{ id: "t-abc12345", subject: "subj", body: "INBOX_TASK_BODY_MARKER" }],
          done: [],
        }),
      );
      await writeFile(join(templatesDir, "member.md"), "TEMPLATE_MARKER {{MEMBER}}");
      const outboxLines = Array.from({ length: 60 }, (_, i) => `outbox-${String(i + 1).padStart(3, "0")}`);
      await writeFile(join(atmuxDir, "lead-outbox.md"), `${outboxLines.join("\n")}\n`);
      const result = await composeFallbackBrief({
        member: "alpha",
        role: "member",
        atmuxDir,
        projectRoot: gitRoot,
        agent: "cursor-agent",
        templatesDir,
      });
      expect(result.path).toBe(fallbackBriefPath(atmuxDir, "alpha"));
      expect(result.body).toContain("INBOX_TASK_BODY_MARKER");
      expect(result.body).toContain("TEMPLATE_MARKER");
      expect(result.body).toContain("first");
      expect(result.body).toContain("second");
      // Tail-50: the last line lands, the first line was sliced off.
      expect(result.body).toContain("outbox-060");
      expect(result.body).not.toContain("outbox-001");
      const onDisk = await Bun.file(result.path).text();
      expect(onDisk).toBe(result.body);
    } finally {
      await rm(gitRoot, { recursive: true, force: true });
    }
  });

  test("bare dirs: every default degrades to its notice line, brief still written", async () => {
    const result = await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot,
      agent: "cursor-agent",
      templatesDir,
    });
    expect(result.body).toContain("_no in-progress task at pause time — execute defensively_");
    expect(result.body).toContain("_brief template not found at");
    expect(result.body).toContain("_no git log entries (worktree missing .git or empty repo)_");
    expect(result.body).toContain("_lead-outbox empty or absent_");
    const onDisk = await Bun.file(result.path).text();
    expect(onDisk).toBe(result.body);
  });

  test("unspawnable git collapses to empty log via the fail-soft catch", async () => {
    const nulRoot = "/tmp/\0unspawnable";
    // Premise pin: the runtime must throw (not truncate) on NUL argv —
    // otherwise the notice below could come from the exit≠0 branch and
    // this test would pass without entering the catch.
    expect(() => Bun.spawn(["git", "-C", nulRoot, "log"], { stdout: "ignore" })).toThrow();
    const result = await composeFallbackBrief({
      member: "alpha",
      role: "member",
      atmuxDir,
      projectRoot: nulRoot,
      agent: "cursor-agent",
      templatesDir,
      taskBody: "task",
    });
    expect(result.body).toContain("_no git log entries (worktree missing .git or empty repo)_");
  });
});
