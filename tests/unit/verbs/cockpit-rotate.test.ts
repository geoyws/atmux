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
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  type CockpitRotateAuditRow,
  classifyGate1,
  classifyGate2,
  classifyGate3,
  classifyRole,
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
}

const T0 = 1779100000000;

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
  };
}

function makeTmuxFactory(h: TestHarness): (cfg: TmuxConfig) => TmuxNamespace {
  return (_cfg: TmuxConfig) =>
    ({
      pane: {
        capturePane: async (opts: { target: string }) => {
          return h.captures.get(opts.target) ?? "";
        },
      },
    }) as unknown as TmuxNamespace;
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

  test("--force bypasses gate-1 → continues to T4 stub (exit 70)", async () => {
    const h = makeHarness();
    // Even with TYPING in superdriver, --force should bypass.
    h.captures.set("atmux_cockpit:_superdriver", "Press up to edit queued messages");
    h.stats.set("/test/home/.claude/teams/__cockpit__/medic/session-start.txt", {
      mtimeMs: T0 - 2 * 60 * 60_000,
    });
    const exit = await cockpitRotate(["medic", "--force"], harnessOpts(h));
    expect(exit).toBe(70);
    expect(h.capturedStderr.join("")).toContain("NOT IMPLEMENTED");
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

  test("passes when uptime ≥60min → T4 stub fires (exit 70)", async () => {
    const h = makeHarness();
    h.stats.set("/test/home/.claude/teams/__cockpit__/medic/session-start.txt", {
      mtimeMs: T0 - 2 * 60 * 60_000,
    });
    const exit = await cockpitRotate(["medic"], harnessOpts(h));
    expect(exit).toBe(70);
    expect(h.capturedStderr.join("")).toContain("medic respawn");
    // No refusal-row audit emission on T4 stub path.
    expect(h.appendedAudit.length).toBe(0);
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
    expect(exit).toBe(70); // T4 stub fires; no gate refused
    expect(h.appendedAudit.length).toBe(0);
    expect(h.discordCalls.length).toBe(0);
  });
});

describe("cockpitRotate — argv parse error bubbling", () => {
  test("UsageError bubbles to caller (cli.ts maps to exit 64)", async () => {
    const h = makeHarness();
    await expect(cockpitRotate([], harnessOpts(h))).rejects.toThrow(UsageError);
  });
});
