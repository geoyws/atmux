import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { parseTokenBudgetArgs, tokenBudget } from "../../../src/verbs/token-budget.ts";

const NOW = 1_700_000_000;

async function makeTmpRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "atmux-token-budget-defaults-"));
}

async function writeProbeScript(dir: string): Promise<{ scriptPath: string; argvPath: string }> {
  const argvPath = join(dir, "captured-argv.txt");
  const scriptPath = join(dir, "probe-budgets.sh");
  const healthyRow = JSON.stringify({
    provider: "claude",
    account: "gmail",
    bucket: "5h",
    usedPercent: 12,
    windowMinutes: 300,
    resetsAt: NOW + 3600,
    status: "allowed",
    source: "live",
    observedAt: NOW,
  });
  await writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      `printf "%s\\n" "$0" "$@" > "${argvPath}"`,
      `printf "%s\\n" '${healthyRow}'`,
      "",
    ].join("\n"),
  );
  await chmod(scriptPath, 0o755);
  return { scriptPath, argvPath };
}

describe("token-budget defaults", () => {
  test("missing --timeout-ms throws UsageError", () => {
    expect(() => parseTokenBudgetArgs(["--timeout-ms"])).toThrow(UsageError);
    expect(() => parseTokenBudgetArgs(["--timeout-ms"])).toThrow(
      /token-budget: --timeout-ms requires a value/,
    );
  });

  test("a NUL probe path falls through defaultExists and becomes ConfigError", async () => {
    const root = await makeTmpRoot();
    try {
      const env = {
        ATMUX_BUDGET_PROBE: `${join(root, "probe-budgets.sh")}\0bad`,
        HOME: join(root, "home"),
      };
      await mkdir(env.HOME, { recursive: true });
      await expect(tokenBudget([], { env })).rejects.toThrow(ConfigError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the real defaultExists/defaultRunProbe path invokes the fixture executable and returns rc 0", async () => {
    const root = await makeTmpRoot();
    try {
      const { scriptPath, argvPath } = await writeProbeScript(root);
      const env = {
        ATMUX_BUDGET_PROBE: scriptPath,
        HOME: join(root, "home"),
      };
      await mkdir(env.HOME, { recursive: true });

      const rc = await tokenBudget([], { env });

      expect(rc).toBe(0);
      const captured = await readFile(argvPath, "utf8");
      expect(captured).toBe(`${scriptPath}\n--json\n--provider\nall\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
