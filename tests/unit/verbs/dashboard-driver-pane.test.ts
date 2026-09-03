// Unit tests for dashboard.ts driver-pane block — ADR-064 §4
// (Task t-c8a70988). Direct unit tests on `composeFrame` so we
// don't need to spin the full dashboard loop or real tmux.

import { describe, expect, test } from "bun:test";
import type { DriverPaneHealth } from "../../../src/core/driver-pane-health.ts";
import { composeFrame, type FrameSnapshot } from "../../../src/verbs/dashboard.ts";

const BASE_FRAME: Omit<FrameSnapshot, "driverPane"> = {
  intervalSec: 5,
  status: "🟢 TEAM atmux  session=atmux-x [up]\n",
  recentKanban: "t-1 todo  test\n",
  driverInbox: "- [P0] do thing\n",
  outbox: "[lead → driver] hello\n",
};

describe("dashboard composeFrame — driver-pane block", () => {
  test("driverPane absent → no '─── driver pane ───' block in frame (back-compat)", () => {
    const frame = composeFrame(BASE_FRAME);
    expect(frame).not.toContain("─── driver pane ───");
    // driver-inbox block still renders.
    expect(frame).toContain("─── driver-inbox open ───");
  });

  test("driverPane configured=false → block skipped", () => {
    const dp: DriverPaneHealth = {
      configured: false,
      windowExists: false,
      state: null,
      evidence: "",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    expect(frame).not.toContain("─── driver pane ───");
  });

  test("driverPane configured + windowExists + READY → block rendered", () => {
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: true,
      state: "READY",
      evidence: "tokens · esc to interrupt",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    expect(frame).toContain("─── driver pane ───");
    expect(frame).toContain("configured=y  window=exists  state=READY");
    expect(frame).toContain("evidence: tokens · esc to interrupt");
  });

  test("driverPane configured + no window → block shows window=missing + state=n/a", () => {
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: false,
      state: null,
      evidence: "",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    expect(frame).toContain("─── driver pane ───");
    expect(frame).toContain("window=missing");
    expect(frame).toContain("state=n/a");
  });

  test("driverPane pairDecision=unavailable renders observer failure instead of state", () => {
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: true,
      state: null,
      pairDecision: "unavailable",
      pairReason: "pair.observer.list_panes_failed",
      evidence: "tmux pane list failed",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    expect(frame).toContain("pair=observer-failure");
    expect(frame).toContain("reason=pair.observer.list_panes_failed");
    expect(frame).not.toContain("window=exists  state=");
  });

  test("driverPane list-window failure also renders observer failure", () => {
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: false,
      state: null,
      pairDecision: "unavailable",
      pairReason: "pair.observer.list_windows_failed",
      evidence: "tmux list-windows failed",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    expect(frame).toContain("pair=observer-failure");
    expect(frame).toContain("reason=pair.observer.list_windows_failed");
  });

  test("driverPane pairDecision=fail-closed renders the fail-closed reason", () => {
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: true,
      state: null,
      pairDecision: "fail-closed",
      pairReason: "pair.observer.missing_pane_metadata",
      evidence: "missing pane metadata",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    expect(frame).toContain("pair=fail-closed");
    expect(frame).toContain("reason=pair.observer.missing_pane_metadata");
  });

  test("driverPane pairDecision=plan-add-attention renders the add-attention reason", () => {
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: true,
      state: null,
      pairDecision: "plan-add-attention",
      pairReason: "pair.singleton.safe_worker_role",
      evidence: "worker singleton",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    expect(frame).toContain("pair=plan-add-attention");
    expect(frame).toContain("reason=pair.singleton.safe_worker_role");
  });

  test("driverPane pairDecision=noop + READY shows the worker state", () => {
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: true,
      pairDecision: "noop",
      pairReason: "pair.two.valid",
      state: "READY",
      evidence: "worker pane ready",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    expect(frame).toContain("state=READY");
    expect(frame).toContain("worker pane ready");
  });

  test("driver-pane block appears ABOVE driver-inbox block (ordering)", () => {
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: true,
      state: "READY",
      evidence: "",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    const paneIdx = frame.indexOf("─── driver pane ───");
    const inboxIdx = frame.indexOf("─── driver-inbox open ───");
    expect(paneIdx).toBeGreaterThan(-1);
    expect(inboxIdx).toBeGreaterThan(paneIdx);
  });

  test("pair row is emitted before evidence in the dashboard block", () => {
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: true,
      state: null,
      pairDecision: "unavailable",
      pairReason: "pair.observer.list_windows_failed",
      evidence: "tmux list-windows failed",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    const pairIdx = frame.indexOf("pair=observer-failure");
    const evidenceIdx = frame.indexOf("evidence:");
    expect(pairIdx).toBeGreaterThan(-1);
    expect(evidenceIdx).toBeGreaterThan(pairIdx);
  });

  test("evidence is truncated to 80 chars in the dashboard block", () => {
    const longEvidence = "x".repeat(200);
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: true,
      state: "MODAL",
      evidence: longEvidence,
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    // 80 x's followed by ellipsis, NOT the full 200.
    expect(frame).toContain(`evidence: ${"x".repeat(80)}…`);
    expect(frame).not.toContain("x".repeat(81));
  });

  test("frame structure: status → kanban → driver-pane → driver-inbox → outbox", () => {
    const dp: DriverPaneHealth = {
      configured: true,
      windowExists: true,
      state: "READY",
      evidence: "",
    };
    const frame = composeFrame({ ...BASE_FRAME, driverPane: dp });
    const order = [
      "TEAM atmux", // status
      "─── recent kanban ───",
      "─── driver pane ───",
      "─── driver-inbox open ───",
      "─── lead-outbox open ───",
    ];
    let cursor = 0;
    for (const marker of order) {
      const idx = frame.indexOf(marker, cursor);
      expect(idx).toBeGreaterThan(-1);
      cursor = idx + marker.length;
    }
  });
});
