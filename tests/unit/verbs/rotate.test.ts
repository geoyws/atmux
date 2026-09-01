// Unit tests for src/verbs/rotate.ts (ADR-010).
// Bash spec ref: lib/rotate.sh @ worktree-frozen.
//
// Coverage strategy
// -----------------
// Pure helpers (`parseRotateArgs`, `findLeadMember`, `getBriefPath`,
// `renderBrief`, `windowExists`) are exercised directly. The public
// verb is driven against a stub `TmuxNamespace` injected via
// `opts.buildTmux` — captures every send-keys / loadBuffer /
// pasteBuffer call so we can assert on order + payload without
// spinning a real tmux server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSendTarget, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { renderBootPrompt } from "../../../src/core/boot-claude.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  defaultBriefsDir,
  defaultBuildTmux,
  defaultSleep,
  findLeadMember,
  getBriefPath,
  parseRotateArgs,
  renderBrief,
  rotate,
  rotateLead,
  windowExists,
} from "../../../src/verbs/rotate.ts";

/** ADR-081 §C / t-4ad7fc42: shared `bootClaude` opts override for every
 *  rotate-into-claude test. Fast timeouts + no-op sleep so the readiness
 *  + tokens-moved polls don't hang real setTimeout in the test runner.
 *  Tests asserting the boot path's behaviour stage paneText sequences so
 *  the polls flip from "ready" to "tokens moved" deterministically.
 *
 *  ADR-138 §submitVerify (t-1b45d565 split out the C-m submit into its
 *  own safeSendKeysWithVerify call): without tight `submitVerifyTimeoutMs`
 *  + `submitVerifyRetries` overrides, the verify loop spins for
 *  `DEFAULT_SUBMIT_VERIFY_TIMEOUT_MS (3000ms) × (DEFAULT_SUBMIT_VERIFY_RETRIES (1) + 1)`
 *  = 6000ms of REAL wall-clock per boot attempt. The injected `sleep`
 *  is no-op but `Date.now()` (used for the deadline check) advances
 *  independently — the loop tight-spins until the natural timeout
 *  elapses. Tight overrides (50ms timeout, 0 retries) keep the
 *  verify-and-retry contract under test while bounding the worst-case
 *  hang to <100ms per test. */
const FAST_BOOT_CLAUDE = {
  readyPollIntervalMs: 5,
  readyTimeoutMs: 100,
  postBootPollIntervalMs: 5,
  postBootTimeoutMs: 100,
  maxAttempts: 1,
  submitVerifyTimeoutMs: 50,
  submitVerifyRetries: 0,
  submitVerifyPollIntervalMs: 5,
  sleep: async () => {},
} as const;

// ---------- parseRotateArgs ----------

describe("parseRotateArgs", () => {
  test("empty argv → forLead=false, member empty", () => {
    expect(parseRotateArgs([])).toEqual({ forLead: false, member: "" });
  });

  test("--lead → forLead=true, member empty", () => {
    expect(parseRotateArgs(["--lead"])).toEqual({ forLead: true, member: "" });
  });

  test("positional member → forLead=false, member set", () => {
    expect(parseRotateArgs(["alice"])).toEqual({ forLead: false, member: "alice" });
  });

  test("--socket <path> captured", () => {
    expect(parseRotateArgs(["--socket", "/s", "alice"])).toEqual({
      forLead: false,
      member: "alice",
      socketPath: "/s",
    });
  });

  test("--team-dir <dir> captured", () => {
    expect(parseRotateArgs(["--team-dir", "/d", "alice"])).toEqual({
      forLead: false,
      member: "alice",
      teamDir: "/d",
    });
  });

  test("--socket without value → UsageError", () => {
    expect(() => parseRotateArgs(["--socket"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseRotateArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseRotateArgs(["--bogus"])).toThrow(UsageError);
  });

  test("two positionals → UsageError 'too many args'", () => {
    expect(() => parseRotateArgs(["alice", "bob"])).toThrow(UsageError);
  });
});

// ---------- findLeadMember ----------

describe("findLeadMember", () => {
  test("returns the first team-lead in roster order", () => {
    const m = findLeadMember({
      name: "t",
      members: [
        { name: "alpha", role: "member" },
        { name: "lead-1", role: "team-lead" },
        { name: "lead-2", role: "team-lead" },
      ],
    });
    expect(m?.name).toBe("lead-1");
  });

  test("null when no team-lead in roster", () => {
    expect(
      findLeadMember({
        name: "t",
        members: [{ name: "alpha", role: "member" }],
      }),
    ).toBeNull();
  });

  test("null on empty roster", () => {
    expect(findLeadMember({ name: "t", members: [] })).toBeNull();
  });
});

// ---------- getBriefPath ----------

describe("getBriefPath", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-rotate-briefs-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns role-specific path when present", async () => {
    await writeFile(join(dir, "reviewer.md"), "rev");
    await writeFile(join(dir, "member.md"), "m");
    expect(await getBriefPath("reviewer", dir)).toBe(join(dir, "reviewer.md"));
  });

  test("falls back to member.md when role file absent", async () => {
    await writeFile(join(dir, "member.md"), "m");
    expect(await getBriefPath("planner", dir)).toBe(join(dir, "member.md"));
  });

  test("returns member.md path even if it doesn't exist (caller checks)", async () => {
    expect(await getBriefPath("foo", dir)).toBe(join(dir, "member.md"));
  });

  // Role-alias semantic — `team-lead` must read from `lead.md` even when
  // a stale `team-lead.md` tombstone is present. The alias short-circuits
  // before the existence check so a leftover deprecated file (e.g. from
  // an older checkout / npm cache / operator override) cannot shadow the
  // canonical brief.
  test("role 'team-lead' aliases to lead.md and ignores tombstone team-lead.md", async () => {
    await writeFile(join(dir, "lead.md"), "canonical");
    await writeFile(join(dir, "team-lead.md"), "DEPRECATED tombstone");
    await writeFile(join(dir, "member.md"), "m");
    expect(await getBriefPath("team-lead", dir)).toBe(join(dir, "lead.md"));
  });

  test("role 'team-lead' falls back to member.md when lead.md absent (alias still applied)", async () => {
    await writeFile(join(dir, "team-lead.md"), "DEPRECATED tombstone");
    await writeFile(join(dir, "member.md"), "m");
    expect(await getBriefPath("team-lead", dir)).toBe(join(dir, "member.md"));
  });

  // Regression: production briefs/ must resolve every role used in
  // shipped team.json templates to a real, readable file. `team-lead`
  // is alias-mapped to `lead.md` inside getBriefPath (canonical brief
  // per ADR-007 pull-model rename); `member` is the direct fallback
  // file; `docs` has no own brief and must fall through to member.md.
  // Without these the team rotation half-cycles panes — observed
  // 2026-05-12 after a 20h+ dormancy rebuild.
  test.each([
    "team-lead",
    "lead",
    "member",
    "docs",
    "planner",
    "reviewer",
    "gitter",
    // ADR-147 T4: new role `ombudsman` ships with its own brief at
    // `templates/briefs/ombudsman.md`. Including it in the regression
    // sweep ensures the file is shipped + readable + resolves via
    // getBriefPath without falling through to member.md (which would
    // mean spawned ombudsman panes boot with the wrong role contract).
    "ombudsman",
  ])("production briefs resolve role %s to an existing file", async (role) => {
    const path = await getBriefPath(role, defaultBriefsDir());
    const content = await readFile(path, "utf8");
    expect(content.length).toBeGreaterThan(0);
  });

  // ADR-147 T4: ombudsman brief must NOT fall back to member.md — its
  // role contract (cron + pending-JSON sentinel queue, no kanban
  // claims, no code edits) diverges sharply from the generic member
  // loop. A fallback would boot the pane with member.md's claim-loop
  // instructions, which is wrong for ombudsman.
  test("role 'ombudsman' resolves to ombudsman.md, NOT member.md fallback", async () => {
    const path = await getBriefPath("ombudsman", defaultBriefsDir());
    expect(path.endsWith("/ombudsman.md")).toBe(true);
    expect(path.endsWith("/member.md")).toBe(false);
  });
});

// ---------- renderBrief ----------

describe("renderBrief", () => {
  test("substitutes all four placeholder keys", () => {
    const tpl = "team={{TEAM}} member={{MEMBER}} role={{ROLE}} dir={{ATMUX_DIR}}";
    expect(
      renderBrief(tpl, { team: "alpha", member: "bob", role: "reviewer", atmuxDir: "/x/.atmux" }),
    ).toBe("team=alpha member=bob role=reviewer dir=/x/.atmux");
  });

  test("replaces ALL occurrences (replaceAll, not first-match)", () => {
    expect(
      renderBrief("{{TEAM}}-{{TEAM}}", { team: "x", member: "", role: "", atmuxDir: "" }),
    ).toBe("x-x");
  });

  test("leaves non-matching {{...}} alone (no greedy regex)", () => {
    expect(
      renderBrief("{{UNKNOWN}} kept; {{TEAM}} replaced", {
        team: "x",
        member: "",
        role: "",
        atmuxDir: "",
      }),
    ).toBe("{{UNKNOWN}} kept; x replaced");
  });

  // ---------- ADR-280 stage 4: the ADR-090 epic placeholders ----------
  //
  // Three cases here drove `renderBrief`'s optional `parent` / `epicId`
  // vars, which existed solely for ADR-090's `epic-lead.md` brief. Stage 3
  // deleted that template and dropped both vars, so `{{PARENT}}` and
  // `{{EPIC_ID}}` are now ordinary unknown placeholders. Two of the three
  // cases collapse into the unknown-placeholder case above; this one is
  // kept as the regression guard that the removal was CLEAN — nothing
  // still substitutes them, and a template that carries them survives
  // rendering intact rather than being mangled.

  test("ADR-280: {{PARENT}} / {{EPIC_ID}} are now ordinary unknown placeholders — passed through raw", () => {
    const tpl = "team={{TEAM}} parent={{PARENT}} epicId={{EPIC_ID}} member={{MEMBER}}";
    expect(
      renderBrief(tpl, {
        team: "checkout-flow",
        member: "lead",
        role: "lead",
        atmuxDir: "/p/.atmux",
      }),
    ).toBe("team=checkout-flow parent={{PARENT}} epicId={{EPIC_ID}} member=lead");
  });
});

// ---------- defaultBriefsDir ----------

describe("defaultBriefsDir", () => {
  test("resolves to <repo>/templates/briefs", () => {
    const d = defaultBriefsDir();
    expect(d.endsWith("/templates/briefs")).toBe(true);
  });
});

// ---------- default helper functions ----------

describe("defaultSleep", () => {
  test("resolves after ~0ms (covers the setTimeout path)", async () => {
    await defaultSleep(0);
  });
});

describe("defaultBuildTmux", () => {
  test("returns a TmuxNamespace pinned to the supplied socketPath", () => {
    // We don't drive a real tmux subprocess — just probe the factory
    // returns the expected shape (has .session / .window / .pane /
    // .buffer namespaces). No process spawned.
    const ns = defaultBuildTmux("/tmp/atmux-rotate-defaultbuildtmux-noop/sock");
    expect(typeof ns.window.listWindows).toBe("function");
    expect(typeof ns.pane.sendKeys).toBe("function");
    expect(typeof ns.buffer.loadBuffer).toBe("function");
  });
});

// ---------- windowExists ----------

interface StubTmuxCalls {
  sendKeys: Array<{ target: string; keys: string; enter: boolean | undefined }>;
  loadBuffer: Array<{ name: string | undefined; data: string }>;
  pasteBuffer: Array<{
    name: string | undefined;
    target: string;
    deleteAfter: boolean | undefined;
  }>;
  listWindows: string[];
  /** Pane captures observed by safePreflight. */
  capturePane: Array<{ target: string; start: number | undefined }>;
}

function stubTmux(opts: {
  windows?: ReadonlyArray<{ index: number; name: string; active: boolean }>;
  /** Pane content returned to safePreflight + ADR-081 §C
   *  bootClaudeMember probes. Default is empty (classifies as UNKNOWN
   *  → preflight ready=false → no dismissals; bootClaude readiness
   *  poll times out at its own deadline).
   *
   *  ADR-081 §C / t-4ad7fc42: pass an array to stage capture-pane
   *  return values over multiple calls (last element sticky). Useful
   *  for pinning the boot-prompt-then-tokens-moved transition. */
  paneText?: string | ReadonlyArray<string>;
}): { tmux: TmuxNamespace; calls: StubTmuxCalls } {
  const calls: StubTmuxCalls = {
    sendKeys: [],
    loadBuffer: [],
    pasteBuffer: [],
    listWindows: [],
    capturePane: [],
  };
  const sequence: string[] = Array.isArray(opts.paneText)
    ? [...opts.paneText]
    : typeof opts.paneText === "string"
      ? [opts.paneText]
      : [""];
  let captureIdx = 0;
  const tmux = {
    window: {
      async listWindows(session: string) {
        calls.listWindows.push(session);
        return [...(opts.windows ?? [])];
      },
    },
    pane: {
      // ADR-025: o.target is now SendTarget. Unwrap via serializeSendTarget
      // so existing string-equality assertions stay byte-identical.
      async sendKeys(o: {
        target: import("../../../src/abstractions/tmux.ts").SendTarget;
        keys: string;
        enter?: boolean;
      }) {
        calls.sendKeys.push({
          target: serializeSendTarget(o.target),
          keys: o.keys,
          enter: o.enter,
        });
      },
      async capturePane(o: { target: string; start?: number }) {
        calls.capturePane.push({ target: o.target, start: o.start });
        const idx = Math.min(captureIdx, sequence.length - 1);
        captureIdx++;
        return sequence[idx] ?? "";
      },
    },
    buffer: {
      async loadBuffer(o: { name?: string; data: string }) {
        calls.loadBuffer.push({ name: o.name, data: o.data });
      },
      async pasteBuffer(o: {
        name?: string;
        target: import("../../../src/abstractions/tmux.ts").SendTarget;
        deleteAfter?: boolean;
      }) {
        calls.pasteBuffer.push({
          name: o.name,
          target: serializeSendTarget(o.target),
          deleteAfter: o.deleteAfter,
        });
      },
    },
  } as unknown as TmuxNamespace;
  return { tmux, calls };
}

describe("windowExists", () => {
  test("true when listWindows yields a matching name", async () => {
    const { tmux } = stubTmux({
      windows: [
        { index: 0, name: "alice", active: false },
        { index: 1, name: "🐝bob", active: true },
      ],
    });
    expect(await windowExists(tmux, "atmux-x", "🐝bob")).toBe(true);
  });

  test("false when no window matches", async () => {
    const { tmux } = stubTmux({ windows: [{ index: 0, name: "alice", active: true }] });
    expect(await windowExists(tmux, "atmux-x", "ghost")).toBe(false);
  });
});

// ---------- rotate() public verb ----------

describe("rotate() — public verb", () => {
  let scratch: string;
  let briefsDir: string;
  let priorAtmuxDir: string | undefined;
  let priorAtmuxTeamDir: string | undefined;
  let priorAtmuxSession: string | undefined;
  let priorAtmuxDriverSession: string | undefined;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-rotate-"));
    briefsDir = await mkdtemp(join(tmpdir(), "atmux-rotate-briefs-"));
    priorAtmuxDir = process.env.ATMUX_DIR;
    priorAtmuxTeamDir = process.env.ATMUX_TEAM_DIR;
    priorAtmuxSession = process.env.ATMUX_SESSION;
    priorAtmuxDriverSession = process.env.ATMUX_DRIVER_SESSION;
    delete process.env.ATMUX_DIR;
    delete process.env.ATMUX_TEAM_DIR;
    delete process.env.ATMUX_SESSION;
    delete process.env.ATMUX_DRIVER_SESSION;
  });

  afterEach(async () => {
    // Always delete-then-restore: tests in this file SET ATMUX_SESSION
    // for the cross-session-name path, and the prior value may be
    // undefined. Without the delete first, the set leaks to the next
    // test file (causes tell-lead's "atmux-t" assertion to drift).
    delete process.env.ATMUX_DIR;
    delete process.env.ATMUX_TEAM_DIR;
    delete process.env.ATMUX_SESSION;
    delete process.env.ATMUX_DRIVER_SESSION;
    if (priorAtmuxDir !== undefined) process.env.ATMUX_DIR = priorAtmuxDir;
    if (priorAtmuxTeamDir !== undefined) process.env.ATMUX_TEAM_DIR = priorAtmuxTeamDir;
    if (priorAtmuxSession !== undefined) process.env.ATMUX_SESSION = priorAtmuxSession;
    if (priorAtmuxDriverSession !== undefined)
      process.env.ATMUX_DRIVER_SESSION = priorAtmuxDriverSession;
    await rm(scratch, { recursive: true, force: true });
    await rm(briefsDir, { recursive: true, force: true });
  });

  async function seedTeam(team: unknown): Promise<void> {
    const atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
  }

  test("argv parse error → UsageError", async () => {
    await expect(rotate(["--socket"])).rejects.toBeInstanceOf(UsageError);
  });

  test("missing team.json → ConfigError", async () => {
    await expect(rotate(["--team-dir", scratch, "alice"])).rejects.toBeInstanceOf(ConfigError);
  });

  test("--lead with no team-lead in roster → ConfigError", async () => {
    await seedTeam({
      name: "t",
      members: [{ name: "alice", role: "member" }],
    });
    await expect(rotate(["--team-dir", scratch, "--lead"])).rejects.toBeInstanceOf(ConfigError);
  });

  test("bare form with no positional → UsageError", async () => {
    await seedTeam({ name: "t", members: [{ name: "alice" }] });
    await expect(rotate(["--team-dir", scratch])).rejects.toBeInstanceOf(UsageError);
  });

  test("bare form with unknown member → ConfigError", async () => {
    await seedTeam({ name: "t", members: [{ name: "alice" }] });
    await expect(rotate(["--team-dir", scratch, "ghost"])).rejects.toBeInstanceOf(ConfigError);
  });

  test("missing tmux window → ConfigError", async () => {
    await seedTeam({
      name: "t",
      members: [{ name: "alice", tui: "claude" }],
    });
    const { tmux } = stubTmux({ windows: [] });
    await expect(
      rotate(["--team-dir", scratch, "alice"], { buildTmux: () => tmux }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("ADR-081 §C: claude TUI → /clear + bootClaudeMember (boot prompt sent via paste-submit per ADR-138 T3b3)", async () => {
    // Post-t-94d7ad60 rotation flow: for claude TUIs, the legacy
    // paste-buffer brief-deliver path was replaced by
    // `bootClaudeMember`. The new sequence is:
    //   1. safePreflight + /clear
    //   2. bootClaudeMember: capture (sentinel) → poll-ready (capture
    //      loop) → paste-submit(boot prompt) → poll-tokens-moved.
    // ADR-138 T3b3 (t-06547e2d) migrated the boot-prompt emit from
    // raw sendKeys → pasteAndSubmit to fix bracketed-paste-Enter-
    // swallow. So loadBuffer + pasteBuffer DO fire now (carrying the
    // boot-prompt text); the trailing sendKeys is the literal C-m
    // submit (enter:false).
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "alice", role: "reviewer", tui: "claude" }],
    });
    await writeFile(
      join(briefsDir, "reviewer.md"),
      "team={{TEAM}} member={{MEMBER}} role={{ROLE}} dir={{ATMUX_DIR}}",
    );
    // Staged paneText: first capture returns "ready but not booted"
    // (matches `❯` for the readiness poll, no `\d+k tokens` so the
    // already-booted sentinel doesn't short-circuit). Subsequent
    // captures return BOTH a composer-empty line (`❯ \n` — matches
    // ADR-138 `composerEmpty()` regex `/❯\s*$/m`) so the post-paste
    // safeSendKeysWithVerify exits on first poll AND a tokens-moved
    // line so the post-boot poll closes out on attempt 1. Last
    // element is sticky.
    const { tmux, calls } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
      paneText: ["❯ ready", "❯ ready", "❯ \n↑ 5k tokens"],
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    const exit = await rotate(["--team-dir", scratch, "alice"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {
        /* no-op for tests — bypass real 2s/1s delays */
      },
      stdout: (s) => {
        stdoutBuf += s;
      },
      stderr: (s) => {
        stderrBuf += s;
      },
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(exit).toBe(0);
    // First send-keys is /clear.
    expect(calls.sendKeys[0]).toEqual({
      target: "atmux-t:alice",
      keys: "/clear",
      enter: true,
    });
    // ADR-138 T3b3 (t-06547e2d): boot prompt landed via pasteAndSubmit
    // — the prompt data rides through loadBuffer, NOT raw sendKeys.
    // The trailing send-keys is C-m (enter:false), which submits the
    // pasted body without re-triggering the bracketed-paste-Enter
    // swallow.
    const bootPrompt = renderBootPrompt("t", "alice");
    expect(calls.loadBuffer.length).toBeGreaterThanOrEqual(1);
    // At least one loadBuffer carried the boot prompt as data.
    expect(calls.loadBuffer.some((l) => l.data === bootPrompt)).toBe(true);
    // pasteBuffer fired with deleteAfter (the bracketed-paste envelope).
    expect(calls.pasteBuffer.length).toBeGreaterThanOrEqual(1);
    // A C-m submit followed the paste; no raw text-body sendKeys for
    // the boot prompt remains.
    expect(calls.sendKeys.some((s) => s.keys === "C-m" && s.enter === false)).toBe(true);
    expect(calls.sendKeys.some((s) => s.keys === bootPrompt)).toBe(false);
    // capturePane fired at least 3x (sentinel + readiness poll + post-boot poll).
    expect(calls.capturePane.length).toBeGreaterThanOrEqual(3);
    // Stdout carries the boot-success line + the final rotation summary.
    expect(stdoutBuf).toContain("rotate: alice: bootstrapped");
    expect(stdoutBuf).toContain("rotated alice (role=reviewer, tui=claude)");
    expect(stderrBuf).toBe("");
  });

  test("ADR-081 §C + ADR-138 T3b3: claude TUI boot sequence (capture → paste-submit(prompt) → capture)", async () => {
    // t-4ad7fc42 rewrite of the legacy ADR-081 §A sequence pin,
    // updated for ADR-138 T3b3 (t-06547e2d) paste-submit migration.
    // Post-T3b3 invariant: after /clear, the boot sequence is
    // `capturePane (sentinel)` → `capturePane* (readiness poll)` →
    // `loadBuffer(prompt)` + `pasteBuffer` + `sendKeys(C-m)`
    // (pasteAndSubmit cascade) → `capturePane* (tokens-moved poll)`.
    // Paste-buffer is REQUIRED now (was forbidden pre-T3b3); the
    // bracketed-paste envelope around the body + C-m submit is the
    // empirical fix for the lane-tick Enter-swallow incident.
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "alice", role: "reviewer", tui: "claude" }],
    });
    await writeFile(join(briefsDir, "reviewer.md"), "BRIEF BODY");
    const { tmux, calls } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
      // ADR-138 composerEmpty line `❯ \n` lets safeSendKeysWithVerify
      // exit on first poll post-C-m; second line carries the
      // tokens-moved sentinel for the post-boot poll. Same shape as
      // the §C/T3b3 test above.
      paneText: ["❯ ready", "❯ ready", "❯ \n↑ 5k tokens"],
    });
    type Event =
      | { kind: "capture" }
      | { kind: "sendKeys"; keys: string; enter: boolean }
      | { kind: "loadBuffer" }
      | { kind: "pasteBuffer" };
    const timeline: Event[] = [];
    const wrappedTmux = {
      ...tmux,
      buffer: {
        ...tmux.buffer,
        async loadBuffer(o: Parameters<typeof tmux.buffer.loadBuffer>[0]) {
          timeline.push({ kind: "loadBuffer" });
          return tmux.buffer.loadBuffer(o);
        },
        async pasteBuffer(o: Parameters<typeof tmux.buffer.pasteBuffer>[0]) {
          timeline.push({ kind: "pasteBuffer" });
          return tmux.buffer.pasteBuffer(o);
        },
      },
      pane: {
        ...tmux.pane,
        async sendKeys(o: Parameters<typeof tmux.pane.sendKeys>[0]) {
          timeline.push({ kind: "sendKeys", keys: o.keys, enter: o.enter === true });
          return tmux.pane.sendKeys(o);
        },
        async capturePane(o: Parameters<typeof tmux.pane.capturePane>[0]) {
          timeline.push({ kind: "capture" });
          return tmux.pane.capturePane(o);
        },
      },
    };
    const exit = await rotate(["--team-dir", scratch, "alice"], {
      buildTmux: () => wrappedTmux,
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      stderr: () => {},
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(exit).toBe(0);
    // ADR-138 T3b3: paste-submit cascade fires (loadBuffer + pasteBuffer
    // + C-m). The bracketed-paste envelope around the body + C-m
    // submit is the canonical text-body injection per t-06547e2d.
    expect(timeline.some((e) => e.kind === "loadBuffer")).toBe(true);
    expect(timeline.some((e) => e.kind === "pasteBuffer")).toBe(true);
    // Locate the paste-buffer event (carries the boot prompt as data
    // via the preceding loadBuffer) and the captures that bracket it.
    const pasteIdx = timeline.findIndex((e) => e.kind === "pasteBuffer");
    expect(pasteIdx).toBeGreaterThan(0);
    // At least one capture preceded the paste (sentinel + readiness poll).
    const before = timeline.slice(0, pasteIdx);
    expect(before.some((e) => e.kind === "capture")).toBe(true);
    // At least one capture followed the paste (the tokens-moved poll
    // observing the staged paneText flip after the C-m submit).
    const after = timeline.slice(pasteIdx + 1);
    expect(after.some((e) => e.kind === "capture")).toBe(true);
    // Calls accumulator-level invariants: last sendKeys is the C-m
    // submit (enter:false), NOT the boot prompt text. The boot prompt
    // landed inside loadBuffer's `data`.
    expect(calls.sendKeys.at(-1)?.keys).toBe("C-m");
    expect(calls.sendKeys.at(-1)?.enter).toBe(false);
  });

  test("safe-send: CC feedback survey is dismissed before /clear lands", async () => {
    // Stuck-pane scenario from t-06e7209d brief: Claude Code's
    // feedback modal eats keystrokes. safePreflight must auto-dismiss
    // it (sending "0") before the rotation's /clear hits the wire.
    //
    // t-4ad7fc42: staged paneText so post-dismiss captures look
    // ready-to-booted to bootClaudeMember (the survey text vanishes
    // after dismissal in production; we simulate by sequencing).
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "alice", role: "reviewer", tui: "claude" }],
    });
    await writeFile(join(briefsDir, "reviewer.md"), "ok");
    const { tmux, calls } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
      paneText: [
        // safePreflight reads the survey, sends "0" to dismiss.
        "● How is Claude doing this session? (optional)\n  1: Bad    2: Fine   3: Good   0: Dismiss",
        // bootClaudeMember sentinel + readiness poll see the cleared
        // pane; tokens-moved poll closes the boot on attempt 1.
        "❯ ready",
        "❯ ↑ 5k tokens",
      ],
    });
    const exit = await rotate(["--team-dir", scratch, "alice"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(exit).toBe(0);
    // The first sendKeys call is the dismissal "0" from preflight,
    // NOT /clear — proves the modal was caught + handled before
    // rotation payload typed into the wrong prompt.
    expect(calls.sendKeys[0]?.keys).toBe("0");
    expect(calls.sendKeys[0]?.enter).toBe(false);
    // /clear lands AFTER the dismissal (one or more dismissals may
    // have fired; find the /clear call to assert it still happens).
    const clearIdx = calls.sendKeys.findIndex((c) => c.keys === "/clear");
    expect(clearIdx).toBeGreaterThan(0);
    expect(calls.sendKeys[clearIdx]?.enter).toBe(true);
    // capturePane was invoked at least once by preflight.
    expect(calls.capturePane.length).toBeGreaterThanOrEqual(1);
  });

  test("happy path: --lead resolves the team-lead from roster", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [
        { name: "alpha", role: "member", tui: "claude" },
        { name: "lead-x", role: "team-lead", tui: "claude" },
      ],
    });
    const { tmux, calls } = stubTmux({
      windows: [
        { index: 0, name: "alpha", active: false },
        { index: 1, name: "lead-x", active: true },
      ],
      // Pre-T7 this paneText would have short-circuited the
      // bootClaudeMember sentinel as already-booted (matches the
      // `\d+k tokens` regex) and skipped the boot prompt. EPIC
      // e-f28c2596 T7 decouples the brief-paste from the sentinel:
      // rotate.ts now sets `forceBootPrompt: true` so the boot
      // prompt fires regardless of stale-token scrollback.
      paneText: "❯ ↑ 5k tokens",
    });
    const exit = await rotate(["--team-dir", scratch, "--lead"], {
      buildTmux: () => tmux,
      briefsDir, // BRIEF_ALIASES: team-lead → lead.md; neither staged → fall through to member.md (also absent → silent skip)
      sleep: async () => {},
      stdout: () => {},
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(exit).toBe(0);
    // Lead resolved from roster: /clear lands on the team-lead pane.
    // (This test's primary assertion; the boot-prompt paste-buffer
    // calls are now expected per T7 but their exact shape is covered
    // by the §C/§T3b3 tests above + the T8 forceBootPrompt sweep.)
    expect(calls.sendKeys[0]?.target).toBe("atmux-t:lead-x");
  });

  test("ADR-057 §D2c: --lead writes pre-rotate handoff file", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = join(scratch, ".atmux");
    await seedTeam({
      name: "t",
      members: [{ name: "lead-x", role: "team-lead", tui: "claude" }],
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    // Seed a minimal kanban so listTasks succeeds.
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({ version: 1, epics: [], stories: [], tasks: [] }),
    );
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "lead-x", active: true }],
      paneText: "❯ ↑ 5k tokens",
    });
    let stdoutBuf = "";
    const fixedNowMs = 1778126400 * 1000;
    const exit = await rotate(["--team-dir", scratch, "--lead"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: (s) => {
        stdoutBuf += s;
      },
      now: () => fixedNowMs,
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(exit).toBe(0);
    expect(stdoutBuf).toContain("lead handoff written to");
    const handoffPath = join(atmuxDir, "state", "lead-handoff-1778126400.md");
    const md = await readFile(handoffPath, "utf8");
    expect(md).toContain("# Lead handoff — `t`");
    expect(md).toContain("**outgoing lead:** `lead-x`");
  });

  test("ADR-057 §D2c: regular member rotation does NOT write handoff", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = join(scratch, ".atmux");
    await seedTeam({
      name: "t",
      members: [{ name: "alice", role: "member", tui: "claude" }],
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
      paneText: "❯ ↑ 5k tokens",
    });
    let stdoutBuf = "";
    await rotate(["--team-dir", scratch, "alice"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: (s) => {
        stdoutBuf += s;
      },
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(stdoutBuf).not.toContain("lead handoff");
    // No file in state/ matching the handoff prefix.
    const stateFiles = await readdir(join(atmuxDir, "state"));
    expect(stateFiles.some((f) => f.startsWith("lead-handoff-"))).toBe(false);
  });

  // t-afd3fe38: after `atmux rotate-lead`, `lead-session-start.txt`
  // MUST equal the new spawn epoch so ADR-143's cron-fired uptime gate
  // reads the rotated lead's clock — not the stale pre-rotate one. The
  // ADR-143 §59 invariant "Re-running just after a force-rotate is also
  // a no-op because atmux rotate-lead resets lead-session-start.txt to
  // the new spawn epoch" depended on a missing write; without this,
  // the cron-gate re-fires on every tick → rotation flap loop.
  test("t-afd3fe38: rotate-lead writes lead-session-start.txt with new spawn epoch", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = join(scratch, ".atmux");
    await seedTeam({
      name: "t",
      members: [{ name: "lead-x", role: "team-lead", tui: "claude" }],
    });
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(
      join(atmuxDir, "kanban.json"),
      JSON.stringify({ version: 1, epics: [], stories: [], tasks: [] }),
    );
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "lead-x", active: true }],
      paneText: "❯ ↑ 5k tokens",
    });
    const fixedNowMs = 1778126400 * 1000;
    const exit = await rotate(["--team-dir", scratch, "--lead"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      stderr: () => {},
      now: () => fixedNowMs,
      leadMarkerHome: scratch,
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(exit).toBe(0);
    const markerPath = join(scratch, ".claude", "teams", "t", "lead-session-start.txt");
    const text = await readFile(markerPath, "utf8");
    expect(text.trim()).toBe(String(Math.floor(fixedNowMs / 1000)));
  });

  test("t-afd3fe38: regular member rotation does NOT write lead-session-start.txt", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "alice", role: "member", tui: "claude" }],
    });
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
      paneText: "❯ ↑ 5k tokens",
    });
    const exit = await rotate(["--team-dir", scratch, "alice"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      stderr: () => {},
      leadMarkerHome: scratch,
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(exit).toBe(0);
    // No marker file under the scratch home.
    const markerPath = join(scratch, ".claude", "teams", "t", "lead-session-start.txt");
    let exists = true;
    try {
      await readFile(markerPath, "utf8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("ADR-057 §D2c: handoff write failure logs to stderr but does NOT abort", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    const atmuxDir = join(scratch, ".atmux");
    await seedTeam({
      name: "t",
      members: [{ name: "lead-x", role: "team-lead", tui: "claude" }],
    });
    // Don't create state/ dir AND seed a corrupt kanban.json — the kanban
    // load will fail, propagating up. writeLeadHandoff catches via its
    // try/catch in rotate.ts.
    await writeFile(join(atmuxDir, "kanban.json"), "{ corrupt json");
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "lead-x", active: true }],
      paneText: "❯ ↑ 5k tokens",
    });
    let stderrBuf = "";
    const exit = await rotate(["--team-dir", scratch, "--lead"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      stderr: (s) => {
        stderrBuf += s;
      },
      bootClaude: FAST_BOOT_CLAUDE,
    });
    // Rotation continues despite handoff failure.
    expect(exit).toBe(0);
    expect(stderrBuf).toContain("lead handoff write failed");
  });

  test("non-claude TUI (opencode) → warn on stderr, no /clear, brief still pasted", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "bob", role: "member", tui: "opencode" }],
    });
    await writeFile(join(briefsDir, "member.md"), "{{MEMBER}}");
    const { tmux, calls } = stubTmux({
      windows: [{ index: 0, name: "bob", active: true }],
    });
    let stderrBuf = "";
    const exit = await rotate(["--team-dir", scratch, "bob"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      stderr: (s) => {
        stderrBuf += s;
      },
    });
    expect(exit).toBe(0);
    // Only one send-keys — the trailing C-m for the brief paste
    // (ADR-081 §A: C-m bypasses bracketed-paste mode's Enter swallow).
    expect(calls.sendKeys.length).toBe(1);
    expect(calls.sendKeys[0]?.keys).toBe("C-m");
    expect(stderrBuf).toContain("rotate: tui=opencode has no /clear equivalent");
    expect(calls.loadBuffer.length).toBe(1);
    expect(calls.loadBuffer[0]?.data).toBe("bob");
  });

  test("--socket override forwards into the buildTmux factory", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "alice", tui: "claude" }],
    });
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
      paneText: "❯ ↑ 5k tokens",
    });
    let receivedSock = "";
    const exit = await rotate(["--team-dir", scratch, "--socket", "/custom/sock", "alice"], {
      buildTmux: (sp) => {
        receivedSock = sp;
        return tmux;
      },
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(exit).toBe(0);
    expect(receivedSock).toBe("/custom/sock");
  });

  test("default-socket branch hits getDefaultSocket when --socket omitted", async () => {
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "team-default",
      members: [{ name: "alice", tui: "claude" }],
    });
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
      paneText: "❯ ↑ 5k tokens",
    });
    let receivedSock = "";
    const exit = await rotate(["--team-dir", scratch, "alice"], {
      buildTmux: (sp) => {
        receivedSock = sp;
        return tmux;
      },
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(exit).toBe(0);
    expect(receivedSock).toBe("/tmp/atmux-team-default/sock");
  });

  test("default stdout/stderr/sleep paths exercised when opts omitted", async () => {
    // Drive rotate without overriding sleep / stdout / stderr — covers
    // the `opts.X ?? defaultX` fallback branches. Use opencode tui +
    // missing brief so neither /clear nor brief-paste fires (no real
    // sleep needed); the warn-stderr line still hits defaultStderrWrite.
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t-defaults",
      members: [{ name: "alice", role: "member", tui: "opencode" }],
    });
    const { tmux } = stubTmux({
      windows: [{ index: 0, name: "alice", active: true }],
    });
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const exit = await rotate(["--team-dir", scratch, "alice"], {
        buildTmux: () => tmux,
        briefsDir: join(scratch, "no-such-briefs-dir"),
        // opts.sleep / opts.stdout / opts.stderr DELIBERATELY omitted —
        // verb falls through to the named-default exports.
      });
      expect(exit).toBe(0);
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }
  });

  test("EPIC e-f28c2596 T7: rotate-lead fires brief boot prompt even when scrollback shows tokens (forceBootPrompt:true threaded into bootClaudeMember)", async () => {
    // Regression test for EPIC e-f28c2596 T7. Pre-fix: paneText with
    // `Nk tokens` triggered bootClaudeMember's already-booted sentinel,
    // which short-circuited the boot prompt → brief never re-pasted →
    // rotated lead at 0 tok of brief context. Post-fix: rotate.ts
    // unconditionally sets `forceBootPrompt: true`, so the sentinel is
    // bypassed and the boot prompt fires (observable as loadBuffer +
    // pasteBuffer calls carrying the boot-prompt body).
    //
    // Counter-fixture: the next test inverts forceBootPrompt via
    // opts.bootClaude.forceBootPrompt=false to confirm the override
    // still works (the Object.assign happens AFTER rotate.ts's default
    // — operator can pin the old behavior if needed).
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "lead-x", role: "team-lead", tui: "claude" }],
    });
    const { tmux, calls } = stubTmux({
      windows: [{ index: 0, name: "lead-x", active: true }],
      // paneText that pre-T7 would have short-circuited as already-booted
      // (matches `\d+k tokens`). With T7's forceBootPrompt:true default
      // the sentinel is bypassed; the realistic two-line render passes
      // readiness on the bare `❯` row before the boot prompt fires.
      paneText: "❯\n↑ 5k tokens",
    });
    const exit = await rotate(["--team-dir", scratch, "--lead"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      stderr: () => {},
      bootClaude: FAST_BOOT_CLAUDE,
    });
    expect(exit).toBe(0);
    // /clear lands on the lead pane (step 1 of rotate).
    expect(calls.sendKeys[0]?.target).toBe("atmux-t:lead-x");
    expect(calls.sendKeys[0]?.keys).toBe("/clear");
    // Boot prompt fires via loadBuffer + pasteBuffer (the T7 fix —
    // pre-fix these arrays would have been EMPTY because the sentinel
    // short-circuited).
    expect(calls.loadBuffer.length).toBeGreaterThanOrEqual(1);
    expect(calls.loadBuffer.some((l) => l.data.includes("/tmp/atmux-brief-generic-t.md"))).toBe(
      true,
    );
    expect(calls.pasteBuffer.length).toBeGreaterThanOrEqual(1);
  });

  test("EPIC e-f28c2596 T7: bootClaude.forceBootPrompt=false override pins legacy sentinel behavior (operator opt-out)", async () => {
    // Counter-fixture: explicit operator override via opts.bootClaude
    // (Object.assign runs AFTER rotate.ts's default forceBootPrompt:true,
    // so an explicit false here wins). The sentinel re-engages → no
    // loadBuffer/pasteBuffer (legacy short-circuit). Confirms the
    // forceBootPrompt option is honored from BOTH sides — rotate's
    // default and operator override.
    process.env.ATMUX_SESSION = "atmux-t";
    await seedTeam({
      name: "t",
      members: [{ name: "lead-x", role: "team-lead", tui: "claude" }],
    });
    const { tmux, calls } = stubTmux({
      windows: [{ index: 0, name: "lead-x", active: true }],
      paneText: "❯ ↑ 5k tokens", // triggers sentinel when forceBootPrompt=false
    });
    const exit = await rotate(["--team-dir", scratch, "--lead"], {
      buildTmux: () => tmux,
      briefsDir,
      sleep: async () => {},
      stdout: () => {},
      stderr: () => {},
      // Override: pin legacy already-booted sentinel behavior.
      bootClaude: { ...FAST_BOOT_CLAUDE, forceBootPrompt: false },
    });
    expect(exit).toBe(0);
    // /clear still fires (step 1 unchanged).
    expect(calls.sendKeys[0]?.keys).toBe("/clear");
    // But with forceBootPrompt=false override + tokens-in-scrollback,
    // the sentinel fires → status='already-booted' → no boot prompt
    // paste → loadBuffer + pasteBuffer remain empty.
    expect(calls.loadBuffer).toEqual([]);
    expect(calls.pasteBuffer).toEqual([]);
  });
});

describe("rotateLead", () => {
  test("delegates to rotate with --lead prepended", async () => {
    // rotateLead has no logic of its own — just argv re-prefix. Drive
    // it against a fixture and assert the lead branch fires (resolves
    // the lead role from roster).
    const dir = await mkdtemp(join(tmpdir(), "atmux-rotlead-"));
    const briefs = await mkdtemp(join(tmpdir(), "atmux-rotlead-briefs-"));
    try {
      const atmuxDir = join(dir, ".atmux");
      await mkdir(atmuxDir, { recursive: true });
      await writeFile(
        join(atmuxDir, "team.json"),
        JSON.stringify({
          name: "t",
          members: [{ name: "lead-x", role: "team-lead", tui: "claude" }],
        }),
      );
      const priorSession = process.env.ATMUX_SESSION;
      process.env.ATMUX_SESSION = "atmux-t";
      try {
        const { tmux, calls } = stubTmux({
          windows: [{ index: 0, name: "lead-x", active: true }],
          paneText: "❯ ↑ 5k tokens",
        });
        const exit = await rotateLead(["--team-dir", dir], {
          buildTmux: () => tmux,
          briefsDir: briefs,
          sleep: async () => {},
          stdout: () => {},
          bootClaude: FAST_BOOT_CLAUDE,
        });
        expect(exit).toBe(0);
        expect(calls.sendKeys[0]?.target).toBe("atmux-t:lead-x");
      } finally {
        if (priorSession !== undefined) process.env.ATMUX_SESSION = priorSession;
        else delete process.env.ATMUX_SESSION;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(briefs, { recursive: true, force: true });
    }
  });
});
