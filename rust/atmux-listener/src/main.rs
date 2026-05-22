// atmux-listener — subprocess companion to `atmux committer --daemon`
// (and future event-driven consumers). Wraps Honker's native
// `Database::listen()` blocking iterator and streams wake events to
// stdout, one line per notification, so the Bun parent can block on
// `read()` instead of polling the SQLite events table.
//
// **Why this exists**: from SQL (bun:sqlite), the `_honker_notifications`
// table can only be polled via `MAX(id)` cursor reads. Honker's native
// Rust API (`Database::listen`) returns a blocking iterator backed by
// an mpsc channel fed by a background watcher thread. With the
// `kernel-watcher` cargo feature, that watcher uses notify-rs filesystem
// events on the SQLite WAL file — true kernel-blocking wake (~1ms),
// zero in-process polling. Without it, Honker falls back to its
// PRAGMA data_version polling loop, which is still inside Honker's
// Rust thread rather than ours.
//
// Either way: from the Bun parent's perspective, we're a black-box
// subprocess that prints a line every time a relevant event lands.
// Parent's daemon does `read_line()` instead of `SELECT MAX(id)` —
// the polling location moves out of our process, and (with
// kernel-watcher) out of any process at all.
//
// **Wire protocol** (stdout, line-buffered):
//   ready\n                                  — emitted once on subscribe success
//   <channel>\t<payload>\n                   — one line per notification
//
// Channel format matches Honker's stream-publish convention:
//   `honker:stream:<topic>` (e.g. `honker:stream:task.done`)
// Payload is whatever `honker_stream_publish(topic, key, payload)`
// wrote. atmux's emit() writes `JSON.stringify(eventPayload)` — but
// we don't parse it here; we just forward the bytes verbatim so the
// parent can decide its own deserialization strategy. Keeps this
// binary protocol-version-agnostic.
//
// **Exit codes**:
//   0  — clean exit (parent closed stdin, subscription dropped, etc.)
//   2  — usage error (wrong arg count)
//   3  — Database::open failed (db path absent / SQLite open error)
//   4  — Database::listen failed (channel name invalid, honker init error)
//   5  — Subscription iterator yielded an error (rare — watcher panic)
//
// **Lifecycle**:
//   - Parent passes `<state.db path>` + `<channel>` as argv[1..3].
//   - Parent reads stdout line-by-line. EOF means we exited.
//   - We exit if stdout write fails (broken pipe = parent died).
//   - SIGTERM/SIGINT exit cleanly via Subscription's Drop impl
//     (which calls `unsubscribe` on the inner Honker handle).
//
// **What this is NOT**:
//   - Not a daemon. It's a foreground subprocess managed by the parent.
//   - Not durable. Notifications missed during downtime are caught by
//     the parent's `drainSince()` SQL drain on next start. Honker's
//     `_honker_notifications` table is the at-least-once spool; we're
//     just the wake-up signal.
//   - Not an authority on event content. We forward raw payloads.

use std::env;
use std::io::{self, Write};
use std::process::ExitCode;

use honker::Database;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!(
            "atmux-listener: usage: {} <state.db path> <channel>\n  channel example: honker:stream:task.done",
            args.first().map(String::as_str).unwrap_or("atmux-listener"),
        );
        return ExitCode::from(2);
    }

    let db_path = &args[1];
    let channel = &args[2];

    let db = match Database::open(db_path) {
        Ok(db) => db,
        Err(e) => {
            eprintln!(
                "atmux-listener: Database::open({}) failed: {}",
                db_path, e
            );
            return ExitCode::from(3);
        }
    };

    let mut sub = match db.listen(channel) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "atmux-listener: Database::listen({}) failed: {}",
                channel, e
            );
            return ExitCode::from(4);
        }
    };

    // Signal readiness so the parent knows the subscription is live.
    // Without this the parent can't distinguish "still spinning up" from
    // "subscribed but nothing has happened yet."
    let mut stdout = io::stdout().lock();
    if writeln!(stdout, "ready").is_err() || stdout.flush().is_err() {
        return ExitCode::SUCCESS;
    }

    loop {
        match sub.recv() {
            Some(Ok(notification)) => {
                // Forward channel + payload verbatim. The parent
                // already knows the channel (it passed it in argv) but
                // surfacing it here keeps the protocol uniform when a
                // future variant subscribes to multiple channels.
                if writeln!(stdout, "{}\t{}", notification.channel, notification.payload).is_err()
                    || stdout.flush().is_err()
                {
                    // Parent's stdin closed (broken pipe). Exit clean.
                    return ExitCode::SUCCESS;
                }
            }
            Some(Err(e)) => {
                eprintln!("atmux-listener: subscription error: {}", e);
                return ExitCode::from(5);
            }
            None => {
                // Watcher dropped (Honker internal thread died) — exit
                // clean so the parent can decide whether to respawn.
                return ExitCode::SUCCESS;
            }
        }
    }
}
