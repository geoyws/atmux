import { describe, expect, test } from "bun:test";
import {
  cronReaper,
  type CronReaperDeps,
  removeCronBlocks,
} from "../../../src/verbs/cron-reaper.ts";

const block = (prefix: "team" | "pulse" | "groom" | "lane-tick" | "poke", team: string) =>
  `# >>> atmux:${prefix}=${team} — managed by atmux\nATMUX_DIR=/work/${team} atmux ${prefix}\n# <<< atmux:${prefix}=${team}\n`;

function fixture(
  crontab: string,
  cockpit: ReadonlyArray<string> = [],
  epicTeams: ReadonlyArray<string> = [],
) {
  const writes: string[] = [];
  const output: string[] = [];
  const deps: CronReaperDeps = {
    readCrontab: () => crontab,
    writeCrontab: (content) => writes.push(content),
    loadCockpitRoster: () => cockpit,
    loadEpicTeamRegistry: () => epicTeams,
    stdout: (text) => output.push(text),
  };
  return { deps, writes, output };
}

describe("cron-reaper", () => {
  test("dry-run lists only orphan blocks in table and JSON shapes", async () => {
    const source = `${block("team", "active")}${block("pulse", "epic-active")}${block("groom", "gone")}`;
    const table = fixture(source, ["active"], ["epic-active"]);

    expect(await cronReaper(["--dry-run"], table.deps)).toBe(0);
    expect(table.writes).toEqual([]);
    expect(table.output.join("")).toContain("STATUS\tPREFIX\tTEAM\tATMUX_DIR\tREMOVED");
    expect(table.output.join("")).toContain("orphan\tgroom\tgone\t/work/gone\tno");
    expect(table.output.join("")).not.toContain("active\t/work/active");

    const json = fixture(source, ["active"], ["epic-active"]);
    await cronReaper(["--json"], json.deps);
    expect(JSON.parse(json.output.join(""))).toEqual({
      dryRun: true,
      entries: [
        {
          prefix: "groom",
          team: "gone",
          atmux_dir: "/work/gone",
          status: "orphan",
          removed: false,
        },
      ],
      removed: 0,
    });
  });

  test("apply removes only positively orphaned blocks across every managed prefix", async () => {
    const manual = "15 * * * * echo keep\n";
    const source = `${manual}${block("team", "active")}${block("pulse", "gone")}${block("groom", "gone")}${block("lane-tick", "gone")}${block("poke", "gone")}`;
    const run = fixture(source, ["active"]);

    await cronReaper(["--apply"], run.deps);

    expect(run.writes).toEqual([`${manual}${block("team", "active")}`]);
    expect(run.output.join("").match(/\tyes\n/g)?.length).toBe(4);
  });

  test("clean apply is an idempotent no-op", async () => {
    const source = block("team", "active");
    const run = fixture(source, ["active"]);

    await cronReaper(["--apply"], run.deps);

    expect(run.writes).toEqual([]);
    expect(run.output).toEqual([]);
  });

  test("an unresolvable roster lists absent blocks as unknown and never removes them", async () => {
    const source = `${block("team", "known-epic")}${block("poke", "maybe-orphan")}`;
    const run = fixture(source, [], ["known-epic"]);
    run.deps.loadCockpitRoster = () => {
      throw new Error("cockpit unavailable");
    };

    await cronReaper(["--apply", "--json"], run.deps);

    expect(run.writes).toEqual([]);
    expect(JSON.parse(run.output.join(""))).toEqual({
      dryRun: false,
      entries: [
        {
          prefix: "poke",
          team: "maybe-orphan",
          atmux_dir: "/work/maybe-orphan",
          status: "unknown",
          removed: false,
        },
      ],
      removed: 0,
    });
  });

  test("removeCronBlocks applies an exact team scope and preserves every other block", async () => {
    const source = `${block("team", "gone")}${block("pulse", "gone")}${block("team", "gone-long")}`;
    const run = fixture(source);

    const result = await removeCronBlocks({ team: "gone" }, run.deps);

    expect(result.removed).toBe(2);
    expect(run.writes).toEqual([block("team", "gone-long")]);
  });
});
