// Unit tests for src/verbs/cockpit-rotate.ts — ADR-167 T2 skeleton.
//
// T2 scope (this file): verb dispatch, argv parse, caller-scope gate
// refusal, gate-4 (never-rotate-superdriver) refusal, role classification.
// T6 (t-18bddf4e) expands coverage to gates 1-3 + each respawn path +
// handoff payload (100% on the production paths landed in T3-T5).

import { describe, expect, test } from "bun:test";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  classifyRole,
  cockpitRotate,
  parseCockpitRotateArgs,
} from "../../../src/verbs/cockpit-rotate.ts";

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

describe("cockpitRotate dispatch", () => {
  test("gate-4 (superdriver) refusal returns 65 even under --force", async () => {
    const errs: string[] = [];
    const exit = await cockpitRotate(["superdriver", "--force"], {
      env: { ATMUX_CALLER_SCOPE: "driver" },
      stderr: (m) => errs.push(m),
    });
    expect(exit).toBe(65);
    expect(errs.join("")).toContain("gate-4-never-rotate-superdriver");
  });

  test("gate-4 fires before caller-scope (cheapest gate first)", async () => {
    // Even without driver scope, gate-4 short-circuits to 65 — not the
    // ConfigError 78 that caller-scope would throw.
    const errs: string[] = [];
    const exit = await cockpitRotate(["superdriver"], {
      env: {},
      stderr: (m) => errs.push(m),
    });
    expect(exit).toBe(65);
    expect(errs.join("")).toContain("gate-4-never-rotate-superdriver");
  });

  test("caller-scope gate throws ConfigError when env not 'driver'", async () => {
    await expect(
      cockpitRotate(["medic"], {
        env: {},
        stderr: () => {},
      }),
    ).rejects.toThrow(ConfigError);
  });

  test("caller-scope gate bypassed via injected callerScope", async () => {
    // With driver scope + non-superdriver target, the verb reaches the
    // T4-stub path and returns 70 (EX_SOFTWARE) with a "NOT IMPLEMENTED"
    // stderr line. This is the expected T2 shape; T4 replaces this with
    // the real respawn matrix.
    const errs: string[] = [];
    const exit = await cockpitRotate(["medic"], {
      callerScope: () => "driver",
      stderr: (m) => errs.push(m),
    });
    expect(exit).toBe(70);
    expect(errs.join("")).toContain("NOT IMPLEMENTED");
    expect(errs.join("")).toContain("medic");
  });

  test("sentinel target hits sentinel stub", async () => {
    const errs: string[] = [];
    const exit = await cockpitRotate(["sentinel"], {
      callerScope: () => "driver",
      stderr: (m) => errs.push(m),
    });
    expect(exit).toBe(70);
    expect(errs.join("")).toContain("sentinel respawn");
  });

  test("team-name target hits team-driver stub", async () => {
    const errs: string[] = [];
    const exit = await cockpitRotate(["atmux"], {
      callerScope: () => "driver",
      stderr: (m) => errs.push(m),
    });
    expect(exit).toBe(70);
    expect(errs.join("")).toContain("team-driver respawn");
    expect(errs.join("")).toContain("atmux");
  });

  test("argv parse failure bubbles UsageError → cli.ts maps to exit 64", async () => {
    await expect(
      cockpitRotate([], {
        callerScope: () => "driver",
        stderr: () => {},
      }),
    ).rejects.toThrow(UsageError);
  });
});
