// Unit tests for src/verbs/team-rename-cockpit.ts (ADR-027 T4).
// Covers syncCockpitRegistry's full surface against synthetic
// ~/.atmux/cockpit.json fixtures under tmpdir: happy / refuse-not-found
// / legacy-lift / non-team carve-out / nested team-in-team / atomic
// write idempotence.
//
// ADR-280 stage 4: the carve-out cases were written against `epic-team`,
// the only non-`team` node that could sit nested under a team. That type
// is retired, so each case now asserts the SAME property against a type
// that still exists — `superdriver` / `medic` for "not a rename target",
// and an ordinary nested `team` for "a child is not renamed with its
// parent". The rule under test is unchanged: only `type: "team"` nodes,
// matched by name, are renamed.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../../src/errors.ts";
import {
  findAndMutateTeamName,
  syncCockpitRegistry,
} from "../../../src/verbs/team-rename-cockpit.ts";

function mkTmpdir(): string {
  return mkdtempSync(join(tmpdir(), "syncCockpit-"));
}
function rmTmpdir(d: string): void {
  rmSync(d, { recursive: true, force: true });
}
async function writeCockpit(path: string, body: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}
async function readCockpit(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

// ---------- syncCockpitRegistry ----------

describe("syncCockpitRegistry", () => {
  test("happy path — find / mutate / atomic-write / undo restores", async () => {
    const dir = mkTmpdir();
    const cockpitPath = join(dir, "cockpit.json");
    try {
      await writeCockpit(cockpitPath, {
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [
          {
            type: "team",
            name: "atmux-kanban",
            root: "/tmp/atmux-kanban",
            enabled: true,
            sessions: [],
          },
          { type: "team", name: "rentx", root: "/tmp/rentx", enabled: true, sessions: [] },
        ],
      });
      const step = await syncCockpitRegistry({
        cockpitPath,
        oldName: "atmux-kanban",
        newName: "atmux",
        newSession: "atmux",
      });
      expect(step.label).toMatch(/cockpit-sync atmux-kanban → atmux/);
      const after = (await readCockpit(cockpitPath)) as { sessions: Array<{ name: string }> };
      expect(after.sessions.map((s) => s.name)).toEqual(["atmux", "rentx"]);
      // undo() restores
      await step.undo();
      const restored = (await readCockpit(cockpitPath)) as {
        sessions: Array<{ name: string }>;
      };
      expect(restored.sessions.map((s) => s.name)).toEqual(["atmux-kanban", "rentx"]);
    } finally {
      rmTmpdir(dir);
    }
  });

  test("refuses with ConfigError when oldName not in cockpit", async () => {
    const dir = mkTmpdir();
    const cockpitPath = join(dir, "cockpit.json");
    try {
      const before = {
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [{ type: "team", name: "foo", root: "/tmp/foo", enabled: true, sessions: [] }],
      };
      await writeCockpit(cockpitPath, before);
      await expect(
        syncCockpitRegistry({ cockpitPath, oldName: "bar", newName: "baz" }),
      ).rejects.toThrow(ConfigError);
      // file unchanged
      const after = await readCockpit(cockpitPath);
      expect(after).toEqual(before);
    } finally {
      rmTmpdir(dir);
    }
  });

  test("legacy flat teams[] shape lifts to sessions[] then renames", async () => {
    const dir = mkTmpdir();
    const cockpitPath = join(dir, "cockpit.json");
    try {
      // pre-ADR-089 shape: no schemaVersion, flat teams[], no sessions[]
      await writeCockpit(cockpitPath, {
        cockpitSession: "atmux_cockpit",
        teams: [{ name: "atmux-kanban", root: "/tmp/atmux-kanban", enabled: true }],
      });
      const warns: string[] = [];
      const step = await syncCockpitRegistry({
        cockpitPath,
        oldName: "atmux-kanban",
        newName: "atmux",
        warn: (m) => warns.push(m),
      });
      expect(step.label).toMatch(/cockpit-sync atmux-kanban → atmux/);
      // legacy-lift warn fired (per migrateLegacyShape stderr line)
      expect(warns.some((w) => /legacy flat teams\[\]/.test(w))).toBe(true);
      const after = (await readCockpit(cockpitPath)) as {
        schemaVersion: number;
        sessions: Array<{ type: string; name: string; root: string }>;
        teams?: unknown;
      };
      expect(after.schemaVersion).toBe(1);
      expect(after.sessions.length).toBe(1);
      expect(after.sessions[0]?.type).toBe("team");
      expect(after.sessions[0]?.name).toBe("atmux");
      expect(after.sessions[0]?.root).toBe("/tmp/atmux-kanban");
      // legacy top-level teams[] stripped by the migration
      expect(after.teams).toBeUndefined();
    } finally {
      rmTmpdir(dir);
    }
  });

  test("a nested child team is NOT renamed when its parent is renamed", async () => {
    const dir = mkTmpdir();
    const cockpitPath = join(dir, "cockpit.json");
    try {
      await writeCockpit(cockpitPath, {
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [
          {
            type: "team",
            name: "parent",
            root: "/tmp/parent",
            enabled: true,
            sessions: [
              {
                type: "team",
                name: "child",
                root: "/tmp/parent/child",
                enabled: true,
                sessions: [],
              },
            ],
          },
        ],
      });
      await syncCockpitRegistry({ cockpitPath, oldName: "parent", newName: "newparent" });
      const after = (await readCockpit(cockpitPath)) as {
        sessions: Array<{
          name: string;
          sessions: Array<{ type: string; name: string; root?: string }>;
        }>;
      };
      expect(after.sessions[0]?.name).toBe("newparent");
      // The rename matches on NAME, so the child is untouched — its own
      // name and root both survive the parent's rename.
      expect(after.sessions[0]?.sessions[0]?.name).toBe("child");
      expect(after.sessions[0]?.sessions[0]?.root).toBe("/tmp/parent/child");
    } finally {
      rmTmpdir(dir);
    }
  });

  test('a non-team node with a matching name refuses (only type:"team" is renamed)', async () => {
    const dir = mkTmpdir();
    const cockpitPath = join(dir, "cockpit.json");
    try {
      await writeCockpit(cockpitPath, {
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [
          {
            type: "team",
            name: "parent",
            root: "/tmp/parent",
            enabled: true,
            sessions: [
              { type: "superdriver", name: "sd-1", enabled: true },
              { type: "medic", name: "medic-1", enabled: true },
            ],
          },
        ],
      });
      await expect(
        syncCockpitRegistry({ cockpitPath, oldName: "sd-1", newName: "sd-2" }),
      ).rejects.toThrow(ConfigError);
      await expect(
        syncCockpitRegistry({ cockpitPath, oldName: "medic-1", newName: "medic-2" }),
      ).rejects.toThrow(ConfigError);
    } finally {
      rmTmpdir(dir);
    }
  });

  test("nested team-in-team renames correctly", async () => {
    const dir = mkTmpdir();
    const cockpitPath = join(dir, "cockpit.json");
    try {
      await writeCockpit(cockpitPath, {
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [
          {
            type: "team",
            name: "outer",
            root: "/tmp/outer",
            enabled: true,
            sessions: [
              { type: "team", name: "inner", root: "/tmp/inner", enabled: true, sessions: [] },
            ],
          },
        ],
      });
      await syncCockpitRegistry({ cockpitPath, oldName: "inner", newName: "inner-renamed" });
      const after = (await readCockpit(cockpitPath)) as {
        sessions: Array<{ name: string; sessions: Array<{ name: string }> }>;
      };
      expect(after.sessions[0]?.name).toBe("outer");
      expect(after.sessions[0]?.sessions[0]?.name).toBe("inner-renamed");
    } finally {
      rmTmpdir(dir);
    }
  });

  test("atomic-write leaves no leftover .tmp file", async () => {
    const dir = mkTmpdir();
    const cockpitPath = join(dir, "cockpit.json");
    try {
      await writeCockpit(cockpitPath, {
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [{ type: "team", name: "foo", root: "/tmp/foo", enabled: true, sessions: [] }],
      });
      await syncCockpitRegistry({ cockpitPath, oldName: "foo", newName: "bar" });
      const entries = readdirSync(dir);
      const tmps = entries.filter((n) => n.includes(".tmp."));
      expect(tmps).toEqual([]);
      expect(existsSync(cockpitPath)).toBe(true);
    } finally {
      rmTmpdir(dir);
    }
  });

  test("undo() refuses with ConfigError when newName diverged externally", async () => {
    const dir = mkTmpdir();
    const cockpitPath = join(dir, "cockpit.json");
    try {
      await writeCockpit(cockpitPath, {
        schemaVersion: 1,
        cockpitSession: "atmux_cockpit",
        sessions: [{ type: "team", name: "foo", root: "/tmp/foo", enabled: true, sessions: [] }],
      });
      const step = await syncCockpitRegistry({ cockpitPath, oldName: "foo", newName: "bar" });
      // External edit: rename 'bar' to 'qux' out-of-band before undo()
      const meddled = (await readCockpit(cockpitPath)) as {
        sessions: Array<{ name: string }>;
      };
      if (meddled.sessions[0] !== undefined) meddled.sessions[0].name = "qux";
      await writeCockpit(cockpitPath, meddled);
      // undo() refuses because 'bar' no longer present
      await expect(step.undo()).rejects.toThrow(ConfigError);
    } finally {
      rmTmpdir(dir);
    }
  });
});

// ---------- findAndMutateTeamName (direct unit) ----------

import type { CockpitSessionT } from "../../../src/schema/cockpit.ts";

describe("findAndMutateTeamName", () => {
  test("returns false on empty input", () => {
    expect(findAndMutateTeamName([], "old", "new")).toBe(false);
  });

  test("mutates a flat team-typed node", () => {
    const nodes: CockpitSessionT[] = [
      { type: "team", name: "old", root: "/tmp/a", enabled: true, sessions: [] },
    ];
    expect(findAndMutateTeamName(nodes, "old", "new")).toBe(true);
    expect((nodes[0] as { name: string }).name).toBe("new");
  });

  test("returns false when no match found", () => {
    const nodes: CockpitSessionT[] = [
      { type: "team", name: "foo", root: "/tmp/foo", enabled: true, sessions: [] },
    ];
    expect(findAndMutateTeamName(nodes, "bar", "baz")).toBe(false);
    expect((nodes[0] as { name: string }).name).toBe("foo");
  });

  test("recurses into nested team's sessions[]", () => {
    const nodes: CockpitSessionT[] = [
      {
        type: "team",
        name: "outer",
        root: "/tmp/outer",
        enabled: true,
        sessions: [
          { type: "team", name: "inner", root: "/tmp/inner", enabled: true, sessions: [] },
        ],
      },
    ];
    expect(findAndMutateTeamName(nodes, "inner", "inner2")).toBe(true);
    expect((nodes[0] as { sessions: Array<{ name: string }> }).sessions[0]?.name).toBe(
      "inner2",
    );
  });

  test("does NOT mutate non-team siblings (only type:team)", () => {
    const nodes: CockpitSessionT[] = [
      { type: "superdriver", name: "sd-1", enabled: true },
      { type: "medic", name: "medic-1", enabled: true },
    ];
    expect(findAndMutateTeamName(nodes, "sd-1", "sd-2")).toBe(false);
    expect(findAndMutateTeamName(nodes, "medic-1", "medic-2")).toBe(false);
    expect((nodes[0] as { name: string }).name).toBe("sd-1");
    expect((nodes[1] as { name: string }).name).toBe("medic-1");
  });

  test("first match wins (short-circuits depth-first walk)", () => {
    const nodes: CockpitSessionT[] = [
      {
        type: "team",
        name: "dup",
        root: "/tmp/a",
        enabled: true,
        sessions: [
          { type: "team", name: "dup", root: "/tmp/b", enabled: true, sessions: [] },
        ],
      },
    ];
    expect(findAndMutateTeamName(nodes, "dup", "new")).toBe(true);
    expect((nodes[0] as { name: string }).name).toBe("new");
    // sibling-nested duplicate (would never pass loader, but the walk is
    // first-hit so the inner duplicate remains as-is)
    expect(
      (nodes[0] as { sessions: Array<{ name: string }> }).sessions[0]?.name,
    ).toBe("dup");
  });

  test("walks past non-matching team-type nodes into their nested sessions[]", () => {
    const nodes: CockpitSessionT[] = [
      {
        type: "team",
        name: "outer1",
        root: "/tmp/o1",
        enabled: true,
        sessions: [],
      },
      {
        type: "team",
        name: "outer2",
        root: "/tmp/o2",
        enabled: true,
        sessions: [
          { type: "team", name: "target", root: "/tmp/t", enabled: true, sessions: [] },
        ],
      },
    ];
    expect(findAndMutateTeamName(nodes, "target", "found")).toBe(true);
    expect(
      (nodes[1] as { sessions: Array<{ name: string }> }).sessions[0]?.name,
    ).toBe("found");
  });
});
