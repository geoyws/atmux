// Unit tests for src/core/name-resolver.ts — ADR-162 canonical session
// name substrate. Mirrors the cageSessionName matrix in cockpit.test.ts
// and the resolveCageSession name-half matrix from e-b84c4d48 S2.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionName } from "../../../src/core/name-resolver.ts";

const ATMUX_DIR = "/some/root/.atmux";

/** Build an injectable anchor reader that returns `body` for the canonical
 *  session.txt path and asserts it is never asked for any other path. */
function anchorReader(body: string | null): (path: string) => Promise<string | null> {
  const expected = join(ATMUX_DIR, "state", "session.txt");
  return async (path: string) => {
    expect(path).toBe(expected);
    return body;
  };
}

describe("buildSessionName — anchor-first, HYPHEN fallback (ADR-162)", () => {
  test("absent anchor → atmux-<team> HYPHEN canonical", async () => {
    expect(
      await buildSessionName({ name: "rentx" }, { atmuxDir: ATMUX_DIR, readAnchor: anchorReader(null) }),
    ).toBe("atmux-rentx");
  });

  test("absent anchor, hyphenated team name passes through untouched", async () => {
    expect(
      await buildSessionName({ name: "ifca-docs" }, { atmuxDir: ATMUX_DIR, readAnchor: anchorReader(null) }),
    ).toBe("atmux-ifca-docs");
  });

  test("anchor with legacy UNDERSCORE form is used verbatim", async () => {
    expect(
      await buildSessionName({ name: "unum" }, { atmuxDir: ATMUX_DIR, readAnchor: anchorReader("atmux_unum") }),
    ).toBe("atmux_unum");
  });

  test("anchor wins over the hyphen fallback even when it disagrees with team.name", async () => {
    // If the fallback leaked through, this would be 'atmux-sopx', not the anchor value.
    expect(
      await buildSessionName({ name: "sopx" }, { atmuxDir: ATMUX_DIR, readAnchor: anchorReader("atmux_sopx") }),
    ).toBe("atmux_sopx");
  });

  test("anchor holding the bare 'atmux' session is honored", async () => {
    expect(
      await buildSessionName({ name: "atmux" }, { atmuxDir: ATMUX_DIR, readAnchor: anchorReader("atmux") }),
    ).toBe("atmux");
  });

  test("empty anchor file falls through to hyphen fallback", async () => {
    expect(
      await buildSessionName({ name: "rentx" }, { atmuxDir: ATMUX_DIR, readAnchor: anchorReader("") }),
    ).toBe("atmux-rentx");
  });

  test("whitespace-only anchor file falls through to hyphen fallback", async () => {
    expect(
      await buildSessionName({ name: "rentx" }, { atmuxDir: ATMUX_DIR, readAnchor: anchorReader("   \n\t ") }),
    ).toBe("atmux-rentx");
  });

  test("trailing-newline anchor is stripped, not used verbatim", async () => {
    expect(
      await buildSessionName({ name: "rentx" }, { atmuxDir: ATMUX_DIR, readAnchor: anchorReader("atmux-prod\n") }),
    ).toBe("atmux-prod");
  });

  test("only trailing whitespace is stripped; leading whitespace is preserved", async () => {
    // \s+$ strips the trailing tab but NOT the inner content; a leading
    // space (unlikely in practice) survives so the test pins the regex shape.
    expect(
      await buildSessionName({ name: "rentx" }, { atmuxDir: ATMUX_DIR, readAnchor: anchorReader("atmux-x\t") }),
    ).toBe("atmux-x");
  });
});

describe("buildSessionName — real filesystem anchor path", () => {
  let dir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-name-resolver-test-"));
    atmuxDir = join(dir, ".atmux");
    await mkdir(join(atmuxDir, "state"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("no session.txt on disk → hyphen fallback (default reader, ENOENT path)", async () => {
    // Exercises the real readTextOrNull default — no injected reader.
    expect(await buildSessionName({ name: "rentx" }, { atmuxDir })).toBe("atmux-rentx");
  });

  test("session.txt on disk is read and stripped (default reader)", async () => {
    await writeFile(join(atmuxDir, "state", "session.txt"), "atmux_dogfood\n", "utf8");
    expect(await buildSessionName({ name: "dogfood" }, { atmuxDir })).toBe("atmux_dogfood");
  });
});
