// Unit tests for src/verbs/tell-lead.ts.
// Bash spec: lib/tell.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  buildHeadsUp,
  findLead,
  parseTellLeadArgs,
  tellLead,
} from "../../../src/verbs/tell-lead.ts";

let socketDir: string;
let socketPath: string;
let teamDir: string;
let atmuxDir: string;
let priorTmux: string | undefined;
let tmux: TmuxNamespace;
let sessionPrefix: string;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-tell-lead-sock-"));
  socketPath = join(socketDir, "sock");
  teamDir = await mkdtemp(join(tmpdir(), "atmux-tell-lead-team-"));
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
    // expected
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  await rm(socketDir, { recursive: true, force: true });
  await rm(teamDir, { recursive: true, force: true });
});

async function captureStdoutStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const o1 = process.stdout.write.bind(process.stdout);
  const o2 = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => {
    stdout += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderr += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = o1;
    process.stderr.write = o2;
  }
}

async function stageTeam(
  members: ReadonlyArray<{ name: string; role?: string }>,
  withSession: boolean,
): Promise<{ teamName: string; sessionName: string }> {
  const teamName = `${sessionPrefix}-team`;
  const sessionName = `atmux-${teamName}`;
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: teamName, members }));
  if (withSession) {
    const first = members[0];
    if (first === undefined) throw new Error("test fail");
    await tmux.session.newSession({
      name: sessionName,
      shellCommand: "cat",
      windowName: first.name,
    });
    for (const m of members.slice(1)) {
      await tmux.window.newWindow({ sessionName, name: m.name, shellCommand: "cat" });
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return { teamName, sessionName };
}

// ---------- Pure: parseTellLeadArgs ----------

describe("parseTellLeadArgs", () => {
  test("plain msg", () => {
    expect(parseTellLeadArgs(["hello", "world"]).msg).toBe("hello world");
  });

  test("--socket / --team-dir consumed", () => {
    const a = parseTellLeadArgs(["--socket", "/s", "--team-dir", "/x", "msg"]);
    expect(a.socketPath).toBe("/s");
    expect(a.teamDir).toBe("/x");
  });

  test("`--` ends flag parsing", () => {
    expect(parseTellLeadArgs(["--", "--with-dashes"]).msg).toBe("--with-dashes");
  });

  test("missing msg → UsageError", () => {
    expect(() => parseTellLeadArgs([])).toThrow(UsageError);
  });

  test("--socket without value → UsageError", () => {
    expect(() => parseTellLeadArgs(["--socket"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseTellLeadArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown -* flag → UsageError", () => {
    expect(() => parseTellLeadArgs(["--bogus", "msg"])).toThrow(UsageError);
  });
});

// ---------- Pure: findLead ----------

describe("findLead", () => {
  test("returns member with role=team-lead when present", () => {
    const lead = findLead([
      { name: "alpha" },
      { name: "captain", role: "team-lead" },
      { name: "lead" }, // would match by name but role wins
    ]);
    expect(lead?.name).toBe("captain");
  });

  test("falls back to member named 'lead' when no role match", () => {
    const lead = findLead([{ name: "alpha" }, { name: "lead" }]);
    expect(lead?.name).toBe("lead");
  });

  test("returns undefined when neither match", () => {
    expect(findLead([{ name: "alpha" }, { name: "beta" }])).toBeUndefined();
  });
});

// ---------- Pure: buildHeadsUp ----------

describe("buildHeadsUp", () => {
  test("short msg: full text, no ellipsis", () => {
    expect(buildHeadsUp("short ask")).toBe("📬 driver-inbox has a new ask: short ask");
  });

  test("80-char msg: included full, no ellipsis", () => {
    const msg = "a".repeat(80);
    expect(buildHeadsUp(msg).endsWith(msg)).toBe(true);
    expect(buildHeadsUp(msg)).not.toContain("…");
  });

  test("81+ char msg: truncated to 80 + ellipsis", () => {
    const msg = "a".repeat(120);
    const out = buildHeadsUp(msg);
    expect(out).toContain("…");
    expect(out).toContain("a".repeat(80));
  });
});

// ---------- Integration ----------

describe("tellLead — integration", () => {
  test("happy path: appends to driver-inbox.md + pings lead (ADR-029 §F3)", async () => {
    // Per ADR-029 §F3 — bash atmux::ok writes to STDERR with `✅ atmux `
    // prefix (lib/common.sh:21); TS now mirrors. Earlier port wrote to
    // stdout with no prefix.
    await stageTeam([{ name: "alpha", role: "team-lead" }], true);
    const { stderr } = await captureStdoutStderr(() =>
      tellLead(["--socket", socketPath, "--team-dir", teamDir, "review", "the", "migration"]),
    );
    expect(stderr).toContain("✅ atmux tell-lead → alpha");
    const di = await Bun.file(join(atmuxDir, "driver-inbox.md")).text();
    expect(di).toContain("# Driver Inbox");
    expect(di).toContain("review the migration");
    // Send log written by sendToMember.
    const log = await Bun.file(join(atmuxDir, "logs", "send-alpha.log")).text();
    expect(log).toContain("driver-inbox has a new ask");
  });

  test("falls back to member named 'lead' when no team-lead role", async () => {
    await stageTeam([{ name: "alpha" }, { name: "lead" }], true);
    const { stderr } = await captureStdoutStderr(() =>
      tellLead(["--socket", socketPath, "--team-dir", teamDir, "msg"]),
    );
    expect(stderr).toContain("✅ atmux tell-lead → lead");
  });

  test("no lead defined → ConfigError", async () => {
    await stageTeam([{ name: "alpha" }, { name: "beta" }], false);
    await expect(tellLead(["--socket", socketPath, "--team-dir", teamDir, "msg"])).rejects.toThrow(
      ConfigError,
    );
  });

  test("ping failure → ConfigError 'no tmux window' after durable inbox write (ADR-029 §F6 + F7)", async () => {
    // Per ADR-029 §F6 + F7 — bash lib/tell.sh:44 calls send_to_member
    // unguarded; lib/send.sh:61-62 dies "no tmux window for <m> (is the
    // team running?)" / exit 1 when the window is missing. Earlier TS
    // port caught + warned + returned 0 (divergent). Now mirrors bash:
    // throws ConfigError with bash-byte-equal body. Inbox write before
    // the throw is durable and remains on disk.
    await stageTeam([{ name: "alpha", role: "team-lead" }], false);
    await expect(
      tellLead(["--socket", socketPath, "--team-dir", teamDir, "ask body"]),
    ).rejects.toThrow(/no tmux window for alpha \(is the team running\?\)/);
    // Inbox write happened BEFORE the throw — durable.
    const di = await Bun.file(join(atmuxDir, "driver-inbox.md")).text();
    expect(di).toContain("ask body");
  });

  test("multiple asks accumulate in driver-inbox", async () => {
    await stageTeam([{ name: "alpha", role: "team-lead" }], true);
    await captureStdoutStderr(() =>
      tellLead(["--socket", socketPath, "--team-dir", teamDir, "first"]),
    );
    await captureStdoutStderr(() =>
      tellLead(["--socket", socketPath, "--team-dir", teamDir, "second"]),
    );
    const di = await Bun.file(join(atmuxDir, "driver-inbox.md")).text();
    expect(di).toContain("first");
    expect(di).toContain("second");
  });

  test("driver-inbox entry timestamp is HH:MM MYT format (ADR-029 §F8)", async () => {
    // Bash atmux::now_myt emits HH:MM MYT (lib/common.sh:225); the TS port
    // earlier used formatMytFull (YYYY-MM-DD HH:MM:SS MYT) which violated
    // CLAUDE.md global timezone rule + diverged from bash. Verify the
    // correct shape after the F8 fix.
    await stageTeam([{ name: "alpha", role: "team-lead" }], true);
    await captureStdoutStderr(() =>
      tellLead(["--socket", socketPath, "--team-dir", teamDir, "format check"]),
    );
    const di = await Bun.file(join(atmuxDir, "driver-inbox.md")).text();
    expect(di).toMatch(/- \[\d{2}:\d{2} MYT\] format check/);
    expect(di).not.toMatch(/- \[\d{4}-\d{2}-\d{2}/);
  });

  test("t-bf09aec0: cursor advances after a successful tell-lead emit", async () => {
    // Wiring proof for the dedup primitive: tell-lead must record
    // the cursor (post-emit) so a polling supervisor on the SAME
    // file (lib/supervisor.sh, future TS supervisor) won't re-fire
    // for the same revision and burn lead tokens with "Stale
    // heads-up — already absorbed". The suppression itself is
    // tested at the primitive level in heads-up-cursor.test.ts;
    // here we verify tell-lead writes the cursor entry shape.
    await stageTeam([{ name: "alpha", role: "team-lead" }], true);
    await captureStdoutStderr(() =>
      tellLead(["--socket", socketPath, "--team-dir", teamDir, "first ask"]),
    );
    const cursorPath = join(atmuxDir, "state", "heads-up-cursor.json");
    const cursorJson = JSON.parse(await Bun.file(cursorPath).text()) as Record<string, number>;
    const inboxPath = join(atmuxDir, "driver-inbox.md");
    const key = `${inboxPath}:alpha`;
    expect(cursorJson[key]).toBeGreaterThan(0);
    // The cursor mtime should match the inbox file's mtime exactly
    // (we recorded what we observed on disk).
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(inboxPath);
    expect(cursorJson[key]).toBe(stat.mtimeMs);
  });

  test("t-bf09aec0: heads-up SUPPRESSED when cursor already at-or-past inbox mtime", async () => {
    // Replicate the polling-supervisor flood scenario: cursor has
    // already been advanced (by a different emitter — supervisor or
    // a racing tell-lead) past the current driver-inbox.md mtime.
    // tell-lead's pre-emit gate should suppress the redundant send
    // so the lead pane doesn't burn tokens on a stale ping.
    await stageTeam([{ name: "alpha", role: "team-lead" }], true);
    // Pre-seed the cursor with a huge mtime — any subsequent
    // append's mtime will be <= this value (system clock can't
    // realistically reach Number.MAX_SAFE_INTEGER ms).
    const inboxPath = join(atmuxDir, "driver-inbox.md");
    const fs = await import("node:fs/promises");
    await fs.mkdir(join(atmuxDir, "state"), { recursive: true });
    await fs.writeFile(
      join(atmuxDir, "state", "heads-up-cursor.json"),
      JSON.stringify({ [`${inboxPath}:alpha`]: Number.MAX_SAFE_INTEGER }),
      "utf8",
    );
    const sendLogPath = join(atmuxDir, "logs", "send-alpha.log");
    const logExistsBefore = await Bun.file(sendLogPath)
      .exists()
      .catch(() => false);

    const { stderr } = await captureStdoutStderr(() =>
      tellLead(["--socket", socketPath, "--team-dir", teamDir, "duplicate ask"]),
    );
    // Suppression-branch stderr surface tells the operator dedup hit.
    expect(stderr).toContain("heads-up suppressed: cursor already at mtime");
    // sendToMember was NOT invoked → no log file written.
    const logExistsAfter = await Bun.file(sendLogPath)
      .exists()
      .catch(() => false);
    expect(logExistsAfter).toBe(logExistsBefore);
    // BUT: appendDriverInbox still wrote — the durable record is
    // intact even when the ping is suppressed.
    const di = await Bun.file(inboxPath).text();
    expect(di).toContain("duplicate ask");
  });

  test("honours team.tmuxTmpdir when --socket is absent (t-f786031f regression)", async () => {
    // t-f786031f: pre-fix, tell-lead pinned `/tmp/atmux-<team>/sock`
    // unconditionally and ignored team.tmuxTmpdir. On project-local-
    // tmpdir teams the cage socket lives at
    // `<tmuxTmpdir>/tmux-<uid>/default` and `/tmp/...` is empty, so the
    // heads-up keystroke failed with "no tmux window for lead" while
    // the inbox append (which predates the send) still landed —
    // exactly the 07:52 + 08:25 MYT 2026-05-13 failures driver hit.
    //
    // This test stages a team with `tmuxTmpdir` pointing at a controlled
    // directory, runs a real tmux session at the resolveTeamSocket()-
    // computed path, and calls tellLead WITHOUT --socket. Pre-fix this
    // throws ConfigError (defaultSocketPath sees no socket at the
    // hardcoded /tmp path); post-fix tellLead resolves through
    // resolveTeamSocket(team) and the heads-up lands on the live cage.
    const { join: pjoin } = await import("node:path");
    const uid = process.getuid?.() ?? 0;
    const tmpdirParent = socketDir;
    const tmpdirSocket = pjoin(tmpdirParent, `tmux-${uid}`, "default");
    // tmux needs the socket's parent dir to exist before bind(2).
    await mkdir(pjoin(tmpdirParent, `tmux-${uid}`), { recursive: true });
    // Spin a fresh tmux on the tmuxTmpdir-derived socket.
    const tmpdirTmux = createTmux({ socketPath: tmpdirSocket, configFile: "/dev/null" });
    try {
      const teamName = `${sessionPrefix}-tmpdir`;
      const sessionName = `atmux-${teamName}`;
      await writeFile(
        join(atmuxDir, "team.json"),
        JSON.stringify({
          name: teamName,
          members: [{ name: "alpha", role: "team-lead" }],
          tmuxTmpdir: tmpdirParent,
        }),
      );
      await tmpdirTmux.session.newSession({
        name: sessionName,
        shellCommand: "cat",
        windowName: "alpha",
      });
      await new Promise((r) => setTimeout(r, 80));

      const { stderr } = await captureStdoutStderr(() =>
        tellLead(["--team-dir", teamDir, "regression ping"]),
      );
      expect(stderr).toContain("✅ atmux tell-lead → alpha");
      const di = await Bun.file(join(atmuxDir, "driver-inbox.md")).text();
      expect(di).toContain("regression ping");
      // Per-member send log lands ONLY when the keystroke fired — proves
      // tell-lead routed to the live tmpdir-derived socket, not the
      // hardcoded /tmp path.
      const log = await Bun.file(join(atmuxDir, "logs", "send-alpha.log")).text();
      expect(log).toContain("regression ping");
    } finally {
      try {
        await tmpdirTmux.server.killServer();
      } catch {
        // expected when test cleanup races
      }
    }
  });

  test("zero-byte driver-inbox.md does not get a leading \\n on first append (ADR-029 §F14)", async () => {
    // Bash `printf >> file` appends to EOF; a zero-byte file produces
    // just the entry, no leading separator. Earlier TS port falsely
    // prepended `\n` because the empty-string `existing` failed the
    // `endsWith("\n")` check, triggering the "needs separator" branch.
    // Result: bash 23 bytes vs TS 24 bytes (extra leading newline).
    await stageTeam([{ name: "alpha", role: "team-lead" }], true);
    // Pre-create driver-inbox.md as zero bytes — matches lifecycle
    // fixture preset (factory.ts:168), which is the parity-test stage.
    await Bun.write(join(atmuxDir, "driver-inbox.md"), "");
    await captureStdoutStderr(() =>
      tellLead(["--socket", socketPath, "--team-dir", teamDir, "test ask"]),
    );
    const di = await Bun.file(join(atmuxDir, "driver-inbox.md")).text();
    expect(di).not.toMatch(/^\n/);
    expect(di).toMatch(/^- \[\d{2}:\d{2} MYT\] test ask\n$/);
  });
});
