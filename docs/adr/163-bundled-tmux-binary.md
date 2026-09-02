# ADR-163: atmux bundles its own tmux binary — version-lock + config-pin

**Status**: accepted
**Date**: 2026-05-16
**Driver-ref**: driver-inbox 16:57 MYT 2026-05-16 §2 (operator's bundled-tmux ask — *"can atmux just bring its own tmux? we should never trust the host tmux"*); slot-3 of lead's queue per driver-inbox line 5331.
**Parent EPIC**: this ADR IS the umbrella; child Tasks filed in same session per [[feedback_decomp_same_session_with_deps]].
**Relationship to ADR-162**: ADR-162 §3 carves out "binary acquisition + version-lock v2" as deferred scope; this ADR closes that carve-out. ADR-162's `cockpit-on-default-socket` foot-gun fix + `templates/tmux/atmux.conf` config-template stay in ADR-162; ADR-163 owns the BINARY that loads that config.
**Cross-refs**: ADR-097 (tmux abstraction — `configFile` resolver on the `TmuxConfig` discriminated union), ADR-138 (verified send-keys — verifier contract assumes a specific tmux output format), ADR-091 (auto-merge state machine — consumes tmux through ADR-097's abstraction), ADR-144 (epic-team test-gate — cage-mode spawns tmux servers per ADR-018's per-team-tmpdir primitive).

## Amendment 2026-09-02 — staged split, pending gate

- Host-facing doctor/version checks stay anchored to 3.6a.
- The future server-only split is reserved to the dated amendment; the historical proposal text below remains about 3.4.
- The prepared `binaryPath`/vendored-resolver seam exists, but no production call site is routed through it yet.

## Context

### The host-tmux trust problem

atmux's lead/member/cockpit topology is built entirely on top of `tmux` — sockets, windows, panes, send-keys, capture-pane, paste-buffer. ADR-097 lays down the abstraction surface (`src/abstractions/tmux.ts`) and codifies the rule that EVERY call passes an explicit `-S <socket>` to keep teams isolated. ADR-138 layers a verify-and-retry pattern on top of `send-keys` because the raw primitive is silently unreliable when panes are mid-think / mid-modal / mid-compact.

The unstated assumption underneath both ADRs is that **the tmux binary in `$PATH` behaves the way we expect**. That assumption is not safe:

1. **Version skew across hosts.** ADR-097 §Context already names this: "tmux's option/command syntax changes across major versions (3.0 → 3.3 deprecated `target-` flags, 3.4 added `display-message -p` semantic shifts)." Today atmux runs on hax (Ubuntu 22.04 — tmux 3.2a), local Macs (varies by `brew` upgrade cadence — 3.4 or 3.5a), CI runners (whatever the base image ships), and operator workstations (Arch / Debian stable / NixOS / WSL — all different).
2. **Config-side surprise.** Even on a pinned binary version, `tmux` reads `~/.tmux.conf` by default. ADR-097 already documents this and now routes the server-starting paths through the canonical atmux conf path. The 2026-05-05 `configFile: "/dev/null"` workaround is historical and superseded on 2026-09-01. In the current wiring, session-start production paths and live-server tests use the canonical path, while non-server-starting callers can still omit `configFile` where that is appropriate. Reading window-name with a `#{?...}` formatter that the operator overrode can return parser-breaking strings.
3. **Output-format drift.** ADR-138's verifier contract assumes specific `capture-pane` output shapes (composer-empty / agent-thinking / modal-closed / context-non-zero detection). A future tmux patch changing how `capture-pane` formats unicode or how terminal escapes are stripped will silently break every verifier without a single test failure (the tests run on the dev box's tmux; the failure is on the operator's box).
4. **OSS contributor footgun.** A fresh `git clone` + `bun install` against a host that ships tmux 1.8 (Debian buster) or tmux on Windows-via-WSL with a different `pid` table layout will fail in ways that look like atmux bugs, not tmux-version bugs. ADR-162 §3 added a warn-probe for this (v1: "your host tmux is too old, things may break"); ADR-163 promotes that warning to a structural fix (v2: ship our own tmux, never load the host one).

### Why this isn't "just use Docker"

Containerization would solve version-skew but creates a worse experience:
- atmux drives the user's terminal. Running inside a container means the container needs a TTY allocator, the user has to attach into the container to see panes, and the cockpit topology becomes "containers within containers" which defeats the locality model.
- atmux teams write to the user's filesystem (worktrees, state.db, briefs). A container needs bind-mounts; misconfigured bind-mounts make atmux's atomic-rename idioms fail.
- Operator workstations may not have Docker / may have it but not running / may run rootless Docker with different UID mapping. Adds support surface.

A bundled binary lives in the user's `$PATH` (via `/opt/atmux/<version>/bin/tmux` per ADR-047 canonical install topology) and is invoked exactly the way the host `tmux` would be, just deterministically. Zero container overhead, zero terminal-attach gymnastics, zero filesystem-mount semantics to debug.

### Why this isn't ADR-097 territory

ADR-097 is the tmux *abstraction layer* — it specifies the API surface (`tmux.session.newSession(...)`, `tmux.pane.sendKeys(...)`), not where the tmux binary comes from. ADR-097 §Decision §Config-pinning already added `configFile` to the `TmuxConfig` discriminated union, but the resolved path is left to the consumer. ADR-163's 2026-05-16 proposal specified the consumer side: production code would pin `configFile` to the bundled binary's bundled tmux.conf instead of omitting it. That bundled resolver remains unimplemented as of 2026-09-01; current server-starting paths use `getAtmuxTmuxConfPath()`.

In that historical proposal, the API would gain the proposed binary selector; the selected binary and the config it loaded would change.

## Decision

Six §Decision-anchor lines first, then prose around each subsystem.

> **§Decision-anchor #1** — **Vendored prebuilt binaries via GitHub-release artifact; build-from-source as escape hatch for unsupported platforms.** atmux releases ship a per-platform prebuilt `tmux` binary (linux-x64, linux-arm64, darwin-x64, darwin-arm64) under `/opt/atmux/<version>/vendor/tmux/<platform>/tmux`. The npm/Bun installer's `postinstall` script symlinks the right platform's binary to `/opt/atmux/<version>/bin/tmux` per ADR-047's atomic-symlink-swap pattern. Unsupported platforms (Alpine musl, FreeBSD, OpenBSD, Windows-native) fall back to a build-from-source path that requires `gcc` + `libevent-dev` + `ncurses-dev` on the host. Build-from-source is opt-in via `ATMUX_TMUX_BUILD=1`; default is "prebuilt or fail-with-actionable-hint." Pinned tmux version is **3.4** (current stable as of 2026-05; bumps require an ADR-163 amendment + reviewer signoff).
>
> **§Decision-anchor #2** — **Config layout — `${atmuxRoot}/vendor/tmux/atmux.conf` is the default; `${userConfigDir}/atmux/tmux.conf.local` is the user override; resolution is default → override (override wins on key conflict).** The default config ships in the vendored binary directory and is read-only (operator MUST NOT edit — `atmux tmux reset-config` regenerates it). The user override lives in the standard XDG location (`$XDG_CONFIG_HOME/atmux/tmux.conf.local` or `~/.config/atmux/tmux.conf.local`) — operators edit this file to customize bindings, status-bar, theme overlays. atmux's tmux invocations pass `-f ${bundled}/atmux.conf` AND `source-file -q ${userOverride}` is appended inside the default conf (the `-q` makes missing override a silent no-op). The user's personal `~/.tmux.conf` is NEVER loaded by atmux's bundled tmux — full host-config quarantine.
>
> **§Decision-anchor #3** — **`atmux tmux reset-config` verb regenerates both files; `atmux tmux print-config` dumps the active layered config.** The reset verb writes the default conf from the embedded template (shipped under `templates/tmux/atmux.conf` per ADR-162) into `${atmuxRoot}/vendor/tmux/atmux.conf` (overwriting any tampering) AND creates a fresh empty `${userOverride}` with header comments documenting the override semantics. `--force` overwrites an existing user override (otherwise refuses with a hint to back up first). `atmux tmux print-config` is the operator's debug-helper: prints `-f ${default}` + `source-file ${override}` evaluated against the actual binary (via `tmux -f ${default} show-options -A`). No-op safe; read-only.
>
> **§Decision-anchor #4** — **Version-lock v2 — promote ADR-162 §3 warn-probe to refusal at session-start.** ADR-162 §3 shipped a warn-probe that runs on `atmux doctor` and emits `🟡 host tmux too old (got X, want ≥Y), bundled tmux recommended` without blocking. ADR-163 promotes this gate: when the bundled binary is present (post-install check), atmux REFUSES to fall back to the host tmux for any team-spawning verb (`atmux start`, `atmux rotate-lead`, `atmux team start`, cockpit rebuild). The host-tmux path remains usable for `atmux doctor` / `atmux status` (read-only probes). Refusal hint names the bundled binary path + invites `atmux tmux reset-config` if the bundle is corrupted. The `ATMUX_USE_HOST_TMUX=1` escape hatch exists for CI / debugging — emits a `[host-tmux-fallback]` Discord notification (driver-only, audited).
>
> **§Decision-anchor #5 (historical 2026-05-16 proposal)** — **ADR-097 `configFile` resolver would pin to a bundled path.** The proposal required production callers of `createTmux` (per ADR-097 §Decision §Method shape) to pass `configFile: getBundledTmuxConfigPath()` from a new `src/core/tmux-bundle.ts`; the proposed resolver would return `${atmuxRoot}/vendor/tmux/atmux.conf` or refuse if the bundle were absent. That resolver is not implemented in this tree as of 2026-09-01. Current live-server tests, the parity harness, and selected production server-starting paths use `configFile: getAtmuxTmuxConfPath()` so they load the canonical atmux conf instead of an empty config file. Other production `createTmux` call sites still require a server-startability audit. The proposal named `src/core/team-start.ts`, `src/core/cockpit-rebuild.ts`, and `src/core/rotate-lead.ts` as initial wiring sites; that nonexistent current-tree list is historical. The API/code shape below remains historical until a bundled resolver lands.
>
> **§Decision-anchor #6** — **ADR-138 verifier contract is preserved by the version-lock — verifiers test against the pinned tmux output format, not host's.** ADR-138's five built-in verifiers (`composerEmpty` / `agentThinking` / `modalClosed` / `contextNonZero` / `paneMatchesRegex`) all operate on `capture-pane` output. Pinning tmux to 3.4 means the verifier regex set is stable across deploys — no more "verifier broke on macOS 3.5a" silent failures. The verifier test suite (`tests/core/safe-send.test.ts` — confirm via grep) MUST run against the bundled binary in CI (currently runs against the runner's host tmux); T6 of this ADR's decomp wires the CI matrix to spawn from the bundled binary.

### §Binary distribution mechanism

**Vendoring strategy** (per §Decision-anchor #1):

1. **Build pipeline**: a separate `atmux-vendor-tmux` CI workflow builds tmux 3.4 from source against the four supported platform triples on GitHub Actions runners (`ubuntu-22.04` for linux-x64, `ubuntu-22.04-arm` for linux-arm64, `macos-14` for darwin-arm64, `macos-13` for darwin-x64). Artifacts are statically linked where possible (libevent statically linked; ncurses dynamically linked because static ncurses on macOS is painful). Builds are deterministic — reproducible-build flags + SOURCE_DATE_EPOCH pinned to the tmux 3.4 release date.
2. **Release artifact**: each atmux release tag (`v0.X.Y`) attaches the four binaries as GitHub-release assets named `tmux-3.4-${platform}.tar.gz`. The npm/Bun package's `postinstall` script (`scripts/install-vendored-tmux.ts`) downloads the artifact matching `process.platform` + `process.arch`, verifies SHA-256 against a manifest baked into the package, extracts to `/opt/atmux/<version>/vendor/tmux/${platform}/tmux`, atomic-symlinks `/opt/atmux/<version>/bin/tmux → vendor/tmux/${platform}/tmux`, and chmods it executable.
3. **Build-from-source escape hatch**: when `ATMUX_TMUX_BUILD=1` or `process.platform` is unsupported, `postinstall` clones `https://github.com/tmux/tmux.git` at tag `3.4`, runs `./configure --enable-static --without-utempter && make`, and installs the resulting binary into the same vendored path. Build dependencies (`gcc`, `make`, `libevent-dev`, `ncurses-dev`) are NOT installed by atmux — operator must have them; postinstall fails with a clear hint listing the missing packages.
4. **Manifest**: `scripts/tmux-bundle-manifest.json` (committed to the repo, NOT generated) lists per-platform SHA-256s. The `atmux-vendor-tmux` workflow updates the manifest on each tmux version bump; the bump requires an ADR-163 amendment so reviewer signoff is mandatory.
5. **Offline-install path**: operators on air-gapped boxes pre-download the artifact, set `ATMUX_TMUX_TARBALL=/path/to/tmux-3.4-${platform}.tar.gz`, and `postinstall` skips the GitHub fetch. Same SHA-256 verification.

**Why GitHub-release artifact, not npm package**: npm packages bundle everything into the tarball, which inflates the package size 20-40MB per platform × 4 platforms = 80-160MB unpacked. npm tarballs are downloaded on every install. GitHub-release artifacts are fetched lazily per platform — Linux users never download macOS binaries. Bun's `postinstall` runs once per install; the lazy fetch is cheap.

**Why not `mise`-managed**: `mise install tmux@3.4` is an option for runtime version managers, but atmux can't assume the operator runs mise (some operators are on systems where mise isn't available). Vendoring inside atmux's own install tree is self-contained.

### §Config layout

**File tree** (per §Decision-anchor #2):

```
/opt/atmux/<version>/
├── bin/
│   ├── atmux            (the CLI shim, per ADR-047)
│   └── tmux             (symlink to vendor/tmux/<platform>/tmux)
└── vendor/
    └── tmux/
        ├── atmux.conf       (default config, regenerated by reset-config verb)
        └── <platform>/
            └── tmux         (the actual binary)

$XDG_CONFIG_HOME/atmux/
└── tmux.conf.local      (user override, optional; created empty by reset-config)
```

**Historical proposed minimum contents** (2026-05-16 draft, superseded by `templates/tmux/atmux.conf` on 2026-09-01):

The default `atmux.conf` is shipped from `templates/tmux/atmux.conf` (per ADR-162 — that ADR ships the template; ADR-163 owns the binary that loads it). Minimum contents:

```tmux
# Historical only: proposed minimum tmux config for the bundled-config
# design pass. It is preserved here so the 2026-09-01 supersession can be
# read against the original proposal.

# Quarantine — never load operator's personal ~/.tmux.conf
# (atmux's tmux invocations also pass -f explicitly, so ~/.tmux.conf is
#  never read in any case; this comment documents the intent.)

# Sane defaults
set -g default-terminal "tmux-256color"
set -g history-limit 50000
set -g base-index 0
set -g pane-base-index 0
set -g status off
set -g remain-on-exit on
set -g mouse on

# Load user override last, silently no-op if missing
source-file -q ~/.config/atmux/tmux.conf.local
```

The live `templates/tmux/atmux.conf` template is the current source of truth. It sets `base-index 1` and does not set `pane-base-index`.

**User override semantics**: operator-edits land in `~/.config/atmux/tmux.conf.local`. Loaded LAST so it overrides the defaults. Examples of legit overrides: theme overlay (`set -g status-style …`), custom binding (`bind -n M-, …`), per-host status-bar formatter. Operators MUST NOT redefine `base-index` / `pane-base-index` — atmux's window-numbering invariants depend on them. `atmux tmux print-config` flags overrides that touch atmux-load-bearing keys with a warning.

### §`atmux tmux` sub-verbs

**New verbs** (per §Decision-anchor #3):

1. **`atmux tmux reset-config`** — regenerates `${atmuxRoot}/vendor/tmux/atmux.conf` from `templates/tmux/atmux.conf` (embedded in the npm package) AND creates an empty `~/.config/atmux/tmux.conf.local` (with header comments) if it doesn't exist. `--force` overwrites an existing override (otherwise refuses with hint to `cp` it aside first). Idempotent re-invocation safe.

2. **`atmux tmux print-config`** — runs `tmux -f ${bundled}/atmux.conf show-options -A` against the bundled binary, prints the active option matrix. Flags any override (from `tmux.conf.local`) that touches load-bearing keys (`base-index`, `pane-base-index`, `default-terminal` with a non-256color value, `prefix` if changed to something atmux's send-keys protocol relies on). Read-only; safe to run anytime.

3. **`atmux tmux which`** — prints the bundled binary path + tmux version + SHA-256 of the binary. One-line output. Useful for support / bug reports / verifying the install didn't get corrupted.

The `tmux` verb namespace is NEW — no conflict with the existing `tmux` import in code. Help text registered in `src/verbs/help.ts`.

### §Version-lock v2

**Promotion gate** (per §Decision-anchor #4):

ADR-162 §3 ships a warn-probe in `atmux doctor`:

```
🟡 Host tmux version 3.2a detected; atmux is tested against 3.4. Run `atmux tmux which`
   to use the bundled binary instead.
```

ADR-163 promotes this to a refusal at session-spawning time:

- **`atmux start` / `atmux team start` / `atmux rotate-lead` / `atmux cockpit rebuild` / any verb that calls `tmux new-session` or `tmux new-window`** — refuses if the bundled binary is missing. Hint: `atmux tmux reset-config` reinstalls; `ATMUX_USE_HOST_TMUX=1` overrides (driver-only).
- **`atmux doctor` / `atmux status` / `atmux task list`** — read-only probes; the warn-probe stays as ADR-162 §3 v1 (warn, don't refuse) so operators on air-gapped boxes can still inspect state.
- **`ATMUX_USE_HOST_TMUX=1`** — escape hatch for CI runners that haven't downloaded the vendored binary yet (legitimate during a release cut), or for operators debugging issues where they suspect the bundled binary itself is at fault. Driver-only enforcement (mirror ADR-144 T5 `--skip-test-gate` pattern — `process.env.ATMUX_CALLER_SCOPE === "driver"`). Fires a `[host-tmux-fallback]` Discord notification on every team-spawn under this flag (audited).

**Why promote NOW**: without ADR-163's bundled binary, the warn-probe is decorative — it tells the operator the version is wrong but lets the session start anyway, often resulting in silent verifier failures or window-numbering corruption that surfaces hours later. ADR-163 makes the warning actionable (the bundle exists, just use it) AND structural (the host-tmux path is closed by default).

### §ADR-097 + ADR-138 integration

**ADR-097 update** (per §Decision-anchor #5):

`src/core/tmux-bundle.ts` (new module) exports:

```ts
export function getBundledTmuxPath(): string;       // /opt/atmux/<v>/bin/tmux
export function getBundledTmuxConfigPath(): string; // /opt/atmux/<v>/vendor/tmux/atmux.conf
export function bundledTmuxExists(): boolean;       // null-safe probe
export function getBundledTmuxVersion(): string;    // "tmux 3.4"
```

The 2026-05-16 proposal named `src/core/team-start.ts`, `src/core/cockpit-rebuild.ts`, and `src/core/rotate-lead.ts` as the initial production call sites for the bundled-path wiring; that file list is historical and records the proposal, not the current tree. On 2026-09-01, current examples explicitly wired to `getAtmuxTmuxConfPath()` include server-starting paths in `src/verbs/start.ts`, `src/verbs/cockpit.ts`, `src/verbs/bot.ts`, `src/verbs/superbot.ts`, `src/verbs/status.ts`, and `src/abstractions/fallback-cage.ts`. That list is not an assertion that every other production `createTmux` caller is non-starting or already safe; the remaining call sites require a separate audit. The proposal also sketched a per-verb-resolved `binary: getBundledTmuxPath()` field and a PATH fallback; that material is historical only and is not implemented in this tree as of 2026-09-01.

The full `TmuxConfig` shape proposed in 2026-05-16 becomes:

```ts
type SocketConfig =
  | { readonly socket: string;     readonly socketPath?: never }
  | { readonly socketPath: string; readonly socket?: never };

export type TmuxConfig = SocketConfig & {
  readonly configFile?: string;   // optional -f <path>; current live tests and selected server-starting paths use getAtmuxTmuxConfPath()
  // `binary?: string` was part of the 2026-05-16 proposal, but it is not
  // implemented in this tree as of 2026-09-01.
};
```

ADR-097 gets an amendment annotation citing ADR-163 (append-only — never edit ADR-097's existing prose; add a `## Amendments` section at the bottom pointing to this ADR). The 2026-05-16 proposal remains historical until an actual resolver lands.

**ADR-138 verifier alignment** (per §Decision-anchor #6):

The five built-in verifiers in `src/core/safe-send.ts` (or wherever ADR-138 placed them — confirm via grep) operate on `capture-pane` output. Their regex set is currently tested against the dev box's tmux version; this is the silent-skew risk.

ADR-163 closes the skew by running the verifier test suite (`tests/core/safe-send.test.ts`) in CI against the bundled tmux binary. The CI matrix (T6) spins up a bundled-tmux session, fires the verifier under known pane states, asserts the verifier returns the expected boolean. Failures are now caught at PR time, not at operator-runtime.

No ADR-138 amendment is needed (the contract stays the same — verifiers operate on capture-pane output). What changes is the CI environment: bundled tmux instead of host tmux.

### §EPIC-done definition for the 2026-05-16 proposal only

ADR-163's 2026-05-16 proposal would complete when ALL of:

1. T1 lands — vendored prebuilt binaries available as GitHub-release artifacts for the four supported platforms; postinstall fetches + verifies SHA-256 + symlinks.
2. T2 lands — `${atmuxRoot}/vendor/tmux/atmux.conf` default + `$XDG_CONFIG_HOME/atmux/tmux.conf.local` override resolver implemented; production callers pass `configFile: getBundledTmuxConfigPath()`.
3. T3 lands — `atmux tmux reset-config` / `print-config` / `which` verbs shipped + help text updated.
4. T4 lands — ADR-097 amendment annotation + `binary` field added to `TmuxConfig` + the production call-sites pass `binary: getBundledTmuxPath()`.
5. T5 lands — version-lock v2 refusal at team-spawning verbs; `ATMUX_USE_HOST_TMUX=1` escape hatch with `[host-tmux-fallback]` Discord audit.
6. T6 lands — CI matrix runs `tests/core/safe-send.test.ts` against bundled tmux; e2e dogfood verifies fresh OSS clone bootstraps cleanly with the bundled binary.
7. T7 lands — RUNBOOK-tmux-bundled.md + README §Installation section updated.

## Consequences

### What this ADR enables

- **Deterministic atmux behavior across hosts.** Verifier contracts (ADR-138), window-numbering invariants (ADR-097 base-index/pane-base-index), capture-pane output formats — all pinned. The fresh-OSS-contributor footgun closes.
- **Atomic upgrades.** Bumping tmux from 3.4 → 3.5 lands as an ADR-163 amendment + reviewer signoff + bumped `tmux-bundle-manifest.json`. No operator has to manually `brew upgrade tmux`; the postinstall fetches the new bundle.
- **Reproducible bug reports.** "atmux X breaks for me" + `atmux tmux which` output = exact binary version under failure. Today the bug-triage chain has to ask the operator for `tmux -V` and hope they remembered to actually run atmux against that tmux.
- **Closes ADR-162 §3 carve-out.** The deferred-scope is now fully in this ADR.

### What this ADR does NOT cover

- **Bundled libevent / ncurses dependency upgrades**. Statically linking libevent insulates atmux from libevent bumps; ncurses is dynamically linked so OS-level ncurses upgrades still affect rendering. Acceptable trade-off — ncurses ABI is stable.
- **Windows-native support.** Out of scope. WSL is the supported Windows path (uses linux-x64 or linux-arm64 binary depending on WSL arch).
- **Operator-installed tmux replacement.** Operators who genuinely want their host tmux can set `ATMUX_USE_HOST_TMUX=1` permanently; ADR-163 doesn't fight them but DOES audit it via Discord.
- **Building tmux from operator-modified source.** The build-from-source escape hatch builds from upstream's tagged source. Custom-patched tmux is out of scope — operators wanting that should clone tmux separately + set `ATMUX_TMUX_TARBALL` to their own tarball.

### Rollback path

- Set `ATMUX_USE_HOST_TMUX=1` in the operator's shell rc — all atmux verbs fall back to PATH-resolved `tmux`. Warns once per session via Discord (`[host-tmux-fallback]`). No code change required.
- Remove `/opt/atmux/<version>/vendor/tmux/` from the install — postinstall is idempotent; re-running `bun install -g atmux` (or `npm install -g atmux`) re-vendors.
- ADR-163 itself is reversible by amending ADR-097 to drop the `binary` field + removing the production callers' `binary:` argument. Vendored binary directory becomes dead weight (operator can `rm -rf` it).

### Reuse statement

- Atomic-symlink-swap pattern: ADR-047 (canonical install topology).
- `TmuxConfig` discriminated union: ADR-097.
- `safeSendKeysWithVerify` verifier contract: ADR-138.
- `templates/tmux/atmux.conf` config template: ADR-162.
- `[host-tmux-fallback]` Discord template: ADR-162 §3 names it; this ADR fires it from the version-lock v2 escape hatch path. Template literal landed by ADR-162 T<N>; ADR-163 wires the call-site.
- Driver-only caller-scope refusal: mirrors ADR-144 T5 `--skip-test-gate` pattern.

## Open questions

1. **Per-host SHA-256 manifest source-of-truth.** Manifest baked into npm package vs fetched at install-time from a GitHub URL? Decision: baked into package (offline-install works without GitHub access; verification happens entirely against package-included data). Manifest bump = package version bump = npm publish; verifier-bundle-mismatch impossible by construction.

2. **macOS Gatekeeper / codesigning.** Unsigned binaries downloaded from GitHub-releases trigger Gatekeeper warnings on macOS first-run. Options: (a) sign the macOS binaries with an Apple Developer ID (requires a paid Apple Developer account); (b) post-extract `xattr -d com.apple.quarantine` in the postinstall (works but requires the user to grant atmux's npm-install permission to modify xattrs); (c) document the workaround in RUNBOOK-tmux-bundled. **Planner recommendation**: (c) for v1 — document the right-click → "Open" workaround in the RUNBOOK; (a) for v2 if Apple Developer account becomes available. Reviewer can flip at signoff.

3. **Linux distro variance.** glibc vs musl. The linux-x64 binary is built against glibc 2.31 (Ubuntu 20.04 baseline); musl-based distros (Alpine, Void) need the build-from-source path. Acceptable for v1; if Alpine adoption shows up, file a follow-up Task to ship a musl-targeted prebuilt.

4. **CI cost.** Building 4 platforms × every release commit doesn't scale. Mitigation: vendor-build CI runs only on `tmux-bundle-manifest.json` change (i.e. tmux version bump), not on every atmux commit. Manifest churn is rare (tmux versions bump ~1-2× per year).

## Cross-references

- ADR-047 (canonical install topology — `/opt/atmux/<version>/bin/atmux` atomic-symlink pattern reused for the bundled tmux).
- ADR-097 (tmux abstraction — adds `binary` field to `TmuxConfig`; amendment annotation cites this ADR).
- ADR-138 (verified send-keys — verifier contract stays unchanged; CI matrix in T6 runs verifier tests against bundled tmux).
- ADR-091 (auto-merge state machine — consumes tmux through ADR-097's abstraction; no direct impact, but the cron-tick verb spawning cage sessions on the bundled binary by extension).
- ADR-144 (epic-team test-gate — cage-mode spawns tmux sessions via ADR-018; the bundled binary becomes the cage-tmux too, ensuring test-gate behavior is reproducible across hosts).
- ADR-162 (cockpit-on-default-socket isolation + tmux.conf template — sibling foundation; ADR-162 §3 deferred binary scope is closed here).
- Driver-inbox 16:57 MYT 2026-05-16 §2 (operator's bundled-tmux ask).
- Project [CLAUDE.md](../../CLAUDE.md) §Docs Discipline (same-commit doc updates) + §Testing Discipline (CI matrix integration) + §Push Policy (postinstall download path is not a `staging` push so policy doesn't apply).
- Memory [[project_atmux_install_topology]] — install path conventions consumed here.


## §Amendment 2026-05-20 — promoted to accepted (status-drift audit T4)

Promoted from `proposed` → `accepted` per [docs/audits/adr-status-drift-audit-2026-05-20.md](../audits/adr-status-drift-audit-2026-05-20.md) (sha=a6f1541). Code-refs + git-log refs both present at audit time confirming shipped + dogfooded status; the `proposed` marker was bookkeeping debt. Original Date preserved verbatim. Append-only — see Status field for the canonical flip; this §Amendment carries the audit traceability.

**Filed via** t-45b401c3 (T4 sweep, 2026-05-20).
