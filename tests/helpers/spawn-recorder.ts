// A fake `Bun.spawn` that records what atmux asked for (ADR-283 §B1).
//
// `src/abstractions/spawn.ts` is the only module allowed to call
// `Bun.spawn` (ADR-100 R4), and every tmux call site in the repository
// reaches it through there. Recording at that single seam therefore
// covers all of them at once, without module mocking and without adding a
// production injection point to seven files.
//
// It records the EFFECTIVE environment — the object `spawn()` actually
// hands the child after `mergeEnv` has applied `env` and `unsetEnv` — not
// the `unsetEnv` option. That is the stronger assertion: an `unsetEnv`
// that is present but no longer honoured would pass an options check and
// fail this one.
//
// Every recorded call is answered by a real `true(1)`, so exit codes,
// stream reads and `proc.exited` behave normally and the caller's own
// error handling is not bypassed.

/** One intercepted spawn. */
export interface RecordedSpawn {
  cmd: ReadonlyArray<string>;
  /** The environment handed to the child, or `undefined` when the caller
   *  did not pass one (in which case bun uses its start-time snapshot). */
  env: Readonly<Record<string, string | undefined>> | undefined;
}

interface SpawnOptionsLike {
  cmd: string[];
  env?: Record<string, string | undefined>;
  stdin?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

export interface SpawnRecorder {
  readonly calls: RecordedSpawn[];
  /** The environments of every recorded call, for the common assertion. */
  envs(): Array<Readonly<Record<string, string | undefined>> | undefined>;
  restore(): void;
}

/**
 * Replace `Bun.spawn` with a recorder until `restore()` is called.
 *
 * ALWAYS call `restore()` from an `afterEach`, not just at the end of a
 * happy path: bun runs every test file in one process, so a recorder left
 * installed by a throwing test would swallow every subprocess in the rest
 * of the suite.
 */
export function installSpawnRecorder(): SpawnRecorder {
  const original = Bun.spawn;
  const calls: RecordedSpawn[] = [];

  const fake = (opts: unknown): unknown => {
    if (
      typeof opts !== "object" ||
      opts === null ||
      !Array.isArray((opts as SpawnOptionsLike).cmd)
    ) {
      // The positional form `Bun.spawn(["cmd"], opts)` is not used by
      // src/abstractions/spawn.ts. Failing loudly beats silently letting
      // a future call site through unrecorded.
      throw new Error("installSpawnRecorder: expected Bun.spawn({ cmd: [...] }) object form");
    }
    const o = opts as SpawnOptionsLike;
    calls.push({ cmd: [...o.cmd], env: o.env });
    return original({
      cmd: ["true"],
      stdin: o.stdin as never,
      stdout: o.stdout as never,
      stderr: o.stderr as never,
    });
  };

  (Bun as unknown as { spawn: unknown }).spawn = fake;

  return {
    calls,
    envs: () => calls.map((c) => c.env),
    restore: () => {
      (Bun as unknown as { spawn: unknown }).spawn = original;
    },
  };
}
