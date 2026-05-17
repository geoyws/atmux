// `--dry-run` preview renderer — ADR-164 §"Behavior" step 8 (T6 / t-fe4a570e).
//
// Pure function: takes the prior on-disk Claude-side roster + the newly
// computed one and emits a unified-diff-style preview to a string. The
// dispatcher (`src/verbs/sync.ts`) prints the result + exits 0 without
// touching disk.
//
// Diff shape (per task body):
//   - `+` prefix on additions (new field, new member, fresh file)
//   - `-` prefix on removals (field cleared, member dropped)
//   - ` ` (space) prefix on unchanged lines surrounding diffs
//   - Per-member blocks for readability — header `[member: <name>]`
//     with optional +/- when the whole member is added or removed
//
// Fresh-file case (prior === null): every line is `+` per ADR §Behavior
// step 8 "render the entire computed roster as `+`-prefixed additions".
//
// Field set per member is `MEMBER_DIFF_FIELDS` — the closed surface
// declared in ./types.ts ClaudeTeamMember (name, agentType, color, role,
// model). Unknown operator-extension fields (the index signature) are
// preserved on the write path (T4/T5 territory) but not rendered in the
// diff — keeping the preview deterministic + focused on the sync surface.

import type { ClaudeTeam, ClaudeTeamMember } from "./types.ts";

/** Closed set of fields the diff renderer compares per member. Matches
 *  the post-mapping surface — operator-extension passthroughs are out
 *  of scope for the preview (T4/T5 own the write-time preservation
 *  semantics, not the diff). */
const MEMBER_DIFF_FIELDS = ["name", "agentType", "color", "role", "model"] as const;
type MemberDiffField = (typeof MEMBER_DIFF_FIELDS)[number];

/** Newly computed roster shape, decoupled from `ComputeResult` so the
 *  diff renderer doesn't need to know about sidecars or atmux-side
 *  team-loading. */
export interface ComputedRoster {
  name: string;
  description: string | undefined;
  members: readonly ClaudeTeamMember[];
}

/** Render a unified-diff-style preview comparing `prior` (current
 *  on-disk Claude-side file, or null when none exists) against
 *  `computed` (the would-be-written roster).
 *
 *  Returns a string that ends in a single newline so callers can write
 *  it directly to stdout without re-padding. */
export function renderDiff(prior: ClaudeTeam | null, computed: ComputedRoster): string {
  const out: string[] = [];
  out.push(
    prior === null
      ? "atmux sync claude-team-json: --dry-run preview (no .claude/team.json on disk — fresh file)"
      : "atmux sync claude-team-json: --dry-run preview (no write performed)",
  );
  out.push("");

  // Top-level scalar fields.
  diffScalar(out, "name", prior?.name, computed.name, prior === null);
  diffScalar(out, "description", prior?.description, computed.description, prior === null);
  out.push("");

  // Members — emit in computed order first, then append prior-only
  // members (those removed by the sync) at the bottom.
  const priorMembers: readonly ClaudeTeamMember[] = prior?.members ?? [];
  const priorByName = indexByName(priorMembers);
  const computedByName = indexByName(computed.members);

  out.push(`members (${computed.members.length}):`);
  out.push("");

  for (const m of computed.members) {
    const before = priorByName.get(m.name) ?? null;
    renderMemberBlock(out, before, m, prior === null);
  }
  for (const m of priorMembers) {
    if (!computedByName.has(m.name)) {
      renderMemberBlock(out, m, null, false);
    }
  }

  return out.join("\n") + (out[out.length - 1] === "" ? "" : "\n");
}

/** Map members by `name` (post-rewrite Claude-side name). When a
 *  member appears twice with the same name, the last write wins —
 *  consistent with how `mergeBriefs` (T4) resolves prior-member
 *  lookup. */
function indexByName(
  members: readonly ClaudeTeamMember[],
): Map<string, ClaudeTeamMember> {
  const m = new Map<string, ClaudeTeamMember>();
  for (const member of members) {
    if (typeof member?.name === "string" && member.name.length > 0) {
      m.set(member.name, member);
    }
  }
  return m;
}

function diffScalar(
  out: string[],
  key: string,
  before: string | undefined,
  after: string | undefined,
  fresh: boolean,
): void {
  if (before === after) {
    if (after !== undefined && !fresh) out.push(`   ${key}: ${after}`);
    if (after !== undefined && fresh) out.push(`+  ${key}: ${after}`);
    return;
  }
  if (before === undefined) {
    out.push(`+  ${key}: ${after ?? ""}`);
    return;
  }
  if (after === undefined) {
    out.push(`-  ${key}: ${before}`);
    return;
  }
  out.push(`-  ${key}: ${before}`);
  out.push(`+  ${key}: ${after}`);
}

/** Render one member block. `before` null → addition; `after` null →
 *  removal; both present → field-by-field compare. Identical members
 *  still get a `[member: <name>]` header for grep-ability; the body is
 *  all space-prefix in that case. */
function renderMemberBlock(
  out: string[],
  before: ClaudeTeamMember | null,
  after: ClaudeTeamMember | null,
  fresh: boolean,
): void {
  if (before === null && after !== null) {
    out.push(`+  [member: ${after.name}]`);
    for (const k of MEMBER_DIFF_FIELDS) {
      const v = after[k];
      if (typeof v === "string" && v.length > 0) out.push(`+    ${k}: ${v}`);
    }
    out.push("");
    return;
  }
  if (after === null && before !== null) {
    out.push(`-  [member: ${before.name}]`);
    for (const k of MEMBER_DIFF_FIELDS) {
      const v = before[k];
      if (typeof v === "string" && v.length > 0) out.push(`-    ${k}: ${v}`);
    }
    out.push("");
    return;
  }
  if (before === null || after === null) return; // unreachable; satisfies TS
  const body: string[] = [];
  for (const k of MEMBER_DIFF_FIELDS) {
    diffMemberField(body, k, before[k], after[k], fresh);
  }
  out.push(`   [member: ${after.name}]`);
  for (const line of body) out.push(line);
  out.push("");
}

function diffMemberField(
  out: string[],
  key: MemberDiffField,
  before: unknown,
  after: unknown,
  fresh: boolean,
): void {
  const b = stringOrUndef(before);
  const a = stringOrUndef(after);
  if (b === a) {
    if (a !== undefined && !fresh) out.push(`     ${key}: ${a}`);
    if (a !== undefined && fresh) out.push(`+    ${key}: ${a}`);
    return;
  }
  if (b === undefined) {
    out.push(`+    ${key}: ${a ?? ""}`);
    return;
  }
  if (a === undefined) {
    out.push(`-    ${key}: ${b}`);
    return;
  }
  out.push(`-    ${key}: ${b}`);
  out.push(`+    ${key}: ${a}`);
}

function stringOrUndef(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return undefined;
  return JSON.stringify(v);
}
