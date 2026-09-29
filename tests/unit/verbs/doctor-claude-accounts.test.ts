// Unit tests for the ADR-243 `claude-accounts` doctor probe
// (src/verbs/doctor/claude-accounts.ts): yellow on absent, red on
// malformed, silent on valid. Pattern mirror:
// tests/unit/verbs/doctor-skills-plugin.test.ts — same pure/I-O
// describe split, same scratch-via-mkdtemp + cleanup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAccountsConfigPath } from "../../../src/abstractions/claude-accounts-config.ts";
import {
  type ClaudeAccountsConfigState,
  checkClaudeAccountsConfig,
  claudeAccountsConfigStateRows,
} from "../../../src/verbs/doctor/claude-accounts.ts";

describe("claudeAccountsConfigStateRows (pure)", () => {
  test("absent → single yellow claude-accounts row", () => {
    const rows = claudeAccountsConfigStateRows({ kind: "absent", path: "/h/.atmux/x.json" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("claude-accounts");
  });

  test("malformed → single red claude-accounts row quoting the reason", () => {
    const rows = claudeAccountsConfigStateRows({
      kind: "malformed",
      path: "/h/.atmux/x.json",
      reason: "malformed JSON: boom",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("claude-accounts");
    expect(rows[0]?.detail).toContain("boom");
  });

  test("valid → silent (no rows)", () => {
    const state: ClaudeAccountsConfigState = {
      kind: "valid",
      path: "/h/.atmux/x.json",
      accountCount: 5,
    };
    expect(claudeAccountsConfigStateRows(state)).toEqual([]);
  });
});

describe("checkClaudeAccountsConfig (I/O wrapper)", () => {
  let scratch: string;
  let home: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-doctor-claude-accounts-"));
    home = scratch;
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function writeConfig(body: string): Promise<void> {
    const path = claudeAccountsConfigPath(home);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  }

  test("absent file → yellow row", async () => {
    const rows = await checkClaudeAccountsConfig({ home });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("claude-accounts");
  });

  test("valid file → silent", async () => {
    await writeConfig(
      JSON.stringify({
        schemaVersion: 1,
        accounts: [{ configDir: "/root/.claude", wrapper: "claude" }],
      }),
    );
    await expect(checkClaudeAccountsConfig({ home })).resolves.toEqual([]);
  });

  test("malformed JSON → red row", async () => {
    await writeConfig("{ nope");
    const rows = await checkClaudeAccountsConfig({ home });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("claude-accounts");
  });

  test("schema violation (duplicate configDir) → red row", async () => {
    await writeConfig(
      JSON.stringify({
        schemaVersion: 1,
        accounts: [
          { configDir: "/root/.claude", wrapper: "claude" },
          { configDir: "/root/.claude", wrapper: "c-dup" },
        ],
      }),
    );
    const rows = await checkClaudeAccountsConfig({ home });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
    expect(rows[0]?.label).toBe("claude-accounts");
  });

  test("unknown schemaVersion → red row", async () => {
    await writeConfig(JSON.stringify({ schemaVersion: 9, accounts: [] }));
    const rows = await checkClaudeAccountsConfig({ home });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("red");
  });

  test("home unset → silent (no doctor row emitted)", async () => {
    await expect(checkClaudeAccountsConfig({ home: "", env: {} })).resolves.toEqual([]);
  });
});
