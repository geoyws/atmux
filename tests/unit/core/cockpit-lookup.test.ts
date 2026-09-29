// Unit tests for lookupTeamAtmuxDir (ADR-150 §D5, e-41 T2).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCockpit, lookupTeamAtmuxDir } from "../../../src/core/cockpit.ts";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "atmux-cockpit-lookup-"));
  await mkdir(join(homeDir, ".atmux"), { recursive: true });
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

async function loadRoster(body: unknown) {
  await writeFile(join(homeDir, ".atmux", "cockpit.json"), JSON.stringify(body), "utf8");
  return loadCockpit({ home: homeDir, warn: () => {} });
}

describe("lookupTeamAtmuxDir", () => {
  test("single match resolves to <root>/.atmux", async () => {
    const cockpit = await loadRoster({
      sessions: [
        { type: "team", name: "team-a", root: "/p/a" },
        { type: "team", name: "team-b", root: "/p/b" },
      ],
    });
    expect(lookupTeamAtmuxDir(cockpit, "team-b")).toEqual({ atmuxDir: join("/p/b", ".atmux") });
  });

  test("unknown name returns not-found", async () => {
    const cockpit = await loadRoster({
      sessions: [{ type: "team", name: "team-a", root: "/p/a" }],
    });
    expect(lookupTeamAtmuxDir(cockpit, "team-zz")).toEqual({ error: "not-found" });
  });

  test("duplicate names return ambiguous with the match count", async () => {
    const cockpit = await loadRoster({
      sessions: [
        { type: "team", name: "dup", root: "/p/1" },
        { type: "team", name: "dup", root: "/p/2" },
      ],
    });
    expect(lookupTeamAtmuxDir(cockpit, "dup")).toEqual({ error: "ambiguous", matches: 2 });
  });

  test("nested team inside a group still matches", async () => {
    const cockpit = await loadRoster({
      sessions: [
        {
          type: "group",
          name: "g",
          sessions: [{ type: "team", name: "nested", root: "/p/n" }],
        },
      ],
    });
    expect(lookupTeamAtmuxDir(cockpit, "nested")).toEqual({ atmuxDir: join("/p/n", ".atmux") });
  });

  test("disabled team reads as not-found", async () => {
    const cockpit = await loadRoster({
      sessions: [{ type: "team", name: "old", root: "/p/old", enabled: false }],
    });
    expect(lookupTeamAtmuxDir(cockpit, "old")).toEqual({ error: "not-found" });
  });
});
