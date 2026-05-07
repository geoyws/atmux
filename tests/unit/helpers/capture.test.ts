// Unit tests for tests/helpers/capture.ts.
// The helper file isn't in the production coverage denominator
// (`src/**`), but it IS test infrastructure that other tests trust;
// covering it directly catches buffer-leak / restore-on-error bugs
// before they corrupt later tests' captures.

import { describe, expect, test } from "bun:test";
import { captureMain, captureStdio } from "../../helpers/capture.ts";

describe("captureStdio", () => {
  test("captures process.stdout.write + console.log + process.stderr.write", async () => {
    const { result, stdout, stderr } = await captureStdio(async () => {
      process.stdout.write("a\n");
      console.log("b");
      process.stderr.write("c\n");
      return 42;
    });
    expect(result).toBe(42);
    expect(stdout).toBe("a\nb\n");
    expect(stderr).toBe("c\n");
  });

  test("captures Uint8Array writes (decoded as utf-8)", async () => {
    const { stdout, stderr } = await captureStdio(async () => {
      process.stdout.write(new TextEncoder().encode("u8-out\n"));
      process.stderr.write(new TextEncoder().encode("u8-err\n"));
    });
    expect(stdout).toBe("u8-out\n");
    expect(stderr).toBe("u8-err\n");
  });

  test("supports synchronous callbacks (await on a non-promise)", async () => {
    const { result, stdout } = await captureStdio(() => {
      process.stdout.write("sync\n");
      return "done";
    });
    expect(result).toBe("done");
    expect(stdout).toBe("sync\n");
  });

  test("restores originals when fn throws — error re-raises", async () => {
    // Indirect test: after a throwing capture, a SECOND captureStdio
    // call still produces correct output. If finally hadn't restored,
    // writes inside the second call would either go nowhere (still
    // pointing at the freed first-call buffer) OR corrupt unrelated
    // state. We assert end-to-end roundtrip instead of identity-
    // comparing function references (Bun's bound `.write` is a
    // different fn every `.bind()` call, so identity check is brittle).
    await expect(
      captureStdio(async () => {
        process.stdout.write("partial\n");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const { stdout: nextStdout, stderr: nextStderr } = await captureStdio(async () => {
      process.stdout.write("after\n");
      process.stderr.write("after-err\n");
    });
    expect(nextStdout).toBe("after\n");
    expect(nextStderr).toBe("after-err\n");
  });
});

describe("captureMain", () => {
  test("invokes main(argv) and returns { exit, stdout, stderr }", async () => {
    // 'version' is the smallest verb — exit 0 + 'atmux <version>\n' on
    // stdout. Asserts the wrapper unpacks captureStdio's `result` →
    // `exit` correctly.
    const { exit, stdout, stderr } = await captureMain(["version"]);
    expect(exit).toBe(0);
    expect(stdout).toMatch(/^atmux \S+\n$/);
    expect(stderr).toBe("");
  });

  test("unknown-verb path → exit 64 + error on stderr", async () => {
    const { exit, stdout, stderr } = await captureMain(["definitely-not-a-verb"]);
    expect(exit).toBe(64);
    expect(stdout).toBe("");
    expect(stderr).toContain("atmux: unknown verb: definitely-not-a-verb");
  });
});
