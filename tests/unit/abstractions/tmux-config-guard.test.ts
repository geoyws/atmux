import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_ROOT = join(import.meta.dir, "..", "..");
const REPO_ROOT = join(TESTS_ROOT, "..");
const SELF_PATH = fileURLToPath(import.meta.url);

const DEV_NULL = ["/dev", "/null"].join("");
const CREATE_TMUX_CONFIG_RE = new RegExp(
  String.raw`\bcreateTmux\s*\(\s*\{[\s\S]*?\bconfigFile\s*:\s*(['"])\s*${DEV_NULL.replace(
    /\//g,
    "\\/",
  )}\s*\1[\s\S]*?\}\s*\)`,
  "m",
);
const RAW_SERVER_START_RE = new RegExp(
  String.raw`['"]-f['"]\s*,\s*['"]${DEV_NULL.replace(/\//g, "\\/")}['"][\s\S]*?['"]new-session['"]`,
  "m",
);

async function walkTsFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkTsFiles(abs)));
      continue;
    }
    if (entry.isFile() && extname(entry.name) === ".ts") out.push(abs);
  }
  return out;
}

describe("tmux config fixture inventory guard", () => {
  test("rejects lingering /dev/null tmux config pins in TypeScript tests", async () => {
    const findings: Array<{ file: string; matches: string[] }> = [];
    for (const file of await walkTsFiles(TESTS_ROOT)) {
      const text = await readFile(file, "utf8");
      const matches: string[] = [];
      if (CREATE_TMUX_CONFIG_RE.test(text)) {
        matches.push("createTmux configFile /dev/null");
      }
      if (RAW_SERVER_START_RE.test(text)) {
        matches.push("raw tmux -f /dev/null new-session");
      }
      if (matches.length > 0) {
        findings.push({ file: file.replace(`${REPO_ROOT}/`, ""), matches });
      }
    }

    const selfText = await readFile(SELF_PATH, "utf8");
    expect(CREATE_TMUX_CONFIG_RE.test(selfText)).toBe(false);
    expect(RAW_SERVER_START_RE.test(selfText)).toBe(false);
    expect(findings).toEqual([]);
  });
});
