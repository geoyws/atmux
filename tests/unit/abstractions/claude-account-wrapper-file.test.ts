// Unit tests for the ADR-243 wrapper integration: resolution
// prefers ~/.atmux/claude-accounts.json when present, embedded
// defaults when absent, ConfigError when malformed.
//
// The wrapper reads process.env.HOME (single env boundary in
// claude-account-wrapper.ts); each case points HOME at a mkdtemp
// scratch dir, resets the per-process cache, and restores HOME after.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  knownClaudeConfigDirs,
  mergeWrapperRegistries,
  resetClaudeWrapperCacheForTests,
  resolveClaudeWrapper,
} from "../../../src/abstractions/claude-account-wrapper.ts";
import { claudeAccountsConfigPath } from "../../../src/abstractions/claude-accounts-config.ts";
import { ConfigError } from "../../../src/errors.ts";

let scratch: string;
let savedHome: string | undefined;
let savedStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-claude-wrapper-file-"));
  savedHome = process.env.HOME;
  process.env.HOME = scratch;
  resetClaudeWrapperCacheForTests();
  // The absent-file fallback emits a one-time stderr notice per
  // process — silence it so the suite output stays clean.
  savedStderrWrite = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stderr.write = savedStderrWrite;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  resetClaudeWrapperCacheForTests();
  await rm(scratch, { recursive: true, force: true });
});

async function writeConfig(value: unknown): Promise<void> {
  const path = claudeAccountsConfigPath(scratch);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

describe("resolveClaudeWrapper (file-backed)", () => {
  test("custom account from file resolves", async () => {
    await writeConfig({
      schemaVersion: 1,
      accounts: [
        { configDir: "/root/.claude", wrapper: "claude" },
        { configDir: "/root/.claude-newone", wrapper: "c-n" },
      ],
    });
    expect(resolveClaudeWrapper("/root/.claude-newone") as string).toBe("c-n");
  });

  test("file table replaces defaults (removed default is unknown)", async () => {
    await writeConfig({
      schemaVersion: 1,
      accounts: [{ configDir: "/root/.claude-newone", wrapper: "c-n" }],
    });
    expect(() => resolveClaudeWrapper("/root/.claude-unum")).toThrow(ConfigError);
  });

  test("absent file serves embedded defaults", () => {
    expect(resolveClaudeWrapper("/root/.claude")).toBe("claude");
    expect(resolveClaudeWrapper("/root/.claude-unum")).toBe("c-u");
    expect(resolveClaudeWrapper("/root/.claude-icloud")).toBe("c-ic");
    expect(resolveClaudeWrapper("/root/.claude-ifca")).toBe("c-i");
  });

  test("malformed file refuses with ConfigError (no silent fallback)", async () => {
    await writeConfig("{ broken json");
    expect(() => resolveClaudeWrapper("/root/.claude")).toThrow(ConfigError);
  });

  test("duplicate configDir file refuses", async () => {
    await writeConfig({
      schemaVersion: 1,
      accounts: [
        { configDir: "/root/.claude", wrapper: "claude" },
        { configDir: "/root/.claude", wrapper: "c-dup" },
      ],
    });
    expect(() => resolveClaudeWrapper("/root/.claude")).toThrow(ConfigError);
  });

  test("explicit registry still wins over the file", async () => {
    await writeConfig({
      schemaVersion: 1,
      accounts: [{ configDir: "/root/.claude", wrapper: "file-wrapper" }],
    });
    const custom = new Map([["/root/.claude", "explicit-wrapper"]]);
    expect(resolveClaudeWrapper("/root/.claude", custom)).toBe("explicit-wrapper");
  });
});

describe("knownClaudeConfigDirs (file-backed)", () => {
  test("absent file enumerates the 4-entry defaults", () => {
    expect(knownClaudeConfigDirs()).toEqual([
      "/root/.claude",
      "/root/.claude-unum",
      "/root/.claude-icloud",
      "/root/.claude-ifca",
    ]);
  });

  test("present file enumerates file order", async () => {
    await writeConfig({
      schemaVersion: 1,
      accounts: [
        { configDir: "/root/.claude-newone", wrapper: "c-n" },
        { configDir: "/root/.claude", wrapper: "claude" },
      ],
    });
    expect(knownClaudeConfigDirs()).toEqual(["/root/.claude-newone", "/root/.claude"]);
  });
});

describe("mergeWrapperRegistries (file-backed base)", () => {
  test("seeds from the file table; cockpit/team overrides still win", async () => {
    await writeConfig({
      schemaVersion: 1,
      accounts: [{ configDir: "/root/.claude", wrapper: "file-wrapper" }],
    });
    const merged = mergeWrapperRegistries(
      { "/root/.claude": "cockpit-wrapper" },
      { "/root/.other": "team-wrapper" },
    );
    expect(merged.get("/root/.claude")).toBe("cockpit-wrapper");
    expect(merged.get("/root/.other")).toBe("team-wrapper");
    expect(resolveClaudeWrapper("/root/.claude", merged)).toBe("cockpit-wrapper");
  });
});
