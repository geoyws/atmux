/**
 * Harness self-tests for `pre-state.ts` — ADR-029 row-level pre-state hook.
 *
 * These tests live under `tests/parity/` and are excluded from the
 * lcov-gate denominator per ADR-009 §2 (`tests/**` exclusion). They
 * exist for behavioural correctness — catching apply-loop bugs before
 * they cause silent false-greens at matrix-row evaluation time. Drift
 * surfaces here, not via a mysterious parity divergence later
 * (CLAUDE.md "verify green from the right path").
 *
 * Pair: `tests/parity/pre-state.ts` (apply-loop implementation);
 *       `tests/parity/matrix.ts` (`ParityRow.preState` type);
 *       `docs/adr-bun/029-phase3-state-mutating-lane-scope.md` §3.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyPreState } from "./pre-state.ts";

describe("applyPreState — ADR-029 row-level pre-state hook", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "atmux-prestate-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("undefined preState is a no-op", async () => {
    await applyPreState(dir, undefined);
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
  });

  test("empty preState is a no-op", async () => {
    await applyPreState(dir, {});
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
  });

  test("JSON value writes canonicalised JSON with 2-space indent + trailing newline", async () => {
    await applyPreState(dir, {
      ".atmux/kanban.json": { tasks: [{ id: "t-seed1", subject: "seed" }] },
    });
    const content = await fs.readFile(path.join(dir, ".atmux/kanban.json"), "utf8");
    expect(content).toBe(
      '{\n  "tasks": [\n    {\n      "id": "t-seed1",\n      "subject": "seed"\n    }\n  ]\n}\n',
    );
  });

  test("string value writes verbatim (no newline coercion)", async () => {
    await applyPreState(dir, {
      ".atmux/driver-inbox.md": "# Existing content\n- entry\n",
    });
    const content = await fs.readFile(path.join(dir, ".atmux/driver-inbox.md"), "utf8");
    expect(content).toBe("# Existing content\n- entry\n");
  });

  test("intermediate dirs are created (mkdir -p)", async () => {
    await applyPreState(dir, {
      ".atmux/inboxes/lead.json": { pending: [], inProgress: [], done: [] },
    });
    const stat = await fs.stat(path.join(dir, ".atmux/inboxes"));
    expect(stat.isDirectory()).toBe(true);
    const content = await fs.readFile(path.join(dir, ".atmux/inboxes/lead.json"), "utf8");
    expect(content).toContain('"pending": []');
  });

  test("existing file at relPath is overwritten", async () => {
    await fs.mkdir(path.join(dir, ".atmux"), { recursive: true });
    await fs.writeFile(path.join(dir, ".atmux/kanban.json"), '{"tasks":[]}');
    await applyPreState(dir, {
      ".atmux/kanban.json": { tasks: [{ id: "t-overwrite" }] },
    });
    const content = await fs.readFile(path.join(dir, ".atmux/kanban.json"), "utf8");
    expect(content).toContain('"id": "t-overwrite"');
    expect(content).not.toContain('"tasks":[]');
  });

  test("multiple entries write in iteration order", async () => {
    await applyPreState(dir, {
      ".atmux/kanban.json": { tasks: [] },
      ".atmux/inboxes/lead.json": { pending: [], inProgress: [], done: [] },
      ".atmux/driver-inbox.md": "",
    });
    const k = await fs.readFile(path.join(dir, ".atmux/kanban.json"), "utf8");
    const ib = await fs.readFile(path.join(dir, ".atmux/inboxes/lead.json"), "utf8");
    const di = await fs.readFile(path.join(dir, ".atmux/driver-inbox.md"), "utf8");
    expect(k).toContain('"tasks"');
    expect(ib).toContain('"pending"');
    expect(di).toBe("");
  });

  test("number / boolean / null JSON values stringify correctly", async () => {
    await applyPreState(dir, {
      "config.json": { count: 42, enabled: true, parent: null },
    });
    const content = await fs.readFile(path.join(dir, "config.json"), "utf8");
    expect(content).toBe('{\n  "count": 42,\n  "enabled": true,\n  "parent": null\n}\n');
  });
});
