// ADR-087: Zod schema for `<atmuxDir>/state/resume.json`.
//
// Written by `core/soft-stop.ts` during `atmux stop --soft`; read by
// `verbs/start.ts` to surface a one-line resume hint after the team
// comes back up.
//
// `.strict()` per src/schema/README.md — unknown keys fail-loud. Bump
// `version` (currently `1`) if the shape changes; the start-side reader
// catches Zod parse failures + warns rather than wedging the start
// pipeline, so a corrupt or future-versioned manifest degrades to "no
// hint surfaced."

import { z } from "zod";

/** Per-member entry in the resume manifest. One per declared team
 *  member, regardless of whether they had an in-flight task at
 *  stop-time. Members with `lastClaim === null` were idle. */
export const ResumeMember = z
  .object({
    /** Member name from `team.members[].name`. */
    name: z.string().min(1),
    /** Task id (e.g. `t-xxxxxxxx`) the member owned with
     *  `status='in-progress'` at stop time. `null` when the member had
     *  no in-flight claim. */
    lastClaim: z.string().nullable(),
    /** Epoch seconds the member claimed `lastClaim`. `null` when
     *  `lastClaim` is `null` or the kanban row had no `claimedAt`
     *  stamp (legacy rows pre-ADR-029). */
    claimedAt: z.number().int().nullable(),
    /** Post-ADR-017 tmux window name (`<emoji><member>`, e.g. `🧭lead`).
     *  Captured at stop-time so the operator can re-target the same
     *  pane after `atmux start` re-creates the session. `null` when
     *  the member had no `emoji` resolved at stop time. */
    windowName: z.string().nullable(),
  })
  .strict();
export type ResumeMember = z.infer<typeof ResumeMember>;

/** Why the manifest was written. `soft-stop` is the operator-driven
 *  `atmux stop --soft` path; `dissolve-epic` (ADR-090, future) is the
 *  auto-merge teardown path that re-uses `core/soft-stop.ts`. */
export const ResumeReason = z.enum(["soft-stop", "dissolve-epic"]);
export type ResumeReason = z.infer<typeof ResumeReason>;

/** `.atmux/state/resume.json` — written by ADR-087 soft-stop, read by
 *  ADR-087 start resume-hook. Once consumed, the start hook renames the
 *  file to `resume.json.<ts>.consumed` so subsequent starts don't
 *  re-surface it. */
export const ResumeManifest = z
  .object({
    /** Schema version. Bump on any breaking shape change so the
     *  start-side reader can refuse old manifests rather than mis-parse. */
    version: z.literal(1),
    /** Epoch seconds the manifest was written. Surfaces in the
     *  resume-hint output as a relative-time annotation
     *  (`claimed Xmin ago`). */
    ts: z.number().int().nonnegative(),
    /** `team.name` at stop-time. Captured to detect stale manifests
     *  after a team rename. */
    team: z.string().min(1),
    /** Why the manifest exists. See {@link ResumeReason}. */
    reason: ResumeReason,
    /** One entry per declared `team.members[]`. Order matches the team
     *  roster at stop-time. */
    members: z.array(ResumeMember),
  })
  .strict();
export type ResumeManifest = z.infer<typeof ResumeManifest>;

/** Current manifest version emitted by `core/soft-stop.ts`. Re-export
 *  so the writer doesn't drift from the schema's literal. */
export const RESUME_MANIFEST_VERSION = 1 as const;
