import { spawn as defaultSpawn, type SpawnResult } from "../../abstractions/spawn.ts";
import { TMUX_CHILD_UNSET_ENV } from "../../abstractions/tmux.ts";
import { resolveTmuxBin } from "../../core/resolve-tmux-bin.ts";

// ---------- Row + report shape ----------

export type DoctorStatus = "green" | "yellow" | "red" | "info";

export interface DoctorRow {
  status: DoctorStatus;
  label: string;
  detail?: string;
  hint?: string;
}

export interface DoctorReport {
  rows: DoctorRow[];
  redCount: number;
  yellowCount: number;
}

/** Pure: aggregate rows into a DoctorReport with counts. */
export function buildReport(rows: ReadonlyArray<DoctorRow>): DoctorReport {
  let red = 0;
  let yellow = 0;
  for (const r of rows) {
    if (r.status === "red") red += 1;
    else if (r.status === "yellow") yellow += 1;
  }
  return { rows: [...rows], redCount: red, yellowCount: yellow };
}

export function defaultWhich(cmd: string): string | null {
  return Bun.which(cmd);
}

/** Spawn a single git command from cwd. Test injection point. */
export type GitSpawn = (argv: ReadonlyArray<string>) => Promise<SpawnResult>;

export const defaultGitSpawn: GitSpawn = (argv) =>
  defaultSpawn({ cmd: "git", argv, expectExitCode: "any", timeoutMs: 15_000 });

export function truncateEvidence(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Spawn override for the tmux probes. Test-injection point. */
export type TmuxSpawn = (argv: ReadonlyArray<string>) => Promise<SpawnResult>;

export const defaultTmuxSpawn: TmuxSpawn = (argv) =>
  defaultSpawn({
    cmd: resolveTmuxBin(),
    argv,
    expectExitCode: "any",
    timeoutMs: 5_000,
    // ADR-281: a doctor probe is read-only against tmux STATE, but tmux
    // starts a server implicitly for any subcommand that needs one — so a
    // probe against a dead socket can be the process whose environ gets
    // frozen. Same child-env policy as `abstractions/tmux.ts`.
    unsetEnv: TMUX_CHILD_UNSET_ENV,
  });
