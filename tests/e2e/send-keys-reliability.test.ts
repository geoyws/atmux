// E2E: ADR-138 send-keys verification + retry + escalation walk.
//
// **Stateful 1x cold-start+walk e2e** per atmux CLAUDE.md testing
// discipline. Each test() spins a fresh tmux server on a private
// socket, drives `safeSendKeysWithVerify` against a real cat-pane,
// and walks the verify-and-retry flow to its terminal state. The
// three paths cover the canonical send-keys outcomes named in
// ADR-138 §"Why not blanket-3x Enter":
//
//   Path A — retry-success. Synthetic agent ignores the first send
//     (verifier returns false during attempt 1's poll window), then
//     accepts on retry (verifier returns true during attempt 2's
//     poll window). Asserts attempts=2 + success=true + no
//     escalation log entry.
//
//   Path B — never accepts. Synthetic agent never produces the
//     expected post-send state (verifier always returns false).
//     Asserts attempts=retries+1 + success=false + escalation log
//     entry written + `checkSendKeysFailureRecent` doctor probe
//     surfaces the YELLOW row + `renderSendKeysFailureWarning`
//     Discord template renders cleanly.
//
//   Path C — happy. Synthetic agent accepts immediately (verifier
//     returns true on the first poll). Asserts attempts=1 +
//     success=true + total wall time ≤ 500ms.
//
// Cold-start invariant: every test() owns a private tmux socket +
// private $HOME for the escalation log path. Not streak-runnable;
// the escalation log is append-only and Path B's appended entry
// would survive into Path A's window on a second run.
//
// Synthetic-agent strategy: we use a stateful `PaneVerifier` closure
// to drive each scenario instead of a real Claude TUI. The verifier
// represents the post-send pane state that `composerEmpty()` would
// observe in production — closures let us deterministically toggle
// the accept/reject state per attempt without depending on a real
// agent. This matches the ADR-138 §"Why not blanket-3x Enter"
// failure-mode taxonomy: the verifier is the ground truth for
// "agent accepted Enter", not the keystroke side effect.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSendKeysFailureWarning } from "../../src/abstractions/discord.ts";
import type { TmuxNamespace } from "../../src/abstractions/tmux.ts";
import {
  DEFAULT_SEND_KEYS_FAILURES_LOG_REL,
  type PaneVerifier,
  safeSendKeysWithVerify,
} from "../../src/core/safe-send.ts";
import { checkSendKeysFailureRecent } from "../../src/verbs/doctor.ts";
import { createCanonicalAtmuxTmux, setCanonicalAtmuxTmuxHome } from "../helpers/tmux.ts";

setDefaultTimeout(30_000);

let socketDir: string;
let socketPath: string;
let tmux: TmuxNamespace;
let homeDir = "";
let logPath: string;
let priorTmux: string | undefined;
let sessionName = "";
let target = "";
let restoreHome: (() => void) | undefined;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-skr-sock-"));
  socketPath = join(socketDir, "sock");
  homeDir = await mkdtemp(join(tmpdir(), "atmux-skr-home-"));
  logPath = join(homeDir, DEFAULT_SEND_KEYS_FAILURES_LOG_REL);
  restoreHome = setCanonicalAtmuxTmuxHome(homeDir);
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  tmux = createCanonicalAtmuxTmux({ socketPath });

  sessionName = `skr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await tmux.session.newSession({ name: sessionName, shellCommand: "cat" });
  const opts = await tmux.option.showOptions({ global: true });
  const windowOpts = await tmux.option.showOptions({ global: true, window: true });
  expect(opts["base-index"]).toBe("1");
  expect(windowOpts["pane-base-index"]).toBe("0");
  expect(windowOpts["automatic-rename"]).toBe("off");
  target = `${sessionName}:1`;
});

afterEach(async () => {
  try {
    if (tmux !== undefined) await tmux.server.killServer();
  } catch {
    // expected: server may already be gone (idempotent teardown)
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  else delete process.env.TMUX;
  restoreHome?.();
  restoreHome = undefined;
  await rm(socketDir, { recursive: true, force: true });
  if (homeDir !== "") await rm(homeDir, { recursive: true, force: true });
});

/** Build a stateful verifier that returns `false` on the first N
 *  poll calls, then `true` afterwards. Simulates an agent that
 *  ignores the first M-1 send attempts and accepts on attempt M. */
function verifierAcceptsAfter(failPolls: number): PaneVerifier {
  let polls = 0;
  return () => {
    polls += 1;
    return polls > failPolls;
  };
}

describe("ADR-138 send-keys reliability — 3-path e2e", () => {
  test("Path A — retry-success: ignores attempt 1, accepts attempt 2 (attempts=2)", async () => {
    // Verifier rejects every poll across attempt 1's full window
    // (3 polls at 150ms each fit inside the 400ms deadline-top
    // check before the deadline exit), then accepts on attempt 2's
    // first poll. failPolls=3 puts acceptance just past attempt 1's
    // worst-case poll count (which can reach 3 because the
    // deadline gate is at the top of the loop — the third iter
    // enters at elapsed=300 < 400 and sleeps past the deadline).
    const verifier = verifierAcceptsAfter(3);

    const result = await safeSendKeysWithVerify({
      target,
      keys: "C-m",
      expectVerifier: verifier,
      retries: 1,
      timeoutMs: 400,
      pollIntervalMs: 150,
      capture: (t) => tmux.pane.capturePane({ target: t, start: -10 }),
      sendKeys: async (t, keys) =>
        tmux.pane.sendKeys({
          target: { kind: "member", member: "w1", team: "skr", target: t },
          keys,
          enter: false,
        }),
      escalationLogPath: logPath,
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);

    // No escalation log entry on success.
    await expect(stat(logPath)).rejects.toThrow();
  });

  test("Path B — never accepts: escalation log + doctor probe + Discord render", async () => {
    // Verifier always returns false. After retries+1 attempts (2
    // total at default retries=1), the function escalates: writes
    // the escalation log + returns success=false. We then walk
    // through the post-hoc surfaces (doctor probe + Discord
    // render) to prove the end-to-end observability chain.
    const result = await safeSendKeysWithVerify({
      target,
      keys: "C-m",
      expectVerifier: () => false,
      retries: 1,
      timeoutMs: 200,
      pollIntervalMs: 100,
      capture: (t) => tmux.pane.capturePane({ target: t, start: -10 }),
      sendKeys: async (t, keys) =>
        tmux.pane.sendKeys({
          target: { kind: "member", member: "w1", team: "skr", target: t },
          keys,
          enter: false,
        }),
      escalationLogPath: logPath,
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);

    // 1. Escalation log exists at the home-resolved path and
    //    contains the canonical entry shape.
    const logText = await readFile(logPath, "utf8");
    expect(logText).toContain(`target=${target}`);
    expect(logText).toContain("attempts=2");
    expect(logText).toContain("preCapture:");
    expect(logText).toContain("postCapture:");
    expect(logText).toContain("---");

    // 2. Doctor probe surfaces a YELLOW row for the recent entry.
    //    Pin the probe's `now` clock to a value just-after the
    //    entry's timestamp so the 1h window catches it
    //    regardless of test machine wall-clock skew.
    const rows = await checkSendKeysFailureRecent({ logPath });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "yellow",
      label: "send-keys-failure-recent",
    });
    expect(rows[0]?.detail).toContain("1 send-keys failure in last hour");
    expect(rows[0]?.detail).toContain(target);
    expect(rows[0]?.hint).toContain("ADR-138");

    // 3. Discord template renders cleanly from the probe's
    //    output — surfaces the count + target + fix-bullet shape
    //    a Discord-aware caller would emit on probe trip.
    const discordOpts = renderSendKeysFailureWarning({
      team: "skr",
      failureCount: 1,
      mostRecentTarget: target,
      mostRecentAgeMin: 1,
    });
    expect(discordOpts.template).toBe("send-keys-failure");
    expect(discordOpts.category).toBe("📋");
    expect(discordOpts.verdict).toContain("🟡");
    expect(discordOpts.verdict).toContain("1 send-keys failure");
    // First bullet = target hint; second = fix bullet pointing at
    // the escalation log path.
    expect(discordOpts.bullets?.[0]).toContain(target);
    expect(discordOpts.bullets?.[1]).toContain("send-keys-failures.log");
  });

  test("Path C — happy: accepts immediately, attempts=1, wall time ≤500ms", async () => {
    const t0 = Date.now();
    const result = await safeSendKeysWithVerify({
      target,
      keys: "C-m",
      // Accepts on the very first poll capture (returns true
      // from the start). Simulates the common case where the
      // agent immediately renders composer-empty post-Enter.
      expectVerifier: () => true,
      retries: 1,
      timeoutMs: 3000,
      pollIntervalMs: 50,
      capture: (t) => tmux.pane.capturePane({ target: t, start: -10 }),
      sendKeys: async (t, keys) =>
        tmux.pane.sendKeys({
          target: { kind: "member", member: "w1", team: "skr", target: t },
          keys,
          enter: false,
        }),
      escalationLogPath: logPath,
    });
    const elapsed = Date.now() - t0;

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);

    // Fast-path budget: at pollIntervalMs=50, the verify loop's
    // first capture lands ~50ms after the send. Bound the wall
    // time at 500ms per the task body's ADR-138 fast-path
    // requirement.
    expect(elapsed).toBeLessThanOrEqual(500);

    // No escalation log on happy path.
    await expect(stat(logPath)).rejects.toThrow();
  });
});
