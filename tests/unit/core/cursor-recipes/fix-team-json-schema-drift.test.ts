// Unit tests for src/core/cursor-recipes/fix-team-json-schema-drift.ts
// (ADR-055 §D4 first recipe).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixTeamJsonSchemaDriftRecipe } from "../../../../src/core/cursor-recipes/fix-team-json-schema-drift.ts";
import type { WhipTickContextForRecipe } from "../../../../src/core/cursor-recipes/types.ts";

let atmuxDir: string;
let projectCwd: string;

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "atmux-r1-"));
  projectCwd = tmp;
  atmuxDir = join(tmp, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(projectCwd, { recursive: true, force: true }).catch(() => {});
});

const ctx = (): WhipTickContextForRecipe => ({
  atmuxDir,
  projectCwd,
  nowSec: 1_700_000_000,
  teamName: "atmux",
});

const writeTeamJson = async (content: string): Promise<void> => {
  await writeFile(join(atmuxDir, "team.json"), content);
};

describe("fixTeamJsonSchemaDriftRecipe — recipe shape", () => {
  test("has the expected canonical id + tokenCap + fileAllowlist", () => {
    expect(fixTeamJsonSchemaDriftRecipe.id).toBe("fix:team-json-schema-drift");
    expect(fixTeamJsonSchemaDriftRecipe.tokenCap).toBe(5_000);
    expect(fixTeamJsonSchemaDriftRecipe.fileAllowlist).toEqual(["team.json"]);
  });
});

describe("fixTeamJsonSchemaDriftRecipe.detect", () => {
  test("missing team.json → null (recipe doesn't apply)", async () => {
    const r = await fixTeamJsonSchemaDriftRecipe.detect(ctx());
    expect(r).toBeNull();
  });

  test("malformed JSON → null (catastrophic — different recipe)", async () => {
    await writeTeamJson("not valid {");
    const r = await fixTeamJsonSchemaDriftRecipe.detect(ctx());
    expect(r).toBeNull();
  });

  test("valid Team schema → null (no drift)", async () => {
    await writeTeamJson(JSON.stringify({ name: "atmux", members: [{ name: "alpha" }] }));
    const r = await fixTeamJsonSchemaDriftRecipe.detect(ctx());
    expect(r).toBeNull();
  });

  test("schema drift (whip.staleMin string instead of number) → recipe context with issues", async () => {
    await writeTeamJson(
      JSON.stringify({
        name: "atmux",
        members: [{ name: "alpha" }],
        whip: { staleMin: "garbage" },
      }),
    );
    const r = await fixTeamJsonSchemaDriftRecipe.detect(ctx());
    expect(r).not.toBeNull();
    const dctx = r as { issues: ReadonlyArray<unknown>; allowedPaths: ReadonlyArray<string>; teamJsonBefore: string };
    expect(dctx.issues.length).toBeGreaterThan(0);
    expect(dctx.allowedPaths).toContain("whip");
    expect(dctx.teamJsonBefore).toContain("garbage");
  });
});

describe("fixTeamJsonSchemaDriftRecipe.propose", () => {
  test("composes prompt with issue list + canonical hard constraints", async () => {
    await writeTeamJson(
      JSON.stringify({
        name: "atmux",
        members: [{ name: "alpha" }],
        whip: { staleMin: "garbage" },
      }),
    );
    const detected = await fixTeamJsonSchemaDriftRecipe.detect(ctx());
    expect(detected).not.toBeNull();
    const job = await fixTeamJsonSchemaDriftRecipe.propose(detected as object, ctx());
    expect(job.prompt).toContain("schema drift");
    expect(job.prompt).toContain("ADR-054");
    expect(job.prompt).toContain("ONLY modify `team.json`");
    expect(job.prompt).toContain("Do NOT modify `members[]`");
    expect(job.fileAllowlist).toEqual(["team.json"]);
    expect(job.tokenCap).toBe(5_000);
    expect(job.cwd).toBe(projectCwd);
  });
});

describe("fixTeamJsonSchemaDriftRecipe.verify", () => {
  test("clean post-cursor team.json + members[] preserved → ok", async () => {
    await writeTeamJson(
      JSON.stringify(
        {
          name: "atmux",
          members: [{ name: "alpha" }],
          whip: { staleMin: 120 }, // valid number now (assume cursor fixed it)
        },
        null,
        2,
      ),
    );
    const r = await fixTeamJsonSchemaDriftRecipe.verify(
      { prompt: "", fileAllowlist: ["team.json"], tokenCap: 5_000, cwd: projectCwd },
      { diff: "@@ ...", files: ["team.json"] },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.patchSummary).toContain("clean");
  });

  test("non-allowlisted file in patch → reasons include violation", async () => {
    await writeTeamJson(JSON.stringify({ name: "atmux", members: [] }));
    const r = await fixTeamJsonSchemaDriftRecipe.verify(
      { prompt: "", fileAllowlist: ["team.json"], tokenCap: 5_000, cwd: projectCwd },
      { diff: "", files: ["team.json", "lib/whip.sh"] },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.includes("non-allowlisted file: lib/whip.sh"))).toBe(true);
  });

  test("malformed JSON post-cursor → reasons include parse error", async () => {
    await writeTeamJson("not json{");
    const r = await fixTeamJsonSchemaDriftRecipe.verify(
      { prompt: "", fileAllowlist: ["team.json"], tokenCap: 5_000, cwd: projectCwd },
      { diff: "", files: ["team.json"] },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.includes("invalid JSON post-cursor"))).toBe(true);
  });

  test("missing team.json post-cursor → reasons include 'missing'", async () => {
    // Don't write any team.json.
    const r = await fixTeamJsonSchemaDriftRecipe.verify(
      { prompt: "", fileAllowlist: ["team.json"], tokenCap: 5_000, cwd: projectCwd },
      { diff: "", files: ["team.json"] },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.includes("missing post-cursor"))).toBe(true);
  });

  test("residual schema drift post-cursor → reasons include drift count", async () => {
    await writeTeamJson(JSON.stringify({ name: "atmux", members: "not-array" }));
    const r = await fixTeamJsonSchemaDriftRecipe.verify(
      { prompt: "", fileAllowlist: ["team.json"], tokenCap: 5_000, cwd: projectCwd },
      { diff: "", files: ["team.json"] },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.includes("still drift-failing post-cursor"))).toBe(true);
  });

  // members[] preservation check is exercised via the residual-drift
  // test above — TeamWhip schema rejects non-array members, so an
  // attempt to mutate members[] into a non-array surfaces as drift.
});
