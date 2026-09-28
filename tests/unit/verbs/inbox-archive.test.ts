// e-77 T2 — `atmux inbox archive` verb over the T1 helper.
// Wiring only: cut math is covered by inbox-outbox-archive.test.ts.
// Fixtures use real temp dirs + real mtimes (utimes-pinned); the verb
// itself takes no clock seam, so old/recent are wall-clock anchored.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  inbox,
  inboxArchive,
  parseInboxArchiveArgs,
  parseInboxArgs,
} from "../../../src/verbs/inbox.ts";

const dirs: string[] = [];
let origCockpitConfig: string | undefined;
// beforeEach (not afterEach): capture the ambient value BEFORE any
// test overwrites it, so restore always returns to ambient.
beforeEach(() => {
  origCockpitConfig = process.env.ATMUX_COCKPIT_CONFIG;
});
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  if (origCockpitConfig === undefined) delete process.env.ATMUX_COCKPIT_CONFIG;
  else process.env.ATMUX_COCKPIT_CONFIG = origCockpitConfig;
});

async function stageInbox(body: string, mtimeMs?: number): Promise<{ root: string; atmuxDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "atmux-inbox-archive-"));
  dirs.push(root);
  const atmuxDir = join(root, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  const p = join(atmuxDir, "driver-inbox.md");
  await writeFile(p, body);
  if (mtimeMs !== undefined) await utimes(p, new Date(mtimeMs), new Date(mtimeMs));
  return { root, atmuxDir };
}

/** MYT clock (HH, MM) of an epoch-ms — mirrors the helper's anchoring. */
function mytClock(ms: number): [number, number] {
  const d = new Date(ms + 8 * 3_600_000);
  return [d.getUTCHours(), d.getUTCMinutes()];
}

function marker(h: number, m: number): string {
  return `[${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} MYT]`;
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
    // evaluates `out` (empty) before fn() runs (found 2026-09-28: every
    // capture returned "").
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

describe("parseInboxArchiveArgs", () => {
  test("defaults to 48h, non-json", () => {
    expect(parseInboxArchiveArgs([])).toEqual({ olderThan: "48h", json: false });
  });
  test("all flags", () => {
    expect(parseInboxArchiveArgs(["--older-than", "1h", "--team", "t", "--team-dir", "/x", "--json"])).toEqual({
      olderThan: "1h",
      team: "t",
      teamDir: "/x",
      json: true,
    });
  });
  test("unknown flag rejected", () => {
    expect(() => parseInboxArchiveArgs(["--frobnicate"])).toThrow(UsageError);
  });
  test("missing flag value rejected", () => {
    expect(() => parseInboxArchiveArgs(["--older-than"])).toThrow(UsageError);
  });
  test("positional rejected", () => {
    expect(() => parseInboxArchiveArgs(["bogus"])).toThrow(UsageError);
  });
});

describe("OQ1 precedence + conflict gate", () => {
  test("member `archive` refused with subcommand hint", () => {
    expect(() => parseInboxArgs(["archive"])).toThrow(/did you mean `atmux inbox archive`/);
  });
  test("`inbox archive` routes to archive flow, never member lookup", async () => {
    // No team.json staged: the member path would ConfigError; the
    // archive path no-ops 0 on the missing driver-inbox.md.
    const { root } = await stageInbox("# will be deleted", Date.now());
    await rm(join(root, ".atmux", "driver-inbox.md"));
    const { out, result } = await captureStdout(() => inbox(["archive", "--team-dir", root]));
    expect(result).toBe(0);
    expect(out).toMatch(/nothing older than 48h/);
  });
});

describe("inboxArchive", () => {
  test("moves old entry, keeps header; json shape", async () => {
    const mtime = Date.now() - 72 * 3_600_000;
    const [h, m] = mytClock(mtime);
    const { atmuxDir } = await stageInbox(`# driver inbox\n\n## ${marker(h, m)} — old note\nbody line\n`, mtime);
    const cap = capture();
    const code = await inboxArchive(["--team-dir", join(atmuxDir, ".."), "--json"], cap);
    expect(code).toBe(0);
    const payload = JSON.parse(cap.out()) as {
      path: string;
      olderThan: string;
      entriesArchived: number;
      archivePath: string | null;
    };
    expect(payload.olderThan).toBe("48h");
    expect(payload.entriesArchived).toBe(1);
    expect(payload.archivePath).not.toBeNull();
    const live = await readFile(join(atmuxDir, "driver-inbox.md"), "utf8");
    expect(live).toContain("# driver inbox");
    expect(live).not.toContain("old note");
    const archived = await readFile(payload.archivePath as string, "utf8");
    expect(archived).toContain("old note");
  });

  test("recent entry stays live; human no-op message", async () => {
    const now = Date.now();
    const [h, m] = mytClock(now);
    // 5 minutes back on the same clock; at midnight edge reuse the
    // exact clock so at == mtime == now (still recent).
    const mm = m >= 5 ? m - 5 : m;
    const { root, atmuxDir } = await stageInbox(`# driver inbox\n\n## ${marker(h, mm)} — fresh note\n`, now);
    const cap = capture();
    const code = await inboxArchive(["--team-dir", root], cap);
    expect(code).toBe(0);
    expect(cap.out()).toMatch(/nothing older than 48h/);
    const live = await readFile(join(atmuxDir, "driver-inbox.md"), "utf8");
    expect(live).toContain("fresh note");
  });

  test("missing file no-ops 0", async () => {
    const { root } = await stageInbox("# placeholder");
    await rm(join(root, ".atmux", "driver-inbox.md"));
    const cap = capture();
    expect(await inboxArchive(["--team-dir", root], cap)).toBe(0);
    expect(cap.out()).toMatch(/nothing older/);
  });

  test("bad --older-than surfaces helper UsageError", async () => {
    const { root } = await stageInbox("# placeholder");
    const cap = capture();
    await expect(inboxArchive(["--team-dir", root, "--older-than", "48"], cap)).rejects.toThrow(UsageError);
  });

  test("--team unknown name → ConfigError", async () => {
    const { root } = await stageInbox("# placeholder");
    process.env.ATMUX_COCKPIT_CONFIG = join(root, "missing-cockpit.json");
    const cap = capture();
    await expect(inboxArchive(["--team", "no-such-team-zzz"], cap)).rejects.toThrow(ConfigError);
  });

  test("--team resolves via cockpit-walk to target root", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-inbox-archive-team-"));
    dirs.push(scratch);
    const targetRoot = join(scratch, "t1");
    await mkdir(join(targetRoot, ".atmux"), { recursive: true });
    const mtime = Date.now() - 72 * 3_600_000;
    const [h, m] = mytClock(mtime);
    const inboxPath = join(targetRoot, ".atmux", "driver-inbox.md");
    await writeFile(inboxPath, `# driver inbox\n\n## ${marker(h, m)} — team note\n`);
    await utimes(inboxPath, new Date(mtime), new Date(mtime));
    const cfg = join(scratch, "cockpit.json");
    await writeFile(cfg, JSON.stringify({ schemaVersion: 1, sessions: [{ type: "team", name: "t1", root: targetRoot, enabled: true }] }));
    process.env.ATMUX_COCKPIT_CONFIG = cfg;
    const cap = capture();
    expect(await inboxArchive(["--team", "t1", "--json"], cap)).toBe(0);
    const payload = JSON.parse(cap.out()) as { entriesArchived: number };
    expect(payload.entriesArchived).toBe(1);
    expect(await readFile(inboxPath, "utf8")).not.toContain("team note");
  });
});
