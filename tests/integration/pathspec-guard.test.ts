// integration: ADR-0058 (b) — the pathspec guard refuses a commit whose staged
// paths escape the Task's declared '## Files' section.
//
// The defect it exists for is sibling absorption: a lint-staged sweep, or a
// plain `git commit` over an index someone else already added to, pulls another
// teammate's files into this commit. Measured at 3 incidents in 6 hours on
// u-n-u-m/root before the ADR.
//
// Driven as a real subprocess against real bodies. `--staged-from` feeds the
// staged set directly so the assertions are about the GUARD, not about setting
// up a git index.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "..", "..", "scripts", "pathspec-guard.sh");

const BODY_WITH_PATHSPEC = `# Some Task

## Files

- \`scripts/pathspec-guard.sh\`
- \`tests/integration/pathspec-guard.test.ts\`
- \`docs/RUNBOOK-commits.md\`

## Scope
Prose that must not be parsed as a path.
`;

function runGuard(
  staged: string[],
  opts: { body?: string; env?: Record<string, string> } = {},
): { status: number; stdout: string; stderr: string; auditPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pathspec-guard-"));
  const bodyFile = join(dir, "body.md");
  writeFileSync(bodyFile, opts.body ?? BODY_WITH_PATHSPEC);
  const auditPath = join(dir, "audit.jsonl");

  const r = spawnSync(
    "bash",
    [GUARD, "--body-file", bodyFile, "--staged-from", "-"],
    {
      input: `${staged.join("\n")}\n`,
      encoding: "utf8",
      env: {
        ...process.env,
        ATMUX_PATHSPEC_AUDIT: auditPath,
        ATMUX_MEMBER: "tester",
        ...(opts.env ?? {}),
      },
    },
  );
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    auditPath,
  };
}

describe("pathspec-guard (ADR-0058 b)", () => {
  test("(a) every staged path inside the pathspec → exit 0", () => {
    const r = runGuard([
      "scripts/pathspec-guard.sh",
      "docs/RUNBOOK-commits.md",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("clean");
  });

  test("(b) a path outside the pathspec → non-zero, and it is NAMED", () => {
    // The sibling's file. This is the whole point: it is plausible, it is
    // adjacent, and nothing about it looks wrong in a diff summary.
    const r = runGuard([
      "scripts/pathspec-guard.sh",
      "src/core/host-registry.ts",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/core/host-registry.ts");
    // The clean path must not be listed as a VIOLATION. Scope the check to the
    // violations block — the message also echoes the whole declared pathspec
    // further down, and a naive whole-stderr match hits that instead.
    const violations = r.stderr.split("The Task declares:")[0];
    expect(violations).toContain("src/core/host-registry.ts");
    expect(violations).not.toContain("scripts/pathspec-guard.sh");
  });

  test("(b') the guard fails on the CONDITION, not always", () => {
    // Same body, same guard, one path moved inside the spec. If this passed
    // while (b) failed for any other reason, (b) would prove nothing.
    const outside = runGuard(["src/core/host-registry.ts"]);
    const inside = runGuard(["tests/integration/pathspec-guard.test.ts"]);
    expect(outside.status).toBe(1);
    expect(inside.status).toBe(0);
  });

  test("(c) ATMUX_PATHSPEC_GUARD=off short-circuits AND audits", () => {
    const r = runGuard(["src/core/host-registry.ts"], {
      env: { ATMUX_PATHSPEC_GUARD: "off" },
    });
    expect(r.status).toBe(0);
    // Opting out is allowed; opting out SILENTLY is not — a recovery commit is
    // legitimate, and hiding that it bypassed the guard is what makes the next
    // incident unattributable.
    expect(existsSync(r.auditPath)).toBe(true);
    const audit = readFileSync(r.auditPath, "utf8");
    expect(audit).toContain("opted-out");
    expect(audit).toContain("tester");
  });

  test("a Task with no '## Files' section is NOT judged", () => {
    // Legacy Tasks predate the convention. Failing them closed would block the
    // whole board, so the guard warns and passes — which is also what lets this
    // ship before every Task carries a pathspec.
    const r = runGuard(["anything/at/all.ts"], {
      body: "# Task\n\n## Scope\nNo Files section here.\n",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("no \"## Files\" pathspec");
  });

  test("a directory entry covers the files beneath it", () => {
    const r = runGuard(["docs/RUNBOOK-commits.md"], {
      body: "# Task\n\n## Files\n\n- `docs/`\n",
    });
    expect(r.status).toBe(0);
  });

  test("prose in the Files section is not mistaken for a path", () => {
    // Real bodies annotate their bullets. Only the first token is a path, and
    // a trailing note must not become a phantom glob that matches everything.
    const r = runGuard(["src/somewhere/else.ts"], {
      body:
        "# Task\n\n## Files\n\n- `scripts/only-this.sh` — the single file this Task may touch\n",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/somewhere/else.ts");
  });
});
