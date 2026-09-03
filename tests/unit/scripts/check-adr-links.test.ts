import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../../scripts/check-adr-links.sh");

interface RunResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function makeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adr-links-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "docs", "adr"), { recursive: true });
  await copyFile(SCRIPT, join(root, "scripts", "check-adr-links.sh"));

  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = join(root, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, contents);
  }

  return root;
}

async function runScript(root: string): Promise<RunResult> {
  const proc = Bun.spawn(["/bin/bash", join(root, "scripts", "check-adr-links.sh")], {
    cwd: root,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { exit, stdout, stderr };
}

describe("check-adr-links.sh", () => {
  test("passes when both exact basenames and bare ADR references resolve", async () => {
    const root = await makeFixture({
      "docs/adr/001-root.md": [
        "# ADR-001: root",
        "",
        "See [ADR-002](002-linked.md) and ADR-002.",
        "",
      ].join("\n"),
      "docs/adr/002-linked.md": ["# ADR-002: linked", ""].join("\n"),
    });
    try {
      const r = await runScript(root);
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe("✓ check-adr-links: all ADR cross-references resolve in docs/adr/\n");
      expect(r.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a dangling Markdown basename when the slug does not exist", async () => {
    const root = await makeFixture({
      "docs/adr/001-root.md": ["# ADR-001: root", "", "See [ADR-002](002-renamed.md).", ""].join(
        "\n",
      ),
      "docs/adr/002-linked.md": ["# ADR-002: linked", ""].join("\n"),
    });
    try {
      const r = await runScript(root);
      expect(r.exit).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("✗ 001-root.md");
      expect(r.stderr).toContain("dangling md-link: 002-renamed.md");
      expect(r.stderr).toContain("✗ check-adr-links: 1 dangling ADR target(s) across docs/adr/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports a dangling bare ADR reference with zero-padded lookup semantics", async () => {
    const root = await makeFixture({
      "docs/adr/001-root.md": [
        "# ADR-001: root",
        "",
        "See ADR-67 for the older discussion.",
        "",
      ].join("\n"),
    });
    try {
      const r = await runScript(root);
      expect(r.exit).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("dangling ADR-ref: ADR-67 (no docs/adr/067-*.md)");
      expect(r.stderr).toContain("✗ check-adr-links: 1 dangling ADR target(s) across docs/adr/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("groups findings by source file and still exits 1 on multiple failures", async () => {
    const root = await makeFixture({
      "docs/adr/001-alpha.md": [
        "# ADR-001: alpha",
        "",
        "See [ADR-777](777-missing.md) and [ADR-777](777-missing.md) and ADR-88 and ADR-88.",
        "",
      ].join("\n"),
      "docs/adr/002-beta.md": ["# ADR-002: beta", "", "See [ADR-333](333-missing.md).", ""].join(
        "\n",
      ),
    });
    try {
      const r = await runScript(root);
      expect(r.exit).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr.split("✗ 001-alpha.md").length - 1).toBe(1);
      expect(r.stderr.split("✗ 002-beta.md").length - 1).toBe(1);
      expect(r.stderr.split("dangling md-link: 777-missing.md").length - 1).toBe(1);
      expect(r.stderr.split("dangling ADR-ref: ADR-88 (no docs/adr/088-*.md)").length - 1).toBe(1);
      expect(r.stderr).toContain("dangling md-link: 333-missing.md");
      expect(r.stderr).toContain("✗ check-adr-links: 3 dangling ADR target(s) across docs/adr/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
