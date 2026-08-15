// Unit tests for src/core/cage-session.ts — ADR-162 cage handle resolver.
//
// Drives every branch of `resolveCageSession` with a REAL temp
// `.atmux/state/session.txt` anchor. Asserts BOTH halves of the returned
// CageSession (sessionName + socketPath) so a regression in either field
// fails the suite — a feature-broken impl could not pass these.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCageSession } from "../../../src/core/cage-session.ts";

describe("resolveCageSession (name + socket)", () => {
  let root: string;
  let atmuxDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cage-session-"));
    atmuxDir = join(root, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeAnchor(value: string): Promise<void> {
    await mkdir(join(atmuxDir, "state"), { recursive: true });
    await writeFile(join(atmuxDir, "state", "session.txt"), value);
  }

  test("anchor absent + no tmuxTmpdir → HYPHEN name + legacy /tmp socket (rentx)", async () => {
    const out = await resolveCageSession({ name: "rentx" }, atmuxDir);
    expect(out.sessionName).toBe("atmux-rentx");
    expect(out.socketPath).toBe("/tmp/atmux-rentx/sock");
  });

  test("anchor absent preserves dashes in team name (ifca-docs)", async () => {
    // Regression guard: the legacy underscore form `atmux_ifca-docs` would
    // mismatch the `atmux-ifca-docs` session start.ts actually creates.
    const out = await resolveCageSession({ name: "ifca-docs" }, atmuxDir);
    expect(out.sessionName).toBe("atmux-ifca-docs");
    expect(out.socketPath).toBe("/tmp/atmux-ifca-docs/sock");
  });

  test("UNDERSCORE anchor honoured verbatim + tmuxTmpdir socket (unum)", async () => {
    await writeAnchor("atmux_unum");
    const out = await resolveCageSession(
      { name: "unum", tmuxTmpdir: "/tmp/atmux-unum" },
      atmuxDir,
    );
    expect(out.sessionName).toBe("atmux_unum");
    expect(out.socketPath).toBe("/tmp/atmux-unum/sock");
  });

  test("UNDERSCORE anchor honoured verbatim + tmuxTmpdir socket (sopx)", async () => {
    await writeAnchor("atmux_sopx");
    const out = await resolveCageSession(
      { name: "sopx", tmuxTmpdir: "/tmp/atmux-sopx" },
      atmuxDir,
    );
    expect(out.sessionName).toBe("atmux_sopx");
    expect(out.socketPath).toBe("/tmp/atmux-sopx/sock");
  });

  test("'atmux' anchor (bare) + tmuxTmpdir socket — atmux dogfood team", async () => {
    await writeAnchor("atmux");
    const out = await resolveCageSession(
      { name: "atmux", tmuxTmpdir: "/tmp/atmux-atmux" },
      atmuxDir,
    );
    expect(out.sessionName).toBe("atmux");
    expect(out.socketPath).toBe("/tmp/atmux-atmux/sock");
  });

  test("'atmux' team with NO anchor special-cases to bare 'atmux'", async () => {
    // Branch: anchor absent AND team.name === "atmux" → bare session name,
    // no tmuxTmpdir → legacy /tmp/atmux/sock socket.
    const out = await resolveCageSession({ name: "atmux" }, atmuxDir);
    expect(out.sessionName).toBe("atmux");
    expect(out.socketPath).toBe("/tmp/atmux/sock");
  });

  test("empty-string anchor treated as absent → HYPHEN fallback (rentx)", async () => {
    await writeAnchor("   \n");
    const out = await resolveCageSession({ name: "rentx" }, atmuxDir);
    expect(out.sessionName).toBe("atmux-rentx");
    expect(out.socketPath).toBe("/tmp/atmux-rentx/sock");
  });

  test("trailing-newline anchor is trimmed; socket derives from stripped name", async () => {
    await writeAnchor("atmux-custom\n\n");
    const out = await resolveCageSession({ name: "rentx" }, atmuxDir);
    expect(out.sessionName).toBe("atmux-custom");
    expect(out.socketPath).toBe("/tmp/atmux-custom/sock");
  });

  test("empty-string tmuxTmpdir falls through to legacy /tmp socket", async () => {
    // Branch: tmuxTmpdir present but zero-length → NOT a per-team cage,
    // must use the legacy /tmp/<sessionName>/sock derivation.
    const out = await resolveCageSession({ name: "rentx", tmuxTmpdir: "" }, atmuxDir);
    expect(out.sessionName).toBe("atmux-rentx");
    expect(out.socketPath).toBe("/tmp/atmux-rentx/sock");
  });

  test("tmuxTmpdir socket ignores the session NAME (anchor-independent path)", async () => {
    // When tmuxTmpdir is set the socket is `<tmuxTmpdir>/sock` regardless
    // of the resolved session name — proves the two halves are derived
    // independently (anchor drives name, tmuxTmpdir drives socket).
    await writeAnchor("atmux_weird_name");
    const out = await resolveCageSession(
      { name: "unum", tmuxTmpdir: "/custom/tmuxdir" },
      atmuxDir,
    );
    expect(out.sessionName).toBe("atmux_weird_name");
    expect(out.socketPath).toBe("/custom/tmuxdir/sock");
  });
});
