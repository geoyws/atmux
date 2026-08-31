// Regression guard for the bundled tmux prefix hotkeys in templates/tmux/atmux.conf.
//
// The shipped conf now binds Meta+0..9 in the prefix table to windows
// 10..19, while leaving tmux's built-in prefix digits 1..9 alone for the
// lower windows and keeping 20+ on chooser / explicit `select-window`.
// This file checks the effective key tables on a real isolated tmux
// server that loads the shipped config, not just the config text.
//
// Honest-test note: a grep over the file alone would miss a mistaken
// `bind -n M-0 ...` in the root table. The server-level probe below reads
// the real prefix and root tables from a live tmux process, so the test
// fails if the hotkeys move tables or target the wrong windows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CONF_PATH = join(REPO_ROOT, "templates", "tmux", "atmux.conf");
const conf = readFileSync(CONF_PATH, "utf8");

let dir = "";
let socket = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atmux-meta-hotkeys-"));
  socket = join(dir, "sock");
});

afterEach(async () => {
  Bun.spawnSync({
    cmd: ["tmux", "-S", socket, "kill-server"],
    env: { ...process.env, TMUX: undefined, HOME: undefined } as Record<string, string | undefined>,
    stderr: "ignore",
  });
  await rm(dir, { recursive: true, force: true });
});

function spawnTmux(args: ReadonlyArray<string>, extraEnv: Record<string, string | undefined> = {}) {
  return Bun.spawnSync({
    cmd: ["tmux", "-S", socket, ...args],
    env: {
      ...process.env,
      HOME: dir,
      TMUX: undefined,
      ...extraEnv,
    } as Record<string, string | undefined>,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function assertTmuxSuccess(proc: ReturnType<typeof spawnTmux>, context: string) {
  const stderr = new TextDecoder().decode(proc.stderr);
  expect(proc.exitCode, `${context}: tmux exited non-zero`).toBe(0);
  expect(stderr, `${context}: tmux reported socket or server creation failure`).not.toContain(
    "error creating",
  );
}

function runTmux(args: ReadonlyArray<string>, extraEnv: Record<string, string | undefined> = {}) {
  const proc = spawnTmux(args, extraEnv);
  assertTmuxSuccess(proc, `tmux ${args.join(" ")}`);
  return new TextDecoder().decode(proc.stdout);
}

function listKeys(table: "prefix" | "root") {
  return runTmux(["list-keys", "-T", table])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeBinding(line: string) {
  return line
    .replace(/^bind-key\s+/, "bind ")
    .replace(/\s+/g, " ")
    .trim();
}

function nonCommentDirectiveLines(source: string) {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("templates/tmux/atmux.conf Meta hotkeys (prefix table)", () => {
  test("the shipped conf has exactly the ten prefix-table Meta digit bindings and loads the local override last", () => {
    const lines = nonCommentDirectiveLines(conf);
    const metaBindings = lines.filter((line) =>
      /^bind -T prefix M-[0-9] select-window -t \d+$/.test(line),
    );
    const rootMetaBindings = lines.filter((line) =>
      /^(?:bind|bind-key)\s+(?:-n|-T\s+root)\s+M-[0-9]\b/.test(line),
    );
    const expected = Array.from(
      { length: 10 },
      (_, digit) => `bind -T prefix M-${digit} select-window -t ${10 + digit}`,
    );

    expect(metaBindings).toHaveLength(10);
    expect(metaBindings).toEqual(expected);
    expect(new Set(metaBindings).size).toBe(10);
    expect(rootMetaBindings).toEqual([]);
    expect(lines.at(-1)).toBe('source-file -q "~/.config/atmux/tmux.conf.local"');
  });

  test("loads the shipped config into a real tmux server and binds M-0..M-9 to windows 10..19", async () => {
    const start = spawnTmux(["-f", CONF_PATH, "new-session", "-d", "-s", "probe"], {
      HOME: dir,
    });
    assertTmuxSuccess(start, "tmux new-session -d -s probe");

    const prefixLines = listKeys("prefix");
    const metaBindings = prefixLines.filter((line) =>
      /^bind-key\s+-T\s+prefix\s+M-[0-9]\b/.test(line),
    );
    expect(metaBindings).toHaveLength(10);
    expect(new Set(metaBindings).size).toBe(10);
    expect(prefixLines.filter((line) => /^bind-key\s+-n\s+M-[0-9]\b/.test(line))).toEqual([]);

    for (let digit = 0; digit <= 9; digit += 1) {
      const target = 10 + digit;
      const expected = `bind -T prefix M-${digit} select-window -t ${target}`;
      const hit = metaBindings.find((candidate) => candidate.includes(` M-${digit} `));
      expect(hit, `missing prefix binding for M-${digit}`).toBeDefined();
      expect(normalizeBinding(hit ?? "")).toBe(expected);
      expect(hit).toContain(`select-window -t ${target}`);
    }

    for (let window = 1; window <= 9; window += 1) {
      const hit = prefixLines.find((candidate) => candidate.includes(` ${window} `));
      expect(hit, `missing built-in prefix binding for ${window}`).toBeDefined();
      expect(normalizeBinding(hit ?? "")).toBe(
        `bind -T prefix ${window} select-window -t :=${window}`,
      );
    }
  });

  test("does not introduce any M-digit root-table binding", async () => {
    const start = spawnTmux(["-f", CONF_PATH, "new-session", "-d", "-s", "probe"], {
      HOME: dir,
    });
    assertTmuxSuccess(start, "tmux new-session -d -s probe");

    const rootLines = listKeys("root");
    const rootMetaDigits = rootLines.filter((line) => /\bM-[0-9]\b/.test(line));
    expect(rootMetaDigits).toEqual([]);
  });
});
