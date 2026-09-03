import { describe, expect, test } from "bun:test";
import {
  DRIVER_PANE_ROLE_ATTENTION,
  DRIVER_PANE_ROLE_METADATA_KEY,
  DRIVER_PANE_ROLE_WORKER,
  type DriverPane,
  type DriverPanePairPlanAddAttention,
  type DriverPanePairPlanFailClosed,
  type DriverPanePairPlanNoop,
  planDriverPanePair,
} from "../../../src/core/driver-pair.ts";

function pane(
  overrides: Partial<DriverPane> & Pick<DriverPane, "id" | "index" | "pid" | "left">,
): DriverPane {
  const base: DriverPane = {
    id: overrides.id,
    index: overrides.index,
    pid: overrides.pid,
    left: overrides.left,
  };
  if (overrides.role !== undefined) {
    base.role = overrides.role;
  }
  return base;
}

function expectDoctorGuidance(plan: {
  diagnostics: readonly [string, string];
  doctorCommand: "atmux doctor";
}) {
  expect(plan.doctorCommand).toBe("atmux doctor");
  expect(plan.diagnostics[1]).toContain("atmux doctor");
  expect(plan.diagnostics.join(" ")).not.toMatch(/delete|swap|restart/i);
}

function expectPlanAddAttention(
  plan: ReturnType<typeof planDriverPanePair>,
): DriverPanePairPlanAddAttention {
  expect(plan.decision).toBe("plan-add-attention");
  return plan as DriverPanePairPlanAddAttention;
}

function expectPlanNoop(plan: ReturnType<typeof planDriverPanePair>): DriverPanePairPlanNoop {
  expect(plan.decision).toBe("noop");
  return plan as DriverPanePairPlanNoop;
}

function expectFailClosed(
  plan: ReturnType<typeof planDriverPanePair>,
): DriverPanePairPlanFailClosed {
  expect(plan.decision).toBe("fail-closed");
  return plan as DriverPanePairPlanFailClosed;
}

describe("driver-pair constants", () => {
  test("exports the metadata key and stable role values", () => {
    expect(DRIVER_PANE_ROLE_METADATA_KEY).toBe("@atmux_driver_pane_role");
    expect(DRIVER_PANE_ROLE_WORKER).toBe("worker");
    expect(DRIVER_PANE_ROLE_ATTENTION).toBe("attention");
  });
});

describe("planDriverPanePair — zero panes and singleton safety", () => {
  test("zero panes fail closed", () => {
    const plan = expectFailClosed(planDriverPanePair([]));
    expect(plan.reasonCode).toBe("pair.zero_panes");
    expectDoctorGuidance(plan);
  });

  test("singleton without a role is safe and plans an attention pane", () => {
    const existing = pane({ id: "%1", index: 0, pid: 11, left: 0 });
    const plan = expectPlanAddAttention(planDriverPanePair([existing]));

    expect(plan.reasonCode).toBe("pair.singleton.safe_absent_role");
    expect(plan.keepPane).toBe(existing);
    expect(plan.addPane).toEqual({
      metadataKey: "@atmux_driver_pane_role",
      role: "attention",
    });
    expectDoctorGuidance(plan);
  });

  test("singleton worker is safe and plans an attention pane", () => {
    const existing = pane({ id: "%2", index: 1, pid: 12, left: 4, role: "worker" });
    const plan = expectPlanAddAttention(planDriverPanePair([existing]));

    expect(plan.reasonCode).toBe("pair.singleton.safe_worker_role");
    expect(plan.keepPane).toBe(existing);
    expect(plan.addPane.role).toBe("attention");
    expectDoctorGuidance(plan);
  });

  test("singleton attention fails closed", () => {
    const plan = expectFailClosed(
      planDriverPanePair([pane({ id: "%3", index: 2, pid: 13, left: 9, role: "attention" })]),
    );

    expect(plan.reasonCode).toBe("pair.singleton.attention_role");
    expectDoctorGuidance(plan);
  });

  test("singleton unknown role fails closed", () => {
    const plan = expectFailClosed(
      planDriverPanePair([pane({ id: "%4", index: 3, pid: 14, left: 12, role: "planner" })]),
    );

    expect(plan.reasonCode).toBe("pair.singleton.unknown_role");
    expectDoctorGuidance(plan);
  });
});

describe("planDriverPanePair — valid pair and geometry", () => {
  test("worker left of attention is noop regardless of input order", () => {
    const attention = pane({ id: "%5", index: 5, pid: 15, left: 20, role: "attention" });
    const worker = pane({ id: "%6", index: 6, pid: 16, left: 3, role: "worker" });
    const plan = expectPlanNoop(planDriverPanePair([attention, worker]));

    expect(plan.reasonCode).toBe("pair.two.valid");
    expect(plan.workerPane.role).toBe("worker");
    expect(plan.attentionPane.role).toBe("attention");
    expect(plan.workerPane.id).toBe("%6");
    expect(plan.attentionPane.id).toBe("%5");
    expectDoctorGuidance(plan);
  });

  test("reversed geometry fails closed", () => {
    const worker = pane({ id: "%7", index: 7, pid: 17, left: 30, role: "worker" });
    const attention = pane({ id: "%8", index: 8, pid: 18, left: 2, role: "attention" });
    const plan = expectFailClosed(planDriverPanePair([worker, attention]));

    expect(plan.reasonCode).toBe("pair.two.reversed_geometry");
    expectDoctorGuidance(plan);
  });

  test("equal left geometry also fails closed", () => {
    const worker = pane({ id: "%9", index: 9, pid: 19, left: 5, role: "worker" });
    const attention = pane({ id: "%10", index: 10, pid: 20, left: 5, role: "attention" });
    const plan = expectFailClosed(planDriverPanePair([worker, attention]));

    expect(plan.reasonCode).toBe("pair.two.reversed_geometry");
  });
});

describe("planDriverPanePair — invalid two-pane shapes", () => {
  test("missing role fails closed", () => {
    const worker = pane({ id: "%11", index: 11, pid: 21, left: 1, role: "worker" });
    const missing = pane({ id: "%12", index: 12, pid: 22, left: 9 });
    const plan = expectFailClosed(planDriverPanePair([worker, missing]));

    expect(plan.reasonCode).toBe("pair.two.missing_role");
    expectDoctorGuidance(plan);
  });

  test("unknown role in a two-pane pair fails closed", () => {
    const worker = pane({ id: "%13", index: 13, pid: 23, left: 1, role: "worker" });
    const unknown = pane({ id: "%14", index: 14, pid: 24, left: 9, role: "planner" });
    const plan = expectFailClosed(planDriverPanePair([worker, unknown]));

    expect(plan.reasonCode).toBe("pair.two.unknown_role");
    expectDoctorGuidance(plan);
  });

  test("duplicate workers fail closed", () => {
    const left = pane({ id: "%15", index: 15, pid: 25, left: 1, role: "worker" });
    const right = pane({ id: "%16", index: 16, pid: 26, left: 9, role: "worker" });
    const plan = expectFailClosed(planDriverPanePair([left, right]));

    expect(plan.reasonCode).toBe("pair.two.duplicate_worker");
    expectDoctorGuidance(plan);
  });

  test("duplicate attention panes fail closed", () => {
    const left = pane({ id: "%17", index: 17, pid: 27, left: 1, role: "attention" });
    const right = pane({ id: "%18", index: 18, pid: 28, left: 9, role: "attention" });
    const plan = expectFailClosed(planDriverPanePair([left, right]));

    expect(plan.reasonCode).toBe("pair.two.duplicate_attention");
    expectDoctorGuidance(plan);
  });
});

describe("planDriverPanePair — multiplicity boundaries", () => {
  test("more than two panes fail closed", () => {
    const plan = expectFailClosed(
      planDriverPanePair([
        pane({ id: "%19", index: 19, pid: 29, left: 0, role: "worker" }),
        pane({ id: "%20", index: 20, pid: 30, left: 5, role: "attention" }),
        pane({ id: "%21", index: 21, pid: 31, left: 9, role: "worker" }),
      ]),
    );

    expect(plan.reasonCode).toBe("pair.too_many_panes");
    expectDoctorGuidance(plan);
  });
});
