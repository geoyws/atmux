// t-c06ac71f: a relative `--stage` must resolve under the caller's cwd.
//
// package.json build:install passes `--stage dist-vendored` (relative).
// The script used to `cd $WORK/tmux-$VERSION` before `mkdir -p $STAGE/bin`,
// so the binary landed inside $WORK (deleted by the EXIT trap) while the
// script still printed success. Strategy: run the script as a subprocess
// from a scratch cwd with a relative --stage, using the
// ATMUX_VENDORED_TMUX_STUB_BUILD=1 seam (no download/compile) — the seam
// keeps the same cd-then-stage ordering, so without the absolute-path fix
// the binary would land in the trap-deleted $WORK and the assertions
// below would fail. The real user tmpdir/crontab/network are never
// touched.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../../scripts/build-vendored-tmux.sh");
const PINNED = resolve(import.meta.dir, "../../../tmux/PINNED_VERSION");

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runScript(
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { exit, stdout, stderr };
}

describe("build-vendored-tmux.sh — relative --stage (t-c06ac71f)", () => {
  test("stages the binary under the caller's cwd, not the trap-deleted work dir", async () => {
    const caller = await mkdtemp(join(tmpdir(), "vendored-stage-caller."));
    try {
      const rel = "rel-dist-vendored";
      const res = await runScript(["--stage", rel, "--force", "--no-smoke"], caller, {
        ATMUX_VENDORED_TMUX_STUB_BUILD: "1",
      });
      expect(`${res.stdout}\n${res.stderr}`).not.toContain("missing");
      expect(res.exit).toBe(0);

      // pwd -P canonicalizes symlinked parents (macOS /var -> /private/var),
      // so compare against the canonical caller path.
      const stagedBin = join(await realpath(caller), rel, "bin", "tmux");
      const st = await stat(stagedBin);
      // Would be absent if the stage had resolved inside $WORK
      // (the EXIT trap deletes $WORK on return).
      expect(st.isFile()).toBe(true);
      expect((st.mode & 0o111) !== 0).toBe(true);

      const version = (await readFile(PINNED, "utf-8")).trim();
      const check = Bun.spawn([stagedBin, "-V"], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(check.stdout).text();
      expect(await check.exited).toBe(0);
      expect(out.trim()).toBe(`tmux ${version}`);

      // The reported path is absolute under the caller's cwd.
      expect(res.stdout).toContain(`staged ${stagedBin}`);
    } finally {
      await rm(caller, { recursive: true, force: true });
    }
  });
});
