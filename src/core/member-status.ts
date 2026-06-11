// ADR-260 §D3: member self-reported status primitives.
//
// In manual orchestration mode (the default — no orchd daemon), the
// member LLM is its own status authority: it writes
// `<atmuxDir>/state/member-status/<member>.json` via the
// `atmux member status` verb, and `atmux status` renders the record
// next to the derived signals (cage-state / cadence / heartbeat) so
// the orchestrating lead/driver sees intent alongside observation.
//
// Same concurrency reasoning as the ADR-057 heartbeat family: one
// file per member (exactly one writer — the member itself), written
// via `atomicWrite` so readers never see a torn record. A signal,
// not kanban state — hence a file, not a state.db table.

import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, readTextOrNull } from "../abstractions/fs.ts";
import { now } from "../abstractions/time.ts";

/** ADR-260 §D3 vocabulary — the self-reportable subset of the ADR-258
 *  AgentBackend status enum (`idle | working | rate-limited`) plus
 *  `blocked` (an agent-level judgment; the backend enum's probe-derived
 *  `awaiting-input` / `errored` are NOT self-reportable). */
export const MEMBER_SELF_STATUS_VALUES = [
  "idle",
  "working",
  "blocked",
  "rate-limited",
] as const;
export type MemberSelfStatus = (typeof MEMBER_SELF_STATUS_VALUES)[number];

/** Runtime guard for verb-layer argv parsing. */
export function isMemberSelfStatus(value: string): value is MemberSelfStatus {
  return (MEMBER_SELF_STATUS_VALUES as readonly string[]).includes(value);
}

/** On-disk shape of `<atmuxDir>/state/member-status/<member>.json`.
 *  `.strict()` so a hand-edited file with a typo'd key surfaces as
 *  unreadable (null) rather than silently passing through. */
export const MemberStatusRecord = z
  .object({
    member: z.string().min(1),
    status: z.enum(MEMBER_SELF_STATUS_VALUES),
    note: z.string().optional(),
    /** Kanban task the status refers to (ADR-260 §D4). A reference,
     *  not a foreign key — the task may have moved on since. */
    taskId: z.string().optional(),
    updatedAtSec: z.number().int().nonnegative(),
  })
  .strict();
export type MemberStatusRecord = z.infer<typeof MemberStatusRecord>;

export const MEMBER_STATUS_DIRNAME = "member-status";

/** `<atmuxDir>/state/member-status/`. */
export function memberStatusDir(atmuxDir: string): string {
  return join(atmuxDir, "state", MEMBER_STATUS_DIRNAME);
}

/** `<atmuxDir>/state/member-status/<member>.json`. */
export function memberStatusPath(atmuxDir: string, member: string): string {
  return join(memberStatusDir(atmuxDir), `${member}.json`);
}

/** Write the member's self-reported status atomically. `updatedAtSec`
 *  defaults to the current clock; tests pin a value. */
export async function writeMemberStatus(
  atmuxDir: string,
  record: Omit<MemberStatusRecord, "updatedAtSec"> & { updatedAtSec?: number },
): Promise<MemberStatusRecord> {
  const full: MemberStatusRecord = MemberStatusRecord.parse({
    ...record,
    updatedAtSec: record.updatedAtSec ?? Math.floor(now() / 1000),
  });
  await atomicWrite(
    memberStatusPath(atmuxDir, full.member),
    `${JSON.stringify(full, null, 2)}\n`,
  );
  return full;
}

/** Read one member's self-reported status. Returns `null` when the
 *  file is absent, unparseable JSON, or fails the schema — fail-soft,
 *  matching `readHeartbeat`: a torn/legacy file degrades to "no
 *  signal", never aborts a status snapshot. */
export async function readMemberStatus(
  atmuxDir: string,
  member: string,
): Promise<MemberStatusRecord | null> {
  const raw = await readTextOrNull(memberStatusPath(atmuxDir, member));
  if (raw === null) return null;
  try {
    return MemberStatusRecord.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Batch read for `atmux status` — one entry per member that has a
 *  readable record; members without a signal are simply absent from
 *  the map (mirrors the `contextPct` key-presence convention). */
export async function readAllMemberStatuses(
  atmuxDir: string,
  members: ReadonlyArray<string>,
): Promise<Map<string, MemberStatusRecord>> {
  const out = new Map<string, MemberStatusRecord>();
  for (const m of members) {
    const rec = await readMemberStatus(atmuxDir, m);
    if (rec !== null) out.set(m, rec);
  }
  return out;
}
