// Unit tests for src/core/cursor-recipes/fix-supervisor-missing.ts
// (ADR-055 §D4 third recipe + R1-T8 part 5).
//
// Covers detect/propose/verify across:
//   - happy path: supervisor present → null
//   - supervisor missing in a real session → context with present windows
//   - sessionName undefined → null (recipe gated on session presence)
//   - tmux unreachable / session missing → null
//   - propose prompt shape (allowlist empty, 1k token cap, present windows)
//   - verify allowlist enforcement (empty allowlist rejects any patch)
//   - verify post-cursor: supervisor present → ok summary; absent → staged summary

import { describe, expect, test } from "bun:test";
import {
  makeFixSupervisorMissingRecipe,
  type SupervisorMissingContext,
  type SupervisorMissingDeps,
} from "../../../../src/core/cursor-recipes/fix-supervisor-missing.ts";
import type {
  GitPatch,
  WhipTickContextForRecipe,
} from "../../../../src/core/cursor-recipes/types.ts";

// ---------- Fixtures ----------

const TEAM = "atmux";
const PROJECT_CWD = "/tmp/atmux-test-project";
const ATMUX_DIR = `${PROJECT_CWD}/.atmux`;
const SESSION = "atmux";

function whipCtx(overrides: Partial<WhipTickContextForRecipe> = {}): WhipTickContextForRecipe {
  return {
    atmuxDir: ATMUX_DIR,
    projectCwd: PROJECT_CWD,
    nowSec: 1_700_000_000,
    teamName: TEAM,
    sessionName: SESSION,
    ...overrides,
  };
}

function makeRecipe(windowsByCall: ReadonlyArray<ReadonlyArray<string> | null>) {
  let i = 0;
  const deps: SupervisorMissingDeps = {
    listWindows: async () => {
      const out = windowsByCall[i] ?? null;
      i += 1;
      return out;
    },
  };
  return makeFixSupervisorMissingRecipe(deps);
}

// ---------- detect ----------

describe("fix:supervisor-missing detect", () => {
  test("supervisor present → null context (no drift)", async () => {
    const recipe = makeRecipe([["lead", "supervisor", "whip-impl"]]);
    const ctx = await recipe.detect(whipCtx());
    expect(ctx).toBeNull();
  });

  test("supervisor absent → context with sessionName + present windows", async () => {
    const recipe = makeRecipe([["lead", "whip-impl", "reviewer"]]);
    const ctx = (await recipe.detect(whipCtx())) as SupervisorMissingContext | null;
    expect(ctx).not.toBeNull();
    expect(ctx?.sessionName).toBe(SESSION);
    expect(ctx?.presentWindows).toEqual(["lead", "whip-impl", "reviewer"]);
  });

  test("undefined sessionName → null (recipe doesn't apply)", async () => {
    const recipe = makeRecipe([["any"]]);
    const ctx = await recipe.detect({
      atmuxDir: ATMUX_DIR,
      projectCwd: PROJECT_CWD,
      nowSec: 1_700_000_000,
      teamName: TEAM,
    });
    expect(ctx).toBeNull();
  });

  test("empty sessionName → null", async () => {
    const recipe = makeRecipe([["any"]]);
    const ctx = await recipe.detect(whipCtx({ sessionName: "" }));
    expect(ctx).toBeNull();
  });

  test("listWindows null (session missing or tmux unreachable) → null", async () => {
    const recipe = makeRecipe([null]);
    const ctx = await recipe.detect(whipCtx());
    expect(ctx).toBeNull();
  });

  test("empty windows list (sentinel for transient race) + supervisor missing → context", async () => {
    const recipe = makeRecipe([[]]);
    const ctx = (await recipe.detect(whipCtx())) as SupervisorMissingContext | null;
    expect(ctx).not.toBeNull();
    expect(ctx?.presentWindows).toEqual([]);
  });
});

// ---------- propose ----------

describe("fix:supervisor-missing propose", () => {
  test("returns CursorJob with empty allowlist + 1k token cap", async () => {
    const recipe = makeRecipe([["lead", "whip-impl"]]);
    const ctx = (await recipe.detect(whipCtx())) as SupervisorMissingContext;
    const job = await recipe.propose(ctx, whipCtx());
    expect(job.fileAllowlist).toEqual([]);
    expect(job.tokenCap).toBe(1_000);
    expect(job.cwd).toBe(PROJECT_CWD);
    expect(job.prompt).toContain("Supervisor window absent");
    expect(job.prompt).toContain(`session \`${SESSION}\``);
    expect(job.prompt).toContain("WINDOWS PRESENT");
    expect(job.prompt).toContain("- lead");
    expect(job.prompt).toContain("- whip-impl");
    expect(job.prompt).toContain("atmux start");
    expect(job.prompt).toContain("fileAllowlist is empty");
  });

  test("zero present windows yields '(no other windows)' fallback in prompt", async () => {
    const recipe = makeRecipe([[]]);
    const ctx = (await recipe.detect(whipCtx())) as SupervisorMissingContext;
    const job = await recipe.propose(ctx, whipCtx());
    expect(job.prompt).toContain("(no other windows)");
  });

  test("teamName interpolated into prompt", async () => {
    const recipe = makeRecipe([["lead"]]);
    const ctx = (await recipe.detect(
      whipCtx({ teamName: "demo-team" }),
    )) as SupervisorMissingContext;
    const job = await recipe.propose(ctx, whipCtx({ teamName: "demo-team" }));
    expect(job.prompt).toContain("`demo-team`");
  });
});

// ---------- verify ----------

describe("fix:supervisor-missing verify", () => {
  const EMPTY_PATCH: GitPatch = { diff: "", files: [] };
  const TOUCHED_PATCH: GitPatch = {
    diff: "diff --git a/team.json b/team.json\n",
    files: ["team.json"],
  };

  test("post-cursor supervisor present → ok summary 'now present'", async () => {
    const recipe = makeRecipe([
      ["lead", "whip-impl"], // detect: missing
      ["lead", "supervisor", "whip-impl"], // verify: present
    ]);
    const ctx = (await recipe.detect(whipCtx())) as SupervisorMissingContext;
    const job = await recipe.propose(ctx, whipCtx());
    const v = await recipe.verify(job, EMPTY_PATCH, whipCtx());
    expect(v.ok).toBe(true);
    expect(v.patchSummary).toContain("supervisor window now present");
  });

  test("post-cursor supervisor still missing → ok=true (allowlist) but staged summary", async () => {
    const recipe = makeRecipe([
      ["lead", "whip-impl"], // detect: missing
      ["lead", "whip-impl"], // verify: still missing
    ]);
    const ctx = (await recipe.detect(whipCtx())) as SupervisorMissingContext;
    const job = await recipe.propose(ctx, whipCtx());
    const v = await recipe.verify(job, EMPTY_PATCH, whipCtx());
    expect(v.ok).toBe(true);
    expect(v.patchSummary).toContain("supervisor still absent");
    expect(v.patchSummary).toContain("staged for reviewer");
  });

  test("post-cursor list returns null (session gone) → not-ok summary", async () => {
    const recipe = makeRecipe([
      ["lead", "whip-impl"], // detect: missing
      null, // verify: session vanished
    ]);
    const ctx = (await recipe.detect(whipCtx())) as SupervisorMissingContext;
    const job = await recipe.propose(ctx, whipCtx());
    const v = await recipe.verify(job, EMPTY_PATCH, whipCtx());
    // Allowlist honored → ok=true (cursor didn't break things); summary
    // reflects that supervisor is still absent.
    expect(v.ok).toBe(true);
    expect(v.patchSummary).toContain("staged for reviewer");
  });

  test("non-empty patch → allowlist violation, ok=false", async () => {
    const recipe = makeRecipe([
      ["lead", "whip-impl"], // detect: missing
      ["lead", "supervisor", "whip-impl"], // verify: present (irrelevant — patch fails)
    ]);
    const ctx = (await recipe.detect(whipCtx())) as SupervisorMissingContext;
    const job = await recipe.propose(ctx, whipCtx());
    const v = await recipe.verify(job, TOUCHED_PATCH, whipCtx());
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain("patch touched 1 file");
    expect(v.reasons[0]).toContain("recipe allowlist is empty");
  });

  test("verify with absent sessionName → does not crash, summary mentions empty session", async () => {
    const recipe = makeRecipe([]);
    const v = await recipe.verify(
      {
        prompt: "x",
        fileAllowlist: [],
        tokenCap: 1_000,
        cwd: PROJECT_CWD,
      },
      EMPTY_PATCH,
      {
        atmuxDir: ATMUX_DIR,
        projectCwd: PROJECT_CWD,
        nowSec: 1_700_000_000,
        teamName: TEAM,
      },
    );
    expect(v.ok).toBe(true);
    // No session name means the post-list check was skipped; summary
    // says "still absent ... staged for reviewer".
    expect(v.patchSummary).toContain("still absent");
  });
});

// ---------- registry export ----------

describe("fix:supervisor-missing module exports", () => {
  test("default export is a CursorRecipe with the canonical id", async () => {
    const { fixSupervisorMissingRecipe } = await import(
      "../../../../src/core/cursor-recipes/fix-supervisor-missing.ts"
    );
    expect(fixSupervisorMissingRecipe.id).toBe("fix:supervisor-missing");
    expect(fixSupervisorMissingRecipe.tokenCap).toBe(1_000);
    expect(fixSupervisorMissingRecipe.fileAllowlist).toEqual([]);
  });
});
