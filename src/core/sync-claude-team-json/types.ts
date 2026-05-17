// Claude-side `.claude/team.json` shape — per ADR-164 §"Behavior" step 2.
//
// Intentionally LOOSE — no Zod, no closed enum on fields. The Claude
// `/team` skill family + hand-authoring practices add operator extensions
// over time; the sync verb preserves unknown fields rather than schema-
// rejecting them. Per ADR-164 §"File shape after sync" + §Consequences.

/** Idempotence marker stamped at sync time (ADR-164 §"File shape after sync"
 *  + §OQ-1). Top-level passthrough field — Claude `/team` skill ignores
 *  unknown keys, so this rides along without breaking the consumer. */
export interface AtmuxSyncMarker {
  lastSyncedAt: string;
  schemaRev: string;
  sourceFingerprint: string;
}

/** Per-member Claude-side shape. Closed-shape known fields + index signature
 *  for unknown-field preservation. */
export interface ClaudeTeamMember {
  name: string;
  agentType?: string;
  color?: string;
  /** Hand-authored long-form text on the Claude side. Preserved-by-default
   *  on re-sync per ADR-164 §"Brief preservation" + §OQ-4. */
  role?: string;
  model?: string;
  /** Operator extensions (unknown-field passthrough). */
  [unknown: string]: unknown;
}

/** Top-level Claude-side team file shape. */
export interface ClaudeTeam {
  _atmuxSync?: AtmuxSyncMarker;
  name?: string;
  description?: string;
  members?: ClaudeTeamMember[];
  /** Operator extensions (unknown-field passthrough). */
  [unknown: string]: unknown;
}

/** Color-map sidecar shape (`.claude/team-colors.json`) per ADR-164
 *  §"Color mapping". `_byMemberName` wins over top-level emoji keys. */
export interface ColorSidecar {
  _byMemberName?: Record<string, string>;
  /** Top-level emoji → color overrides. Stored alongside `_byMemberName`. */
  [emoji: string]: string | Record<string, string> | undefined;
}
