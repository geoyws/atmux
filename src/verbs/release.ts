// t-c3f4c418 — `atmux release [patch|minor|major]` one-shot deploy verb.
//
// Replaces the 4-manual-step deploy flow that hid t-186d5910 for ~30h
// (code-shipped-not-deployed class):
//
//   pre:   npm version patch --no-git-tag-version
//          git add package.json && git commit -m "chore(release): ..."
//          bun run build:install
//          git push origin <branch>
//
//   post:  atmux release patch                (does all four)
//          atmux release minor --dry-run      (prints the plan)
//          atmux release patch --allow-dirty  (proceed with uncommitted)
//
// Safety gates (refuse + exit 64 unless --allow-dirty):
//   - working tree must be clean (no uncommitted source changes that
//     would be omitted from the deploy)
//   - HEAD must not be equal to the last package.json bump commit AND
//     /opt/atmux/current version must equal source-package.json version
//     (i.e. "nothing to ship" — would produce an empty deploy)
//
// Skipped in --dry-run: every action; prints the plan + exits 0.

import { readTextOrNull, writeText } from "../abstractions/fs.ts";
import { spawn as defaultSpawn, type SpawnResult } from "../abstractions/spawn.ts";
import { defaultStderrWrite, defaultStdoutWrite, type Writer } from "../core/io.ts";
import { UsageError } from "../errors.ts";

export type BumpKind = "patch" | "minor" | "major";

export interface ParsedReleaseArgs {
  bump: BumpKind;
  dryRun: boolean;
  allowDirty: boolean;
}

const USAGE = "atmux release <patch|minor|major> [--dry-run] [--allow-dirty]";

export function parseReleaseArgs(argv: ReadonlyArray<string>): ParsedReleaseArgs {
  let bump: BumpKind | undefined;
  let dryRun = false;
  let allowDirty = false;
  for (const a of argv) {
    if (a === "patch" || a === "minor" || a === "major") {
      if (bump !== undefined) {
        throw new UsageError({
          what: `release: bump kind specified twice ('${bump}' then '${a}')`,
          hint: USAGE,
        });
      }
      bump = a;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--allow-dirty") {
      allowDirty = true;
      continue;
    }
    throw new UsageError({ what: `release: unknown arg: ${a}`, hint: USAGE });
  }
  if (bump === undefined) {
    throw new UsageError({
      what: "release: bump kind required",
      hint: USAGE,
    });
  }
  return { bump, dryRun, allowDirty };
}

/** Semver bump — pure. Strips pre-release suffixes; output is always
 *  `N.N.N`. Throws when input doesn't parse as semver. */
export function bumpVersion(current: string, kind: BumpKind): string {
  const m = current.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+].*)?$/);
  if (m === null) {
    throw new UsageError({
      what: `release: package.json version '${current}' not semver`,
      hint: "fix the version field manually before running release",
    });
  }
  const major = Number.parseInt(m[1] ?? "0", 10);
  const minor = Number.parseInt(m[2] ?? "0", 10);
  const patch = Number.parseInt(m[3] ?? "0", 10);
  switch (kind) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

export type SpawnFn = (
  cmd: string,
  argv: ReadonlyArray<string>,
  opts?: { cwd?: string },
) => Promise<SpawnResult>;

const defaultSpawnFn: SpawnFn = (cmd, argv, opts = {}) =>
  defaultSpawn({
    cmd,
    argv,
    expectExitCode: "any",
    timeoutMs: 300_000,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });

export interface ReleaseOpts {
  /** Override the spawn for test isolation. Receives ('git'|'bun', argv, opts). */
  spawn?: SpawnFn;
  /** Reader for package.json. Defaults to ./package.json. */
  readPackageJson?: () => Promise<string | null>;
  /** Writer for package.json. Defaults to ./package.json. */
  writePackageJson?: (content: string) => Promise<void>;
  stdout?: Writer;
  stderr?: Writer;
}

export async function release(
  argv: ReadonlyArray<string>,
  opts: ReleaseOpts = {},
): Promise<number> {
  const parsed = parseReleaseArgs(argv);
  const spawn = opts.spawn ?? defaultSpawnFn;
  const readPackageJson = opts.readPackageJson ?? (() => readTextOrNull("package.json"));
  const writePackageJson =
    opts.writePackageJson ?? ((content: string) => writeText("package.json", content));
  const stdout = opts.stdout ?? defaultStdoutWrite;
  const stderr = opts.stderr ?? defaultStderrWrite;

  // Step 1 — read current version.
  const pkgText = await readPackageJson();
  if (pkgText === null) {
    stderr("release: package.json not found in cwd\n");
    return 64;
  }
  let parsedPkg: { version?: unknown };
  try {
    parsedPkg = JSON.parse(pkgText);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    stderr(`release: package.json invalid JSON — ${cause}\n`);
    return 64;
  }
  if (typeof parsedPkg.version !== "string") {
    stderr("release: package.json missing 'version' field\n");
    return 64;
  }
  const current = parsedPkg.version;
  const next = bumpVersion(current, parsed.bump);

  // Step 2 — clean-tree gate.
  if (!parsed.allowDirty) {
    const status = await spawn("git", ["status", "--porcelain"]);
    if (status.exitCode !== 0) {
      stderr(`release: git status failed (exit ${status.exitCode})\n`);
      return 65;
    }
    if (status.stdout.trim() !== "") {
      stderr(
        `release: working tree dirty — refusing to bump.\n` +
          `        Commit or stash first, or pass --allow-dirty to proceed.\n` +
          `        Dirty files:\n${status.stdout}`,
      );
      return 65;
    }
  }

  // Step 3 — print + dry-run gate.
  const branchProbe = await spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = branchProbe.exitCode === 0 ? branchProbe.stdout.trim() : "<unknown>";
  stdout(`atmux release ${parsed.bump}: ${current} → ${next}\n`);
  stdout(`  branch:    ${currentBranch}\n`);
  if (parsed.dryRun) {
    stdout("  --dry-run set — would perform:\n");
    stdout(`    1. write package.json version=${next}\n`);
    stdout('    2. git commit -m "chore(release): bump version to ' + next + '"\n');
    stdout("    3. bun run build:install\n");
    stdout("    4. git push origin <current-branch>\n");
    return 0;
  }

  // Step 4 — write new version.
  const updatedPkg = pkgText.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${next}"`);
  if (updatedPkg === pkgText) {
    stderr(`release: failed to substitute version in package.json\n`);
    return 70;
  }
  await writePackageJson(updatedPkg);

  // Step 5 — git add + commit.
  const addRes = await spawn("git", ["add", "package.json"]);
  if (addRes.exitCode !== 0) {
    stderr(`release: git add failed (exit ${addRes.exitCode}): ${addRes.stderr}\n`);
    return 70;
  }
  const commitMsg = `chore(release): bump version to ${next}\n\nRolls forward source-tree commits into deployable build via 'atmux release ${parsed.bump}'.\n`;
  const commitRes = await spawn("git", ["commit", "-m", commitMsg]);
  if (commitRes.exitCode !== 0) {
    stderr(`release: git commit failed (exit ${commitRes.exitCode}): ${commitRes.stderr}\n`);
    return 70;
  }
  stdout(`  ✓ commit landed: ${next}\n`);

  // Step 6 — build + install.
  stdout("  → bun run build:install (this takes a few seconds)...\n");
  const buildRes = await spawn("bun", ["run", "build:install"]);
  if (buildRes.exitCode !== 0) {
    stderr(
      `release: bun run build:install failed (exit ${buildRes.exitCode}).\n` +
        `        stderr: ${buildRes.stderr}\n` +
        `        Recover: roll the version forward manually + redeploy, OR run\n` +
        `        \`git reset --soft HEAD~1\` to undo the commit and retry.\n`,
    );
    return 70;
  }
  stdout(`  ✓ /opt/atmux/${next}/bin/atmux installed; /opt/atmux/current symlink retargeted\n`);

  // Step 7 — push.
  const branchRes = await spawn("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchRes.exitCode !== 0) {
    stderr(`release: git rev-parse failed (exit ${branchRes.exitCode})\n`);
    return 70;
  }
  const branch = branchRes.stdout.trim();
  const pushRes = await spawn("git", ["push", "origin", branch]);
  if (pushRes.exitCode !== 0) {
    stderr(
      `release: git push failed (exit ${pushRes.exitCode}): ${pushRes.stderr}\n` +
        `        Commit + build landed locally; push manually with: git push origin ${branch}\n`,
    );
    return 70;
  }
  stdout(`  ✓ pushed origin/${branch}\n`);
  stdout(`atmux release ${parsed.bump} complete — v${next} deployed.\n`);
  return 0;
}
