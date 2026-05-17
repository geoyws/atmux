// Unit tests for src/verbs/cockpit-rotate.ts — ADR-167 T2 + T3.
//
// T2 (shipped c376f63): verb dispatch + argv parse + caller-scope gate
// refusal + gate-4 (never-rotate-superdriver) refusal + role
// classification.
//
// T3 (this commit): pre-flight gate impl —
//   - pure classifiers: classifyGate1 (TYPING in superdriver pane),
//     classifyGate2 (BUSY/COMPACTING in target pane), classifyGate3
//     (uptime <60min).
//   - IO orchestration: gate firing order, --force bypass matrix (gate
//     4 unconditional, gates 1-3 bypass), audit-row emission shape,
//     Discord refusal emission shape, swallow-on-error for audit +
//     Discord (observability is non-fatal).
//   - durationMs + callerScope + tsIso fields on each audit row.
//
// fe-1's T6 (t-18bddf4e) extends with each respawn path × handoff
// payload coverage once T4+T5 land.

import { describe, expect, test } from "bun:test";
import type { DiscordSendOpts } from "../../../src/abstractions/discord.ts";
import type { TmuxConfig, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import type { LoadedCockpit } from "../../../src/core/cockpit.ts";
import type { SafeSendKeysWithVerifyOpts } from "../../../src/core/safe-send.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  buildClaudeRespawnCommand,
  type CockpitRotateAuditRow,
  classifyGate1,
  classifyGate2,
  classifyGate3,
  classifyRole,
  claudeUiGoneVerifier,
  cockpitRotate,
  parseCockpitRotateArgs,
  serializeAuditRow,
  targetWindowForRole,
} from "../../../src/verbs/cockpit-rotate.ts";

// ---------- argv parser ----------

describe("parseCockpitRotateArgs", () => {
  test("rejects empty argv with usage hint", () => {
    expect(() => parseCockpitRotateArgs([])).toThrow(UsageError);
  });

  test("parses bare session-name with force=false", () => {
    const p = parseCockpitRotateArgs(["medic"]);
    expect(p).toEqual({ sessionName: "medic", force: false });
  });

  test("parses --force flag (positional first)", () => {
    const p = parseCockpitRotateArgs(["sentinel", "--force"]);
    expect(p).toEqual({ sessionName: "sentinel", force: true });
  });

  test("parses --force flag (positional last)", () => {
    const p = parseCockpitRotateArgs(["--force", "atmux"]);
    expect(p).toEqual({ sessionName: "atmux", force: true });
  });

  test("rejects unknown flag", () => {
    expect(() => parseCockpitRotateArgs(["medic", "--frob"])).toThrow(UsageError);
  });

  test("rejects duplicate positional", () => {
    expect(() => parseCockpitRotateArgs(["medic", "sentinel"])).toThrow(UsageError);
  });

  test("rejects only flags (no positional)", () => {
    expect(() => parseCockpitRotateArgs(["--force"])).toThrow(UsageError);
  });
});

// ---------- role + window resolver ----------

describe("classifyRole", () => {
  test("medic → medic", () => {
    expect(classifyRole("medic")).toBe("medic");
  });
  test("sentinel → sentinel", () => {
    expect(classifyRole("sentinel")).toBe("sentinel");
  });
  test("team-name → team-driver", () => {
    expect(classifyRole("atmux")).toBe("team-driver");
    expect(classifyRole("sopx")).toBe("team-driver");
    expect(classifyRole("unum")).toBe("team-driver");
  });
});

describe("targetWindowForRole", () => {
  test("medic → _medic (ADR-135 _-prefix)", () => {
    expect(targetWindowForRole("medic", "medic")).toBe("_medic");
  });
  test("sentinel → _sentinel", () => {
    expect(targetWindowForRole("sentinel", "sentinel")).toBe("_sentinel");
  });
  test("team-driver → bare team-name", () => {
    expect(targetWindowForRole("team-driver", "atmux")).toBe("atmux");
    expect(targetWindowForRole("team-driver", "sopx")).toBe("sopx");
  });
});

// ---------- T3: pure gate classifiers ----------

describe("classifyGate1 — user-not-typing", () => {
  test("READY pane passes", () => {
    expect(classifyGate1("$ ❯ ")).toBeNull();
  });
  test("empty capture passes (defensive)", () => {
    expect(classifyGate1("")).toBeNull();
  });
  test("TYPING (queued message) refuses", () => {
    // Per pane-state.ts, the TYPING pattern fires on the "Press up to
    // edit queued messages" banner that Claude Code shows when the
    // operator has typed text in the compose box.
    const text = "Press up to edit queued messages";
    const r = classifyGate1(text);
    expect(r).not.toBeNull();
    expect(r).toContain("compose-box");
  });
  test("BUSY (other state) does NOT trigger gate-1", () => {
    // Gate 1 is scoped to TYPING only; BUSY is gate-2's concern.
    expect(classifyGate1("✻ Cooked for 12s")).toBeNull();
  });
});

describe("classifyGate2 — pane-idle", () => {
  test("READY pane passes", () => {
    expect(classifyGate2("$ ❯ ")).toBeNull();
  });
  test("BUSY (`✻ ...`) refuses", () => {
    const r = classifyGate2("✻ Cooked for 12s");
    expect(r).not.toBeNull();
    expect(r).toContain("BUSY");
  });
  test("BUSY (`✽ Honking…`) refuses", () => {
    const r = classifyGate2("✽ Honking…");
    expect(r).not.toBeNull();
    expect(r).toContain("BUSY");
  });
  test("COMPACTING refuses", () => {
    const r = classifyGate2("Compacting conversation");
    expect(r).not.toBeNull();
    expect(r).toContain("COMPACTING");
  });
  test("TYPING does NOT trigger gate-2 (scoped to BUSY/COMPACTING)", () => {
    expect(classifyGate2("Press up to edit queued messages")).toBeNull();
  });
  test("UNKNOWN (no markers) passes", () => {
    expect(classifyGate2("ordinary text with no Claude Code markers")).toBeNull();
  });
});

describe("classifyGate3 — uptime", () => {
  const T0 = 1779100000000;

  test("mtime null (marker missing) refuses", () => {
    const r = classifyGate3(null, T0);
    expect(r).not.toBeNull();
    expect(r).toContain("missing");
    expect(r).toContain("--force to bypass");
  });
  test("uptime 0min refuses", () => {
    const r = classifyGate3(T0, T0);
    expect(r).not.toBeNull();
    expect(r).toContain("0.0min");
    expect(r).toContain("60min minimum");
  });
  test("uptime 30min refuses", () => {
    const r = classifyGate3(T0 - 30 * 60_000, T0);
    expect(r).not.toBeNull();
    expect(r).toContain("30.0min");
  });
  test("uptime 59.9min refuses (sub-threshold)", () => {
    const r = classifyGate3(T0 - 59.9 * 60_000, T0);
    expect(r).not.toBeNull();
  });
  test("uptime exactly 60min passes", () => {
    expect(classifyGate3(T0 - 60 * 60_000, T0)).toBeNull();
  });
  test("uptime 2h passes", () => {
    expect(classifyGate3(T0 - 2 * 60 * 60_000, T0)).toBeNull();
  });
});

// ---------- audit-row serializer ----------

describe("serializeAuditRow", () => {
  test("emits one NDJSON line with trailing newline", () => {
    const row: CockpitRotateAuditRow = {
      ts: "2026-05-17T10:00:00.000Z",
      role: "medic",
      sessionName: "medic",
      outcome: "gate-1-refused",
      durationMs: 12,
      callerScope: "driver",
      error: "compose-box has queued text",
    };
    const out = serializeAuditRow(row);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n").length).toBe(2); // line + empty
    const parsed = JSON.parse(out.trimEnd());
    expect(parsed).toEqual(row);
  });
});

// ---------- T3: cockpitRotate IO orchestration ----------

/** Parse the first audit row from a harness; throws if none written.
 *  Wraps the index-access so call-sites stay terse without tripping
 *  biome's noNonNullAssertion. */
function firstAuditRow(h: TestHarness): CockpitRotateAuditRow {
  const row0 = h.appendedAudit[0];
  if (row0 === undefined) throw new Error("expected appendedAudit[0] but found none");
  return JSON.parse(row0.content.trimEnd());
}

/** First Discord call; throws if none made. */
function firstDiscord(h: TestHarness): DiscordSendOpts {
  const c0 = h.discordCalls[0];
  if (c0 === undefined) throw new Error("expected discordCalls[0] but found none");
  return c0;
}

interface TestHarness {
  capturedStderr: string[];
  appendedAudit: { path: string; content: string }[];
  discordCalls: DiscordSendOpts[];
  /** Captures (`tmux capture-pane`) keyed by `<session>:<window>`. */
  captures: Map<string, string>;
  /** mtime returns keyed by absolute path. */
  stats: Map<string, { mtimeMs: number } | null>;
  /** Returns ms; defaults to constant T0. */
  nowMs(): number;
  // ---- T4 respawn-path harness state ----
  /** Synthetic cockpit returned by the injected `loadCockpit` seam. */
  cockpit: LoadedCockpit;
  /** Whether `loadCockpit` should throw — tests the respawn-failed path. */
  loadCockpitThrows?: Error;
  /** Recorded safe-send-keys-with-verify invocations. */
  ctrlCCalls: { target: string; keys: string }[];
  /** Whether the verifier should report success (true) or escalation
   *  (false). Default true. */
  ctrlCSucceeds: boolean;
  /** Recorded `tmux.window.killWindow` invocations. */
  killWindowCalls: string[];
  /** Force killWindow to throw the given error on next call. */
  killWindowThrows?: Error;
  /** Recorded `tmux.window.newWindow` invocations. */
  newWindowCalls: { name: string; shellCommand: string }[];
  /** Window-index newWindow returns; default 4 (matches medic at idx 4
   *  for a fresh cockpit per ADR-135 §D2). */
  newWindowIndex: number;
  /** Force newWindow to throw the given error on next call. */
  newWindowThrows?: Error;
  /** Recorded `tmux.window.listWindows` results — keyed by sessionName. */
  windowsBySession: Map<string, { index: number; id: string; name: string; active: boolean }[]>;
  /** Recorded medic auto-start invocations. */
  medicAutoStartCalls: { sessionName: string; windowIndex: number }[];
  /** Recorded sentinel auto-start invocations. */
  sentinelAutoStartCalls: { sessionName: string; windowIndex: number }[];
}

const T0 = 1779100000000;

/** Default synthetic cockpit — declares medic + sentinel (claude impl)
 *  with explicit `/root/.claude` accounts so the wrapper resolver
 *  returns `claude`. Tests assert respawn shape against this baseline;
 *  per-test overrides build narrower cockpit shapes. */
function defaultCockpit(): LoadedCockpit {
  return {
    sessions: [],
    teams: [
      {
        name: "atmux",
        root: "/root/work/src/atmux",
        enabled: true,
        claudeAccount: { configDir: "/root/.claude" },
      },
    ],
    medic: {
      enabled: true,
      claudeAccount: { configDir: "/root/.claude" },
    },
    sentinel: {
      impl: "claude",
      enabled: true,
      claudeAccount: { configDir: "/root/.claude" },
    },
  } as unknown as LoadedCockpit;
}

function makeHarness(overrides: Partial<TestHarness> = {}): TestHarness {
  const captures = overrides.captures ?? new Map<string, string>();
  const stats = overrides.stats ?? new Map<string, { mtimeMs: number } | null>();
  return {
    capturedStderr: overrides.capturedStderr ?? [],
    appendedAudit: overrides.appendedAudit ?? [],
    discordCalls: overrides.discordCalls ?? [],
    captures,
    stats,
    nowMs: overrides.nowMs ?? (() => T0),
    cockpit: overrides.cockpit ?? defaultCockpit(),
    ...(overrides.loadCockpitThrows !== undefined
      ? { loadCockpitThrows: overrides.loadCockpitThrows }
      : {}),
    ctrlCCalls: overrides.ctrlCCalls ?? [],
    ctrlCSucceeds: overrides.ctrlCSucceeds ?? true,
    killWindowCalls: overrides.killWindowCalls ?? [],
    ...(overrides.killWindowThrows !== undefined
      ? { killWindowThrows: overrides.killWindowThrows }
      : {}),
    newWindowCalls: overrides.newWindowCalls ?? [],
    newWindowIndex: overrides.newWindowIndex ?? 4,
    ...(overrides.newWindowThrows !== undefined
      ? { newWindowThrows: overrides.newWindowThrows }
      : {}),
    windowsBySession: overrides.windowsBySession ?? new Map(),
    medicAutoStartCalls: overrides.medicAutoStartCalls ?? [],
    sentinelAutoStartCalls: overrides.sentinelAutoStartCalls ?? [],
  };
}

function makeTmuxFactory(h: TestHarness): (cfg: TmuxConfig) => TmuxNamespace {
  return (_cfg: TmuxConfig) =>
    ({
      pane: {
        capturePane: async (opts: { target: string }) => {
          return h.captures.get(opts.target) ?? "";
        },
        sendKeys: async () => {},
      },
      window: {
        killWindow: async (target: string) => {
          h.killWindowCalls.push(target);
          if (h.killWindowThrows !== undefined) throw h.killWindowThrows;
        },
        newWindow: async (opts: { name?: string; shellCommand?: string }) => {
          h.newWindowCalls.push({
            name: opts.name ?? "",
            shellCommand: opts.shellCommand ?? "",
          });
          if (h.newWindowThrows !== undefined) throw h.newWindowThrows;
          return { sessionName: "atmux_cockpit", windowIndex: h.newWindowIndex };
        },
        listWindows: async (sessionName: string) => {
          return h.windowsBySession.get(sessionName) ?? [];
        },
      },
    }) as unknown as TmuxNamespace;
}

/** Stub safeSendKeysWithVerify — records the call + invokes the
 *  verifier and sendKeys closures so the underlying lambdas are
 *  exercised (verifier-regex + sendKeys SendTarget adapter). Returns
 *  the canned success/failure result without touching real tmux. */
function makeSafeSendKeysStub(h: TestHarness) {
  return async (opts: SafeSendKeysWithVerifyOpts) => {
    h.ctrlCCalls.push({ target: opts.target, keys: opts.keys });
    // Invoke the closures the caller injected so coverage exercises
    // the adapter lambdas (capture / sendKeys) + the verifier. Test
    // stub for capture returns "" → verifier matches (TUI gone) →
    // success.
    await opts.capture(opts.target);
    await opts.sendKeys(opts.target, opts.keys);
    const verifierOutput = opts.expectVerifier("");
    return {
      success: h.ctrlCSucceeds && verifierOutput,
      attempts: 1,
      finalCapture: h.ctrlCSucceeds ? "" : "❯ claude TUI still visible",
    };
  };
}

function harnessOpts(h: TestHarness) {
  return {
    env: { ATMUX_CALLER_SCOPE: "driver", HOME: "/test/home" },
    homeDir: "/test/home",
    cockpitSessionName: "atmux_cockpit",
    cockpitSocketName: "atmux-cockpit",
    nowMs: () => h.nowMs(),
    stderr: (m: string) => h.capturedStderr.push(m),
    tmuxFactory: makeTmuxFactory(h),
    stat: async (path: string) => h.stats.get(path) ?? null,
    appendText: async (path: string, content: string) => {
      h.appendedAudit.push({ path, content });
    },
    discordSend: async (opts: DiscordSendOpts) => {
      h.discordCalls.push(opts);
    },
    // ---- T4 respawn seams ----
    loadCockpit: async () => {
      if (h.loadCockpitThrows !== undefined) throw h.loadCockpitThrows;
      return h.cockpit;
    },
    safeSendKeysWithVerify: makeSafeSendKeysStub(h),
    autoStartMedicLoop: async (opts: { sessionName: string; windowIndex: number }) => {
      h.medicAutoStartCalls.push({
        sessionName: opts.sessionName,
        windowIndex: opts.windowIndex,
      });
    },
    autoStartSentinelLoop: async (opts: { sessionName: string; windowIndex: number }) => {
      h.sentinelAutoStartCalls.push({
        sessionName: opts.sessionName,
        windowIndex: opts.windowIndex,
      });
    },
    autoStartTimeoutMs: 0, // bail immediately in tests
  };
}

describe("cockpitRotate — gate-4 (T2 carry-forward)", () => {
  test("refuses superdriver under --force, emits audit + Discord", async () => {
    const h = makeHarness();
    const exit = await cockpitRotate(["superdriver", "--force"], harnessOpts(h));
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-4-never-rotate-superdriver");
    expect(h.appendedAudit.length).toBe(1);
    const row = firstAuditRow(h);
    expect(row.outcome).toBe("gate-4-refused");
    expect(row.sessionName).toBe("superdriver");
    expect(row.callerScope).toBe("driver");
    expect(h.discordCalls.length).toBe(1);
    expect(firstDiscord(h).template).toBe("cockpit-rotate-refused");
  });

  test("gate-4 fires before caller-scope (cheapest gate first)", async () => {
    const h = makeHarness();
    const opts = {
      ...harnessOpts(h),
      env: { HOME: "/test/home" }, // no driver scope
    };
    const exit = await cockpitRotate(["superdriver"], opts);
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-4-never-rotate-superdriver");
  });
});

describe("cockpitRotate — caller-scope gate", () => {
  test("throws ConfigError when env not 'driver'", async () => {
    const h = makeHarness();
    const opts = {
      ...harnessOpts(h),
      env: { HOME: "/test/home" }, // no driver scope
    };
    await expect(cockpitRotate(["medic"], opts)).rejects.toThrow(ConfigError);
  });
});

describe("cockpitRotate — gate 1 (user-not-typing)", () => {
  test("refuses when superdriver compose-box has queued text", async () => {
    const h = makeHarness();
    h.captures.set("atmux_cockpit:_superdriver", "Press up to edit queued messages");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-1-user-not-typing");
    expect(h.appendedAudit.length).toBe(1);
    const row = firstAuditRow(h);
    expect(row.outcome).toBe("gate-1-refused");
    expect(row.role).toBe("medic");
    expect(h.discordCalls.length).toBe(1);
    expect(firstDiscord(h).template).toBe("cockpit-rotate-refused");
  });

  test("--force bypasses gate-1 → continues to T4 respawn (exit 0)", async () => {
    const h = makeHarness();
    // Even with TYPING in superdriver, --force should bypass to respawn.
    h.captures.set("atmux_cockpit:_superdriver", "Press up to edit queued messages");
    h.stats.set("/test/home/.claude/teams/__cockpit__/medic/session-start.txt", {
      mtimeMs: T0 - 2 * 60 * 60_000,
    });
    const exit = await cockpitRotate(["medic", "--force"], harnessOpts(h));
    expect(exit).toBe(0);
    // Success path: respawn lands, success audit row written, no Discord.
    expect(h.killWindowCalls).toEqual(["atmux_cockpit:_medic"]);
    expect(h.newWindowCalls.length).toBe(1);
    expect(h.appendedAudit.length).toBe(1);
    const row = firstAuditRow(h);
    expect(row.outcome).toBe("success");
  });
});

describe("cockpitRotate — gate 2 (pane-idle)", () => {
  test("refuses when target pane is BUSY (`✻ Cooked`)", async () => {
    const h = makeHarness();
    h.captures.set("atmux_cockpit:_medic", "✻ Cooked for 12s");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-2-pane-idle");
    expect(h.appendedAudit.length).toBe(1);
    const row = firstAuditRow(h);
    expect(row.outcome).toBe("gate-2-refused");
  });

  test("refuses when target pane is COMPACTING", async () => {
    const h = makeHarness();
    h.captures.set("atmux_cockpit:_sentinel", "Compacting conversation");
    const exit = await cockpitRotate(["sentinel"], harnessOpts(h));
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-2-pane-idle");
  });

  test("team-driver target reads from team-name window", async () => {
    const h = makeHarness();
    h.captures.set("atmux_cockpit:atmux", "✽ Honking…");
    const exit = await cockpitRotate(["atmux"], harnessOpts(h));
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-2-pane-idle");
    expect(firstDiscord(h).template).toBe("cockpit-rotate-refused");
  });
});

describe("cockpitRotate — gate 3 (uptime)", () => {
  test("refuses when session-start marker is missing", async () => {
    const h = makeHarness();
    // No stat entry → returns null → gate-3 refuses with "missing" reason.
    const exit = await cockpitRotate(["medic"], harnessOpts(h));
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-3-uptime");
    expect(h.capturedStderr.join("")).toContain("missing");
  });

  test("refuses when uptime <60min", async () => {
    const h = makeHarness();
    h.stats.set("/test/home/.claude/teams/__cockpit__/medic/session-start.txt", {
      mtimeMs: T0 - 30 * 60_000,
    });
    const exit = await cockpitRotate(["medic"], harnessOpts(h));
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-3-uptime");
    const row = firstAuditRow(h);
    expect(row.outcome).toBe("gate-3-refused");
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("passes when uptime ≥60min → T4 respawn fires (exit 0)", async () => {
    const h = makeHarness();
    h.stats.set("/test/home/.claude/teams/__cockpit__/medic/session-start.txt", {
      mtimeMs: T0 - 2 * 60 * 60_000,
    });
    const exit = await cockpitRotate(["medic"], harnessOpts(h));
    expect(exit).toBe(0);
    // Refusal not fired — success audit row only, no Discord.
    expect(h.appendedAudit.length).toBe(1);
    expect(firstAuditRow(h).outcome).toBe("success");
    expect(h.discordCalls.length).toBe(0);
  });
});

describe("cockpitRotate — observability fault-tolerance", () => {
  test("audit-log append failure does NOT block refusal exit", async () => {
    const h = makeHarness();
    const opts = {
      ...harnessOpts(h),
      appendText: async () => {
        throw new Error("disk full");
      },
    };
    const exit = await cockpitRotate(["superdriver", "--force"], opts);
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-4-never-rotate-superdriver");
  });

  test("Discord send failure does NOT block refusal exit", async () => {
    const h = makeHarness();
    const opts = {
      ...harnessOpts(h),
      discordSend: async () => {
        throw new Error("webhook 503");
      },
    };
    const exit = await cockpitRotate(["superdriver", "--force"], opts);
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-4-never-rotate-superdriver");
    expect(h.appendedAudit.length).toBe(1); // audit still written
  });
});

describe("cockpitRotate — --force bypass matrix (per ADR-167)", () => {
  test("gate-4 is NOT bypassed by --force (row 4 column 'no')", async () => {
    const h = makeHarness();
    const exit = await cockpitRotate(["superdriver", "--force"], harnessOpts(h));
    expect(exit).toBe(65);
  });

  test("gates 1-3 ALL skipped under --force (rows 1-3 column 'yes')", async () => {
    const h = makeHarness();
    // All three gate sources would fire if checked:
    h.captures.set("atmux_cockpit:_superdriver", "Press up to edit queued messages");
    h.captures.set("atmux_cockpit:_medic", "✻ Cooked for 5s");
    // No stat → would fire gate-3 missing.
    const exit = await cockpitRotate(["medic", "--force"], harnessOpts(h));
    // T4 respawn lands cleanly; success audit only (no Discord on
    // success — the noise budget is reserved for refusals).
    expect(exit).toBe(0);
    expect(h.appendedAudit.length).toBe(1);
    expect(firstAuditRow(h).outcome).toBe("success");
    expect(h.discordCalls.length).toBe(0);
  });
});

describe("cockpitRotate — argv parse error bubbling", () => {
  test("UsageError bubbles to caller (cli.ts maps to exit 64)", async () => {
    const h = makeHarness();
    await expect(cockpitRotate([], harnessOpts(h))).rejects.toThrow(UsageError);
  });
});

// =============================================================
// T4: per-role respawn matrix (t-a245bbc8)
// =============================================================

/** Helper — pass gates so T4 respawn runs. Sets gate-3 marker old
 *  enough to pass without --force. */
function passGates(h: TestHarness, role: "medic" | "sentinel" | "team-driver"): void {
  h.stats.set(`/test/home/.claude/teams/__cockpit__/${role}/session-start.txt`, {
    mtimeMs: T0 - 2 * 60 * 60_000,
  });
}

// ---------- T4: claude-UI-gone verifier ----------

describe("claudeUiGoneVerifier", () => {
  test("empty capture → claude UI absent → true", () => {
    expect(claudeUiGoneVerifier("")).toBe(true);
  });

  test("shell prompt only → claude UI absent → true", () => {
    expect(claudeUiGoneVerifier("$ ")).toBe(true);
    expect(claudeUiGoneVerifier("# ")).toBe(true);
  });

  test("`❯` compose marker → claude UI present → false", () => {
    expect(claudeUiGoneVerifier("❯ ")).toBe(false);
  });

  test("`✻ Cooked` busy marker → claude UI present → false", () => {
    // The `✻` glyph plus the literal `Cooked` adverb both trigger the
    // negative match (defense-in-depth — either signal suffices).
    expect(claudeUiGoneVerifier("✻ Cooked for 12s")).toBe(false);
    expect(claudeUiGoneVerifier("Cooked for 12s")).toBe(false);
  });

  test("`✽ Honking…` busy marker → claude UI present → false", () => {
    expect(claudeUiGoneVerifier("✽ Honking…")).toBe(false);
    expect(claudeUiGoneVerifier("Honking for 3s")).toBe(false);
  });

  test("`Schlepping…` busy marker → claude UI present → false", () => {
    expect(claudeUiGoneVerifier("Schlepping for 2s")).toBe(false);
  });

  test("`Compacting conversation` banner → claude UI present → false", () => {
    expect(claudeUiGoneVerifier("Compacting conversation")).toBe(false);
  });
});

// ---------- T4: claude-wrapper resolver in spawn line ----------

describe("buildClaudeRespawnCommand", () => {
  test("default (no account) → bare claude wrapper", () => {
    const cmd = buildClaudeRespawnCommand(undefined, undefined);
    expect(cmd).toContain(" claude");
    expect(cmd).toContain("CLAUDE_GUARD_AGENT=1");
    expect(cmd).toContain("--permission-mode auto");
    expect(cmd).toContain("--model claude-opus-4-7");
  });

  test("/root/.claude → claude (literal in spawn line)", () => {
    const cmd = buildClaudeRespawnCommand({ configDir: "/root/.claude" }, undefined);
    expect(cmd).toMatch(/CLAUDE_GUARD_AGENT=1 claude /);
  });

  test("/root/.claude-unum → c-u wrapper-alias", () => {
    const cmd = buildClaudeRespawnCommand({ configDir: "/root/.claude-unum" }, undefined);
    expect(cmd).toMatch(/CLAUDE_GUARD_AGENT=1 c-u /);
    expect(cmd).not.toContain("CLAUDE_CONFIG_DIR=");
  });

  test("/root/.claude-icloud → c-ic wrapper-alias", () => {
    const cmd = buildClaudeRespawnCommand({ configDir: "/root/.claude-icloud" }, undefined);
    expect(cmd).toMatch(/CLAUDE_GUARD_AGENT=1 c-ic /);
  });

  test("/root/.claude-ifca → c-i wrapper-alias", () => {
    const cmd = buildClaudeRespawnCommand({ configDir: "/root/.claude-ifca" }, undefined);
    expect(cmd).toMatch(/CLAUDE_GUARD_AGENT=1 c-i /);
  });

  test("unknown configDir throws ConfigError (refused upstream of mutation)", () => {
    expect(() =>
      buildClaudeRespawnCommand({ configDir: "/root/.claude-bogus" }, undefined),
    ).toThrow(ConfigError);
  });

  test("tuiOverrides.permissionMode threads through", () => {
    const cmd = buildClaudeRespawnCommand(undefined, { permissionMode: "dontAsk" });
    expect(cmd).toContain("--permission-mode dontAsk");
    expect(cmd).not.toContain("--permission-mode auto");
  });

  test("tuiOverrides.pluginDir adds --plugin-dir=<X>", () => {
    const cmd = buildClaudeRespawnCommand(undefined, {
      pluginDir: "/home/op/.claude/plugins",
    });
    expect(cmd).toContain("--plugin-dir=/home/op/.claude/plugins");
  });

  test("no pluginDir override → no --plugin-dir flag", () => {
    const cmd = buildClaudeRespawnCommand(undefined, undefined);
    expect(cmd).not.toContain("--plugin-dir");
  });
});

// ---------- T4: medic respawn path ----------

describe("cockpitRotate — T4 medic respawn", () => {
  test("happy-path: Ctrl-C → killWindow → newWindow with wrapper-alias → autoStart → success audit", async () => {
    const h = makeHarness();
    passGates(h, "medic");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));

    expect(exit).toBe(0);
    // Ctrl-C fired against the medic window via cockpit socket.
    expect(h.ctrlCCalls.length).toBe(1);
    expect(h.ctrlCCalls[0]?.target).toBe("atmux_cockpit:_medic");
    expect(h.ctrlCCalls[0]?.keys).toBe("C-c");
    // killWindow then newWindow on the same window.
    expect(h.killWindowCalls).toEqual(["atmux_cockpit:_medic"]);
    expect(h.newWindowCalls.length).toBe(1);
    expect(h.newWindowCalls[0]?.name).toBe("_medic");
    expect(h.newWindowCalls[0]?.shellCommand).toContain(" claude ");
    expect(h.newWindowCalls[0]?.shellCommand).toContain("CLAUDE_GUARD_AGENT=1");
    // Medic auto-start fired at the spawned window index.
    expect(h.medicAutoStartCalls.length).toBe(1);
    expect(h.medicAutoStartCalls[0]?.windowIndex).toBe(4);
    // Sentinel auto-start NOT fired (separate role).
    expect(h.sentinelAutoStartCalls.length).toBe(0);
    // Success audit row written (no Discord).
    expect(h.appendedAudit.length).toBe(1);
    const row = firstAuditRow(h);
    expect(row.outcome).toBe("success");
    expect(row.role).toBe("medic");
    expect(row.sessionName).toBe("medic");
    expect(row.callerScope).toBe("driver");
    expect(h.discordCalls.length).toBe(0);
  });

  test("non-default claudeAccount routes through wrapper-alias resolver", async () => {
    const h = makeHarness({
      cockpit: {
        ...defaultCockpit(),
        medic: {
          enabled: true,
          claudeAccount: { configDir: "/root/.claude-unum" },
        },
      } as unknown as LoadedCockpit,
    });
    passGates(h, "medic");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));
    expect(exit).toBe(0);
    expect(h.newWindowCalls[0]?.shellCommand).toContain(" c-u ");
    expect(h.newWindowCalls[0]?.shellCommand).not.toContain(" claude ");
  });

  test("medic with no declared claudeAccount → default to bare claude", async () => {
    const h = makeHarness({
      cockpit: {
        ...defaultCockpit(),
        medic: { enabled: true }, // no claudeAccount field
      } as unknown as LoadedCockpit,
    });
    passGates(h, "medic");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));
    expect(exit).toBe(0);
    expect(h.newWindowCalls[0]?.shellCommand).toContain(" claude ");
  });
});

// ---------- T4: sentinel respawn path ----------

describe("cockpitRotate — T4 sentinel respawn", () => {
  test("claude-impl: wrapper-alias + sentinel autoStart fires", async () => {
    const h = makeHarness();
    passGates(h, "sentinel");
    const exit = await cockpitRotate(["sentinel"], harnessOpts(h));

    expect(exit).toBe(0);
    expect(h.killWindowCalls).toEqual(["atmux_cockpit:_sentinel"]);
    expect(h.newWindowCalls[0]?.name).toBe("_sentinel");
    expect(h.newWindowCalls[0]?.shellCommand).toContain(" claude ");
    // Sentinel auto-start fired; medic auto-start NOT fired.
    expect(h.sentinelAutoStartCalls.length).toBe(1);
    expect(h.medicAutoStartCalls.length).toBe(0);
    expect(firstAuditRow(h).outcome).toBe("success");
    expect(firstAuditRow(h).role).toBe("sentinel");
  });

  test("cursor-impl: bash loop spawn + autoStart SKIPPED (ADR-132 §D4)", async () => {
    const h = makeHarness({
      cockpit: {
        ...defaultCockpit(),
        sentinel: {
          impl: "cursor",
          enabled: true,
        },
      } as unknown as LoadedCockpit,
    });
    passGates(h, "sentinel");
    const exit = await cockpitRotate(["sentinel"], harnessOpts(h));

    expect(exit).toBe(0);
    // Cursor variant uses the bash `while true; do atmux sentinel tick;
    // sleep 270; done` loop — no claude wrapper, no autoStart.
    expect(h.newWindowCalls[0]?.shellCommand).toContain("atmux sentinel tick");
    expect(h.newWindowCalls[0]?.shellCommand).not.toContain(" claude");
    expect(h.sentinelAutoStartCalls.length).toBe(0);
    expect(h.medicAutoStartCalls.length).toBe(0);
  });

  test("non-default claudeAccount on claude-impl threads through resolver", async () => {
    const h = makeHarness({
      cockpit: {
        ...defaultCockpit(),
        sentinel: {
          impl: "claude",
          enabled: true,
          claudeAccount: { configDir: "/root/.claude-icloud" },
        },
      } as unknown as LoadedCockpit,
    });
    passGates(h, "sentinel");
    const exit = await cockpitRotate(["sentinel"], harnessOpts(h));
    expect(exit).toBe(0);
    expect(h.newWindowCalls[0]?.shellCommand).toContain(" c-ic ");
  });
});

// ---------- T4: team-driver respawn path ----------

describe("cockpitRotate — T4 team-driver respawn", () => {
  test("happy-path: killWindow + newWindow with cageRetryLoop bash + NO autoStart", async () => {
    const h = makeHarness();
    passGates(h, "team-driver");
    const exit = await cockpitRotate(["atmux"], harnessOpts(h));

    expect(exit).toBe(0);
    expect(h.killWindowCalls).toEqual(["atmux_cockpit:atmux"]);
    expect(h.newWindowCalls[0]?.name).toBe("atmux");
    // team-driver respawn uses cage-attach loop — `while true; do tmux
    // attach || tmux attach; sleep 1; done` per cockpit.ts cageRetryLoop.
    // No claude TUI invocation; no wrapper alias.
    expect(h.newWindowCalls[0]?.shellCommand).toContain("tmux");
    expect(h.newWindowCalls[0]?.shellCommand).not.toMatch(/ claude /);
    expect(h.newWindowCalls[0]?.shellCommand).not.toContain("c-u");
    // No cadence re-arm — team-driver's cageRetryLoop IS the loop.
    expect(h.medicAutoStartCalls.length).toBe(0);
    expect(h.sentinelAutoStartCalls.length).toBe(0);
    expect(firstAuditRow(h).outcome).toBe("success");
    expect(firstAuditRow(h).role).toBe("team-driver");
    expect(firstAuditRow(h).sessionName).toBe("atmux");
  });

  test("unknown team-name → respawn-failed audit + exit 70", async () => {
    const h = makeHarness();
    passGates(h, "team-driver");
    const exit = await cockpitRotate(["nonexistent-team"], harnessOpts(h));

    expect(exit).toBe(70);
    expect(h.capturedStderr.join("")).toContain("not found");
    expect(firstAuditRow(h).outcome).toBe("respawn-failed");
    expect(firstAuditRow(h).sessionName).toBe("nonexistent-team");
    // No mutation against tmux when team-name doesn't resolve.
    expect(h.killWindowCalls.length).toBe(0);
    expect(h.newWindowCalls.length).toBe(0);
  });
});

// ---------- T4: failure modes ----------

describe("cockpitRotate — T4 failure modes", () => {
  test("unknown claudeAccount.configDir → respawn-failed + exit 70 + no tmux mutation", async () => {
    const h = makeHarness({
      cockpit: {
        ...defaultCockpit(),
        medic: {
          enabled: true,
          claudeAccount: { configDir: "/root/.claude-bogus" },
        },
      } as unknown as LoadedCockpit,
    });
    passGates(h, "medic");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));

    expect(exit).toBe(70);
    expect(firstAuditRow(h).outcome).toBe("respawn-failed");
    expect(firstAuditRow(h).error).toContain("/root/.claude-bogus");
    // Wrapper resolution refuses BEFORE the pane is touched — no
    // destructive ops fire on unknown wrappers.
    expect(h.killWindowCalls.length).toBe(0);
    expect(h.newWindowCalls.length).toBe(0);
  });

  test("loadCockpit fails → respawn-failed + exit 70 + no tmux mutation", async () => {
    const h = makeHarness({ loadCockpitThrows: new Error("cockpit.json missing") });
    passGates(h, "medic");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));

    expect(exit).toBe(70);
    expect(firstAuditRow(h).outcome).toBe("respawn-failed");
    expect(firstAuditRow(h).error).toContain("loadCockpit");
    expect(h.killWindowCalls.length).toBe(0);
    expect(h.newWindowCalls.length).toBe(0);
  });

  test("killWindow throws → respawn-failed + exit 70 (post-Ctrl-C, pre-newWindow)", async () => {
    const h = makeHarness({ killWindowThrows: new Error("no such window") });
    passGates(h, "medic");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));

    expect(exit).toBe(70);
    // Ctrl-C still fired (the verifier-fired step happens before kill).
    expect(h.ctrlCCalls.length).toBe(1);
    expect(h.killWindowCalls.length).toBe(1); // attempted
    expect(h.newWindowCalls.length).toBe(0); // never reached
    expect(firstAuditRow(h).outcome).toBe("respawn-failed");
    expect(firstAuditRow(h).error).toContain("killWindow");
  });

  test("newWindow throws → respawn-failed + exit 70 (post-kill)", async () => {
    const h = makeHarness({ newWindowThrows: new Error("tmux server unreachable") });
    passGates(h, "medic");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));

    expect(exit).toBe(70);
    expect(h.killWindowCalls.length).toBe(1);
    expect(h.newWindowCalls.length).toBe(1); // attempted
    expect(h.medicAutoStartCalls.length).toBe(0); // never reached
    expect(firstAuditRow(h).outcome).toBe("respawn-failed");
    expect(firstAuditRow(h).error).toContain("newWindow");
  });

  test("Ctrl-C verifier escalates → respawn STILL proceeds (kill-window is destructive)", async () => {
    const h = makeHarness({ ctrlCSucceeds: false });
    passGates(h, "medic");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));

    // Per ADR-167 §Per-role respawn matrix: the Ctrl-C step is "grace"
    // not "required"; kill-window is what guarantees pane teardown.
    // A C-c-resistant claude is HUP'd via tmux kill-window which
    // delivers SIGHUP to the pane's process group.
    expect(exit).toBe(0);
    expect(h.killWindowCalls.length).toBe(1);
    expect(h.newWindowCalls.length).toBe(1);
    expect(firstAuditRow(h).outcome).toBe("success");
  });

  test("autoStart failure is non-fatal (operator falls back to manual /loop)", async () => {
    const h = makeHarness();
    passGates(h, "medic");
    const opts = {
      ...harnessOpts(h),
      autoStartMedicLoop: async () => {
        throw new Error("auto-start poll timeout");
      },
    };
    const exit = await cockpitRotate(["medic"], opts);

    // autoStart is best-effort — operator can `/loop /medic` manually.
    // Respawn still reports success: the pane is alive at the right
    // wrapper-alias spawn line, just without auto-fired cadence.
    expect(exit).toBe(0);
    expect(firstAuditRow(h).outcome).toBe("success");
  });

  test("success-row audit-append failure is non-fatal (exit 0 still returns)", async () => {
    const h = makeHarness();
    passGates(h, "medic");
    const opts = {
      ...harnessOpts(h),
      appendText: async () => {
        throw new Error("disk full");
      },
    };
    const exit = await cockpitRotate(["medic"], opts);

    // Same posture as refusal-row append failure: observability is
    // non-fatal. The pane was respawned; operator can grep tmux state
    // to confirm.
    expect(exit).toBe(0);
    expect(h.killWindowCalls.length).toBe(1);
    expect(h.newWindowCalls.length).toBe(1);
  });
});

// ---------- T4: audit-row schema invariants ----------

describe("cockpitRotate — T4 success audit-row shape", () => {
  test("success row carries ts/role/sessionName/outcome/durationMs/callerScope, no error", async () => {
    const h = makeHarness();
    passGates(h, "medic");
    h.nowMs = () => T0 + 1234; // simulate 1.234s respawn duration

    const opts = {
      ...harnessOpts(h),
      nowMs: () => {
        const v = h.nowMs();
        return v;
      },
    };
    await cockpitRotate(["medic"], opts);

    const row = firstAuditRow(h);
    expect(row.outcome).toBe("success");
    expect(row.role).toBe("medic");
    expect(row.sessionName).toBe("medic");
    expect(row.ts).toMatch(/^2026-/); // ISO 8601
    expect(typeof row.durationMs).toBe("number");
    expect(row.error).toBeUndefined();
  });
});
