// Unit tests for src/verbs/send.ts (ADR-010 + ADR-004 amend).
// Bash spec ref: lib/send.sh @ worktree-frozen.
//
// Coverage strategy
// -----------------
// Heavy emphasis on `parseSendArgs` (every branch of the bash flag
// loop must be reproducible in isolation) + `buildMemberTarget` (pure
// concat, simple). Integration paths spin a real tmux server on an
// isolated socketPath per test (memory `feedback_tmux_test_isolation.md`):
//
//   1. Single-member happy path — send routes through core/send,
//      writes log, returns 0.
//   2. Single-member with missing team-member → ConfigError.
//   3. Broadcast happy path — iterates members, skips driver by default.
//   4. Broadcast --include-driver — does NOT skip driver.
//   5. Broadcast partial-failure — some members succeed, some throw
//      → returns 1 + writes warn lines to stderr.
//   6. Single-member missing team.json → ConfigError from requireTeam.
//
// Per-test isolation: each test stages a fresh `.atmux/team.json` +
// fresh tmux socket so cross-test state can't leak.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  buildMemberTarget,
  parseSendArgs,
  resolveMemberTarget,
  send,
} from "../../../src/verbs/send.ts";

// ---------- pure: parseSendArgs ----------

describe("parseSendArgs — flag parsing", () => {
  test("--broadcast at position 0 sets broadcast + msg from rest", () => {
    const a = parseSendArgs(["--broadcast", "hello", "world"]);
    expect(a.broadcast).toBe(true);
    expect(a.msg).toBe("hello world");
    expect(a.includeDriver).toBe(false);
    expect(a.member).toBeUndefined();
  });

  test("--broadcast NOT at position 0 is treated as a member name (bash parity)", () => {
    // Bash lib/send.sh:18 only checks position 1; later --broadcast
    // tokens fall through case `*) break` and become the member name.
    const a = parseSendArgs(["alpha", "--broadcast", "msg"]);
    expect(a.broadcast).toBe(false);
    expect(a.member).toBe("alpha");
    expect(a.msg).toBe("--broadcast msg");
  });

  test("--include-driver flag sets includeDriver=true (broadcast mode)", () => {
    const a = parseSendArgs(["--broadcast", "--include-driver", "ping"]);
    expect(a.includeDriver).toBe(true);
    expect(a.msg).toBe("ping");
  });

  test("--no-submit flag sets noSubmit=true", () => {
    const a = parseSendArgs(["--no-submit", "alpha", "msg"]);
    expect(a.noSubmit).toBe(true);
    expect(a.member).toBe("alpha");
  });

  test("--no-verify flag sets noVerify=true", () => {
    const a = parseSendArgs(["--no-verify", "alpha", "msg"]);
    expect(a.noVerify).toBe(true);
  });

  test("--submit-only sets submitOnly and needs NO message (ADR-273 D5)", () => {
    const a = parseSendArgs(["--submit-only", "alpha"]);
    expect(a.submitOnly).toBe(true);
    expect(a.member).toBe("alpha");
    expect(a.msg).toBe("");
  });

  test("submitOnly is false on every ordinary invocation", () => {
    expect(parseSendArgs(["alpha", "msg"]).submitOnly).toBe(false);
    expect(parseSendArgs(["--broadcast", "msg"]).submitOnly).toBe(false);
  });

  test("--submit-only WITH a message is refused, never silently dropped", () => {
    // Silently dropping it would send a keystroke while the operator
    // believed he had sent words.
    expect(() => parseSendArgs(["--submit-only", "alpha", "hello"])).toThrow(UsageError);
  });

  test("--submit-only + --no-submit is refused (they are opposites)", () => {
    expect(() => parseSendArgs(["--submit-only", "--no-submit", "alpha"])).toThrow(UsageError);
  });

  test("--submit-only + --broadcast is refused (a keystroke is not a broadcast)", () => {
    expect(() => parseSendArgs(["--broadcast", "--submit-only"])).toThrow(UsageError);
  });

  test("an ordinary send with an empty message is STILL a usage error", () => {
    // The empty-message relaxation is scoped to --submit-only only.
    expect(() => parseSendArgs(["alpha"])).toThrow(UsageError);
  });

  test("--socket <path> consumed; survives into SendArgs.socketPath", () => {
    const a = parseSendArgs(["--socket", "/tmp/sock", "alpha", "msg"]);
    expect(a.socketPath).toBe("/tmp/sock");
    expect(a.member).toBe("alpha");
  });

  test("--socket without value throws UsageError", () => {
    expect(() => parseSendArgs(["--socket"])).toThrow(UsageError);
  });

  test("--team-dir <dir> consumed; survives into SendArgs.teamDir", () => {
    const a = parseSendArgs(["--team-dir", "/some/dir", "alpha", "msg"]);
    expect(a.teamDir).toBe("/some/dir");
  });

  test("--team-dir without value throws UsageError", () => {
    expect(() => parseSendArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("--team-dir without value (broadcast mode) throws UsageError", () => {
    expect(() => parseSendArgs(["--broadcast", "--team-dir"])).toThrow(UsageError);
  });

  test("--socket without value (broadcast mode) throws UsageError", () => {
    expect(() => parseSendArgs(["--broadcast", "--socket"])).toThrow(UsageError);
  });

  test("`--` ends flag parsing; subsequent args are positional", () => {
    const a = parseSendArgs(["--", "alpha", "msg-with-dashes"]);
    expect(a.member).toBe("alpha");
    expect(a.msg).toBe("msg-with-dashes");
  });

  test("`--` (broadcast mode) ends flag parsing; subsequent args are msg", () => {
    const a = parseSendArgs(["--broadcast", "--", "msg-with-dashes"]);
    expect(a.broadcast).toBe(true);
    expect(a.msg).toBe("msg-with-dashes");
  });

  test("unknown -* flag throws UsageError", () => {
    expect(() => parseSendArgs(["--bogus", "alpha", "msg"])).toThrow(UsageError);
  });

  test("unknown -* flag in broadcast mode throws UsageError", () => {
    expect(() => parseSendArgs(["--broadcast", "--bogus", "msg"])).toThrow(UsageError);
  });

  test("missing member (single-member mode) throws UsageError", () => {
    expect(() => parseSendArgs([])).toThrow(UsageError);
  });

  test("empty member positional throws UsageError", () => {
    expect(() => parseSendArgs([""])).toThrow(UsageError);
  });

  test("empty msg throws UsageError (single-member)", () => {
    expect(() => parseSendArgs(["alpha"])).toThrow(UsageError);
  });

  test("empty msg throws UsageError (broadcast)", () => {
    expect(() => parseSendArgs(["--broadcast"])).toThrow(UsageError);
  });

  test("multi-word msg joined by single space (bash $* IFS=' ')", () => {
    const a = parseSendArgs(["alpha", "one", "two", "three"]);
    expect(a.msg).toBe("one two three");
  });

  // ---------- ADR-077 §F3: --from / --kind for cockpit-tier inbox ----------

  test("--from <sender> consumed; survives into SendArgs.from", () => {
    const a = parseSendArgs(["--from", "atmux:lead", "__superdoctor__", "hi"]);
    expect(a.from).toBe("atmux:lead");
    expect(a.member).toBe("__superdoctor__");
    expect(a.msg).toBe("hi");
  });

  test("--from without value throws UsageError", () => {
    expect(() => parseSendArgs(["--from"])).toThrow(UsageError);
  });

  test("--kind <kind> consumed; survives into SendArgs.kind", () => {
    const a = parseSendArgs(["--kind", "p0", "__superdoctor__", "alarm"]);
    expect(a.kind).toBe("p0");
    expect(a.msg).toBe("alarm");
  });

  test("--kind without value throws UsageError", () => {
    expect(() => parseSendArgs(["--kind"])).toThrow(UsageError);
  });

  test("--from/--kind are inert on regular member sends (passthrough)", () => {
    // The verb logic ignores them when member !== __superdoctor__; the
    // parser still accepts them for forward-compat.
    const a = parseSendArgs(["--from", "x", "--kind", "info", "alpha", "msg"]);
    expect(a.from).toBe("x");
    expect(a.kind).toBe("info");
    expect(a.member).toBe("alpha");
  });
});

// ---------- pure: buildMemberTarget ----------

describe("buildMemberTarget", () => {
  test("emoji-less window name → 'session:member'", () => {
    expect(buildMemberTarget("atmux-foo", "alpha", undefined)).toBe("atmux-foo:alpha");
  });

  test("emoji-prefixed window name → 'session:<emoji>-<member>' (ADR-135 §D3 hyphen separator)", () => {
    expect(buildMemberTarget("atmux-foo", "alpha", "🐝")).toBe("atmux-foo:🐝-alpha");
  });

  test("empty emoji string treated as no emoji (parity with buildWindowName)", () => {
    expect(buildMemberTarget("atmux-foo", "alpha", "")).toBe("atmux-foo:alpha");
  });
});

// ---------- resolveMemberTarget — cross-format self-heal (EPIC e-a3077ca0 T3) ----------

describe("resolveMemberTarget — window-name self-heal shim", () => {
  let socketDir: string;
  let socketPath: string;
  let priorTmux: string | undefined;
  let tmux: TmuxNamespace;
  let sessionName: string;

  beforeEach(async () => {
    socketDir = await mkdtemp(join(tmpdir(), "atmux-rmt-sock-"));
    socketPath = join(socketDir, "sock");
    priorTmux = process.env.TMUX;
    delete process.env.TMUX;
    tmux = createTmux({ socketPath, configFile: "/dev/null" });
    sessionName = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  });

  afterEach(async () => {
    try {
      await tmux.server.killServer();
    } catch {
      // expected: server may already be gone
    }
    if (priorTmux !== undefined) process.env.TMUX = priorTmux;
    await rm(socketDir, { recursive: true, force: true });
  });

  test("(a) canonical window exists → no rename, returns canonical target", async () => {
    // role=team-lead → buildWindowName produces `_-prefix` canonical.
    await tmux.session.newSession({
      name: sessionName,
      shellCommand: "cat",
      windowName: "🧭_lead",
    });
    const target = await resolveMemberTarget(
      tmux,
      sessionName,
      "lead",
      "🧭",
      undefined,
      "team-lead",
    );
    expect(target).toBe(`${sessionName}:🧭_lead`);
    // No additional window was created — canonical was already there.
    const wins = (await tmux.window.listWindows(sessionName)).map((w) => w.name);
    expect(wins).toContain("🧭_lead");
    expect(wins).not.toContain("🧭-lead");
  });

  test("(b) ADR-135 hyphen-form exists → atomic rename → returns canonical (default-member role)", async () => {
    // Stage the pre-ADR-161 hyphen form for a default-member role.
    await tmux.session.newSession({
      name: sessionName,
      shellCommand: "cat",
      windowName: "🧭-lead",
    });
    const target = await resolveMemberTarget(
      tmux,
      sessionName,
      "lead",
      "🧭",
      undefined,
      "team-lead",
    );
    expect(target).toBe(`${sessionName}:🧭_lead`);
    // Post-call: window was renamed in place.
    const wins = (await tmux.window.listWindows(sessionName)).map((w) => w.name);
    expect(wins).toContain("🧭_lead");
    expect(wins).not.toContain("🧭-lead");
  });

  test("(c) pre-ADR-135 no-separator form exists → atomic rename → returns canonical", async () => {
    // Stage the pre-ADR-135 concatenated form.
    await tmux.session.newSession({
      name: sessionName,
      shellCommand: "cat",
      windowName: "🧭lead",
    });
    const target = await resolveMemberTarget(
      tmux,
      sessionName,
      "lead",
      "🧭",
      undefined,
      "team-lead",
    );
    expect(target).toBe(`${sessionName}:🧭_lead`);
    const wins = (await tmux.window.listWindows(sessionName)).map((w) => w.name);
    expect(wins).toContain("🧭_lead");
    expect(wins).not.toContain("🧭lead");
  });

  test("(d) neither canonical nor legacy variants exist → ConfigError 'no tmux window for <canonical>'", async () => {
    // Empty session — no matching windows.
    await tmux.session.newSession({
      name: sessionName,
      shellCommand: "cat",
      windowName: "unrelated",
    });
    await expect(
      resolveMemberTarget(tmux, sessionName, "lead", "🧭", undefined, "team-lead"),
    ).rejects.toThrow(/no tmux window for 🧭_lead/);
  });

  test("non-default-role member (role=member) — hyphen IS canonical, only no-sep gets renamed", async () => {
    // For role="member", buildWindowName returns `<emoji>-<member>` (hyphen).
    // Stage the pre-ADR-135 no-separator legacy → rename to hyphen canonical.
    await tmux.session.newSession({
      name: sessionName,
      shellCommand: "cat",
      windowName: "🐝be-1",
    });
    const target = await resolveMemberTarget(tmux, sessionName, "be-1", "🐝", undefined, "member");
    expect(target).toBe(`${sessionName}:🐝-be-1`);
    const wins = (await tmux.window.listWindows(sessionName)).map((w) => w.name);
    expect(wins).toContain("🐝-be-1");
    expect(wins).not.toContain("🐝be-1");
  });
});

// ---------- integration: send() drives core/send ----------

describe("send() — integration", () => {
  let socketDir: string;
  let socketPath: string;
  let atmuxDir: string;
  let teamDir: string;
  let priorTmux: string | undefined;
  let tmux: TmuxNamespace;
  let sessionPrefix: string;

  beforeEach(async () => {
    socketDir = await mkdtemp(join(tmpdir(), "atmux-send-verb-sock-"));
    socketPath = join(socketDir, "sock");
    teamDir = await mkdtemp(join(tmpdir(), "atmux-send-verb-team-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    sessionPrefix = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    priorTmux = process.env.TMUX;
    delete process.env.TMUX;
    tmux = createTmux({ socketPath, configFile: "/dev/null" });
  });

  afterEach(async () => {
    try {
      await tmux.server.killServer();
    } catch {
      // expected: server may already be gone
    }
    if (priorTmux !== undefined) process.env.TMUX = priorTmux;
    await rm(socketDir, { recursive: true, force: true });
    await rm(teamDir, { recursive: true, force: true });
  });

  /** Stage a team.json with the given member roster + spin a tmux
   *  session named `<sessionPrefix>-team` with one window per member. */
  async function stageTeam(members: ReadonlyArray<{ name: string; emoji?: string }>): Promise<{
    teamName: string;
    sessionName: string;
  }> {
    const teamName = `${sessionPrefix}-team`;
    const sessionName = `atmux-${teamName}`;
    const team = { name: teamName, members };
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
    // Spin a session with the FIRST member as window 0, then add
    // windows for each remaining member, named per buildWindowName.
    const first = members[0];
    if (first === undefined) throw new Error("test setup: stageTeam needs ≥1 member");
    const firstWin =
      first.emoji !== undefined && first.emoji.length > 0
        ? `${first.emoji}${first.name}`
        : first.name;
    await tmux.session.newSession({
      name: sessionName,
      shellCommand: "cat",
      windowName: firstWin,
    });
    for (const m of members.slice(1)) {
      const winName = m.emoji !== undefined && m.emoji.length > 0 ? `${m.emoji}${m.name}` : m.name;
      await tmux.window.newWindow({
        sessionName,
        name: winName,
        shellCommand: "cat",
      });
    }
    // Tiny boot window so `cat` is consuming stdin before send.
    await new Promise((r) => setTimeout(r, 100));
    return { teamName, sessionName };
  }

  test("single-member send routes through core/send + writes log", async () => {
    const { teamName } = await stageTeam([{ name: "alpha" }]);
    const exit = await send([
      "--socket",
      socketPath,
      "--team-dir",
      teamDir,
      "--no-verify",
      "alpha",
      "hello",
      "world",
    ]);
    expect(exit).toBe(0);
    // The log file is written by core/send.ts::appendSendLog under
    // <atmuxDir>/logs/send-<member>.log.
    const logPath = join(atmuxDir, "logs", "send-alpha.log");
    const log = await Bun.file(logPath).text();
    expect(log).toContain("sent:");
    expect(log).toContain("hello world");
    // teamName is interpolated into the session — sanity rail.
    expect(teamName).toContain(sessionPrefix);
  });

  test("--submit-only delivers a keystroke and writes the action to the log", async () => {
    await stageTeam([{ name: "alpha" }]);
    const exit = await send([
      "--socket",
      socketPath,
      "--team-dir",
      teamDir,
      "--submit-only",
      "alpha",
    ]);
    expect(exit).toBe(0);
    const log = await Bun.file(join(atmuxDir, "logs", "send-alpha.log")).text();
    expect(log).toContain("submit-only");
  });

  test("--submit-only against the cockpit-tier inbox key is refused (no pane to submit into)", async () => {
    await stageTeam([{ name: "alpha" }]);
    await expect(
      send(["--socket", socketPath, "--team-dir", teamDir, "--submit-only", "__medic__"]),
    ).rejects.toThrow(UsageError);
  });

  test("single-member with non-existent name → ConfigError", async () => {
    await stageTeam([{ name: "alpha" }]);
    await expect(
      send(["--socket", socketPath, "--team-dir", teamDir, "--no-verify", "missing-name", "msg"]),
    ).rejects.toThrow(ConfigError);
  });

  test("missing team.json (no .atmux/team.json) → ConfigError", async () => {
    // Don't call stageTeam — leave atmuxDir empty.
    await expect(
      send(["--socket", socketPath, "--team-dir", teamDir, "--no-verify", "alpha", "msg"]),
    ).rejects.toThrow(ConfigError);
  });

  test("broadcast skips 'driver' member by default", async () => {
    await stageTeam([{ name: "driver" }, { name: "alpha" }, { name: "beta" }]);
    const exit = await send([
      "--broadcast",
      "--socket",
      socketPath,
      "--team-dir",
      teamDir,
      "--no-verify",
      "ping",
    ]);
    expect(exit).toBe(0);
    // Driver log MUST NOT exist; alpha + beta logs DO.
    expect(await Bun.file(join(atmuxDir, "logs", "send-driver.log")).exists()).toBe(false);
    expect(await Bun.file(join(atmuxDir, "logs", "send-alpha.log")).exists()).toBe(true);
    expect(await Bun.file(join(atmuxDir, "logs", "send-beta.log")).exists()).toBe(true);
  });

  test("broadcast --include-driver is refused by the ADR-239 §D2 send-keys guard", async () => {
    // Pre-ADR-239 this flag delivered into the driver pane. ADR-239 §D2
    // made driver panes operator-interactive ONLY: atmux NEVER sends
    // keystrokes to a pane whose name matches /^driver(-N)?$/, and
    // `src/abstractions/tmux.ts` enforces this at the lowest-level
    // send-keys helper (`DriverSendKeysViolation`). So a `driver`-named
    // member can no longer receive a broadcast even with --include-driver:
    // the guard throws, broadcastSend absorbs it into the per-member warn
    // bucket, sets anyFailed, and returns 1 (partial-failure). The driver
    // log is NEVER written (the throw fires in safePreflight's sendKeys,
    // before appendSendLog). The non-driver member (alpha) still delivers.
    await stageTeam([{ name: "driver" }, { name: "alpha" }]);
    let stderrBuf = "";
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    let exit: number;
    try {
      exit = await send([
        "--broadcast",
        "--include-driver",
        "--socket",
        socketPath,
        "--team-dir",
        teamDir,
        "--no-verify",
        "ping",
      ]);
    } finally {
      process.stderr.write = origStderrWrite;
    }
    // Partial-failure exit: the driver delivery was refused.
    expect(exit).toBe(1);
    // The warn names the driver member AND cites the ADR-239 §D2 refusal —
    // proves the failure is the driver-pane guard, not an unrelated error.
    expect(stderrBuf).toContain("send to driver failed");
    expect(stderrBuf).toContain("ADR-239 §D2 violation");
    expect(stderrBuf).toContain("refused to send-keys into driver pane");
    // Driver pane received NO keystrokes → no send-log was written for it.
    expect(await Bun.file(join(atmuxDir, "logs", "send-driver.log")).exists()).toBe(false);
    // The non-driver member still got its broadcast delivery.
    expect(await Bun.file(join(atmuxDir, "logs", "send-alpha.log")).exists()).toBe(true);
  });

  // ---------- ADR-077 §F3: __superdoctor__ inbox routing ----------

  test("send __superdoctor__ writes to inbox_messages, no tmux pane delivery", async () => {
    await stageTeam([{ name: "alpha" }]);
    const exit = await send([
      "--socket",
      socketPath,
      "--team-dir",
      teamDir,
      "__superdoctor__",
      "the cage cycled itself",
    ]);
    expect(exit).toBe(0);
    // No send-log written (no tmux pane delivery happened).
    expect(await Bun.file(join(atmuxDir, "logs", "send-__superdoctor__.log")).exists()).toBe(false);
    // The row landed in inbox_messages (verify via the read helper).
    const { loadInboxMessages } = await import("../../../src/core/inbox.ts");
    const rows = await loadInboxMessages(atmuxDir, { member: "__superdoctor__" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("the cage cycled itself");
    expect(rows[0]?.kind).toBe("heads-up");
    // Default sender = `<team-name>:cli`
    expect(rows[0]?.sender).toMatch(/:cli$/);
  });

  test("send __superdoctor__ --from honored, --kind honored", async () => {
    await stageTeam([{ name: "alpha" }]);
    const exit = await send([
      "--socket",
      socketPath,
      "--team-dir",
      teamDir,
      "--from",
      "atmux:lead",
      "--kind",
      "p0",
      "__superdoctor__",
      "demo in 20min, member wedged",
    ]);
    expect(exit).toBe(0);
    const { loadInboxMessages } = await import("../../../src/core/inbox.ts");
    const rows = await loadInboxMessages(atmuxDir, { member: "__superdoctor__" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sender).toBe("atmux:lead");
    expect(rows[0]?.kind).toBe("p0");
  });

  test("send __superdoctor__ does NOT require a member entry in team.json", async () => {
    // Stage a team that DOES NOT have a __superdoctor__ member; the
    // inbox-route should still succeed (cockpit-tier, not a team
    // member).
    await stageTeam([{ name: "alpha" }]);
    const exit = await send([
      "--socket",
      socketPath,
      "--team-dir",
      teamDir,
      "__superdoctor__",
      "ok",
    ]);
    expect(exit).toBe(0);
  });

  test("broadcast partial-failure → returns 1 + writes warn to stderr", async () => {
    // Stage alpha (real window) + ghost (NOT staged in tmux). The
    // paste-buffer call against ghost will TmuxError; broadcast
    // catches it, writes warn, continues.
    await stageTeam([{ name: "alpha" }]);
    // Hand-edit team.json to add a member with no tmux window.
    const teamName = `${sessionPrefix}-team`;
    const teamJson = {
      name: teamName,
      members: [{ name: "alpha" }, { name: "ghost" }],
    };
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(teamJson));

    let stderrBuf = "";
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const exit = await send([
        "--broadcast",
        "--socket",
        socketPath,
        "--team-dir",
        teamDir,
        "--no-verify",
        "ping",
      ]);
      expect(exit).toBe(1);
      expect(stderrBuf).toContain("send to ghost failed");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });
});
