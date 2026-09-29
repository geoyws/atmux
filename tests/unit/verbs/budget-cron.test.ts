// e-50 T5 (t-6da51a02): hourly `atmux budget collect` cron one-liners.
//
// The install/remove one-liners are extracted from the docs at test time
// (docs/RUNBOOK-budget.md §2 canonical; the docs/adr/270 amendment must
// match line-for-line) so doc and test cannot drift — then EXECUTED as
// written against a fake `crontab` placed first on PATH. The fake stores
// its table in a temp file and commits `crontab -` only at stdin EOF
// (like the real binary, so `crontab -l … | crontab -` never
// self-truncates). The real user crontab is never touched.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shell-outs stay sub-second, but loaded hosts can stall spawns past bun's
// 5s default per-test timeout (observed flake); give them headroom.
setDefaultTimeout(30_000);

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const RUNBOOK = join(REPO_ROOT, "docs", "RUNBOOK-budget.md");
const ADR270 = join(REPO_ROOT, "docs", "adr", "270-budget-usage-tracker.md");

/** Extract the exact documented one-liner from a fenced `tag` block. */
function extract(md: string, tag: string): string {
  const m = md.match(new RegExp(`\`\`\`${tag}\\r?\\n([\\s\\S]*?)\`\`\``));
  if (!m || m[1] === undefined) throw new Error(`missing fenced ${tag} block`);
  return m[1].trim();
}

const runbookMd = readFileSync(RUNBOOK, "utf-8");
const adrMd = readFileSync(ADR270, "utf-8");
const INSTALL = extract(runbookMd, "cron-install-sh");
const REMOVE = extract(runbookMd, "cron-remove-sh");

// Faithful fake crontab: table in $FAKE_CRONTAB_FILE, `-` commits at EOF,
// empty input removes the table, missing table reads as "no crontab" exit 1.
const FAKE_CRONTAB = `#!/bin/sh
if [ "$1" = "-l" ]; then
  if [ -f "$FAKE_CRONTAB_FILE" ]; then cat "$FAKE_CRONTAB_FILE"; else echo "no crontab" >&2; exit 1; fi
elif [ "$1" = "-" ]; then
  cat > "$FAKE_CRONTAB_FILE.tmp"
  if [ -s "$FAKE_CRONTAB_FILE.tmp" ]; then mv "$FAKE_CRONTAB_FILE.tmp" "$FAKE_CRONTAB_FILE"; else rm -f "$FAKE_CRONTAB_FILE.tmp" "$FAKE_CRONTAB_FILE"; fi
else echo "unsupported $*" >&2; exit 2; fi
`;

interface Harness {
  table: string;
  env: NodeJS.ProcessEnv;
}

// Fake `atmux` with the real binary's shebang: it only runs if cron's
// environment can resolve `bun`. It records its argv so the test can see
// that the collector was actually invoked.
const FAKE_ATMUX = `#!/usr/bin/env bun
require("node:fs").writeFileSync(\`\${process.env.HOME}/ran\`, process.argv.slice(2).join(" "));
`;

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "budget-cron-"));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".atmux", "state"), { recursive: true });
  writeFileSync(join(bin, "crontab"), FAKE_CRONTAB, { mode: 0o755 });
  writeFileSync(join(bin, "atmux"), FAKE_ATMUX, { mode: 0o755 });
  const table = join(dir, "table");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_CRONTAB_FILE: table,
    HOME: home,
  };
  return { table, env };
}

/** Run a documented one-liner exactly as written; non-zero exit fails loud. */
function run(env: NodeJS.ProcessEnv, script: string): void {
  const r = spawnSync("sh", ["-c", script], { env, encoding: "utf-8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
}

function readTable(table: string): string | null {
  try {
    return readFileSync(table, "utf-8");
  } catch {
    return null;
  }
}

const UNRELATED = "PATH=/usr/bin:/bin\n*/5 * * * * echo hello >>/tmp/x.log 2>&1\n";

describe("budget cron docs", () => {
  test("ADR-270 amendment matches the RUNBOOK one-liners line-for-line", () => {
    expect(extract(adrMd, "cron-install-sh")).toBe(INSTALL);
    expect(extract(adrMd, "cron-remove-sh")).toBe(REMOVE);
  });

  test("one-liners are single shell lines invoking the collector hourly", () => {
    for (const script of [INSTALL, REMOVE]) expect(script).not.toContain("\n");
    expect(INSTALL).toContain("atmux budget collect");
    expect(INSTALL).toContain("budget-collect.log");
    expect(INSTALL).toContain("7 * * * *");
  });
});

describe("budget cron one-liners against a fake crontab", () => {
  test("install on an empty table arms exactly one entry", () => {
    const { table, env } = setup();
    expect(readTable(table)).toBeNull();
    run(env, INSTALL);
    const body = readTable(table);
    expect(body).not.toBeNull();
    if (body === null) throw new Error("install wrote no table");
    const lines = body.trimEnd().split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatch(/^# >>> atmux:budget/);
    expect(lines[2]).toBe("# <<< atmux:budget");
    expect(lines[1]).toContain("atmux budget collect");
    expect(body.split("atmux budget collect").length - 1).toBe(1);
  });

  test("double install is a no-op; unrelated lines untouched", () => {
    const { table, env } = setup();
    writeFileSync(table, UNRELATED);
    run(env, INSTALL);
    const once = readTable(table);
    if (once === null) throw new Error("install wrote no table");
    expect(once.startsWith(UNRELATED)).toBe(true);
    expect(once.split("atmux budget collect").length - 1).toBe(1);
    run(env, INSTALL);
    expect(readTable(table)).toBe(once);
  });

  test("remove restores the pre-install table byte-identical", () => {
    const { table, env } = setup();
    writeFileSync(table, UNRELATED);
    const before = readFileSync(table);
    run(env, INSTALL);
    expect(readTable(table)).not.toBe(UNRELATED);
    run(env, REMOVE);
    expect(readFileSync(table)).toEqual(before);
  });

  test("remove on an empty table succeeds and leaves no table", () => {
    const { table, env } = setup();
    run(env, REMOVE);
    expect(existsSync(table)).toBe(false);
  });

  test("the installed entry runs under cron's minimal environment", () => {
    // Regression 2026-09-29: `atmux` is `#!/usr/bin/env bun` and cron's
    // PATH is /usr/bin:/bin, so an entry without bun's directory exited 127.
    const { table, env } = setup();
    run(env, INSTALL);
    const body = readTable(table);
    if (body === null) throw new Error("install wrote no table");
    const entry = body.split("\n").find((l) => l.includes("budget collect"));
    if (entry === undefined) throw new Error("no collector entry");
    // Drop the five schedule fields; cron runs the rest with /bin/sh -c.
    const command = entry.trim().split(/\s+/).slice(5).join(" ");
    const home = env.HOME as string;
    const r = spawnSync("/bin/sh", ["-c", command], {
      env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, "ran"), "utf-8")).toBe("budget collect");
  });
});
