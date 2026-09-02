import { describe, expect, test } from "bun:test";
import {
  checkTmuxVersionMismatch,
  checkVendoredTmuxBinary,
  TMUX_MIN_VERSION,
  TMUX_TESTED_VERSION,
} from "../../../src/verbs/doctor/tmux.ts";

function tmuxOk(stdout: string) {
  return Promise.resolve({
    exitCode: 0,
    stdout,
    stderr: "",
    argv: ["-V"],
    cmd: "tmux",
    signalled: null,
    durationMs: 0,
  });
}

describe("doctor/tmux contract split", () => {
  test("host and vendored checks stay on the accepted 3.6a contract", () => {
    expect(TMUX_MIN_VERSION).toBe("3.2");
    expect(TMUX_TESTED_VERSION).toBe("3.6a");
  });

  test("host version mismatch uses the live 3.6a contract", async () => {
    const rows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 3.6a"),
    });
    expect(rows).toEqual([]);
  });

  test("vendored binary uses the same accepted 3.6a contract", async () => {
    const rows = await checkVendoredTmuxBinary({
      existsSync: () => true,
      tmux: async () => tmuxOk("tmux 3.6a"),
    });
    expect(rows).toEqual([]);
  });

  test("host and vendored expectations are independent", async () => {
    const hostRows = await checkTmuxVersionMismatch({
      tmux: async () => tmuxOk("tmux 3.6b"),
    });
    const vendoredRows = await checkVendoredTmuxBinary({
      existsSync: () => true,
      tmux: async () => tmuxOk("tmux 3.6b"),
    });

    expect(hostRows[0]?.label).toBe("tmux-version-mismatch");
    expect(vendoredRows[0]?.label).toBe("vendored-tmux-version-drift");
    expect(hostRows[0]?.detail).toContain("3.6b");
    expect(vendoredRows[0]?.detail).toContain("3.6b");
    expect(vendoredRows[0]?.detail).toContain("3.6a");
  });
});
