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

use std::env;
use std::fs;
use std::path::Path;
use std::process::{Command, ExitCode};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use honker::Database;
use rusqlite::params;
use serde_json::Value as JsonValue;

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
/// [<extra_args>...]`. Returns the child's exit code (None when killed
/// by signal). `extra_args` carry the optional `--task-id <id> --lane <l>`
/// payload hints for the lean per-event dispatch path (ADR-202
/// §Amendment 2026-05-22 IX-A); empty slice = legacy no-hints dispatch.
fn dispatch_to_bun(
    atmux_bin: &str,
    team_dir: &str,
    event_id: &str,
    topic: &str,
    consumer_id: Option<&str>,
    extra_args: &[(&str, &str)],
) -> Option<i32> {
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
    let output = match cmd.status() {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "atmux-orchd: spawn `{} orchd --handle-one` failed: {}",
                atmux_bin, e
            );
            return None;
        }
    };
    output.code()
}

fn drain_and_dispatch(
    db: &Database,
    atmux_bin: &str,
    team_dir: &str,
    offsets: &mut Vec<String>,
) -> Result<usize, String> {
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
            let code = dispatch_to_bun(
                atmux_bin,
                team_dir,
                &event_id,
                cfg.bun_topic,
                cfg.bun_consumer_id,
                &extra_refs,
            );
            match code {
                Some(0) => {
                    save_offset(db, cfg.name, &event_id)?;
                    offsets[idx] = event_id.clone();
                    processed += 1;
                    println!(
                        "atmux-orchd: handled {} eventId={} (consumer={})",
                        cfg.bun_topic, event_id, cfg.name
                    );
                }
                Some(other) => {
                    eprintln!(
                        "atmux-orchd: bun handler exit rc={} on {} eventId={} (consumer={}); NOT advancing offset; will retry next wake",
                        other, cfg.bun_topic, event_id, cfg.name
                    );
                    // Don't continue this consumer's drain — re-attempt next wake.
                    break;
                }
                None => {
                    eprintln!(
                        "atmux-orchd: bun handler killed-by-signal on {} eventId={} (consumer={}); NOT advancing offset",
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
        "{} ⏱  orchd cadence · sweep-merges every 300s · log-rotate when oversize",
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

    // Initial drain — catch up anything that landed while orchd was
    // down. The handler dispatch is at-least-once per ADR-203 §D7;
    // duplicate processing is the failure mode (handlers are idempotent
    // by contract).
    if let Err(e) = drain_and_dispatch(&db, &atmux_bin, &team_dir, &mut offsets) {
        eprintln!("atmux-orchd: initial drain error: {}", e);
    }

    // UpdateEvents — raw wake channel from the Honker watcher thread.
    // Wakes on ANY db commit (including non-event commits like kanban
    // writes). On wake, we re-drain both topics; non-event commits
    // produce zero new events and no Bun spawns.
    let events = db.update_events();
    eprintln!("atmux-orchd: subscribed, entering wake loop");

    // e-11-446429c9 §S6 — in-process 5-min sweep ticker. NOT a
    // crontab entry per operator anti-cron stance (2026-05-24): "no
    // crons because they're leaky and dangerous". This timer dies
    // with the orchd binary — no on-disk scheduler artifact.
    //
    // Cadence: 300s between sweeps. Wakes off the same 60s recv
    // timeout we already use; per-wake we check elapsed and fire
    // when due.
    let sweep_interval = Duration::from_secs(300);
    let mut last_sweep_at = Instant::now();
    // e-12-640853f3 §S1 — log rotation tick (every hour). Cheap stat
    // call; rename when oversized.
    let rotate_interval = Duration::from_secs(3600);
    let mut last_rotate_at = Instant::now();
    // Fire one sweep at startup (after the initial drain) to catch
    // unattended epics whose events fired while orchd was offline +
    // weren't picked up because their consumer was stub at the time.
    spawn_sweep_merges(&atmux_bin, &team_dir);

    loop {
        match events.recv_timeout(Duration::from_secs(60)) {
            Ok(Some(())) => {
                // DB commit observed — drain both topics.
                if let Err(e) = drain_and_dispatch(&db, &atmux_bin, &team_dir, &mut offsets) {
                    eprintln!("atmux-orchd: drain error: {}", e);
                }
            }
            Ok(None) => {
                // 60s timeout with no DB commit — belt-and-braces drain
                // in case the watcher missed an event (rare; defends
                // against subtle Honker bugs without depending on its
                // perfect-delivery guarantee).
                if let Err(e) = drain_and_dispatch(&db, &atmux_bin, &team_dir, &mut offsets) {
                    eprintln!("atmux-orchd: timeout drain error: {}", e);
                }
            }
            Err(e) => {
                eprintln!("atmux-orchd: watcher closed ({}), exiting", e);
                return ExitCode::SUCCESS;
            }
        }
        // After each wake, check the sweep ticker. Fire if due.
        if last_sweep_at.elapsed() >= sweep_interval {
            spawn_sweep_merges(&atmux_bin, &team_dir);
            last_sweep_at = Instant::now();
        }
        // Hourly log rotation check (e-12-640853f3 §S1). Cheap.
        if last_rotate_at.elapsed() >= rotate_interval {
            rotate_log_if_oversize(&team_dir);
            last_rotate_at = Instant::now();
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

/// e-11-446429c9 §S6 — spawn the Bun-side `--sweep-merges` subverb.
/// Fire-and-forget; the subprocess writes its JSON result to stdout,
/// which the orchd pane's `tee` captures into the per-team log. Errors
/// are non-fatal: a failed sweep doesn't compromise the event-driven
/// fast-path; next tick retries.
fn spawn_sweep_merges(atmux_bin: &str, team_dir: &str) {
    eprintln!("{} 🧭 sweep-tick · firing Bun subverb", now_ts());
    let status = Command::new(atmux_bin)
        .arg("orchd")
        .arg("--sweep-merges")
        .arg("--team-dir")
        .arg(team_dir)
        .status();
    match status {
        Ok(s) if s.success() => {
            // The Bun subverb already wrote its own [ts]-prefixed
            // summary line to stdout (via formatSweepReport); we only
            // log on non-success here to avoid double-noise.
        }
        Ok(s) => {
            eprintln!(
                "{} 🔴 sweep-tick · subverb exit={:?}",
                now_ts(),
                s.code()
            );
        }
        Err(e) => {
            eprintln!("{} 🔴 sweep-tick · spawn failed: {}", now_ts(), e);
        }
    }
}
