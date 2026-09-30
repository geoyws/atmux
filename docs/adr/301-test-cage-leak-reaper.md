# ADR-301: Test-cage leak reaper — SAFETY invariant + `atmux test-reaper` verb

**Status**: accepted (reviewer signoff 2026-09-29, after the tmuxSocket containment fix)
**Date**: 2026-09-29
**Driver-ref**: kb atmux t-164af71d (epic e-eb778642, refiled by George 2026-09-28, a-a5c9cb84)
**Builds on**: [ADR-178](178-test-cage-leak-reaper.md) (sidecar schema + verb shape; Status: proposed (deferred) — substance stands, schedule slipped)

## Context

`spinTmux` (`tests/unit/verbs/cockpit.test.ts`, the only in-repo copy —
`rg spinTmux` shows no shared-helper copies) `mkdtemp`s a socket dir
under the OS tmpdir and spawns a real tmux server inside. JS cleanup
hooks (`try/finally` + `afterAll` + `process.on('exit')`) never fire on
SIGKILL, so servers leak (~140–280MB RSS each, complaint c-27a1c8f4).
ADR-178 designed the fix (sidecar + verb) but its impl never shipped;
the sidecar half has since landed in `cockpit.test.ts` (`spinTmux`
writes `<socketDir>/.leak-tracker.json` synchronously on spawn with
`{ tmuxSocket, socketDir, parentPid, createdAt, testFile, testName,
prefix }`, removed with the dir on happy-path teardown). This ADR
records the implementation decisions for the verb half, chiefly the
SAFETY invariant that lets an operator run a recursive deleter against
the shared tmpdir without fear.

## Decision

### D1 — SAFETY invariant (normative)

The reaper only ever acts on (kills a server for + `rm -rf`s) a
directory that satisfies ALL of:

1. (a) it is a direct child of the resolved OS tmpdir (enumerated via
   one `readdir` of the tmpdir root — never a recursive walk, so
   nothing outside the tmpdir is even named);
2. (b) its basename matches the spinTmux prefix pattern
   `<prefix>-<rest>-<mkdtemp-suffix>` (default prefix `atmux-cockpit`);
3. (c) it holds a parseable `.leak-tracker.json` sidecar whose
   `socketDir` field string-equals the directory's own resolved path
   (a sidecar copied or pointed elsewhere fails closed to
   warn-and-skip);
4. (d) it is not a symlink — an `lstat` check skips symlinked entries
   before any read, so the reaper never follows a link out of the
   tmpdir and never resolves a socket path through one.
5. (e) per [ADR-305](305-per-user-private-socket-dirs.md) §D2
   (added 2026-09-30, revision 3): it is ours alone — a descriptor
   walk (`privateDirIssue`) shows it owned by the caller's uid with no
   group/other bit, reached through a chain no other uid can rewrite —
   and its `sock` is neither a symlink nor another uid's. The
   `kill-server` dial runs the ADR-305 connect-time guard right before
   it spawns, and the removal re-runs the ownership walk right before
   it deletes. A directory failing any of this is reported
   `unsafe-skipped` (dry runs too) and never dialled or removed: root's
   reaper must never kill a server through another user's planted link
   or delete another user's tree.

In particular it never touches any other tmux socket: the live
cockpit and team cages live under `~/.atmux/` socket paths (ADR-018),
never directly under the OS tmpdir with a spinTmux basename, and
without a matching sidecar they are invisible to the reaper even if
copied there.

### D2 — Reap gate: dead parent AND old age

A directory passing D1 is reaped only when BOTH hold:

- the recorded `parentPid` is dead: `process.kill(pid, 0)` throws
  `ESRCH`, plus a `ps -p <pid> -o command=` check guards against pid
  reuse (a live pid whose command line is still a `bun test` run
  counts as alive even if the numeric pid was recycled);
- `createdAt` is older than `--max-age-min` (default 30) — same-run
  survivors of still-running suites are never reaped.

Anything else (`parent-alive`, `too-young`, `missing-sidecar`,
`corrupt-sidecar`, `symlink-skipped`, `unsafe-skipped`) is kept, and the sidecar-less/corrupt cases emit a
stderr warning. Reap = `tmux -S <tmuxSocket> kill-server` (with
`TMUX` scrubbed from env so the kill never escapes to the caller's
server) + `rm -rf` of that socket dir only.

### D3 — Verb surface

`atmux test-reaper [--max-age-min N] [--dry-run] [--prefix P]
[--json]` (`src/verbs/test-reaper.ts`, dispatched from `src/cli.ts`,
one line in `src/verbs/help.ts`). `--dry-run` lists (`would-reap`)
and kills/removes nothing. `--json` prints
`{ dryRun, results: [{ socketDir, status }] }`; text mode prints one
`reaped|would-reap<TAB><dir>` line per acted-on dir. Exit 0 always
(usage errors exit 64 via `UsageError`); warnings go to stderr.

### D4 — Test seams

The verb takes injected `tmpDir / nowSeconds / parentIsDead /
killServer / removeDir / stdout / stderr` deps so the full matrix
(dead+old → reaped; live → kept; young → kept; missing/garbage
sidecar → kept; socketDir-mismatch → kept; symlink → kept; dry-run
reaps nothing; `--json` shape) runs without touching real tmux,
real pids, or the real tmpdir. One real-tmux integration test is
allowed, only against a server the test itself spawned in its own
temp dir.

### D5 — Explicitly out of scope (follow-up, not this diff)

`bunfig.toml` preload wiring + CI-script (`scripts/test-ci.sh`)
before/after hooks stay OUT — separate follow-up Task. The verb is
operator-invoked until then.

## Consequences

- Operators can cron or pre-test `atmux test-reaper --dry-run` first,
  then arm the real sweep, with the D1 invariant as the documented
  reason a tmpdir-wide recursive deleter is safe to run.
- `groom --zombie-sweep` remains the sidecar-independent backstop
  (RUNBOOK-grooming); this verb is the precise, sidecar-traced layer.
- Amends nothing in ADR-178 — it implements ADR-178's T3 verb step
  under the D1 safety contract new here.
