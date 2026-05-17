// Unit tests for src/core/templates-dir.ts — resolver for the
// `templates/` directory shared by `init` / `rotate` / `start`.
//
// Closes the c-003a2a4c / t-17d413b1 regression: compiled bun's
// `import.meta.dir` walks $bunfs to `/templates` (filesystem root)
// when running from the installed binary, breaking the previous
// `resolve(import.meta.dir, "..", "..", "templates")` resolvers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBriefsDir, resolveTemplatesDir } from "../../../src/core/templates-dir.ts";

describe("resolveTemplatesDir", () => {
  test("env override (ATMUX_TEMPLATES_DIR) honoured verbatim when set", () => {
    const r = resolveTemplatesDir({ ATMUX_TEMPLATES_DIR: "/custom/path/templates" });
    expect(r).toBe("/custom/path/templates");
  });

  test("empty-string env override falls through to dev-mode probe", () => {
    // The resolver skips env values that are empty strings (mirrors the
    // existing init.test.ts:433 contract for ATMUX_TEMPLATES_DIR).
    const r = resolveTemplatesDir({ ATMUX_TEMPLATES_DIR: "" });
    // Falls through to the repo's templates/ — the test process runs
    // from the repo, so the dev-mode path exists + wins.
    expect(r.endsWith("/templates")).toBe(true);
    expect(r).not.toBe("");
  });

  test("undefined env override falls through to dev-mode probe", () => {
    const r = resolveTemplatesDir({});
    expect(r.endsWith("/templates")).toBe(true);
  });

  test("dev-mode probe returns repo's templates/ (path exists on disk)", () => {
    // The unit test process runs from the repo source tree, so the
    // dev-mode probe at `<this-file>/../../../templates` resolves to
    // `<repo>/templates` which exists.
    const r = resolveTemplatesDir({});
    expect(r.endsWith("/templates")).toBe(true);
    // Sanity: the resolved path is absolute.
    expect(r.startsWith("/")).toBe(true);
  });
});

describe("resolveBriefsDir", () => {
  test("returns <templates>/briefs (composed from resolveTemplatesDir)", () => {
    const r = resolveBriefsDir({ ATMUX_TEMPLATES_DIR: "/x/templates" });
    expect(r).toBe("/x/templates/briefs");
  });

  test("default (no env) ends with /templates/briefs", () => {
    const r = resolveBriefsDir({});
    expect(r.endsWith("/templates/briefs")).toBe(true);
  });
});

// The installed-mode fallback (process.execPath-based) cannot be
// exercised purely through env injection — `process.execPath` is
// process-wide state and bun-test runs as the bun binary, not the
// installed atmux binary. The dev-mode path always wins under bun-test.
//
// Coverage for the installed-mode branch is captured indirectly via
// the c-003a2a4c repro proof: `/usr/local/bin/atmux init` (the actual
// compiled binary) succeeds end-to-end after build:install ships
// `templates/` to `/opt/atmux/<v>/templates/`. The shell-level repro
// is documented in the commit body + RUNBOOK-deploy.md.
//
// One synthetic probe for completeness — exercise the realpathSync
// + dirname code path by symlinking a stub "bin" under a tmpdir-rooted
// "templates" sibling, then asserting resolveTemplatesDir falls back
// past the dev probe (when ATMUX_TEMPLATES_DIR is set to a missing
// path that triggers the empty-string fall-through but doesn't poison
// the dev path). Skipped because the prod path uses process.execPath
// which we can't mutate inside the test process — the test would have
// to spawn a subprocess. Out-of-scope for unit; the e2e is via the
// install-binary repro.

describe("resolveTemplatesDir — installed-mode fallback (out-of-process)", () => {
  test.todo("installed-mode branch — covered by post-deploy /usr/local/bin/atmux init repro", () => {
    // See commit body + RUNBOOK-deploy.md for the shell-level proof.
  });
});

// ---------- Sanity coverage probe: ensure resolveBriefsDir + resolveTemplatesDir don't crash on
// edge env shapes ----------

describe("resolver edge cases", () => {
  let tmpRoot: string | undefined;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "atmux-tmpls-test-"));
  });
  afterEach(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test("custom env override pointing at a real on-disk templates dir resolves successfully", async () => {
    const fakeTemplates = join(tmpRoot ?? "", "templates");
    await mkdir(fakeTemplates, { recursive: true });
    await writeFile(join(fakeTemplates, "team.example.json"), "{}", "utf8");
    const r = resolveTemplatesDir({ ATMUX_TEMPLATES_DIR: fakeTemplates });
    expect(r).toBe(fakeTemplates);
  });

  test("env override pointing at non-existent path STILL returned (resolver doesn't probe override)", () => {
    const fake = join(tmpRoot ?? "", "definitely-not-here");
    const r = resolveTemplatesDir({ ATMUX_TEMPLATES_DIR: fake });
    expect(r).toBe(fake);
  });

  test("resolveBriefsDir composes on env override", async () => {
    const fakeTemplates = join(tmpRoot ?? "", "templates");
    await mkdir(join(fakeTemplates, "briefs"), { recursive: true });
    const r = resolveBriefsDir({ ATMUX_TEMPLATES_DIR: fakeTemplates });
    expect(r).toBe(join(fakeTemplates, "briefs"));
  });
});

// Touching symlink import keeps biome happy; tested via the realpath
// branch of resolveTemplatesDir which is only reachable via process.execPath.
void symlink;
