// ADR-272: voice operator interface — single-session registry
// (latest-wins claim + park/resume across phone drops).
//
// At most ONE voice session is current. A new claim replaces whatever
// session holds the slot — live OR parked — and invokes the old
// session's `onTakeover` so its owner can tear down the socket/provider
// leg (latest-wins; the phone in hand always beats the phone in the
// drawer). A dropped phone parks its session; the caller keeps the
// provider leg alive and may resume within `graceMs`.
//
// No real timers: `clock` is injected and expiry is LAZY — observed in
// `tryResume` (→ reason "expired") and `current()` (→ null, dropping the
// slot silently; the caller's sweep tears down its own leg). Only
// `claim` notifies via `onTakeover`; lazy expiry never does.

export interface ClaimOpts {
  sessionId: string;
  onTakeover: () => void;
}

export interface CurrentSession {
  sessionId: string;
  state: "live" | "parked";
  parkedAtMs?: number;
}

export type TryResumeResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "expired" | "not-parked" };

export interface SessionRegistry {
  claim(opts: ClaimOpts): void;
  park(sessionId: string): void;
  tryResume(sessionId: string): TryResumeResult;
  current(): CurrentSession | null;
  release(sessionId: string): void;
}

interface Slot {
  sessionId: string;
  onTakeover: () => void;
  state: "live" | "parked";
  parkedAtMs: number; // meaningful only while state === "parked"
}

/** In-memory single-session registry. `clock` MUST be injected. */
export function createSessionRegistry(opts: {
  clock: () => number;
  graceMs: number;
}): SessionRegistry {
  let cur: Slot | null = null;

  const parkExpired = (slot: Slot): boolean =>
    slot.state === "parked" && opts.clock() - slot.parkedAtMs > opts.graceMs;

  return {
    claim({ sessionId, onTakeover }): void {
      const prev = cur;
      cur = { sessionId, onTakeover, state: "live", parkedAtMs: 0 };
      if (prev !== null) prev.onTakeover(); // latest-wins, live or parked
    },
    park(sessionId): void {
      if (cur !== null && cur.sessionId === sessionId && cur.state === "live") {
        cur.state = "parked";
        cur.parkedAtMs = opts.clock();
      }
    },
    tryResume(sessionId): TryResumeResult {
      if (cur === null || cur.sessionId !== sessionId) return { ok: false, reason: "unknown" };
      if (cur.state !== "parked") return { ok: false, reason: "not-parked" };
      if (parkExpired(cur)) {
        cur = null; // grace elapsed — the id must not be resurrectable later
        return { ok: false, reason: "expired" };
      }
      cur.state = "live";
      return { ok: true };
    },
    current(): CurrentSession | null {
      if (cur === null) return null;
      if (cur.state === "parked") {
        if (parkExpired(cur)) {
          cur = null; // lazy expiry — caller's sweep observes null
          return null;
        }
        return { sessionId: cur.sessionId, state: "parked", parkedAtMs: cur.parkedAtMs };
      }
      return { sessionId: cur.sessionId, state: "live" };
    },
    release(sessionId): void {
      if (cur !== null && cur.sessionId === sessionId) cur = null; // clean close
    },
  };
}
