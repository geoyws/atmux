// t-af727acd / ADR-302: pin the host→bun-target mapping, the
// ATMUX_BUN_TARGET override, and the --target argv splitter.
//
// Every row asserts the real resolved value, so a regression back to a
// hardcoded linux-x64 (or a wrong mapping) fails loudly.

import { describe, expect, test } from "bun:test";
import {
  BUN_COMPILE_TARGET_ENV,
  isBunCompileTarget,
  resolveBunCompileTarget,
  splitTargetArg,
} from "../../../src/core/build-target.ts";

describe("resolveBunCompileTarget — host mapping", () => {
  const rows = [
    { platform: "darwin", arch: "arm64", want: "bun-darwin-arm64" },
    { platform: "darwin", arch: "x64", want: "bun-darwin-x64" },
    { platform: "linux", arch: "x64", want: "bun-linux-x64" },
    { platform: "linux", arch: "arm64", want: "bun-linux-arm64" },
    { platform: "win32", arch: "x64", want: "bun-windows-x64" },
  ] as const;
  for (const { platform, arch, want } of rows) {
    test(`${platform}-${arch} → ${want}`, () => {
      expect(resolveBunCompileTarget(platform, arch, {})).toBe(want);
    });
  }

  test("unsupported host throws with an actionable message", () => {
    expect(() => resolveBunCompileTarget("freebsd", "x64", {})).toThrow(
      /no known bun compile target.*freebsd-x64/,
    );
    expect(() => resolveBunCompileTarget("darwin", "ia32" as never, {})).toThrow(
      /ATMUX_BUN_TARGET/,
    );
  });
});

describe("resolveBunCompileTarget — ATMUX_BUN_TARGET override", () => {
  test("override wins over the host mapping", () => {
    expect(
      resolveBunCompileTarget("darwin", "arm64", { [BUN_COMPILE_TARGET_ENV]: "bun-linux-x64" }),
    ).toBe("bun-linux-x64");
  });

  test("override is trimmed", () => {
    expect(
      resolveBunCompileTarget("darwin", "arm64", {
        [BUN_COMPILE_TARGET_ENV]: "  bun-linux-arm64\n",
      }),
    ).toBe("bun-linux-arm64");
  });

  test("blank / whitespace-only override falls through to the host", () => {
    expect(resolveBunCompileTarget("darwin", "arm64", { [BUN_COMPILE_TARGET_ENV]: "" })).toBe(
      "bun-darwin-arm64",
    );
    expect(resolveBunCompileTarget("linux", "x64", { [BUN_COMPILE_TARGET_ENV]: "   " })).toBe(
      "bun-linux-x64",
    );
  });

  test("unknown override value throws naming the known targets", () => {
    expect(() =>
      resolveBunCompileTarget("linux", "x64", { [BUN_COMPILE_TARGET_ENV]: "bun-linux-x99" }),
    ).toThrow(/ATMUX_BUN_TARGET=bun-linux-x99 is not a known bun compile target/);
  });
});

describe("isBunCompileTarget", () => {
  test("accepts known targets, rejects the rest", () => {
    expect(isBunCompileTarget("bun-darwin-arm64")).toBe(true);
    expect(isBunCompileTarget("bun-linux-x64")).toBe(true);
    expect(isBunCompileTarget("bun-linux-x99")).toBe(false);
    expect(isBunCompileTarget("")).toBe(false);
  });
});

describe("splitTargetArg", () => {
  test("--target=<t> form", () => {
    expect(splitTargetArg(["--target=bun-linux-x64"])).toEqual({
      target: "bun-linux-x64",
      rest: [],
    });
  });

  test("--target <t> form with passthrough args preserved in order", () => {
    expect(splitTargetArg(["--define", "FOO=1", "--target", "bun-darwin-arm64"])).toEqual({
      target: "bun-darwin-arm64",
      rest: ["--define", "FOO=1"],
    });
  });

  test("no --target → null target, argv untouched", () => {
    expect(splitTargetArg(["--define", "FOO=1"])).toEqual({
      target: null,
      rest: ["--define", "FOO=1"],
    });
  });

  test("last --target wins", () => {
    expect(splitTargetArg(["--target=bun-linux-x64", "--target=bun-darwin-arm64"])).toEqual({
      target: "bun-darwin-arm64",
      rest: [],
    });
  });

  test("trailing bare --target passes through (value missing)", () => {
    expect(splitTargetArg(["--target"])).toEqual({ target: null, rest: ["--target"] });
  });
});
