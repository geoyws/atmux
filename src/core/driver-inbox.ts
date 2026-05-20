// ADR-198 (2026-05-20): driver-inbox.md → lead-inbox.md rename.
//
// This file is a thin re-export shim kept for ONE release so external
// imports of `src/core/driver-inbox.ts` symbols don't break mid-rollout.
// New code should import from `./lead-inbox.ts` directly.
//
// Removal: scheduled with the next semver bump after the on-disk walker
// (T2) has been running in the field for one release cycle.

export type {
  /** @deprecated Use {@link LeadInboxEntry}. */
  DriverInboxEntry,
  LeadInboxEntry,
  /** @deprecated Use {@link ReadLeadInboxResult}. */
  ReadDriverInboxResult,
  ReadLeadInboxResult,
} from "./lead-inbox.ts";
export {
  entriesSince,
  isEntryHead,
  lastDriverInboxReadPath,
  lastLeadInboxReadPath,
  lastNEntries,
  parseEntries,
  parseEntryTimestamp,
  readCursor,
  /** @deprecated Use {@link readLeadInbox}. */
  readDriverInbox,
  readLeadInbox,
  writeCursor,
} from "./lead-inbox.ts";
