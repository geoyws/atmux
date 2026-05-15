# ADR-141: Symlink Claude skills + memories across all accounts via dotfiles

**Status**: Accepted (2026-05-15, t-2736bfa9 ships scripts + ADR; dotfiles-repo init + execution operator-driven)
**Date**: 2026-05-15
**Author**: whip-impl (t-2736bfa9)
**Driver-ref**: 2026-05-14 driver session — operator: *"make sure all claude files are symlinked and shared amongst all claude accounts via dotfiles"* → clarified to *"skills and memories i mean"*.
**Relates**: operator dotfiles repo at `~/work/journals/.sb/_dotfiles`; CLAUDE.md memory discipline section; [[project_claude_shared_adr_141]] project memory.

## Context

The operator runs Claude across **five account directories** on a single machine:

```
~/.claude            (default account)
~/.claude-personal   (personal projects)
~/.claude-unum       (Unum side project)
~/.claude-ifca       (IFCA work)
~/.claude-icloud     (iCloud-bridged account)
```

Each account independently accumulates **project memories** under `~/.claude-*/projects/<project-slug>/memory/` and **skill workspaces** under `~/.claude-*/skills/<skill>/`. Today's layout has two distinct pain points:

### Pain point 1 — fragmented memory across the same project

The atmux project (`-root-work-src-atmux`) currently has **four independent memory trees** — one per account that has worked on it. Each tree accumulates its own `MEMORY.md` index + leaf memory files. Switching accounts mid-investigation (e.g. personal → unum → ifca) loses the prior account's reasoning trail; the new account starts cold even though the same operator did the prior work.

`[[feedback_overnight_reddit_stakes]]` makes this worse: overnight runs that span multiple Claude accounts (one budget exhausts, switch to fallback account) get a discontinuous memory store, defeating the cross-conversation continuity memory was supposed to provide.

### Pain point 2 — skill workspaces drift per-account

Most skills under `~/.claude*/skills/` are plugin-cache symlinks managed by `claude plugins install` — those stay correctly per-account because they're version-pinned per account. But a handful of skills carry **workspace state** alongside the symlink (e.g. `superdoctor/` carries `lead-queue.md` + `state/`). Those workspace dirs drift across accounts: the personal account's superdoctor state isn't visible from unum's, etc.

## Decision

Establish canonical shared paths under the operator's dotfiles repo + symlink each account's path to canonical. Single source of truth per project memory tree; per-skill workspace state shared across accounts; auth + sessions + plugin-cache stay strictly per-account.

### (D1) Canonical layout under dotfiles

```
~/work/journals/.sb/_dotfiles/claude-shared/
├── skills/                     <-- shared skill workspace state (NOT plugin-cache)
│   └── superdoctor/            <-- one workspace per skill, shared across accounts
│       ├── lead-queue.md
│       └── state/
└── memory/
    ├── -root-work-src-atmux/   <-- one memory tree per project slug
    ├── -root-work-ifca-src-sopx-root/
    └── ...                      <-- additional projects discovered on audit
```

### (D2) Per-account symlinks

Each `~/.claude-*/projects/<slug>/memory` becomes a symlink to `~/work/journals/.sb/_dotfiles/claude-shared/memory/<slug>`. Each `~/.claude-*/skills/<workspace-skill>` becomes a symlink to `~/work/journals/.sb/_dotfiles/claude-shared/skills/<workspace-skill>`.

The `~/.claude` default account participates the same way — no special-case for the unprefixed account.

### (D3) What stays per-account (NOT shared)

- **`auth.json`** + credential blobs — NEVER share auth across accounts. Each account has its own OAuth tokens, refresh state, plan tier. Cross-account auth sharing breaks Anthropic's isolation guarantees + creates audit confusion.
- **`sessions/`** — per-conversation state. Sessions are bound to the account that initiated them; sharing would route resume traffic to the wrong API endpoint.
- **`plugins/cache/`** — version-pinned per account. Each account independently runs `claude plugins install`; the cache reflects that account's pinned versions.
- **`settings.json`** — has per-account permission rules, hooks, env vars. Could share parts (the non-permission parts) but the per-account permission rules are intentional. Deferred to a future ADR if a sharing pattern emerges.

### (D4) Migration shape

Operator runs the consolidation manually with sessions stopped (or with a brief drain window) per `scripts/claude-shared-migrate.sh`:

1. **Audit phase** (`scripts/claude-shared-audit.sh`) — walks all per-account project memory dirs + skill workspaces; reports diffs, sizes, conflict-suggestion per project.
2. **Pick winning content** per project — operator chooses on conflict; default is "most recently modified" wins; losing content backed up to `~/work/journals/.sb/_dotfiles/claude-shared/_archive-<YYYY-MM-DD>/`.
3. **Move winning content to canonical** — `mv` (not `cp`) so we don't accumulate duplicates.
4. **Symlink from each account** — `ln -s` from each per-account path to the canonical store.
5. **Dotfiles init** — `_dotfiles/init-claude-shared.sh` (lives in the dotfiles repo, NOT in this atmux repo) recreates the symlinks on a fresh machine. The init script is part of operator's dotfiles bootstrap chain.

### (D5) Concurrency + safety

- **Sessions-stopped invariant**: migration step (3) `mv` is non-atomic across the in-flight memory write hot path. Operator stops all Claude sessions OR uses a quiet window (no active panes writing memory) before running `--apply`.
- **Dry-run default**: `claude-shared-migrate.sh` is dry-run-by-default. `--apply` is the explicit gate; without it the script prints what WOULD change.
- **Idempotent re-run**: every step skips when the target state is already correct (canonical exists + symlink points there). Re-running on a migrated state is a no-op.
- **Backup before destroy**: losing-side content moves to `_archive-<DATE>/` not `rm`. Operator can recover any merged-away memory by walking the archive.

## Scope (single Task, deliverables split by repo)

### Lands in this atmux repo (in-scope for whip-impl ship under t-2736bfa9)

1. **This ADR** at `docs/adr/141-claude-shared-skills-memories.md`.
2. **`scripts/claude-shared-audit.sh`** — read-only audit; reports diffs/sizes; safe to run any time.
3. **`scripts/claude-shared-migrate.sh`** — dry-run-by-default migration; `--apply` writes changes.
4. **`CHANGELOG.md`** entry under the current `[Unreleased]` block.

### Lands in operator's dotfiles repo (out-of-scope for this ship; operator drives)

5. **`_dotfiles/init-claude-shared.sh`** — recreates symlinks on a fresh machine. Sourced by `_dotfiles/init.sh`.
6. **`_dotfiles/README-claude-shared.md`** — canonical layout doc + how to extend per new project.
7. **Smoke test** — operator-driven; write memory from one account, read from another, assert content matches.

The dotfiles-repo bits are out-of-scope because the dotfiles repo is a sibling repo (`~/work/journals/.sb/_dotfiles`, submodule of `.sb`), not the atmux repo. Operator handles those edits in the same migration session.

## Tradeoffs

### Bounded vs unbounded — migration is reversible

| Choice | Risk shape | Pick? |
|---|---|---|
| Shared symlinks + dry-run-first migration + backup-on-conflict | **Bounded**: dry-run shows the plan; conflicts surface for operator review; losing-side content archived not destroyed; re-running migration is a no-op. Worst case: one project's memory gets merged-when-it-should-have-stayed-split, operator recovers from `_archive-*/`. | ✅ |
| Skip the dotfiles + manage each account separately | **Unbounded**: every account-switch costs cross-conversation memory continuity; overnight runs spanning accounts lose reasoning trails; the same memory entry gets re-learned 4× in parallel. | ❌ |
| Symlink the entire `~/.claude*` directory tree | **Unbounded**: shares auth credentials across accounts (security breach), shares sessions (resume routes to wrong API endpoint), shares plugins/cache (version-conflict thrash). | ❌ |

### Merge conflicts during initial migration

If two accounts have non-trivial memory for the same project, the migration can't auto-resolve which wins. Three handling options:

- (A) Default to "most recently modified" wins, backup loser to `_archive-*/`. Operator reviews archive after.
- (B) Halt migration on conflict; operator picks per-project.
- (C) Concatenate both memory trees (interleave MEMORY.md indices).

**Pick (A)** — most recent likely reflects current intent; archive preserves recovery; (B) blocks the whole migration on first conflict; (C) creates duplicate memory entries that defeat the index. Audit script surfaces conflicts BEFORE migration so operator can pre-decide.

### In-flight memory writes during migration

If a Claude session is writing memory at the exact moment the migration `mv`s the file, the write either lands at the OLD path (lost — old path is about to be replaced with a symlink to canonical) OR at the NEW canonical path (correct — symlink resolves transparently).

**Mitigation**: operator stops sessions (or uses a quiet window) before `--apply`. The migrate script's preamble checks `ps -ef | grep claude | wc -l` and warns if processes are running — non-fatal but operator-visible.

## Cross-references

- **Operator dotfiles repo**: `~/work/journals/.sb/_dotfiles` (submodule of `.sb`). The canonical store lives under `_dotfiles/claude-shared/` so dotfiles deploy auto-recreates it on a fresh machine.
- **CLAUDE.md "Auto memory" section** — describes the per-project memory layout this ADR makes shared. The path discipline (project slug, MEMORY.md as index, leaf files for individual entries) doesn't change; only the storage location changes.
- **`[[feedback_overnight_reddit_stakes]]`** memory — overnight cross-account runs lose continuity today; this ADR fixes that.
- **`[[project_claude_shared_adr_141]]`** memory — pre-ADR design note; this ADR formalizes the decision the memory captured.
- **`atmux/scripts/`** — sibling to `backfill-driver-only.sh` + `backfill-story-branch.ts`. The two new scripts follow the same "one-shot operator-driven migration with dry-run-default" pattern.

## Open questions

**OQ-1 — `~/.claude` vs `~/.claude-personal` for the default**

The unprefixed `~/.claude` is the default account; `~/.claude-personal` is an explicit personal account. They COULD be the same account (just two paths) OR different accounts. Today they're separate dirs; the migration treats them as separate accounts to share.

**Recommended default**: treat them as separate accounts that SHARE the same canonical store (same as `.claude-unum` / `.claude-ifca`). If they're actually the same account, the symlinks resolve identically — no breakage. If they're separate, both still pull from canonical — same intent.

**OQ-2 — Project-slug discovery on fresh machine**

The migration runs against the operator's CURRENT set of project slugs (everything that has a memory dir today). When a new project starts on a fresh machine, the init script (in dotfiles) needs to know to set up the symlink for the new slug.

**Recommended default**: deferred. The init script can be re-run on demand when a new project's memory dir first appears in any account. Auto-discovery on every `cd` would require a shell hook; out of scope for v1. Operator runs `init-claude-shared.sh` after any new project's first memory write.

## Implementation notes (for the scripts)

### `scripts/claude-shared-audit.sh`

- Read-only — no `mv`, no `ln -s`, no destructive ops.
- Walks every `~/.claude*/projects/*/memory` + every `~/.claude*/skills/*`.
- Reports per-project: which accounts have memory, total size, list of leaf files, suggested winning account (most-recent-mtime).
- Output a single table to stdout — operator pipes to `less` or `tee`.

### `scripts/claude-shared-migrate.sh`

- `--apply` required to write changes; bare invocation is dry-run.
- Per-project workflow:
  1. Read content from the winning account (most-recent-mtime by default; `--prefer <account>` operator override per project).
  2. Backup losing-side content to `_archive-<YYYY-MM-DD>/<account>/<slug>/`.
  3. `mv` winning content to canonical (`~/work/journals/.sb/_dotfiles/claude-shared/memory/<slug>/`).
  4. `rm -rf` each account's old path (after backup).
  5. `ln -s` canonical from each account's path.
- Idempotent: if canonical already exists AND every account's path is already a symlink to canonical → skip silently.
- Pre-flight: check for running Claude processes; warn operator if any are alive.

## Out of scope

- Sharing auth credentials (`auth.json`) across accounts — explicitly forbidden by design.
- Sharing `settings.json` — defer to future ADR if a sharing pattern emerges.
- Cross-machine sync (Mac local ↔ hax) — already handled by the dotfiles repo's existing sync mechanism; this ADR is single-machine scope.
- Per-account memory carve-outs (operator-marked memories that should stay account-specific) — v1 assumes memory is project-scoped not account-scoped. If account-specific patterns emerge, a future ADR adds an `account-only/` subdir under the memory tree that the symlink mechanism skips.
