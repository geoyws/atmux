// Color mapping — emoji → Claude color string. Per ADR-164 §"Color mapping".
//
// Resolution order (highest priority wins):
//   1. Sidecar `.claude/team-colors.json` `_byMemberName[<name>]` exact match.
//   2. Sidecar top-level `<emoji>` → color.
//   3. Built-in fixed table below.
//   4. Deterministic random-from-pool seeded on `member.name` for unmapped
//      emoji (so the same member always lands on the same fallback color
//      across runs).
//
// The fixed table is NOT a closed enum — operators paint specific
// emoji-or-member combos via the sidecar without recompiling atmux.

import type { ColorSidecar } from "./types.ts";

/** Built-in seed table per ADR-164 §"Color mapping". Each band maps a set
 *  of emoji glyphs to a Claude color. */
const FIXED_EMOJI_TO_COLOR: ReadonlyMap<string, string> = new Map([
  // coordinator
  ["🧭", "white"],
  ["⚙️", "white"],
  ["🛠️", "white"],
  // planner
  ["🎯", "magenta"],
  ["🦊", "magenta"],
  ["🐺", "magenta"],
  // reviewer
  ["🔍", "cyan"],
  ["🦉", "cyan"],
  ["👁️", "cyan"],
  // BE-impl
  ["📦", "green"],
  ["🦔", "green"],
  ["🦫", "green"],
  // FE-impl
  ["🌸", "orange"],
  ["🌷", "orange"],
  ["🎨", "orange"],
  // docs
  ["🦦", "yellow"],
  ["📚", "yellow"],
  ["📝", "yellow"],
  // gitter / committer
  ["🌿", "green"],
  ["🌱", "green"],
  ["🍃", "green"],
  // ombudsman / enforcer
  ["⚖️", "red"],
  ["👮", "red"],
]);

/** Random-from-pool fallback set (Claude's standard color palette).
 *  Excludes `white` (reserved feel for coordinator band). */
const COLOR_POOL: readonly string[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "magenta",
];

/** FNV-1a 32-bit hash — deterministic, dependency-free, good enough for
 *  pool indexing. Same input → same output across runs / platforms. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Resolve the color for a member. `emoji` may be undefined when the
 *  atmux-side member has no emoji set; in that case fall back to the
 *  name-seeded pool. */
export function resolveColor(
  memberName: string,
  emoji: string | undefined,
  sidecar: ColorSidecar | null,
): string {
  // 1. Sidecar by-member-name (highest priority).
  if (sidecar?._byMemberName) {
    const named = sidecar._byMemberName[memberName];
    if (typeof named === "string" && named.length > 0) return named;
  }
  // 2. Sidecar top-level emoji override.
  if (emoji !== undefined && emoji.length > 0 && sidecar) {
    const overridden = sidecar[emoji];
    if (typeof overridden === "string" && overridden.length > 0) {
      return overridden;
    }
  }
  // 3. Built-in fixed table.
  if (emoji !== undefined && emoji.length > 0) {
    const fixed = FIXED_EMOJI_TO_COLOR.get(emoji);
    if (fixed !== undefined) return fixed;
  }
  // 4. Deterministic pool fallback (seed = member.name).
  const idx = fnv1a32(memberName) % COLOR_POOL.length;
  // Pool indexing — modulo on a non-empty const-readonly array; safe
  // non-null per the COLOR_POOL guarantee above.
  return COLOR_POOL[idx] as string;
}
