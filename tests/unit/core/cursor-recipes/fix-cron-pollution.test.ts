// Unit tests for src/core/cursor-recipes/fix-cron-pollution.ts (ADR-055
// §D4 second recipe + R1-T8 part 5).
//
// Covers detect/propose/verify across:
//   - happy path: clean crontab → null
//   - no crontab → null (errno 1 from `crontab -l`)
//   - duplicate start markers → reasons reported
//   - duplicate end markers → reasons reported
//   - mismatched markers (start without end / end without start) → reasons
//   - lines outside markers referencing project path → reasons
//   - propose prompt shape (canonical block embedded, allowlist empty)
//   - verify allowlist enforcement (empty allowlist rejects any patch)
//   - verify re-detect path (post-cursor crontab still malformed → reasons)

import { describe, expect, test } from "bun:test";
import {
  type CronPollutionContext,
  type CronPollutionDeps,
  makeFixCronPollutionRecipe,
} from "../../../../src/core/cursor-recipes/fix-cron-pollution.ts";
import type {
  GitPatch,
  WhipTickContextForRecipe,
} from "../../../../src/core/cursor-recipes/types.ts";

// ---------- Fixtures ----------

const TEAM = "atmux";
const PROJECT_CWD = "/tmp/atmux-test-project";
const ATMUX_DIR = `${PROJECT_CWD}/.atmux`;
const ATMUX_BIN = "/usr/local/bin/atmux";

function whipCtx(overrides: Partial<WhipTickContextForRecipe> = {}): WhipTickContextForRecipe {
  return {
    atmuxDir: ATMUX_DIR,
    projectCwd: PROJECT_CWD,
    nowSec: 1_700_000_000,
    teamName: TEAM,
    ...overrides,
  };
}

function makeRecipe(cronText: string | null, extraDeps: Partial<CronPollutionDeps> = {}) {
  const deps: CronPollutionDeps = {
    readCrontab: async () => cronText,
    atmuxBin: ATMUX_BIN,
    ...extraDeps,
  };
  return makeFixCronPollutionRecipe(deps);
}

const CLEAN_BLOCK = (team: string, projectPath: string) =>
  `# >>> atmux:team=${team} — managed by atmux start; do not edit by hand
*/5 * * * * ATMUX_DIR=${projectPath}/.atmux ${ATMUX_BIN} whip >> ${projectPath}/.atmux/logs/whip.log 2>&1
# <<< atmux:team=${team}`;

// ---------- detect ----------

describe("fix:cron-pollution detect", () => {
  test("null crontab → null context (no crontab installed)", async () => {
    const recipe = makeRecipe(null);
    const ctx = await recipe.detect(whipCtx());
    expect(ctx).toBeNull();
  });

  test("clean crontab matching this team → null context", async () => {
    const cron = `${CLEAN_BLOCK(TEAM, PROJECT_CWD)}\n`;
    const recipe = makeRecipe(cron);
    const ctx = await recipe.detect(whipCtx());
    expect(ctx).toBeNull();
  });

  test("empty crontab (no atmux block at all) → null context", async () => {
    const recipe = makeRecipe("");
    const ctx = await recipe.detect(whipCtx());
    expect(ctx).toBeNull();
  });

  test("crontab with another team's block but not ours → null", async () => {
    const otherTeam = `# >>> atmux:team=other — managed by atmux start; do not edit by hand
*/5 * * * * ATMUX_DIR=/tmp/other/.atmux ${ATMUX_BIN} whip
# <<< atmux:team=other`;
    const recipe = makeRecipe(otherTeam);
    const ctx = await recipe.detect(whipCtx());
    expect(ctx).toBeNull();
  });

  test("duplicate start markers → reason reported", async () => {
    const cron = `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
*/5 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} whip
# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
*/5 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} whip
# <<< atmux:team=${TEAM}`;
    const recipe = makeRecipe(cron);
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext | null;
    expect(ctx).not.toBeNull();
    expect(ctx?.reasons.some((r) => r.includes("duplicate start marker"))).toBe(true);
  });

  test("duplicate end markers → reason reported", async () => {
    const cron = `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
*/5 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} whip
# <<< atmux:team=${TEAM}
# <<< atmux:team=${TEAM}`;
    const recipe = makeRecipe(cron);
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext | null;
    expect(ctx?.reasons.some((r) => r.includes("duplicate end marker"))).toBe(true);
  });

  test("start without matching end marker → reason", async () => {
    const cron = `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
*/5 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} whip`;
    const recipe = makeRecipe(cron);
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext | null;
    expect(ctx).not.toBeNull();
    expect(ctx?.reasons.some((r) => r.includes("start marker without matching end"))).toBe(true);
  });

  test("end without matching start marker → reason", async () => {
    const cron = `*/5 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} whip
# <<< atmux:team=${TEAM}`;
    const recipe = makeRecipe(cron);
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext | null;
    expect(ctx).not.toBeNull();
    expect(ctx?.reasons.some((r) => r.includes("end marker without matching start"))).toBe(true);
  });

  test("lines outside markers referencing project path → reason", async () => {
    const cron = `# stale line referencing this project (operator never cleaned up)
*/5 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} whip-resume-check
${CLEAN_BLOCK(TEAM, PROJECT_CWD)}`;
    const recipe = makeRecipe(cron);
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext | null;
    expect(ctx).not.toBeNull();
    expect(
      ctx?.reasons.some((r) =>
        r.includes("line(s) outside markers reference this team's project path"),
      ),
    ).toBe(true);
  });

  test("emits canonical block built via injected renderer", async () => {
    const cron = `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
*/5 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} whip
# <<< atmux:team=${TEAM}
# <<< atmux:team=${TEAM}`; // duplicate end → triggers detect
    const recipe = makeRecipe(cron, {
      renderCanonical: () => "<<<INJECTED CANONICAL>>>",
    });
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext | null;
    expect(ctx?.canonicalBlock).toBe("<<<INJECTED CANONICAL>>>");
  });

  test("default canonical includes whip 5min line + team marker", async () => {
    const cron = `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
*/5 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} whip
# <<< atmux:team=${TEAM}
# <<< atmux:team=${TEAM}`;
    const recipe = makeRecipe(cron);
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext | null;
    expect(ctx?.canonicalBlock).toContain("# >>> atmux:team=atmux");
    expect(ctx?.canonicalBlock).toContain("*/5 * * * *");
    expect(ctx?.canonicalBlock).toContain("# <<< atmux:team=atmux");
  });

  test("malformedBlock captures the team's bracketed text", async () => {
    const cron = `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
*/5 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} whip
*/30 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} report
# <<< atmux:team=${TEAM}
# <<< atmux:team=${TEAM}`;
    const recipe = makeRecipe(cron);
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext | null;
    expect(ctx?.malformedBlock).toContain("# >>> atmux:team=atmux");
    expect(ctx?.malformedBlock).toContain("*/5 * * * *");
    expect(ctx?.malformedBlock).toContain("*/30 * * * *");
  });

  test("tmuxTmpdir DI propagates to canonical render", async () => {
    const cron = `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
*/5 * * * * ATMUX_DIR=${ATMUX_DIR} ${ATMUX_BIN} whip
# <<< atmux:team=${TEAM}
# <<< atmux:team=${TEAM}`;
    const recipe = makeRecipe(cron, { tmuxTmpdir: "/tmp/cage" });
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext | null;
    expect(ctx?.canonicalBlock).toContain("TMUX_TMPDIR=/tmp/cage");
  });
});

// ---------- propose ----------

describe("fix:cron-pollution propose", () => {
  test("returns CursorJob with empty allowlist + 5k token cap", async () => {
    const recipe =
      makeRecipe(`# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
# <<< atmux:team=${TEAM}
# <<< atmux:team=${TEAM}`);
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext;
    const job = await recipe.propose(ctx, whipCtx());
    expect(job.fileAllowlist).toEqual([]);
    expect(job.tokenCap).toBe(5_000);
    expect(job.cwd).toBe(PROJECT_CWD);
    expect(job.prompt).toContain("MALFORMED BLOCK");
    expect(job.prompt).toContain("CANONICAL BLOCK");
    expect(job.prompt).toContain("fileAllowlist is empty");
    // Embeds the recipe context's reasons inline.
    expect(job.prompt).toContain("REASONS the existing block is malformed");
  });

  test("prompt includes all detect reasons as bullets", async () => {
    const ctx: CronPollutionContext = {
      malformedBlock: "<malformed>",
      canonicalBlock: "<canonical>",
      reasons: ["duplicate start marker (2 found)", "extra outside line"],
    };
    const recipe = makeRecipe(null);
    const job = await recipe.propose(ctx, whipCtx());
    expect(job.prompt).toContain("- duplicate start marker (2 found)");
    expect(job.prompt).toContain("- extra outside line");
  });
});

// ---------- verify ----------

describe("fix:cron-pollution verify", () => {
  const EMPTY_PATCH: GitPatch = { diff: "", files: [] };
  const TOUCHED_PATCH: GitPatch = {
    diff: "diff --git a/team.json b/team.json\n",
    files: ["team.json"],
  };

  test("empty patch + cron now clean → ok with positive summary", async () => {
    let listenIdx = 0;
    const recipe = makeRecipe(null, {
      readCrontab: async () => {
        listenIdx += 1;
        return listenIdx === 1
          ? // detect call
            `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
# <<< atmux:team=${TEAM}
# <<< atmux:team=${TEAM}`
          : // verify call sees clean crontab
            CLEAN_BLOCK(TEAM, PROJECT_CWD);
      },
    });
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext;
    const job = await recipe.propose(ctx, whipCtx());
    const v = await recipe.verify(job, EMPTY_PATCH, whipCtx());
    expect(v.ok).toBe(true);
    expect(v.patchSummary).toContain("pollution cleared");
  });

  test("empty patch + cron still malformed → ok=true (allowlist) but reviewer-staged summary", async () => {
    const malformed = `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
# <<< atmux:team=${TEAM}
# <<< atmux:team=${TEAM}`;
    const recipe = makeRecipe(malformed);
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext;
    const job = await recipe.propose(ctx, whipCtx());
    const v = await recipe.verify(job, EMPTY_PATCH, whipCtx());
    // Allowlist clean → ok, but summary reflects "still malformed".
    expect(v.ok).toBe(true);
    expect(v.patchSummary).toContain("still malformed");
    expect(v.patchSummary).toContain("staged for reviewer");
  });

  test("non-empty patch → allowlist violation; ok=false", async () => {
    const malformed = `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
# <<< atmux:team=${TEAM}
# <<< atmux:team=${TEAM}`;
    const recipe = makeRecipe(malformed);
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext;
    const job = await recipe.propose(ctx, whipCtx());
    const v = await recipe.verify(job, TOUCHED_PATCH, whipCtx());
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain("patch touched 1 file");
    expect(v.reasons[0]).toContain("recipe allowlist is empty");
  });

  test("crontab disappeared post-cursor (errno 1) → graceful summary", async () => {
    let firstCall = true;
    const recipe = makeRecipe(null, {
      readCrontab: async () => {
        if (firstCall) {
          firstCall = false;
          return `# >>> atmux:team=${TEAM} — managed by atmux start; do not edit by hand
# <<< atmux:team=${TEAM}
# <<< atmux:team=${TEAM}`;
        }
        return null;
      },
    });
    const ctx = (await recipe.detect(whipCtx())) as CronPollutionContext;
    const job = await recipe.propose(ctx, whipCtx());
    const v = await recipe.verify(job, EMPTY_PATCH, whipCtx());
    expect(v.ok).toBe(true);
    expect(v.patchSummary).toContain("no crontab found");
  });
});

// ---------- registry export ----------

describe("fix:cron-pollution module exports", () => {
  test("default export is a CursorRecipe with the canonical id", async () => {
    const { fixCronPollutionRecipe } = await import(
      "../../../../src/core/cursor-recipes/fix-cron-pollution.ts"
    );
    expect(fixCronPollutionRecipe.id).toBe("fix:cron-pollution");
    expect(fixCronPollutionRecipe.tokenCap).toBe(5_000);
    expect(fixCronPollutionRecipe.fileAllowlist).toEqual([]);
  });
});
