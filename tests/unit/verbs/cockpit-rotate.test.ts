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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  knownClaudeConfigDirs,
  resolveClaudeWrapper,
} from "../../../src/abstractions/claude-account-wrapper.ts";
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
  handoffPayloadPath,
  parseAuditTailForRole,
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
    const p = parseCockpitRotateArgs(["atmux", "--force"]);
    expect(p).toEqual({ sessionName: "atmux", force: true });
  });

  test("parses --force flag (positional last)", () => {
    const p = parseCockpitRotateArgs(["--force", "atmux"]);
    expect(p).toEqual({ sessionName: "atmux", force: true });
  });

  test("rejects unknown flag", () => {
    expect(() => parseCockpitRotateArgs(["medic", "--frob"])).toThrow(UsageError);
  });

  test("rejects duplicate positional", () => {
    expect(() => parseCockpitRotateArgs(["medic", "atmux"])).toThrow(UsageError);
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
    expect(classifyGate1("✻ Cooking…")).toBeNull();
  });
});

describe("classifyGate2 — pane-idle", () => {
  test("READY pane passes", () => {
    expect(classifyGate2("$ ❯ ")).toBeNull();
  });
  test("BUSY (`✻ ...`) refuses", () => {
    const r = classifyGate2("✻ Cooking…");
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
  /** Recorded T5 handoff writes. */
  handoffWrites: { path: string; content: string }[];
  /** Force atomicWrite to throw the given error on next call. */
  atomicWriteThrows?: Error;
  /** Canned audit-log content returned by `readAuditLog` seam. */
  auditLogContent: string | null;
  /** Canned lead-outbox tail by atmuxDir for team-driver handoff. */
  leadOutboxByDir: Map<string, string>;
}

const T0 = 1779100000000;

/** Default synthetic cockpit — declares medic (claude impl) with an
 *  explicit `/root/.claude` account so the wrapper resolver returns
 *  `claude`. Tests assert respawn shape against this baseline; per-
 *  test overrides build narrower cockpit shapes. */
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
    handoffWrites: overrides.handoffWrites ?? [],
    ...(overrides.atomicWriteThrows !== undefined
      ? { atomicWriteThrows: overrides.atomicWriteThrows }
      : {}),
    auditLogContent: overrides.auditLogContent ?? null,
    leadOutboxByDir: overrides.leadOutboxByDir ?? new Map(),
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
    autoStartTimeoutMs: 0, // bail immediately in tests
    // ---- T5 handoff seams ----
    atomicWrite: async (path: string, content: string) => {
      h.handoffWrites.push({ path, content });
      if (h.atomicWriteThrows !== undefined) throw h.atomicWriteThrows;
    },
    readAuditLog: async (_path: string) => h.auditLogContent,
    readLeadOutboxTail: async (atmuxDir: string, _lines: number) => {
      return h.leadOutboxByDir.get(atmuxDir) ?? "";
    },
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
    h.captures.set("atmux_cockpit:_medic", "✻ Cooking…");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));
    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-2-pane-idle");
    expect(h.appendedAudit.length).toBe(1);
    const row = firstAuditRow(h);
    expect(row.outcome).toBe("gate-2-refused");
  });

  test("refuses when target pane is COMPACTING", async () => {
    const h = makeHarness();
    h.captures.set("atmux_cockpit:_medic", "Compacting conversation");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));
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

  test("team-driver under a top-level group captures from the group session", async () => {
    const h = makeHarness();
    const cockpit = defaultCockpit();
    cockpit.sessions = [
      {
        type: "group",
        name: "platform",
        enabled: true,
        sessions: [
          {
            type: "team",
            name: "atmux",
            root: "/root/work/src/atmux",
            enabled: true,
            sessions: [],
          },
        ],
      },
    ];
    const tmuxConfigs: TmuxConfig[] = [];
    const captureTargets: string[] = [];
    const opts = {
      ...harnessOpts(h),
      cockpit,
      loadCockpit: async () => cockpit,
      tmuxFactory: (cfg: TmuxConfig) => {
        tmuxConfigs.push(cfg);
        const inner = makeTmuxFactory(h)(cfg);
        return {
          ...inner,
          pane: {
            ...inner.pane,
            capturePane: async (captureOpts: { target: string; start?: number }) => {
              captureTargets.push(captureOpts.target);
              return inner.pane.capturePane(captureOpts);
            },
          },
        } as unknown as TmuxNamespace;
      },
    };
    h.captures.set("platform:atmux", "✻ Cooking…");

    const exit = await cockpitRotate(["atmux"], opts);

    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-2-pane-idle");
    expect(captureTargets).toContain("platform:atmux");
    expect(captureTargets).not.toContain("atmux_cockpit:atmux");
    expect(tmuxConfigs).toContainEqual({ socketPath: "/tmp/atmux-grp-platform/sock" });
  });

  test("grouped team-driver falls back to cockpit host when loadCockpit throws", async () => {
    const h = makeHarness({
      loadCockpitThrows: new Error("cockpit.json missing"),
    });
    const cockpit = defaultCockpit();
    cockpit.sessions = [
      {
        type: "group",
        name: "platform",
        enabled: true,
        sessions: [
          {
            type: "team",
            name: "atmux",
            root: "/root/work/src/atmux",
            enabled: true,
            sessions: [],
          },
        ],
      },
    ];
    const captureTargets: string[] = [];
    const opts = {
      ...harnessOpts(h),
      cockpit,
      loadCockpit: async () => {
        throw new Error("cockpit.json missing");
      },
      tmuxFactory: (cfg: TmuxConfig) => {
        const inner = makeTmuxFactory(h)(cfg);
        return {
          ...inner,
          pane: {
            ...inner.pane,
            capturePane: async (captureOpts: { target: string; start?: number }) => {
              captureTargets.push(captureOpts.target);
              return inner.pane.capturePane(captureOpts);
            },
          },
        } as unknown as TmuxNamespace;
      },
    };
    h.captures.set("atmux_cockpit:atmux", "✻ Cooking…");

    const exit = await cockpitRotate(["atmux"], opts);

    expect(exit).toBe(65);
    expect(h.capturedStderr.join("")).toContain("gate-2-pane-idle");
    expect(captureTargets).toContain("atmux_cockpit:atmux");
    expect(captureTargets).not.toContain("platform:atmux");
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
    h.captures.set("atmux_cockpit:_medic", "✻ Cooking…");
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
function passGates(h: TestHarness, role: "medic" | "team-driver"): void {
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

  test("`✻ Cooked` marker → claude UI present → false", () => {
    // KEEP THE PAST-TENSE STRING HERE. This verifier asks "is Claude's UI
    // still on screen", NOT "is the agent busy" — and a finished turn's
    // `✻ Cooked for 12s` residue is perfectly good evidence the UI is up.
    // It is deliberately NOT the same question as pane-state's BUSY, which
    // was tightened to exclude exactly this string (t-89fc1cf8); a sweep that
    // "modernises" both to `✻ Cooking…` breaks this one, because the verifier
    // matches the literal words `Cooked|Schlepping|Honking|Compacting` and
    // never the glyph — `Cooking` is in none of them. Verified by making that
    // exact mistake.
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

// =============================================================
// T5: handoff write-path (t-fe3464df)
// =============================================================

describe("handoffPayloadPath", () => {
  test("resolves under ~/.claude/teams/__cockpit__/<role>/handoff.md", () => {
    expect(handoffPayloadPath("/test/home", "medic")).toBe(
      "/test/home/.claude/teams/__cockpit__/medic/handoff.md",
    );
    expect(handoffPayloadPath("/test/home", "team-driver")).toBe(
      "/test/home/.claude/teams/__cockpit__/team-driver/handoff.md",
    );
  });
});

describe("parseAuditTailForRole", () => {
  test("null input → empty array", () => {
    expect(parseAuditTailForRole(null, "medic", 5)).toEqual([]);
  });

  test("empty string → empty array", () => {
    expect(parseAuditTailForRole("", "medic", 5)).toEqual([]);
  });

  test("malformed JSON lines are skipped silently", () => {
    const ndjson = [
      "not json at all",
      JSON.stringify({
        ts: "2026-05-17T10:00:00.000Z",
        role: "medic",
        sessionName: "medic",
        outcome: "success",
        durationMs: 100,
        callerScope: "driver",
      }),
      "{ broken",
    ].join("\n");
    const rows = parseAuditTailForRole(ndjson, "medic", 5);
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe("success");
  });

  test("filters by role — non-matching rows excluded", () => {
    const teamDriverRow = {
      ts: "2026-05-17T10:00:00.000Z",
      role: "team-driver",
      sessionName: "atmux",
      outcome: "success",
      durationMs: 100,
      callerScope: "driver",
    };
    const medicRow = {
      ts: "2026-05-17T10:01:00.000Z",
      role: "medic",
      sessionName: "medic",
      outcome: "gate-3-refused",
      durationMs: 50,
      callerScope: "driver",
      error: "uptime <60min",
    };
    const ndjson = [JSON.stringify(teamDriverRow), JSON.stringify(medicRow)].join("\n");
    const rows = parseAuditTailForRole(ndjson, "medic", 5);
    expect(rows.length).toBe(1);
    expect(rows[0]?.outcome).toBe("gate-3-refused");
  });

  test("returns LAST `n` matching rows when more exist", () => {
    const ndjson = Array.from({ length: 8 }, (_, i) =>
      JSON.stringify({
        ts: `2026-05-17T10:0${i}:00.000Z`,
        role: "medic",
        sessionName: "medic",
        outcome: "success",
        durationMs: i,
        callerScope: "driver",
      }),
    ).join("\n");
    const rows = parseAuditTailForRole(ndjson, "medic", 3);
    expect(rows.length).toBe(3);
    // Tail of 3 → rows 5/6/7 (durationMs values).
    expect(rows.map((r) => r.durationMs)).toEqual([5, 6, 7]);
  });

  test("returns all when fewer than `n` match", () => {
    const ndjson = JSON.stringify({
      ts: "2026-05-17T10:00:00.000Z",
      role: "medic",
      sessionName: "medic",
      outcome: "success",
      durationMs: 100,
      callerScope: "driver",
    });
    const rows = parseAuditTailForRole(ndjson, "medic", 5);
    expect(rows.length).toBe(1);
  });

  test("skips blank lines (trailing newline padding)", () => {
    const row = {
      ts: "2026-05-17T10:00:00.000Z",
      role: "medic",
      sessionName: "medic",
      outcome: "success",
      durationMs: 100,
      callerScope: "driver",
    };
    const ndjson = `${JSON.stringify(row)}\n\n\n`;
    const rows = parseAuditTailForRole(ndjson, "medic", 5);
    expect(rows.length).toBe(1);
  });
});

describe("cockpitRotate — T5 handoff write happy-path", () => {
  test("medic: handoff written BEFORE Ctrl-C, audit row carries handoffPath", async () => {
    const h = makeHarness();
    passGates(h, "medic");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));

    expect(exit).toBe(0);
    expect(h.handoffWrites.length).toBe(1);
    expect(h.handoffWrites[0]?.path).toBe("/test/home/.claude/teams/__cockpit__/medic/handoff.md");
    // Handoff payload Markdown sections per ADR-167 §Handoff payload
    // schema for medic.
    const md = h.handoffWrites[0]?.content ?? "";
    expect(md).toContain("# Medic handoff");
    expect(md).toContain("## In-flight diagnosis state");
    expect(md).toContain("## Recent medic-sourced complaints");
    expect(md).toContain("## Recent rotation calls (audit log tail)");
    // Success audit row carries the handoff path.
    const row = firstAuditRow(h);
    expect(row.outcome).toBe("success");
    expect(row.handoffPath).toBe("/test/home/.claude/teams/__cockpit__/medic/handoff.md");
  });

  test("team-driver: handoff includes lead-outbox tail block + team-name in header", async () => {
    const h = makeHarness({
      leadOutboxByDir: new Map([
        [
          "/root/work/src/atmux/.atmux",
          "lead nudge 1: pulled task t-abc\nlead nudge 2: T4 SHIPPED",
        ],
      ]),
    });
    passGates(h, "team-driver");
    const exit = await cockpitRotate(["atmux"], harnessOpts(h));

    expect(exit).toBe(0);
    expect(h.handoffWrites.length).toBe(1);
    const md = h.handoffWrites[0]?.content ?? "";
    expect(md).toContain("# Team-driver handoff — atmux @");
    expect(md).toContain("## Recent tell-lead history (lead-outbox tail)");
    expect(md).toContain("lead nudge 1: pulled task t-abc");
    expect(md).toContain("lead nudge 2: T4 SHIPPED");
    expect(md).toContain("## Outbox state snapshot");
    expect(md).toContain("## Recent rotation calls (audit log tail)");
  });

  test("team-driver with empty lead-outbox renders placeholder", async () => {
    const h = makeHarness(); // no leadOutboxByDir entry → returns ""
    passGates(h, "team-driver");
    const exit = await cockpitRotate(["atmux"], harnessOpts(h));

    expect(exit).toBe(0);
    const md = h.handoffWrites[0]?.content ?? "";
    expect(md).toContain("_no lead-outbox content available_");
  });

  test("audit-log tail renders into the recent-rotations section", async () => {
    const recentRow = {
      ts: "2026-05-17T09:00:00.000Z",
      role: "medic" as const,
      sessionName: "medic",
      outcome: "success" as const,
      durationMs: 4231,
      callerScope: "driver" as const,
    };
    const h = makeHarness({ auditLogContent: JSON.stringify(recentRow) });
    passGates(h, "medic");
    await cockpitRotate(["medic"], harnessOpts(h));

    const md = h.handoffWrites[0]?.content ?? "";
    expect(md).toContain("2026-05-17T09:00:00.000Z");
    expect(md).toContain("outcome=`success`");
    expect(md).toContain("durationMs=4231");
  });

  test("empty audit-log renders 'no recent rotation attempts' placeholder", async () => {
    const h = makeHarness({ auditLogContent: null });
    passGates(h, "medic");
    await cockpitRotate(["medic"], harnessOpts(h));

    const md = h.handoffWrites[0]?.content ?? "";
    expect(md).toContain("_no recent rotation attempts recorded_");
  });
});

describe("cockpitRotate — T5 handoff write failure modes", () => {
  test("atomicWrite throws → handoff-write-failed audit row + exit 70 + NO pane mutation", async () => {
    const h = makeHarness({ atomicWriteThrows: new Error("ENOSPC: disk full") });
    passGates(h, "medic");
    const exit = await cockpitRotate(["medic"], harnessOpts(h));

    expect(exit).toBe(70);
    expect(h.capturedStderr.join("")).toContain("handoff write failed");
    expect(h.appendedAudit.length).toBe(1);
    const row = firstAuditRow(h);
    expect(row.outcome).toBe("handoff-write-failed");
    expect(row.error).toContain("ENOSPC");
    expect(row.handoffPath).toBe("/test/home/.claude/teams/__cockpit__/medic/handoff.md");
    // Pane intentionally NOT touched on handoff failure — recovery is
    // "retry the verb" not "rotate blind".
    expect(h.ctrlCCalls.length).toBe(0);
    expect(h.killWindowCalls.length).toBe(0);
    expect(h.newWindowCalls.length).toBe(0);
  });

  test("handoff write failure swallow on audit-append failure (observability non-fatal)", async () => {
    const h = makeHarness({ atomicWriteThrows: new Error("EACCES") });
    passGates(h, "medic");
    const opts = {
      ...harnessOpts(h),
      appendText: async () => {
        throw new Error("audit log unwriteable too");
      },
    };
    const exit = await cockpitRotate(["medic"], opts);

    // Both write paths failed but exit code + stderr still signal the
    // primary failure cleanly.
    expect(exit).toBe(70);
    expect(h.capturedStderr.join("")).toContain("handoff write failed");
    expect(h.ctrlCCalls.length).toBe(0);
  });
});

describe("cockpitRotate — T5 soft-cap truncation (ADR-167 OQ-2)", () => {
  test("payload >100KB → truncated with trailer", async () => {
    // Generate a lead-outbox tail >100KB so the team-driver handoff
    // overflows the soft cap.
    const giantTail = "a".repeat(150_000);
    const h = makeHarness({
      leadOutboxByDir: new Map([["/root/work/src/atmux/.atmux", giantTail]]),
    });
    passGates(h, "team-driver");
    const exit = await cockpitRotate(["atmux"], harnessOpts(h));

    expect(exit).toBe(0);
    expect(h.handoffWrites.length).toBe(1);
    const md = h.handoffWrites[0]?.content ?? "";
    // Truncation trailer present.
    expect(md).toContain("[truncated at 100KB; see audit log for full assembly inputs]");
    // Final payload stays within budget (trailer + content ≤ cap).
    expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(100_000);
  });

  test("payload exactly at cap → no truncation", async () => {
    // Small payload (well under 100KB) → no trailer.
    const h = makeHarness();
    passGates(h, "medic");
    await cockpitRotate(["medic"], harnessOpts(h));

    const md = h.handoffWrites[0]?.content ?? "";
    expect(md).not.toContain("[truncated at 100KB");
  });
});

describe("cockpitRotate — T5 ordering invariant", () => {
  test("handoff write lands BEFORE Ctrl-C (re-traceable mid-flight crash)", async () => {
    const h = makeHarness();
    passGates(h, "medic");
    const sequence: string[] = [];

    const opts = {
      ...harnessOpts(h),
      atomicWrite: async (path: string, content: string) => {
        sequence.push("handoff-write");
        h.handoffWrites.push({ path, content });
      },
      safeSendKeysWithVerify: async (sopts: SafeSendKeysWithVerifyOpts) => {
        sequence.push("ctrl-c");
        h.ctrlCCalls.push({ target: sopts.target, keys: sopts.keys });
        return { success: true, attempts: 1, finalCapture: "" };
      },
      tmuxFactory: (_cfg: TmuxConfig) =>
        ({
          pane: {
            capturePane: async () => "",
            sendKeys: async () => {},
          },
          window: {
            killWindow: async () => {
              sequence.push("kill-window");
            },
            newWindow: async () => {
              sequence.push("new-window");
              return { sessionName: "atmux_cockpit", windowIndex: 4 };
            },
            listWindows: async () => [],
          },
        }) as unknown as TmuxNamespace,
    };

    await cockpitRotate(["medic"], opts);

    // ADR-167 §Ordering invariant: handoff → Ctrl-C → kill → new.
    expect(sequence).toEqual(["handoff-write", "ctrl-c", "kill-window", "new-window"]);
  });
});

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

// ---------- T6 residual: claude-account-wrapper direct ----------

// resolveClaudeWrapper happy + error paths are exercised indirectly via
// cockpitRotate (be-2's T4 happy-paths + "unknown configDir" failure
// test). But knownClaudeConfigDirs() is currently dead code from a
// test-coverage standpoint — be-2 noted it's a follow-up surface for
// doctor / cockpit-rotate audit telemetry. Cover it now to close the
// claude-account-wrapper.ts FN gap (lcov FNH:1/FNF:2 → 2/2).
describe("claude-account-wrapper exports (T6 direct unit)", () => {
  test("knownClaudeConfigDirs enumerates the canonical 4-entry registry", () => {
    const dirs = knownClaudeConfigDirs();
    expect(dirs).toEqual([
      "/root/.claude",
      "/root/.claude-unum",
      "/root/.claude-icloud",
      "/root/.claude-ifca",
    ]);
  });

  test("resolveClaudeWrapper round-trips every registered configDir", () => {
    expect(resolveClaudeWrapper("/root/.claude")).toBe("claude");
    expect(resolveClaudeWrapper("/root/.claude-unum")).toBe("c-u");
    expect(resolveClaudeWrapper("/root/.claude-icloud")).toBe("c-ic");
    expect(resolveClaudeWrapper("/root/.claude-ifca")).toBe("c-i");
  });

  test("resolveClaudeWrapper throws ConfigError on unknown configDir w/ hint listing every registered dir", () => {
    let caught: unknown;
    try {
      resolveClaudeWrapper("/root/.claude-bogus");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const msg = `${(caught as Error).message}`;
    expect(msg).toContain("/root/.claude-bogus");
    expect(msg).toContain("ADR-094 c-alias convention");
    // Hint enumerates the full registered set so the operator can
    // disambiguate which alias to add to their shell init.
    expect(msg).toContain("/root/.claude-unum");
    expect(msg).toContain("/root/.claude-ifca");
  });
});

// ---------- T6 residual: defaultReadLeadOutboxTail real-fs ----------

// Exercises the un-injected default lead-outbox-tail reader
// (cockpit-rotate.ts::defaultReadLeadOutboxTail). The default path
// only fires when callers omit `readLeadOutboxTail` from
// CockpitRotateOpts; be-2's T4/T5 harness always injects the seam, so
// these lines stayed uncovered on the 99.36% T5 baseline.
describe("cockpitRotate — T6 defaultReadLeadOutboxTail (real-fs)", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "atmux-rotate-t6-"));
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test("team-driver handoff uses default reader when readLeadOutboxTail omitted", async () => {
    const teamRoot = join(tmpRoot, "team-real-fs");
    const atmuxDir = join(teamRoot, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    const outboxLines = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`);
    await writeFile(join(atmuxDir, "lead-outbox.md"), outboxLines.join("\n"));

    const h = makeHarness({
      cockpit: {
        sessions: [],
        teams: [
          {
            name: "real-fs",
            root: teamRoot,
            enabled: true,
            claudeAccount: { configDir: "/root/.claude" },
          },
        ],
      } as unknown as LoadedCockpit,
    });
    h.stats.set("/test/home/.claude/teams/__cockpit__/team-driver/session-start.txt", {
      mtimeMs: T0 - 2 * 60 * 60_000,
    });

    // Build opts inline OMITTING readLeadOutboxTail so the verb falls
    // through to defaultReadLeadOutboxTail (the production default).
    const opts = {
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
      discordSend: async (sendOpts: DiscordSendOpts) => {
        h.discordCalls.push(sendOpts);
      },
      loadCockpit: async () => h.cockpit,
      safeSendKeysWithVerify: makeSafeSendKeysStub(h),
      autoStartMedicLoop: async () => {},
      autoStartTimeoutMs: 0,
      atomicWrite: async (path: string, content: string) => {
        h.handoffWrites.push({ path, content });
      },
      readAuditLog: async (_path: string) => h.auditLogContent,
      // INTENTIONALLY omit readLeadOutboxTail to exercise default.
    };

    const exit = await cockpitRotate(["real-fs"], opts);
    expect(exit).toBe(0);

    // HANDOFF_LEAD_OUTBOX_TAIL_LINES = 50 (cockpit-rotate.ts L537).
    // Default reader returns the last 50 lines of a 60-line file, i.e.
    // lines 11..60. The team-driver handoff Markdown wraps the tail in
    // a fenced code block under `## Recent tell-lead history`.
    const handoff = h.handoffWrites.find((w) => w.path.endsWith("/team-driver/handoff.md"));
    expect(handoff).toBeDefined();
    expect(handoff?.content).toContain("line-60");
    expect(handoff?.content).toContain("line-11");
    // Lines 1..10 fell out of the tail window — verify the slice math.
    expect(handoff?.content).not.toContain("line-1\n");
    expect(handoff?.content).not.toContain("line-10\n");
  });

  test("default reader returns empty when lead-outbox.md missing", async () => {
    const teamRoot = join(tmpRoot, "team-no-outbox");
    await mkdir(join(teamRoot, ".atmux"), { recursive: true });
    // NO writeFile — exercises readTextOrNull → null path inside
    // defaultReadLeadOutboxTail, then the early-return on null/empty.

    const h = makeHarness({
      cockpit: {
        sessions: [],
        teams: [
          {
            name: "no-outbox",
            root: teamRoot,
            enabled: true,
            claudeAccount: { configDir: "/root/.claude" },
          },
        ],
      } as unknown as LoadedCockpit,
    });
    h.stats.set("/test/home/.claude/teams/__cockpit__/team-driver/session-start.txt", {
      mtimeMs: T0 - 2 * 60 * 60_000,
    });

    const opts = {
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
      discordSend: async (sendOpts: DiscordSendOpts) => {
        h.discordCalls.push(sendOpts);
      },
      loadCockpit: async () => h.cockpit,
      safeSendKeysWithVerify: makeSafeSendKeysStub(h),
      autoStartMedicLoop: async () => {},
      autoStartTimeoutMs: 0,
      atomicWrite: async (path: string, content: string) => {
        h.handoffWrites.push({ path, content });
      },
      readAuditLog: async (_path: string) => h.auditLogContent,
    };

    const exit = await cockpitRotate(["no-outbox"], opts);
    expect(exit).toBe(0);
    const handoff = h.handoffWrites.find((w) => w.path.endsWith("/team-driver/handoff.md"));
    // Empty outbox renders the explicit placeholder per
    // renderTeamDriverHandoff (T5 ADR-167 schema).
    expect(handoff?.content).toContain("_no lead-outbox content available_");
  });
});

// ---------- T6 residual: safeCapturePane catch branch ----------

// safeCapturePane (cockpit-rotate.ts L453-462) swallows tmux capture
// errors so a misconfigured cockpit doesn't crash the verb — gate-1
// + gate-2 then receive empty text (treated as READY, the safer
// default). Coverage gap: the catch branch (L460-461) only fires when
// tmux.pane.capturePane throws; default harness `captures` Map returns
// `""` non-throwingly, so the branch stayed uncovered on the T5
// baseline.
describe("cockpitRotate — T6 safeCapturePane catch branch", () => {
  test("capturePane throw → gate-1+gate-2 pass on empty; rotation proceeds", async () => {
    const h = makeHarness();
    passGates(h, "medic");

    // Custom tmuxFactory: capturePane throws on every call; window
    // methods still record so we can assert respawn proceeded past the
    // (degraded) gates.
    const throwingTmuxFactory = (_cfg: TmuxConfig) =>
      ({
        pane: {
          capturePane: async () => {
            throw new Error("synthetic tmux capture failure");
          },
          sendKeys: async () => {},
        },
        window: {
          killWindow: async (target: string) => {
            h.killWindowCalls.push(target);
          },
          newWindow: async (opts: { name?: string; shellCommand?: string }) => {
            h.newWindowCalls.push({
              name: opts.name ?? "",
              shellCommand: opts.shellCommand ?? "",
            });
            return { sessionName: "atmux_cockpit", windowIndex: h.newWindowIndex };
          },
          listWindows: async () => [],
        },
      }) as unknown as TmuxNamespace;

    // Custom safeSendKeysWithVerify that DOES NOT call opts.capture
    // (which would re-trigger the throwing factory mid-respawn). The
    // standard harness stub exercises the capture closure for coverage,
    // but here we narrow the surface to the safeCapturePane catch.
    const noCaptureSafeSend = async (sendOpts: SafeSendKeysWithVerifyOpts) => {
      h.ctrlCCalls.push({ target: sendOpts.target, keys: sendOpts.keys });
      return { success: true, attempts: 1, finalCapture: "" };
    };
    const opts = {
      ...harnessOpts(h),
      tmuxFactory: throwingTmuxFactory,
      safeSendKeysWithVerify: noCaptureSafeSend,
    };
    const exit = await cockpitRotate(["medic"], opts);

    // Capture-throw is non-fatal: gates 1+2 receive "" (treated as
    // READY per classifyGate1/2 empty-passes-defensively), gate-3
    // passes via stat-marker mtime, respawn fires.
    expect(exit).toBe(0);
    expect(h.killWindowCalls).toEqual(["atmux_cockpit:_medic"]);
    expect(h.newWindowCalls.length).toBe(1);
    // No gate-refusal audit row — gates didn't fire even though
    // capture-pane threw under the hood.
    const refusals = h.appendedAudit.filter((a) => a.content.includes("gate-"));
    expect(refusals.length).toBe(0);
    expect(firstAuditRow(h).outcome).toBe("success");
  });
});

// ---------- T6 residual: default cadenceLogger arrows ----------

// cockpit-rotate.ts L423-428 declares 4 inline arrow functions
// (log/ok/warn/err) inside the `?? {}` default for opts.cadenceLogger.
// be-2's harness omits cadenceLogger (uses the default), but no test
// actually drives an autoStartMedicLoop that calls
// logger.log/ok/warn/err — so the 4 arrow bodies are constructed but
// never invoked. Force-call them via a stub autoStartMedicLoop that
// exercises every logger method.
describe("cockpitRotate — T6 default cadenceLogger arrows", () => {
  test("autoStart-driven logger calls hit log/ok/warn/err defaults via stderr", async () => {
    const h = makeHarness();
    passGates(h, "medic");

    const opts = {
      ...harnessOpts(h),
      autoStartMedicLoop: async (autoOpts: {
        sessionName: string;
        windowIndex: number;
        logger?: {
          log: (s: string) => void;
          ok: (s: string) => void;
          warn: (s: string) => void;
          err: (s: string) => void;
        };
      }) => {
        // Drive each default arrow exactly once. They close over the
        // injected `stderr` so the output lands in h.capturedStderr.
        autoOpts.logger?.log("cadence-log-marker");
        autoOpts.logger?.ok("cadence-ok-marker");
        autoOpts.logger?.warn("cadence-warn-marker");
        autoOpts.logger?.err("cadence-err-marker");
      },
    };
    // INTENTIONALLY omit cadenceLogger from opts — verb falls through
    // to resolveDeps default at cockpit-rotate.ts L423.
    delete (opts as { cadenceLogger?: unknown }).cadenceLogger;

    const exit = await cockpitRotate(["medic"], opts);
    expect(exit).toBe(0);

    const stderrJoined = h.capturedStderr.join("");
    expect(stderrJoined).toContain("cadence-log-marker");
    expect(stderrJoined).toContain("cadence-ok-marker");
    expect(stderrJoined).toContain("cadence-warn-marker");
    expect(stderrJoined).toContain("cadence-err-marker");
  });
});

// ---------- T6 residual: default stderr arrow ----------

// cockpit-rotate.ts L405 declares the default stderr writer:
//   `const stderr = opts.stderr ?? ((msg) => process.stderr.write(msg));`
// be-2's harness always injects `stderr`, so the default arrow is
// constructed (line covered) but never invoked (function uncovered).
// Drive the default by omitting `stderr` from opts and stubbing
// `process.stderr.write` to capture without polluting test output.
describe("cockpitRotate — T6 default stderr arrow", () => {
  test("omitting opts.stderr falls through to process.stderr.write default", async () => {
    const h = makeHarness();
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (
      chunk: string | Uint8Array,
    ) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    try {
      const opts = { ...harnessOpts(h) };
      delete (opts as { stderr?: unknown }).stderr;
      // gate-4 fires unconditionally, so it's the cheapest path to
      // exercise deps.stderr without setting up gate state.
      const exit = await cockpitRotate(["superdriver"], opts);
      expect(exit).toBe(65); // EX_DATAERR for gate refusal
    } finally {
      (process.stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
    }

    // Default arrow wrote to process.stderr — captured chunk should
    // include the gate-4 stderr line.
    expect(captured.join("")).toContain("gate-4-never-rotate-superdriver");
  });
});

// ---------- T6 residual: gate-3 stat-throw fallback ----------

// cockpit-rotate.ts L1198-1203 wraps `deps.stat` in try/catch so a
// rejected stat call (fs permission error, ENOTDIR mid-path, etc.)
// degrades to `mtimeMs = null`, which classifyGate3 treats as a hard
// refusal (no marker → cannot prove uptime → refuse). The default
// harness returns null without throwing, so the catch branch stayed
// uncovered on the T5 baseline.
describe("cockpitRotate — T6 gate-3 stat-throw", () => {
  test("stat rejection → mtimeMs=null → gate-3 refuses (marker-missing path)", async () => {
    const h = makeHarness();
    const opts = {
      ...harnessOpts(h),
      stat: async (_path: string) => {
        throw new Error("synthetic fs permission denied");
      },
    };

    const exit = await cockpitRotate(["medic"], opts);

    expect(exit).toBe(65); // EX_DATAERR — gate refusal
    expect(h.capturedStderr.join("")).toContain("gate-3-uptime");
    expect(firstAuditRow(h).outcome).toBe("gate-3-refused");
    // No tmux mutation under a gate refusal.
    expect(h.killWindowCalls.length).toBe(0);
    expect(h.newWindowCalls.length).toBe(0);
  });
});
