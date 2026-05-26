# ADR-243: Runtime-configurable claude accounts — `~/.atmux/claude-accounts.json` replaces hardcoded `WRAPPER_TABLE`

**Status**: Accepted (operator-direct 2026-05-25 *"yes please"* in response to recommended fix shape)

**Date**: 2026-05-25

**Driver-ref**: 2026-05-25 conversation:
- *"did we already have atmux config for using claude accounts? right now it's requiring a recompile of the binary just to include a new claude account"*
- *"yes please"* (greenlighting the recommended runtime-config-file fix)

**Cross-refs**:
- [ADR-094](094-c-alias-spawn-convention.md) — c-alias spawn convention. Defines what the wrapper names (`c-u`, `c-ic`, etc.) actually do at the shell level (per-account `CLAUDE_CONFIG_DIR` + canonical flag bake). Unchanged by this ADR — wrappers still live on the operator's PATH; this ADR only relocates the **configDir → wrapper-name mapping table** from source to runtime config.
- [ADR-167](167-cockpit-rotate-verb.md) — wrapper-resolver consumer. `cockpit-rotate` calls `resolveClaudeWrapper(configDir)` to pick the respawn command for cockpit roles. Consumer-side API doesn't change; only the lookup table's source-of-truth moves.
- [ADR-241](241-atmux-start-preflight-deps-wizard.md) — preflight wizard. Bootstrap of `~/.atmux/claude-accounts.json` on first-run-missing folds into the same preflight pass as the vendored-deps install: one prompt covers both gaps if both are missing.
- Global CLAUDE.md §Spawn Pattern — operator-side shell wrappers (`c-u`, `c-ic`, etc.) on PATH. This ADR is the atmux-side complement: atmux now reads the operator's claude-accounts file instead of having a baked-in copy of the same data.

## Context

Adding a new claude account to atmux today requires editing `src/abstractions/claude-account-wrapper.ts:31-37`:

```ts
const WRAPPER_TABLE: ReadonlyMap<string, ClaudeWrapper> = new Map([
  ["/root/.claude", "claude"],
  ["/root/.claude-unum", "c-u"],
  ["/root/.claude-icloud", "c-ic"],
  ["/root/.claude-ifca", "c-i"],
  ["/root/.claude-proton", "c-p"],
]);
```

Five fixed entries. To add a sixth (or rename one, or drop one), the operator must:

1. Edit the TS source.
2. Run `bun run build:install` (or equivalent) to re-bundle atmux into `/opt/atmux/<v>/bin/atmux`.
3. Re-install to the active version path.
4. Restart everything that uses the old bundle.

This is a four-step ritual for a one-line data change. The operator's complaint *"right now it's requiring a recompile of the binary just to include a new claude account"* is accurate — atmux is TS but ships bundled, and source-resident data inherits all the friction of compiled-language data.

The Rust binaries (`atmux-orchd`, `atmux-listener`, `atmux-cockpit-mirror`) have zero hardcoded account references — only the TS bundle is affected. Scope of this ADR is therefore exactly one file.

ADR-094 + ADR-167 both predate the operator-mutability conversation; both treat the wrapper set as source-resident because that's what existed when they were written. Neither is invalidated by relocating the table to runtime config; both consumers continue to call `resolveClaudeWrapper(configDir)` with no signature change.

## Decision

### D1 — `~/.atmux/claude-accounts.json` is the new source-of-truth

New runtime config file. Schema:

```jsonc
{
  "schemaVersion": 1,
  "accounts": [
    { "configDir": "/root/.claude",         "wrapper": "claude" },
    { "configDir": "/root/.claude-unum",    "wrapper": "c-u"   },
    { "configDir": "/root/.claude-icloud",  "wrapper": "c-ic"  },
    { "configDir": "/root/.claude-ifca",    "wrapper": "c-i"   },
    { "configDir": "/root/.claude-proton",  "wrapper": "c-p"   }
  ]
}
```

- `schemaVersion: 1` — frozen at this number for now. Future schema changes increment + bring a migration path (`src/core/claude-accounts-migrate.ts` per ADR-098-style locking + atomic-write). Unknown `schemaVersion` → refuse to start with a clear ConfigError.
- `accounts[]` — ordered. Order is preserved verbatim in the in-memory `Map` (insertion order is iteration order). The order matters only for `knownClaudeConfigDirs()` enumeration in error hints — operator sees the file's order in error messages.
- `configDir` — absolute path string. NOT existence-checked at load time (operator may register an account whose configDir doesn't exist yet, e.g. before running `claude --setup` on it). Existence-check happens lazily at first spawn attempt against that account, where today's error path already covers missing configDirs.
- `wrapper` — string name of the shell wrapper on PATH. NOT PATH-probed at load time (same reasoning — operator may declare a wrapper before installing it). Resolution happens at spawn time per existing ADR-094 semantics.
- Both `configDir` and `wrapper` are validated as non-empty strings; duplicate `configDir` entries → ConfigError at load time (ambiguous mapping).

### D2 — Code lookup chain: config file → embedded defaults → refuse

`src/abstractions/claude-account-wrapper.ts` becomes a loader, not a literal table. New shape:

1. **Load `~/.atmux/claude-accounts.json`** at module-init time (once per atmux process; cached). Parse + validate schema + build the in-memory `Map<string, ClaudeWrapper>`.
2. **If the file is absent**, fall back to the **embedded defaults** — same 5 entries as today's `WRAPPER_TABLE`. This keeps existing hosts working without operator action. Emit a one-time stderr line on first lookup: `[atmux] claude-accounts: ~/.atmux/claude-accounts.json not found; using built-in defaults. Run \`atmux start\` to bootstrap or write the file directly.`
3. **If the file is present but malformed** (invalid JSON, schema mismatch, duplicate `configDir`, missing required field), **refuse to start** with a ConfigError quoting the parse error + file path. Do NOT silently fall back to defaults — a malformed config is operator-intent that needs fixing, not papering-over.
4. **Public API unchanged**. `resolveClaudeWrapper(configDir)` + `knownClaudeConfigDirs()` keep their signatures; only the data source moves. Every existing consumer (ADR-167 cockpit-rotate, doctor probes, anything else grep'd) continues to work without code change.

The `ClaudeWrapper` type union (`"claude" | "c-u" | "c-ic" | "c-i" | "c-p"`) is **widened to `string`** in the runtime path — we no longer know the wrapper set at compile time. The type stays as a documentation-only alias for the canonical names; consumers that branch on specific wrapper values must defend against unknowns (today there are none; ADR-167's cockpit-rotate just exec's the resolved string).

### D3 — Bootstrap during ADR-241 preflight wizard

The first-run-missing case is folded into ADR-241's wizard. Preflight gains a new probe:

- If `~/.atmux/claude-accounts.json` is absent, list it alongside missing vendored deps in the wizard prompt:
  ```
  [atmux start] preflight: 2 vendored deps missing, claude-accounts config absent.
    Missing : tmux
    Missing : atmux-cockpit-mirror
    Missing : ~/.atmux/claude-accounts.json (will write 5-account default)
  Install/rebuild + bootstrap configs? [Y/n]
  ```
- Operator accepts → write the default file (embedded defaults from D2 step 2, atomic write per ADR-098 §atomic-write contract) **alongside** the `bun run build:install` invocation. Operator declines → preflight skips both; runtime falls back to embedded defaults silently (D2 step 2). Either way, the operator can edit `~/.atmux/claude-accounts.json` post-start to add accounts without re-running the wizard.
- `--skip-deps` + `--non-interactive` flags from ADR-241 §D3 apply uniformly — both gates affect both probes.

The marker file (`~/.atmux/state/preflight-<version>.json` per ADR-241 §D4) gains a `claude_accounts_bootstrapped: true` field once the default file is written, so re-runs see the work as done.

### D4 — Operator workflow: adding an account

After this ADR lands:

1. `vi ~/.atmux/claude-accounts.json` — add a new `{ "configDir": "/root/.claude-newone", "wrapper": "c-n" }` entry to `accounts[]`.
2. Install the shell wrapper `c-n` on the operator's PATH (existing per global CLAUDE.md §Spawn Pattern; not changed by this ADR).
3. Done. Next atmux process reads the updated file. No rebuild, no reinstall, no atmux-restart for already-running processes that haven't called `resolveClaudeWrapper` yet (the cache is module-init-time per process; restarting a single process re-reads).

For a fleet-wide pickup of the new account, `atmux shutdown && atmux start` (per ADR-242) is the cleanest move — every atmux process restarts and re-reads. For point updates, restarting just the affected windows works.

### D5 — Out of scope

- **`atmux claude-account add/remove/list` verb**. Could be added later as a thin wrapper around JSON-file editing. Not load-bearing for the operator's complaint (which is "stop requiring rebuild"). Vim-the-file is sufficient v1. If operator-experience says otherwise post-rollout, add the verb in a follow-up ADR.
- **Per-team or per-driver claude-account scoping**. The mapping is host-wide. Per-team `team.json.claudeAccount` already exists (it points at a `configDir`); the configDir → wrapper translation is host-wide. No change.
- **Schema-version migration tooling**. Schema is v1 only today. When v2 becomes necessary, that's a sibling ADR with the migration path. Stub: forward-incompatible changes get a `claude-accounts-migrate.ts` helper invoked by the loader on schemaVersion mismatch.
- **Cross-host config sync**. If the operator runs atmux on hax + local, they edit two files. Sync is operator's problem (dotfiles, rsync, etc.). atmux doesn't try to keep them in sync.

## Consequences

- `src/abstractions/claude-account-wrapper.ts` rewrites from "literal Map" to "loader + cache + embedded-defaults fallback". Same public API surface; consumers don't change. File grows from ~65 lines to ~120 lines (loader, schema validator, fallback wiring, error paths).
- New file `src/abstractions/claude-accounts-config.ts` for the schema + JSON loader, separated for testability. Unit tests cover: file-absent → defaults, file-present-valid → parses correctly, malformed-JSON → refuses, duplicate-configDir → refuses, unknown-schemaVersion → refuses, schema-v1-roundtrip clean.
- ADR-241 preflight wizard absorbs the bootstrap step (per D3). One commit lands both the loader rewrite + the wizard integration, so there's no intermediate state where the wizard prompts about a config the loader doesn't know about.
- `tests/unit/abstractions/claude-account-wrapper.test.ts` updates: existing tests against the literal table get migrated to assert against the loader behavior with injected fake-FS for the config file. Coverage stays at the project's standard 100% lines on tracked paths.
- README §"Configuring claude accounts" — new section showing the JSON shape + the "add a new account" workflow from D4. Same-commit per atmux convention.
- CHANGELOG `[Unreleased] §Changed` — claude-accounts mapping moved from source-resident to `~/.atmux/claude-accounts.json`; defaults unchanged for existing hosts.
- Doctor probe (`src/verbs/doctor.ts`) gains a `checkClaudeAccountsConfig` row that yellows on file-absent (informational — defaults still work) and reds on file-malformed (operator must fix).

## Reversal

If the runtime-config approach proves problematic (e.g. operators fat-finger the JSON and break their own startup, or the loader's error paths surface confusion):

- **Soft revert**: keep the loader, ignore the config file unconditionally, always serve defaults. One-line change at the top of the loader (`return DEFAULTS;`). Operator falls back to the "edit source + rebuild" workflow per the §Context complaint, but at least atmux still starts.
- **Hard revert**: restore the literal `WRAPPER_TABLE` from this ADR's §Context, delete `claude-accounts-config.ts`, drop the wizard bootstrap step. Operator's existing `~/.atmux/claude-accounts.json` files become orphaned (harmless leftover).

Either reversal restores pre-ADR behavior in <30 lines of diff. The verb surface and consumer API doesn't change either way, so reversal blast radius is bounded to the loader file.

## Implementation order

1. **Land `claude-accounts-config.ts`** with the schema + loader + tests.
2. **Rewrite `claude-account-wrapper.ts`** to use the loader; keep defaults as the absent-file fallback. Existing consumers continue to work without change.
3. **Doctor probe** for config file state.
4. **Wizard integration** (ADR-241 §D3) — folds into the same commit as the preflight wizard if landed in the same week, or a follow-up commit if ADR-241 lands first.
5. **README + CHANGELOG** in the same commit as step 2.

No work has to land in lockstep with ADR-241 — the loader works standalone with the absent-file fallback. Wizard integration is a nice-to-have on top.
