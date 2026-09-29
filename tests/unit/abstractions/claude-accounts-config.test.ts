// Unit tests for src/abstractions/claude-accounts-config.ts —
// ADR-243 D1/D2 schema-v1 loader. All file cases run against a
// mkdtemp scratch HOME passed explicitly as `home` (never the real
// $HOME, never shared /tmp literals).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeAccountsConfigPath,
  DEFAULT_CLAUDE_ACCOUNTS,
  loadClaudeAccounts,
  parseClaudeAccountsConfig,
} from "../../../src/abstractions/claude-accounts-config.ts";
import { ConfigError } from "../../../src/errors.ts";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-claude-accounts-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writeConfig(body: string): Promise<string> {
  const path = claudeAccountsConfigPath(scratch);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
  return path;
}

describe("claudeAccountsConfigPath", () => {
  test("resolves ~/.atmux/claude-accounts.json under the given home", () => {
    expect(claudeAccountsConfigPath("/home/op")).toBe("/home/op/.atmux/claude-accounts.json");
  });
});

describe("loadClaudeAccounts (absent → embedded defaults)", () => {
  test("missing file falls back to the 4-entry defaults", () => {
    const loaded = loadClaudeAccounts(scratch);
    expect(loaded.source).toBe("defaults");
    expect(loaded.path).toBe(claudeAccountsConfigPath(scratch));
    expect([...loaded.table.entries()]).toEqual(
      DEFAULT_CLAUDE_ACCOUNTS.accounts.map((a) => [a.configDir, a.wrapper]),
    );
  });

  test("unset home falls back to defaults with null path", () => {
    const loaded = loadClaudeAccounts(undefined);
    expect(loaded.source).toBe("defaults");
    expect(loaded.path).toBeNull();
    expect(loaded.table.get("/root/.claude")).toBe("claude");
  });

  test("empty home falls back to defaults with null path", () => {
    expect(loadClaudeAccounts("").source).toBe("defaults");
  });

  test("unreadable path (directory at config path) refuses", async () => {
    const path = claudeAccountsConfigPath(scratch);
    await mkdir(join(path, ".."), { recursive: true });
    await mkdir(path, { recursive: true });
    let message = "";
    try {
      loadClaudeAccounts(scratch);
    } catch (e) {
      if (e instanceof Error) message = e.message;
    }
    expect(message).toContain("unreadable");
    expect(message).toContain(path);
  });
});

describe("loadClaudeAccounts (valid file)", () => {
  test("parses custom accounts preserving file order", async () => {
    await writeConfig(
      JSON.stringify({
        schemaVersion: 1,
        accounts: [
          { configDir: "/root/.claude-newone", wrapper: "c-n" },
          { configDir: "/root/.claude", wrapper: "claude" },
        ],
      }),
    );
    const loaded = loadClaudeAccounts(scratch);
    expect(loaded.source).toBe("file");
    expect([...loaded.table.keys()]).toEqual(["/root/.claude-newone", "/root/.claude"]);
    expect(loaded.table.get("/root/.claude-newone")).toBe("c-n");
  });

  test("5-account ADR example round-trips (incl. c-p)", async () => {
    await writeConfig(
      JSON.stringify({
        schemaVersion: 1,
        accounts: [
          { configDir: "/root/.claude", wrapper: "claude" },
          { configDir: "/root/.claude-unum", wrapper: "c-u" },
          { configDir: "/root/.claude-icloud", wrapper: "c-ic" },
          { configDir: "/root/.claude-ifca", wrapper: "c-i" },
          { configDir: "/root/.claude-proton", wrapper: "c-p" },
        ],
      }),
    );
    const loaded = loadClaudeAccounts(scratch);
    expect(loaded.table.get("/root/.claude-proton")).toBe("c-p");
    expect(loaded.table.size).toBe(5);
  });
});

describe("loadClaudeAccounts (malformed → ConfigError refusal)", () => {
  test("invalid JSON refuses", async () => {
    await writeConfig("{ not json");
    expect(() => loadClaudeAccounts(scratch)).toThrow(ConfigError);
  });

  test("unknown schemaVersion refuses", async () => {
    await writeConfig(JSON.stringify({ schemaVersion: 2, accounts: [] }));
    const err = (() => {
      try {
        loadClaudeAccounts(scratch);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(String((err as Error)?.message ?? err)).toContain("schemaVersion");
  });

  test("duplicate configDir refuses", async () => {
    await writeConfig(
      JSON.stringify({
        schemaVersion: 1,
        accounts: [
          { configDir: "/root/.claude", wrapper: "claude" },
          { configDir: "/root/.claude", wrapper: "c-dup" },
        ],
      }),
    );
    expect(() => loadClaudeAccounts(scratch)).toThrow(ConfigError);
  });

  test("missing required field refuses", async () => {
    await writeConfig(
      JSON.stringify({ schemaVersion: 1, accounts: [{ configDir: "/root/.claude" }] }),
    );
    expect(() => loadClaudeAccounts(scratch)).toThrow(ConfigError);
  });

  test("refusal quotes the file path", async () => {
    const path = await writeConfig("{ broken");
    let message = "";
    try {
      loadClaudeAccounts(scratch);
    } catch (e) {
      if (e instanceof Error) message = e.message;
    }
    expect(message).toContain(path);
  });
});

describe("parseClaudeAccountsConfig (pure validator)", () => {
  test("non-object root refuses", () => {
    expect(() => parseClaudeAccountsConfig([1], "/p")).toThrow(ConfigError);
    expect(() => parseClaudeAccountsConfig(null, "/p")).toThrow(ConfigError);
    expect(() => parseClaudeAccountsConfig("x", "/p")).toThrow(ConfigError);
  });

  test("non-array accounts refuses", () => {
    expect(() => parseClaudeAccountsConfig({ schemaVersion: 1 }, "/p")).toThrow(ConfigError);
  });

  test("empty configDir / wrapper refuse", () => {
    expect(() =>
      parseClaudeAccountsConfig(
        { schemaVersion: 1, accounts: [{ configDir: "", wrapper: "c-x" }] },
        "/p",
      ),
    ).toThrow(ConfigError);
    expect(() =>
      parseClaudeAccountsConfig(
        { schemaVersion: 1, accounts: [{ configDir: "/r/.c", wrapper: "" }] },
        "/p",
      ),
    ).toThrow(ConfigError);
  });

  test("non-object entry refuses", () => {
    expect(() => parseClaudeAccountsConfig({ schemaVersion: 1, accounts: ["nope"] }, "/p")).toThrow(
      ConfigError,
    );
  });
});
