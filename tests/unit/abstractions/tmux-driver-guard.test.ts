// ADR-239 §D2 + §A5 — unit tests for the no-send-keys-to-drivers runtime
// guard in src/abstractions/tmux.ts.
//
// Pure-fn coverage for extractWindowNameFromTargetString (name vs numeric
// vs malformed) + behavioral coverage for the guard firing on pane.sendKeys
// and buffer.pasteBuffer against driver / driver-N targets, plus
// pass-through for member / lead / numeric-indexed targets.
//
// The guard fires BEFORE any tmux subprocess is spawned, so these tests
// use a bogus socket path — the throw happens before tmux is touched.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTmux,
  DriverSendKeysViolation,
  extractWindowNameFromTargetString,
  type SendTarget,
} from "../../../src/abstractions/tmux.ts";

describe("extractWindowNameFromTargetString — parse the window-name segment", () => {
  test("named window — '<session>:driver' → 'driver'", () => {
    expect(extractWindowNameFromTargetString("atmux:driver")).toBe("driver");
  });

  test("named driver-N — '<session>:driver-3' → 'driver-3'", () => {
    expect(extractWindowNameFromTargetString("atmux:driver-3")).toBe("driver-3");
  });

  test("named window with pane suffix — '<session>:driver.0' → 'driver'", () => {
    expect(extractWindowNameFromTargetString("atmux:driver.0")).toBe("driver");
  });

  test("ADR-288 review: exact-match prefix — '<session>:=driver' → 'driver' (the `=` is stripped)", () => {
    expect(extractWindowNameFromTargetString("atmux:=driver")).toBe("driver");
    expect(extractWindowNameFromTargetString("atmux:=driver-2")).toBe("driver-2");
    expect(extractWindowNameFromTargetString("atmux:=driver-2.0")).toBe("driver-2");
    expect(extractWindowNameFromTargetString("atmux:=lead")).toBe("lead");
    // Bare `=` → empty window segment → not classifiable.
    expect(extractWindowNameFromTargetString("atmux:=")).toBeNull();
  });

  test("numeric index — '<session>:2' → null", () => {
    expect(extractWindowNameFromTargetString("atmux:2")).toBeNull();
  });

  test("numeric index with pane — '<session>:2.0' → null", () => {
    expect(extractWindowNameFromTargetString("atmux:2.0")).toBeNull();
  });

  test("no colon — 'just-a-name' → null", () => {
    expect(extractWindowNameFromTargetString("just-a-name")).toBeNull();
  });

  test("empty after colon — '<session>:' → null", () => {
    expect(extractWindowNameFromTargetString("atmux:")).toBeNull();
  });

  test("non-driver named windows — 'lead' / 'planner' / 'reviewer' surface unchanged", () => {
    expect(extractWindowNameFromTargetString("atmux:lead")).toBe("lead");
    expect(extractWindowNameFromTargetString("atmux:planner")).toBe("planner");
    expect(extractWindowNameFromTargetString("atmux:reviewer.0")).toBe("reviewer");
  });
});

describe("DriverSendKeysViolation — ADR-239 §D2 runtime guard", () => {
  const tmux = createTmux({ socketPath: join(tmpdir(), "atmux-test-bogus-socket") });

  test("pane.sendKeys against '<session>:driver' throws DriverSendKeysViolation", async () => {
    const target: SendTarget = {
      kind: "member",
      member: "driver",
      team: "atmux",
      target: "atmux:driver",
    };
    await expect(tmux.pane.sendKeys({ target, keys: "hello" })).rejects.toThrow(
      DriverSendKeysViolation,
    );
  });

  test("pane.sendKeys against '<session>:driver-2' throws DriverSendKeysViolation", async () => {
    const target: SendTarget = {
      kind: "member",
      member: "driver-2",
      team: "atmux",
      target: "atmux:driver-2",
    };
    await expect(tmux.pane.sendKeys({ target, keys: "hello" })).rejects.toThrow(
      DriverSendKeysViolation,
    );
  });

  test("ADR-288 review: pane.sendKeys against exact-match '<session>:=driver' still throws", async () => {
    const target: SendTarget = {
      kind: "member",
      member: "driver",
      team: "atmux",
      target: "atmux:=driver",
    };
    await expect(tmux.pane.sendKeys({ target, keys: "hello" })).rejects.toThrow(
      DriverSendKeysViolation,
    );
  });

  test("ADR-288 review: pane.sendKeys against exact-match '<session>:=driver-2' still throws", async () => {
    const target: SendTarget = {
      kind: "member",
      member: "driver-2",
      team: "atmux",
      target: "atmux:=driver-2",
    };
    await expect(tmux.pane.sendKeys({ target, keys: "hello" })).rejects.toThrow(
      DriverSendKeysViolation,
    );
  });

  test("pane.sendKeys against '<session>:driver-99' throws DriverSendKeysViolation", async () => {
    const target: SendTarget = {
      kind: "member",
      member: "driver-99",
      team: "atmux",
      target: "atmux:driver-99",
    };
    await expect(tmux.pane.sendKeys({ target, keys: "hello" })).rejects.toThrow(
      DriverSendKeysViolation,
    );
  });

  test("pane.sendKeys against driver.0 (pane suffix) still throws", async () => {
    const target: SendTarget = {
      kind: "member",
      member: "driver",
      team: "atmux",
      target: "atmux:driver.0",
    };
    await expect(tmux.pane.sendKeys({ target, keys: "hello" })).rejects.toThrow(
      DriverSendKeysViolation,
    );
  });

  test("buffer.pasteBuffer against driver target also throws (symmetric guard)", async () => {
    const target: SendTarget = {
      kind: "member",
      member: "driver",
      team: "atmux",
      target: "atmux:driver",
    };
    await expect(tmux.buffer.pasteBuffer({ target })).rejects.toThrow(DriverSendKeysViolation);
  });

  test("pane.sendKeys against numeric '<session>:1' does NOT throw the driver guard (passes through to tmux)", async () => {
    // The guard only checks NAMED windows. Numeric indices fall through
    // to tmux — which will fail with TmuxError since the socket is bogus,
    // but NOT with DriverSendKeysViolation.
    const target: SendTarget = {
      kind: "member",
      member: "anyone",
      team: "atmux",
      target: "atmux:1",
    };
    await expect(tmux.pane.sendKeys({ target, keys: "hello" })).rejects.not.toThrow(
      DriverSendKeysViolation,
    );
  });

  test("pane.sendKeys against named 'lead' does NOT throw the driver guard", async () => {
    const target: SendTarget = {
      kind: "lead",
      team: "atmux",
      target: "atmux:lead",
    };
    await expect(tmux.pane.sendKeys({ target, keys: "hello" })).rejects.not.toThrow(
      DriverSendKeysViolation,
    );
  });

  test("pane.sendKeys admits the distinct _bot target without widening driver", async () => {
    const target: SendTarget = {
      kind: "bot",
      team: "atmux",
      target: "atmux:_bot",
    };
    await expect(tmux.pane.sendKeys({ target, keys: "hello" })).rejects.not.toThrow(
      DriverSendKeysViolation,
    );
  });

  test("pane.sendKeys against 'driverless' (driver-prefix but not the pattern) does NOT throw", async () => {
    const target: SendTarget = {
      kind: "member",
      member: "driverless",
      team: "atmux",
      target: "atmux:driverless",
    };
    await expect(tmux.pane.sendKeys({ target, keys: "hello" })).rejects.not.toThrow(
      DriverSendKeysViolation,
    );
  });

  test("DriverSendKeysViolation message names the pane + the target", () => {
    const err = new DriverSendKeysViolation("atmux:driver-2", "driver-2");
    expect(err.message).toContain("ADR-239 §D2");
    expect(err.message).toContain("driver-2");
    expect(err.message).toContain("atmux:driver-2");
    expect(err.name).toBe("DriverSendKeysViolation");
  });
});
