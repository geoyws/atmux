// Regression guard for the bundled cage tmux conf invariants (ADR-190).
//
// Codifies two ADR-190 rules as same-commit grep-style assertions so
// later conf maintenance can't silently regress them:
//   1. §Rule 1 — cage statusline is ZERO-FORK: the bundled
//      templates/tmux/atmux.conf contains NO `#(...)` fork tokens.
//      tmux 3.6a re-evaluates `#()` expansions on every pane-activity
//      event (not just status-interval ticks) → fork-storm at
//      multi-team-of-teams cage scale (ADR-190 §Context). The conf is
//      already zero-fork; this guard pins it.
//   2. §Rule 3 — status-interval is set EXPLICITLY to 15s (no longer
//      relying on tmux's implicit 15s default), so personal-config
//      drift can't tighten it below the helper TTL floor.
//
// Honest-test note (CLAUDE.md §"NO LIES"): if the conf regressed —
// a `#(...)` fork reintroduced, or the explicit status-interval line
// removed — these assertions fail. They read the real shipped file and
// match the real tokens, not a shape proxy.
//
// Closes e-63c97ed8 S1 T2 (`t-70e671ab`).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Project root — resolve from this test file's location (tests/regression).
const REPO_ROOT = join(import.meta.dir, "..", "..");
const CONF_PATH = join(REPO_ROOT, "templates", "tmux", "atmux.conf");

const conf = readFileSync(CONF_PATH, "utf8");

describe("templates/tmux/atmux.conf cage zero-fork invariant (ADR-190)", () => {
  test("(Rule 1) contains NO `#(` fork tokens", () => {
    // `#(` is the tmux shell-command format expansion that forks on
    // every pane-activity event. Forbidden in the bundled cage conf.
    // Collect with 1-based line numbers so a regression names the
    // offending line.
    const forkLines = conf
      .split("\n")
      .map((line, i) => ({ lineNo: i + 1, line }))
      .filter(({ line }) => line.includes("#("));

    expect(forkLines).toEqual([]);
  });

  test("(Rule 3) sets status-interval explicitly to 15", () => {
    expect(conf).toMatch(/^set -g status-interval 15\b/m);
  });

  test("(Rule 3) the status-interval line cites ADR-190", () => {
    // Same-commit doc-pointer: the explicit setting must carry its
    // rationale so the invariant survives conf maintenance.
    expect(conf).toMatch(/ADR-190/);
  });
});
