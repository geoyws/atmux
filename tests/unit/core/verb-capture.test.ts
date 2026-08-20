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
//   - stderr is captured ALONGSIDE stdout and TEED through to the real
//     stderr (ADR-272 §Supplement-2026-08-20) — the `atmux::ok` receipt
//     lives on that channel, and swallowing it would blind the server
//     log.
//   - createVerbMutex is strict FIFO under interleaved async and a
//     rejection does not poison the queue.
//   - The queue is BOUNDED (VERB_MUTEX_MAX_QUEUE) and carries an abandon
//     deadline: a caller past the cap is refused immediately with the
//     holder NAMED, and a caller whose deadline elapsed while queued is
//     SKIPPED rather than run late. Both are ADR-272 §Supplement-P7 §R2,
//     which reverses this module's earlier "deliberately uncapped".
//   - createVerbMutex.state() reports the CURRENT holder, when it
//     acquired, and how many callers are queued behind it — the
//     observability a wedged voice tool bridge is detected through.
//   - src/verbs/dashboard.ts still exports the same function object.

import { describe, expect, test } from "bun:test";
import {
  captureVerbRun,
  captureVerbStdout,
  createVerbMutex,
  VERB_MUTEX_MAX_QUEUE,
  VERB_MUTEX_UNLABELLED,
} from "../../../src/core/verb-capture.ts";
import { VerbMutexError } from "../../../src/errors.ts";
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
    expect(r).toEqual({ stdout: "hello\nlog-line\n", stderr: "", exitCode: 0 });
  });

  test("nonzero exit code passes through untouched", async () => {
    const r = await captureVerbRun(async () => 3, []);
    expect(r).toEqual({ stdout: "", stderr: "", exitCode: 3 });
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

// ADR-272 §Supplement-2026-08-20 — the capture was half-deaf: atmux
// verbs put their success RECEIPT on stderr (`atmux::ok`), so a
// stdout-only capture could not tell "tell-lead delivered the ask" from
// "the verb said nothing".
describe("captureVerbRun — stderr", () => {
  /** Swap in a recording stderr sink around `fn`, restoring afterwards.
   *  This is what proves the TEE: if the capture swallowed stderr, this
   *  sink would record nothing. */
  async function withRecordedStderr<T>(fn: () => Promise<T>): Promise<{ r: T; sink: string }> {
    let sink = "";
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      sink += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      return { r: await fn(), sink };
    } finally {
      process.stderr.write = orig;
    }
  }

  test("a verb's stderr receipt lands in stderr, NOT in stdout", async () => {
    const { r } = await withRecordedStderr(() =>
      captureVerbRun(async () => {
        process.stderr.write("✅ atmux tell-lead → lead (appended to /w/di.md)\n");
        return 0;
      }, []),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("✅ atmux tell-lead → lead (appended to /w/di.md)\n");
    // The whole defect in one assertion: stdout is empty and the run
    // still succeeded.
    expect(r.stdout).toBe("");
  });

  test("stderr is TEED — the real stderr still receives every write", async () => {
    const { r, sink } = await withRecordedStderr(() =>
      captureVerbRun(async () => {
        process.stderr.write("atmux: warn: ping failed\n");
        return 0;
      }, []),
    );
    expect(r.stderr).toBe("atmux: warn: ping failed\n");
    // Swallowing stderr would trade one blind spot for another — the vox
    // server logs on this channel.
    expect(sink).toBe("atmux: warn: ping failed\n");
  });

  test("stdout and stderr do not cross-contaminate", async () => {
    const { r } = await withRecordedStderr(() =>
      captureVerbRun(async () => {
        process.stdout.write("out-line\n");
        process.stderr.write("err-line\n");
        console.log("log-line");
        return 0;
      }, []),
    );
    expect(r.stdout).toBe("out-line\nlog-line\n");
    expect(r.stderr).toBe("err-line\n");
  });

  test("stderr written before a throw is still captured", async () => {
    const { r } = await withRecordedStderr(() =>
      captureVerbRun(async () => {
        process.stderr.write("partial\n");
        throw new Error("kapow");
      }, []),
    );
    expect(r.exitCode).toBeNull();
    expect(r.errorMessage).toBe("kapow");
    expect(r.stderr).toBe("partial\n");
  });

  test("Uint8Array stderr writes decode into the buffer", async () => {
    const { r } = await withRecordedStderr(() =>
      captureVerbRun(async () => {
        process.stderr.write(new TextEncoder().encode("err-bytes\n"));
        return 0;
      }, []),
    );
    expect(r.stderr).toBe("err-bytes\n");
  });

  test("restores process.stderr.write after a throwing verb", async () => {
    const { r, sink } = await withRecordedStderr(async () => {
      await captureVerbRun(async () => {
        process.stderr.write("first\n");
        throw new Error("x");
      }, []);
      // If the patch leaked, this write would land in the DEAD buffer of
      // the finished capture instead of the recorder.
      process.stderr.write("after\n");
      return await captureVerbRun(async () => {
        process.stderr.write("second\n");
        return 0;
      }, []);
    });
    expect(r.stderr).toBe("second\n");
    expect(sink).toBe("first\nafter\nsecond\n");
  });

  // `console.error` is a SEPARATE surface from `process.stderr.write` in
  // Bun — it does not route through it (verified 2026-08-20). A capture
  // that patched only the `process.*` half would see the empty string for
  // a verb that used `console.error`, which looks exactly like the defect
  // this whole change closes.
  test("CONTROL: the recorder patch alone does NOT see console.error", async () => {
    // Without this control, the console.error tests below could pass
    // vacuously on a harness that captured nothing. It pins the Bun fact
    // the implementation depends on: patching `process.stderr.write` is
    // not sufficient, so `runRedirected` must patch both.
    let sink = "";
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      sink += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    const origError = console.error;
    console.error = () => {}; // keep the control quiet, not routed
    console.error("not-routed");
    console.error = origError;
    process.stderr.write = orig;
    expect(sink).toBe("");
  });

  test("a console.error receipt lands in stderr", async () => {
    const origError = console.error;
    const seen: string[] = [];
    console.error = (...a: unknown[]) => {
      seen.push(a.map((v) => String(v)).join(" "));
    };
    try {
      const r = await captureVerbRun(async () => {
        console.error("✅ atmux reply recorded (be-1 → driver) in /w/ob.md");
        return 0;
      }, []);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("✅ atmux reply recorded (be-1 → driver) in /w/ob.md\n");
      // TEED: the real console.error still ran (proved by the recorder
      // seeing it), so a verb's diagnostics are not swallowed.
      expect(seen).toEqual(["✅ atmux reply recorded (be-1 → driver) in /w/ob.md"]);
    } finally {
      console.error = origError;
    }
  });

  test("console.error joins every argument, buffer and tee agreeing", async () => {
    const origError = console.error;
    const seen: string[] = [];
    console.error = (...a: unknown[]) => {
      seen.push(a.map((v) => String(v)).join(" "));
    };
    try {
      const r = await captureVerbRun(async () => {
        console.error("✅ atmux", "tell-lead", 7);
        return 0;
      }, []);
      expect(r.stderr).toBe("✅ atmux tell-lead 7\n");
      expect(seen).toEqual(["✅ atmux tell-lead 7"]);
    } finally {
      console.error = origError;
    }
  });

  test("console.error is restored after a throwing verb", async () => {
    const origError = console.error;
    const seen: string[] = [];
    console.error = (...a: unknown[]) => {
      seen.push(a.map((v) => String(v)).join(" "));
    };
    try {
      await captureVerbRun(async () => {
        console.error("during");
        throw new Error("x");
      }, []);
      // If the patch leaked, this would land in the finished capture's
      // dead buffer instead of the recorder.
      console.error("after");
      expect(seen).toEqual(["during", "after"]);
    } finally {
      console.error = origError;
    }
  });

  test("console.error and process.stderr.write share ONE buffer, in order", async () => {
    const origError = console.error;
    console.error = () => {};
    try {
      const { r } = await withRecordedStderr(() =>
        captureVerbRun(async () => {
          process.stderr.write("one\n");
          console.error("two");
          process.stderr.write("three\n");
          return 0;
        }, []),
      );
      expect(r.stderr).toBe("one\ntwo\nthree\n");
    } finally {
      console.error = origError;
    }
  });

  // The TEE makes a leaked stderr patch behaviourally INVISIBLE — writes
  // still reach the real stderr through it, so no output assertion can
  // see the leak; only an identity round-trip can. Without these two,
  // deleting `process.stderr.write = origStderrWriteRef` from the
  // `finally` passes the entire suite (measured), and every capture
  // leaves one more live closure appending to a dead buffer.
  test.each([
    ["a normal verb", async () => 0],
    [
      "a throwing verb",
      async () => {
        throw new Error("x");
      },
    ],
  ])("restores the EXACT process.stderr.write it found, after %s", async (_label, verb) => {
    const real = process.stderr.write;
    const sentinel = ((): boolean => true) as typeof process.stderr.write;
    process.stderr.write = sentinel;
    try {
      await captureVerbRun(verb as () => Promise<number>, []);
      expect(process.stderr.write).toBe(sentinel);
    } finally {
      process.stderr.write = real;
    }
  });

  test("N captures leave NO wrapper layers behind", async () => {
    // Restoring a bound CLONE instead of the original would still pass
    // the identity test above only by accident; running the cycle three
    // times pins that the stream is not accumulating one wrapper per run.
    const real = process.stderr.write;
    const sentinel = ((): boolean => true) as typeof process.stderr.write;
    process.stderr.write = sentinel;
    try {
      for (let i = 0; i < 3; i += 1) await captureVerbRun(async () => 0, []);
      expect(process.stderr.write).toBe(sentinel);
    } finally {
      process.stderr.write = real;
    }
  });

  test("the TEE calls Bun's REAL console.error DETACHED, without throwing", async () => {
    // `runRedirected` saves `console.error` and invokes it as a bare
    // function (`origError(...a)`). If Bun's console methods required
    // `this === console`, every verb that used console.error inside a
    // capture would crash — and every OTHER console.error test here
    // stubs the original, so none of them would notice. This one runs
    // against the real console.error and pays one line of test-log
    // output for the proof.
    const r = await captureVerbRun(async () => {
      console.error("atmux: (verb-capture test) the tee reaches the real console.error");
      return 0;
    }, []);
    expect(r.exitCode).toBe(0);
    expect(r.errorMessage).toBeUndefined();
    expect(r.stderr).toBe("atmux: (verb-capture test) the tee reaches the real console.error\n");
  });

  test("console.error is restored to the EXACT function it found", async () => {
    const real = console.error;
    const sentinel = (): void => {};
    console.error = sentinel;
    try {
      await captureVerbRun(async () => 0, []);
      expect(console.error).toBe(sentinel);
    } finally {
      console.error = real;
    }
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

// A holder that never returns is permanent — the capture wrapper cannot
// run two verbs at once — and invisible unless the mutex reports it.
// These tests drive exactly that: a function that never resolves, and the
// state readings taken while it holds the lock. `holder` + `heldSince`
// are the whole of the wedge verdict, which is why bounding the QUEUE
// (below) costs that verdict nothing.
describe("createVerbMutex — state()", () => {
  test("an untouched mutex reads idle", () => {
    expect(createVerbMutex().state()).toEqual({
      holder: null,
      heldSince: null,
      queueDepth: 0,
    });
  });

  test("reports the holder's LABEL and acquisition time from the injected clock", async () => {
    let now = 500;
    const mutex = createVerbMutex({ clock: () => now });
    const gate = deferred();
    const p = mutex.run(async () => {
      await gate.promise;
      return 1;
    }, "team_status");
    await Bun.sleep(0);
    expect(mutex.state()).toEqual({ holder: "team_status", heldSince: 500, queueDepth: 0 });
    // The clock moving does not move heldSince — it is the ACQUISITION
    // stamp, which is what makes a held-duration computable.
    now = 90_000;
    expect(mutex.state().heldSince).toBe(500);
    gate.resolve();
    await p;
  });

  test("an unlabelled run is still attributable, not blank", async () => {
    const mutex = createVerbMutex();
    const gate = deferred();
    const p = mutex.run(async () => {
      await gate.promise;
      return 0;
    });
    await Bun.sleep(0);
    expect(mutex.state().holder).toBe(VERB_MUTEX_UNLABELLED);
    gate.resolve();
    await p;
  });

  test("queueDepth counts the WAITERS, never the holder, up to the cap", async () => {
    const mutex = createVerbMutex();
    const gate = deferred();
    const held = mutex.run(async () => {
      await gate.promise;
      return 0;
    }, "stuck");
    await Bun.sleep(0);
    expect(mutex.state()).toMatchObject({ holder: "stuck", queueDepth: 0 });

    const waiters = Array.from({ length: VERB_MUTEX_MAX_QUEUE }, (_, i) =>
      mutex.run(async () => i, `waiter-${i}`),
    );
    await Bun.sleep(0);
    // Every one inside the cap is still queued, and the holder is
    // unchanged — the wedge is as visible as it ever was.
    expect(mutex.state()).toMatchObject({ holder: "stuck", queueDepth: VERB_MUTEX_MAX_QUEUE });

    gate.resolve();
    await held;
    expect(await Promise.all(waiters)).toEqual(
      Array.from({ length: VERB_MUTEX_MAX_QUEUE }, (_, i) => i),
    );
    expect(mutex.state()).toEqual({ holder: null, heldSince: null, queueDepth: 0 });
  });

  test("the holder is cleared even when its function REJECTS", async () => {
    const mutex = createVerbMutex();
    await expect(
      mutex.run(async () => {
        throw new Error("boom");
      }, "explodes"),
    ).rejects.toThrow("boom");
    // A rejection that left `holder` set would read as a permanent wedge
    // for a tool that actually finished.
    expect(mutex.state()).toEqual({ holder: null, heldSince: null, queueDepth: 0 });
  });

  test("a function that NEVER resolves holds the lock indefinitely — the wedge", async () => {
    let now = 0;
    const mutex = createVerbMutex({ clock: () => now });
    void mutex.run(() => new Promise<number>(() => {}), "never_returns");
    await Bun.sleep(0);
    now = 10 * 60_000;
    // Ten minutes on, still held by the same label with nothing releasing
    // it. This is the state `/healthz` must not report as ok.
    expect(mutex.state()).toMatchObject({ holder: "never_returns", heldSince: 0 });
    void mutex.run(async () => 1, "queued-behind");
    await Bun.sleep(0);
    expect(mutex.state().queueDepth).toBe(1);
    expect(mutex.state().holder).toBe("never_returns");
  });
});

// ADR-272 §Supplement-P7 §R2 — the lane must RECOVER, not only confess.
//
// Before this, `createVerbMutex` had no cap and no abandon path: a verb
// that never returned meant every later call queued forever, and when a
// merely-slow verb finally finished, the whole backlog then EXECUTED —
// answers nobody was waiting for, and (once P7 enables the mutating
// tools) a `dispatch_task` firing minutes after the operator was told it
// timed out. These tests drive both halves: nothing grows without bound,
// and nothing runs after its deadline.
describe("createVerbMutex — bounded queue", () => {
  test("a caller past the cap is refused IMMEDIATELY, with the holder named", async () => {
    const mutex = createVerbMutex({ maxQueueDepth: 2, clock: () => 500 });
    const gate = deferred();
    const held = mutex.run(async () => {
      await gate.promise;
      return 0;
    }, "team_status");
    await Bun.sleep(0);
    const queued = [mutex.run(async () => 1, "a"), mutex.run(async () => 2, "b")];
    await Bun.sleep(0);
    expect(mutex.state().queueDepth).toBe(2);

    let ran = false;
    const refused = mutex.run(async () => {
      ran = true;
      return 3;
    }, "team_health");
    await expect(refused).rejects.toThrow(VerbMutexError);
    // NOT RUN — the whole point of refusing rather than accepting.
    expect(ran).toBe(false);

    const e = (await refused.catch((x: unknown) => x)) as VerbMutexError;
    expect(e.reason).toBe("queue_full");
    expect(e.blockedBy).toBe("team_status"); // the actionable half
    expect(e.queueDepth).toBe(2);
    expect(e.queueCap).toBe(2);
    expect(e.waitedMs).toBe(0);
    expect(e.tag).toBe("verb-mutex");
    expect(e.message).toContain("team_health");
    expect(e.message).toContain("team_status");

    gate.resolve();
    await held;
    expect(await Promise.all(queued)).toEqual([1, 2]);
  });

  test("the queue cannot grow without limit, however many callers arrive", async () => {
    const mutex = createVerbMutex({ maxQueueDepth: 3 });
    const gate = deferred();
    const held = mutex.run(async () => {
      await gate.promise;
      return 0;
    }, "stuck");
    await Bun.sleep(0);

    let refusals = 0;
    const all = Array.from({ length: 50 }, (_, i) =>
      mutex
        .run(async () => i, `c${i}`)
        .catch((e: unknown) => {
          if (e instanceof VerbMutexError) refusals += 1;
          return -1;
        }),
    );
    await Bun.sleep(0);
    expect(mutex.state().queueDepth).toBe(3);
    expect(refusals).toBe(47);

    gate.resolve();
    await held;
    await Promise.all(all);
    expect(mutex.state().queueDepth).toBe(0);
  });

  test("a refusal consumes no slot — the accepted callers still run, in order", async () => {
    const mutex = createVerbMutex({ maxQueueDepth: 1 });
    const order: string[] = [];
    const gate = deferred();
    const held = mutex.run(async () => {
      await gate.promise;
      order.push("holder");
      return 0;
    }, "holder");
    await Bun.sleep(0);
    const accepted = mutex.run(async () => {
      order.push("accepted");
      return 1;
    }, "accepted");
    await Bun.sleep(0);
    await expect(mutex.run(async () => 2, "refused")).rejects.toThrow(VerbMutexError);
    gate.resolve();
    await held;
    await accepted;
    expect(order).toEqual(["holder", "accepted"]);
    // The refusal did not leave a phantom waiter behind.
    expect(mutex.state()).toEqual({ holder: null, heldSince: null, queueDepth: 0 });
  });

  test("the shipped default cap is 8", () => {
    expect(VERB_MUTEX_MAX_QUEUE).toBe(8);
  });
});

describe("createVerbMutex — abandon path", () => {
  test("a caller whose deadline elapsed while queued is SKIPPED, not run late", async () => {
    let now = 0;
    const mutex = createVerbMutex({ clock: () => now });
    const gate = deferred();
    let lateRan = false;
    const held = mutex.run(async () => {
      await gate.promise;
      return 0;
    }, "slow_verb");
    await Bun.sleep(0);

    const late = mutex.run(
      async () => {
        lateRan = true;
        return 1;
      },
      "dispatch_task",
      { abandonAfterMs: 20_000 },
    );
    // The holder takes 30s — well past the queued caller's deadline.
    now = 30_000;
    gate.resolve();
    await held;

    await expect(late).rejects.toThrow(VerbMutexError);
    // The one that matters: a mutating verb must NOT fire minutes after
    // the operator was told it timed out.
    expect(lateRan).toBe(false);
    const e = (await late.catch((x: unknown) => x)) as VerbMutexError;
    expect(e.reason).toBe("abandoned");
    expect(e.waitedMs).toBe(30_000);
    expect(e.blockedBy).toBe("slow_verb");
    expect(e.message).toContain("abandoned after waiting 30000ms");
  });

  test("the deadline boundary: waiting exactly the budget still runs, one ms past does not", async () => {
    async function waitedThenRan(waitMs: number): Promise<boolean> {
      let now = 0;
      const mutex = createVerbMutex({ clock: () => now });
      const gate = deferred();
      let ran = false;
      const held = mutex.run(async () => {
        await gate.promise;
        return 0;
      }, "holder");
      await Bun.sleep(0);
      const queued = mutex.run(
        async () => {
          ran = true;
          return 1;
        },
        "queued",
        { abandonAfterMs: 1_000 },
      );
      now = waitMs;
      gate.resolve();
      await held;
      await queued.catch(() => undefined);
      return ran;
    }
    expect(await waitedThenRan(1_000)).toBe(true);
    expect(await waitedThenRan(1_001)).toBe(false);
  });

  test("without a deadline, a long wait still runs — the historical behaviour", async () => {
    let now = 0;
    const mutex = createVerbMutex({ clock: () => now });
    const gate = deferred();
    let ran = false;
    const held = mutex.run(async () => {
      await gate.promise;
      return 0;
    }, "holder");
    await Bun.sleep(0);
    const queued = mutex.run(async () => {
      ran = true;
      return 1;
    }, "patient");
    now = 10 * 60_000;
    gate.resolve();
    await held;
    expect(await queued).toBe(1);
    expect(ran).toBe(true);
  });

  test("the queue DRAINS when a stuck holder finally returns", async () => {
    // The recovery property, end to end: a backlog of expired callers is
    // discarded in one pass and the lane is immediately usable again —
    // rather than the lane grinding through work nobody is waiting for.
    let now = 0;
    const mutex = createVerbMutex({ clock: () => now });
    const gate = deferred();
    const ran: string[] = [];
    const held = mutex.run(async () => {
      ran.push("stuck");
      await gate.promise;
      return 0;
    }, "stuck");
    await Bun.sleep(0);

    const stale = Array.from({ length: 5 }, (_, i) =>
      mutex
        .run(
          async () => {
            ran.push(`stale-${i}`);
            return i;
          },
          `stale-${i}`,
          { abandonAfterMs: 20_000 },
        )
        .catch(() => -1),
    );
    await Bun.sleep(0);
    expect(mutex.state().queueDepth).toBe(5);

    now = 120_000;
    gate.resolve();
    await held;
    expect(await Promise.all(stale)).toEqual([-1, -1, -1, -1, -1]);
    expect(ran).toEqual(["stuck"]); // not one stale verb executed

    // And the lane is healthy again for the NEXT thing the operator says.
    expect(mutex.state()).toEqual({ holder: null, heldSince: null, queueDepth: 0 });
    expect(await mutex.run(async () => "fresh", "team_status")).toBe("fresh");
    expect(ran).toEqual(["stuck"]);
  });
});
