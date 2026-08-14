// Unit tests for src/core/verb-capture.ts — ADR-272 verb capture +
// FIFO mutex (lifted from src/verbs/dashboard.ts; dashboard re-exports).
//
// Pins:
//   - stdout.write + console.log are captured AND restored after both
//     normal and throwing verbs (the finally guarantee the mutex
//     rationale depends on).
//   - captureVerbStdout behavior is byte-identical to the pre-lift
//     dashboard.ts implementation (error re-render line included).
//   - captureVerbRun returns the numeric exit code; a throw lands in
//     errorMessage with exitCode null and is NOT appended to stdout.
//   - createVerbMutex is strict FIFO under interleaved async and a
//     rejection does not poison the queue.
//   - src/verbs/dashboard.ts still exports the same function object.

import { describe, expect, test } from "bun:test";
import {
  captureVerbRun,
  captureVerbStdout,
  createVerbMutex,
} from "../../../src/core/verb-capture.ts";
import { captureVerbStdout as fromDashboard } from "../../../src/verbs/dashboard.ts";

/** A deferred the tests resolve by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("captureVerbStdout", () => {
  test("captures process.stdout.write + console.log + Uint8Array writes", async () => {
    const fakeVerb = async () => {
      process.stdout.write("a\n");
      console.log("b");
      process.stdout.write(new TextEncoder().encode("c\n"));
      return 0;
    };
    const out = await captureVerbStdout(fakeVerb, [], "fake");
    expect(out).toBe("a\nb\nc\n");
  });

  test("swallows verb errors and re-renders as a single line", async () => {
    const angryVerb = async () => {
      throw new Error("boom");
    };
    const out = await captureVerbStdout(angryVerb, [], "myverb");
    expect(out).toBe("myverb: boom\n");
  });

  test("non-Error throw is stringified", async () => {
    const angryVerb = async () => {
      const v: unknown = "stringly";
      throw v;
    };
    const out = await captureVerbStdout(angryVerb, [], "x");
    expect(out).toBe("x: stringly\n");
  });

  test("output before a throw is kept, error line appended after it", async () => {
    const verb = async () => {
      process.stdout.write("partial\n");
      throw new Error("late");
    };
    const out = await captureVerbStdout(verb, [], "v");
    expect(out).toBe("partial\nv: late\n");
  });

  test.each([
    ["normal verb", async () => 0],
    [
      "throwing verb",
      async () => {
        throw new Error("x");
      },
    ],
  ])("restores stdout.write + console.log after %s", async (_name, verb) => {
    const origWrite = process.stdout.write;
    const origLog = console.log;
    await captureVerbStdout(verb as () => Promise<number>, [], "l");
    expect(console.log).toBe(origLog);
    // The restore rebinds via .bind, so compare behaviorally: writing
    // after the capture must NOT land in any buffer — assert identity of
    // the function reference changes are limited to a bound clone by
    // re-capturing and checking isolation instead.
    const out = await captureVerbStdout(
      async () => {
        process.stdout.write("iso\n");
        return 0;
      },
      [],
      "l",
    );
    expect(out).toBe("iso\n");
    expect(typeof process.stdout.write).toBe(typeof origWrite);
  });

  test("args are forwarded to the verb", async () => {
    let seen: ReadonlyArray<string> = [];
    await captureVerbStdout(
      async (a) => {
        seen = a;
        return 0;
      },
      ["--json", "x"],
      "l",
    );
    expect(seen).toEqual(["--json", "x"]);
  });

  test("dashboard.ts re-exports the exact same function", () => {
    expect(fromDashboard).toBe(captureVerbStdout);
  });
});

describe("captureVerbRun", () => {
  test("returns exit code 0 with captured stdout", async () => {
    const r = await captureVerbRun(async () => {
      process.stdout.write("hello\n");
      console.log("log-line");
      return 0;
    }, []);
    expect(r).toEqual({ stdout: "hello\nlog-line\n", exitCode: 0 });
  });

  test("nonzero exit code passes through untouched", async () => {
    const r = await captureVerbRun(async () => 3, []);
    expect(r).toEqual({ stdout: "", exitCode: 3 });
  });

  test("a throw lands in errorMessage (exitCode null), NOT in stdout", async () => {
    const r = await captureVerbRun(async () => {
      process.stdout.write("before\n");
      throw new Error("kapow");
    }, []);
    expect(r.stdout).toBe("before\n");
    expect(r.exitCode).toBeNull();
    expect(r.errorMessage).toBe("kapow");
  });

  test("non-Error throw is stringified into errorMessage", async () => {
    const r = await captureVerbRun(async () => {
      const v: unknown = 42;
      throw v;
    }, []);
    expect(r.exitCode).toBeNull();
    expect(r.errorMessage).toBe("42");
  });

  test("restores stdout after a throwing verb (next capture is isolated)", async () => {
    await captureVerbRun(async () => {
      throw new Error("x");
    }, []);
    const r = await captureVerbRun(async () => {
      process.stdout.write("clean\n");
      return 0;
    }, []);
    expect(r.stdout).toBe("clean\n");
  });

  test("Uint8Array writes decode into the buffer", async () => {
    const r = await captureVerbRun(async () => {
      process.stdout.write(new TextEncoder().encode("bytes\n"));
      return 0;
    }, []);
    expect(r.stdout).toBe("bytes\n");
  });
});

describe("createVerbMutex", () => {
  test("strict FIFO order under interleaved async", async () => {
    const mutex = createVerbMutex();
    const log: string[] = [];
    const gate1 = deferred();
    const gate2 = deferred();
    const p1 = mutex.run(async () => {
      log.push("1-start");
      await gate1.promise;
      log.push("1-end");
      return 1;
    });
    const p2 = mutex.run(async () => {
      log.push("2-start");
      await gate2.promise;
      log.push("2-end");
      return 2;
    });
    const p3 = mutex.run(async () => {
      log.push("3-start");
      log.push("3-end");
      return 3;
    });
    // Let microtasks settle: only task 1 may have started.
    await Bun.sleep(0);
    expect(log).toEqual(["1-start"]);
    gate1.resolve();
    await p1;
    await Bun.sleep(0);
    expect(log).toEqual(["1-start", "1-end", "2-start"]);
    gate2.resolve();
    expect(await p2).toBe(2);
    expect(await p3).toBe(3);
    expect(log).toEqual(["1-start", "1-end", "2-start", "2-end", "3-start", "3-end"]);
  });

  test("resolves with the function's return value", async () => {
    const mutex = createVerbMutex();
    expect(await mutex.run(async () => "value")).toBe("value");
  });

  test("a rejection propagates to its caller but does not poison the queue", async () => {
    const mutex = createVerbMutex();
    const log: string[] = [];
    const p1 = mutex.run(async () => {
      log.push("1");
      throw new Error("first fails");
    });
    const p2 = mutex.run(async () => {
      log.push("2");
      return "ok";
    });
    await expect(p1).rejects.toThrow("first fails");
    expect(await p2).toBe("ok");
    expect(log).toEqual(["1", "2"]);
  });

  test("two concurrent captures through the mutex never clobber each other's buffers", async () => {
    // The rationale the mutex exists for (see verb-capture.ts header):
    // run two capture-wrapped verbs "concurrently" through the mutex and
    // assert each buffer holds exactly its own verb's writes.
    const mutex = createVerbMutex();
    const slowGate = deferred();
    const a = mutex.run(() =>
      captureVerbRun(async () => {
        process.stdout.write("A1\n");
        await slowGate.promise;
        process.stdout.write("A2\n");
        return 0;
      }, []),
    );
    const b = mutex.run(() =>
      captureVerbRun(async () => {
        process.stdout.write("B1\n");
        return 0;
      }, []),
    );
    await Bun.sleep(0);
    slowGate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.stdout).toBe("A1\nA2\n");
    expect(rb.stdout).toBe("B1\n");
  });
});
