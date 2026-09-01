import { now } from "../../abstractions/time.ts";
import {
  type BudgetProbeState,
  DEFAULT_STALE_THRESHOLD_SEC,
  loadBudgetMap,
} from "../../core/account-pool.ts";
import { type LoadedCockpit, loadCockpit } from "../../core/cockpit.ts";
import {
  type HostPressureVerdict,
  type ProbeHostPressureDeps,
  probeHostPressure,
} from "../../core/host-pressure.ts";
import type { DoctorRow } from "./types.ts";

// ---------- host-pressure probe (ADR-184 §Amendment 2026-05-21) ----------

/** Pure mapping. State-snapshot → doctor row. Tests inject verdicts to
 *  hit every branch without /proc reads. */
export function hostPressureRows(verdict: HostPressureVerdict): DoctorRow[] {
  if (verdict.skipped) {
    return [
      {
        status: "info",
        label: "host-pressure",
        detail: "probe skipped — non-Linux platform (gate inactive)",
      },
    ];
  }
  if (verdict.probe === null || verdict.thresholds === null) {
    // Linux but probe failed somehow — surface as info, don't block.
    return [
      {
        status: "info",
        label: "host-pressure",
        detail: "probe data unavailable",
      },
    ];
  }
  const loadCeil = verdict.probe.cpuCores * verdict.thresholds.maxLoadRatio;
  const memMb = verdict.probe.memAvailableMb;
  const memMbThreshold = verdict.thresholds.minMemMb;
  // Disk joins the row for the same reason it joins the verdict
  // (ADR-273 §Supplement): a host-pressure row that never mentions disk
  // reads as "pressure is fine" on a box that is 99% full.
  const diskParts = verdict.probe.disks.map(
    (d) => `${d.mount} ${d.usedPercent}%/${verdict.thresholds?.maxDiskPercent ?? 90}%`,
  );
  for (const m of verdict.probe.missingMounts) diskParts.push(`${m} NOT REPORTED`);
  const baseDetail = [
    `load 15min ${verdict.probe.loadAvg15min.toFixed(2)} / ${loadCeil.toFixed(2)} ceil`,
    `mem ${memMb}MB / ${memMbThreshold}MB floor`,
    `disk ${diskParts.length > 0 ? diskParts.join(", ") : "none reported"}`,
    `${verdict.probe.cpuCores} cores`,
  ].join(" · ");
  if (verdict.ok) {
    return [
      {
        status: "green",
        label: "host-pressure",
        detail: `under threshold — ${baseDetail}`,
      },
    ];
  }
  return [
    {
      status: "yellow",
      label: "host-pressure",
      detail: `OVER threshold — ${baseDetail}`,
      hint:
        `${verdict.reasons.join("; ")} — spawn-epic will REFUSE until pressure drops. ` +
        `override: --force-spawn (use sparingly); tune: ATMUX_SPAWN_MAX_LOAD_RATIO + ATMUX_SPAWN_MIN_FREE_MB + ATMUX_SPAWN_MAX_DISK_PERCENT env.`,
    },
  ];
}

/** Verb-side wrapper — runs the live probe + maps to rows. Production
 *  default; tests inject `probeFn` to drive specific verdicts. */
export async function checkHostPressure(
  probeFn: (deps: ProbeHostPressureDeps) => Promise<HostPressureVerdict> = probeHostPressure,
): Promise<DoctorRow[]> {
  const verdict = await probeFn({});
  return hostPressureRows(verdict);
}

// ---------- claudeAccountPool probe (ADR-199 §D1 / §Impl-status) ----------

/** State-snapshot the pure mapper resolves to a doctor row. Built by the
 *  verb-side wrapper from the cockpit + budget probe state; injected
 *  directly in unit tests so every branch is reachable without I/O. */
export interface ClaudeAccountPoolVerdict {
  /** Number of entries in `cockpit.claudeAccountPool[]`. 0 = unconfigured. */
  poolSize: number;
  /** Pool labels whose budget probe data is fresh (probedAt within the
   *  stale threshold). */
  freshLabels: readonly string[];
  /** Pool labels whose budget probe data is stale or missing entirely. */
  staleLabels: readonly string[];
  /** Names of cockpit teams whose `claudeAccount` is unset. Drives the
   *  RED verdict when the pool is ALSO empty (spawn-epic has no account
   *  source for these teams). */
  teamsMissingAccount: readonly string[];
}

/**
 * Pure mapping. State-snapshot → doctor row. ADR-199 §D1 final paragraph
 * + §Impl-status deferred row:
 *
 *   - GREEN  — pool populated AND every entry has fresh (non-stale) budget
 *              probe data (the selector can score every account).
 *   - YELLOW — pool populated but SOME entries are stale/missing budget
 *              data (selector falls back to weight + order for those; ADR-199
 *              §"Stale-grace contract"). Partial staleness.
 *   - RED    — pool EMPTY *and* a cockpit team has `claudeAccount` unset:
 *              spawn-epic has no account source for that team (the 401-on-
 *              bootstrap regression class ADR-199 closes).
 *   - INFO   — pool empty but every team already pins its own
 *              `claudeAccount` (pool is an optimisation, not load-bearing
 *              here — spawn-epic falls back to the inheritance chain).
 *
 * Tests inject verdicts to hit every branch without filesystem I/O.
 */
export function claudeAccountPoolRows(verdict: ClaudeAccountPoolVerdict): DoctorRow[] {
  if (verdict.poolSize === 0) {
    if (verdict.teamsMissingAccount.length > 0) {
      return [
        {
          status: "red",
          label: "claudeAccountPool",
          detail: `pool empty + ${verdict.teamsMissingAccount.length} team(s) without claudeAccount: ${verdict.teamsMissingAccount.join(", ")}`,
          hint:
            "populate cockpit.claudeAccountPool[] (ADR-199 §D1) so spawn-epic can draw a least-loaded account, " +
            "or pin each team's claudeAccount explicitly — otherwise a cage bootstrap 401s on a fresh OAuth login.",
        },
      ];
    }
    return [
      {
        status: "info",
        label: "claudeAccountPool",
        detail:
          "pool unconfigured; every team pins its own claudeAccount (spawn-epic uses the inheritance chain)",
      },
    ];
  }
  if (verdict.staleLabels.length === 0) {
    return [
      {
        status: "green",
        label: "claudeAccountPool",
        detail: `${verdict.poolSize} account(s), all fresh budget data — ${verdict.freshLabels.join(", ")}`,
      },
    ];
  }
  return [
    {
      status: "yellow",
      label: "claudeAccountPool",
      detail: `${verdict.poolSize} account(s); ${verdict.staleLabels.length} with stale/missing budget data: ${verdict.staleLabels.join(", ")}`,
      hint:
        "run the budget probe (coordination:budget skill) to refresh ~/.atmux/state/budget-probe-<label>.json; " +
        "stale entries fall back to weight + pool-array order in selectAccount() (ADR-199 §Stale-grace contract).",
    },
  ];
}

/** Dependencies for {@link checkClaudeAccountPool} — all injectable so
 *  unit tests drive the full wrapper without touching the filesystem. */
export interface CheckClaudeAccountPoolDeps {
  /** Cockpit reader. Default loads `~/.atmux/cockpit.json`; returns `null`
   *  on absence / unreadable so a first-run host emits a benign info row
   *  rather than tanking the probe. */
  loadCockpitFn?: () => Promise<LoadedCockpit | null>;
  /** Budget-probe-state reader keyed by pool label. Default delegates to
   *  `account-pool.ts::loadBudgetMap` against `home`. */
  loadBudgetMapFn?: (
    pool: readonly { label: string }[],
    home: string,
  ) => Promise<Map<string, BudgetProbeState | null>>;
  /** Current epoch seconds for staleness. Defaults to `now() / 1000`. */
  nowSec?: number;
  /** Stale threshold in seconds. Defaults to {@link DEFAULT_STALE_THRESHOLD_SEC}. */
  staleThresholdSec?: number;
}

/**
 * Verb-side wrapper — loads the cockpit pool + per-label budget probe
 * state, computes staleness, and delegates to {@link claudeAccountPoolRows}.
 * Tolerant of a missing cockpit (returns the empty-pool branch) so a
 * first-run host doesn't fail the probe. ADR-199 §Impl-status deferred row.
 */
export async function checkClaudeAccountPool(
  home: string | undefined,
  deps: CheckClaudeAccountPoolDeps = {},
): Promise<DoctorRow[]> {
  const loadCockpitFn =
    deps.loadCockpitFn ??
    (async () => {
      try {
        return await loadCockpit();
      } catch {
        // No cockpit / unreadable / schema error → benign (no pool).
        return null;
      }
    });
  const cockpit = await loadCockpitFn();
  const pool = cockpit?.claudeAccountPool ?? [];
  const teamsMissingAccount = (cockpit?.teams ?? [])
    .filter((t) => t.claudeAccount === undefined)
    .map((t) => t.name);

  if (pool.length === 0) {
    return claudeAccountPoolRows({
      poolSize: 0,
      freshLabels: [],
      staleLabels: [],
      teamsMissingAccount,
    });
  }

  const loadBudgetMapFn = deps.loadBudgetMapFn ?? loadBudgetMap;
  const budgetByLabel = await loadBudgetMapFn(pool, home ?? "");
  const nowSec = deps.nowSec ?? Math.floor(now() / 1000);
  const staleThresholdSec = deps.staleThresholdSec ?? DEFAULT_STALE_THRESHOLD_SEC;

  const freshLabels: string[] = [];
  const staleLabels: string[] = [];
  for (const entry of pool) {
    const state = budgetByLabel.get(entry.label) ?? null;
    const stale = state === null || nowSec - state.probedAt > staleThresholdSec;
    (stale ? staleLabels : freshLabels).push(entry.label);
  }

  return claudeAccountPoolRows({
    poolSize: pool.length,
    freshLabels,
    staleLabels,
    teamsMissingAccount,
  });
}
