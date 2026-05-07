// Unit tests for src/verbs/inbox.ts.
// Bash spec: lib/inbox.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDispatched } from "../../../src/core/inbox.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { inbox, parseInboxArgs } from "../../../src/verbs/inbox.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-inbox-verb-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: "team", members: [{ name: "alpha" }] }),
  );
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

// ---------- parseInboxArgs ----------

describe("parseInboxArgs", () => {
  test("plain member", () => {
    expect(parseInboxArgs(["alpha"])).toEqual({ member: "alpha", json: false });
  });

  test("--json flag", () => {
    expect(parseInboxArgs(["alpha", "--json"]).json).toBe(true);
  });

  test("--team-dir consumed", () => {
    expect(parseInboxArgs(["alpha", "--team-dir", "/x"]).teamDir).toBe("/x");
  });

  test("missing member → UsageError", () => {
    expect(() => parseInboxArgs([])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseInboxArgs(["alpha", "--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseInboxArgs(["alpha", "--bogus"])).toThrow(UsageError);
  });

  test("too many positionals → UsageError", () => {
    expect(() => parseInboxArgs(["alpha", "extra"])).toThrow(UsageError);
  });
});

// ---------- inbox verb integration ----------

describe("inbox verb — integration", () => {
  test("empty inbox: human view shows '(empty)' for each section", async () => {
    const { out } = await captureStdout(() => inbox(["alpha", "--team-dir", teamDir]));
    expect(out).toContain("inbox — alpha");
    expect(out).toContain("pending");
    expect(out).toContain("in-progress");
    expect(out).toContain("done");
    // Three "(empty)" markers — one per section.
    expect((out.match(/\(empty\)/g) ?? []).length).toBe(3);
  });

  test("--json emits valid JSON with the {pending,inProgress,done} shape", async () => {
    const { out } = await captureStdout(() => inbox(["alpha", "--json", "--team-dir", teamDir]));
    const parsed = JSON.parse(out);
    expect(parsed.pending).toEqual([]);
    expect(parsed.inProgress).toEqual([]);
    expect(parsed.done).toEqual([]);
  });

  test('--json emits compact single-line JSON (ADR-029 §F12 — bash `cat "$f"` parity)', async () => {
    // Bash lib/inbox.sh:24 writes `{"pending":[],"inProgress":[],"done":[]}`
    // (compact, single-line) on first-run init, then `cat "$f"` for --json.
    // The TS port emits the same compact shape so byte-equal-after-mask
    // holds against bash's `cat` literal-file output.
    const { out } = await captureStdout(() => inbox(["alpha", "--json", "--team-dir", teamDir]));
    expect(out).toBe('{"pending":[],"inProgress":[],"done":[]}\n');
  });

  test("populated inProgress shows id + subject", async () => {
    await appendDispatched(
      atmuxDir,
      "alpha",
      { id: "t-aaaaaaaa", subject: "ship X", status: "in-progress", deps: [] },
      1,
    );
    const { out } = await captureStdout(() => inbox(["alpha", "--team-dir", teamDir]));
    expect(out).toContain("t-aaaaaaaa");
    expect(out).toContain("ship X");
  });

  test("unknown member → ConfigError (bash member_json die parity)", async () => {
    await expect(inbox(["bogus", "--team-dir", teamDir])).rejects.toThrow(ConfigError);
  });
});
