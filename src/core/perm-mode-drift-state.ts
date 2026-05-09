// ADR-057 §D4a: 24h dedup state for permission-mode drift findings.
//
// Each whip-tick scans member panes for the `⏵⏵ <mode> on` indicator.
// When `mode !== "auto"` the tick emits a [whip-perm-mode-drift] finding
// — but only ONCE per member per 24h, so a member that's been in
// `accept-edits` mode all day doesn't burn 288 dedup-bypassed pings.
//
// State file: `<atmuxDir>/state/perm-mode-drift-state.json`. Schema
// is a flat per-member map:
//
//   {
//     "<member>": <epoch-of-last-fire-in-seconds>,
//     ...
//   }
//
// Window: 24h fixed (matches the cursor-self-heal pattern + the rest
// of ADR-057's per-member dedup posture). Caller passes `nowSec`;
// module is clock-agnostic for testability.
//
// Anti-pattern guard: corrupt/malformed state → empty map. Losing the
// dedup memory is cheaper than crashing the whip-tick (mirrors
// cursor-self-heal-state.ts and budget-warning-state.ts).

import { join } from "node:path";
import { atomicWrite, readTextOrNull } from "../abstractions/fs.ts";

const STATE_FILENAME = "perm-mode-drift-state.json";

/** Default dedup window — 24h per ADR-057 §D4 brief. */
export const DEFAULT_DEDUP_TTL_SEC = 24 * 60 * 60;

export function permModeDriftStatePath(atmuxDir: string): string {
  return join(atmuxDir, "state", STATE_FILENAME);
}

/** State map: `<member>` → epoch-seconds-of-last-drift-fire. */
export type PermModeDriftState = Record<string, number>;

/** Read state from disk; empty map on missing/malformed. */
export async function loadPermModeDriftState(atmuxDir: string): Promise<PermModeDriftState> {
  const path = permModeDriftStatePath(atmuxDir);
  const txt = await readTextOrNull(path);
  if (txt === null) return {};
  try {
    const parsed: unknown = JSON.parse(txt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: PermModeDriftState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Atomic write via abstractions/fs. */
export async function savePermModeDriftState(
  atmuxDir: string,
  state: PermModeDriftState,
): Promise<void> {
  await atomicWrite(permModeDriftStatePath(atmuxDir), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * True when the drift finding for `member` should fire this tick:
 * never fired before, OR last fire is older than `ttlSec`.
 */
export function shouldFireDrift(
  state: PermModeDriftState,
  member: string,
  nowSec: number,
  ttlSec: number = DEFAULT_DEDUP_TTL_SEC,
): boolean {
  const last = state[member];
  if (last === undefined) return true;
  return nowSec - last > ttlSec;
}

/**
 * Record a drift fire — returns the next state with `member` stamped
 * at `nowSec`. Pure; caller persists via `savePermModeDriftState`.
 */
export function recordDrift(
  state: PermModeDriftState,
  member: string,
  nowSec: number,
): PermModeDriftState {
  return { ...state, [member]: nowSec };
}

// ---------- Pane-text classifier ----------

/**
 * Parse the permission-mode indicator from captured pane text. Claude
 * Code renders the active mode in the bottom status row as
 * `⏵⏵ <mode> on` (e.g. `⏵⏵ auto mode on`, `⏵⏵ accept edits on`,
 * `⏵⏵ don't ask on`). Default mode (no indicator) returns `"default"`.
 *
 * Returns the parsed mode token (lowercase, hyphen-normalized) OR
 * `null` when the pane text doesn't contain the marker (treated as
 * "indicator absent" — caller decides whether absence is fine, e.g.
 * for non-claude TUIs).
 */
export type PermissionMode = "auto" | "accept-edits" | "dont-ask" | "plan" | "default" | "unknown";

export function parsePermissionMode(paneText: string): PermissionMode | null {
  const m = paneText.match(/⏵⏵\s+([a-zA-Z][a-zA-Z' -]+?)\s+on\b/);
  if (m === null) return null;
  const raw = (m[1] ?? "").toLowerCase().trim();
  // Normalize `accept edits` → `accept-edits`, `don't ask` → `dont-ask`.
  if (raw === "auto" || raw === "auto mode") return "auto";
  if (raw.includes("accept edits")) return "accept-edits";
  if (raw.includes("don't ask") || raw.includes("dont ask")) return "dont-ask";
  if (raw.includes("plan")) return "plan";
  if (raw === "default") return "default";
  return "unknown";
}
