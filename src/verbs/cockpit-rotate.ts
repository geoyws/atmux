// ADR-167: `atmux cockpit rotate <session-name>` — Rung C canonical
// rotation verb for cockpit-level role panes (medic / sentinel / per-
// team driver). Closes the missing rung in /bruh's escalation chain
// (Rung A = member rotate, Rung B = lead rotate via medic, Rung C =
// this verb, Rung D = full cockpit rebuild).
//
// T2 scope (this file): argv parser + caller-scope gate + the four
// pre-flight gates + the three per-role respawn paths stubbed with TODO
// markers. Real gate logic lands in T3, real respawn matrix in T4,
// handoff write-path in T5, exhaustive tests in T6+T7, docs sweep + ADR
// flip 'proposed → accepted' in T8.
//
// Exit codes (ADR-167 §Decision + §OQ-5):
//   0   success
//   64  EX_USAGE        — argv parse failure (bubbles via UsageError)
//   65  EX_DATAERR      — pre-flight gate refusal (1-4)
//   70  EX_SOFTWARE     — respawn-step failure
//   78  EX_CONFIG       — caller-scope gate refusal (ConfigError; mirrors
//                         spawn-epic / dissolve-epic per ADR-033)

import { resolveCallerScope } from "../core/common.ts";
import { ConfigError, UsageError } from "../errors.ts";

/** Parsed shape for `atmux cockpit rotate` argv. */
export interface ParsedCockpitRotateArgs {
  /** Canonical session-name: `medic` | `sentinel` | `<team-name>`. */
  sessionName: string;
  /** Operator override for the four pre-flight gates. Gate 4 (never-
   *  rotate-superdriver) ignores this flag — see ADR-167 §Pre-flight
   *  gate matrix row 4. */
  force: boolean;
}

/** Session-names that the verb hard-refuses regardless of `--force`.
 *  Gate 4 (never-rotate-superdriver) fires before gates 1-3 because
 *  it's the cheapest + most load-bearing check — superdriver is the
 *  operator REPL pane (W1 per ADR-135) and rotating it would kill the
 *  operator's interactive session. */
const RESERVED_NEVER_ROTATE: ReadonlySet<string> = new Set(["superdriver"]);

/** Exit-code constants. Module-local — cli.ts maps AtmuxError tags via
 *  exitCodeForTag, but gate-1..3 refusals + respawn failures return
 *  numeric codes directly (cleaner than minting new error tags). */
const EX_OK = 0;
const EX_DATAERR = 65;
const EX_SOFTWARE = 70;

/** Parse `cockpit rotate` argv. The positional `<session-name>` is
 *  required; `--force` is the only flag. Unknown flags / extra
 *  positionals throw UsageError → exit 64. */
export function parseCockpitRotateArgs(args: ReadonlyArray<string>): ParsedCockpitRotateArgs {
  let sessionName: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    switch (a) {
      case "--force":
        force = true;
        break;
      default:
        if (a.startsWith("-")) {
          throw new UsageError({
            what: `cockpit rotate: unknown arg: ${a}`,
            hint: "usage: atmux cockpit rotate <medic|sentinel|<team-name>> [--force]",
          });
        }
        if (sessionName !== undefined) {
          throw new UsageError({
            what: `cockpit rotate: unexpected positional arg: ${a}`,
            hint: "only one <session-name> accepted",
          });
        }
        sessionName = a;
    }
  }

  if (sessionName === undefined || sessionName.length === 0) {
    throw new UsageError({
      what: "cockpit rotate: missing <session-name>",
      hint: "usage: atmux cockpit rotate <medic|sentinel|<team-name>> [--force]",
    });
  }

  return { sessionName, force };
}

/** Map a canonical session-name to one of the three per-role respawn
 *  paths. `medic` and `sentinel` are dedicated cockpit roles (W2 + W3
 *  per ADR-135 + ADR-158); anything else is interpreted as a team-name
 *  → per-team driver pane (W4+). Lead panes are out of scope — leads
 *  live in the team cage on per-team sockets per ADR-162; lead
 *  rotation continues to use Rung B (medic's `/team rotate-lead`). */
export function classifyRole(sessionName: string): "medic" | "sentinel" | "team-driver" {
  if (sessionName === "medic") return "medic";
  if (sessionName === "sentinel") return "sentinel";
  return "team-driver";
}

/** Test-injection seams for the rotate verb. */
export interface CockpitRotateOpts {
  /** Override `process.env`. Tests inject a curated subset. */
  env?: NodeJS.ProcessEnv;
  /** Override caller-scope resolution. Default uses ADR-033 env-based
   *  `resolveCallerScope`. Tests inject `() => "driver"` to bypass the
   *  gate without setting env. */
  callerScope?: () => string;
  /** Override stderr sink. Default writes to `process.stderr`. Tests
   *  capture into a string buffer to assert structured gate messages. */
  stderr?: (msg: string) => void;
}

/** Top-level entry. Returns numeric exit code per ADR-167:
 *
 *  - gate-4 (never-rotate-superdriver) refusal       → exit 65
 *  - caller-scope gate refusal (driver-only)         → throws ConfigError (exit 78)
 *  - gates 1-3 refusal (T3 impl)                     → exit 65
 *  - respawn failure (T4 impl)                       → exit 70
 *  - argv parse error                                → throws UsageError (exit 64)
 *  - success                                         → exit 0
 *
 *  Ordering: parser first, then gate-4 (cheapest + unconditional),
 *  then caller-scope, then gates 1-3, then respawn dispatch. */
export async function cockpitRotate(
  args: ReadonlyArray<string>,
  opts: CockpitRotateOpts = {},
): Promise<number> {
  const parsed = parseCockpitRotateArgs(args);
  const env = opts.env ?? process.env;
  const callerScope = opts.callerScope ?? (() => resolveCallerScope({ env }));
  const stderr = opts.stderr ?? ((msg: string) => process.stderr.write(msg));

  // Gate 4 — never-rotate-superdriver. Hard-refused regardless of
  // --force per ADR-167 §Pre-flight gate matrix row 4. Fires first
  // because it's cheapest + most load-bearing (rotating the operator
  // REPL pane would kill the interactive session).
  if (RESERVED_NEVER_ROTATE.has(parsed.sessionName)) {
    stderr(
      `gate-4-never-rotate-superdriver: '${parsed.sessionName}' is the operator REPL pane — ` +
        `rotation is unconditionally refused\n`,
    );
    return EX_DATAERR;
  }

  // Caller-scope gate per ADR-033. Cockpit rotation is high-consequence
  // (parallel to spawn-epic / dissolve-epic per ADR-167 §Caller-scope
  // gate); restricting to ATMUX_CALLER_SCOPE=driver matches the
  // existing pattern. ConfigError → exit 78 via exitCodeForTag.
  if (callerScope() !== "driver") {
    throw new ConfigError({
      what:
        "cockpit rotate: refused — caller scope is not 'driver'. " +
        "Set ATMUX_CALLER_SCOPE=driver in the calling shell (ADR-033 §Caller-scope gate).",
      hint: "from a driver pane: ATMUX_CALLER_SCOPE=driver atmux cockpit rotate <session-name>",
    });
  }

  // Pre-flight gates 1-3 (T3). Each refusal exits 65 with a structured
  // stderr line `gate-N-<name>: <reason>`. --force bypasses these but
  // NOT gate 4 (handled above).
  if (!parsed.force) {
    // TODO(T3 t-90be6b47): gate 1 — user-not-typing. Capture
    //   `<cockpit_session>:_superdriver` compose-box via tmux
    //   capture-pane; refuse if non-empty (operator may be about to
    //   reference target panes). Bypass: --force.
    //
    // TODO(T3 t-90be6b47): gate 2 — pane-idle. Capture target pane
    //   last 60s via tmux capture-pane -S -<N>; refuse if `✽` / `✻`
    //   / `Compacting` markers present per pane-state-classifier
    //   (ADR-155). Bypass: --force.
    //
    // TODO(T3 t-90be6b47): gate 3 — uptime. Read mtime of
    //   ~/.claude/teams/__cockpit__/<role>/session-start.txt; refuse
    //   if `<60min` ago (premature rotation, lost context). Bypass:
    //   --force.
  }

  // Per-role respawn matrix (T4). Each path:
  //   1. Assemble role-specific handoff payload (T5).
  //   2. Atomic-write handoff to ~/.claude/teams/__cockpit__/<role>/
  //      handoff.md (flock per ADR-005).
  //   3. safeSendKeysWithVerify Ctrl-C (ADR-138); 3s grace; HUP fallback.
  //   4. tmux kill-pane -t <cockpit_session>:<window>.
  //   5. Resolve claudeAccount wrapper (ADR-094 c-alias convention).
  //   6. Respawn via tmux new-window / respawn-window.
  //   7. Re-arm role-specific cadence (per-role inline, per OQ-4).
  //   8. Append outcome row to ~/.atmux/state/cockpit-rotate-audit.log
  //      (NDJSON). Audit row writes AFTER respawn so `outcome` reflects
  //      ground truth (per ADR-167 §Ordering invariant).
  //
  // T5 wires the handoff-write step in front of steps 3+ so the
  // rotation can be re-traced if a later step crashes mid-flight.
  const role = classifyRole(parsed.sessionName);
  switch (role) {
    case "medic":
      // TODO(T4 t-a245bbc8): medic respawn path. Handoff inputs (T5
      //   t-fe3464df): in-flight diagnosis state from src/verbs/medic.ts
      //   runtime + recent medic-source complaints (state.db
      //   complaints WHERE source_kind='medic' last N) + recent
      //   rotation calls (cockpit-rotate-audit.log WHERE role='medic'
      //   tail N).
      stderr(`cockpit rotate: medic respawn — NOT IMPLEMENTED (T4 t-a245bbc8)\n`);
      return EX_SOFTWARE;
    case "sentinel":
      // TODO(T4 t-a245bbc8): sentinel respawn path. Handoff inputs (T5
      //   t-fe3464df): whip-classifier state snapshot + NudgeAction
      //   history (per-team sentinel logs tail N) + recent escalations
      //   (audit log filtered to sentinel-escalated rows).
      stderr(`cockpit rotate: sentinel respawn — NOT IMPLEMENTED (T4 t-a245bbc8)\n`);
      return EX_SOFTWARE;
    case "team-driver":
      // TODO(T4 t-a245bbc8): team-driver respawn path. Handoff inputs
      //   (T5 t-fe3464df): recent tell-lead history (.atmux/lead-outbox
      //   .md or tells SQLite table tail N) + outbox state snapshot at
      //   rotation time. `parsed.sessionName` is the team-name; locate
      //   the W4+ cockpit window of that name.
      stderr(
        `cockpit rotate: team-driver respawn for '${parsed.sessionName}' ` +
          `— NOT IMPLEMENTED (T4 t-a245bbc8)\n`,
      );
      return EX_SOFTWARE;
  }

  // Unreachable — classifyRole returns one of three literals; the
  // switch above is exhaustive. Kept for TS-narrow safety; will be
  // replaced by a real success path in T4.
  return EX_OK;
}
