export const DRIVER_PANE_ROLE_METADATA_KEY = "@atmux_driver_pane_role" as const;
export const DRIVER_PANE_ROLE_WORKER = "worker" as const;
export const DRIVER_PANE_ROLE_ATTENTION = "attention" as const;

export type DriverPaneRole = typeof DRIVER_PANE_ROLE_WORKER | typeof DRIVER_PANE_ROLE_ATTENTION;

export interface DriverPane {
  id: string;
  index: number;
  pid: number;
  left: number;
  role?: string | null;
}

export type DriverPanePairReasonCode =
  | "pair.zero_panes"
  | "pair.singleton.safe_absent_role"
  | "pair.singleton.safe_worker_role"
  | "pair.singleton.attention_role"
  | "pair.singleton.unknown_role"
  | "pair.two.valid"
  | "pair.two.missing_role"
  | "pair.two.unknown_role"
  | "pair.two.duplicate_worker"
  | "pair.two.duplicate_attention"
  | "pair.two.reversed_geometry"
  | "pair.too_many_panes";

export interface DriverPanePairDiagnostics {
  reasonCode: DriverPanePairReasonCode;
  doctorCommand: "atmux doctor";
  diagnostics: readonly [string, string];
}

export interface DriverPanePairPlanAddAttention extends DriverPanePairDiagnostics {
  decision: "plan-add-attention";
  keepPane: DriverPane;
  addPane: {
    metadataKey: typeof DRIVER_PANE_ROLE_METADATA_KEY;
    role: typeof DRIVER_PANE_ROLE_ATTENTION;
  };
}

export interface DriverPanePairPlanNoop extends DriverPanePairDiagnostics {
  decision: "noop";
  workerPane: DriverPane & { role: typeof DRIVER_PANE_ROLE_WORKER };
  attentionPane: DriverPane & { role: typeof DRIVER_PANE_ROLE_ATTENTION };
}

export interface DriverPanePairPlanFailClosed extends DriverPanePairDiagnostics {
  decision: "fail-closed";
}

export type DriverPanePairPlan =
  | DriverPanePairPlanAddAttention
  | DriverPanePairPlanNoop
  | DriverPanePairPlanFailClosed;

type NormalizedRole = "absent" | "unknown" | DriverPaneRole;

function normalizeRole(role: string | null | undefined): NormalizedRole {
  if (role === undefined || role === null) {
    return "absent";
  }
  if (role === DRIVER_PANE_ROLE_WORKER || role === DRIVER_PANE_ROLE_ATTENTION) {
    return role;
  }
  return "unknown";
}

function doctorDiagnostics(problem: string): readonly [string, string] {
  return [problem, "Run atmux doctor to inspect driver-pane roles and geometry."];
}

function failClosed(
  reasonCode: DriverPanePairReasonCode,
  problem: string,
): DriverPanePairPlanFailClosed {
  return {
    decision: "fail-closed",
    reasonCode,
    doctorCommand: "atmux doctor",
    diagnostics: doctorDiagnostics(problem),
  };
}

/**
 * Pure classifier/planner for the driver-pane pair.
 *
 * It accepts a snapshot of live pane metadata and returns one of:
 * - `noop` when the pair is valid and ordered left-to-right
 * - `plan-add-attention` when a single worker pane is safe to keep
 *   and the missing attention pane should be added
 * - `fail-closed` for every other shape
 */
export function planDriverPanePair(panes: readonly DriverPane[]): DriverPanePairPlan {
  switch (panes.length) {
    case 0:
      return failClosed("pair.zero_panes", "No driver panes were found.");
    case 1: {
      const pane = panes[0] as DriverPane;
      const role = normalizeRole(pane.role);
      if (role === "absent" || role === DRIVER_PANE_ROLE_WORKER) {
        return {
          decision: "plan-add-attention",
          reasonCode:
            role === "absent"
              ? "pair.singleton.safe_absent_role"
              : "pair.singleton.safe_worker_role",
          doctorCommand: "atmux doctor",
          diagnostics: doctorDiagnostics(
            role === "absent"
              ? "A single unlabelled pane is safe to keep."
              : "A single worker pane is safe to keep.",
          ),
          keepPane: pane,
          addPane: {
            metadataKey: DRIVER_PANE_ROLE_METADATA_KEY,
            role: DRIVER_PANE_ROLE_ATTENTION,
          },
        };
      }
      if (role === DRIVER_PANE_ROLE_ATTENTION) {
        return failClosed(
          "pair.singleton.attention_role",
          "A singleton attention pane is not a safe driver-pair shape.",
        );
      }
      return failClosed(
        "pair.singleton.unknown_role",
        "A singleton pane with an unknown driver-pair role is not safe.",
      );
    }
    case 2: {
      const firstPane = panes[0] as DriverPane;
      const secondPane = panes[1] as DriverPane;
      const firstRole = normalizeRole(firstPane.role);
      const secondRole = normalizeRole(secondPane.role);

      if (firstRole === "absent" || secondRole === "absent") {
        return failClosed("pair.two.missing_role", "Exactly two driver panes require both roles.");
      }
      if (firstRole === "unknown" || secondRole === "unknown") {
        return failClosed(
          "pair.two.unknown_role",
          "Exactly two driver panes cannot include unknown roles.",
        );
      }
      if (firstRole === secondRole && firstRole === DRIVER_PANE_ROLE_WORKER) {
        return failClosed(
          "pair.two.duplicate_worker",
          "Exactly two driver panes cannot both be workers.",
        );
      }
      if (firstRole === secondRole && firstRole === DRIVER_PANE_ROLE_ATTENTION) {
        return failClosed(
          "pair.two.duplicate_attention",
          "Exactly two driver panes cannot both be attention panes.",
        );
      }

      let workerPane: DriverPane;
      let attentionPane: DriverPane;
      if (firstRole === DRIVER_PANE_ROLE_WORKER) {
        workerPane = firstPane;
        attentionPane = secondPane;
      } else {
        workerPane = secondPane;
        attentionPane = firstPane;
      }

      if (workerPane.left < attentionPane.left) {
        return {
          decision: "noop",
          reasonCode: "pair.two.valid",
          doctorCommand: "atmux doctor",
          diagnostics: doctorDiagnostics("The driver pair is valid and ordered left-to-right."),
          workerPane: { ...workerPane, role: DRIVER_PANE_ROLE_WORKER },
          attentionPane: { ...attentionPane, role: DRIVER_PANE_ROLE_ATTENTION },
        };
      }

      return failClosed(
        "pair.two.reversed_geometry",
        "The worker pane must sit left of the attention pane.",
      );
    }
    default:
      return failClosed(
        "pair.too_many_panes",
        "More than two driver panes is not a safe driver-pair shape.",
      );
  }
}
