// e-77 T3 — `atmux outbox archive` verb over the T1 helper.
// Mirror of inbox-archive.test.ts for lead-outbox.md; cut math lives
// in inbox-outbox-archive.test.ts. Uses the real outbox entry shape
// `- [HH:MM MYT] **from**: msg` (src/verbs/reply.ts appendOutboxEntry).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  outbox,
  outboxArchive,
  parseOutboxArchiveArgs,
} from "../../../src/verbs/reply.ts";

const dirs: string[] = [];
let origCockpitConfig: string | undefined;
beforeEach(() => {
  origCockpitConfig = process.env.ATMUX_COCKPIT_CONFIG;
});
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  if (origCockpitConfig === undefined) delete process.env.ATMUX_COCKPIT_CONFIG;
  else process.env.ATMUX_COCKPIT_CONFIG = origCockpitConfig;
});

async function stageOutbox(body: string, mtimeMs?: number): Promise<{ root: string; atmuxDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "atmux-outbox-archive-"));
  dirs.push(root);
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  const p = join(atmuxDir, "lead-outbox.md");
  await writeFile(p, body);
  if (mtimeMs !== undefined) await utimes(p, new Date(mtimeMs), new Date(mtimeMs));
  return { root, atmuxDir };
}

/** MYT clock (HH, MM) of an epoch-ms — mirrors the helper's anchoring. */
function mytClock(ms: number): [number, number] {
  const d = new Date(ms + 8 * 3_600_000);
  return [d.getUTCHours(), d.getUTCMinutes()];
}

function entry(h: number, m: number, from: string, msg: string): string {
  return `- [${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} MYT] **${from}**: ${msg}`;
}

function capture() {
  let out = "";
  return { out: () => out, stdout: { write: (s: string) => { out += s; } } };
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    // NB: await FIRST, then read `out` — `{ out, result: await fn() }`
    // evaluates `out` (empty) before fn() runs.
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

describe("parseOutboxArchiveArgs", () => {
  test("defaults to 48h, non-json", () => {
    expect(parseOutboxArchiveArgs([])).toEqual({ olderThan: "48h", json: false });
  });
  test("all flags", () => {
    expect(parseOutboxArchiveArgs(["--older-than", "1h", "--team", "t", "--team-dir", "/x", "--json"])).toEqual({
      olderThan: "1h",
      team: "t",
      teamDir: "/x",
      json: true,
    });
  });
  test("unknown flag rejected", () => {
    expect(() => parseOutboxArchiveArgs(["--frobnicate"])).toThrow(UsageError);
  });
  test("missing flag value rejected", () => {
    expect(() => parseOutboxArchiveArgs(["--older-than"])).toThrow(UsageError);
  });
  test("positional rejected", () => {
    expect(() => parseOutboxArchiveArgs(["bogus"])).toThrow(UsageError);
  });
});

describe("OQ1 precedence", () => {
  test("`outbox archive` routes to archive flow, never the reader", async () => {
    // No team.json staged: the read path would ConfigError; the
    // archive path no-ops 0 on the missing lead-outbox.md.
    const { root } = await stageOutbox("# will be deleted", Date.now());
    await rm(join(root, ".atmux", "lead-outbox.md"));
    const { out, result } = await captureStdout(() => outbox(["archive", "--team-dir", root]));
    expect(result).toBe(0);
    expect(out).toMatch(/nothing older than 48h/);
  });
  test("other positionals still rejected (no behavior change)", async () => {
    const { root } = await stageOutbox("# placeholder");
    await expect(outbox(["bogus", "--team-dir", root])).rejects.toThrow(/unknown arg/);
  });
});

describe("outboxArchive", () => {
  test("moves old entry, keeps header; json shape", async () => {
    const mtime = Date.now() - 72 * 3_600_000;
    const [h, m] = mytClock(mtime);
    const { atmuxDir } = await stageOutbox(`# Lead Outbox\n\n## Open\n${entry(h, m, "m1", "old reply")}\n`, mtime);
    const cap = capture();
    const code = await outboxArchive(["--team-dir", join(atmuxDir, ".."), "--json"], cap);
    expect(code).toBe(0);
    const payload = JSON.parse(cap.out()) as {
      path: string;
      olderThan: string;
      entriesArchived: number;
      archivePath: string | null;
    };
    expect(payload.path).toBe(join(atmuxDir, "lead-outbox.md"));
    expect(payload.olderThan).toBe("48h");
    expect(payload.entriesArchived).toBe(1);
    expect(payload.archivePath).not.toBeNull();
    const live = await readFile(join(atmuxDir, "lead-outbox.md"), "utf8");
    expect(live).toContain("# Lead Outbox");
    expect(live).not.toContain("old reply");
    const archived = await readFile(payload.archivePath as string, "utf8");
    expect(archived).toContain("old reply");
  });

  test("recent entry stays live; human no-op message", async () => {
    const now = Date.now();
    const [h, m] = mytClock(now);
    const mm = m >= 5 ? m - 5 : m;
    const { root, atmuxDir } = await stageOutbox(`# Lead Outbox\n\n## Open\n${entry(h, mm, "m1", "fresh reply")}\n`, now);
    const cap = capture();
    const code = await outboxArchive(["--team-dir", root], cap);
    expect(code).toBe(0);
    expect(cap.out()).toMatch(/nothing older than 48h/);
    const live = await readFile(join(atmuxDir, "lead-outbox.md"), "utf8");
    expect(live).toContain("fresh reply");
  });

  test("missing file no-ops 0", async () => {
    const { root } = await stageOutbox("# placeholder");
    await rm(join(root, ".atmux", "lead-outbox.md"));
    const cap = capture();
    expect(await outboxArchive(["--team-dir", root], cap)).toBe(0);
    expect(cap.out()).toMatch(/nothing older/);
  });

  test("bad --older-than surfaces helper UsageError", async () => {
    const { root } = await stageOutbox("# placeholder");
    const cap = capture();
    await expect(outboxArchive(["--team-dir", root, "--older-than", "48"], cap)).rejects.toThrow(UsageError);
  });

  test("--team unknown name → ConfigError", async () => {
    const { root } = await stageOutbox("# placeholder");
    process.env.ATMUX_COCKPIT_CONFIG = join(root, "missing-cockpit.json");
    const cap = capture();
    await expect(outboxArchive(["--team", "no-such-team-zzz"], cap)).rejects.toThrow(ConfigError);
  });

  test("--team resolves via cockpit-walk to target root", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-outbox-archive-team-"));
    dirs.push(scratch);
    const targetRoot = join(scratch, "t1");
    await mkdir(join(targetRoot, ".atmux"), { recursive: true });
    const mtime = Date.now() - 72 * 3_600_000;
    const [h, m] = mytClock(mtime);
    const outboxPath = join(targetRoot, ".atmux", "lead-outbox.md");
    await writeFile(outboxPath, `# Lead Outbox\n\n## Open\n${entry(h, m, "m1", "team reply")}\n`);
    await utimes(outboxPath, new Date(mtime), new Date(mtime));
    const cfg = join(scratch, "cockpit.json");
    await writeFile(cfg, JSON.stringify({ schemaVersion: 1, sessions: [{ type: "team", name: "t1", root: targetRoot, enabled: true }] }));
    process.env.ATMUX_COCKPIT_CONFIG = cfg;
    const cap = capture();
    expect(await outboxArchive(["--team", "t1", "--json"], cap)).toBe(0);
    const payload = JSON.parse(cap.out()) as { entriesArchived: number };
    expect(payload.entriesArchived).toBe(1);
    expect(await readFile(outboxPath, "utf8")).not.toContain("team reply");
  });
});
