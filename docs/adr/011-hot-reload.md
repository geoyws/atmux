# ADR-011: Erlang-style hot reload — brief / config / lib

**Status**: accepted
**Date**: 2026-04-25
**Epic**: E3 (`e-fcee9723`)
**Driver-ref**: `driver-inbox.md` @ 15:35 MYT 2026-04-25 (verbs 1–6 spec)

## Context

Today, evolving a running team requires destructive operations:

- **Brief edits mid-Epic**: `atmux rotate <member>` `/clear`s the pane — loses all in-memory reasoning context (~30s of context-rebuild per rotate, plus the cost of /clearing genuinely valuable in-flight thinking).
- **Config changes (team.json)**: `atmux start --force` kills the entire session — catastrophic for in-flight work across the whole team.
- **Broken `lib/*.sh`**: doesn't propagate to running members until they re-shell. CLI-side invocations (`atmux <verb>`) re-source libs each time, but long-running pane state stays on the broken version.

Driver proposed 6 verbs inspired by Erlang/OTP BEAM's hot-code-swap:

1. `atmux brief-reload <member>` — re-paste fresh brief WITHOUT `/clear`.
2. `atmux config-reload [--member <m>]` — re-read team.json, push delta notifications.
3. `atmux swap-tui <member> --to <tui>` — migrate claude→opencode→kimi without losing inbox/Tasks.
4. `atmux verify-libs` — sources every `lib/*.sh` in a subshell, reports defined functions.
5. **Versioned briefs** — `templates/briefs/*.md` track version; whip auto-pings on bump.
6. **Erlang-style code-per-process versioning** — claim-time brief snapshot + per-Task reconciliation.

## Decisions

### D1 — E3 ships verbs 1+2+4+5; verbs 3+6 carved into recommended E5 spinoff

**E3 = static-state hot reload.** Brief content, team.json config, lib/*.sh integrity, brief versioning. All operate on files written to disk, read on demand, with no per-claim coupling.

**E5 (recommended) = pane lifecycle + per-claim state.** TUI swap (verb 3) tears down a running tmux pane and replaces it with a different TUI binary while preserving inbox + claimed Tasks. Erlang-style per-claim brief snapshot (verb 6) requires schema work in the inbox JSON to record which brief version was active at claim time and a reconciliation step on `claim --next`. Both have rich corner-case surface (mid-spawn race, in-flight Task transfer, brief-version-during-Task drift, atomic upgrade across heterogeneous TUIs) that deserves its own ADR.

**Why carve**: E3's 4 verbs are tactical (~1 day each per driver estimate). E5's 2 verbs are foundational (multi-day each). Bundling them dilutes E3's velocity and leaks E5's complexity into a release the team can otherwise ship inside a week. Driver themselves flagged "(possibly its own E5)" — concur, formalising here.

### D2 — `brief-reload` skips on bad pane state; `--force` bypasses

Before pasting a new brief into a member's pane, `brief-reload` reads `atmux::capture_pane <member> 30` and greps for blocker banners: `Compacting conversation`, `Press up to edit queued messages`, `approaching usage limit`, `hit your limit`, `thinking with`. If any present: log + exit 1, don't paste. `--force` flag overrides.

**Why**: Pasting a brief into a "Press up to edit queued messages" pane appends the brief to the queued message buffer — the brief becomes the next user message instead of a new context entry, scrambling intent. Pasting into a Compacting pane racing the harness's own compaction can corrupt either or both. Pasting into a "thinking with" pane lands during model output — at best ignored, at worst interleaved with response tokens.

This mirrors lib/flags.sh D4 from ADR-010 (banner-detect skips tmux send-keys to lead). One pattern, two callers.

`--force` exists for the rare case where the lead knows the banner is stale (seen it stuck for 5+ minutes, capture-pane is misreading) and wants to push through. Costs a config-aware operator; safe default is skip.

### D3 — `config-reload` is delta-only notification; no respawn, no auto-apply

`config-reload` reads team.json, computes per-member delta against `.atmux/state/spawn-snapshot.json` (written at start time), and pings each affected member with `⚙️ CONFIG RELOAD: your <field> changed: <old>→<new>. Apply on next dispatch.` Members with no delta: silent. NO tmux respawn. NO model swap exec. NO `/clear`.

**Why**: Auto-apply (e.g., respawn pane with new model) is destructive — same problem as `atmux start --force`. Delta-only notification respects member autonomy: they finish current Task on the OLD config (reasoning continuity), apply on next dispatch (clean cut). This is the soft form of Erlang per-claim versioning (verb 6) — verbal protocol instead of schema-enforced. When E5 ships, schema-enforced replaces verbal.

`--member <m>` flag scopes the reload to one member if the operator only changed that member's config — saves N-1 useless pings.

### D4 — Brief versioning uses HTML comment `<!-- brief-version: v1 -->` as first-line marker

Every `templates/briefs/*.md` gets a first-line marker. HTML comment so the marker is invisible when the brief renders in the pane (markdown comments don't render). State at `.atmux/state/brief-versions.json`: `{<member>: {role, version, pastedAt}}`.

**Why HTML comment**: Frontmatter (`---\nversion: v1\n---`) would break the existing brief-render path (sed substitution doesn't strip frontmatter; pane would see literal `---` lines). A magic-line convention (`Brief version: v1` as a literal first-line) would render in the pane as visible text — not invisible. HTML comment is markdown-native, invisible on render, parseable with a single regex. `v0` is the default for marker-less briefs (legacy graceful — existing briefs don't break until upgraded).

`brief-versions.json` is nested (not flat `{member: vN}`) so future fields (`role`, `pastedAt`, eventual `claimVersion` from E5) can extend the schema without breaking the format.

## Consequences

**What changes**

- New `lib/reload.sh` (~200 LOC) with `brief-reload` and `config-reload` subcommands.
- New `lib/verify_libs.sh` (~80 LOC).
- `lib/doctor.sh` gains `libs:` check (~10 LOC).
- `lib/start.sh` writes `.atmux/state/spawn-snapshot.json` and `brief-versions.json`.
- `lib/rotate.sh` and `lib/reload.sh` update `brief-versions.json` on paste.
- `lib/whip.sh` gains `_atmux_whip_check_brief_versions` (~30 LOC).
- `lib/common.sh` gains `atmux::brief_version <role>` helper.
- All 7 (+1 alias) `templates/briefs/*.md` get `<!-- brief-version: v1 -->` first-line marker.
- 3 new bats files: `tests/unit/reload.bats`, `tests/unit/verify_libs.bats`, `tests/unit/brief_versions.bats`.
- 1 new e2e: `tests/e2e/reload.bats`.
- `bin/atmux` gains 3 dispatcher entries (`reload`, `verify-libs`, plus `brief-reload`/`config-reload` as `reload` subcommands).
- CHANGELOG v0.5.0 entry consolidated alongside E2 + E4.

**What breaks**

- Nothing for existing teams. `atmux brief-reload` / `config-reload` / `verify-libs` are new verbs. Brief markers are HTML comments — invisible to pane render. `brief-versions.json` writes are additive — no existing reader depends on absence.

**What we give up (until E5)**

- TUI swap mid-session. Workaround: `atmux stop --force` + edit team.json + `atmux start`. Accepted cost for v0.5.0.
- Erlang per-claim brief snapshot. Workaround: D3's verbal protocol — members finish current Task on old config, apply on next dispatch. Coordination via brief-reload pings.
- Mid-spawn race handling, in-flight Task transfer guarantees. Out of scope until E5's ADR addresses pane lifecycle.

**Cross-Epic relationship**

- `lib/rotate.sh` is touched by both **E2/T1.1** (writes `<member>-rotated.epoch`) and **E3/T3.3** (writes `brief-versions.json` entry on rotate-paste). Edits are additive (different code paths in `main()`); gitter sequences commits or merges if both land same SHA.
- `lib/whip.sh` is touched by **E2/T2.x** (rotated.epoch read + autoRotate exec), **E2/T3.1** (banner preclear), **E4/T6.1** (open p0 flags surface), **E3/T3.4** (brief-version mismatch). All four are independent helper-function additions to whip.sh's main(). Gitter commit ordering matters; merge conflicts unlikely (each adds a new helper + one main() invocation).

## Open questions deferred to future Epics

- `atmux brief-reload --all` — bulk reload all members on brief bump. Defer; lead can scripts this with a `for` loop today.
- Auto-reload on brief bump (skip the manual `brief-reload` step entirely). Defer; lead might want manual gate for safety.
- `verify-libs` integration into pre-commit hook. Defer; reviewer can opt in per-project.
- TUI swap (verb 3). **Recommended E5.**
- Erlang per-claim brief snapshot (verb 6). **Recommended E5.**
- Brief diff renderer (`atmux brief-diff <role>` shows v1→v2 changes). Nice-to-have; defer until needed.
