// Unit tests for the explicit tmux binary routing seam in src/abstractions/tmux.ts.
//
// The goal here is narrow: prove that `binaryPath` pins the namespace to
// the requested binary path and that the test stays socket-isolated.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTmux } from "../../../src/abstractions/tmux.ts";
import { installSpawnRecorder } from "../../helpers/spawn-recorder.ts";

describe("createTmux binaryPath", () => {
  test("explicit binaryPath is used for the tmux spawn command", async () => {
    const recorder = installSpawnRecorder();
    const socketPath = join(tmpdir(), "atmux-binary-routing.sock");
    try {
      const tmux = createTmux({ socketPath, binaryPath: "/vendored/tmux" });
      await tmux.server.hasServer();
      expect(recorder.calls[0]?.cmd[0]).toBe("/vendored/tmux");
      expect(recorder.calls[0]?.cmd).toContain("-S");
      expect(recorder.calls[0]?.cmd).toContain(socketPath);
    } finally {
      recorder.restore();
    }
  });

  test("blank binaryPath fails closed before any spawn occurs", () => {
    const recorder = installSpawnRecorder();
    const socketPath = join(tmpdir(), "atmux-binary-routing-empty.sock");
    try {
      expect(() => createTmux({ socketPath, binaryPath: "   " })).toThrow(/binaryPath must be a non-empty absolute path/);
      expect(recorder.calls).toHaveLength(0);
    } finally {
      recorder.restore();
    }
  });

  test("relative binaryPath fails closed before any spawn occurs", () => {
    const recorder = installSpawnRecorder();
    const socketPath = join(tmpdir(), "atmux-binary-routing-relative.sock");
    try {
      expect(() => createTmux({ socketPath, binaryPath: "bin/tmux" })).toThrow(/binaryPath must be an absolute path/);
      expect(recorder.calls).toHaveLength(0);
    } finally {
      recorder.restore();
    }
  });
});
