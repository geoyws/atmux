// Unit tests for src/verbs/reply.ts (reply + outbox).
// Bash spec: lib/reply.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  archiveOpenEntries,
  collectOpenEntries,
  insertOpenEntry,
  outbox,
  parseOutboxArgs,
  parseReplyArgs,
  reply,
} from "../../../src/verbs/reply.ts";

let teamDir: string;
let atmuxDir: string;
let priorMember: string | undefined;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-reply-verb-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: "team", members: [{ name: "alpha" }, { name: "beta" }] }),
  );
  priorMember = process.env.ATMUX_MEMBER;
  delete process.env.ATMUX_MEMBER;
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
  if (priorMember !== undefined) process.env.ATMUX_MEMBER = priorMember;
  else delete process.env.ATMUX_MEMBER;
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

// ---------- Pure: parseReplyArgs ----------

describe("parseReplyArgs", () => {
  test("plain msg", () => {
    expect(parseReplyArgs(["hello", "world"]).msg).toBe("hello world");
  });

  test("--from <member>", () => {
    expect(parseReplyArgs(["--from", "alpha", "msg"]).from).toBe("alpha");
  });

  test("--team-dir consumed", () => {
    expect(parseReplyArgs(["--team-dir", "/x", "msg"]).teamDir).toBe("/x");
  });

  test("`--` ends flag parsing", () => {
    expect(parseReplyArgs(["--", "msg-with-dashes"]).msg).toBe("msg-with-dashes");
  });

  test("missing msg → UsageError", () => {
    expect(() => parseReplyArgs([])).toThrow(UsageError);
  });

  test("--from without value → UsageError", () => {
    expect(() => parseReplyArgs(["--from"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseReplyArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown -* flag → UsageError", () => {
    expect(() => parseReplyArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- Pure: insertOpenEntry ----------

describe("insertOpenEntry", () => {
  test("inserts under existing `## Open` line", () => {
    const body = "# header\n\n## Open\n- [ts] **a**: existing\n";
    const out = insertOpenEntry(body, "- [now] **b**: new");
    expect(out).toContain("## Open\n- [now] **b**: new");
    expect(out).toContain("- [ts] **a**: existing");
    // New entry comes BEFORE existing (newest-first).
    const newIdx = out.indexOf("- [now] **b**");
    const oldIdx = out.indexOf("- [ts] **a**");
    expect(newIdx).toBeLessThan(oldIdx);
  });

  test("creates `## Open` section when missing", () => {
    const body = "# header\n";
    const out = insertOpenEntry(body, "- [ts] **a**: msg");
    expect(out).toContain("## Open");
    expect(out).toContain("- [ts] **a**: msg");
  });
});

// ---------- Pure: collectOpenEntries ----------

describe("collectOpenEntries", () => {
  test("returns lines under `## Open` matching `- [`", () => {
    const body =
      "## Open\n- [t1] **a**: m1\n- [t2] **b**: m2\nplain text\n## Archive\n- [t3] **c**: m3\n";
    expect(collectOpenEntries(body)).toEqual(["- [t1] **a**: m1", "- [t2] **b**: m2"]);
  });

  test("empty when no `## Open` section", () => {
    expect(collectOpenEntries("# header\n")).toEqual([]);
  });

  test("empty when section has no `- [` entries", () => {
    expect(collectOpenEntries("## Open\nrandom prose\n")).toEqual([]);
  });
});

// ---------- Pure: archiveOpenEntries ----------

describe("archiveOpenEntries", () => {
  test("moves entries to existing `## Archive`", () => {
    const body =
      "## Open\n- [t1] **a**: m1\n- [t2] **b**: m2\n\n## Archive\n- [t0] **x**: old\n";
    const { body: out, archived } = archiveOpenEntries(body, "now");
    expect(archived).toHaveLength(2);
    // Entries removed from Open
    expect(collectOpenEntries(out)).toEqual([]);
    // Both entries land in Archive with `_(archived now)_` suffix
    expect(out).toContain("- [t1] **a**: m1  _(archived now)_");
    expect(out).toContain("- [t2] **b**: m2  _(archived now)_");
    // Pre-existing archive entry preserved
    expect(out).toContain("- [t0] **x**: old");
  });

  test("creates `## Archive` when missing", () => {
    const body = "## Open\n- [t1] **a**: m1\n";
    const { body: out } = archiveOpenEntries(body, "now");
    expect(out).toContain("## Archive");
    expect(out).toContain("- [t1] **a**: m1  _(archived now)_");
  });

  test("no-op when Open is empty", () => {
    const body = "## Open\n## Archive\n";
    const { body: out, archived } = archiveOpenEntries(body, "now");
    expect(archived).toEqual([]);
    expect(out).toBe(body);
  });
});

// ---------- parseOutboxArgs ----------

describe("parseOutboxArgs", () => {
  test("--ack / --json toggles", () => {
    expect(parseOutboxArgs(["--ack"]).ack).toBe(true);
    expect(parseOutboxArgs(["--json"]).json).toBe(true);
  });

  test("--team-dir consumed", () => {
    expect(parseOutboxArgs(["--team-dir", "/x"]).teamDir).toBe("/x");
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseOutboxArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseOutboxArgs(["bogus"])).toThrow(UsageError);
  });
});

// ---------- reply verb integration ----------

describe("reply verb — integration", () => {
  test("first reply creates outbox file with header + entry", async () => {
    const { out } = await captureStdout(() =>
      reply(["--from", "alpha", "--team-dir", teamDir, "first", "message"]),
    );
    expect(out).toContain("reply recorded (alpha → driver)");
    const ob = await Bun.file(join(atmuxDir, "lead-outbox.md")).text();
    expect(ob).toContain("# Lead Outbox");
    expect(ob).toContain("**alpha**: first message");
  });

  test("--from defaults to $ATMUX_MEMBER", async () => {
    process.env.ATMUX_MEMBER = "envalpha";
    await captureStdout(() => reply(["--team-dir", teamDir, "msg"]));
    const ob = await Bun.file(join(atmuxDir, "lead-outbox.md")).text();
    expect(ob).toContain("**envalpha**:");
  });

  test("--from defaults to 'lead' when no env / no flag", async () => {
    await captureStdout(() => reply(["--team-dir", teamDir, "msg"]));
    const ob = await Bun.file(join(atmuxDir, "lead-outbox.md")).text();
    expect(ob).toContain("**lead**:");
  });

  test("--from with unknown member (not 'lead') → ConfigError", async () => {
    await expect(
      reply(["--from", "bogus", "--team-dir", teamDir, "msg"]),
    ).rejects.toThrow(ConfigError);
  });

  test("--from 'lead' is allowed even when not in members[] (synthetic)", async () => {
    await captureStdout(() => reply(["--from", "lead", "--team-dir", teamDir, "msg"]));
    const ob = await Bun.file(join(atmuxDir, "lead-outbox.md")).text();
    expect(ob).toContain("**lead**:");
  });

  test("multiple replies stack newest-first under `## Open`", async () => {
    await captureStdout(() => reply(["--from", "alpha", "--team-dir", teamDir, "first"]));
    await captureStdout(() => reply(["--from", "beta", "--team-dir", teamDir, "second"]));
    const ob = await Bun.file(join(atmuxDir, "lead-outbox.md")).text();
    const idxBeta = ob.indexOf("**beta**: second");
    const idxAlpha = ob.indexOf("**alpha**: first");
    expect(idxBeta).toBeGreaterThan(0);
    expect(idxAlpha).toBeGreaterThan(idxBeta);
  });
});

// ---------- outbox verb integration ----------

describe("outbox verb — integration", () => {
  test("missing outbox file → '(outbox empty)' (text mode)", async () => {
    const { out } = await captureStdout(() => outbox(["--team-dir", teamDir]));
    expect(out).toContain("(outbox empty)");
  });

  test("missing outbox file → '{\"open\":[]}' (json mode)", async () => {
    const { out } = await captureStdout(() =>
      outbox(["--json", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ open: [] });
  });

  test("populated open section: human view shows entries", async () => {
    await captureStdout(() => reply(["--from", "alpha", "--team-dir", teamDir, "msg"]));
    const { out } = await captureStdout(() => outbox(["--team-dir", teamDir]));
    expect(out).toContain("📬 lead-outbox");
    expect(out).toContain("**alpha**: msg");
  });

  test("--json emits the entries array", async () => {
    await captureStdout(() => reply(["--from", "alpha", "--team-dir", teamDir, "msg"]));
    const { out } = await captureStdout(() =>
      outbox(["--json", "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.open).toHaveLength(1);
    expect(parsed.open[0]).toContain("**alpha**: msg");
  });

  test("empty open section but file exists: '📭 outbox empty'", async () => {
    await writeFile(join(atmuxDir, "lead-outbox.md"), "## Open\n## Archive\n");
    const { out } = await captureStdout(() => outbox(["--team-dir", teamDir]));
    expect(out).toContain("📭 outbox empty");
  });

  test("--ack archives all open entries", async () => {
    await captureStdout(() => reply(["--from", "alpha", "--team-dir", teamDir, "m1"]));
    await captureStdout(() => reply(["--from", "beta", "--team-dir", teamDir, "m2"]));
    const { out } = await captureStdout(() =>
      outbox(["--ack", "--team-dir", teamDir]),
    );
    expect(out).toContain("archived 2 entries");
    const ob = await Bun.file(join(atmuxDir, "lead-outbox.md")).text();
    expect(collectOpenEntries(ob)).toEqual([]);
    expect(ob).toContain("## Archive");
    expect(ob).toContain("**alpha**: m1  _(archived");
    expect(ob).toContain("**beta**: m2  _(archived");
  });

  test("--ack on empty outbox is a no-op (no '#archived' line)", async () => {
    const { out } = await captureStdout(() =>
      outbox(["--ack", "--team-dir", teamDir]),
    );
    expect(out).not.toContain("archived");
  });
});
