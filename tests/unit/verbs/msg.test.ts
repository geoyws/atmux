// Unit tests for src/verbs/msg.ts (ADR-292 `atmux msg`).
//
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../src/abstractions/sqlite.ts";
import { migrations } from "../../../src/abstractions/sqlite-migrations.ts";
import { sendMsg } from "../../../src/core/msg/index.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  coercePriority,
  meetsMin,
  msg,
  PRIORITIES,
  parseMsgReadArgs,
  parseMsgSendArgs,
  resolveMsgReader,
} from "../../../src/verbs/msg.ts";

let teamDir: string;
let atmuxDir: string;
let stdoutBuf: string;
const stdout = (s: string): void => {
  stdoutBuf += s;
};

const seedTeam = async (): Promise<void> => {
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "t",
      members: [
        { name: "driver", emoji: "🗺️", role: "member" },
        { name: "driver-2", emoji: "🚀", role: "member" },
      ],
    }),
  );
};

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-msg-verb-"));
  await seedTeam();
  stdoutBuf = "";
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

const sendArgs = (extra: string[] = []): string[] => ["--team-dir", teamDir, ...extra];
const asDriver2 = { ATMUX_MEMBER: "driver-2" };

// ---------- subverb dispatch ----------

describe("msg()", () => {
  test("unknown subverb → UsageError", async () => {
    await expect(msg(["bogus"], { stdout })).rejects.toBeInstanceOf(UsageError);
  });

  test("bare msg → UsageError", async () => {
    await expect(msg([], { stdout })).rejects.toBeInstanceOf(UsageError);
  });
});

// ---------- parseMsgSendArgs ----------

describe("parseMsgSendArgs", () => {
  test("peer + body, defaults to p2", () => {
    expect(parseMsgSendArgs(["driver-2", "hi", "there"])).toEqual({
      peer: "driver-2",
      priority: "p2",
      body: "hi there",
    });
  });

  test("--priority and --pN shorthands", () => {
    expect(parseMsgSendArgs(["--priority", "p0", "d", "b"]).priority).toBe("p0");
    expect(parseMsgSendArgs(["d", "--p0", "b"]).priority).toBe("p0");
    expect(parseMsgSendArgs(["d", "--p1", "b"]).priority).toBe("p1");
    expect(parseMsgSendArgs(["d", "--p2", "b"]).priority).toBe("p2");
    expect(parseMsgSendArgs(["d", "--p3", "b"]).priority).toBe("p3");
    expect(parseMsgSendArgs(["--as", "driver", "--team-dir", "/x", "d", "b"])).toEqual({
      peer: "d",
      priority: "p2",
      body: "b",
      as: "driver",
      teamDir: "/x",
    });
  });

  test("missing peer / body → UsageError", () => {
    expect(() => parseMsgSendArgs([])).toThrow(UsageError);
    expect(() => parseMsgSendArgs(["driver-2"])).toThrow(UsageError);
  });

  test("bad flags → UsageError", () => {
    expect(() => parseMsgSendArgs(["d", "b", "--bogus"])).toThrow(UsageError);
    expect(() => parseMsgSendArgs(["--priority", "d", "b"])).toThrow(UsageError);
    expect(() => parseMsgSendArgs(["--priority", "p9", "d", "b"])).toThrow(UsageError);
    expect(() => parseMsgSendArgs(["--as"])).toThrow(UsageError);
    expect(() => parseMsgSendArgs(["--team-dir"])).toThrow(UsageError);
  });
});

// ---------- parseMsgReadArgs ----------

describe("parseMsgReadArgs", () => {
  test("defaults", () => {
    expect(parseMsgReadArgs([], "check")).toEqual({
      showAll: false,
      ack: false,
      json: false,
      min: "p3",
    });
  });

  test("every flag parses", () => {
    const parsed = parseMsgReadArgs(
      ["--all", "--ack", "--json", "--min", "p1", "--since", "42", "--as", "d", "--team-dir", "/x"],
      "read",
    );
    expect(parsed).toEqual({
      showAll: true,
      ack: true,
      json: true,
      min: "p1",
      sinceEpoch: 42,
      as: "d",
      teamDir: "/x",
    });
  });

  test("bad flags → UsageError", () => {
    expect(() => parseMsgReadArgs(["--bogus"], "check")).toThrow(UsageError);
    expect(() => parseMsgReadArgs(["--min"], "check")).toThrow(UsageError);
    expect(() => parseMsgReadArgs(["--min", "p9"], "check")).toThrow(UsageError);
    expect(() => parseMsgReadArgs(["--since"], "read")).toThrow(UsageError);
    expect(() => parseMsgReadArgs(["--since", "-1"], "read")).toThrow(UsageError);
    expect(() => parseMsgReadArgs(["--since", "abc"], "read")).toThrow(UsageError);
    expect(() => parseMsgReadArgs(["--as"], "check")).toThrow(UsageError);
    expect(() => parseMsgReadArgs(["--team-dir"], "check")).toThrow(UsageError);
  });
});

// ---------- resolveMsgReader ----------

describe("resolveMsgReader", () => {
  const members = [{ name: "driver-2" }, { name: "driver" }];
  test("--as wins over env", () => {
    expect(resolveMsgReader("driver", { ATMUX_MEMBER: "driver-2" }, members, "check")).toBe(
      "driver",
    );
  });
  test("env fallback", () => {
    expect(resolveMsgReader(undefined, asDriver2, members, "read")).toBe("driver-2");
  });
  test("missing identity → UsageError", () => {
    expect(() => resolveMsgReader(undefined, {}, members, "check")).toThrow(UsageError);
    expect(() => resolveMsgReader(undefined, { ATMUX_MEMBER: "" }, members, "read")).toThrow(
      UsageError,
    );
  });
  test("unknown roster name → ConfigError", () => {
    expect(() => resolveMsgReader("ghost", {}, members, "check")).toThrow(ConfigError);
    expect(() => resolveMsgReader(undefined, { ATMUX_MEMBER: "ghost" }, members, "read")).toThrow(
      ConfigError,
    );
  });
});

// ---------- send ----------

describe("msg send", () => {
  test("prints the peer address + pointer line (snapshot)", async () => {
    const code = await msg(["send", "driver-2", "--p0", "prod deploy wedged", ...sendArgs()], {
      stdout,
      env: { ATMUX_MEMBER: "driver" },
      now: () => 1756858800 * 1000,
    });
    expect(code).toBe(0);
    expect(stdoutBuf).toMatchSnapshot();
  });

  test("unknown peer fails closed", async () => {
    await expect(
      msg(["send", "ghost", "hi", ...sendArgs()], { stdout, env: asDriver2 }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("drivers-only team (ADR-287 default): driver seats are addressable peers and readers", async () => {
    // Regression 2026-09-29: the roster read members[] only, so on a
    // drivers-only team `msg send driver-2` failed with "unknown peer".
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "t",
        members: [],
        drivers: [
          { name: "driver", tui: null, cwd: "." },
          { name: "driver-2", tui: null, cwd: ".atmux/worktrees/driver-2" },
        ],
      }),
    );
    const code = await msg(["send", "driver-2", "--p0", "wedged", ...sendArgs()], {
      stdout,
      env: { ATMUX_MEMBER: "driver" },
    });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("peer=driver-2 window=");
    expect(stdoutBuf).toMatch(/window=\S+:driver-2 priority=p0/);
    stdoutBuf = "";
    expect(await msg(["check", ...sendArgs(), "--as", "driver-2"], { stdout })).toBe(1);
    expect(stdoutBuf).toContain("1 unread p0 from driver");
    await expect(
      msg(["send", "driver-9", "hi", ...sendArgs()], { stdout, env: asDriver2 }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

// ---------- check ----------

describe("msg check", () => {
  test("empty mailbox → exit 0", async () => {
    const code = await msg(["check", ...sendArgs(), "--as", "driver-2"], { stdout });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("nothing unread at or above p3");
  });

  test("one unread → exit 1, single-line shape", async () => {
    await sendMsg(atmuxDir, {
      to: "driver-2",
      sender: "driver",
      body: "wedged",
      priority: "p0",
      ts: 1000,
    });
    const code = await msg(["check", ...sendArgs(), "--as", "driver-2"], { stdout });
    expect(code).toBe(1);
    expect(stdoutBuf).toContain("1 unread p0 from driver");
  });

  test("--min filters below-threshold rows", async () => {
    await sendMsg(atmuxDir, {
      to: "driver-2",
      sender: "driver",
      body: "hot",
      priority: "p0",
      ts: 1000,
    });
    await sendMsg(atmuxDir, {
      to: "driver-2",
      sender: "driver",
      body: "cold",
      priority: "p2",
      ts: 1100,
    });
    const lo = await msg(["check", ...sendArgs(), "--as", "driver-2", "--min", "p1"], { stdout });
    expect(lo).toBe(1);
    expect(stdoutBuf).toContain("1 unread p0");
    stdoutBuf = "";
    const hi = await msg(["check", ...sendArgs(), "--as", "driver-2", "--min", "p3"], { stdout });
    expect(hi).toBe(1);
    expect(stdoutBuf).toContain("2 unread at or above p3:");
    expect(stdoutBuf).toContain("[p0] from driver");
    expect(stdoutBuf).toContain("[p2] from driver");
  });

  test("--min above everything → exit 0", async () => {
    await sendMsg(atmuxDir, {
      to: "driver-2",
      sender: "driver",
      body: "cold",
      priority: "p3",
      ts: 1000,
    });
    const code = await msg(["check", ...sendArgs(), "--as", "driver-2", "--min", "p3"], { stdout });
    expect(code).toBe(1);
    stdoutBuf = "";
    const code2 = await msg(["check", ...sendArgs(), "--as", "driver-2", "--min", "p2"], {
      stdout,
    });
    expect(code2).toBe(0);
    expect(stdoutBuf).toContain("nothing unread at or above p2");
  });

  test("--ack advances the cursor; next check exits 0", async () => {
    await sendMsg(atmuxDir, { to: "driver-2", sender: "driver", body: "one", ts: 1000 });
    const acked = await msg(["check", ...sendArgs(), "--as", "driver-2", "--ack"], { stdout });
    expect(acked).toBe(1);
    stdoutBuf = "";
    const again = await msg(["check", ...sendArgs(), "--as", "driver-2"], { stdout });
    expect(again).toBe(0);
    expect(stdoutBuf).toContain("nothing unread");
  });

  test("--ack on an empty mailbox is a no-op exit 0", async () => {
    const code = await msg(["check", ...sendArgs(), "--as", "driver-2", "--ack", "--json"], {
      stdout,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdoutBuf)).toMatchObject({
      entries: [],
      cursorBefore: null,
      cursorAfter: null,
    });
  });

  test("--since rewinds past the cursor but not past per-row acks", async () => {
    await sendMsg(atmuxDir, { to: "driver-2", sender: "driver", body: "one", ts: 1000 });
    await sendMsg(atmuxDir, { to: "driver-2", sender: "driver", body: "two", ts: 2000 });
    await msg(["check", ...sendArgs(), "--as", "driver-2", "--ack"], { stdout });
    stdoutBuf = "";
    // Rewind: acked rows stay hidden even with --since 0.
    const rewound = await msg(["check", ...sendArgs(), "--as", "driver-2", "--since", "0"], {
      stdout,
    });
    expect(rewound).toBe(0);
    expect(stdoutBuf).toContain("nothing unread");
  });

  test("--all wins over --since", async () => {
    await sendMsg(atmuxDir, { to: "driver-2", sender: "driver", body: "one", ts: 1000 });
    await sendMsg(atmuxDir, { to: "driver-2", sender: "driver", body: "two", ts: 2000 });
    const code = await msg(
      ["check", ...sendArgs(), "--as", "driver-2", "--since", "1500", "--all"],
      { stdout },
    );
    expect(code).toBe(1);
    expect(stdoutBuf).toContain("2 unread");
    stdoutBuf = "";
    const narrowed = await msg(["check", ...sendArgs(), "--as", "driver-2", "--since", "1500"], {
      stdout,
    });
    expect(narrowed).toBe(1);
    expect(stdoutBuf).toContain("1 unread p2");
  });

  test("--json carries entries + cursorBefore/cursorAfter", async () => {
    await sendMsg(atmuxDir, {
      to: "driver-2",
      sender: "driver",
      body: "one",
      priority: "p1",
      ts: 1000,
    });
    const before = await msg(["check", ...sendArgs(), "--as", "driver-2", "--json"], { stdout });
    expect(before).toBe(1);
    const first = JSON.parse(stdoutBuf);
    expect(first).toMatchObject({
      reader: "driver-2",
      min: "p3",
      cursorBefore: null,
      cursorAfter: null,
    });
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({
      priority: "p1",
      sender: "driver",
      body: "one",
      acked: false,
      ackedAt: null,
    });
    stdoutBuf = "";
    await msg(["check", ...sendArgs(), "--as", "driver-2", "--json", "--ack"], { stdout });
    const second = JSON.parse(stdoutBuf);
    expect(second).toMatchObject({ cursorBefore: null, cursorAfter: 1000 });
    expect(second.entries[0]).toMatchObject({ acked: false });
  });

  test("identity: env fallback works, missing → UsageError, unknown → ConfigError", async () => {
    await sendMsg(atmuxDir, { to: "driver-2", sender: "driver", body: "x", ts: 1 });
    stdoutBuf = "";
    expect(await msg(["check", ...sendArgs()], { stdout, env: asDriver2 })).toBe(1);
    await expect(msg(["check", ...sendArgs()], { stdout, env: {} })).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(msg(["check", ...sendArgs(), "--as", "ghost"], { stdout })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

// ---------- read ----------

describe("msg read", () => {
  test("empty mailbox prints the empty marker", async () => {
    const code = await msg(["read", ...sendArgs(), "--as", "driver-2"], { stdout });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("(no messages)");
  });

  test("full bodies with per-row ack flags", async () => {
    await sendMsg(atmuxDir, {
      to: "driver-2",
      sender: "driver",
      body: "line1\nline2",
      priority: "p0",
      ts: 1000,
    });
    const code = await msg(["read", ...sendArgs(), "--as", "driver-2"], { stdout });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain("msg m-1 [p0] from driver");
    expect(stdoutBuf).toContain("[unread]");
    expect(stdoutBuf).toContain("line1\nline2");
  });

  test("read surfaces [acked] after --ack + rewind; check stays quiet", async () => {
    await sendMsg(atmuxDir, { to: "driver-2", sender: "driver", body: "one", ts: 1000 });
    await msg(["read", ...sendArgs(), "--as", "driver-2", "--ack"], { stdout });
    stdoutBuf = "";
    await msg(["read", ...sendArgs(), "--as", "driver-2", "--since", "0"], { stdout });
    expect(stdoutBuf).toContain("[acked]");
    stdoutBuf = "";
    expect(
      await msg(["check", ...sendArgs(), "--as", "driver-2", "--since", "0"], { stdout }),
    ).toBe(0);
  });

  test("read --json mirrors the check envelope over the since-view", async () => {
    await sendMsg(atmuxDir, { to: "driver-2", sender: "driver", body: "one", ts: 1000 });
    await msg(["read", ...sendArgs(), "--as", "driver-2", "--json"], { stdout });
    const parsed = JSON.parse(stdoutBuf);
    expect(parsed).toMatchObject({ reader: "driver-2", cursorBefore: null, cursorAfter: null });
    expect(parsed.entries).toHaveLength(1);
  });

  test("rows without a stored msg_id fall back to m-<rowid>", async () => {
    const db = openDatabase(join(atmuxDir, "state.db"), migrations);
    try {
      db.query(
        "INSERT INTO inbox_messages (member, msg_id, sender, body, ts, kind, extra) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("driver-2", null, "driver", "raw", 500, "msg", JSON.stringify({ priority: "p1" }));
    } finally {
      closeDatabase(db);
    }
    await msg(["read", ...sendArgs(), "--as", "driver-2"], { stdout });
    expect(stdoutBuf).toContain("msg m-1 [p1]");
  });
});

// ---------- re-exported vocabulary ----------

describe("priority vocabulary re-exports", () => {
  test("shared p0..p3 helpers stay importable from the verb", () => {
    expect(PRIORITIES).toEqual(["p0", "p1", "p2", "p3"]);
    expect(meetsMin("p0", "p3")).toBe(true);
    expect(coercePriority("p2")).toBe("p2");
  });
});
