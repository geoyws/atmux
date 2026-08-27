// atmux-orchd — Rust dispatcher for the atmux event-driven substrate.
//
// Replaces the Bun-side `atmux orchd --start` long-lived process per
// ADR-202 §Amendment 2026-05-22 (VII). Architecture:
//
//   1. This Rust binary stays subscribed (Honker `Database::listen`),
//      blocks kernel-level on the mpsc-fed Subscription iterator. Idle
//      RSS ~5MB, idle CPU ~0%.
//   2. On each notification: query the events table for new rows since
//      this consumer's offset (rusqlite — same db, same connection).
//   3. For each new event: spawn `atmux orchd --handle-one --event-id
//      <id>` as a one-shot Bun subprocess. Wait for exit.
//   4. On clean exit (rc=0): advance the consumer's offset and loop.
//      On non-zero exit: log and DON'T advance — next wake re-attempts.
//
// Net: Bun runs only during handler execution (~50ms cold start + the
// handler's own time, usually 1-30s for a git merge). Idle resource
// cost is Rust-only, ~5MB per team.
//
// Multi-topic dispatch: we listen on BOTH honker:stream:task.done and
// honker:stream:task.unclaimed via the raw UpdateEvents waker (wakes on
// any DB commit) rather than spawning two Subscription threads. On
// each wake we drain BOTH topics' new events in lex-id order, dispatch
// each to Bun via `--topic` flag so the Bun side picks the right
// handler.
//
// Wire protocol with Bun:
//   atmux orchd --handle-one --event-id <id> --topic <t> [--team-dir <p>]
//   exit 0          → event handled successfully; orchd advances offset
//   exit non-zero   → handler failed (or Bun couldn't load event);
//                     orchd does NOT advance offset; next wake retries
//
// Lifecycle:
//   - parent dies (tmux pane killed, atmux stop, kernel OOM SIGKILL) →
//     PR_SET_PDEATHSIG(SIGTERM) terminates this process on Linux.
//   - SIGTERM/SIGINT → break out of subscription loop, exit 0.
//   - In-flight Bun child gets SIGTERM via process-group cascade.
//
// Configuration via env:
//   ATMUX_ORCHD_DB        — path to state.db (default: ./.atmux/state.db)
//   ATMUX_ORCHD_ATMUX_BIN — path to atmux binary (default: `atmux` on PATH)
//   ATMUX_ORCHD_TEAM_DIR  — path passed to atmux --team-dir (default: cwd)
//   ATMUX_ORCHD_TOPICS    — comma-separated topic list to subscribe to
//                            (default: task.done,task.unclaimed)

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::Path;
use std::process::{Child, Command, ExitCode};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use honker::Database;
use rusqlite::params;
use serde_json::Value as JsonValue;

// ADR-256 §Bounded-wait — default deadlines for nested subprocess waits.
// orchd's Bun children (`--handle-one` per-event handlers + the periodic
// `--scan-*` / `--housekeep` ticks) used to block the
// supervisor thread on `Command::status()` UNBOUNDEDLY: a single hung Bun
// child (deadlocked git merge, wedged network call, infinite loop) froze
// orchd entirely — no further event dispatch, no ticker progress, the
// whole team's substrate stalled behind one stuck process. We now spawn +
// poll `try_wait()` against a deadline, escalating SIGTERM → grace →
// SIGKILL when the deadline lapses. std-only (std::process + a sleep-poll
// loop + libc::kill on Linux); no async runtime / extra crate.
//
// Defaults are generous because a real git-merge handler can legitimately
// run for tens of seconds (large rebase, submodule fan-in). The point is
// to bound *pathological* hangs (minutes→forever), not to clip honest
// work. Operators tune via env when a project's handlers run longer.
const DEFAULT_HANDLER_TIMEOUT_SECS: u64 = 600; // per-event Bun handler
const DEFAULT_TICK_TIMEOUT_SECS: u64 = 900; // sweep / scan / housekeep tick
/// Grace window between SIGTERM and the follow-up SIGKILL — gives the Bun
/// child a chance to flush logs + release flocks before the hard kill.
const TERM_GRACE_SECS: u64 = 5;
/// Poll cadence for the `try_wait()` loop. 50ms keeps the latency overhead
/// negligible (a fast handler still returns within ~50ms of its real exit)
/// while costing ~20 wakeups/sec of idle CPU only while a child is live.
const WAIT_POLL: Duration = Duration::from_millis(50);

/// ADR-256 §Poison-event tripwire — consecutive non-zero exits ON THE SAME
/// event_id before orchd dead-letters it (advances past + emits
/// `orchd.event-dead-lettered`). A single poison event (Bun handler throws
/// deterministically on this row — corrupt payload, a bug the handler hits
/// only for this input) would otherwise retry-storm FOREVER: every wake
/// re-drains from the un-advanced offset, re-spawns Bun, re-throws, never
/// advances. ADR-231's lesson ("retry storms hide root causes; operator-
/// visible signal beats silent infinite retry") applied to the dispatch
/// loop. After N strikes we advance the offset (unblocking every later
/// event for that consumer) and emit an operator-visible dead-letter event.
const DEFAULT_POISON_STRIKES: u32 = 5;

/// Process-lifetime monotonic counter mixed into the dead-letter event_id
/// entropy so two dead-letters emitted within the same millisecond still
/// get distinct (and lexicographically increasing) UUIDv7s.
static DEAD_LETTER_SEQ: AtomicU64 = AtomicU64::new(0);

/// Linux-only: kernel sends SIGTERM when our parent dies. Closes the
/// orphan-after-SIGKILL teardown hole. See atmux-listener for the same
/// pattern.
#[cfg(target_os = "linux")]
fn install_parent_death_signal() {
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong, 0, 0, 0);
        if libc::getppid() == 1 {
            std::process::exit(0);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn install_parent_death_signal() {}

/// ADR-249 — derive the singleton-lock path from the DB path. Canonicalize
/// the DB's parent dir so relative (`.atmux/state.db`) and absolute argv
/// variants of the SAME team's DB collide on one lockfile, while different
/// teams' DBs (different parents) never collide. Best-effort canonicalize:
/// if the parent can't be resolved (shouldn't happen — `.atmux/` exists by
/// the time orchd runs), fall back to the parent as-given.
fn singleton_lock_path(db_path: &str) -> String {
    let p = Path::new(db_path);
    let parent = p.parent().filter(|s| !s.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let canon_parent = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("state.db");
    canon_parent
        .join(format!("{}.orchd.lock", fname))
        .to_string_lossy()
        .into_owned()
}

/// ADR-249 — acquire the exclusive, non-blocking advisory lock that makes
/// orchd a singleton per team DB. Returns the held `File` on success (caller
/// MUST keep it alive for the process lifetime — `flock` is released when the
/// fd closes, i.e. on exit/crash, so no stale-lock cleanup is needed).
/// `Ok(None)` on non-Linux = no guard (matches `install_parent_death_signal`).
#[cfg(target_os = "linux")]
fn acquire_singleton_lock(lock_path: &str) -> Result<Option<fs::File>, String> {
    use std::os::unix::io::AsRawFd;
    let file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(lock_path)
        .map_err(|e| format!("open lock {}: {}", lock_path, e))?;
    // LOCK_NB → fail immediately if another orchd holds it (don't block).
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc != 0 {
        return Err(format!("another orchd holds {}", lock_path));
    }
    Ok(Some(file))
}

#[cfg(not(target_os = "linux"))]
fn acquire_singleton_lock(_lock_path: &str) -> Result<Option<fs::File>, String> {
    Ok(None)
}

/// Subscriber-offset row schema mirrors the Bun-side
/// `src/abstractions/events.ts::loadOffset/saveOffset` contract. Each
/// consumer has its own offset so slow handlers don't starve fast ones.
struct ConsumerCfg {
    name: &'static str,
    topic: &'static str,
    /// The Bun-side `--topic` argument value the handler will use to
    /// dispatch internally. Must match the topic literal in
    /// `src/schema/events.ts::TOPICS`.
    bun_topic: &'static str,
    /// e-10-eee9ea5a — when `Some(id)`, Rust passes `--consumer-id <id>`
    /// to Bun so `--handle-one` routes via the registry. When `None`
    /// (legacy back-compat for atmux:gitter + atmux:lane-router), Bun
    /// falls through to the hardcoded topic branches.
    bun_consumer_id: Option<&'static str>,
}

const CONSUMERS: &[ConsumerCfg] = &[
    // Legacy: atmux:gitter and atmux:lane-router predate the registry-
    // driven dispatch (ADR-202 §VII original wiring). Bun's --handle-one
    // recognizes these topic names without a --consumer-id flag and
    // routes them through the legacy hardcoded branches (task.done →
    // gitter merge handler; task.unclaimed → lane-tick). They stay
    // here for back-compat.
    ConsumerCfg {
        name: "atmux:gitter",
        topic: "task.done",
        bun_topic: "task.done",
        bun_consumer_id: None,
    },
    ConsumerCfg {
        name: "atmux:lane-router",
        topic: "task.unclaimed",
        bun_topic: "task.unclaimed",
        bun_consumer_id: None,
    },
    // e-10-eee9ea5a — registry-driven dispatch. Each entry below maps
    // 1:1 to a `bootstrapOrchd` registration in
    // src/core/orchd-bootstrap.ts. The Bun side looks up the handler
    // by --consumer-id (NOT by topic alone — multiple consumers can
    // share a topic, e.g. atmux:orchd:auto-merge +
    // atmux:orchd:dissolve-solo-worker both on task.done). Per-
    // consumer offset isolation is preserved by the distinct `name`
    // field.
    ConsumerCfg {
        name: "atmux:orchd:auto-merge",
        topic: "task.done",
        bun_topic: "task.done",
        bun_consumer_id: Some("atmux:orchd:auto-merge"),
    },
    ConsumerCfg {
        name: "atmux:orchd:dissolve-solo-worker",
        topic: "task.done",
        bun_topic: "task.done",
        bun_consumer_id: Some("atmux:orchd:dissolve-solo-worker"),
    },
    ConsumerCfg {
        name: "atmux:orchd:auto-push",
        topic: "epic.merged",
        bun_topic: "epic.merged",
        bun_consumer_id: Some("atmux:orchd:auto-push"),
    },
    ConsumerCfg {
        name: "atmux:orchd:auto-dissolve",
        topic: "epic.pushed",
        bun_topic: "epic.pushed",
        bun_consumer_id: Some("atmux:orchd:auto-dissolve"),
    },
    ConsumerCfg {
        name: "atmux:orchd:spawn:on-ready",
        topic: "epic.ready",
        bun_topic: "epic.ready",
        bun_consumer_id: Some("atmux:orchd:spawn:on-ready"),
    },
    ConsumerCfg {
        name: "atmux:orchd:spawn:on-unblocked",
        topic: "epic.unblocked",
        bun_topic: "epic.unblocked",
        bun_consumer_id: Some("atmux:orchd:spawn:on-unblocked"),
    },
    // ADR-214 §D2 — complaint consumer routes complaint.filed events
    // to the lead's tell-lead inbox.
    ConsumerCfg {
        name: "atmux:complaint-consumer",
        topic: "complaint.filed",
        bun_topic: "complaint.filed",
        bun_consumer_id: Some("atmux:complaint-consumer"),
    },
    // ADR-212 / e-cc3728bf — rotation consumer routes
    // member.context-high (and future pane.stuck / member.no-progress
    // / cage.starving) events to the lead's tell-lead inbox.
    ConsumerCfg {
        name: "atmux:rotation-consumer",
        topic: "member.context-high",
        bun_topic: "member.context-high",
        bun_consumer_id: Some("atmux:rotation-consumer"),
    },
];

fn load_offset(db: &Database, consumer: &str) -> Result<String, String> {
    let r: rusqlite::Result<String> = db.with_conn(|c| {
        match c.query_row(
            "SELECT last_event_id FROM subscriber_offsets WHERE consumer_name = ?1",
            params![consumer],
            |r| r.get::<_, String>(0),
        ) {
            Ok(s) => Ok(s),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(String::new()),
            Err(e) => Err(e),
        }
    });
    r.map_err(|e| format!("load_offset({}) error: {}", consumer, e))
}

fn save_offset(db: &Database, consumer: &str, event_id: &str) -> Result<(), String> {
    let now_sec = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let r: rusqlite::Result<usize> = db.with_conn(|c| {
        c.execute(
            "INSERT INTO subscriber_offsets (consumer_name, last_event_id, last_processed_at_sec)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(consumer_name) DO UPDATE SET
               last_event_id = excluded.last_event_id,
               last_processed_at_sec = excluded.last_processed_at_sec",
            params![consumer, event_id, now_sec],
        )
    });
    r.map(|_| ()).map_err(|e| format!("save_offset error: {}", e))
}

/// Load the `payload` column for an event_id. Returns `Ok(None)` when
/// the row exists but payload is NULL, `Ok(Some(_))` when present, and
/// `Err(_)` only on rusqlite faults. Missing-row collapses to `Ok(None)`
/// so the caller's fallback path handles both transparently — at most-
/// once-payload semantics: emitter races (payload null'd, event pruned)
/// fall back to no-extra-args dispatch identically.
fn load_event_payload(db: &Database, event_id: &str) -> Result<Option<String>, String> {
    let r: rusqlite::Result<Option<String>> = db.with_conn(|c| {
        match c.query_row(
            "SELECT payload FROM events WHERE event_id = ?1",
            params![event_id],
            |r| r.get::<_, Option<String>>(0),
        ) {
            Ok(s) => Ok(s),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    });
    r.map_err(|e| format!("load_event_payload({}) error: {}", event_id, e))
}

/// Parse `TaskUnclaimedPayload` (Zod schema at `src/schema/events.ts`)
/// for the `taskId` + `lane` fields. Returns `None` when either field
/// is missing or the JSON doesn't parse — caller falls back to no-
/// extra-args dispatch (existing cross-member runLaneTick behavior).
/// `member` is INTENTIONALLY absent — task is unclaimed at this point,
/// the Bun side derives member from `lane` via `team.members[]`.
fn parse_task_unclaimed_payload(json: &str) -> Option<(String, String)> {
    let v: JsonValue = serde_json::from_str(json).ok()?;
    let task_id = v.get("taskId")?.as_str()?.to_string();
    let lane = v.get("lane")?.as_str()?.to_string();
    Some((task_id, lane))
}

/// Read a `u64` env override, falling back to `default` when the var is
/// unset, non-numeric, or zero (zero is rejected because a 0s deadline
/// would kill every child before it could start — fail closed to the
/// sane default rather than self-DoS). Mirrors the fail-closed parsing of
/// `ATMUX_SPAWN_TIMEOUT_MS` documented in CLAUDE.md.
fn env_u64_or(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(default)
}

/// Read the per-event handler deadline (`ATMUX_ORCHD_HANDLER_TIMEOUT_SECS`).
fn handler_timeout() -> Duration {
    Duration::from_secs(env_u64_or(
        "ATMUX_ORCHD_HANDLER_TIMEOUT_SECS",
        DEFAULT_HANDLER_TIMEOUT_SECS,
    ))
}

/// Read the periodic-tick deadline (`ATMUX_ORCHD_TICK_TIMEOUT_SECS`).
fn tick_timeout() -> Duration {
    Duration::from_secs(env_u64_or(
        "ATMUX_ORCHD_TICK_TIMEOUT_SECS",
        DEFAULT_TICK_TIMEOUT_SECS,
    ))
}

/// Read the poison-strike threshold (`ATMUX_ORCHD_POISON_STRIKES`).
fn poison_strikes() -> u32 {
    let n = env_u64_or("ATMUX_ORCHD_POISON_STRIKES", DEFAULT_POISON_STRIKES as u64);
    // Clamp to u32; the practical range is single digits.
    n.min(u32::MAX as u64) as u32
}

/// Outcome of a bounded subprocess wait.
#[derive(Debug, PartialEq, Eq)]
enum WaitOutcome {
    /// Child exited on its own before the deadline. `Some(code)` =
    /// normal exit with that code; `None` = terminated by a signal that
    /// wasn't ours (rare — e.g. external SIGKILL / OOM).
    Exited(Option<i32>),
    /// Deadline lapsed; orchd escalated SIGTERM→SIGKILL and reaped the
    /// child. Treated as a failure (non-advancing) by callers.
    TimedOut,
}

/// Linux-only: send a signal to a child PID via `libc::kill`. We target
/// the PID directly (not the process group) — the child inherits orchd's
/// own process group, so a `kill(-pgid)` would also signal orchd itself.
#[cfg(target_os = "linux")]
fn signal_child(child: &Child, sig: libc::c_int) {
    let pid = child.id() as libc::pid_t;
    unsafe {
        libc::kill(pid, sig);
    }
}

/// Block until `child` exits or `deadline` lapses, polling `try_wait()`
/// every `WAIT_POLL`. On deadline: SIGTERM, wait up to `TERM_GRACE_SECS`,
/// then SIGKILL + a final blocking `wait()` to reap (no zombie). This is
/// the std-only replacement for the old unbounded `Command::status()` —
/// a hung Bun child can no longer freeze the orchd supervisor thread.
///
/// `label` is purely for the timeout log line so operators can see WHICH
/// nested subprocess wedged.
fn wait_bounded(mut child: Child, deadline: Duration, label: &str) -> WaitOutcome {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return WaitOutcome::Exited(status.code()),
            Ok(None) => {
                if start.elapsed() >= deadline {
                    break;
                }
                std::thread::sleep(WAIT_POLL);
            }
            Err(e) => {
                // try_wait() faulted — give up the bounded wait and fall
                // through to a best-effort kill so we never leak the child.
                eprintln!(
                    "{} 🔴 orchd bounded-wait · try_wait({}) error: {} — escalating to kill",
                    now_ts(),
                    label,
                    e
                );
                break;
            }
        }
    }

    // Deadline (or try_wait fault). Escalate SIGTERM → grace → SIGKILL.
    eprintln!(
        "{} ⏱ orchd bounded-wait · {} exceeded {}s — SIGTERM",
        now_ts(),
        label,
        deadline.as_secs()
    );
    terminate_child(&mut child, label);
    WaitOutcome::TimedOut
}

/// Escalate SIGTERM → grace-poll → SIGKILL, then a blocking reap. Shared
/// by the deadline path and (future) shutdown paths.
fn terminate_child(child: &mut Child, label: &str) {
    #[cfg(target_os = "linux")]
    {
        signal_child(child, libc::SIGTERM);
        let grace = Duration::from_secs(TERM_GRACE_SECS);
        let grace_start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return, // exited within grace — reaped
                Ok(None) => {
                    if grace_start.elapsed() >= grace {
                        break;
                    }
                    std::thread::sleep(WAIT_POLL);
                }
                Err(_) => break,
            }
        }
        eprintln!(
            "{} 🔪 orchd bounded-wait · {} ignored SIGTERM after {}s — SIGKILL",
            now_ts(),
            label,
            TERM_GRACE_SECS
        );
        signal_child(child, libc::SIGKILL);
        let _ = child.wait(); // reap the zombie
    }
    #[cfg(not(target_os = "linux"))]
    {
        // No libc::kill on non-Linux — Child::kill() is SIGKILL-equivalent.
        let _ = child.kill();
        let _ = child.wait();
        let _ = label;
    }
}

/// Generate a UUIDv7 (RFC 9562 §5.7) std-only. Mirrors the Bun-side
/// `src/abstractions/uuidv7.ts` byte layout so the dead-letter event_id
/// sorts lexicographically by creation time alongside Bun-emitted events
/// (the `events` table orders on `event_id ASC`). The 74 random bits are
/// drawn from a SplitMix64 PRNG seeded with the current nanosecond clock
/// XOR a process-lifetime atomic counter — NOT cryptographic, but the
/// dead-letter event is consumer-less operator-visibility telemetry, so
/// uniqueness (not unpredictability) is the only requirement, and the
/// nanos+counter seed guarantees uniqueness even for same-millisecond
/// emissions.
fn uuidv7_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    let ts_ms: u64 = now.as_millis() as u64;
    let seq = DEAD_LETTER_SEQ.fetch_add(1, Ordering::Relaxed);
    // SplitMix64 — fast, std-only, good avalanche for non-crypto use.
    let mut z = now
        .as_nanos() as u64
        ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut next = || {
        z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut x = z;
        x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        x ^ (x >> 31)
    };
    let r0 = next();
    let r1 = next();
    let mut b = [0u8; 16];
    // 48-bit big-endian timestamp (ms).
    b[0] = ((ts_ms >> 40) & 0xff) as u8;
    b[1] = ((ts_ms >> 32) & 0xff) as u8;
    b[2] = ((ts_ms >> 24) & 0xff) as u8;
    b[3] = ((ts_ms >> 16) & 0xff) as u8;
    b[4] = ((ts_ms >> 8) & 0xff) as u8;
    b[5] = (ts_ms & 0xff) as u8;
    // version (0b0111) + 4 bits rand, then 8 bits rand.
    b[6] = 0x70 | ((r0 & 0x0f) as u8);
    b[7] = ((r0 >> 8) & 0xff) as u8;
    // variant (0b10) + 6 bits rand, then remaining rand bytes.
    b[8] = 0x80 | ((r0 >> 16) & 0x3f) as u8;
    b[9] = ((r0 >> 24) & 0xff) as u8;
    b[10] = ((r0 >> 32) & 0xff) as u8;
    b[11] = ((r0 >> 40) & 0xff) as u8;
    b[12] = (r1 & 0xff) as u8;
    b[13] = ((r1 >> 8) & 0xff) as u8;
    b[14] = ((r1 >> 16) & 0xff) as u8;
    b[15] = ((r1 >> 24) & 0xff) as u8;
    let h: String = b.iter().map(|byte| format!("{:02x}", byte)).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

/// ADR-256 §Poison-event tripwire — emit an `orchd.event-dead-lettered`
/// row into the `events` table for operator visibility, then return so the
/// caller can advance the offset past the poison event. The payload mirrors
/// the BasePayloadFields shape (topic / eventId / emittedAtSec /
/// schemaVersion) used by the Bun-side Zod union so an operator inspecting
/// the row sees the familiar envelope, plus the dead-letter specifics
/// (consumer / deadEventId / deadTopic / strikes / lastExitCode). The topic
/// is INTENTIONALLY outside the closed Zod v1 set (`src/schema/events.ts`):
/// no consumer subscribes to it, so the Bun-side `drainSince` Zod parse
/// skipping it as unknown is correct — it exists purely as a durable
/// operator-visible breadcrumb (`SELECT * FROM events WHERE topic =
/// 'orchd.event-dead-lettered'`). Best-effort: a write failure is logged
/// and swallowed so a substrate hiccup can't wedge the tripwire itself.
fn emit_dead_letter(
    db: &Database,
    consumer: &str,
    dead_event_id: &str,
    dead_topic: &str,
    strikes: u32,
    last_exit_code: i32,
) {
    let event_id = uuidv7_now();
    let emitted_at_sec = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let payload = serde_json::json!({
        "topic": "orchd.event-dead-lettered",
        "eventId": event_id,
        "emittedAtSec": emitted_at_sec,
        "schemaVersion": 1,
        "consumer": consumer,
        "deadEventId": dead_event_id,
        "deadTopic": dead_topic,
        "strikes": strikes,
        "lastExitCode": last_exit_code,
    });
    let payload_str = payload.to_string();
    let r: rusqlite::Result<usize> = db.with_conn(|c| {
        c.execute(
            "INSERT OR IGNORE INTO events (event_id, topic, payload, emitted_at_sec, schema_version)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                event_id,
                "orchd.event-dead-lettered",
                payload_str,
                emitted_at_sec,
                1_i64
            ],
        )
    });
    match r {
        Ok(_) => eprintln!(
            "{} ☠️ orchd dead-letter · consumer={} deadEventId={} deadTopic={} after {} strikes (lastExit={}) — advancing offset past poison event (ADR-256/ADR-231)",
            now_ts(),
            consumer,
            dead_event_id,
            dead_topic,
            strikes,
            last_exit_code
        ),
        Err(e) => eprintln!(
            "{} 🔴 orchd dead-letter · failed to emit orchd.event-dead-lettered for consumer={} deadEventId={}: {} (still advancing offset to break the retry storm)",
            now_ts(),
            consumer,
            dead_event_id,
            e
        ),
    }
}

fn drain_topic(
    db: &Database,
    topic: &str,
    after: &str,
    limit: i64,
) -> Result<Vec<String>, String> {
    let r: rusqlite::Result<Vec<String>> = db.with_conn(|c| {
        let mut stmt = c.prepare(
            "SELECT event_id FROM events
             WHERE event_id > ?1 AND topic = ?2
             ORDER BY event_id ASC
             LIMIT ?3",
        )?;
        let iter = stmt.query_map(params![after, topic, limit], |r| r.get::<_, String>(0))?;
        iter.collect::<rusqlite::Result<Vec<_>>>()
    });
    r.map_err(|e| format!("drain_topic({}) error: {}", topic, e))
}

/// Spawn `atmux orchd --handle-one --event-id <id> --topic <t> --team-dir <p>
/// [<extra_args>...]` and wait for it BOUNDED by `handler_timeout()` (ADR-256
/// §Bounded-wait). Returns the child's `WaitOutcome`. `extra_args` carry the
/// optional `--task-id <id> --lane <l>` payload hints for the lean per-event
/// dispatch path (ADR-202 §Amendment 2026-05-22 IX-A); empty slice = legacy
/// no-hints dispatch. On spawn failure returns `WaitOutcome::Exited(None)` —
/// the caller treats a spawn fault the same as a killed-by-signal child
/// (non-advancing, no poison-strike: it's an orchd-side fault, not the
/// event's fault).
fn dispatch_to_bun(
    atmux_bin: &str,
    team_dir: &str,
    event_id: &str,
    topic: &str,
    consumer_id: Option<&str>,
    extra_args: &[(&str, &str)],
) -> WaitOutcome {
    let mut cmd = Command::new(atmux_bin);
    cmd.arg("orchd")
        .arg("--handle-one")
        .arg("--event-id")
        .arg(event_id)
        .arg("--topic")
        .arg(topic)
        .arg("--team-dir")
        .arg(team_dir);
    if let Some(cid) = consumer_id {
        cmd.arg("--consumer-id").arg(cid);
    }
    for (flag, value) in extra_args {
        cmd.arg(flag).arg(value);
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "atmux-orchd: spawn `{} orchd --handle-one` failed: {}",
                atmux_bin, e
            );
            return WaitOutcome::Exited(None);
        }
    };
    wait_bounded(
        child,
        handler_timeout(),
        &format!("handle-one eventId={} topic={}", event_id, topic),
    )
}

/// Per-(consumer, event_id) consecutive-failure tracker for the poison-
/// event tripwire (ADR-256 §Poison-event tripwire). Keyed by consumer name
/// → (event_id, consecutive non-zero-exit count). Resets the moment the
/// stuck event advances (success OR dead-letter) or a DIFFERENT event_id
/// becomes the head for that consumer — so a flaky-then-recovering handler
/// never trips the wire, only a deterministically-poison one does.
type PoisonStrikes = HashMap<&'static str, (String, u32)>;

fn drain_and_dispatch(
    db: &Database,
    atmux_bin: &str,
    team_dir: &str,
    offsets: &mut Vec<String>,
    strikes: &mut PoisonStrikes,
) -> Result<usize, String> {
    let max_strikes = poison_strikes();
    let mut processed = 0;
    for (idx, cfg) in CONSUMERS.iter().enumerate() {
        let current_offset = &offsets[idx];
        let new_event_ids = drain_topic(db, cfg.topic, current_offset, 1000)?;
        for event_id in new_event_ids {
            // ADR-202 §Amendment 2026-05-22 IX-A: for the lane-router
            // consumer, read the event payload + pass --task-id/--lane
            // to Bun so the per-event lean dispatcher can target ONE
            // member instead of enumerating the team. Member resolution
            // happens Bun-side because TaskUnclaimedPayload has no
            // `member` field (task is unclaimed at emit time). On any
            // payload-load / parse failure we fall back to the legacy
            // no-extra-args dispatch — the Bun side then runs the full
            // runLaneTick scan, which is the correct degraded behavior.
            let mut payload_args: Vec<(String, String)> = Vec::new();
            if cfg.name == "atmux:lane-router" {
                match load_event_payload(db, &event_id) {
                    Ok(Some(json)) => match parse_task_unclaimed_payload(&json) {
                        Some((task_id, lane)) => {
                            payload_args.push(("--task-id".to_string(), task_id));
                            payload_args.push(("--lane".to_string(), lane));
                        }
                        None => {
                            eprintln!(
                                "atmux-orchd: payload parse failed for eventId={} (consumer={}) — falling back to no-extra-args dispatch",
                                event_id, cfg.name
                            );
                        }
                    },
                    Ok(None) => {
                        eprintln!(
                            "atmux-orchd: no payload row for eventId={} (consumer={}) — falling back to no-extra-args dispatch",
                            event_id, cfg.name
                        );
                    }
                    Err(e) => {
                        eprintln!(
                            "atmux-orchd: {} — falling back to no-extra-args dispatch",
                            e
                        );
                    }
                }
            }
            let extra_refs: Vec<(&str, &str)> = payload_args
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            let outcome = dispatch_to_bun(
                atmux_bin,
                team_dir,
                &event_id,
                cfg.bun_topic,
                cfg.bun_consumer_id,
                &extra_refs,
            );
            match outcome {
                WaitOutcome::Exited(Some(0)) => {
                    save_offset(db, cfg.name, &event_id)?;
                    offsets[idx] = event_id.clone();
                    strikes.remove(cfg.name); // clean exit — clear any strikes
                    processed += 1;
                    println!(
                        "atmux-orchd: handled {} eventId={} (consumer={})",
                        cfg.bun_topic, event_id, cfg.name
                    );
                }
                WaitOutcome::Exited(Some(other)) => {
                    // UNEXPECTED non-zero exit = the Bun handler threw (or
                    // refused) on THIS event. Tick the per-(consumer,
                    // event_id) strike counter. Below the threshold we keep
                    // the existing behavior (don't advance; retry next wake).
                    // At/over the threshold we dead-letter: advance past the
                    // poison event + emit an operator-visible event so a
                    // single deterministically-failing row can't retry-storm
                    // forever (ADR-256 §Poison-event tripwire / ADR-231).
                    let count = match strikes.get_mut(cfg.name) {
                        Some(entry) if entry.0 == event_id => {
                            entry.1 += 1;
                            entry.1
                        }
                        _ => {
                            // First strike for this event_id (or the head
                            // event_id changed since the last strike) —
                            // (re)seed the counter at 1.
                            strikes.insert(cfg.name, (event_id.clone(), 1));
                            1
                        }
                    };
                    if count >= max_strikes {
                        emit_dead_letter(
                            db,
                            cfg.name,
                            &event_id,
                            cfg.bun_topic,
                            count,
                            other,
                        );
                        save_offset(db, cfg.name, &event_id)?;
                        offsets[idx] = event_id.clone();
                        strikes.remove(cfg.name);
                        // Poison event retired — continue draining this
                        // consumer's later events instead of breaking, so a
                        // single poison row doesn't also stall the backlog
                        // behind it.
                        continue;
                    }
                    eprintln!(
                        "atmux-orchd: bun handler exit rc={} on {} eventId={} (consumer={}); strike {}/{}; NOT advancing offset; will retry next wake",
                        other, cfg.bun_topic, event_id, cfg.name, count, max_strikes
                    );
                    // Don't continue this consumer's drain — re-attempt next wake.
                    break;
                }
                WaitOutcome::Exited(None) => {
                    // Killed by an external signal (OOM / operator kill) OR
                    // orchd-side spawn fault — NOT the event's fault, so we
                    // do NOT count a poison strike. Don't advance; retry.
                    eprintln!(
                        "atmux-orchd: bun handler killed-by-signal/spawn-fault on {} eventId={} (consumer={}); NOT advancing offset (no poison strike)",
                        cfg.bun_topic, event_id, cfg.name
                    );
                    break;
                }
                WaitOutcome::TimedOut => {
                    // Bounded-wait deadline lapsed; orchd already SIGTERM→
                    // SIGKILL'd the child (ADR-256 §Bounded-wait). A hang is
                    // a transient/environmental fault (deadlock, slow IO),
                    // NOT a deterministic poison row, so we do NOT count a
                    // poison strike — don't advance; retry next wake.
                    eprintln!(
                        "atmux-orchd: bun handler TIMED OUT on {} eventId={} (consumer={}); killed; NOT advancing offset (no poison strike)",
                        cfg.bun_topic, event_id, cfg.name
                    );
                    break;
                }
            }
        }
    }
    Ok(processed)
}

fn main() -> ExitCode {
    install_parent_death_signal();

    let args: Vec<String> = env::args().collect();
    let cwd = env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string());
    let db_path = env::var("ATMUX_ORCHD_DB").unwrap_or_else(|_| {
        args.iter()
            .skip(1)
            .next()
            .cloned()
            .unwrap_or_else(|| format!("{}/.atmux/state.db", cwd))
    });
    let atmux_bin = env::var("ATMUX_ORCHD_ATMUX_BIN").unwrap_or_else(|_| "atmux".to_string());
    let team_dir = env::var("ATMUX_ORCHD_TEAM_DIR").unwrap_or_else(|_| cwd.clone());

    // ADR-249 — singleton guard. Take an exclusive advisory lock on a
    // per-DB lockfile BEFORE the boot banner / Database::open so a second
    // orchd against the same team's state.db refuses to start instead of
    // double-dispatching every event + racing the spawn-dedup gate. The
    // returned File is bound for the whole of main() (kernel releases the
    // flock on exit/crash — no stale-lock cleanup). Different teams have
    // different canonical DB parents → no false collision.
    let lock_path = singleton_lock_path(&db_path);
    let _orchd_lock = match acquire_singleton_lock(&lock_path) {
        Ok(lock) => lock,
        Err(e) => {
            eprintln!(
                "{} 🔴 orchd singleton guard · refusing to start — {} · another orchd already supervises this DB; exiting to avoid duplicate dispatch (ADR-249)",
                now_ts(),
                e
            );
            return ExitCode::from(5);
        }
    };

    // e-12-640853f3 §S5 — startup banner. Consumer list mirrors
    // src/core/orchd-bootstrap.ts; sweep cadence mirrors S6 ticker.
    eprintln!(
        "{} 🧭 orchd boot · v{} team={} root={} db={}",
        now_ts(),
        env!("CARGO_PKG_VERSION"),
        team_name_from_path(&team_dir),
        team_dir,
        db_path
    );
    eprintln!(
        "{} 📋 orchd consumers · {} subscribed: {}",
        now_ts(),
        CONSUMERS.len(),
        CONSUMERS
            .iter()
            .map(|c| c.name.trim_start_matches("atmux:"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    eprintln!(
        "{} ⏱  orchd cadence · ctx-scan+budget 15min · housekeep 24h · log-rotate hourly",
        now_ts()
    );

    // e-12-640853f3 §S1 — log rotation. Check + rotate orchd.log if it
    // exceeds ATMUX_ORCHD_LOG_MAX_BYTES (default 50 MB). Keeps
    // ATMUX_ORCHD_LOG_KEEP_N rotated files (default 3) so worst-case
    // disk = ~150 MB per team. In-process check at startup + once per
    // hour during the wake loop — no external logrotate dep, no cron
    // (per ADR-233 + operator stance 2026-05-24).
    rotate_log_if_oversize(&team_dir);

    let db = match Database::open(&db_path) {
        Ok(db) => db,
        Err(e) => {
            eprintln!("atmux-orchd: Database::open({}) failed: {}", db_path, e);
            return ExitCode::from(3);
        }
    };

    // Load initial offsets — one per consumer. The Vec index matches
    // the CONSUMERS slice index so `offsets[i]` is `CONSUMERS[i]`'s
    // last-processed event_id.
    let mut offsets: Vec<String> = match CONSUMERS
        .iter()
        .map(|c| load_offset(&db, c.name).map_err(|e| format!("{:?}", e)))
        .collect()
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!("atmux-orchd: failed to load initial offsets: {}", e);
            return ExitCode::from(4);
        }
    };

    // ADR-256 §Poison-event tripwire — per-consumer consecutive-failure
    // tracker, lives for the whole supervisor lifetime so strikes persist
    // across wakes (a poison event re-delivered every 60s timeout drain
    // accumulates strikes until it trips, rather than resetting each wake).
    let mut strikes: PoisonStrikes = HashMap::new();

    // Initial drain — catch up anything that landed while orchd was
    // down. The handler dispatch is at-least-once per ADR-203 §D7;
    // duplicate processing is the failure mode (handlers are idempotent
    // by contract).
    if let Err(e) = drain_and_dispatch(&db, &atmux_bin, &team_dir, &mut offsets, &mut strikes) {
        eprintln!("atmux-orchd: initial drain error: {}", e);
    }

    // UpdateEvents — raw wake channel from the Honker watcher thread.
    // Wakes on ANY db commit (including non-event commits like kanban
    // writes). On wake, we re-drain both topics; non-event commits
    // produce zero new events and no Bun spawns.
    let events = db.update_events();
    eprintln!("atmux-orchd: subscribed, entering wake loop");

    // ADR-280 stage 3 removed the e-11-446429c9 §S6 in-process 5-min
    // sweep ticker. It spawned `atmux orchd --sweep-merges`, a subverb
    // that walked kanban epics and dispatched an EPIC-TEAM merge — both
    // of its dispatchers (the in-cage `atmux epic-merge tick` and
    // `core/orchd-dispatch/epic-merge.ts`) are retired, so the subverb
    // has no implementation left and was removed with them. Leaving the
    // ticker armed would have spawned a failing subprocess every 5
    // minutes, silently, into a log nobody reads.
    // e-12-640853f3 §S1 — log rotation tick (every hour). Cheap stat
    // call; rename when oversized.
    let rotate_interval = Duration::from_secs(3600);
    let mut last_rotate_at = Instant::now();
    // e-13-04c8b3bf — context-saturation scan tick (every 15min per
    // operator stance 2026-05-24: "wdyt about sweeping for the
    // context saturation every 15m instead of 5m"). Captures each
    // member's pane statusline; emits member.context-high events
    // for over-threshold members. Lead consumer (e-cc3728bf) wakes
    // and decides handoff/rotate.
    let context_scan_interval = Duration::from_secs(15 * 60);
    let mut last_context_scan_at = Instant::now();
    // e-12-640853f3 §S4 — housekeep tick (every 24h). Prunes old
    // events / stale offsets / rotated logs / merger_state terminal
    // rows. In-process per anti-cron stance.
    let housekeep_interval = Duration::from_secs(24 * 60 * 60);
    let mut last_housekeep_at = Instant::now();
    // Fire one context scan + budget scan at startup so the
    // lead sees current saturation state without waiting 15min.
    spawn_scan_context(&atmux_bin, &team_dir);
    spawn_scan_budget(&atmux_bin, &team_dir);
    // Housekeep is NOT fired at startup — would slow boot. Let the
    // first 24h tick drive it; orphans are tolerable for one day.

    loop {
        match events.recv_timeout(Duration::from_secs(60)) {
            Ok(Some(())) => {
                // DB commit observed — drain both topics.
                if let Err(e) =
                    drain_and_dispatch(&db, &atmux_bin, &team_dir, &mut offsets, &mut strikes)
                {
                    eprintln!("atmux-orchd: drain error: {}", e);
                }
            }
            Ok(None) => {
                // 60s timeout with no DB commit — belt-and-braces drain
                // in case the watcher missed an event (rare; defends
                // against subtle Honker bugs without depending on its
                // perfect-delivery guarantee).
                if let Err(e) =
                    drain_and_dispatch(&db, &atmux_bin, &team_dir, &mut offsets, &mut strikes)
                {
                    eprintln!("atmux-orchd: timeout drain error: {}", e);
                }
            }
            Err(e) => {
                eprintln!("atmux-orchd: watcher closed ({}), exiting", e);
                return ExitCode::SUCCESS;
            }
        }
        // Hourly log rotation check (e-12-640853f3 §S1). Cheap.
        if last_rotate_at.elapsed() >= rotate_interval {
            rotate_log_if_oversize(&team_dir);
            last_rotate_at = Instant::now();
        }
        // 15min context-saturation scan (e-13-04c8b3bf) + budget scan
        // (e-14-0f156732). Same cadence per operator stance.
        if last_context_scan_at.elapsed() >= context_scan_interval {
            spawn_scan_context(&atmux_bin, &team_dir);
            spawn_scan_budget(&atmux_bin, &team_dir);
            last_context_scan_at = Instant::now();
        }
        // 24h housekeep (e-12-640853f3 §S4).
        if last_housekeep_at.elapsed() >= housekeep_interval {
            spawn_housekeep(&atmux_bin, &team_dir);
            last_housekeep_at = Instant::now();
        }
    }
}

/// e-12-640853f3 §S5 — short local-clock timestamp prefix. Format
/// `HH:MM:SSZ` (UTC) — mirrors Bun-side `isoLocalTs()` in
/// src/core/orchd-log-fmt.ts. Operators reading the orchd pane see
/// the same shape from both halves.
fn now_ts() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("[{:02}:{:02}:{:02}Z]", h, m, s)
}

/// Derive the team name from the team_dir path's basename for the
/// startup banner. Best-effort; falls back to the path itself when
/// the basename can't be extracted.
fn team_name_from_path(team_dir: &str) -> String {
    Path::new(team_dir)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(team_dir)
        .to_string()
}

/// e-12-640853f3 §S1 — rotate `.atmux/logs/orchd.log` when it exceeds
/// `ATMUX_ORCHD_LOG_MAX_BYTES` (default 50 MB). Keeps
/// `ATMUX_ORCHD_LOG_KEEP_N` rotated files (default 3). Best-effort:
/// any IO failure is logged + ignored — never aborts orchd.
fn rotate_log_if_oversize(team_dir: &str) {
    let max_bytes: u64 = env::var("ATMUX_ORCHD_LOG_MAX_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50 * 1024 * 1024);
    let keep_n: usize = env::var("ATMUX_ORCHD_LOG_KEEP_N")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3);

    let log_path = Path::new(team_dir).join(".atmux/logs/orchd.log");
    let metadata = match fs::metadata(&log_path) {
        Ok(m) => m,
        Err(_) => return, // log doesn't exist yet — nothing to rotate
    };
    if metadata.len() < max_bytes {
        return;
    }

    // Shift orchd.log.{N-1} → orchd.log.N down to orchd.log → orchd.log.1
    for i in (1..keep_n).rev() {
        let from = log_path.with_extension(format!("log.{}", i));
        let to = log_path.with_extension(format!("log.{}", i + 1));
        let _ = fs::rename(&from, &to);
    }
    let first_rotated = log_path.with_extension("log.1");
    match fs::rename(&log_path, &first_rotated) {
        Ok(()) => {
            eprintln!(
                "{} 🧹 log-rotate · size={} bytes (cap={}) · rotated → {}",
                now_ts(),
                metadata.len(),
                max_bytes,
                first_rotated.display()
            );
        }
        Err(e) => {
            eprintln!(
                "{} 🔴 log-rotate failed · {} (size={} bytes)",
                now_ts(),
                e,
                metadata.len()
            );
        }
    }
}

/// Spawn `atmux orchd <subverb> --team-dir <dir>` and wait BOUNDED by
/// `tick_timeout()` (ADR-256 §Bounded-wait). Shared by every periodic tick
/// (sweep / budget-scan / housekeep / context-scan) so a wedged tick child
/// can no longer freeze the orchd supervisor thread — the prior
/// `Command::status()` blocked unboundedly, meaning one hung sweep would
/// stop ALL event dispatch + every later tick. `label`/`icon` drive the
/// per-tick log line. Non-fatal: any failure (non-zero exit, spawn fault,
/// timeout) is logged; the next tick retries. On success the Bun subverb
/// has already written its own `[ts]`-prefixed summary line, so we stay
/// quiet to avoid double-noise.
fn run_tick_bounded(atmux_bin: &str, team_dir: &str, subverb: &str, icon: &str, label: &str) {
    eprintln!("{} {} {}-tick · firing Bun subverb", now_ts(), icon, label);
    let child = Command::new(atmux_bin)
        .arg("orchd")
        .arg(subverb)
        .arg("--team-dir")
        .arg(team_dir)
        .spawn();
    let child = match child {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{} 🔴 {}-tick · spawn failed: {}", now_ts(), label, e);
            return;
        }
    };
    match wait_bounded(child, tick_timeout(), &format!("{}-tick", label)) {
        WaitOutcome::Exited(Some(0)) => {}
        WaitOutcome::Exited(code) => {
            eprintln!(
                "{} 🔴 {}-tick · subverb exit={:?}",
                now_ts(),
                label,
                code
            );
        }
        WaitOutcome::TimedOut => {
            eprintln!(
                "{} 🔴 {}-tick · TIMED OUT after {}s — killed; next tick retries",
                now_ts(),
                label,
                tick_timeout().as_secs()
            );
        }
    }
}

/// e-14-0f156732 — spawn the Bun-side `--scan-budget` subverb. Same
/// pattern as scan-context. Consolidates existing budget probe +
/// runBudgetCheck + Discord renderers per ADR-238.
fn spawn_scan_budget(atmux_bin: &str, team_dir: &str) {
    run_tick_bounded(atmux_bin, team_dir, "--scan-budget", "💰", "budget-scan");
}

/// e-12-640853f3 §S4 — spawn the Bun-side `--housekeep` subverb. Same
/// pattern as scan-context.
fn spawn_housekeep(atmux_bin: &str, team_dir: &str) {
    run_tick_bounded(atmux_bin, team_dir, "--housekeep", "🧹", "housekeep");
}

/// e-13-04c8b3bf — spawn the Bun-side `--scan-context` subverb.
/// Fire-and-forget (bounded). Subverb writes its own
/// summary line; we only log on non-success to avoid double-noise.
fn spawn_scan_context(atmux_bin: &str, team_dir: &str) {
    run_tick_bounded(atmux_bin, team_dir, "--scan-context", "📊", "ctx-scan");
}

// ADR-256 §Tests + ADR-249 coverage reconciliation. Before this module
// `cargo test` ran 0 tests, making ADR-249's "Tests: covered" claim false.
// These tests make it true: the singleton-lock-path collision matrix is
// exercised directly (relative vs absolute argv of the same DB ⇒ one
// canonical lock; different teams ⇒ distinct locks), and the acquire/refuse
// path is exercised as a same-process double-flock (the deterministic,
// non-flaky equivalent of "a second orchd against the same dbPath exits 5
// with the refusal log" — the refusal log + ExitCode::from(5) in main() is
// driven by exactly the Err returned here). Plus: bounded-wait
// exit/timeout outcomes, the poison-tripwire dead-letter row, the UUIDv7
// generator's shape/ordering/uniqueness, and the fail-closed env parsing.
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// std-only unique tmpdir under the OS temp root — avoids a `tempfile`
    /// crate dep (the build must not network-fetch). PID + a per-process
    /// atomic counter guarantee no collision across parallel test threads.
    fn unique_tmpdir(tag: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = env::temp_dir().join(format!(
            "atmux-orchd-test-{}-{}-{}",
            tag,
            std::process::id(),
            n
        ));
        fs::create_dir_all(&dir).expect("create tmpdir");
        dir
    }

    /// Mirror the Bun-side events-table DDL (src/abstractions/sqlite-
    /// migrations.ts v10→v11) so emit_dead_letter has a table to INSERT
    /// into. Identical to atmux-cockpit-mirror's bootstrap_schema.
    fn create_events_table(db: &Database) {
        db.with_conn(|c| {
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS events (
                   event_id TEXT PRIMARY KEY NOT NULL,
                   topic TEXT NOT NULL,
                   payload TEXT NOT NULL,
                   emitted_at_sec INTEGER NOT NULL,
                   schema_version INTEGER NOT NULL DEFAULT 1
                 );",
            )
        })
        .expect("create events table");
    }

    // ---- ADR-249 singleton-lock collision matrix -------------------------

    #[test]
    fn singleton_lock_relative_and_absolute_collide_for_same_db() {
        // The SAME team's DB referenced two ways — bare filename
        // (canonicalizes parent to CWD) vs the same path with an explicit
        // "./" prefix — MUST resolve to one canonical lockfile, else two
        // orchd with different argv styles for the same DB both start.
        let tmp = unique_tmpdir("collide");
        let db_abs = tmp.join("state.db");
        // Touch the DB so the parent dir is real + canonicalize-able.
        fs::write(&db_abs, b"").expect("touch db");

        let abs = singleton_lock_path(db_abs.to_str().unwrap());
        let with_dot = singleton_lock_path(
            tmp.join("./state.db").to_str().unwrap(),
        );
        assert_eq!(
            abs, with_dot,
            "absolute and ./-prefixed argv of the same DB must share one lock"
        );
        assert!(
            abs.ends_with("state.db.orchd.lock"),
            "lock filename derives from the DB basename, got {}",
            abs
        );
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn singleton_lock_distinct_teams_never_collide() {
        // Two teams = two different DB parent dirs → two distinct locks.
        // Without canonicalize-by-parent this is the duplicate-spawn bug
        // ADR-249 closes (a naive basename-only key would collide both
        // teams' `state.db` onto one lock).
        let team_a = unique_tmpdir("team-a");
        let team_b = unique_tmpdir("team-b");
        fs::write(team_a.join("state.db"), b"").unwrap();
        fs::write(team_b.join("state.db"), b"").unwrap();

        let lock_a = singleton_lock_path(team_a.join("state.db").to_str().unwrap());
        let lock_b = singleton_lock_path(team_b.join("state.db").to_str().unwrap());
        assert_ne!(
            lock_a, lock_b,
            "different teams' state.db must derive DISTINCT locks"
        );
        fs::remove_dir_all(&team_a).ok();
        fs::remove_dir_all(&team_b).ok();
    }

    #[test]
    fn singleton_lock_path_for_missing_parent_falls_back_without_panicking() {
        // Parent dir doesn't exist → canonicalize fails → falls back to
        // the parent as-given (no panic, still a usable path).
        let p = singleton_lock_path("/nonexistent-atmux-dir-xyz/.atmux/state.db");
        assert!(p.ends_with("state.db.orchd.lock"), "got {}", p);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn singleton_lock_second_acquire_refuses() {
        // The acquire/refuse path that drives main()'s ExitCode::from(5) +
        // the "🔴 orchd singleton guard · refusing to start" log. A second
        // flock against the SAME lockfile (separate open fd, same path)
        // must fail with LOCK_NB — this is the exact Err that main() maps
        // to exit 5. Same-process double-flock is the deterministic,
        // non-flaky equivalent of spawning a second orchd binary.
        let tmp = unique_tmpdir("refuse");
        let lock_path = tmp.join("state.db.orchd.lock");
        let lock_path_str = lock_path.to_str().unwrap();

        let first = acquire_singleton_lock(lock_path_str)
            .expect("first acquire should succeed");
        assert!(first.is_some(), "first acquire holds a lock fd on Linux");

        let second = acquire_singleton_lock(lock_path_str);
        assert!(
            second.is_err(),
            "second acquire on a held lock must refuse (drives exit 5)"
        );
        let msg = second.unwrap_err();
        assert!(
            msg.contains("another orchd holds"),
            "refusal message should name the contention, got: {}",
            msg
        );

        // Release the first lock (drop the fd) and prove a fresh acquire
        // now succeeds — the kernel releases flock on fd close, so an
        // incumbent's death lets the next orchd take over (ADR-249
        // self-healing, no stale-lock GC).
        drop(first);
        let third = acquire_singleton_lock(lock_path_str)
            .expect("acquire after release should succeed");
        assert!(third.is_some());
        fs::remove_dir_all(&tmp).ok();
    }

    // ---- ADR-256 bounded-wait -------------------------------------------

    #[test]
    fn wait_bounded_returns_exit_code_for_fast_child() {
        // A child that exits before the deadline yields its real code.
        let child = Command::new("sh")
            .arg("-c")
            .arg("exit 0")
            .spawn()
            .expect("spawn fast child");
        let outcome = wait_bounded(child, Duration::from_secs(30), "fast");
        assert_eq!(outcome, WaitOutcome::Exited(Some(0)));
    }

    #[test]
    fn wait_bounded_propagates_nonzero_exit() {
        let child = Command::new("sh")
            .arg("-c")
            .arg("exit 7")
            .spawn()
            .expect("spawn child");
        let outcome = wait_bounded(child, Duration::from_secs(30), "rc7");
        assert_eq!(outcome, WaitOutcome::Exited(Some(7)));
    }

    #[test]
    fn wait_bounded_kills_hung_child_on_deadline() {
        // A child that sleeps far past the deadline must be SIGTERM→
        // SIGKILL'd and reported TimedOut — this is the freeze the whole
        // ADR-256 §Bounded-wait fix exists to prevent. We bound the
        // overall wall-clock to deadline + grace + slack to prove the call
        // itself does not block unboundedly.
        let child = Command::new("sh")
            .arg("-c")
            .arg("sleep 120")
            .spawn()
            .expect("spawn hung child");
        let started = Instant::now();
        let outcome = wait_bounded(child, Duration::from_millis(150), "hung");
        let elapsed = started.elapsed();
        assert_eq!(outcome, WaitOutcome::TimedOut);
        // 150ms deadline + 5s grace ceiling + generous slack. The sleeper
        // dies on SIGTERM immediately (well under grace), so this is fast.
        assert!(
            elapsed < Duration::from_secs(TERM_GRACE_SECS + 8),
            "bounded wait must not block unboundedly; took {:?}",
            elapsed
        );
    }

    // ---- ADR-256 poison-event dead-letter -------------------------------

    #[test]
    fn emit_dead_letter_writes_operator_visible_row() {
        let tmp = unique_tmpdir("deadletter");
        let db_path = tmp.join("state.db");
        let db = Database::open(db_path.to_str().unwrap()).expect("open db");
        create_events_table(&db);

        emit_dead_letter(&db, "atmux:orchd:auto-merge", "e-poison-1", "task.done", 5, 42);

        let (topic, payload): (String, String) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT topic, payload FROM events WHERE topic = 'orchd.event-dead-lettered'",
                    [],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
            })
            .expect("dead-letter row should exist");
        assert_eq!(topic, "orchd.event-dead-lettered");
        let v: JsonValue = serde_json::from_str(&payload).expect("payload is json");
        assert_eq!(v["consumer"], "atmux:orchd:auto-merge");
        assert_eq!(v["deadEventId"], "e-poison-1");
        assert_eq!(v["deadTopic"], "task.done");
        assert_eq!(v["strikes"], 5);
        assert_eq!(v["lastExitCode"], 42);
        // Envelope mirrors BasePayloadFields so operators see the familiar
        // shape; eventId is a real UUIDv7 (version nibble 7).
        let event_id = v["eventId"].as_str().expect("eventId present");
        assert_eq!(
            event_id.replace('-', "").chars().nth(12),
            Some('7'),
            "dead-letter eventId must be a UUIDv7"
        );
        fs::remove_dir_all(&tmp).ok();
    }

    // ---- ADR-256 UUIDv7 generator ---------------------------------------

    #[test]
    fn uuidv7_now_has_v7_shape_and_is_unique() {
        let a = uuidv7_now();
        let b = uuidv7_now();
        // 36 chars, hyphenated 8-4-4-4-12.
        assert_eq!(a.len(), 36, "uuid length");
        let parts: Vec<&str> = a.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        let hex = a.replace('-', "");
        // Version nibble (13th hex char) == '7'.
        assert_eq!(hex.chars().nth(12), Some('7'), "version nibble");
        // Variant: high two bits of the 17th hex char's byte == 0b10, i.e.
        // the nibble is one of 8/9/a/b.
        let variant_nibble = hex.chars().nth(16).unwrap();
        assert!(
            matches!(variant_nibble, '8' | '9' | 'a' | 'b'),
            "variant nibble was {}",
            variant_nibble
        );
        // Distinct even back-to-back — the process-lifetime atomic seq is
        // mixed into the entropy so two same-millisecond emissions never
        // collide on the PRIMARY KEY events.event_id. (We do NOT assert
        // same-ms lexicographic ordering: like the Bun-side uuidv7.ts the
        // 74 low bits are pseudo-random, so within one millisecond the
        // order is undefined — that's RFC 9562's optional monotonic-random
        // method, which neither half implements. Cross-ms ordering — the
        // load-bearing property for the events table's `event_id ASC`
        // drain — is asserted below.)
        assert_ne!(a, b, "consecutive uuids must be unique");
    }

    #[test]
    fn uuidv7_now_is_time_ordered_across_milliseconds() {
        // The 48-bit big-endian millisecond-timestamp prefix dominates the
        // lexicographic sort across distinct milliseconds — the property
        // the `events` table relies on (`ORDER BY event_id ASC` == creation
        // order). Sleep past a ms boundary so the two IDs land in different
        // timestamp buckets, then assert ordering.
        let earlier = uuidv7_now();
        std::thread::sleep(Duration::from_millis(3));
        let later = uuidv7_now();
        assert!(
            earlier < later,
            "uuidv7 from distinct milliseconds must sort by time: {earlier} < {later}"
        );
        // And the embedded timestamp of `later` is >= `earlier`'s.
        let ts = |id: &str| -> u64 {
            let hex = id.replace('-', "");
            u64::from_str_radix(&hex[0..12], 16).unwrap()
        };
        assert!(ts(&later) > ts(&earlier), "embedded ms timestamp advances");
    }

    // ---- ADR-256 fail-closed env parsing --------------------------------

    #[test]
    fn env_u64_or_falls_back_on_bad_or_zero_values() {
        // A unique key per assertion avoids cross-test env races.
        let key = format!("ATMUX_TEST_ENV_{}", std::process::id());
        env::remove_var(&key);
        assert_eq!(env_u64_or(&key, 600), 600, "unset → default");
        env::set_var(&key, "not-a-number");
        assert_eq!(env_u64_or(&key, 600), 600, "garbage → default");
        env::set_var(&key, "0");
        assert_eq!(env_u64_or(&key, 600), 600, "zero → default (no self-DoS)");
        env::set_var(&key, "  120  ");
        assert_eq!(env_u64_or(&key, 600), 120, "trimmed valid → parsed");
        env::remove_var(&key);
    }
}
