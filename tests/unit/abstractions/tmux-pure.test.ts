import { describe, expect, test } from "bun:test";
import {
  buildSetPaneRoleArgv,
  PANE_LIST_FIELDS,
  PANE_LIST_FORMAT,
  paneRowToObject,
  serializePaneTarget,
} from "../../../src/abstractions/tmux.ts";

const compileOnly = () => false;

describe("pane metadata seams", () => {
  test("pane list format keeps the stable field order", () => {
    expect(PANE_LIST_FIELDS).toEqual([
      "id",
      "index",
      "pid",
      "title",
      "left",
      "width",
      "height",
      "role",
    ]);
    expect(PANE_LIST_FORMAT).toBe(
      "#{pane_id}\t#{pane_index}\t#{pane_pid}\t#{pane_title}\t#{pane_left}\t#{pane_width}\t#{pane_height}\t#{@atmux_driver_pane_role}",
    );
  });

  test("paneRowToObject coerces numeric fields and preserves role metadata", () => {
    const pane = paneRowToObject({
      id: "%42",
      index: "3",
      pid: "9876",
      title: "shell",
      left: "12",
      width: "80",
      height: "24",
      role: "driver",
    });

    expect(pane).toEqual({
      id: "%42",
      index: 3,
      pid: 9876,
      title: "shell",
      left: 12,
      width: 80,
      height: 24,
      role: "driver",
    });
    expect(typeof pane.index).toBe("number");
    expect(typeof pane.pid).toBe("number");
    expect(typeof pane.left).toBe("number");
    expect(typeof pane.width).toBe("number");
    expect(typeof pane.height).toBe("number");
  });

  test("paneRowToObject keeps blank optional metadata absent and left zero numeric", () => {
    const missing = paneRowToObject({
      index: "7",
      pid: "100",
      title: "shell",
      width: "80",
      height: "24",
    });
    expect(missing).toEqual({
      index: 7,
      pid: 100,
      title: "shell",
      width: 80,
      height: 24,
    });
    expect("id" in missing).toBe(false);
    expect("left" in missing).toBe(false);
    expect("role" in missing).toBe(false);

    const blank = paneRowToObject({
      id: "",
      index: "7",
      pid: "100",
      title: "shell",
      left: "",
      width: "80",
      height: "24",
      role: "",
    });
    expect(blank).toEqual({
      index: 7,
      pid: 100,
      title: "shell",
      width: 80,
      height: 24,
    });
    expect("id" in blank).toBe(false);
    expect("left" in blank).toBe(false);
    expect("role" in blank).toBe(false);

    const leftZero = paneRowToObject({
      index: "7",
      pid: "100",
      title: "shell",
      left: "0",
      width: "80",
      height: "24",
    });
    expect(leftZero.left).toBe(0);
    expect("left" in leftZero).toBe(true);

    const role = paneRowToObject({
      index: "7",
      pid: "100",
      title: "shell",
      width: "80",
      height: "24",
      role: "scheduler",
    });
    expect(role.role).toBe("scheduler");
    expect("role" in role).toBe(true);
  });

  test("buildSetPaneRoleArgv targets pane scope and does not use send-keys", () => {
    const argv = buildSetPaneRoleArgv(
      { sessionName: "demo", windowIndex: 2, paneIndex: 3 },
      "worker",
    );

    expect(argv).toEqual([
      "set-option",
      "-p",
      "-t",
      "demo:2.3",
      "@atmux_driver_pane_role",
      "worker",
    ]);
    expect(argv).not.toContain("send-keys");
    expect(argv[0]).toBe("set-option");
    expect(argv[1]).toBe("-p");
  });

  test("buildSetPaneRoleArgv accepts explicit pane IDs", () => {
    const argv = buildSetPaneRoleArgv({ paneId: "%42" }, "attention");
    expect(argv).toEqual(["set-option", "-p", "-t", "%42", "@atmux_driver_pane_role", "attention"]);
    expect(serializePaneTarget({ paneId: "%42" })).toBe("%42");
    expect(() => serializePaneTarget({ paneId: "demo:2" } as never)).toThrow(TypeError);
  });

  test("serializePaneTarget validates structured pane ids before serialization", () => {
    expect(serializePaneTarget({ sessionName: "demo", windowIndex: 2, paneIndex: 3 })).toBe(
      "demo:2.3",
    );
    expect(() =>
      serializePaneTarget({ sessionName: "", windowIndex: 2, paneIndex: 3 } as never),
    ).toThrow(TypeError);
    expect(() =>
      serializePaneTarget({ sessionName: "demo", windowIndex: -1, paneIndex: 3 } as never),
    ).toThrow(TypeError);
    expect(() =>
      serializePaneTarget({ sessionName: "demo", windowIndex: 2.5, paneIndex: 3 } as never),
    ).toThrow(TypeError);
    expect(() =>
      serializePaneTarget({ sessionName: "demo", windowIndex: 2, paneIndex: "x" } as never),
    ).toThrow(TypeError);
  });

  test("buildSetPaneRoleArgv rejects runtime-only bogus role values", () => {
    expect(() => buildSetPaneRoleArgv({ paneId: "%42" }, "driver" as never)).toThrow(TypeError);
    expect(() => buildSetPaneRoleArgv({ paneId: "%42" }, "" as never)).toThrow(TypeError);
    expect(() => buildSetPaneRoleArgv({ paneId: "%42" }, "Worker" as never)).toThrow(TypeError);
  });

  test("window-shaped targets are rejected at the type boundary", () => {
    const windowTarget = { sessionName: "demo", windowIndex: 2 };

    if (compileOnly()) {
      // @ts-expect-error -- pane role writes require a pane target, not a window target.
      buildSetPaneRoleArgv(windowTarget, "worker");
    }

    expect(true).toBe(true);
  });

  test("raw strings and bogus role values are rejected at the type boundary", () => {
    if (compileOnly()) {
      // @ts-expect-error -- raw strings are not valid pane role targets.
      buildSetPaneRoleArgv("demo:2", "worker");
    }
    if (compileOnly()) {
      // @ts-expect-error -- only worker/attention are valid role values.
      buildSetPaneRoleArgv({ paneId: "%42" }, "driver");
    }

    expect(true).toBe(true);
  });
});
