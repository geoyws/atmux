import { describe, expect, test } from "bun:test";
import {
  type CockpitScaffoldFs,
  probePrereqs,
  scaffoldCockpit,
} from "../../../src/core/wizard-prereq.ts";

function memoryFs(initial: string | null = null): CockpitScaffoldFs & {
  contents: string | null;
  mkdirCalls: string[];
  writes: number;
} {
  return {
    cockpitPath: "/home/test/.atmux/cockpit.json",
    contents: initial,
    mkdirCalls: [],
    writes: 0,
    async readFile() {
      return this.contents;
    },
    async mkdir(path) {
      this.mkdirCalls.push(path);
    },
    async writeFile(_path, contents) {
      this.contents = contents;
      this.writes += 1;
    },
  };
}

function parsed(fs: { contents: string | null }): Record<string, unknown> {
  if (fs.contents === null) throw new Error("expected cockpit contents");
  return JSON.parse(fs.contents) as Record<string, unknown>;
}

describe("probePrereqs", () => {
  test("reports no missing prerequisites when every binary is present", () => {
    expect(probePrereqs(() => true, "darwin").missing).toEqual([]);
  });

  test("returns Homebrew hints for missing macOS binaries", () => {
    const result = probePrereqs((bin) => bin !== "bun" && bin !== "sqlite3", "darwin");

    expect(result.missing).toEqual([
      { bin: "bun", hint: "brew install oven-sh/bun/bun" },
      { bin: "sqlite3", hint: "brew install sqlite" },
    ]);
  });

  test("returns apt hints for missing Linux binaries", () => {
    const result = probePrereqs((bin) => bin !== "tmux" && bin !== "jq", "linux");

    expect(result.missing).toEqual([
      { bin: "tmux", hint: "sudo apt install tmux" },
      { bin: "jq", hint: "sudo apt install jq" },
    ]);
  });
});

describe("scaffoldCockpit", () => {
  test("creates a minimal cockpit containing the project when absent", async () => {
    const fs = memoryFs();

    const result = await scaffoldCockpit(fs, "/work/atlas");

    expect(result.changed).toBe(true);
    expect(fs.mkdirCalls).toEqual(["/home/test/.atmux"]);
    expect(parsed(fs)).toEqual({
      schemaVersion: 1,
      cockpitSession: "atx",
      sessions: [
        {
          type: "team",
          name: "atlas",
          enabled: true,
          root: "/work/atlas",
          sessions: [],
        },
      ],
    });
  });

  test("adds a project idempotently", async () => {
    const fs = memoryFs('{"schemaVersion":1,"cockpitSession":"atx","sessions":[]}\n');

    expect((await scaffoldCockpit(fs, "/work/atlas")).changed).toBe(true);
    expect((await scaffoldCockpit(fs, "/work/atlas")).changed).toBe(false);

    const cockpit = parsed(fs) as { sessions: unknown[] };
    expect(cockpit.sessions).toEqual([
      {
        type: "team",
        name: "atlas",
        enabled: true,
        root: "/work/atlas",
        sessions: [],
      },
    ]);
    expect(fs.writes).toBe(1);
  });

  test("leaves an existing project entry untouched", async () => {
    const original = `${JSON.stringify(
      {
        schemaVersion: 1,
        cockpitSession: "custom",
        custom: { retained: true },
        sessions: [
          {
            type: "group",
            name: "projects",
            enabled: true,
            sessions: [
              {
                type: "team",
                name: "operator-name",
                enabled: false,
                root: "/work/atlas",
                sessions: [{ type: "medic", name: "nested", enabled: true }],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`;
    const fs = memoryFs(original);

    const result = await scaffoldCockpit(fs, "/work/atlas/");

    expect(result.changed).toBe(false);
    expect(fs.contents).toBe(original);
    expect(fs.writes).toBe(0);
  });
});
