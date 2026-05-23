// atmux-cockpit-mirror — cockpit-scope event-consumer daemon
// (ADR-219). Singleton per cockpit. Reads fleet-mirrored events from
// `~/.atmux/cockpit-events.db` and dispatches each whitelisted event
// to a Bun handler subprocess (`atmux cockpit-mirror --handle-one
// --event-id <id> --topic <t>`). The per-team mirror WRITER half lives
// in atmux-relayd (or a future writer crate per ADR-219 §OQ1); this
// crate is purely the READER side.
//
// Architecture mirror of rust/atmux-relayd/src/main.rs:
//
//   1. `Database::open(~/.atmux/cockpit-events.db)` — Honker bootstraps
//      its own internal tables on open; we additionally ensure the
//      application-level `events` + `subscriber_offsets` tables exist
//      (created idempotently from inline DDL kept in sync with
//      `src/abstractions/sqlite-migrations.ts`).
//   2. Stays subscribed via `db.update_events()`; idle RSS ~5MB.
//   3. On each notification: query events for new rows past each
//      consumer's offset; for each new event in a whitelisted topic,
//      spawn `atmux cockpit-mirror --handle-one --event-id <id>
//      --topic <t>` as a one-shot Bun subprocess.
//   4. On clean exit (rc=0): advance the consumer's offset and loop.
//      On non-zero exit: log and DON'T advance — next wake re-attempts.
//
// Lifecycle:
//   - parent dies (tmux pane killed, cockpit-start cleanup, kernel OOM
//     SIGKILL) → PR_SET_PDEATHSIG(SIGTERM) terminates this process on
//     Linux. Mirrors atmux-relayd.
//   - SIGTERM/SIGINT → break out of subscription loop, exit 0.
//   - In-flight Bun child gets SIGTERM via process-group cascade.
//
// Configuration via env:
//   ATMUX_COCKPIT_MIRROR_DB    — path to cockpit-events.db
//                                (default: $HOME/.atmux/cockpit-events.db)
//   ATMUX_COCKPIT_MIRROR_BIN   — path to atmux binary
//                                (default: `atmux` on PATH)

use std::env;
use std::process::{Command, ExitCode};
use std::time::Duration;

use honker::Database;
use rusqlite::params;

/// Linux-only: kernel sends SIGTERM when our parent dies. Closes the
/// orphan-after-SIGKILL teardown hole. See atmux-listener + atmux-relayd
/// for the same pattern.
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

/// ADR-219 §D3 v1 topic whitelist. Each entry: subscriber-offset name
/// (`atmux:cockpit-mirror:<topic>`) + topic literal queried in the
/// events table + the topic literal passed through to Bun's handler.
/// Adding a new topic = one entry here + the Bun-side topic-switch
/// handler in `src/verbs/cockpit-mirror.ts`.
struct ConsumerCfg {
    name: &'static str,
    topic: &'static str,
    /// The Bun-side `--topic` argument value the handler will use to
    /// dispatch internally. Must match the topic literal in
    /// `src/schema/events.ts::TOPICS`.
    bun_topic: &'static str,
}

const CONSUMERS: &[ConsumerCfg] = &[
    ConsumerCfg {
        name: "atmux:cockpit-mirror:epic.merge_ready",
        topic: "epic.merge_ready",
        bun_topic: "epic.merge_ready",
    },
    ConsumerCfg {
        name: "atmux:cockpit-mirror:epic.spawn_blocked",
        topic: "epic.spawn_blocked",
        bun_topic: "epic.spawn_blocked",
    },
    ConsumerCfg {
        name: "atmux:cockpit-mirror:team.spawned",
        topic: "team.spawned",
        bun_topic: "team.spawned",
    },
    ConsumerCfg {
        name: "atmux:cockpit-mirror:team.dissolved",
        topic: "team.dissolved",
        bun_topic: "team.dissolved",
    },
    ConsumerCfg {
        name: "atmux:cockpit-mirror:budget.warning",
        topic: "budget.warning",
        bun_topic: "budget.warning",
    },
    ConsumerCfg {
        name: "atmux:cockpit-mirror:budget.recovered",
        topic: "budget.recovered",
        bun_topic: "budget.recovered",
    },
    ConsumerCfg {
        name: "atmux:cockpit-mirror:gitter.escalated",
        topic: "gitter.escalated",
        bun_topic: "gitter.escalated",
    },
];

/// Idempotent schema bootstrap. Honker manages its own internal tables
/// via `Database::open()`; this fn additionally ensures the application-
/// level `events` + `subscriber_offsets` tables exist. DDL kept in sync
/// with `src/abstractions/sqlite-migrations.ts` (v0→v1 events table +
/// the index + subscriber_offsets per-consumer offsets).
///
/// Re-runs are cheap no-ops via `CREATE TABLE IF NOT EXISTS`. We do
/// NOT track migration version here — application-level migrations
/// remain Bun-owned on the per-team state.db; cockpit-events.db is a
/// dedicated mirror DB whose schema is frozen at v1 unless this crate
/// updates the bootstrap DDL.
fn bootstrap_schema(db: &Database) -> Result<(), String> {
    let r: rusqlite::Result<()> = db.with_conn(|c| {
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
               event_id TEXT PRIMARY KEY NOT NULL,
               topic TEXT NOT NULL,
               payload TEXT NOT NULL,
               emitted_at_sec INTEGER NOT NULL,
               schema_version INTEGER NOT NULL DEFAULT 1
             );
             CREATE INDEX IF NOT EXISTS events_topic_id ON events(topic, event_id);
             CREATE TABLE IF NOT EXISTS subscriber_offsets (
               consumer_name TEXT PRIMARY KEY NOT NULL,
               last_event_id TEXT NOT NULL,
               last_processed_at_sec INTEGER NOT NULL
             );",
        )?;
        Ok(())
    });
    r.map_err(|e| format!("bootstrap_schema error: {}", e))
}

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

/// Spawn `atmux cockpit-mirror --handle-one --event-id <id> --topic <t>`.
/// Returns the child's exit code (None when killed by signal). No
/// `--team-dir` flag — cockpit-mirror is cockpit-scoped, not per-team.
fn dispatch_to_bun(atmux_bin: &str, event_id: &str, topic: &str) -> Option<i32> {
    let mut cmd = Command::new(atmux_bin);
    cmd.arg("cockpit-mirror")
        .arg("--handle-one")
        .arg("--event-id")
        .arg(event_id)
        .arg("--topic")
        .arg(topic);
    let output = match cmd.status() {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "atmux-cockpit-mirror: spawn `{} cockpit-mirror --handle-one` failed: {}",
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
    offsets: &mut Vec<String>,
) -> Result<usize, String> {
    let mut processed = 0;
    for (idx, cfg) in CONSUMERS.iter().enumerate() {
        let current_offset = &offsets[idx];
        let new_event_ids = drain_topic(db, cfg.topic, current_offset, 1000)?;
        for event_id in new_event_ids {
            let code = dispatch_to_bun(atmux_bin, &event_id, cfg.bun_topic);
            match code {
                Some(0) => {
                    save_offset(db, cfg.name, &event_id)?;
                    offsets[idx] = event_id.clone();
                    processed += 1;
                    println!(
                        "atmux-cockpit-mirror: handled {} eventId={} (consumer={})",
                        cfg.bun_topic, event_id, cfg.name
                    );
                }
                Some(other) => {
                    eprintln!(
                        "atmux-cockpit-mirror: bun handler exit rc={} on {} eventId={} (consumer={}); NOT advancing offset; will retry next wake",
                        other, cfg.bun_topic, event_id, cfg.name
                    );
                    // Don't continue this consumer's drain — re-attempt next wake.
                    break;
                }
                None => {
                    eprintln!(
                        "atmux-cockpit-mirror: bun handler killed-by-signal on {} eventId={} (consumer={}); NOT advancing offset",
                        cfg.bun_topic, event_id, cfg.name
                    );
                    break;
                }
            }
        }
    }
    Ok(processed)
}

fn default_db_path() -> String {
    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    format!("{}/.atmux/cockpit-events.db", home)
}

fn main() -> ExitCode {
    install_parent_death_signal();

    let db_path =
        env::var("ATMUX_COCKPIT_MIRROR_DB").unwrap_or_else(|_| default_db_path());
    let atmux_bin =
        env::var("ATMUX_COCKPIT_MIRROR_BIN").unwrap_or_else(|_| "atmux".to_string());

    eprintln!(
        "atmux-cockpit-mirror: starting (db={}, atmux={})",
        db_path, atmux_bin
    );

    let db = match Database::open(&db_path) {
        Ok(db) => db,
        Err(e) => {
            eprintln!(
                "atmux-cockpit-mirror: Database::open({}) failed: {}",
                db_path, e
            );
            return ExitCode::from(3);
        }
    };

    // ADR-219 §D2: bootstrap `events` + `subscriber_offsets` if absent
    // on first open. Honker's own tables are bootstrapped by
    // `Database::open` itself; application-level tables are this
    // crate's responsibility (per ADR-219 §OQ2 default).
    if let Err(e) = bootstrap_schema(&db) {
        eprintln!("atmux-cockpit-mirror: schema bootstrap failed: {}", e);
        return ExitCode::from(4);
    }

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
            eprintln!(
                "atmux-cockpit-mirror: failed to load initial offsets: {}",
                e
            );
            return ExitCode::from(5);
        }
    };

    // Initial drain — catch up anything that landed while the mirror
    // was down. The handler dispatch is at-least-once per ADR-202
    // §D7; duplicate processing is the failure mode (handlers are
    // idempotent by contract).
    if let Err(e) = drain_and_dispatch(&db, &atmux_bin, &mut offsets) {
        eprintln!("atmux-cockpit-mirror: initial drain error: {}", e);
    }

    // UpdateEvents — raw wake channel from the Honker watcher thread.
    // Wakes on ANY db commit. On wake, we re-drain all whitelisted
    // topics; non-event commits produce zero new events and no Bun
    // spawns.
    let events = db.update_events();
    eprintln!("atmux-cockpit-mirror: subscribed, entering wake loop");

    loop {
        match events.recv_timeout(Duration::from_secs(60)) {
            Ok(Some(())) => {
                if let Err(e) = drain_and_dispatch(&db, &atmux_bin, &mut offsets) {
                    eprintln!("atmux-cockpit-mirror: drain error: {}", e);
                }
            }
            Ok(None) => {
                // 60s timeout — belt-and-braces drain in case the
                // watcher missed an event (rare; defends against subtle
                // Honker bugs without depending on its perfect-delivery
                // guarantee). Same pattern as atmux-relayd.
                if let Err(e) = drain_and_dispatch(&db, &atmux_bin, &mut offsets) {
                    eprintln!("atmux-cockpit-mirror: timeout drain error: {}", e);
                }
            }
            Err(e) => {
                eprintln!("atmux-cockpit-mirror: watcher closed ({}), exiting", e);
                return ExitCode::SUCCESS;
            }
        }
    }
}
