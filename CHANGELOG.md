# Changelog

All notable changes to **atmux** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 🧹 Removed — the per-window `window-size smallest` override on the cockpit's `unum` window (ADR-284)

**Every cockpit window now uses one sizing policy: the server global `window-size latest` + `aggressive-resize on`. No window-level or session-level `window-size` override is set on any cockpit window.**

The `unum` cockpit window had carried `window-size smallest` since 2026-06-24, installed by two `after-new-window` / `after-rename-window` hooks in the operator's `~/.tmux.conf`, which reaches an atmux server through the ADR-171 override path (`templates/tmux/atmux.conf` → `~/.config/atmux/tmux.conf.local` → `source-file ~/.tmux.conf`). atmux itself sets no `window-size` at any scope and still does not.

Measured on `geoywsMBP` 2026-08-30 with three clients attached to cockpit session `atx`: `ifca` rendered **291x80** under `latest` while `unum` rendered **79x43**, clamped by a 79x44 client regardless of which client was active. A sweep of every live tmux socket on the box found exactly one `window-size` override at any non-global scope — cockpit `atx:5`. The group cage was never at fault; its client faithfully inherited the clipped cockpit pane.

**The override was a workaround for ghost clients, and it made them permanent.** `_dotfiles/bin/tmux-ghost-reaper.sh` — written the day *before* the override — records the precedent verbatim: *"a lingering narrow client is doubly harmful on the atmux cockpit … cages (e.g. unum) render cramped … (2026-06-23: a 71x38 cockpit attach idled ~21h and pinned the unum cage to 270x74.)"* Both extra clients on 2026-08-30 were ghosts by that reaper's own criteria (narrow + stale: 79x44 idle 53min, 102x53 idle 335min).

**Correction, same day, recorded rather than silently edited:** ADR-284's first revision explained the reaper's absence as devbox-migration drift. That was invented — the absence is real, the explanation was not. `hax`'s crontab carries the entry **commented out on 2026-06-25 22:18 MYT by operator request**, with its own note that the narrow tier *"was reaping his live narrow mosh client … George's 71-col phone client (pts/36) was being kicked repeatedly all day"*, and `/var/log/tmux-ghost-reaper.log` shows dozens of 71x38 detaches at **6–19 minutes idle** between 05-17 and 06-25. So the override was installed on 06-24 and the reaper switched off on 06-25: one decision made in two places, with the same 71-column phone client on both sides. This release retires only the first half; the second stays the operator's call (attention `a-a752804f`). Tuning does not rescue the heuristic either — the phone is 71 columns and the 2026-08-30 ghost was 79, a pocketed phone idles *longer* than a freshly-orphaned attach, and the crontab's own remedy (`NARROW_WIDTH ≤ 71`) would have dropped that 79x44 ghost into the 2h tier where its 53 minutes never qualified. `smallest` promoted a narrow client's geometry from an accident into policy, and kept it there for 68 days.

Retired in three places, because a conf edit does not reach a running server:

- **Source** — the hook block and its `@unum_smallest_hook` guard are deleted from `_dotfiles/tmux/.tmux.conf`, replaced by a tombstone pointing at ADR-284.
- **Self-healing** — `_dotfiles/tmux/refit-nested.sh` already cleared stale *session*-level `window-size` on reload; it now clears *window*-level too, on every window of every reachable server (addressed by `#{window_id}`, so renames and renumbering can't dodge it).
- **Live** — the running cockpit was remediated in the same change: override unset, both hook arrays unset (verified to hold only slot `[0]`, both ours, before using `-u`), guard flag cleared, both ghosts detached, conf edits landed first so a reload in between could not reinstall.

**Measured tmux 3.7c semantics, established on a throwaway two-client rig and then confirmed live** — none of this is asserted from the manual: `smallest` clamps from an *attached* client, not a viewing one, so an idle ghost in another window still binds; `latest` pins a window to the client that last generated real **input** while viewing it, and a `select-window` issued by a control client does not move that pin; and removing the override resizes nothing on its own — nor does detaching the pinning client — because an unviewed window keeps its stale geometry until something triggers a recalculation. The live refit was therefore driven through a temporary grouped session (`new-session -d -s _fit284 -t atx`) so a throwaway 291x81 client could view window 5 while the operator stayed on window 6, rather than flipping his own client and risking keystrokes landing in the unum cage. Final state: six windows at 291x80, one client, zero overrides, both hook arrays empty, all three group cages reporting a 291x80 inner client.

**Not re-armed, and ADR-284 §D6 recommends it stays that way.** ADR-284 removes half of what the reaper was defending: under plain `latest` a lingering narrow client no longer clamps any window. What remains is the redraw-lockstep cost its header describes — real, but not what was observed on 2026-08-30. Ghosts are now reaped by hand when a cage looks cramped, which is the accepted steady state rather than a stopgap. Two Darwin defects would need fixing first if it were ever re-armed here: the script appends to root-owned `/var/log` (verified not writable as `geoyws`), so under `set -e` it aborts *after* detaching clients and the Discord notice never fires; and its local-console exemptions (`/dev/pts/0`, `/dev/tty1`) are Linux tty names that never match on Darwin.

### ↩️ Withdrawn — ADR-283 (test-runner environment scrub), and the claims cut back to what is measured

**ADR-283 was proposed on 2026-08-28 and is withdrawn.** It would have built the `bun test` runner's environment from an allowlist, on the claim that *"if the variables are not in the runner's environment, no test can leak them, whatever shape it uses … there is nothing to evade."* Two measured reasons it is gone, and ADR number 283 is left as a deliberate gap:

- **The guarantee is false. One interactive-shell hop restores every credential.** Measured on `geoywsMBP` 2026-08-28 from `env -i` carrying only allowlisted names (counts only, never names or values): `sh -c` → 8 names / 0 credential-shaped; `zsh -c` → 10 / 0; `zsh -lc` → 11 / 0; **`zsh -lic` (login + interactive) → 81 / 25.** Reproduced independently 2026-08-29 with a counts-only script (7 / 0, 9 / 0, 9 / 0, **74 / 28** — different seed set and credential pattern, same decisive finding: every non-interactive form is clean, one `-i` brings in dozens). The operator's `.zshrc` sources a git-crypt'd `.env` and is read by *interactive* shells — and spawning interactive shells is exactly what atmux does. A scrubbed runner has an unscrubbed grandchild.
- **Its bare-`bun test` refusal is destructive on this box.** `.atmux/team.json` carries `autoMerge: { enabled: true, testCommand: "bun test", revertOnFail: true, skipTestGate: false }` (verified 2026-08-29). Per `templates/briefs/committer.md:128` the gitter runs `testCommand` as the merge gate and per `:130` answers a failure with `git revert -m 1 <merge-commit>`. A refusal exits non-zero and is **indistinguishable from a test failure**, so shipping it would have made every auto-merge revert itself.

**Deleted:** `docs/adr/283-*.md`, `scripts/test.ts`, `tests/helpers/test-env.ts`, `tests/helpers/test-env-guard.ts`, `tests/unit/helpers/test-env.test.ts`, the bunfig preload, and the `package.json` / CI-workflow rewrites. `package.json`, `bunfig.toml`, `.github/workflows/ci.yml` and both runbooks are byte-identical to their pre-ADR-283 content. **A bare `bun test` works normally again.** The standing defence for the 2026-08-28 disclosure remains ADR-282's: probes collect an allowlist and never the whole environment.

**Three things ADR-283 got right are kept, with their claims cut to what is provable:**

- **The `env(1)` argv half of the tmux child-env policy now has call-site coverage — it had none.** `TMUX_CHILD_UNSET_ENV` covers the seven direct `spawn()` sites; `TMUX_CHILD_ENV_ARGV` covers the sudo branches, and removing all three `...TMUX_CHILD_ENV_ARGV` spread lines from `src/` left the suite **entirely unchanged**. Two of the three sites are reachable and are now driven (`destroyFallbackCage`'s sudo `kill-session`, `sendCageBrief`'s sudo branch × 3 calls); the same mutation now turns both red. The third (`createFallbackCage`'s sudo `new-session`) is **provably dead** — `createFallbackCage` throws `FallbackTierDroppedError` for every `tier !== 2` and `TIER_AGENT[2] === "operator"`, so its `agent !== "operator"` branch cannot execute — and is pinned as dead rather than given a test that could never fail.
- **"The test asserts the effective environment, not the option" is now true.** It was claimed in three places and was false for one of the seven legs, which injected a fake `spawnFn` and checked the `unsetEnv` option: deleting the `unsetEnv` block from `mergeEnv` left that leg **green** while the other six went red. It now runs the real `spawn()`; re-measured 2026-08-29, the same mutation turns **all seven** red.
- **`templates/tmux/atmux.conf`'s `set-environment -g COLORTERM truecolor` line stays — its justification does not.** Four places claimed the line existed for "the tmux 3.6b servers ADR-281 measured with `COLORTERM=` empty, where the pane does inherit the frozen value". **No such measurement was ever made**; ADR-281 says the opposite two paragraphs above ("nothing in this ADR has been measured on either"), and `grep -rn '3\.6b'` found only the pointer sentences citing each other. Re-measured first-hand 2026-08-29 on tmux 3.7c: the line is **inert for the pane** (a pane reports `COLORTERM=truecolor` with it and without it) and **safe** (server-side + a client carrying none → `#{client_termfeatures}` = `bpaste,ccolour,clipboard,cstyle,focus,title`, no `RGB`, byte-identical to the no-line leg; `COLORTERM` on the CLIENT is what adds `RGB`). It is now documented as a **cheap, measured-safe defensive default**, not a fix for any pane fault measured here.

**ADR-282's helper is kept; its source-scanning guard is deleted:**

- **`parseEnvDump`'s newline mitigation was order-dependent and leaked the fragment.** Keeping the FIRST sighting of a repeated name assumed we choose the order; the secret does. Measured 2026-08-29 with a placeholder payload: given `["TERM=<fragment>", "TERM=tmux-256color"]` it emitted **the fragment verbatim** and redacted the legitimate value. A repeat proves the boundary producing *both* lines is fake, so **both** are redacted now, and both orders are pinned by test.
- **The source-scanning guard test is DELETED, and ADR-282 §D4 with it.** A regex over arbitrary source cannot recognise "this program captures the environment"; three rounds of widening it each produced both a new gap and a new overstatement. Every claim resting on it — the catch/miss ratio, the residual-gaps list, the scanned-root roster, the decision table — is deleted rather than restated. The standing defence is ADR-282 §D1: a probe collects an allowlist, filtered inside the probe, so there is nothing to print.

**Smaller factual corrections:** ADR-282 §D5 said the include brought 7 `noNonNullAssertion` warnings "in four files" — it is **two** (`tests/helpers/__smoke__.test.ts` 6, `tests/helpers/honker-mock.ts` 1); the other two files contributed `format` errors, not warnings, which is how the counts were conflated. Verified with the pinned `node_modules/@biomejs/cli-darwin-arm64/biome` 2.4.14: **`e50e3266` = 156 errors / 181 warnings; `bb47d0b6` = 162 / 188.**

### 🐛 Fixed — a tmux server atmux starts can no longer inherit `NO_COLOR` ([ADR-281](docs/adr/281-tmux-child-environment-scrub-at-the-spawn-seam.md))

**[ADR-277](docs/adr/277-cage-color-environment-scrub.md)'s coverage claim was false, and cages were still going greyscale.** It fixed the scrub in `templates/tmux/atmux.conf` and asserted *"Because atmux passes `-f <this file>` on every invocation (ADR-162), this covers every cage, however it was launched."* Two independent holes: `createTmux` emits `-f` only when the caller supplied a `configFile` (several call sites, `vox.ts`'s supervisor among them, do not), and tmux starts a **server** implicitly for any subcommand against a dead socket — so `attach-session`, or even a read-only `list-keys`, can be the process whose environ gets frozen before an `-f`-carrying command ever runs. Measured 2026-08-28 on geoywsMBP across 47 live servers: **6 had never loaded any atmux conf, and 2 of those (`rx`, `hrx`) carried a live `NO_COLOR=1`** — both created by a bare `tmux -S <sock> new-session`. `grp-geoyws`'s server was born from `attach`, which this fix covers. `hx`'s was born from `tmux list-keys`, which it does **not**: `list-keys` appears nowhere in atmux's source, so that server was started from outside atmux and no spawn-level seam can reach it.

- **`src/abstractions/spawn.ts` gains `unsetEnv?: ReadonlyArray<string>`** on `SpawnOpts` + `SpawnInheritStdioOpts` (`SpawnStreamOpts` inherits it), applied by `mergeEnv` **after** the `env` merge so deletion is the last word. This was previously unrepresentable, not merely unused: `env` is typed `Record<string, string>`, and `{ NO_COLOR: "" }` is a *different* observable state that ADR-277 §D1 had already rejected. `mergeEnv` never touches `process.env`.
- **`src/abstractions/tmux.ts` exports `TMUX_CHILD_UNSET_ENV` (`NO_COLOR`)** and passes it at every `spawn()` / `spawnInheritStdio()` in the module — `tmuxRunRaw`, `buffer.loadBuffer` (which bypasses `tmuxRun` for stdin), and `client.attachSessionInheritStdio`. **It is a deletion and nothing else — atmux sets no colour variable on a tmux child.** `TERM` is not set because tmux re-derives it per pane from `default-terminal`, and `COLORTERM` is not set for two measured reasons (ADR-281 §D2): tmux sets `COLORTERM=truecolor` in every pane itself regardless of the server environ, so the pane half was inert; and on the attach path tmux reads `COLORTERM` from the **client** to decide the operator's terminal advertises RGB (`#{client_termfeatures}`), so setting it made tmux stop downconverting at a terminal that never claimed 24-bit colour. ⚠ **The claim that `templates/tmux/atmux.conf` carried a `COLORTERM truecolor` line was FALSE** — it carried none; the line existed only in the operator's personal `~/.tmux.conf`, which atmux does not ship. The line is in the shipped conf now (after the ADR-277 scrub, above the ADR-171 `source-file`), with two regression legs holding it there. Measured 2026-08-29 on tmux 3.7c, fresh `mktemp` sockets: server-side `COLORTERM` with the client carrying none leaves `#{client_termfeatures}` at `bpaste,ccolour,clipboard,cstyle,focus,title` — **no `RGB`**, byte-identical to the no-line leg — while `COLORTERM` on the CLIENT does add `RGB`. That asymmetry is the whole argument and it reproduces. The line is also **inert for the pane** on 3.7c (tmux sets `COLORTERM=truecolor` there itself, with or without it), so it is a cheap defensive default rather than a fix for a measured pane fault — see the conf comment.
- **Every other path that starts a tmux process carries it too**, read-only probes included, because a read-only command against a dead socket is a server-creating command: `doctor/types.ts::defaultTmuxSpawn`, `cursor-recipes/fix-supervisor-missing.ts`, `fallback-cage.ts`'s `capture-pane`. Sudo-wrapped sites (`fallback-cage` Tier 3+, `poke.ts::sendCageBrief`) use `TMUX_CHILD_ENV_ARGV` (`-u NO_COLOR`, kept byte-for-byte equivalent to the spawn-level list) in their `env(1)` prefix — `sudo`'s `env_reset` discards a spawn-level override. Everything reached through `createTmux` (`start.ts`, `cockpit.ts`, `vox.ts`, `groom.ts`, the read-path modules, `fallback-cage` Tier 2) is covered by the tmux.ts change with no site-level edit.
- **Three layers now, and the operator still wins**: spawn scrub → `atmux.conf` (ADR-277, unchanged) → `~/.config/atmux/tmux.conf.local` last ([ADR-171](docs/adr/171-tmux-conf-local-override.md)). `set-environment -gr` on an absent variable is a no-op, so both scrubs together cost nothing.
- **Servers already running are unaffected** — a tmux server freezes its environ once. ADR-277 §D3's in-place `tmux -S <sock> set-environment -gr NO_COLOR` remains the repair for those, and remains preferable to a restart that would destroy live agent context.
- **Tests**: `tests/unit/abstractions/spawn.test.ts` gains 8 `unsetEnv` cases (including a control leg proving the var *does* arrive without it, and the empty-string-is-different leg). `tests/regression/atmux-conf-no-color-scrub.test.ts` gains the leg the conf-only guard structurally could not have — every pre-existing leg passes `-f CONF_PATH`, so together they could only prove the conf was *correct*, never that it *arrived*; the new one drives `createTmux` with `-f /dev/null` (an explicitly EMPTY conf, which is what rules the conf out as the reason) and asserts a real pane comes out clean, with a raw-tmux control leg that asserts the same shape **is** poisoned. Verified by reverting the source fix: both new legs go red.
- **Two pre-existing defects in that regression file, fixed in the same commit.** (1) Its ADR-277 control leg was **failing on any box whose `~/.config/atmux/tmux.conf.local` sources a `~/.tmux.conf` carrying the same scrub** — the "stripped" conf re-acquired the directive through the operator's own chain, which also meant the shipped-conf leg above it was passing for the operator's reason rather than the shipped conf's; the probe now redirects `HOME` into its scratch dir. (2) It asserted against the **entire** pane `env` dump, so a failure printed every API token, DB password and webhook in the operator's environment into the test log (observed). Fixed structurally — see the ADR-282 entry below; the probe no longer collects anything but an allowlist.

### 🔒 Security — probes collect an allowlist ([ADR-282](docs/adr/282-never-collect-the-whole-environment-in-a-test.md))

**A failing assertion in the ADR-281 suite printed ~180 environment variables with their values into a test log and an agent transcript on 2026-08-28** — the runner's environment carries live API tokens, database and docs passwords, and Discord webhook URLs, because the operator's `.zshrc` sources a git-crypt'd `.env`. The probe pane redirected all of `env` to a file and the assertions ran against the whole string, so `expect(received)` printed it in full. Nothing about the assertion was wrong; the disclosure was structural, and filtering before asserting only moves it one careless `expect(raw)` away.

- **Probes collect an allowlist, filtered inside the probe** — `env | grep -E "^(NO_COLOR|COLORTERM|TERM|TMUX)=" > <file> || true`. What is never collected cannot be printed by a failure, a stray `console.log`, or a future author who did not read the ADR. The `|| true` is load-bearing: `grep` exits 1 on no match, and "no match" is the expected result for the leg asserting `NO_COLOR` is absent.
- **New shared helper `tests/helpers/env-dump.ts`** — `ENV_DUMP_ALLOWLIST`, `dumpEnvCommand(outPath, vars?, keepAliveSeconds?)`, `parseEnvDump(dump, vars?)`. It refuses a quoted `outPath` (spliced into a shell word), a non-identifier variable name (spliced into an ERE), and an empty allowlist (that would dump everything). `tests/regression/atmux-conf-no-color-scrub.test.ts` routes through it.
- **A redactor as the seatbelt, never the brake** — `parseEnvDump` replaces the value of any surviving name matching `SENSITIVE_NAME_RE` (`tests/helpers/env-dump.ts`), matching the **name** only so it cannot itself leak. The long, unambiguous words (`PASSWORD`, `SECRET`, `TOKEN`, `WEBHOOK`, …) match as substrings; the short, collision-prone ones (`KEY`, `PAT`, `AUTH`) match only as whole `_`-delimited segments, so `PATH` is not redacted. It is explicitly not the defence: a name pattern is a guess, and `DATABASE_URL` carries a password while matching none of it.
- **`biome.json` gains `tests/regression/**` and `tests/helpers/**`.** `tests/regression/` was outside `files.includes`, which is why an unlinted, unformatted file sat there while `bun run lint` stayed green. `tests/helpers/` brings 7 pre-existing `noNonNullAssertion`/format warnings in unrelated files — left standing and surfaced rather than silenced with an `overrides` rule, which would be loosening a measurement to make a gate green.
- **Rotation of the disclosed credentials is a separate operator decision, already raised, and out of scope here.**

### 🔧 Changed — ADR-281 revised the day it landed, and demoted to `proposed`

- **Status corrected `accepted` → `proposed`.** ADR-281 was marked accepted by the implementing agent in the same commit as its own code; `CLAUDE.md` §"Binding discipline" #4 allows that transition only via reviewer signoff or a driver/lead `decisions-add`. **Re-accepted 2026-08-29 by operator-direct signoff**, together with ADR-282, when the branch was authorised for merge.
- **`TMUX_CHILD_ENV` withdrawn entirely** (see the ADR-281 entry above) — the export is gone rather than emptied, so no dead seam invites a refill.
- **A vacuous assertion deleted, not repaired.** `expect(env).toMatch(/^COLORTERM=truecolor$/m)` could not fail: tmux sets that value in every pane itself, so it held with or without atmux's policy and survived the mutation that emptied `TMUX_CHILD_ENV`. Deleted with the policy it was pinning.
### ✨ Added — operator-cooperative `_bot` seats ([ADR-285](docs/adr/285-cooperative-bot-seat-and-superbot-offer-protocol.md))

- An opt-in `team.json::bot` block creates exactly one `_bot` window after declared drivers and before members, backed by `.atmux/worktrees/bot` on `<base>-bot`. Existing `_bot` windows are preserved during incremental starts.
- Each bot has the stable `bot@<team>` identity and a harness-neutral brief. A null or omitted harness starts zsh for direct operator use but is deliberately unroutable; automated offers require an explicit harness/account.
- `atmux bot hold|resume` provides a durable tmux-window interlock for operator sessions. Manual input needs no special mode and always outranks future scheduler offers.
- `_bot` is a distinct typed send target. ADR-239's driver send-keys prohibition remains unchanged, and bot worktree setup fails closed instead of falling back to shared trunk.

### ✨ Added — held `_superbot` offer-and-pull source ([ADR-285](docs/adr/285-cooperative-bot-seat-and-superbot-offer-protocol.md))

- `_superbot` is a deterministic 30-minute Kanban candidate router immediately after optional `_medic`, with a singleton loop and one-shot tick. It offers board/task/tag identity plus the exact atomic claim command; it never claims, assigns, or copies task bodies.
- Candidate discovery crosses the installed `kb` CLI with ambient board selectors removed. Route order resolves multi-tag work, default owners precede one-interval fallbacks, and pending delivery metadata distinguishes an interrupted send from a verified offer.
- Automated delivery requires a stably idle, empty, unheld Claude bot with no live `bot@<team>` lease. It buffer-pastes one multiline offer under the per-pane lock and performs a final readiness check immediately before sending; direct operator input wins.
- A checked-in held fleet plan covers all 18 observed persistent teams and 95 registered `(board, tag)` routes. Its renderer prints disabled + shadow cockpit and per-team patches without writing live configuration. Six missing team configs and two mapping/account mismatches remain explicit activation blockers.
- Source defaults remain disabled + shadow. This change does not install, deploy, rebuild, reconcile, or mutate live tmux.

### ✨ Added — pathspec guard refuses commits that reach outside a Task's files (ADR-0058 b)

**A commit picks up files it was never meant to touch, through the index rather than through carelessness.** Someone else stages work in the same worktree, a `lint-staged` sweep restores partially-staged files, or a `git commit` with no pathspec commits whatever the index already held — and the commit's message describes one change while its contents carry somebody else's. Measured at three incidents in six hours on `u-n-u-m/root`; all three were recovered, and all three depended on the committer noticing.

- **`scripts/pathspec-guard.sh`** — verifies `git diff --cached --name-only` against the `## Files` section of the Task body, and exits non-zero naming every staged path that escapes it. The body is read from `--body-file`, `$ATMUX_TASK_BODY`, or the member's claim record, first match wins. A directory entry covers everything beneath it.
- **A Task with no `## Files` section is not judged** — it warns and passes. Legacy Tasks predate the convention and failing them closed would block the board, which is also what makes the guard adoptable before every Task carries a pathspec.
- **`ATMUX_PATHSPEC_GUARD=off` is audited, not silent** — it appends to `~/.atmux/logs/pathspec-guard.jsonl`. Recovery and bulk-rename commits legitimately need the bypass; an unattributable bypass is what makes the next incident impossible to explain.
- **`docs/RUNBOOK-commits.md`** — the failure, the guard, the opt-out playbook, and what to do when it fires. Planner, lead and committer briefs cross-reference it.

Ships as a standalone verifier rather than a hook: this repo declares no hook manager and has no `.husky/`, and inventing one would add a dependency it deliberately lacks. Wiring it into a hook is a one-line `scripts/pathspec-guard.sh` call wherever a consumer already runs pre-commit checks.

### 🗑 Removed — orchd retired entirely; atmux's scope narrows to tmux cages + `atmux vox` ([ADR-276](docs/adr/276-orchd-retirement-and-atmux-scope.md))

- **The `atmux orchd` verb, the Rust `rust/atmux-orchd/` crate (ticker daemon), and the `__orchd__` service window are gone.** `atmux orchd` now fails loud with an error naming ADR-276. `package.json` no longer builds or installs `atmux-orchd`. `atmux start` spawns no service window.
- **Epic-machinery event handlers deleted** (their dispatchers were already stubbed by [ADR-280](docs/adr/280-epic-team-retirement-and-staged-excision.md) stage 3): auto-merge (`orchd-merge.ts` — epic-completeness detection, and with it the only emitter of `epic.merged`), auto-dissolve (`orchd-dissolve.ts`), the backstop merge sweep (`orchd-merge-sweep.ts` + `orchd-log-fmt.ts`), context scanning (`orchd-context-scan.ts` + `pane-statusline.ts` — the only producer of `member.context-high`, so the rotation consumer went with it), housekeeping (`orchd-housekeep.ts`; `events-prune.ts` remains as the caller-invoked pruner), and the pressure-deferred spawn queue (`spawn-queue.ts` + repo + schema; its producer and drain died in ADR-280 stage 3).
- **`committer --drain` / `--daemon` are committer's own sub-verbs again** — the ADR-266 §D2 alias expiry pointed at the orchd verb, which no longer exists, so the bodies (which never left `committer.ts`) got their CLI surface back. The drain is the ADR-276 §D1-shaped operator-invoked backstop.
- **Auto-push (ADR-229) deleted outright, dispatcher included.** Nothing emits `epic.merged` once the auto-merge handler (its only emitter) is gone, so the seven-gate engine (`orchd-push.ts`) and the `dispatchGitPush` transport (`orchd-dispatch/git-push.ts`, ADR-232) were removed rather than kept as dead code; both re-derive from git history (last present at trunk `170700d3`) when ADR-276 §D1's operator-invoked push verb is built. The §DA-Gate-2 allowlist `src/core/auto-push.ts` is untouched — it has live consumers (merge-member, claim, merge-cycle, cockpit pushPolicy).
- **The subscription registry slimmed and renamed**: `orchd-registry.ts` + `orchd-bootstrap.ts` → `src/core/event-subscriptions.ts`, registering the complaint consumer (ADR-214 — its emitter `atmux complaints` is live) and the lead-stall watchdog (ADR-247 — its wiring moved verbatim from the retired verb into the drain). Consumer-id strings are unchanged: they are durable `subscriber_offsets` keys.
- **Survives, explicitly**: the Honker substrate, the events/offsets tables, `atmux-listener` (the daemon body's wake channel), `atmux-cockpit-mirror` (ADR-219/230 — different database, named by ADR-276 as kept), gitter + lane-router consumers, and `atmux vox`.
- ADR-202/203/226/227/229 carry superseded-in-place banners pointing at ADR-276 (250 already had one from ADR-280).

### ✨ Added — declarative operator cockpit windows ([ADR-279](docs/adr/279-declarative-operator-cockpit-windows.md))

- Top-level `cockpit.json::windows[]` persists non-team cockpit workspaces with a name, cwd, and optional command. Null or omitted command starts zsh; configured windows sit after `_medic` and before team viewers.
- Explicit `cockpitSession` values are now authoritative. `atx` remains the new-config default, but loading a persisted `atmux_cockpit` no longer silently schedules an in-place rename before reconcile's destructive-operation gate.
- The operator's canonical config now declares the live `_misc` workspace at `/root/work`. No live tmux session, window, client, or socket is mutated by this source/config change.

### 🔄 Changed — driver panes default to zsh, not a pinned agent harness ([ADR-278](docs/adr/278-nullable-driver-agent-harness.md))

- `drivers[].tui` is now nullable/optional. `null` or absence starts the driver in zsh without auto-launching Claude, Codex, OpenCode, or another agent harness; an explicit non-null alias retains the prior auto-launch behavior.
- The new-team template and the operator's canonical atmux team configs now set driver harnesses to `null`. Member TUI declarations are unchanged.
- Existing tmux sessions are untouched; the change takes effect when driver panes are next created.

### 🐛 Fixed — `vox`'s `tell_lead` succeeded, delivered the message, and reported failure ([ADR-272](docs/adr/272-voice-operator-interface.md) §Supplement-2026-08-20)

**The verb worked and the bridge said it hadn't.** `atmux tell-lead` appends the ask to the lead inbox and confirms on **stderr** — `✅ atmux tell-lead → <lead> (appended to <path>)` — writing nothing at all to stdout, per the `atmux::ok` convention (`src/core/tui.ts`, ported from bash `lib/common.sh:21`). `CaptureVerbRunResult` captured **only stdout**, so the tool bridge structurally could not see that receipt, and its step-12 check — empty summarized output → `verb_output_unparseable` — turned exit 0 into a failure envelope.

The consequence is a retry storm in which every iteration both succeeds and is reported as broken: the operator hears "that failed", the model retries, another copy lands in the lead inbox, failure is reported again. `tell_lead` sits behind `ATMUX_VOX_READONLY`; the first use after that flag clears would have spammed the lead inbox from the operator's phone while claiming it did nothing.

- **The verbs were not touched, deliberately.** Moving receipts to stdout would revert a documented fix — `tell-lead.ts:298` records that an earlier TS port wrote to stdout without the prefix and that *that* was the F3 channel-asymmetry bug — and would break every scripted caller relying on clean stdout. The defect was entirely on the consuming side.
- **`exitCode === 0` is the success signal; empty stdout is not evidence of failure.** Step 10 has already rejected both real failure modes (a throw, a nonzero exit) before step 12 runs, so everything reaching it succeeded; the only open question is what there is to *say*.
- **The two cases are told apart explicitly, on `entry.mutating`.** A **mutating** tool's contract is the side effect, so exit 0 settles it and silence is a normal shape. A **read** tool's contract is data, so silence keeps `verb_output_unparseable` — the fault that code was written for. Every read verb in the catalog emits a line even when the answer is empty (`(no tasks)`, `(no blockers)`, `📭 outbox empty`, the `QUIET …` header), so silence from one really is an anomaly.
- **`CaptureVerbRunResult` gains `stderr`, and it is TEED rather than swallowed.** stdout is capture-owned — the buffer is the result — but stderr is the process's shared diagnostic channel, where the vox server logs and where a verb's warnings are often the operator's only trace of a half-done run. Every write still reaches the real stderr *and* the buffer. The field is optional so an injected `capture` fake is unaffected.
- **Only `atmux::ok` lines are ever spoken.** `extractOkReceipt` strips ANSI, keeps lines starting with the `✅ atmux` marker, and strips the marker itself. Warnings on that same channel (`atmux: warn: dispatch: ping to be-1 failed`), progress `🔹`, error `💥` and library noise are all dropped — the relayed string is read aloud as the answer to "did it work?", and letting arbitrary stderr fill that slot would be the same class of defect wearing different clothes. A mutating tool with no receipt gets a plain true fallback instead.
- **Scope-audited across the whole catalog, not just the reported tool.** `tell_lead` was the only affected entry — `add_task`, `dispatch_task`, `claim_task` and `pane_nudge` all print to stdout on success, and every read tool emits at least one line. `src/verbs/reply.ts` writes the same stderr-only receipt shape and is not in the catalog today; the fix sits at the bridge, so a future `reply` tool inherits it rather than rediscovering the trap.
- **A second defect surfaced by mutation-checking the fix:** deleting the `process.stderr.write` restore from the capture's `finally` passed the whole suite, because the tee hides the leak — writes still reach the real stderr *through* the leaked patch. The capture now restores the raw property reference rather than a bound clone, so the round-trip is an identity and can be asserted (after a normal verb, after a throwing verb, and across three consecutive captures).
- **`console.error` is patched alongside `process.stderr.write`.** In Bun the two are separate surfaces — `console.error` does not route through `process.stderr.write`, just as `console.log` does not route through `process.stdout.write`, which is why the stdout half always patched both. A control test pins that Bun fact so the `console.error` assertions cannot pass vacuously.

### 🔄 Changed — `atmux voice` → `atmux vox` ([ADR-274](docs/adr/274-atmux-vox-rename.md))

**The spoken operator interface is named `atmux vox`.** [ADR-272](docs/adr/272-voice-operator-interface.md) §OQ-5 closed on 2026-08-14 with `voice` standing as a top-level verb, settled early *specifically* so no rename shim would be owed. The operator reopened it after the feature shipped, so the shim is owed — and it is paid and dated here rather than quietly skipped.

- **Renamed:** the verb (`atmux voice` → **`atmux vox`**), the env-var prefix (`ATMUX_VOICE_*` → **`ATMUX_VOX_*`**), the supervised tmux session (`atmux-voice` → **`atmux-vox`**), the PWA assets dir (`templates/voice/` → **`templates/vox/`**), the transcript dir (`~/.atmux/voice-logs/` → **`~/.atmux/vox-logs/`**), the runbook (`docs/RUNBOOK-voice.md` → **[docs/RUNBOOK-vox.md](docs/RUNBOOK-vox.md)**), and the module paths (`src/core/voice/` → **`src/core/vox/`**, `src/verbs/voice.ts` → **`src/verbs/vox.ts`**).
- **`atmux voice` still works and warns.** It forwards argv untouched to `atmux vox` — every flag, exit code and error identical — with a single deprecation line on **stderr**, so a piped `--json` reader is unaffected. An alias that behaves even slightly differently from its target is a second implementation wearing a shim's name.
- **`ATMUX_VOICE_*` is still read, as a fallback only when the `ATMUX_VOX_*` equivalent is unset** (`readVoxEnv`, `src/core/vox/env-compat.ts`); an exported-but-empty var counts as unset, so it cannot shadow anything. **When both are set, `ATMUX_VOX_*` wins**, and the legacy name is warned about — louder when the two values *differ*, because a stale value shadowing a fresh one is the failure that wastes the most time: everything looks configured and the wrong value is in play. This half is the load-bearing one. `ATMUX_VOICE_TOKEN` is already committed to the operator's git-crypt'd dotfiles with a `keys/KEYS.md` pointer row and exported in whatever shells are open; without the fallback the first launch after this lands dies with `ATMUX_VOX_TOKEN is required`, an error whose text contains nothing connecting it to a rename agreed days earlier.
- **Both shims are removed in `v0.9.1`**, and every site carries a greppable `SUNSET(v0.9.1):` marker per [ADR-266](docs/adr/266-shim-sunset-policy-and-first-sweep.md) §D1. That is deliberately one train *after* the ADR-264 `atx` shims (`SUNSET(v0.9.0)`) — no single release is asked to sweep both batches, and a sweep that clears half a batch is how a shim outlives its own expiry.
- **NOT renamed, deliberately:** the hostname **`atmux.geoy.ws`** — DNS, the wildcard TLS cert, the nginx vhost and the O2 artifacts all key off it, and the host name is not the feature name; the **token's VALUE** — only the variable holding it changes, since rotating a working credential during a rename makes any failure ambiguous; and **ADR-272 / ADR-273's filenames and titles** — ADRs are append-only and named for what they decided when they decided it, so each gains a pointer to ADR-274 and nothing else. The `atmux fleet` and `atmux nudge` verbs also stand: whether `vox` should cover fleet triage is left open by ADR-274 rather than answered by a sweep.
- **The entries below this one stand as written, and that is on purpose.** They record what shipped and what was *observed* under the name it had at the time — including pasted probe output (`voice-probe:`, `voice-live-smoke:`) and a bug reproduced with `ATMUX_VOICE_READONLY=1`. Rewriting a captured receipt so it matches a later rename makes it un-reproducible as quoted and indistinguishable from a fabricated one. The single link that moved: `docs/RUNBOOK-voice.md`, cited in the entry below, is now [docs/RUNBOOK-vox.md](docs/RUNBOOK-vox.md).

### 🐛 Fixed — `atmux voice --status` reported ITS OWN config as the running server's state ([ADR-272](docs/adr/272-voice-operator-interface.md))

**`--status` fetched `/healthz` and threw the body away.** It then printed `deps.config.provider` and `deps.config.readonly` — the values resolved from the *invoking shell's* environment — on a line an operator reads as the server's state. Observed live against the deployed server: `--status` said `readonly=false` while `curl https://atmux.geoy.ws/healthz` said `readonly:true`, purely because the shell running the command had not exported the flag.

- **The dangerous direction is the inverse of the one observed.** A server running *without* readonly, queried from a shell that happens to set `ATMUX_VOICE_READONLY=1`, reported `readonly=true` — a false all-clear that every mutating voice tool was disabled when all of them were live, on the exact check an operator runs before trusting a deployment. That is the case the new tests pin hardest.
- **Every reported field now comes from the parsed `/healthz` body**, including the `degraded` + `bridge` block added on 2026-08-15 — so a wedged tool bridge (`bridge=WEDGED  stuckTool=… heldMs=…`) is visible from `--status` rather than only from a raw `curl`. Local config is **not** a fallback for a reachable server.
- **When `/healthz` cannot be read, no line claims to describe the server.** The report says `server state UNKNOWN` and prints the local values exactly once, behind a `local config (NOT the server)` label — the operator can always tell which he is looking at. A body that is not a `/healthz` body (wrong service on the port, an HTML 502) reads `healthz=malformed` instead of crashing the command whose job is to diagnose the breakage.
- **Exit-code semantics are deliberately unchanged**: reachability, not the verdict — a wedged-but-answering server still exits 0, matching the reason `/healthz` stays HTTP 200 while wedged. The wedge is surfaced in the printed lines instead.
- **Test discipline the bug demands.** Every `--status` test now makes the two sources *disagree* — server `readonly:true` against local `false`, and `readonly:false` against local `true`. A fixture where both sources agree proves nothing, which is how the original defect survived its own suite. The producer/parser pair is round-tripped through the real `healthzBody` output rather than a hand-written fixture, and the parse is non-strict so an older installed `atmux` can still read a newer server's body.

Third instance of one defect class today, after `/healthz` reporting `ok` through a wedged bridge and `cage-state` reporting live teams as down: **a status surface that reports something other than what it observed.**

Also closes a pre-existing function-coverage gap in the same file, found while measuring this fix: `serveVoice`'s daily transcript-prune callback was never invoked by any test, because the real interval is 24h and the existing test asserted only that a timer *with that interval* had been armed. The tick is now fired through an injected timer, and the second prune plus the re-arm are asserted — so ADR-272 OQ-4's "and daily thereafter" is a tested claim rather than an integer. `src/verbs/voice.ts` goes 98.99% → **100%** function coverage.

### 🐛 Fixed — `atmux fleet` sweeps epic-teams instead of writing them off ([ADR-273](docs/adr/273-voice-fleet-triage-and-pane-input.md) §Supplement-3 U1/U2)

**Five of twenty teams reported UNREADABLE on every single sweep, with a reason naming no action.** ADR-273 §S3.2 claimed an `epic-team`'s cage "is not resolvable from the cockpit entry". That was true of the *entry* and false of the *cage*: `spawn-epic` gives an epic-team a root of its own carrying its own `team.json`, socket and session anchor — and this repo already knew how to find it, in `src/core/cage-resolver.ts`. The two on-disk conventions (ADR-089 in-parent `<parent>/.atmux/worktrees/<name>`, ADR-090 sibling `<parent>-epics/<epicId>`) are now one shared helper, `epicCageRootCandidates` / `resolveEpicCageRoot`, that `resolveCageForEpic` was refactored onto.

- **The sweep rewrites the entry's root to the epic-team's own cage before probing**, so a live epic-team is swept in full — panes, classes, gists, driver-inbox and flag asks. No epic-specific branch was needed in `probeTeamLive`: everything it reads already keys off the root.
- **Only an epic-team with no live cage stays unreadable**, under one shared reason that names `atmux team dissolve-epic` — an action that removes the row permanently. One constant, not two, so `renderUnreadable`'s group-by-reason collapses the whole set into a single spoken clause.
- **Deliberate asymmetry, measured not assumed**: an epic-team with no cage is *not* a `dead` attention item the way a top-level team is. Epic-teams are ephemeral by construction, so a cage that ended is bookkeeping, not news — the same call §S3.3 made for `dormant`. Promoting them took **two of the five spoken slots** on the live fleet and pushed `hx`'s crashed panes and `atmux`'s unread asks into the remainder count, permanently, for epics dissolved in May. The cost is stated in the ADR rather than hidden: a live epic cage that just died is named on the unreadable line rather than ranked acute.

### 🐛 Fixed — `atmux doctor`'s last two hard-coded `atmux-<team>` session names ([ADR-273](docs/adr/273-voice-fleet-triage-and-pane-input.md) §Supplement-4)

**Closes the deferral ADR-273 §S2 filed.** `src/verbs/doctor/cockpit.ts` still built the session name by hand in two places — the same defect already fixed in `cage-state.ts`, where it made every member of `unum` (anchored `atmux_unum`) and `atmux` (bare `atmux`) read as down. Both sites now go through one helper, `probeSessionName`, whose two arms are a decision rather than a convenience:

- **`checkMemberCageStates`** *gated* its whole check on the literal and returned no rows on a miss — blind rather than lying, which is why it outlived its `cage-state.ts` twin. It resolves through `getSessionName({ dir: atmuxDir, team })`, the anchor-aware resolver `gatherStatus` already uses, and fails soft to the old literal rather than throwing when a `singleSession` team has no anchor.
- **`checkLegacyWindowNameFormat`** walks many teams, so it resolves through `resolveCageSessionName({ name, root })` — the anchor-only resolver, deliberately **not** `getSessionName`, whose `ATMUX_SESSION` pin is a process-level override for the *current* team and would point every team's probe at one cage. The cockpit root is carried per target for exactly that; the `currentTeam` fallback keeps `getSessionName`, where the pin is right. Tests set one env var and assert opposite answers from the two arms.
- **ADR-161's "non-canonical session name is out of scope" carve-out is removed** ([§Amendment 2026-08-17](docs/adr/161-default-member-prefix-and-sort-verbs.md)) — it was never a scoping decision, just the probe skipping every anchored cage. The `tmux rename-window` hint now names a session that exists.
- **Live-fleet effect, measured rather than claimed: none today, and that is the finding.** Both checks were run against the real cockpit before and after with byte-identical output. The break is real and directly provable (`has-session -t atmux-unum` exits 1, `-t atmux_unum` exits 0), but both checks are member-scoped and both anchored teams are driver-only (`members: []`), so nothing was reachable to report. Strictly additive and currently latent: no row disappears, and the rows that were structurally unreachable become reachable the moment either team regains members.

### ✨ Added — `atmux voice`: a spoken operator interface for the fleet ([ADR-272](docs/adr/272-voice-operator-interface.md))

**Shipped across six phases and deployed read-only.** The operator can now read the fleet from a phone — walking, in a lift, in a car — over a chain of **PWA → WebSocket relay → realtime provider → `atmux` verbs**. Motivation is coordination, not convenience: under manual orchestration ([ADR-260](docs/adr/260-manual-orchestration-mode-default.md)) the operator and the lead LLMs *are* the scheduler, so an unreachable operator is a missing scheduler. Product framing in `docs/PRD.md` §3.7, architecture in `docs/ARCHITECTURE.md` §Voice subsystem, operating surface + V-1…V-18 acceptance checklist in [docs/RUNBOOK-voice.md](docs/RUNBOOK-voice.md).

- **P1 — protocol layer** (`src/core/voice/{frame,audio,auth,confirm,registry,assets}.ts`, `src/schema/voice.ts`): binary frame codec (4-byte header — magic `0xA1`, `TURN_END`/`SYNTHETIC` flags, `uint16` seq; payload PCM16LE mono 24 kHz, 40 ms = 960 samples = 1920 B + 4 B header), JSON control schema, timing-safe **pre-upgrade** token auth, confirmation-token store, static asset routes. Audio is binary frames and control is JSON text frames; the two never mix.
- **P2 — provider seam** (`src/abstractions/voice-provider.ts` types-only + `src/abstractions/voice/{factory,openai-realtime}.ts`): `VoiceProvider.connect(config) → VoiceSession`, following the `AgentBackend` precedent ([ADR-258](docs/adr/258-vendor-agnostic-orchestration-agentbackend.md)). **No provider-native frame shape crosses the adapter boundary in either direction** (§D4).
- **P3 — tool bridge** (`src/core/voice/{tool-bridge,tool-catalog,config,team-context,summarize,instructions}.ts`): the v1 catalog is **14 tools — 10 read + 4 messaging** (§D6). Every tool call becomes an **argv array** for the `atmux` CLI — never a composed shell string, never `sh -c`, no `run_command`, no `eval` (§D2), with per-tool Zod validation before the argv is built. Mutation confirmation is **server-enforced** via a single-use token bound to `sha256(tool ‖ canonical_json(args) ‖ session_id)` with a TTL, so a token minted for one member cannot be redeemed for another (§D7).
- **P4 — session + serve verb** (`src/core/voice/session.ts`, `src/verbs/voice.ts`): `atmux voice [--serve|--supervise|--status|--stop] [--port <n>] [--provider <p>] [--model <m>] [--readonly]`. One active session, latest-wins takeover, 90-second resume park for a dropped phone with buffered mic audio **discarded rather than replayed** (§D8). `--supervise` owns a detached `atmux-voice` tmux session on the default socket under a crash-loop wrapper with a 5-restarts-in-60s circuit breaker — operator-started, **nothing at boot** ([ADR-233](docs/adr/233-cron-auto-install-disabled-trust-orchd.md)), not a cockpit window (reconcile would prune it) and not a cage window (`atmux stop` on an unrelated team would end the call) (§D10).
- **P5 — PWA client** (`templates/voice/`): vanilla ESM, **no build step and no service worker** (§D11 — a cached client speaking a stale binary protocol is the one failure a service worker reliably produces, on a page the operator cannot fix from a phone). `AudioWorklet` capture on the audio render thread with exact 2:1 48 → 24 kHz decimation; raw-PCM playback; `AudioContext` created inside the first user gesture. Push-to-talk, not continuous VAD. Lives in `templates/` so the browser code is outside the `src/**` lcov universe **by construction rather than by exclusion** — `coveragePathIgnorePatterns` gains zero new entries (§D9).
- **P6 — second provider** (`src/abstractions/voice/gemini-live.ts`): Gemini Live `BidiGenerateContent` behind the same seam, with server-side 24 → 16 kHz uplink decimation, PTT activity markers vs server-VAD, and a per-session tool-call `id → name` map (Gemini requires `name` beside the id on the response). **Landed with `voice-provider.ts` untouched and zero client diff** — the seam holding is the point of the phase.
- **V-7 (provider swap, zero client diff) closed LIVE**, against the real Google endpoint rather than a fixture — `ATMUX_VOICE_PROVIDER` flipped to `gemini-live`, probe re-run with **byte-identical client assets**, pinned model confirmed present in the live model list:

  ```
  provider=gemini-live  model=gemini-2.5-flash-native-audio-preview-09-2025
  voice-probe: ready: {"type":"ready","provider":"gemini-live",
    "model":"gemini-2.5-flash-native-audio-preview-09-2025",…,"readonly":true}
  voice-probe: streaming 50 frames (96000 bytes PCM16 @ 24000 Hz)
  voice-probe: ok=true uplinkFrames=50 downlinkFrames=14 downlinkBytes=71040
    frameTypes=[ready,status,transcript.user,transcript.assistant] closeCode=1000
  ```

  Recorded here because the receipt post-dates the P6 commit body, which still reads "no real Gemini endpoint has been dialled" — a claim that was true when written and is now stale. **Both adapters are live-verified against their real providers**: `openai-realtime` only after the GA port below, `gemini-live` without code changes.
- **Security posture** (§Security): the server runs verbs with `ATMUX_CALLER_SCOPE=driver`, so **whoever reaches the WebSocket is the driver** — hence five layers (oauth2-proxy vhost; `≥32`-char `ATMUX_VOICE_TOKEN` compared timing-safely before the upgrade, with `access_log off` mandatory; `hello` re-assertion + `Origin` allowlist as the CSRF defense, since browsers do not apply same-origin policy to WebSocket handshakes; loopback bind; and the read-only kill switch). API keys never leave the box — the relay exists so provider credentials are never placed on a phone.
- **Deployed with `ATMUX_VOICE_READONLY=1`.** The 4 messaging tools are **absent from the catalog** handed to the provider, not merely refused at call time — and the bridge independently refuses any mutating call with `readonly_mode` as a second layer. Voice can read the fleet and change nothing until phase P7 clears the flag; it carries an [ADR-266](docs/adr/266-shim-sunset-policy-and-first-sweep.md) `SUNSET` marker.
- **Resolved open questions:** OQ-4 — voice transcripts are **local-only** under `~/.atmux/voice-logs/` with **7-day** retention (never a synced or shared path; the recording is the risk, not the disk), *decision recorded, implementation owed at P7*; OQ-5 — `voice` stands as a top-level verb, settled before P4 so no rename shim is owed.

### ✨ Added — voice fleet triage: `fleet_attention` + `fleet_quiet`, and the `atmux fleet` verb ([ADR-273](docs/adr/273-voice-fleet-triage-and-pane-input.md) D1–D3)

**The tools answered point questions; the operator's question is neither point-shaped nor per-team.** "What needs my attention across everything, and what doesn't?" previously cost `list_teams` + `team_status` × N + `member_pane` × N × M — twenty teams times several panes, each a spoken round trip — and still returned state *labels* rather than what an agent is stuck on. Two new read-only tools replace that with one call each, taking the catalog from 14 to 16. Both are `mutating: false`, so both work under `ATMUX_VOICE_READONLY=1`; that is why the survey half ships before any input capability. Also a first-class CLI verb: `atmux fleet [--attention|--quiet] [--top <n>] [--json]`.

- **`fleet_attention`** — every pane that needs the operator, ranked most-urgent first, each carrying **its evidence** (the marker matched plus a pane gist). Speaks at most `top` entries (1..15, default 5); same-class findings on one team collapse into one entry (`dash — 7 panes (docs, driver, driver-2 +4)`) so one team's single cause cannot eat the budget; the remainder becomes a count with a reason breakdown.
- **`fleet_quiet`** — the complement, **aggregated and never enumerated**. It exists so an empty attention list is *checkable* rather than indistinguishable from a silently broken sweep.
- **Classification is server-side and evidence-bearing** (§D3), across eleven attention classes and four quiet ones. `dormant` ranks last and is counted separately by `fleet_quiet`, so a merely-parked fleet still reports as nominal instead of drowning the acute findings.
- **Bounded and honest**: teams swept concurrently (default 8) under a wall-clock deadline; a team that cannot be read is **reported as unreadable, never silently omitted**, grouped by reason so five teams sharing one cause cost one clause.
- **OQ-3 answered by measurement, not guess**: a real sweep of 20 cockpit entries / 47 panes takes **~110 ms** (216 ms serial, 125 ms at concurrency 20). **No cache** — there is no latency to buy with the staleness risk. The `ageMs` field and the spoken "cached Ns ago" exist and are tested anyway, so a future cache cannot hand the caller a stale answer that looks fresh.

**All three classifier traps ADR-273 §D3 names were confirmed live and closed.** `pane-state=down` was a real false positive — `src/core/cage-state.ts` hard-coded `atmux-<team>` while `unum` anchors to `atmux_unum` and `atmux` to bare `atmux`, so every member of both live teams read as down; `probeCageState` gained a `sessionName` opt (default unchanged), `gatherStatus` now passes the name it already resolved, and the sweep resolves through the anchor-aware `resolveCageSessionName`. The in-flight-turn regex in `src/core/pane-state.ts` does match past-tense glyphs (`✻ Worked for 22s`) and tests BUSY before TYPING — the wedge hiding inside the healthy class — so the voice classifier carries the already-fixed present-tense-only regex instead. And silence is answered with an **independent clock**: tmux's own `#{window_activity}`, which no frozen render can forge, so a spinner that has not repainted in five minutes is `frozen`, not `working`.

> **Running it against the real fleet was not a smoke test — it was the design step.** The first live run produced 50 findings of which the top five were all wrong, and each wrong one taught something a fixture never would: `pane_current_command` is `sh` for perfectly healthy Claude panes, so it cannot mean "crashed"; `/hit your limit/i` is a substring of Claude Code's own standing tip, so matching it throttled five healthy drivers on paper; `❯ Try "fix lint errors"` is the composer *placeholder*, so reading it as residue called five idle panes wedged; and Claude is not the only TUI in a cage, so a Claude-only chrome test called every live Codex and Kimi pane "no agent running". Every one is now a regression-pinned fixture. A classifier tested only against invented strings would have shipped all four — and a triage tool that cries wolf gets ignored, which defeats the tool.

### ✨ Added — voice pane input: `pane_nudge` + the `atmux nudge` verb ([ADR-273](docs/adr/273-voice-fleet-triage-and-pane-input.md) D4/D5)

**The fleet sweep found the 2am wedge and could not act on it.** `fleet_attention` reports `idle-residue` — text sitting in a composer nobody submitted — and the operator, one-handed and away from a laptop, still had no way to press the one key that clears it. `pane_nudge` is that key, and the CLI verb `atmux nudge --member <name> [--action submit|continue]` is the same capability from a terminal. Catalog 16 → 17.

- **It sends NO operator-supplied text, and that bound is the entire reason it can ship** while `pane_send` stays blocked on ADR-273 OQ-1's second-factor decision. The bound is structural, not a convention: `action` is a **zod enum**, the pasted word is a **compile-time constant** looked up from the enum name, and a unit test fails if any free-text parameter ever appears on the tool — because that is exactly what `pane_nudge` silently becoming `pane_send` looks like.
- **Two actions, each answering a `fleet_attention` class that actually occurs.** `submit` pastes **nothing** and presses the submit key on what the composer already holds (`idle-residue`, and `permission-prompt` — Claude Code's modals take the default selection on Enter). `continue` types the single word `continue` into an **empty** composer (`dormant` / `frozen`). They are two actions rather than one with an optional string precisely because pasting onto residue *concatenates*.
- **`mutating: true, confirm: true`** — confirm-gated under [ADR-272](docs/adr/272-voice-operator-interface.md) §D7 **and absent from the catalog under `ATMUX_VOICE_READONLY=1`**, so it is unreachable until P7 clears the flag. That is the correct order and it is pinned by a test rather than left as an intention. `VoiceToolEntry` gained an optional per-tool `preview` hook so the operator hears the exact target and the exact action — a generic "confirm pane nudge" would let a misheard member name through, which is the failure the gate exists for.
- **Delivery goes through the `send` VERB, never a hand-rolled `tmux send-keys`** (§D5). Settled by evidence: on wedged panes bare Enter, triple-Enter, `C-m` and bracketed paste **all failed**, and paste-and-submit was the only reliable path. Going through the verb means the nudge path inherits the member lookup, the ADR-135/161 window-rename shim, the ADR-025 driver-pane type gate, the safe-send modal preflight and [ADR-138](docs/adr/138-verified-send-keys.md)'s verify-and-retry — no parallel implementation to drift. A test injects a tmux namespace whose **every input-injection method throws**, so that rule rotting is a red suite rather than a silent regression.
- **`atmux send` gained `--submit-only`**, because a bare Enter is not expressible as a message: `send <m> ""` is a usage error and `send <m> "continue"` pastes *onto* the residue it is meant to submit. It skips the buffer/paste pair and runs the **same** settle + `C-m` + ADR-138 verify step the paste path runs (one shared `submitStep`). Combining it with a message body, `--no-submit`, `--broadcast`, or the cockpit-tier `__medic__` key is **refused** rather than silently resolved — every silent resolution there drops something the operator asked for.
- **The result is a receipt, not a claim.** The pane is read before, delivered to, then read again and classified with the fleet classifier; the verb exits **1** when the pane is in the same classified state it was in before. *"I pressed Enter"* is a claim; *"the composer cleared and the agent is now working"* is a receipt.

  ```
  NUDGE atmux/be-1 (window ⚙-be-1) — pressed Enter to submit what was already in the composer
  before: idle with unsubmitted text — unsubmitted: claim --next
  after: working
  the composer cleared and the agent is now working
  ```

> **The after-read deliberately refuses one rule the survey classifier applies, and that refusal is the difference between a receipt and a lie.** `classifyPaneObservation` treats composer residue in a window tmux saw activity in within the last minute as *someone is typing* and files it under `quiet: idle` — correct for a sweep, because it stops the tool reporting the pane the operator is mid-sentence in. After a nudge it is exactly wrong: **the recent activity is our own paste, one second ago.** Left alone, a nudge that changed nothing at all would be reported as "idle and clear" — the tool announcing success for a failure. `classifyAfterNudge` overrides that one bucket, and a test asserts the bare survey classifier really does disagree, so the bug is demonstrated rather than described.

> ⚠️ **Driver panes cannot be nudged, and it is the biggest practical limit.** [ADR-239](docs/adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §D2 is absolute — atmux never sends keystrokes into a `driver` / `driver-N` pane — while most `idle-residue` findings on the live fleet sit on exactly those windows, because 14 of 15 enabled teams carry `members: []` and run their work in driver windows. So **the most common finding `fleet_attention` reports is one `pane_nudge` structurally cannot act on.** The refusal is raised up front and names the ADR, so the operator hears a rule rather than a stack trace. The related asymmetry — the sweep enumerates from **tmux** while delivery goes through the **roster** — is documented rather than hidden: closing it would mean either a roster-driven sweep (which reports "all clear" across a working fleet) or a delivery path that is not `atmux send` (which §D5 forbids).

### ✨ Added — voice model-pin drift guard at boot, and an opt-in live provider smoke ([ADR-272](docs/adr/272-voice-operator-interface.md) §Supplement M1–M4)

**The OpenAI adapter was built against a retired API and nobody knew until a live dial. The class is not closed — it is loaded and aimed.** `defaultModelFor("gemini-live")` pins `gemini-2.5-flash-native-audio-preview-09-2025`: a **dated preview id**, retired on a schedule nobody in this repo controls. When it goes, the operator's whole experience of the fault is a phone call that goes quiet and closes **4500 after roughly 68 seconds** of dial retries, away from a laptop — the least diagnosable failure this feature can produce.

`atmux voice --serve` now checks the configured model against the provider's model index **after the listener binds** and prints a verdict: one quiet line when the pin is good, an unmissable banner naming the consequence, the closest available ids and the fix when it is not.

- **A network failure is `unreachable`, never `missing`.** An unreachable provider at boot is a different fault from a bad model id; reporting an egress hiccup as drift sends the operator hunting a model that is fine, and after two of those the warning gets ignored — which is how a guard dies while still technically running. An unrecognised response *shape* is `unreachable` too, so a provider reshaping its envelope cannot print a confident wrong claim. A `401`/`403` is reported as *the provider rejected the API key* — actionable, and a different problem.
- **It cannot block or fail the boot.** Failing closed would make voice refuse to start whenever egress hiccups — a rare loud problem traded for a common total one. Even a bug inside the checker degrades to one line. The check is a **read**; it can never change what the server does.
- **Bounded and skippable**: 3 s timeout, **zero retries** (the only cost is boot latency, and a retry multiplies exactly that), `ATMUX_VOICE_SKIP_MODEL_CHECK=1` for offline — with the skip itself logged loudly, because a skipped check will not catch a retired id.
- **The key never appears.** It rides an auth **header** (`Authorization: Bearer` / `x-goog-api-key`) rather than a query parameter — Gemini's REST API accepts `?key=`, and a URL lands in logs, shell history and `ps` — on top of the redacting logger. A test asserts the built URL carries no key for either provider.

**The guard is not sufficient on its own, which is why there is also an opt-in live smoke.** A model-list GET answers *"does this id exist?"*, not *"will a session with it open, negotiate and return audio?"* — and the 2026-08-15 failure was the second question, since `gpt-realtime` was a perfectly real id and the **session-frame shape** had been retired. `scripts/voice-live-smoke.ts` dials a real provider and asserts `session-ready` **and a non-zero downlink byte count**. Bytes, not "an event arrived": a provider that negotiates then goes quiet is a real observed fault class, and a smoke green on the event alone would pass for a broken adapter.

It **stays opt-in and out of `bun test`** deliberately — it bills per minute, needs keys that live only in the git-crypt'd dotfiles, and goes red on a provider outage, which is a CI failure that says nothing about the commit and that people learn to ignore. The orchestration is unit-tested against a fake provider so it carries the same 100% gate; only the shim dials. **Run it before a deploy, and after any provider or model bump.**

Verified live against both real endpoints — good pins, the loud path, and both smokes:

```
voice: model check ok — openai-realtime/gpt-realtime is in the provider's list of 124 models
voice: model check ok — gemini-live/gemini-2.5-flash-native-audio-preview-09-2025 is in the provider's list of 54 models
voice: ## MODEL PIN DRIFT — 'gpt-realtime-preview-2024-10-01' is NOT in openai-realtime's model list (124 models)
voice: ## Closest available: gpt-realtime-1.5, gpt-realtime-2, gpt-realtime-2.1
voice-live-smoke: ok=true provider=openai-realtime downlinkBytes=4800  transcript="Ready"   elapsedMs=1753
voice-live-smoke: ok=true provider=gemini-live    downlinkBytes=32640 transcript="Ready."  elapsedMs=1858
```

> **A live receipt worth reading twice:** Google's list already carries `gemini-2.5-flash-native-audio-preview-12-2025` — a **newer dated preview than the one we pin**. The pinned id still resolves today, so nothing is broken; but the successor exists, which is the drift this guard was built for arriving exactly on schedule. Bump deliberately, and re-run the smoke after.

### 🟢 Fixed — voice `dispatch_task.member` was optional in the schema and never optional in the verb ([ADR-272](docs/adr/272-voice-operator-interface.md) D6 §Supplement-2026-08-16)

**Every `dispatch_task` call that omitted `member` — which the schema told the model was legal — failed. Not intermittently: always.** `parseDispatchArgs` demands both positionals, so the argv built as `["t-abc123", "--team-dir", <root>]` slid the **task id into the member slot**, left the id empty and threw `UsageError`. The operator heard a `verb_failed` whose message named a member he never said. A model reading the catalog will believe an optional field is optional and will call it that way; that is what a schema is for, so the tool surface was lying — and [§D2](docs/adr/272-voice-operator-interface.md)'s "the blast radius is enumerable by reading one file" is weakened whenever the file describes something other than what runs.

`member` is now **required**, which turns the same mistake into a clean `bad_args` at validation before any argv exists. This adjusts D6's frozen `required` list, so the ADR carries a supplement recording the change, the reasoning, and the rejected alternative.

> **Rejected: teaching `parseDispatchArgs` to accept a missing member** (dispatch to the lane's next member, or to the task's existing assignee). Rejected on blast radius — `dispatch` is a verb the whole team system drives, and changing what a one-argument invocation *means* changes behaviour for every caller, cron line and brief, to fix a defect that exists only on the voice surface; the same reasoning §D2 §Supplement used to refuse teaching that parser the `--` terminator. And rejected on semantics: "dispatch task 4a2f" with an implied target is precisely the utterance a confirmation gate exists to catch, and D6 gates this tool because it is "wrong under a misheard member name". **In the abstract the parser change is the nicer feature** — an inferred assignee is genuinely more useful at 2am than being made to name a member. It is still the wrong call here: the useful version needs a decision about *what* it infers, that decision belongs to `dispatch` rather than to the voice catalog, and it would land as a fleet-wide behaviour change dressed as a voice bug fix. Requiring the field costs one spoken word. If the inference is ever wanted, it should arrive as its own change to `dispatch`, with its own ADR.

The pre-existing test that documented the failure mode is **updated, not deleted** — it now asserts the schema refuses the call, joined by one that drives the **real** `parseDispatchArgs` with the one-argument argv the old schema could produce, so schema and verb stay *provably* in agreement rather than merely in agreement today.

### 🟢 Fixed — voice `--supervise` was unusable in the deployed posture: `ATMUX_VOICE_BIN` override ([ADR-273](docs/adr/273-voice-fleet-triage-and-pane-input.md) §Supplement S5)

`resolveAtmuxBin()` finds `/usr/local/bin/atmux` → `/opt/atmux/0.8.30`, an **installed release that predates the `voice` verb** — so `--supervise` started a crash-loop wrapper that ran `/opt/atmux/0.8.30 voice --serve`, got `unknown verb: voice` and exit 64, and looped (observed live going restart 1/5 → 3/5; the circuit breaker itself worked correctly). The obvious fix, `bun run build:install`, swaps the atmux CLI **fleet-wide for every team on the box** — a release decision, not a supervision detail. The already-existing internal `binPath` override is now exposed as **`ATMUX_VOICE_BIN`**: precedence per-call override > env > `resolveAtmuxBin()`, with **both override layers failing closed** so an empty or whitespace-only value degrades to current behaviour rather than producing a wrapper that execs `''`. Repo-checkout deploys stay first-class: `ATMUX_VOICE_BIN=$PWD/bin/atmux-bun atmux voice --supervise`.

### 🟢 Fixed — voice: OpenAI adapter ported to the Realtime **GA** API; the beta shape is retired ([ADR-272](docs/adr/272-voice-operator-interface.md))

**The adapter had never worked against the live service, and 200+ passing tests said otherwise.** Found on the first real dial, during deploy. It was written against the Realtime **beta** API, which OpenAI has retired: both auth styles (`OpenAI-Beta: realtime=v1` header and the `openai-beta.realtime-v1` subprotocol) return `beta_api_shape_disabled` and close 4000. Ported live, one rejection at a time: `session.type: "realtime"` is now required; `session.modalities` is gone, replaced by `output_modalities`, which accepts only `["text"]` **or** `["audio"]` (the pair is rejected — we send `["audio"]`); audio config moved under `audio.input.{format,transcription,turn_detection}` / `audio.output.{format,voice}`; inbound deltas are `response.output_audio*`, with the beta `response.audio*` names kept as dead tolerance and relabelled as such. Unchanged and re-confirmed live: top-level `tools[]` / `tool_choice`, `input_audio_buffer` append/commit, `response.create` / `cancel`, and `conversation.item.create` for both `input_text` and `function_call_output`. End-to-end against the real service with the unmodified adapter: 127,200 bytes of assistant audio whose transcript correctly reflected the tool result. A regression-pin test asserts no beta-era key can reappear in `session.update`.

> **The lesson, recorded because it generalizes beyond voice: fixture-based tests encode *our model* of an external API, not the API. A green suite is not evidence that an integration works.** Every one of those tests passed against a fixture that was faithful to a document rather than to a service, so the suite's greenness measured self-consistency and nothing else. The failure was invisible until a socket was opened to the real endpoint. Where an integration crosses a network boundary we do not control, the acceptance criterion is a live dial — and the same reasoning is why [ADR-272](docs/adr/272-voice-operator-interface.md) insists the phone checks (V-9…V-17) are hand-run on a physical device and a green headless run is never reported as "voice works". **Both adapters are now live-verified against their real providers** (the Gemini V-7 receipt is in the P6 entry above), but they arrived there differently, and the difference is the lesson rather than a scorecard: this adapter needed a GA port to work at all, whereas `gemini-live` was correct as written and verified without changes. **Neither was proven until someone dialled the real endpoint — and one of the two turned out to be entirely broken at that moment.** Authoring quality is not what separated them; a live dial is.

### 🟢 Fixed — voice review fixes: nginx `http2` blocker, probe pre-upgrade auth, argv flag injection ([ADR-272](docs/adr/272-voice-operator-interface.md))

Four review findings; the first two were deploy-breaking.

- **BLOCKER — `nginx http2 on;` removed from the deploy example.** The standalone directive landed in nginx 1.25.1; the host runs 1.24.0, where `nginx -t` fails `[emerg] unknown directive "http2"` and a reload then refuses the **entire** config — **taking every other vhost on the box down, not just voice.** HTTP/1.1 is correct for a long-lived WebSocket anyway, so nothing was substituted. `location /ws` was also tightened to `location = /ws`: the prefix form captured `/wsfoo`, `/ws-admin` and anything else sharing the prefix, every one of them proxied into a driver-scope upgrade endpoint.
- **HIGH — the documented probe could not authenticate.** `runProbe` never passed the token to the **pre-upgrade** gate, which runs before a socket exists, so every documented first-deploy command returned 401 and V-3/V-4 as written could not pass. The suite hid it because the harness pre-tokenized the URL itself. Fixed via `Authorization: Bearer <token>`, chosen over `?token=` deliberately — a query parameter lands in nginx access logs, shell history and `ps` output; a header lands in none. The harness now exposes an un-tokenized URL so the probe must authenticate on its own.
- **MEDIUM — model-supplied strings could pose as CLI flags** in positional argv slots: `claim_task(task_id: "--next")` claimed whatever was next rather than the named task, and `dispatch_task(member: "--socket", …)` aimed dispatch at an arbitrary tmux socket. This is precisely the class §D2 promises to have closed — a CLI flag is "a transcript became a shell token" one layer up. Guarded in the Zod schema, where it holds regardless of any downstream parser; a dash *inside* a value (`px-crm-1`) still passes.
- **Doc claims made TRUE rather than softened:** the asset test now drives every route rather than five hand-picked ones (it had silently omitted three files the PWA cannot run without); the "byte-for-byte" audio claim now actually reassembles what the provider received and compares it to the synthesized PCM, asserting it is not silence, where before it checked only frame count.

### 🗑️ Removed — ADR-266 shim sunset policy + first expired-shim sweep ([ADR-266](docs/adr/266-shim-sunset-policy-and-first-sweep.md))

**Breaking for configs/aliases past their promised expiry — by design; each removal's error or this line names the ADR.** Deprecation shims that shipped with "accepting this release; will fail next release" contracts (written 2026-05-14→24, ~8–25 releases past expiry) are executed, and audit-verified dead modules are deleted outright.

- **Sunset policy (D1):** every future deprecation shim MUST ship a `SUNSET(<version>):` marker comment with an explicit expiry; the ADR-264 `atx` shims are the first to carry one (`SUNSET(v0.9.0)` at `migrateCockpitSessionLegacyLiteral`, `LEGACY_COCKPIT_SESSION_NAMES` + the rename-session migration shim, `COCKPIT_RESERVED_NAMES`, and the doctor `cockpit-on-default-socket` probe literals).
- **CLI aliases removed:** `atmux gitter` (ADR-159), `atmux relayd` (ADR-224), `atmux whip` + `atmux whip-resume-check` (ADR-160) dropped from `src/cli.ts` (now unknown-verb exit 64); the `whip` row dropped from `atmux help`.
- **`committer --daemon` / `--drain` aliases removed** (ADR-224 window): invoking them fails with an actionable error pointing at `atmux orchd --start` / `atmux orchd --drain`; the daemon/drain bodies stay in `src/verbs/committer.ts` (orchd delegates to them).
- **`cockpit rebuild` alias removed** (ADR-235 §OQ4): invoking it fails with an actionable error naming the canonical `atmux cockpit reconcile`; help row dropped.
- **ADR-133 superdoctor→medic shims removed:** `migrateSuperdoctorBlockToMedic` + the dual-key legacy-shape branch (`src/core/cockpit.ts`), `SuperdoctorSession` / `CockpitSuperdoctor` / `Cockpit.superdoctor` (`src/schema/cockpit.ts` — `CockpitMedic` re-anchored to the medic shape directly), and the `status.ts` `superdoctor` JSON mirror / `SuperdoctorState` / `probeSuperdoctor` aliases. The live readers (`start.ts`, `status.ts`) drop the `?? superdoctor` fallback. **A cockpit.json still carrying a `superdoctor` block (top-level key or `type: "superdoctor"` sessions[] entry) now fails at load with a `ConfigError` naming ADR-266 + the rename instructions** — the failure the expired contract promised.
- **`gitter`→`committer` role-literal Zod transform removed** (`src/schema/team.ts`, ADR-159): a literal `role: "gitter"` now parses as-is (open-string field); canonical value is `"committer"`.
- **`Tier4NotAvailableError` removed** (`src/abstractions/fallback-cage.ts`, ADR-050 one-cycle retention expired); the `instanceof` cascade branch in `src/core/whip-budget-fallback.ts` goes with it (`FallbackTierDroppedError` remains the tier gate).
- **Legacy `driverSession`/`driverTui` spawn fallback removed** (`src/core/drivers.ts`, `src/verbs/start.ts`, ADR-239 §D7): `atmux start` reads ONLY `drivers[]` for the driver-spawn loop; the bare `driverTui` field dropped from the schema (passthrough-ignored if present). `team.driverSession` STAYS as the opt-in marker read by the cockpit viewer window + driver-pane health probe. Teams still on the legacy fields must migrate to `drivers[]`.
- **Dead code deleted (zero live importers):** `src/core/whip-escalation.ts`, `src/core/superdoctor-cage-verdict.ts`, `src/core/repositories/superdoctor-attempts-repo.ts` + `src/schema/superdoctor-attempts.ts` (SQL tables stay — live raw-SQL readers), and the four orphan jury event topics `story.jury.ratified|pending|verdict|escalated` (`src/schema/events.ts`, ADR-213 §D5; closed topic set now 52).
- **Doc drift (D5):** the `[Unreleased]` cockpit-roles entry claiming "Medic narrowed to on-demand `atmux medic diagnose <team>` per ADR-212" was corrected — that code was never implemented; the `_medic` window stays live pending the ADR-212 cutover gate.
- **Kept (audit-verified load-bearing, NOT touched):** live `whip-*` core modules (poke/orchd/doctor), `_medic` window + `medic` config + medic paths in `cockpit-rotate.ts` + `probeMedic`, ombudsman verb + schema, superdoctor storage tables + hygiene + activity, `__superdoctor__` inbox alias (data-coupled), `--by superdoctor` historic-row literal, `src/core/common.ts` window-name legacy forms (separate review), all ADR-264 atx shims (sunset v0.9.0).

### 🔄 Changed — cockpit tmux session literal renamed `atmux_cockpit` → `atx` ([ADR-264](docs/adr/264-cockpit-session-atx-rename.md))

Third-generation session-name rename (`atmux_teams` → `atmux_cockpit` → `atx`); the prose word "cockpit", the `atmux cockpit` verb group, and the `atmux-cockpit` SOCKET name are all unchanged. Operator attach flow becomes `tmux -L atmux-cockpit attach -t atx`. `cockpit.json::cockpitSession` default flips to `atx` (`src/schema/cockpit.ts`); the load-time coercion shim `migrateCockpitSessionLegacyLiteral` (`src/core/cockpit.ts`) now accepts BOTH legacy literals (`atmux_cockpit`, `atmux_teams`) and coerces them to `atx` with a one-line deprecation warning — operator-chosen arbitrary names pass through untouched (§D3). `reconcileCockpitSession` (`src/verbs/cockpit.ts`) generalizes the ADR-135 §D4 shim one generation: when the resolved target is `atx`, a live legacy session is renamed in place via `tmux rename-session` (pane PIDs, attached clients, scroll history preserved; idempotent), warning when a legacy session and `atx` coexist (§D4). `LEGACY_COCKPIT_SESSION_NAMES` is now all-legacy (`["atmux_cockpit", "atmux_teams"]`) and the `atmux cockpit migrate-socket` target literal is `atx`; the `atmux doctor` `cockpit-on-default-socket` probe flags any of the three literals on the default socket (§D5); `COCKPIT_SESSION_DEFAULT` in `src/verbs/cockpit-rotate.ts` flips to `atx`. Templates (`templates/briefs/*.md`) and docs (RUNBOOK-cockpit, ARCHITECTURE, PRD, medic, RUNBOOK-migrate-to-honker) updated at machine-target granularity — prose "cockpit" stays.

### 🔄 Changed — manual orchestration mode is the DEFAULT; orchd is opt-in ([ADR-260](docs/adr/260-manual-orchestration-mode-default.md))

**Breaking for orchd-reliant teams.** New `team.json::orchestration.mode` (`"manual"` | `"orchd"`, strict block). Default — including when the block is absent — is `"manual"`: `maybeSpawnOrchdWindow` gains a Gate-1 mode check ahead of the ADR-259 gates, so NO `__orchd__` daemon spawns (no auto-merge, auto-push, auto-spawn, solo-worker dissolve, lead-stall watchdog, context/budget scanners) until a team explicitly sets `"orchd"`. Rationale recorded in the ADR per operator directive: **LLMs can manage their own fleet better than atmux's deterministic automation can at the moment** — the member/lead LLMs run the fleet by hand. New member verb for that: `atmux member status <idle|working|blocked|rate-limited> [--as <m>] [--note <t>] [--task <id>]` — self-reported status persisted to `<atmuxDir>/state/member-status/<member>.json` (`src/core/member-status.ts`, heartbeat-family file signal), with kanban coupling per ADR-260 §D4 (`working --task` claims via the full `claimTaskForMember` gate chain; `blocked --task` runs `markTaskBlockedWithNote`; `idle` lists dangling in-progress tasks with an `atmux done` hint) and a heartbeat touch on every report. `atmux status` renders the self-report as a trailing `📍<status>(task, age)` segment (text) / `selfStatus` key (JSON, key-presence convention). Schema helper `resolveOrchestrationMode()` is the single absent-block⇒manual resolution point. Briefs updated (member + lead manual-mode protocol). Tests: `tests/unit/core/member-status.test.ts`, `tests/unit/verbs/member-status.test.ts`, mode-gate cases in `tests/unit/core/orchd-window.test.ts`, schema cases in `tests/unit/schema/team.test.ts`, selfStatus cases in `tests/unit/verbs/status.test.ts`.

### 🟢 Fixed — `driverSession.model` no longer rejected by strict `team.json` validation ([ADR-239](docs/adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §D7, e-d8e94413)

Operators pinning a driver-TUI model in `team.json` (e.g. `driverSession: { tui: "shell", model: "cursor-fast" }`) previously tripped a `ZodError` — the `driverSession` sub-shape is `.strict()`, so any key beyond `tui` was rejected as unknown. `src/schema/team.ts:1376` now declares `model: z.string().nullable().optional()` inside that strict object: any string is accepted (atmux does NOT enforce a value set), `null` / absent both mean "unset" (spawn loop falls back to its account-derived default), sibling-consistent with `.tui`'s own `.nullable().optional()`. ADR-239 §D7 (driver-session schema shape) is the lineage; the field is purely additive so no ADR amendment is needed. 4 unit tests at `tests/unit/schema/team.test.ts` pin the surface — `model=<str>` parses cleanly, `=null` accepted, absent accepted (omitted, not coerced), non-string REJECTED with `ZodError`. Brief alignment confirmed: no `driverSession` / model-pin reference in `templates/briefs/` (nothing to re-point).

### ♻️ Fixed + Added — orchd RAM-leak cluster: singleton guard + stale-epic reaper + epic-cage socket fix (2026-06-04)

Triage of "orchd is leaking, growing RAM" (2026-05-29) found orchd's own RSS steady (~4MB); the growth was **136 `claude` TUIs ≈ 43.6 GB** across epic-team cages that were spawned but never dissolved. Three structural fixes close the leak at its sources:

- **Singleton guard** ([ADR-249](docs/adr/249-orchd-singleton-guard.md), `rust/atmux-orchd/src/main.rs`) — one supervisor per team DB via an advisory `flock` on `<db>.orchd.lock`. A second `atmux-orchd` for the same team fails fast (exit 5) instead of double-spawning epic-teams. Stops *duplicate* spawns at the source.
- **Stale-epic-team reaper** ([ADR-250](docs/adr/250-orchd-stale-epic-reaper.md), `src/core/orchd-reap.ts`) — `reapStaleEpicTeams` walks spawned epic-teams + classifies by cage liveness: **dead-cage orphan → auto-reap** (`performDissolveEpic`); **live-but-idle → escalate** (never auto-kill); **live+active → skip**. Dep-injected with fail-closed safe defaults (`listSpawnedEpicTeams → []`, `isCageAlive → true`). Closes the spawn-without-reap asymmetry (spawn is automatic; reap was happy-path-only).
- **Epic-cage socket resolution fix** ([ADR-251](docs/adr/251-epic-cage-socket-resolution.md), `src/core/dissolve-epic.ts::defaultCageTeardown`) — resolve the cage socket via `resolveTeamSocket(childTeam)` (authoritative `tmuxTmpdir`) instead of `resolveCageSocket(epicId, root)`, which guessed `/tmp/atmux-<epicId>/sock` and reported **live** epic cages as dead. The latent teardown bug skipped `killSession` on a live cage then pruned its worktree + cockpit entry → orphaned zombie (a leak source). Verified against 3 known-live sopx cages that the wrong resolver mis-reported dead.
- **`atmux orchd --reap-stale [--team-dir <p>] [--dry-run]`** ([ADR-250](docs/adr/250-orchd-stale-epic-reaper.md) §D2, `src/verbs/orchd.ts` + `src/core/orchd-reap-enum.ts`) — wires the reaper's production enumerator (cockpit `sessions[]` walk for the team's epic-teams) + liveness probe (`tmuxTmpdir` → `resolveTeamSocket` → `has-session`, exact-match `=`, fail-closed on unknown socket / probe error per ADR-251). `--dry-run` classifies + prints the verdict without acting — the safe pass an operator runs before any destructive reap. Dead-cage reap inherits `performDissolveEpic`'s driver-scope gate + skip-on-dirty refuse (never force-prunes). Live-idle auto-kill stays gated off (ADR-250 §D1). Validated live: sopx 5 considered (4 live-active, 1 dead-cage orphan), unum 3 + mx 2 all live, errors=0.
- **Live-epic-children removal guard** ([ADR-252](docs/adr/252-epic-cage-children-removal-guard.md), `src/core/epic-cage-children.ts` + `src/core/groom.ts`, P0 t-65bec10b) — `hasLiveEpicChildren(parentTmpdir)` lists `<parentTmpdir>/epics/*`, probes each child cage socket (`<parentTmpdir>/epics/<epicId>/tmux-<uid>/default`, the ADR-251 scheme) via `listSessions().length > 0`, and returns `true` on any live child. **Fail-SAFE** — on listing/probe uncertainty it returns `true` (refuse removal), mirroring the ADR-250 reaper's fail-closed-to-ALIVE in the same safety direction (never destroy on uncertainty); an absent `epics/` dir is the definitive no-children `false`. Wired into `sweepZombieTmuxSockets` BEFORE its `rm -rf`: a parent tmpdir hosting a live epic cage is SKIPPED (no kill, no rm) and counted in the new `ZombieSweepResult.skippedLiveChildren`. Structural prevention of the 2026-05-17 class where a parent-socket-dead probe wholesale-wiped `/tmp/atmux-<parent>/` and orphaned its live epic children (exact culprit not in-tree today — older path / operator dotfiles; this guards the CLASS on any current/future removal path).

### 📐 Architecture alignment — orchd + Honker is the runtime; cockpit roles trimmed (2026-05-24)

Codebase-wide alignment pass after the orchd / Honker session shipped 7 epics:

- **`atmux-orchd` (Rust, `rust/atmux-orchd/`) is the per-team runtime** with 10 in-process event consumers + 4 tickers (5min sweep-merges · 15min context-scan + budget-scan · hourly log-rotate · 24h housekeep). Replaces the legacy cron-fired sweep cadences. atmux NEVER writes to crontab per [ADR-233](docs/adr/233-cron-auto-install-disabled-trust-orchd.md); the source-side cron-install path was retired in commit `8e052e9`, with no-op shims at `src/abstractions/crontab.ts` / `src/core/cron.ts` / `src/verbs/cron-{install,remove}.ts` / `src/core/cursor-recipes/fix-cron-pollution.ts` kept for build-compile until importers migrate (commit `374ca7a`).
- **Honker = in-DB messaging substrate** per [ADR-202](docs/adr/202-honker-in-db-messaging-substrate.md) + [ADR-203](docs/adr/203-event-topic-taxonomy.md). `emit(db, payload)` in `src/abstractions/events.ts` auto-detects honker-loaded state per the ADR-202 §Amendment 2026-05-24. Rust orchd dispatches via Bun `--handle-one --consumer-id <id> --topic <t>` per event; consumers register at `bootstrapOrchd` in `src/core/orchd-bootstrap.ts` (currently 10 entries).
- **Cockpit roles trimmed (lead-gated retirements):**
  - **Sentinel retired** per [ADR-211](docs/adr/211-retire-sentinel-role-distribute-to-honker-consumers.md) — orchd consumers absorb observation.
  - **Medic retirement planned but NOT executed** per [ADR-212](docs/adr/212-retire-medic-lead-gated-rotation-simplify-honker-consumer-set.md) — correction: an earlier revision of this entry claimed "Medic narrowed to on-demand `atmux medic diagnose <team>`"; that code was never implemented (`src/verbs/medic.ts` does not exist). Actual state: the `_medic` cockpit window + `medic` cockpit.json block + `autoStartSuperdoctorLoop` remain live and unchanged; only the `atmux:rotation-consumer` event flow (`member.context-high` → tell-lead) shipped. The ADR-212 cutover awaits its §D5 gate (corrected here per ADR-266 §D5 doc-drift fix).
  - **Jury retired** per [ADR-213](docs/adr/213-retire-jury-reviewer-absorbs-acceptance-criteria.md) — reviewer absorbs Acceptance-Criteria verification.
  - **Ombudsman retired** per [ADR-214](docs/adr/214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md) — `complaint.filed` → consumer → `tell-lead` → lead.
  - Retired roles continue running as the safety net until the cleanup-EPIC cutover (≥30 days after `e-honker-observation-watchdogs` ships stable per ADR-212 §D5 / ADR-213 §D5 / ADR-214 §D7).
- **New consumers shipped this session:**
  - `atmux:complaint-consumer` (ADR-214 / e-92b8fa97, commit `079098c`) — wires `complaint.filed` → tell-lead.
  - `atmux:rotation-consumer` (ADR-212 / e-cc3728bf, commit `89ebbc5`) — wires `member.context-high` → tell-lead.
- **New orchd subverbs shipped this session:**
  - `atmux orchd --sweep-merges` (e-11-446429c9, commit `dab3935`) — 5-min in-process backfill sweep.
  - `atmux orchd --scan-context` (e-13-04c8b3bf, commit `72896a6`) — emits `member.context-high`.
  - `atmux orchd --scan-budget` (e-14-0f156732, commit `e70ba9e`) — 15min consolidated band-warning + refresh-soon dedup.
  - `atmux orchd --housekeep` (e-12-640853f3 §S4, commit `8980a3f`) — 24h events / offsets / logs / merger_state prune.
- **Cross-cuts:** doc-side alignment notes added to `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/medic.md`, `docs/RUNBOOK-stall-recovery.md`, `docs/RUNBOOK-team-of-teams.md`. Stale `cron-fired` / `Cron-fired` source-comment heads on `src/verbs/lane-stall-tick.ts`, `src/verbs/lane-drift-check.ts`, `src/verbs/discorder.ts`, `src/core/discorder.ts`, `src/core/queued-text-resubmit.ts`, `src/core/groom-archive.ts` re-pointed to orchd / operator-on-demand. `checkCronBlock` doctor probe in `src/verbs/doctor.ts` re-framed as legacy opt-in (zero cron blocks is now the canonical post-ADR-233 state). Cron-shim files NOT removed — load-bearing for build until importers (`src/verbs/{cockpit,topo-io,stop,team-rename,team-repair-rename,doctor,poke,start}.ts` + `src/core/{soft-stop,topo-aggregate,orchd-housekeep,orchd-merge-sweep}.ts`) migrate; that's its own cleanup-EPIC.

### ✨ Added — `resolveTmuxBin()` 3-tier resolver + `vendored-tmux-binary` doctor probe (ADR-191, e-162046c7)

First half of the vendored-tmux ship — the source-side resolution chain lands before the build-side install pipeline so the runtime is ready for the binary the moment `build:install` learns to ship it.

- **Resolver helper**: new `src/core/resolve-tmux-bin.ts::resolveTmuxBin()` walks `ATMUX_TMUX_BIN` (operator override) → `/opt/atmux/current/bin/tmux` (vendored) → system `tmux` on PATH (warn-once on fallback). Per-process memoization avoids re-probing the filesystem on every tmux spawn; the warn-once dedup keeps the fallback message out of high-frequency call paths. Injectable env / existsSync / warn / state seams mirror `resolveDefaultListenerBinary` for test parity. 100% line + func coverage in `tests/unit/core/resolve-tmux-bin.test.ts`.
- **Call-site migration**: every `cmd: "tmux"` literal in production code routed through `resolveTmuxBin()` — `src/abstractions/tmux.ts` (3 spawn primitives), `src/abstractions/fallback-cage.ts` (Tier-3+ sudo spawn + capture-pane + kill-session), `src/verbs/poke.ts` (paste-buffer load/paste), `src/verbs/doctor.ts` (tmux-version probe family), `src/core/cursor-recipes/fix-supervisor-missing.ts` (list-windows detect).
- **Doctor probe** `checkVendoredTmuxBinary` (src/verbs/doctor.ts): yellow row `vendored-tmux-missing` when `/opt/atmux/current/bin/tmux` is absent (operators see the fallback signal explicitly) + `vendored-tmux-version-drift` when present-but-not-3.6a. Self-clearing post-install. 7 unit tests cover all branches.
- **Operator-facing**: `ATMUX_TMUX_BIN` documented in README §Configuration. Build:install pipeline extension (DoD #1) lands separately — gated on operator/driver authorization since it sudo-touches `/opt/atmux/` on live deploys.

Cross-refs: [ADR-191](docs/adr/191-vendored-tmux-binary.md) §Implementation status (this commit), [ADR-162](docs/adr/162-atmux-owns-tmux-infrastructure.md) (complementary tmux-infra ownership), [ADR-163](docs/adr/163-bundled-tmux-binary.md) (pin reference).
### ✨ Added — orchd Phase 2: auto-spawn loop + solo-worker auto-dissolve ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md), EPIC `e-60e16169` Story S3, t-18-b2ca7178)

orchd Phase 2 wires three handlers on top of Phase 1's subscription seam ([ADR-224 §D6](docs/adr/224-orchd-rename-and-auto-spawn-loop.md)):

- **spawn handler** subscribes to `epic.ready` + `epic.unblocked` (NOT `epic.added` — avoids eligibility-refusal burn); spawns the epic-team when `autoSpawn=true` AND `epicIsEligible` ([ADR-225](docs/adr/225-epic-dependencies-and-is-ready-toggle.md)) AND `spawned_at IS NULL`. Registers twice with distinct consumerIds (`atmux:orchd:spawn:on-ready` / `:on-unblocked`) so per-topic Honker offsets stay independent.
- **solo-worker dissolve handler** subscribes to `task.done`; dissolves solo-worker teams ([ADR-221 §Phase 2](docs/adr/221-solo-worker-scope.md) close-out) when their only owned task transitions to `done`. Shares the `task.done` topic with auto-merge (ADR-226) — distinct consumerIds isolate offsets.
- **`--sweep` cron backstop** (default `*/5 * * * *`, configurable via `team.json::autoSpawn.sweepCron`) walks eligible epics + solo-workers; reuses canonical handlers per ADR-231 §D4 (NOT duplicate logic).

Per-epic config home: `epics.extra.autoSpawn = { enabled: boolean, roster?: string, forceSpawn?: boolean }`. Set via `atmux epic add --auto-spawn / --no-auto-spawn / --roster <r> / --force-spawn` flags. Per-team policy: `team.json::autoSpawn.defaults[]` regex-match against `epic.title`; per-epic explicit wins. Default: off.

3-way failure classification per ADR-231 §D5: **hard** (flag p1 + `extra.spawnFailed` receipt + NO retry); **host-pressure transient** (counter on `extra.spawnPressureDeferred`; ≥3 → distinct `host-pressure-deferred` flag p1 — operator triages "wait for capacity" separately from "fix config"); **eligibility-race** (silent — next `epic.ready` / `epic.unblocked` event re-fires the handler).

Phase 2 ships behind opt-in (autoSpawn default off) — no existing epic gets auto-spawned without explicit per-epic OR per-team opt-in. Operators continue running `atmux team spawn-epic` manually where autoSpawn=false. Rollback: drop entries from `ORCHD_SUBSCRIPTIONS` + restart orchd → relay-only behaviour; `epics.spawned_at` column stays in place (additive migration per [ADR-126](docs/adr/126-sqlite-state-store.md)).

Per-Task ship trail (each linked below): t-6 (v15→v16 migration, dedup column), t-7 (Zod KanbanEpic.extra.autoSpawn sub-shape), t-8 (Zod team.json autoSpawn.defaults[] + sweepCron), t-9 (epic add CLI flags), t-10 (sweep walker scaffold), t-11 (`atmux orchd --sweep` subverb), t-12 (cron sandwich-marker line), t-13 (failure classifier), t-14 (spawn handler), t-15 (solo-worker dissolve handler), t-16 (S3.1 unit-test scaffolding), t-17 (S3.2 integration trigger matrix), t-18 (this docs sweep).

### ✨ Added — `epics.spawned_at` v15→v16 SQLite migration ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D2 + §D7, EPIC `e-60e16169` Phase 2 Story S1, t-6-8db78adf)

`ALTER TABLE epics ADD COLUMN spawned_at INTEGER` — the canonical dedup gate column read by `spawnEpicHandler` (§D2 step 2) so re-delivered events under at-least-once semantics short-circuit instead of double-spawning. Sequenced AFTER ADR-228 spawn_queue v14→v15 (sibling EPIC e-a946af69 fan-in 8d75360) per the single-ladder append-only invariant of [ADR-126](docs/adr/126-sqlite-state-store.md) — renumbered from the original v14→v15 at impl time. NULL = "never spawned"; positive integer = Unix-epoch seconds set on orchd spawn-success. Additive only; rollback is a no-op (handler skips on Phase 2 disable).

### ✨ Added — Zod `KanbanEpic.extra.autoSpawn` + `spawnedAt` sub-shape ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D2 + §D3, EPIC `e-60e16169` Phase 2 Story S1, t-7-0ad1dfe3)

Extends `src/schema/kanban.ts` `KanbanEpic` with the per-epic orchd auto-spawn config home + the dedup-gate timestamp mirror. `extra.autoSpawn = { enabled: boolean, roster?: string, forceSpawn?: boolean }` types the typed sub-shape inside the `extra` passthrough slot; outer `extra` stays `.passthrough()` for forward-compat sibling keys. Top-level `spawnedAt: z.number().int().nullable().optional()` mirrors the SQLite column from t-6's migration. 7 new schema tests; 100% line + funcs coverage on the kanban schema.

### ✨ Added — `orchdSweep` walker scaffold + handler-reuse seam ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D4, EPIC `e-60e16169` Phase 2 Story S2, t-10-ab3815cf)

`src/core/orchd-sweep.ts::orchdSweep(atmuxDir, deps)` — one-shot walker matching ADR-231 §D4's two-trigger model (event-driven primary via Honker subscriptions + cron-backstop secondary via this walker). Cheap pre-filter: `spawned_at IS NOT NULL` skip (§D2 dedup) → `effectiveAutoSpawn(epic) === false` skip (§D3) → `epicIsEligible().eligible === false` skip (ADR-225). Survivors hit the canonical `spawnEpicHandler` (NOT a re-implementation — invariant per the AC). Solo-worker walk reuses `dissolveSoloWorkerHandler` per epic team. Returns `{epicsConsidered, epicsSpawned, workersConsidered, workersDissolved}` counters surfacing walker observations + handler verdicts independently. Test-injection seam `OrchdSweepDeps` pins each surface for deterministic counter assertions.

### ✨ Added — orchd Phase 2 unit-test scaffolding harness ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md), EPIC `e-60e16169` Phase 2 Story S3, t-16-27fdc08b)

Four reusable test fixtures under `tests/helpers/` consumed by the Phase 2 handler unit tests (t-14 / t-15) and the integration trigger-matrix test (t-17):

- `honker-mock.ts` — `HonkerMock` registers `OrchdSubscription` entries, publishes synthetic events, drains per-consumer with at-least-once semantics (offset advances ONLY on handler-success; throw → next drain re-delivers). Matches the real Honker subscription contract pinned by `src/core/orchd-registry.ts` (consumerId-based offsets, multi-handler-per-topic support).
- `kanban-fixtures.ts` — `seedEpic({...})` + `seedTask({...})` builders round-trip through the real `KanbanEpic` / `KanbanTask` Zod schemas. `autoSpawn` rides under `extra.autoSpawn` (ADR-231 §D3 shape, t-7); `spawnedAt` at top level (ADR-231 §D2 dedup column, t-6). No test-only field shapes.
- `spawn-epic-subprocess-stub.ts` — `createSpawnEpicStub()` intercepts `atmux team spawn-epic` invocations; default `SUCCESS_RESULT` (exit 0); polls to `HOST_PRESSURE_RESULT` / `ELIGIBILITY_RACE_RESULT` / `HARD_FAILURE_RESULT` with canonical stderr fixtures matching the t-13 classifier regexes verbatim. `setResultSequence()` for transient-then-success scenarios. Records every invocation in call order.
- `atmux-flag-spy.ts` — `createFlagSpy()` captures `atmux flag add` calls with message + severity + needs + taskId. `findByMessage` (string / RegExp) for assertion against §D5 hard-failure + host-pressure-deferred flag paths.

20 smoke tests verify each helper works in isolation under bun:test; 100% line coverage on the consumed schema surface.

### ✨ Added — orchd Phase 2 integration trigger-matrix test ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md), EPIC `e-60e16169` Phase 2 Story S3, t-17-d41f607f)

End-to-end integration coverage of the Phase 2 surface at `tests/integration/orchd-phase2-trigger-matrix.test.ts` — drives the full path Honker event (via `HonkerMock`) → production handler (`createSpawnEpicHandler` / `createDissolveSoloWorkerHandler` / `orchdSweep`) → SQLite mutation (`spawned_at`, `extra.spawnFailed`, `extra.spawnPressureDeferred`) → `atmux flag add` emission (via `FlagSpy`). Wires the S3.1 scaffolding (t-16) through a shared spawn router that dispatches `atmux team spawn-epic` → SpawnEpicStub, `atmux team dissolve-worker` → inline DissolveStub, `atmux flag add` → FlagSpy; an `unrouted` channel captures argv shapes the router doesn't recognise (regression guard for future subprocess additions).

Per-scenario isolation: fresh in-memory SQLite + migrations + stub/spy instances per `beforeEach`. atmuxDir is a sentinel `mkdtemp` path; `listEpics` + `epicIsEligible` are dep-injected so nothing touches the host's real `.atmux/`. 21 tests / 96 assertions cover the 7 AC scenarios (event-only success, cron-only success, both-fire dedup, eligibility-race classifier, host-pressure deferred ≥3, hard failure, solo-worker dissolve) plus handler-level dedup, silent-skip branches (row-missing / autoSpawn-off / pre-spawn eligibility-held), forceSpawn bypass, spawn-throws hard-flag path, dissolve silent-skip (task-missing / non-solo / pending-work), and cross-class invariants confirming canonical stderr fixtures stay in sync with the t-13 classifier regexes. Coverage: spawn handler 90% lines, dissolve handler 68%, classifier 100%.

### ✨ Added — orchd auto-spawn handler + effectiveAutoSpawn resolver ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D2 + §D3, EPIC `e-60e16169` Phase 2 Story S2, t-14-c27cdce1)

New `src/core/orchd-spawn.ts` exports `createSpawnEpicHandler` + `effectiveAutoSpawn`. Implements the ADR-231 §D2 5-step algorithm: (1) load epic + row-missing skip; (2) `spawned_at IS NOT NULL` dedup gate; (3) `effectiveAutoSpawn(epic, team)` opt-in gate; (4) ADR-225 `epicIsEligible` predicate gate (bypassed by `forceSpawn=true`); (5) `atmux team spawn-epic <epicId> --from <parentTeam> [--roster X] [--force-spawn]` subprocess with 3-way result classification via `classifySpawnFailure` (t-13): exit 0 → stamp `spawned_at = unixepoch()`; hard → write `extra.spawnFailed = {at, stderrTail}` + `atmux flag add --severity p1 --needs unblock` + NO retry; host-pressure → increment `extra.spawnPressureDeferred`; emit `host-pressure-deferred` flag at ≥3; cron `--sweep` retries; eligibility-race → silent skip (next event re-fires).

`effectiveAutoSpawn(epic, team)` implements §D3 precedence: per-epic explicit `extra.autoSpawn.enabled` (true OR false) wins → per-team `team.json::autoSpawn.defaults[]` first-match (regex tested against `epic.title`) → default off. Pure helper — no I/O, exported for the cron `--sweep` walker to consume (T-S2.1 stub replaceable).

Wired into `src/core/orchd-bootstrap.ts`: TWO new subscriptions register on the same handler factory — `atmux:orchd:spawn:on-ready` (topic `epic.ready`) + `atmux:orchd:spawn:on-unblocked` (topic `epic.unblocked`). Per-topic consumerIds keep Honker offsets independent so a backlog on one topic doesn't shadow the other. `BootstrapOrchdDeps.spawnDeps` is the wire-up seam; absent → factory builds a stub returning `skipped-row-missing` (safe no-op pre-wire). Committer.ts `--drain` injection passes `{atmuxDir, team}` for the production path.

Adjacent infrastructure fix: `src/core/repositories/kanban-repo.ts` extended to surface the `spawned_at` column (added in t-6's v15→v16 migration but missed from `EpicRow` + `epicFromRow` + `epicToRow` + `upsertEpic` SQL — `getEpic` would return `spawnedAt: undefined` defeating the §D2 step-2 dedup gate). Now read-write round-trips correctly; `KNOWN_EPIC_FIELDS` gains `spawnedAt` so it's NOT folded into `extra`.

23 new unit tests at `tests/unit/core/orchd-spawn.test.ts` cover the full §D2 branch matrix (9 §D2 outcomes incl. spawn-throw + forceSpawn-bypasses-eligibility), §D3 precedence (per-epic-true wins, per-epic-false wins, per-team first-match, per-team second-entry, no-match-off, team-absent, empty-title, invalid-regex-graceful), and idempotency on re-delivery. 2 new bootstrap tests pin the 6-subscription canonical order + distinct spawn-handler consumerIds (was 4, +2 for spawn:on-ready + spawn:on-unblocked). 100% line coverage on the new handler module.

### ✨ Added — `atmux orchd --sweep` cron-line emit ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D4, EPIC `e-60e16169` Phase 2 Story S2, t-12-f4c1becb)

The team-cron sandwich-marker block ([ADR-026](docs/adr/026-tmux-session-and-cron-lifecycle.md) + [ADR-192](docs/adr/192-cron-arm-idempotency-contract.md)) now emits one new always-on line — `<cadence> atmux orchd --sweep` — between the existing `orchd --drain` and `epic-merge tick` lines. Wires the cron-backstop half of ADR-231's two-trigger model (event-driven primary via Honker `epic.ready` / `epic.unblocked` subscriptions; cron backstop for socket churn / NOTIFY gaps / orchd restart-induced wake loss). Cadence resolves from `team.json::autoSpawn.sweepCron` (schema-loose-validated 5-field cron string, t-8-3328eb57) with default `'*/5 * * * *'` — both standard `*/N` patterns and richer non-divisor expressions (`7,37 9-17 * * 1-5`) pass through verbatim since the cron line bypasses the divisor-restricted `cronEvery()` helper. `atmux start` writes the new line; `atmux stop` removes it via existing sandwich-marker semantics (no new cleanup code). 7 new unit tests at `tests/unit/core/cron.test.ts`: default cadence, sweepCron override, non-divisor patterns, fallback-without-sweepCron, env-prefix parity, renderCronBlock containment, ADR-192 idempotence. Golden file regenerated (`tests/golden/cron-block.txt`), `orderedVerbs` pin updated.

### ✨ Added — `atmux orchd --sweep` CLI subverb ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D4, EPIC `e-60e16169` Phase 2 Story S2, t-11-84fced39)

One-shot cron-backstop walker subverb on the `atmux orchd` CLI. Wraps `orchdSweep(atmuxDir)` from `src/core/orchd-sweep.ts` (sibling t-10) and prints the `{epicsConsidered, epicsSpawned, workersConsidered, workersDissolved}` counters JSON to stdout per ADR-231 §D4 cron-line + Discord summarization needs (T-S2.3). `--sweep` and the bare positional `sweep` both parse; `--once` reuses the existing flag (consistent with `--drain`). Exit code 0 on any clean sweep (counter values are walker observations, not failure conditions); non-zero only on unrecoverable setup throws (atmuxDir unresolvable, etc.) — the walker itself swallows per-handler errors per its own contract. 6 new unit tests at `tests/unit/verbs/orchd.test.ts` cover parser (`--sweep`, `sweep`, `--team-dir`, `--once`, last-wins-on-mixed-subverb) and dispatch routing (orchdSweep invoked with resolved atmuxDir, counters JSON written to stdout) via `bun:test`'s `mock.module` seam.

### 🟢 Fixed — orchd cross-cage dispatcher seams (ADR-232 §D2.a + c477954 wire-up regression, t-20-91595e35 + t-21-8c0b2bfd)

Sweep across all three dispatchers (`epic-merge`, `dissolve-epic`, `git-push`) to add the [ADR-232 §D2.a](docs/adr/232-orchd-cross-cage-dispatcher-seam.md) routing-semantics guards + heal the c477954 wire-up regression that reviewer flagged. Two-part fix:

- **c477954 typecheck regression — 10 errors cleared in `src/core/orchd-dispatch/epic-merge.ts` + paired tests.** Dropped `DispatchEpicMergeResultSchema.parse(...)` wrapping on returns — output type was already enforced by the function return type, and the Zod parse adds `| undefined` to optional fields under `exactOptionalPropertyTypes:true` (5 src errors). Tests refactored to use a captured-object pattern (`const captured: {epicId?: string; cage?: CageInfo} = {}`) instead of `let x: T | null = null` closure mutation — Bun's TS narrowing collapses the latter to `null` literal at assertion sites (4 test errors). Removed the unused `@ts-expect-error` directive at the empty-string input boundary (the value is TS-valid but Zod-invalid; refine reject at runtime, no TS error to suppress).
- **c477954 wire-up gap — `committer.ts:450` now injects `localTeamName: ctx.team.name`.** The default `resolveCage` still returns `null` (real cage-registry walker deferred), but the dispatcher's cage-not-found path is now QUIET — `skipped-not-mine` without `flag-add`. Pre-fix the dispatcher flag-spammed on every `task.done` event (because every invocation hit the unwired-resolveCage path), which was actively WORSE than the pre-c477954 silent-stub default. Regression-pinned at `tests/unit/core/orchd-dispatch/epic-merge.test.ts::"default resolveCage (unwired) → quiet skipped-not-mine on every event"`.
- **ADR-232 §D2.a anti-pattern guard added to `dispatchEpicMerge` + `dispatchDissolveEpic`.** Refuses `targetCage` values matching the epicId shape `/^e-\d+-[0-9a-f]+$/` at the dispatcher boundary — catches the e874291-flagged anti-pattern of aliasing an epicId as a cage name. Returns `{state: "gate-held", reason: "...looks like an epic id..."}` (epic-merge) or `{state: "skipped-not-mine", reason: "..."}` (dissolve-epic) with explainers pointing to ADR-232 §D2.a so the operator immediately sees the intent. `dispatchGitPush` already takes `cage: string` (no `epicId` field) so it's structurally compliant without a new guard.
- **ADR-232 §D2.a local-cage-skip guard added to `dispatchEpicMerge`.** When `cage.name === localTeamName`, dispatcher returns `{state: "skipped-not-mine", reason: "local-cage-already-owns..."}` immediately — prevents the self-dispatch loop the amendment forbids (the in-cage `atmux epic-merge tick` cron path is the canonical local invocation point per ADR-091; dispatcher's job is parent → child fan-out only). `dispatchDissolveEpic` + `dispatchGitPush` retain the existing local-fire semantic because they're the canonical impl invocation (no separate in-cage handler pre-fires) — noted in a per-dispatcher code comment so the reviewer sees the deliberate distinction.

Test surface: 39 epic-merge tests (added §D2.a + cage-not-found regression coverage), 19+2 dissolve-epic tests (added anti-pattern + legitimate-cage-name §D2.a coverage). 100% line + funcs coverage on `src/core/orchd-dispatch/epic-merge.ts`. Typecheck globally green post fan-in with fe-2's tests/helpers fix at 5282fdc.

### ✨ Added — `atmux epic add` auto-spawn CLI flags ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D3, EPIC `e-60e16169` Phase 2 Story S1, t-9-1060b4c7)

Four new flags on `atmux epic add` populate the per-epic `extra.autoSpawn` Zod sub-shape landed in t-7-0ad1dfe3 (KanbanEpic schema, ADR-231 §D3 §Schema):

| Flag | Effect |
|---|---|
| `--auto-spawn` | sets `extra.autoSpawn.enabled = true` (orchd will spawn this epic-team automatically once ADR-225's eligibility predicate flips) |
| `--no-auto-spawn` | sets `extra.autoSpawn.enabled = false` (explicit opt-out — overrides per-team defaults match in T-S1.3) |
| `--roster <name>` | sets `extra.autoSpawn.roster = <name>` (e.g. `solo`, `backend-heavy`); requires `--auto-spawn` |
| `--force-spawn` | sets `extra.autoSpawn.forceSpawn = true` (passes `--force` to `atmux team spawn-epic` — bypasses ADR-225's eligibility predicate); requires `--auto-spawn` |

Mutex enforcement at parse time (caller sees the error before any DB write):
- `--no-auto-spawn` + `--force-spawn` → UsageError (mutually exclusive — `--no-auto-spawn` opts OUT of orchd spawn, `--force-spawn` opts IN bypassing predicates).
- `--roster` without `--auto-spawn` → UsageError (roster picks the member set orchd spawns; with auto-spawn off it has no effect).
- `--force-spawn` without `--auto-spawn` → UsageError (force only affects the orchd-driven spawn path).

No flags → no `autoSpawn` key written; epic falls back to per-team defaults match (T-S1.3) OR off.

Wire-up: `parseAddArgs` captures the flags + does the mutex walk; `epicAdd` plumbs through `AddEpicOpts.autoSpawn`; `addEpic` (src/core/epic.ts) folds the sub-shape into the inserted row's `extra.autoSpawn` slot. Round-trip through the kanban-repo's JSON-extra spillover bag stays forward-compatible with future per-epic config classes via `extra.passthrough()`.

Tests: 11 new cases at `tests/unit/verbs/epic.test.ts` — 6 pure-parse (single flags, combo, no-flags-undefined) + 5 mutex-error + 1 missing-value + 5 verb-dispatch round-trip (CLI → showEpic readout). 80/80 epic tests green; 93.75% func / 87.48% line coverage on `src/verbs/epic.ts`.

Out of scope (separate Tasks):
- `team.json::autoSpawn.defaults[]` per-team fallback (T-S1.3 — already shipped per CHANGELOG entry below).
- spawn-handler read-side that consults `extra.autoSpawn.enabled` + `spawnedAt IS NULL` (T-S2.5).

### ✨ Added — `dissolveSoloWorkerHandler` + `isSoloWorkerTeamName` orchd auto-dissolve for solo workers ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D6 + [ADR-221](docs/adr/221-solo-worker-scope.md) §Phase 2, EPIC `e-60e16169` Phase 2 Story S2, t-15-6a65eadb)

Closes ADR-221 §Phase 2 auto-dissolve. New `src/core/orchd-dissolve-solo-worker.ts` exports `dissolveSoloWorkerHandler` (created via `createDissolveSoloWorkerHandler({db, …})`) + `orchdDissolveSoloWorkerConsume` (consumer surface mirroring `orchd-merge.ts` + `orchd-dissolve.ts` so operators learn one factory shape). Subscribes to `task.done` with consumerId `atmux:orchd:dissolve-solo-worker` — distinct from parent's `atmux:orchd:auto-merge` (same topic, isolated by Honker per-consumer offsets per ADR-202 §VIII).

Algorithm per ADR-231 §D6:
1. Load task row defensively (race-deleted → `skipped-task-missing`).
2. Classify owning team via `isSoloWorkerTeamName` (`team.name.startsWith("w-")` per ADR-221 §v2 line 72) — exported separately from `src/core/solo-worker.ts` so future tooling (status display, complaint adjudicator) reuses one canonical predicate.
3. Enumerate the owning member's remaining open tasks — any pending → `skipped-pending-work`.
4. Spawn `atmux team dissolve-worker <event.team>` — exit-0 → `dissolved`; non-zero or spawn-throw → `escalated` + `atmux flag add --severity p1 --needs unblock` with stderr tail (≤500 chars) in body. NO retry per ADR-231 anti-retry-storm doctrine.

Bootstrap wire-up at `src/core/orchd-bootstrap.ts` registers the new subscription alongside the three existing (merge / dissolve / push); `BootstrapOrchdDeps.dissolveSoloWorkerDeps` is the test/operator override seam. 19 unit tests cover all 5 outcomes (incl. happy-path + 4 skip variants + escalated with stderr/stdout/throw/swallow-on-flag-fail), idempotency on re-delivery, and the consumer-surface (Honker kill-switch, default handler, escalated counter, custom consumerName). Bootstrap tests updated to expect 4 subscriptions (was 3) — including a regression check that `dissolve-solo-worker` shares `task.done` with auto-merge but has a distinct consumerId.

ADR-231 §D6 + §D7 amended same-commit: §D6 step 4 corrected (`atmux team stop --team <name>` → `atmux team dissolve-worker <id>`; the original verb form doesn't exist in the codebase, per ADR-221 §v2 line 68 which always intended `dissolve-worker` for auto-dissolve); §D7 file-layout row renamed (`orchd-dissolve.ts` → `orchd-dissolve-solo-worker.ts` — sibling EPIC `e-a946af69` fan-in 8d75360 already shipped Phase 4 epic-team auto-dissolve at the original path, so this handler takes the `-solo-worker` suffix to avoid collision). 100% line + funcs coverage on the new handler module + classifier.

### ✨ Added — `classifySpawnFailure` orchd spawn-epic recovery classifier ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D5 + [ADR-184](docs/adr/184-host-wide-epic-team-cap-queue-and-dormancy-audit.md), EPIC `e-60e16169` Phase 2 Story S2, t-13-2f8b0d92)

New pure helper `src/core/orchd-spawn-classify.ts` exports `classifySpawnFailure(stderr): 'hard' | 'host-pressure' | 'eligibility-race'` — the 3-way result classifier the spawn handler (T-S2.5) consumes to decide recovery posture per ADR-231 §D5:

- `host-pressure` (`/host-wide cap \(\d+\) reached/`) — ADR-184 refusal signature; handler increments `spawnPressureDeferred` and lets cron `--sweep` retry.
- `eligibility-race` (`/eligible=false: /`) — ADR-225 predicate refusal signature; handler exits silently and the next `epic.ready` / `epic.unblocked` event re-fires.
- `hard` (default) — any other non-zero exit; handler writes `epics.extra.spawnFailed` + raises `atmux flag add` + NO retry per ADR-231 anti-retry-storm rationale.

Precedence: when BOTH transient signatures appear in the same stderr blob, host-pressure wins — the more severe operator signal, and the safer fallback when ambiguous (capacity exhaustion ought to surface louder than predicate refusal). Whitespace-tolerant between `host-wide`, `cap`, and the digit group so spawn-epic wrapper formatting drift doesn't silently degrade to `hard`. 16 unit tests cover each class, partial-match boundary cases, empty stderr, multiline blob, and the precedence ordering in both orders. 100% line + funcs coverage on the new module.

### ✨ Added — `team.json::autoSpawn` Zod schema ([ADR-231](docs/adr/231-orchd-auto-spawn-and-solo-worker-dissolve.md) §D3 + §D4, EPIC `e-60e16169` Phase 2 Story S1, t-8-3328eb57)

New optional `autoSpawn` block on the top-level Team schema (`src/schema/team.ts`) — config home for orchd's `spawn-epic` handler per ADR-231 §D3:

- `defaults[]` — first-match-wins routing table; each entry is `{ match: string (regex source, validated via `new RegExp(match)` in a `z.string().refine` so unparseable patterns are caught at schema-parse time), roster: string, autoSpawn: literal true (typo-catch for opt-out-by-mistake), forceSpawn?: boolean }`. Per-epic explicit `extra.autoSpawn.enabled` always wins per ADR-231 §D3 resolution precedence; this array is the operator's fallback "anything matching X gets auto-spawned with roster Y".
- `sweepCron` — operator override for the `atmux orchd --sweep` cadence (ADR-231 §D4 OQ-C). Default `*/5 * * * *` is applied at the cron-emission site, NOT here — schema validation is loose (5-field whitespace-separated string presence only) so misshapen cron strings surface at the sandwich-marker emission code's richer parser rather than refusing the whole team.json parse.

Resolution-precedence logic (per-epic explicit > per-team defaults[] first-match > off) lives in `effectiveAutoSpawn()` (out of scope here — Task T-S2.5). Per-epic `epics.extra.autoSpawn` Zod schema lives on the kanban side (out of scope here).

20 new unit tests at `tests/unit/schema/team.test.ts` cover: entry-shape (well-formed, optional forceSpawn, invalid regex, autoSpawn-false typo-catch, empty match/roster, strict unknown-keys); block-shape (empty, multi-entry order, sweepCron 5-field accept, 3-field reject, empty reject, whitespace-pollution reject, strict unknown-keys, invalid-entry-rejects-whole-block); Team-level integration (full-shape parse, back-compat absent, malformed regex via Team.parse, malformed cron via Team.parse, coexists with autoPush). 100% line + funcs coverage on `src/schema/team.ts`.

### 🔄 Changed — orchd auto-dissolve subscriber now routes through `dispatchDissolveEpic` + `dissolveEpic` factored into `src/core/` ([ADR-232](docs/adr/232-orchd-cross-cage-dispatcher-seam.md) §D1, EPIC `e-60e16169` Phase 2 Story S0, t-4-d75fb776)

Two-step landing:

- **Factor.** `dissolveEpic` body extracted from `src/verbs/team/dissolve-epic.ts` into `src/core/dissolve-epic.ts::performDissolveEpic({epicId, skipChecks, forcePrune}, opts)` so the cross-cage dispatcher invokes the same pipeline without re-walking argv. Same factoring pattern as `performEpicMerge` per ADR-091. The CLI verb file shrinks to a thin wrapper (~98 lines from ~613) that parses argv + delegates; helper exports (`defaultCageTeardown`, `deleteMergedEpicBranch`, `DissolveEpicOpts`) re-export through the verb file so existing test imports stay unmodified — no behavior change to `atmux team dissolve-epic` CLI verb (same exit code, same stdout shape, same `ConfigError` throws).
- **Wrap.** New `src/core/orchd-dispatch/dissolve-epic.ts` exports `dispatchDissolveEpic({ epicId, targetCage? })` — the cross-cage dispatcher seam consumed by parent's ADR-227 auto-dissolve subscriber. LOCAL route invokes `performDissolveEpic` directly with `callerScope: () => "driver"` injected per ADR-091 §state machine + ADR-227 §D1 (the orchd subscriber IS the legitimate driver). REMOTE route returns `{state: 'skipped-not-mine'}` per ADR-232 §D2 (v1 local-only; OQ-1 transport refinement deferred). Cage-not-found (targetCage absent from roster AND not local) raises `atmux flag add --severity p1` then returns `skipped-not-mine` so the subscriber advances the offset rather than retrying into a storm (ADR-232 OQ-3 + ADR-231 §D5). `performDissolveEpic` pre-flight refusals (open child tasks, dirty worktree, epic-team not in cockpit) → `{state: 'gate-held', reason}` so the subscriber emits `epic.dissolve-blocked` per ADR-227 §D6.

Wire-up at `src/verbs/committer.ts::committerDrainVerb` injects `dispatchDissolveEpic` into `bootstrapOrchd({ dissolveDeps })` alongside the sibling `dispatchEpicMerge` (mergeDeps) + `dispatchGitPush` (pushDeps) closures. Stubbed `skipped-not-mine` default stays at the handler-factory layer as the ADR-232 §D3 safety net under at-least-once delivery. Zod-validated input (`DispatchDissolveEpicInputSchema`); 11-test unit suite at `tests/unit/core/orchd-dispatch/dissolve-epic.test.ts` covers LOCAL success, ConfigError → gate-held mapping, non-ConfigError re-propagation, REMOTE-deferred, cage-not-found flag + skipped-not-mine, targetCage default to epicId, local-cage override beating roster mismatch. 6 new tests at `tests/unit/core/dissolve-epic.test.ts` cover the structured-input entry point (Zod schema, caller-scope gate, topology not-found, happy path); the 22 pre-factor verb tests at `tests/unit/verbs/team/dissolve-epic.test.ts` continue to pass against the factored module unmodified (no regression on tracked-paths coverage per CLAUDE.md).

### 🔄 Changed — orchd auto-merge subscriber now routes through `dispatchEpicMerge` ([ADR-232](docs/adr/232-orchd-cross-cage-dispatcher-seam.md), EPIC `e-60e16169` Phase 2 Story S0)

New `src/core/orchd-dispatch/epic-merge.ts` exports `dispatchEpicMerge({ epicId, targetCage? })` — the cross-cage dispatcher seam consumed by parent's ADR-226 auto-merge subscriber. LOCAL route invokes `performEpicMerge` directly (zero-RPC); REMOTE route emits a Bun-subprocess dispatch per ADR-202 §IX-A lean-dispatch contract (path A per ADR-232 §D2; OQ-1 transport refinement deferred). Cage-not-found and remote-dispatch failure paths surface `atmux flag add` with epicId + target cage + stderr tail in the body. Wire-up at `src/verbs/committer.ts` injects the dispatcher into `bootstrapOrchd({ mergeDeps })`, replacing the stubbed default that returned `skipped-not-mine` (the stub stays as ADR-232 §D3's safety net — the auto-merge handler's `skipped-not-mine` switch case is unchanged). Zod-validated input/output; 30-test unit suite at `tests/unit/core/orchd-dispatch/epic-merge.test.ts` covers local-route, remote-route, route-failure-flag, cage-not-found, default impls, and pure `mapLocalResult` mapping.

### ✨ Added — orchd Phase 3-5 lifecycle (EPIC `e-a946af69` close-out)

End-to-end automation of epic-team lifecycle via the orchd event-
router substrate. Three subscribers + spawn-queue land together,
flipping atmux's coordination spine from cron-polled to event-driven:

- **Phase 3 ([ADR-226](docs/adr/226-orchd-auto-merge-subscriber.md))** — `orchd-merge` consumer: `task.done` events fire `performEpicMerge` once an epic's last open task lands. Emits `epic.merged` on success or `epic.merge-blocked` on dispatcher gate-held / conflict. `ATMUX_HONKER` kill-switch + at-least-once `withIdempotency` wrapper.
- **Phase 4 ([ADR-227](docs/adr/227-orchd-auto-dissolve-subscriber.md))** — `orchd-dissolve` consumer: `epic.pushed` events fire `dissolve-epic` (cage teardown + branch prune + cockpit registry cleanup). Operator opt-out via `team.json::epicTeam.autoDissolve=false`. Trigger flipped from the original `epic.merged` to `epic.pushed` per ADR-227 §Amendment 2026-05-23 — prevents Phase 4 dissolving the cage before Phase 6 pushes the merge commit (forensics-preserving).
- **Phase 5a ([ADR-228 §D2](docs/adr/228-orchd-spawn-queue-pressure-monitor.md))** — `spawn_queue` SQLite table (v13→v14 migration) + `SpawnQueueRow` Zod schema + `SpawnQueueRepo` (CRUD + `dequeueHead` under `BEGIN IMMEDIATE`).
- **Phase 5b ([ADR-228 §D1 / §D4 / §D7](docs/adr/228-orchd-spawn-queue-pressure-monitor.md))** — `src/core/spawn-queue.ts` exports `admit` / `enqueueIfPressured` / `pressureMonitorTick` / `resolveSpawnQueueLimits`. `spawn-epic` verb refuses → enqueues by default (per §OQ3 HIGH-REV `queue-default` decision); `--no-queue` flag preserves the original throw-on-pressure semantics for one-shot scripts. orchd `--start` installs a `setInterval` drain loop firing every `pressureCheckIntervalSec` (default 60s; tunable via `ATMUX_SPAWN_QUEUE_TICK_SEC`).
- **Phase 6 ([ADR-229](docs/adr/229-orchd-auto-push-and-safety-gates.md))** — `orchd-push` consumer: `epic.merged` events fire `git push origin <parentBase>` through 7 safety gates (kill-switch, opt-in, staging-refuse, cooldown, working-tree-clean, force-push-refusal, typecheck) in cheapest-first fire order. Emits `epic.pushed` / `epic.push-blocked` / `epic.push-conflict`.
- **Wire-up ([ADR-224 §D6](docs/adr/224-orchd-multi-topic-event-router.md))** — `src/core/orchd-bootstrap.ts::bootstrapOrchd` registers all three subscribers against `ORCHD_SUBSCRIPTIONS`; `atmux orchd --drain` iterates the registry alongside the existing hardcoded `gitter` + `lane-router` consumers (single dispatch path per the driver P0 step 3/5 directive).

Topic taxonomy ([ADR-203 §D2](docs/adr/203-event-topic-taxonomy.md)) grew by 3 entries (47 → 50 in `TOPICS`): `epic.spawn-queued`, `epic.spawn-abandoned`, `epic.added`. Discriminated union + Zod payloads in `src/schema/events.ts`.

End-to-end dogfood (lifecycle + pressure-throttle) requires sibling EPIC `e-60e16169`'s dispatcher injection before any handler does work at the verb layer — until then, the registered handlers ship with `skipped-not-mine` stubs that are safe no-ops under at-least-once delivery. Run protocol for the post-`e-60e16169` operator-driven dogfood lives at [ADR-228 §Amendment 2026-05-23-rev2](docs/adr/228-orchd-spawn-queue-pressure-monitor.md).

### ✨ Added — orchd cross-cage dispatcher seam: `dispatchGitPush` (Story s-4-a74c6fc1 / t-5)

First of three dispatchers under [ADR-232 §D1](docs/adr/232-orchd-cross-cage-dispatcher-seam.md) — wraps `git push <remote> <branch>` for the parent ADR-229 auto-push handler. Local cage executes via `defaultGitSpawn` (fetch → upstream-advanced detect → push → resolve head SHA); remote cage stub returns `skipped-not-mine` per §D2 (transport choice OQ-1 deferred — local-only v1). Cage-not-found + fetch-failure + push-rejection paths raise `atmux flag add --severity p1` and return `skipped-not-mine` with no retry per §OQ-3 (mirrors ADR-231 §D5 anti-retry-storm).

- **New** — `src/core/orchd-dispatch/git-push.ts` (Zod input + dispatch function + test-injection deps).
- **New** — `tests/unit/core/orchd-dispatch/git-push.test.ts` (15 cases: schema validation, local happy path, upstream-advanced, remote-route deferred, cage-not-found, fetch-failure flag, push-rejection flag, no-retry assertion, rev-list parse fallbacks).
- **Wired** — `src/verbs/committer.ts::committerDrainVerb` now injects `dispatchGitPush` into `bootstrapOrchd({ pushDeps })`, closing over `team.name` as the local cage identifier. Sibling dispatchers `dispatchEpicMerge` (t-3) and `dispatchDissolveEpic` (t-4) land in the same directory.

### ✨ Added — `atmux topo` fleet observability + reap cascade (ADR-222 + ADR-223)

One verb replaces today's N × N manual cleanup loop: enumerates the
entire fleet (cockpit + parent teams + epic-teams + cage sockets +
crontab marker blocks + worktrees + branches + kanban epic rows),
classifies orphans against the [ADR-222 §D4](docs/adr/222-cage-topography-read-only-verb-surface.md)
6-class taxonomy, and (with `--reap --apply`) composes the canonical
per-class reap primitives behind a 4-gate safety ladder per
[ADR-223 §D3](docs/adr/223-reap-cascade-semantics-and-safety.md).

- **`atmux topo`** — flat / `--tree` / `--orphans` / `--json` / `--team` / `--since`
  read-only manifest. JSON is `schema_version: 1` (cockpit-mirror
  Rust crate at sibling EPIC pins on it).
- **`atmux topo --reap`** — dry-run cascade. `--apply` runs the
  destruction with per-orphan `[y]/[N]/[a]/[q]/[d]` confirmation
  (Gate 4 deferred to the verb layer). `--yes` bypasses Gate 4 only.
- **Safety gates** — Gate 1 (active-check, bypassed by
  `--skip-checks`), Gate 2 (parent-kind, structural / never bypassed),
  Gate 3 (merge-base, preserves [ADR-219 §D2](docs/adr/219-dissolve-epic-completeness.md)
  invariant / never bypassed), Gate 4 (interactive, bypassed by `--yes`).
- **Reap-log** at `~/.atmux/state/reap-log.jsonl` (one row per
  reaped orphan; `schema_version: 1`).
- **Composition map** — `tmux kill-server` / `cron-reaper` /
  `git branch -D` / `rm -rf` (`reapZombieWorktree`) /
  `removeRegistryEntry`. `dissolveEpic` is intentionally NOT in the
  map for the `cage-tmux-without-registry` class (always refuses on
  missing-registry per the 2026-05-22 amendment); two-pass cascade
  re-classifies residue as `branch-without-row` + `worktree-without-cage`.
- **Performance**: hax dogfood 2026-05-22 measured 441-449 ms on
  the live 5T / 16E fleet (4.4× under the 2s budget).
- **Operator runbook**: [`docs/RUNBOOK-topology.md`](docs/RUNBOOK-topology.md).

### 🗑️ Removed — Sentinel substrate (EPIC e-be01fc89, 2026-05-23)

The cron-polling sentinel mechanism documented in [ADR-132](docs/adr/132-pluggable-martinet.SUPERSEDED.md) has been removed in entirety. Mechanical observation + Enter-push + `claim-next` re-fires distribute to Honker event consumers per sibling EPIC `e-a946af69` (orchd Phase 3-5; Phase 1 already merged at [f6b078b](https://github.com/geoyws/atmux/commit/f6b078b)).

**Source surface deleted** (6 files, -1791 LOC in T1):

- `src/abstractions/sentinel.ts` + `src/abstractions/sentinels/{claude,cursor}.ts`
- `src/core/sentinel-config.ts` + `src/core/sentinel-escalation.ts`
- `src/verbs/sentinel.ts` + CLI dispatch case at `src/cli.ts:287`

**Cron + cockpit surface decommissioned**:

- `src/core/cron.ts` — no sentinel emission branch (T3 regression assertions in `tests/unit/core/cron.test.ts`).
- `src/verbs/cockpit.ts` — `buildSentinelWindowCommand`, `autoStartSentinelLoop`, W3 `_sentinel` provisioning in `reconcileCockpitSession` all removed.
- `src/core/cockpit.ts` — `migrateMartinetBlockToSentinel` shim deleted (ADR-158 grace shim is moot post-deletion).
- `src/verbs/doctor.ts` — `checkCockpitSentinelWindow` + `fixMissingSentinelWindow` probes removed.

**Schema fields removed** (passthrough preserves legacy keys as inert data):

- `team.sentinel` / `team.sentinelOverrides`
- `cockpit.sentinel` / `cockpit.defaultSentinel`
- `SentinelImpl`, `TeamSentinelOverrides`, `CockpitSentinel{Claude,Cursor}`, `CockpitDefaultSentinel`, `SentinelSession{T,}`, `DEFAULT_SENTINEL_CADENCE_SEC`, `DEFAULT_SENTINEL_ESCALATION_CONFIDENCE` types.

**Test surface** (T2): 6 sentinel-only test files deleted (~2898 LOC); 10 test files migrated to drop sentinel-specific assertions.

**Brief retired**: `templates/briefs/martinet.md` deleted.

**ADR closure** (T8 + T7):

- ADR-132 status flipped `Accepted` → `Superseded by e-be01fc89`; final §Amendment 2026-05-23 appended.
- ADRs 158 / 183 / 185 / 206 / 207 marked `Superseded by e-be01fc89`.
- ADR-211 marked `Implemented by e-be01fc89 + e-a946af69`.
- ADR-189 §D2 updated: sentinel-cron-polling removal no longer "lean-mode opt-in" — sentinel is gone entirely.

#### Migration notes

- **Existing crontabs with sentinel blocks**: `atmux stop && atmux start` per team cycles the sandwich-marker block; no manual cleanup needed (per [ADR-202](docs/adr/202-honker-in-db-messaging-substrate.md) §X cron decommission protocol).
- **Stale `team.json` / `cockpit.json` keys** (`sentinel`, `sentinelOverrides`, `defaultSentinel`, legacy `martinet`): schema-removed; the deploy-team-start path silently drops them via `.passthrough()`.
- **One-way door**: ADR-158 martinet→sentinel migration shim was deleted alongside the sentinel surface. Operators on pre-ADR-158 cockpit.json with top-level `martinet:` keys: rename to `sentinel:` (or delete the block entirely) before the next `atmux start` — the shim that previously rewrote `martinet` → `sentinel` is gone.

#### Sibling-EPIC IOU — cadence-truth-signal restoration

`tests/e2e/cadence-truth-signal.test.ts` B4+B5 sentinel-escalation contract beats were DELETED; B9+B10 escalation assertions were GUTTED (commit [d26855d](https://github.com/geoyws/atmux/commit/d26855d) — T2). Audit anchor lives in the test file itself as `TODO(e-a946af69)` markers (header line 18 + B4/B5 deletion site at line 294). Sibling EPIC e-a946af69 (orchd Phase 3-5 lifecycle) owes a "restore cadence-truth-signal coverage" Task that wires the orchd-escalation entrypoint + re-adds the gutted beats against the new contract. **NOT blocking e-be01fc89 done-state** — the TODO markers are sufficient audit anchor per ADR-148 contract preservation.

### 🔄 Changed — `atmux relayd` → `atmux orchd` rename + Rust crate atmux-relayd → atmux-orchd (ADR-224 Phase 1)

`relayd` (relay daemon) is misleading now that the daemon will also own auto-spawn (`epic.added`) and auto-dissolve (`task.done`) in Phase 2 per [ADR-224](docs/adr/224-orchd-rename-and-auto-spawn-loop.md). Phase 1 is a pure relabel — zero behavior change — landing before Phase 2 impl so the codebase doesn't carry a misleading symbol through that development window.

- **Bun verb**: `atmux relayd` renamed to `atmux orchd` ([a9c17ab](https://github.com/geoyws/atmux/commit/a9c17ab)). Deprecation alias preserves `atmux relayd` for one release — emits stderr warning `[deprecated] 'atmux relayd' renamed to 'atmux orchd' (ADR-224); update callsites — alias removes next release` then delegates to the orchd handler (same exit code, same stdout shape).
- **Rust crate**: `rust/atmux-relayd/` renamed to `rust/atmux-orchd/`; binary `atmux-relayd` → `atmux-orchd`; `build:relayd` → `build:orchd`; `/usr/local/bin/atmux-orchd` symlink ([e02ea2d](https://github.com/geoyws/atmux/commit/e02ea2d)).
- **Subscription registry seam**: new `src/core/orchd-registry.ts` exporting `ORCHD_SUBSCRIPTIONS: OrchdSubscription[] = []` — zero-handler scaffold per [ADR-224 §D6](docs/adr/224-orchd-rename-and-auto-spawn-loop.md). Phase 2 wires the `epic.added` / `task.done` handlers; Phase 1 array is empty so no behavior change.
- **Migration**: external callers should swap `atmux relayd` → `atmux orchd` and `atmux-relayd` binary references → `atmux-orchd` before the next release removes the alias.

### ✨ Added — epic dependencies + `is_ready` toggle (ADR-225, EPIC e-cf8a6195)

EPICs now carry `depends_on` (epic-id list) + `is_ready` (0/1 kick-off bit) — v13→v14 migration. `atmux team spawn-epic` consults an eligibility predicate (all deps `done` + `is_ready=1`) and refuses on unmet deps with a structured `--force` override + log to `~/.atmux/state/spawn-overrides.log`. New verbs: `epic ready` / `epic unready` / `epic set-depends-on` / `epic deps`; `epic list` gains `R` + `D=k/n` columns; `epic show` renders the dep chain. Two new event topics (`epic.unblocked`, `epic.ready`) ship per ADR-203 §D2 amendment. Cycle-detect + non-existent-dep refusal fire at add-time. Sibling EPIC e-60e16169 (orchd auto-spawn) is the primary substrate consumer. See [ADR-225](docs/adr/225-epic-dependencies-and-is-ready-toggle.md).

### ⏳ Deprecated — `atmux epic-merge tick` cron (orchd Phase 3 supersedes; removal scheduled 2026-06-06)

Per [ADR-226 §D4 + §DA3](docs/adr/226-orchd-auto-merge-subscriber.md) cron-backstop coordination + [ADR-202 §X](docs/adr/202-honker-in-db-messaging-substrate.md) cron-decommission protocol: now that orchd subscribes to `task.done` and dispatches `performEpicMerge` sub-second (commit `89fcab8`, 2026-05-23), the per-epic-team `epic-merge tick` cron is no longer the primary epic-merge trigger. It stays installed for **two weeks (until 2026-06-06)** as a defense-in-depth resilience fallback — the orchd primary path competes with the cron via the existing `merger_state` `BEGIN IMMEDIATE` serialization, so first-one-wins.

**Decommission timeline**:

- **2026-05-23** (T+0): orchd-merge primary path live (Phase 3 module ships at commit `89fcab8`). Cron + orchd both installed; either can drive the merge. CHANGELOG entry (this one).
- **2026-06-06** (T+14): operator-verified orchd primary path stable via Honker event-log query (`SELECT COUNT(*) FROM events WHERE topic = 'epic.merged'` vs cron-attributed `merger_state` rows). Follow-up Task in **parent atmux kanban** removes the cron-block emit from `src/core/cron.ts` (search tag: `epic-merge tick`). Removal lands as a planner-filed Task at T+14 with cron-template-pruning commit + cockpit rebuild verification.
- **2026-06-13** (T+21): orphan-cron sweep pass — `crontab -l | grep 'epic-merge tick'` on every team-host MUST return zero hits post-decommission. If any team's crontab still carries the line, file a follow-up complaint via medic.

**Rollback path**: `ATMUX_HONKER=off` short-circuits the orchd-merge consumer; the cron-only path resumes. The cron template body lives in `src/core/cron.ts` near the existing `epic-merge tick` invocation; the removal Task at T+14 owns the prune.

See also: [ADR-226 §D4](docs/adr/226-orchd-auto-merge-subscriber.md) (cron-backstop coordination), [ADR-226 §DA3](docs/adr/226-orchd-auto-merge-subscriber.md) (decision-anchor), [ADR-202 §X](docs/adr/202-honker-in-db-messaging-substrate.md) (cron-decommission protocol). Follow-up Task (parent atmux kanban, planner-filed at T+14): "Remove epic-merge tick cron template — orchd Phase 3 dogfood verified".

### ✨ Added — solo-worker scope v1: 1-2 member roster presets for small standalone tasks (ADR-221, t-8c8ce51c)

Fills the gap between "drop on long-lived member queue" (pollutes branch) and "spawn full 7-member epic-team" (wasteful for single commits). Two new roster presets under `templates/epic-rosters/`:

- **`solo.json`** — 1 member (`solo`, role=member, lane=misc). For pure-docs / trivial fixes.
- **`solo+committer.json`** — 2 members (solo + committer). For load-bearing changes where a separate review pass adds value.

Spawn via existing verb: `ATMUX_CALLER_SCOPE=driver atmux team spawn-epic w-<task-id> --from <parent> --roster solo`. Convention: `w-` prefix distinguishes worker-teams in cockpit + epic-list enumeration.

v1 ships the substrate only. v2 adds convenience verbs (`spawn-worker` / `dissolve-worker` / `list-workers`) + auto-dissolve on task.done via Honker subscription. Until then, operator manually dissolves with `atmux team dissolve-epic w-<task-id>`.

See [ADR-221](docs/adr/221-solo-worker-scope.md) for the full design + v2 roadmap.

### 🟢 Fixed — merger-state design-gap pair (long-lived members fan in autonomously) — t-9aa2f8cb + t-0542595c

Two sibling dispatcher fixes shipped 2026-05-22 close the structural wedge that required manual `merger_state` sqlite resets every time a long-lived member shipped a commit.

- **`fix(merger-gate)`** ([t-9aa2f8cb](docs/tasks/t-9aa2f8cb.md), c-6ca1ff2) — intra-team gate counts `in-progress` tasks only (was `todo + in-progress`). Closes the in_progress sink that wedged docs/lead/reviewer with forward-todo queues.
- **`fix(merger-state)`** ([t-0542595c](docs/tasks/t-0542595c.md), c-baa0b8a) — auto-re-entry from `merged` when branch is ahead of base. Closes the merged-terminal wedge that required manual reset after every fan-in.

Both shipped with [ADR-134 §Amendment 2026-05-22 (I + II)](docs/adr/134-in-team-auto-merger.md); live-validated on `atmux-geoyws-docs +1` immediately post-deploy.

### 🟢 Fixed — hold-posture deadlock eliminated from lead bootstrap (ADR-210 §Tier 1, t-ef4bb453)

Lead brief step 2 now does **kanban-first dispatch** instead of holding for planner refinement. Planner role re-framed as async-enriching (not gating). Closes the sopx 2026-05-21 deadlock class where lead + members + planner all idled waiting on each other.

- **templates/briefs/lead.md** — new step 2 (kanban-first dispatch by role: fe-*/be-*/db/devops/reviewer); steps 3-9 renumbered. Cross-link to [ADR-210](docs/adr/210-eliminate-hold-posture-deadlock-structurally.md).
- **templates/briefs/planner.md** — async-enrich-not-gating callout at top of §Your loop. Workers re-read Task bodies between turns and pick up planner refinements on subsequent dispatches.

**Backport posture** (per ADR-210 §OQ1 driver preference): NEW spawn-epic invocations pick up the new brief automatically. **Existing teams need `/clear` on lead + planner panes to re-bootstrap from the updated brief**. Operator chooses which stuck teams to /clear; no automated backport sweep ships in Tier 1. If your team is currently in the hold-deadlock pattern, `/clear` the lead pane and re-spawn it via `/team rotate-lead` (or whichever rotation verb your topology uses).

Tier 2 (member-side pull-protocol fallback) ships as a follow-up release once Tier 1 is verified in the field.

### 🏷️ `atmux team rename` — forward-going verb (ADR-027 shipped, EPIC e-1e223687)

Closes the 2026-04-27 gap: [ADR-027](docs/adr/027-team-rename-verb-and-topology-invariant.md) was accepted but never implemented. Sibling to `atmux team repair-rename` (recovery side, [ADR-103](docs/adr/103-team-repair-rename.md)). The verb renames a team atomically across every surface the team-name appears in — `team.json:.name`, tmux session + cockpit team-viewer window, cron markers, cockpit registry (`cockpit.json::sessions[]` DFS — superseded shape per [ADR-089](docs/adr/089-recursive-cockpit-sessions.md) §B), single-session capture file — with rollback-staged 10-step orchestration + refuse-gate preflight (in-progress kanban tasks soft-refuse; name collision + invalid charset hard-refuse).

Implementation across 5 files per the shared-worktree commit-race split pattern (see [`docs/audit/2026-05-20-shared-index-swap.md`](docs/audit/2026-05-20-shared-index-swap.md) for the structural rationale):

- [`src/verbs/team-rename.ts`](src/verbs/team-rename.ts) — pure helpers (`parseTeamRenameArgs`, `validateTeamName`, `runRefuseGates`, `RollbackStep` + `rollbackWalk`) + the top-level `teamRename` dispatcher wiring every sibling step (T1 + T2 + T6 wire-in).
- [`src/verbs/team-rename-fs.ts`](src/verbs/team-rename-fs.ts) — file-state steps: `acquireRenameLock` (with `team.json.bak.<epoch>` snapshot), `mutateTeamJson`, `rewriteSessionAnchor`, `releaseRenameLock` (T3).
- [`src/verbs/team-rename-cockpit.ts`](src/verbs/team-rename-cockpit.ts) — cockpit registry sync: `syncCockpitRegistry` DFS-walks `cockpit.json::sessions[]`; legacy flat `teams[]` rosters auto-lift via `migrateLegacyShape` (T4).
- [`src/verbs/team-rename-tmux.ts`](src/verbs/team-rename-tmux.ts) — tmux + branch rename: `renameTeamViewerWindow` (cockpit team-viewer window only; per-member windows carry no team-name post-[ADR-135](docs/adr/135-cockpit-naming-convention.md)), `renamePerMemberBranches` (opt-in via `--force-branches`; atomic-multi-ref push with per-branch fallback) (T5).
- [`src/verbs/team-rename-convergence.ts`](src/verbs/team-rename-convergence.ts) — post-rename invariant assertion (T6).

Coverage: 100% line on each shipped surface; ≥89% function across the integration test surface.

Known follow-up: cron-consumer rename-lock guards (ADR-027 §Consequences) are NOT YET wired in the bun port — `sentinel.ts` + `cron-orphans.ts` don't honor the lock; `whip.ts` + `decisions.ts` don't exist as standalone bun verbs. Race risk during in-flight renames; follow-up Task filed at T7 commit-time. T6's convergence helper asserts post-rename hygiene but does NOT cover mid-rename consumer-race.

Operator runbook: [`docs/RUNBOOK-cockpit.md`](docs/RUNBOOK-cockpit.md) §7 — Team rename. Reviewer-relevant deviation notes inline in [ADR-027 §Deviations](docs/adr/027-team-rename-verb-and-topology-invariant.md#deviations-from-spec-added-at-shipping-time-2026-05-20).

### 📐 Documented — `claudeAccount` inheritance contract for `spawn-epic` (ADR-090 §Amendment 2026-05-20, t-72f90a08)

Retroactive coverage for the 2026-05-16 dogfood regression fix that landed at commit `2674670` ("fix(epic-team): two regressions caught by 2026-05-16 dogfood") without the same-commit unit test + ADR §Amendment its acceptance criteria required. Closes t-72f90a08 (P0).

- **5 unit tests** in `tests/unit/verbs/team/spawn-epic.test.ts` (`describe spawnEpic — claudeAccount inheritance from parent`) covering all four rules of the inheritance contract: per-member name match, team-default fallback, roster-pin precedence, and no-account-parent no-op. All 20 tests in the file pass; spawn-epic.ts coverage advances per `inheritClaudeAccount` helper at lines 506–545.
- **ADR-090 §Amendment 2026-05-20** documents the contract surface — gives future roster preset authors + reviewers a citable reference instead of relying on the helper's inline doc-comment.
- Memory `feedback_spawn_epic_claude_account_inheritance_gap.md` remains the operator-workaround anchor; the §Amendment cross-refs it for traceability.

Cross-refs: [ADR-090 §Amendment 2026-05-20](docs/adr/090-epic-team-lifecycle.md), `src/verbs/team/spawn-epic.ts::inheritClaudeAccount`, t-72f90a08.

### 🟢 Shipped — sentinel epic-team coverage + atmux release verb + W3 self-heal + bounded tick concurrency (release sweep 2026-05-20, t-1fad1f12)

Headline: **sentinel epic-team coverage (dynamic discovery to follow) + `atmux release` one-shot deploy verb + W3 self-heal in `atmux doctor --fix` + bounded sentinel tick concurrency**. Closes the ~30h gap between code-shipped and code-deployed that hid the original t-186d5910 silent-member-death class, plus adds the operator surface to keep that gap closed permanently.

**Versions cut today**: `0.8.5 → 0.8.6 → 0.8.7 → 0.8.8`. The 0.8.6 cut dogfooded the manual 4-step deploy one last time; 0.8.7 cut after the `atmux release` verb landed (so 0.8.8 used the new verb to ship itself — closed-loop validation).

- **`atmux release <patch|minor|major>`** ([3efd34b](src/verbs/release.ts), [58c6fed](src/verbs/release.ts), t-c3f4c418) — one-shot deploy replacing the 4-step `npm version` + commit + `bun run build:install` + `git push` flow that hid t-186d5910 for ~30h. Flags: `--dry-run` (print plan + exit 0), `--allow-dirty` (skip the tree-clean gate). Exit codes: `0` success / `64` usage / `65` dirty-or-no-op refused / `70` step failure (git / build / push). Branch-name fix in 58c6fed prints the actual branch instead of the unevaluated shell expression.
- **Sentinel scope extended to epic-teams** ([3b92c9d](src/verbs/sentinel.ts), [ADR-183](docs/adr/183-sentinel-scope-includes-epic-teams.SUPERSEDED.md), t-186d5910 Parts C + D) — closes the silent-member-death class. `sentinelTick` swaps `cockpit.teams ?? []` → `enabledTeams(cockpit)` (the post-ADR-089 flattener); cockpit-tier exclusions (medic / superdriver / sentinel itself) preserved via the flattener's discriminator filter. ADR-183 flipped proposed → accepted.
- **`cockpit-has-w3-sentinel` doctor probe** (3b92c9d Part D) — surfaces the W3 sentinel install state. P1 fail when W3 absent so a regression on `atmux cockpit rebuild` doesn't silently drop the install.
- **W3 self-heal in `atmux doctor --fix` + `deployed-binary-lag` probe** ([1dc83dd](src/verbs/doctor.ts), t-3234a084 + t-400a1cad) — doctor can now repair a missing W3 sentinel window in-place (no full cockpit rebuild required). The `deployed-binary-lag` probe catches the case where source HEAD is ahead of `/opt/atmux/current` symbol set (the code-shipped-not-deployed gap that originally hid t-186d5910).
- **Sentinel tick parallelised** ([54a546e](src/core/sentinel-escalation.ts), t-70c8b562) — switches from serial per-team observation to `Promise.allSettled` per-team. Fleet-pass wallclock drops from ~36s (5 teams serial) to ~2s (parallel), keeping the 270s W3 loop cadence comfortably under budget as the epic-team scope expansion grows the team count.
- **Bounded concurrency cap N=4** (aec82d5) — the parallelisation above is now capped at 4 concurrent observations per tick to protect CPU + RAM. Prevents the spike pattern that drove the earlier sentinel-cron backstop removal (see §Sentinel constraints below). First of the constraints folded in per the operator design call 2026-05-20 (`don't spike CPU+RAM`).
- **Human-readable tick-duration logs** ([4fc3d36](src/core/sentinel-escalation.ts)) — sentinel tick logs now print `d/h/m/s/ms` units via `formatTickDuration` instead of raw milliseconds, so cron-log inspection doesn't require mental math.

**Sentinel constraints folded in** (load-bearing non-functional requirements per operator design call 2026-05-20):

1. **Epic-teams are dynamic** — created / dissolved often. They MUST be absent from `cockpit.json::sessions[]`. Sentinel discovers them at tick time. Follow-up impl: t-b51f085b (filed). The implication for ADR-183 is captured in its §Amendment 2026-05-20 + ADR-185 below.
2. **Don't spike CPU+RAM** — sentinel-cron backstop was REMOVED earlier this cycle due to CPU sustain; all remaining sentinel paths respect bounded concurrency (aec82d5 above), per-team timeouts (t-ccf06b97 filed), and RAM-aware cursor-agent spawn caps. PRD §Sentinel updated to name this as a load-bearing NFR.

**Cross-refs**:
- [ADR-183 §Amendment 2026-05-20](docs/adr/183-sentinel-scope-includes-epic-teams.SUPERSEDED.md) — supersedes the §D1 static-cockpit-roster assumption with the dynamic-discovery model.
- [ADR-206](docs/adr/206-sentinel-dynamic-epic-discovery.SUPERSEDED.md) — NEW proposed ADR for the dynamic-discovery follow-up (t-b51f085b is its impl Task).
- [ADR-187](docs/adr/187-coordination-skills-plugin.md) — NEW proposed ADR documenting the sibling Claude Code skills plugin (`~/work/journals/.sb/claude-skills/plugins/coordination/`).
- Filed-but-pending: t-b51f085b (sentinel dynamic epic-team discovery, P1) · t-ccf06b97 (sentinel per-tick token budget + per-team timeout, P2) · t-a0396228 (pre-commit hook: migration delete + ADR status downgrade, P2) · t-c0f0ff5a (MEMORY.md auto-archive, P3) · t-60031ded (`atmux bau` native verb, P3).

### 📜 Doctrine — committer no-deploy + test-trust principle (t-afcc71af, ADR-091/134/144 §Amendment 2026-05-19)

Driver finding 2026-05-19 06:30 MYT (operator: "make sure committers/gitters don't deploy… make sure they understand that if they are merging that means tests are already passing because the epic-team has already done the merge earlier and has run tests") surfaced two implicit doctrines worth making explicit before they drift:

- **Committer scope is merge-and-push, NOT deploy** — `kubectl` / `helm` / `terraform` / pipeline-triggers / manifest edits / service restarts are all out-of-scope refusal-class. Codified in [`templates/briefs/committer.md`](templates/briefs/committer.md) §Deploy is out of scope + §Hard rules (both modes) (new bullet). Per [ADR-145](docs/adr/145-atmux-adopts-gitter.md) the committer role's scope was always merge-and-push, but the brief now names the deploy refusal-class explicitly so future agents can't drift into infra territory while looking adjacent to push semantics.

- **Test-trust principle — tests fire ONCE at L1, fan-in trusts the verdict** — the intra-team merger ([ADR-134](docs/adr/134-in-team-auto-merger.md)) is the SOURCE-of-truth test layer (`autoMerge.testCommand` at `merging → tested`); the epic-team fan-in ([ADR-091](docs/adr/091-kanban-driven-auto-merge.md) via `atmux epic-merge tick`) **trusts** that verdict with `testGateMode: "skip"` default ([ADR-144](docs/adr/144-epic-team-test-gate.md) §Amendment 2026-05-19). The schema-level default (`src/schema/team.ts::TeamEpicSchema.testGateMode = "skip"`) and unit-test pin (`tests/unit/core/epic-merge.test.ts` "testGateMode unset (default) → skip semantics") were already in place; this Task makes the **doctrine** explicit across 3 ADR §Amendments + committer brief §Test-trust principle. `"cage"` / `"deployed"` are operator escape hatches for the rare case where L1 tests were knowingly incomplete; the default behavior is skip-and-trust.

The change is **brief + ADR amendments only** — Part B of the originating Task (default-flip + unit test) was already satisfied at source; the ADR §Amendments codify the WHY behind the existing default. Reviewer surface for regressions: a re-test fire on default fan-in violates the principle and should land as `atmux flag add --severity high`.

### 📐 ADR-186 — unified wedge-clearing mechanism (proposed; EPIC e-35dd6274 T1, t-73128937)

Driver mechanism audit 2026-05-19 (5 wedges discovered in 1h of manual investigation, ~70 lines of orphan crontab hand-cleaned, 1 silent committer death uncaught for hours) framed the need: a single substrate for detecting + clearing wedges across all current + future failure modes. [ADR-186](docs/adr/186-wedge-clearing-mechanism.md) is the T1 spec.

**Decision**: extend three existing mechanisms (no new cockpit-tier member):

- **Doctor probe-class registry** (`src/core/doctor-probes/`) — typed `{id, severity, tier, describe, fingerprint, suggestResolution, probe}` contract per probe; ships 7 classes at T2 (`orphan-cron`, `husk-worktree`, `missing-viewer`, `default-sentinel`, `pane-death`, `partial-dissolve`, `code-shipped-not-wired`).
- **Sentinel observe-pass invokes the registry** with `autoFile=true` per ADR-132 §D5 tick (T4 of the EPIC) — runner is the existing sentinel loop; cron backstop fires independently every 15min.
- **`atmux wedges` operator surface** — `list / show / clear --tier / resolve / --json / --resolved`; cockpit-dashboard-friendly output.

**Tiered auto-clear** per global CLAUDE.md destructive-actions rule: `safe` (auto-cleanup, e.g. orphan-cron) / `fix` (installer-class repair, e.g. missing-viewer) / `suggest` (operator-judgment path, e.g. pane-death) / `surface` (read-only meta-probes). Dedup via SHA256 fingerprint of `<probe-id>|<finding-stable-key>` matched against open Task body markers `auto-filed:<probe-id>:<fp>`. Backup-before-destructive at `/tmp/wedge-clear-backup-<ts>/`, retention 7d.

Cross-refs: [ADR-027](docs/adr/027-doctor-self-diagnostics.md) (substrate), [ADR-132](docs/adr/132-pluggable-martinet.SUPERSEDED.md)/[ADR-158](docs/adr/158-martinet-to-sentinel-rename.SUPERSEDED.md) (runner), [ADR-140](docs/adr/140-cheap-model-first.md) (mechanical-fits-sentinel), [ADR-091](docs/adr/091-kanban-driven-auto-merge.md) (EPIC-done flow), [ADR-090](docs/adr/090-epic-team-lifecycle.md) (lifecycle seams), ADR-183 (deploy-completeness sibling), [ADR-178](docs/adr/178-test-cage-leak-reaper.md) (backup-on-clear convention), [ADR-184](docs/adr/184-host-wide-epic-team-cap-queue-and-dormancy-audit.md) (cluster-precondition).

Out of scope: new cockpit-tier "wedge-clearer" member (rejected — sentinel covers loop, cron covers backstop); LLM-based wedge classification (defer — v1 is deterministic invariants); cross-team wedge correlation (defer to ADR-150).

Status: proposed; reviewer flips to accepted per ADR-091 §EPIC-done #4 (trunk-signoff at `docs/reviews/t-73128937-trunk-signoff-<date>.md`) once the EPIC fan-in commit lands.

### 🔤 Vocabulary / scope — medic vs sentinel boundary tightened (ADR-077 + ADR-132 §Amendment 2026-05-19)

Driver mechanism audit (finding #2 against EPIC e-35dd6274) surfaced a coverage gap: medic (W2, [ADR-077](docs/adr/077-superdoctor-cockpit-role.md) / renamed via [ADR-133](docs/adr/133-medic-rename.md)) owned "health probes" and sentinel (W3, [ADR-132](docs/adr/132-pluggable-martinet.SUPERSEDED.md) / renamed via [ADR-158](docs/adr/158-martinet-to-sentinel-rename.SUPERSEDED.md)) owned "whip", but **pane-death detection / claude TUI wedge** sat in the seam. Today's silent gitter/committer death (TUI wedged but process alive; no `✻` activity, no commits, no operator response) went uncaught for hours because reviewer + driver triage couldn't point to which mechanism owned it.

Two append-only §Amendment sections — one in each ADR — codify the boundary:

- **Medic scope** (repository health): test/lint/build failures, schema drift, code-class probes; drives same-commit fixes. NOT pane-liveness.
- **Sentinel scope** (pane liveness + mechanical nudges): TUI dead/wedged/rate-limited/refusing, enter-push, claim-next, modal-release, routine + emergency rotation. NOT code health.
- **Doctor** stays shared probe substrate per [ADR-027](docs/adr/027-doctor-self-diagnostics.md); both callers invoke it.
- **Cross-invocation**: sentinel routes code-class findings to medic via escalate-to-claude-lead; medic routes liveness-class findings via the shared probe library.

Brief cross-link added at [`templates/briefs/martinet.md`](templates/briefs/martinet.md) §"Scope boundary vs medic". No `medic.md` / `sentinel.md` briefs exist today; the existing `martinet.md` (sentinel canonical pre-ADR-158 rename) carries the contract.

No code changes — pure docs sweep. `rg -i 'medic vs sentinel|pane death' src/` returns zero hits, confirming no contradicting language remains.

**Cross-refs**:

- [ADR-077](docs/adr/077-superdoctor-cockpit-role.md) §Amendment 2026-05-19 — medic side.
- [ADR-132](docs/adr/132-pluggable-martinet.SUPERSEDED.md) §Amendment 2026-05-19 — sentinel side.
- [ADR-027](docs/adr/027-doctor-self-diagnostics.md) — shared probe substrate.
- [ADR-140](docs/adr/140-cheap-model-first.md) — sentinel = mechanical, medic = judgment-bearing.
- EPIC e-35dd6274 — wedge-clearing mechanism (scope clarity is precondition for probe-class routing per ADR-186).
- Task `t-c8be6daa` — this docs sweep.

### 🏷️ Renamed — ADR-088 per-member-branch fan-in → ADR-179 (collision resolution, t-88da6978, 2026-05-18)

Sibling pattern to the t-fe51cf64 ADR-087 renumber (same day). `docs/adr/088-per-member-branch-fan-in.md` (Accepted 2026-05-15) collided with `docs/adr/088-worktree-submodule-init.md` (accepted 2026-05-13). Per atmux ADR convention (monotonic, append-only, one ADR per number — CLAUDE.md §Source-of-truth chain), the older submodule-init ADR keeps the 088 number; the fan-in ADR moves to ADR-179. Both ADR-087 + ADR-088 collisions now closed; project is back to a single ADR per number. Convention precedent: b4d62da `docs(adr-176)` + 830e9fc `docs(adr-177)`.

- **`git mv docs/adr/088-per-member-branch-fan-in.md → docs/adr/179-per-member-branch-fan-in.md`** — file body header `# ADR-088:` → `# ADR-179:`; new §Amendment 2026-05-18 (t-88da6978) at the top documents the renumber + source-commit history (W1 a37dacc, W2 086505c, W3 10dcf43, W7 191b721, W8 f4ea9a2).
- **External fan-in refs swept** (~25 files): `src/abstractions/branch-merge.ts`, `src/verbs/merge-member.ts`, `src/verbs/merge-cycle.ts`, `src/verbs/committer.ts`, `src/verbs/cron-install.ts`, `src/verbs/doctor.ts`, `src/core/committer-sweep.ts`, `src/core/intra-team-merge-dispatcher.ts`, `src/core/merger-config.ts`, `src/core/sentinel-config.ts`, `src/core/cron.ts`, `src/core/kanban.ts`, `src/schema/team.ts` (all fan-in refs; no submodule-init refs in this file), `tests/e2e/merger.test.ts`, `tests/e2e/merger-fan-in.test.ts`, `tests/unit/abstractions/branch-merge.test.ts`, `tests/unit/core/merger-config.test.ts`, `tests/unit/verbs/cron-install.test.ts`, `tests/unit/verbs/doctor.test.ts`, `tests/unit/verbs/merge-member.test.ts`, `tests/unit/verbs/merge-cycle.test.ts`, `templates/briefs/merger.md`, `docs/adr/091-kanban-driven-auto-merge.md` (lines 182 + 232 — line 7 chain-shift preserved), `docs/adr/145-atmux-adopts-gitter.md`, `docs/adr/146-kanban-auto-files-trunk-merge.md`, `docs/reviews/ADR-134-planner-pair-review-2026-05-14.md`.
- **Untouched** (refs are submodule-init, NOT fan-in): `docs/adr/088-worktree-submodule-init.md`, `src/abstractions/worktree.ts`, `tests/unit/abstractions/worktree.test.ts`, `tests/e2e/worktree-submodule.test.ts`, `src/verbs/start.ts`, `docs/adr/089-hierarchical-cockpit.md` (chain-shift only), `docs/adr/134-in-team-auto-merger.md` (chain reference only).
- **ADR-090 line 369 misroute corrected**: was `[ADR-088](088-per-member-branch-fan-in.md) — initSubmodules primitive` (fan-in ADR never contained initSubmodules); retargeted to `088-worktree-submodule-init.md` with parenthetical noting the pre-existing typo + that the fan-in ADR is now ADR-179.
- **ADR-090 line 370 + ADR-135 line 143** updated to past tense — both 087 + 088 collisions are now closed.

### 🏷️ Renamed — ADR-087 whip-velocity-gate → ADR-177 (collision resolution, t-fe51cf64, 2026-05-18)

`docs/adr/087-whip-velocity-gate.md` collided with `docs/adr/087-atmux-stop-soft.md` (Accepted 2026-05-13). Per atmux ADR convention (monotonic, append-only, one ADR per number — CLAUDE.md §Source-of-truth chain), the older soft-stop ADR keeps the 087 number; the velocity-gate ADR moves to ADR-177 (pre-flagged by the t-5d85dddb planner scope-refresh note). Convention precedent: b4d62da `docs(adr-176): renumber ADR-171 epic-aware-lane-drift-revert → ADR-176`. Source-commit history preserved across the rename: 2a7db33 (kernel), eb97ea6 (V1 wiring per ADR-177 §What V1 defers).

- **`git mv docs/adr/087-whip-velocity-gate.md docs/adr/177-whip-velocity-gate.md`** — file body header updated `# ADR-087:` → `# ADR-177:`; new §Amendment 2026-05-18 (t-fe51cf64) at the top documents the renumber + collision context.
- **External refs swept** — all `ADR-087` references in source / docs / tests that pointed at the velocity-gate retarget to `ADR-177`: `src/core/velocity.ts`, `src/core/whip-strikes.ts`, `src/core/whip-escalation.ts`, `src/core/complaints.ts`, `src/core/velocity-gate.ts`, `src/verbs/poke.ts`, `src/schema/team.ts` (velocity-gate cadence knobs + kill-switch fields only — soft-stop `softStopGraceSeconds` ref preserved), `tests/unit/core/velocity.test.ts`, `tests/unit/core/velocity-gate.test.ts`, `tests/unit/core/whip-strikes.test.ts`, `tests/unit/core/whip-escalation.test.ts`, `tests/unit/core/complaints.test.ts`, `docs/adr/139-refusal-pattern-auto-rotate.md`, `docs/adr/147-ombudsman-and-release-notes.md`, `README.md`, `docs/release-notes/2026/05/2026-05-16.md` (lines 18 + 21 + historical-note added).
- **Untouched** (refs are soft-stop, NOT velocity-gate): `docs/adr/087-atmux-stop-soft.md`, `src/core/soft-stop.ts`, `src/verbs/stop.ts`, `src/verbs/start.ts`, `src/schema/resume.ts`, `tests/e2e/stop-soft.test.ts`, `tests/unit/core/soft-stop.test.ts`, `docs/adr/089-hierarchical-cockpit.md`, `docs/adr/090-epic-team-lifecycle.md`, `docs/adr/091-kanban-driven-auto-merge.md`, `docs/adr/134-in-team-auto-merger.md`, `src/verbs/help.ts`, prior CHANGELOG entries for soft-stop §D4 cron quiescence and stop-soft-resume-manifest sections.
- **Tests** — no test behavior changed; ADR ID strings inside test docstrings updated to match the new number.

### 🟢 Fixed — self-heal shim for legacy default-member window names (EPIC e-a3077ca0, 2026-05-18)

Cages continuously running across the ADR-161 default-member `_-prefix` deploy never saw an `atmux start` rename pass and stayed on pre-ADR-161 hyphen / no-separator window names indefinitely. Every addressing verb refused with `no tmux window for lead (is the team running?)` against such cages until an operator manually `tmux rename-window`'d each of the 6 coordination panes. Observed 2026-05-18 on the atmux parent cage (4-day uptime; `🧭-lead` / `🎯-planner` / `🔍-reviewer` / `🦦-docs` / `🌿-gitter` / `⚖️-ombudsman` all on hyphen form). Cross-format failure also caught at `src/verbs/lane-tick.ts` against the docs window: `lane-tick: docs: capture error — can't find window: 🦦docs` (no-separator pre-ADR-135 variant — captured by t-fabd2528 verify-poll while the actual pane was `🦦_docs`).

New `src/core/common.ts::resolveWindowWithRenameShim(sessionName, canonical, legacyVariants, ops)` helper drives an atomic legacy → canonical `tmux rename-window` on the first addressing call against a legacy cage, then returns the canonical name. Wired into the 6 default-member addressing surfaces; first call after deploy self-heals each cage. Doctor probe `legacy-window-name-format` provides an at-a-glance verdict for operators with copy-paste-ready rename hints.

- **[`src/core/common.ts`](src/core/common.ts)** (T1 86c0e4a) — `resolveWindowWithRenameShim` + `WindowShimOps` dep-injectable interface. Canonical handles all three observed formats: `<emoji>_<member>` ADR-161 default-member canonical, `<emoji>-<member>` ADR-135 hyphen, `<emoji><member>` pre-ADR-135 no-separator. Gitter exemption preserved (canonical stays `🌿-gitter` per `project_adr_161_tr2_shipped` + ADR-159 pending — caller passes empty `legacyVariants[]`).
- **[`src/verbs/rotate.ts`](src/verbs/rotate.ts)** (T2 5f07a60) — highest-frequency call-site; was the original 2026-05-18 atmux parent-cage `rotate-lead` failure symptom.
- **[`src/verbs/send.ts`](src/verbs/send.ts)** (T3 1182e66) — both single-member + broadcast paths via `resolveMemberTarget`. Broadcast catch widens to absorb the new `ConfigError("no tmux window for X")` miss-path into the same warn bucket as paste-buffer failures (bash parity).
- **[`src/verbs/dispatch.ts`](src/verbs/dispatch.ts)** (T4 f1e7744) — kanban Task dispatch.
- **[`src/verbs/lane-tick.ts`](src/verbs/lane-tick.ts)** + **[`src/verbs/poke.ts`](src/verbs/poke.ts)** (T5 13ad850) — per-member iteration; was the surface that caught the `🦦docs` capture error in production logs.
- **[`src/verbs/tell-lead.ts`](src/verbs/tell-lead.ts)** (T6 0dcffae) — driver→lead + member→lead paths; preserves ADR-029 §F6 + F7 byte-equal `no tmux window for <lead.name> (is the team running?)` error body (parity-test-gated).
- **[`src/verbs/doctor.ts`](src/verbs/doctor.ts)** (T8 22a2df6) — new warn-class probe `legacy-window-name-format`. Walks every cockpit cage (`~/.atmux/cockpit.json::teams[]`; falls back to current-team when cockpit absent / unreadable). Emits yellow rows with `tmux -S <socket> rename-window` one-liners. Gitter + plain `role: "member"` exempt by definition (hyphen IS their canonical per ADR-161 §D2). Self-clearing post-rename — whether operator runs the hint OR the shim wires self-heal on the next addressing call.

**Test coverage** — T7 unit (86c0e4a, 4 cases on `resolveWindowWithRenameShim` covering canonical-exists, hyphen-form-renamed, no-separator-renamed, neither-throws). Per-wire shim coverage landed alongside each commit: 5 cases in `send.test.ts` (1182e66), 4 cases in `tell-lead.test.ts` (0dcffae), 11 cases in `doctor.test.ts` (22a2df6, including cockpit-walk, current-team dedup, and the role-undefined-silent path). Wire commits for T2 / T4 / T5 carry their own per-verb shim tests against the same matrix.

**Cross-refs**:

- [ADR-161](docs/adr/161-default-member-prefix-and-sort-verbs.md) §Amendment 2026-05-18 — names the helper + the 6 wire-sites + the doctor probe + the gitter exemption + the carve-outs (epic-viewer + user-added members).
- memory `feedback_atmux_dispatch_emoji_window_bug` — RESOLVED 2026-05-18; documents the three observed formats + recovery flow.

**EPIC commits**: T1 86c0e4a · T2 5f07a60 · T3 1182e66 · T4 f1e7744 · T5 13ad850 · T6 0dcffae · T7 (bundled with T1) · T8 22a2df6 · T9 (this commit).

### 🟢 Fixed — auto-fire Enter on queued worker compose-box + rotate-lead brief-paste decoupled from already-booted short-circuit (EPIC e-f28c2596, 2026-05-18)

Two-front fix for chronic stuck-pane patterns observed across `/bau` scans on 2026-05-17 and 2026-05-18: (1) cron-fired hot-loop verbs now ACTIVELY unstick queued compose-box text via ADR-138 verify-and-retry instead of merely surfacing the stuck state, and (2) `atmux rotate-lead` no longer skips the brief re-paste when tmux scrollback retains pre-`/clear` tokens. Both halves of the EPIC ship to trunk in this release; reviewer-trunk-signoff fires when this CHANGELOG entry lands alongside the T6 e2e (7cf5b02) + T8 unit (e97c357) gates.

**Half 1 — auto-fire Enter on queued worker compose-box** (T1-T6):

Cron-fired `poke` / `lane-tick` per-member loops now detect stuck queued text in the composer (e.g. `❯ /loop /whip`, `❯ claim --next`, `❯ atmux ombudsman work` that the worker typed but never submitted) and re-fire the same text via ADR-138 `safeSendKeysWithVerify` + `composerEmpty()` verifier. Pre-fix: operator had to push Enter on N panes per `/bau` cycle OR fire `atmux send <member>` per pane; the cage looked alive but actually had queued work that just needed a submit signal (~50+ manual Enter pushes per 24h shift across the team-of-teams cockpit).

- **[`src/core/queued-text-resubmit.ts`](src/core/queued-text-resubmit.ts)** (NEW, T1 c24ee2b) — pure-of-IO `detectAndResubmit(paneCapture, sendKeysFn, clockFn, failureLogFn)` helper. Decision tree: composer empty → noop; queued + active-turn indicator → skip (mid-turn); queued + idle → fire via `sendKeysFn`; post-fire verifier failure → log-failure (caller's `failureLogFn` invoked). All side effects flow through injected deps so the four state branches unit-test without spinning up tmux.
- **[`src/verbs/poke.ts`](src/verbs/poke.ts)** (T2+T4 collapse 0d69bf3 / 490c0ec) — wired into `checkMember` per-member iteration. ADR-160 collapsed the legacy bash `whip.sh` per-member vs team-level loop distinction into one `for (const member of team.members)` in `runTick` → T2 (per-member) + T4 (team-level) share the call site. Outer guards skip rate-limited / compacting / busy panes (sends would mis-target). Coverage spans every role in `team.json::members[]` (lead / planner / reviewer / workers / ombudsman when present) because no role filtering happens upstream.
- **[`src/verbs/lane-tick.ts`](src/verbs/lane-tick.ts)** (T3 23a33b1) — wired at the top of the per-member loop, after pane capture but before READY classification. New `LaneTickMemberOutcome` value `injected-queued-resubmit` distinguishes the resubmit-fired case from the legacy `injected` (claim-injection); both `fire` and `log-failure` outcomes map to it (the member is now executing their OWN queued command, lane-tick defers to avoid stacking a second claim). Best-effort try/catch wraps the call so a tmux fault doesn't crash the ADR-080 §B2 auto-done scan.
- **Test coverage** — T5 unit (0505bb4, 4 helper-state branches + `extractQueuedText` edge cases) + T6 bats integration (7cf5b02, vs real tmux + claude TUI shim).

**Half 2 — `atmux rotate-lead` brief re-paste skipped on stale-token scrollback** (T7-T8):

Decouples the `bootClaudeMember` already-booted sentinel from the rotate-after-`/clear` path. Pre-fix bug: `atmux rotate-lead` printed `rotate: <role>: already booted — boot prompt skipped` and the rotated lead landed at 0 tok of brief context in the next `/bau` scan. Root cause: `/clear` resets the Claude session but tmux's own scrollback persists, so `capturePane(start: -40)` after `/clear` matched residual `Nk tokens` text and the sentinel mis-fired as already-booted, skipping the brief re-paste entirely (`goal injection skipped` was the downstream symptom — goal-injection runs AFTER brief-paste and silently no-ops when boot was skipped).

- **[`src/core/boot-claude.ts`](src/core/boot-claude.ts)** (T7 1b6b111) — new `BootClaudeOpts.forceBootPrompt?: boolean` (default `false`). When `true`, the (1) already-booted sentinel branch is bypassed; the call proceeds straight to readiness wait + boot prompt regardless of what tmux scrollback shows. `start.ts` and other first-spawn callers keep default `false` (the double-submit guard remains correct for first-spawn — no `/clear` precedes the call).
- **[`src/verbs/rotate.ts`](src/verbs/rotate.ts)** (T7 1b6b111) — passes `forceBootPrompt: true` to `bootClaudeMember` for every claude-TUI rotate, treating `/clear` as definitive ground truth for context-wipe. Override via `opts.bootClaude.forceBootPrompt` (the post-`Object.assign` override path is preserved per the existing test-injection convention).
- **Operator-visible fingerprint of the pre-T7 bug** — `rotate: <role>: already booted — boot prompt skipped` in rotate stderr, followed by 0-token `<role>` in the next `/bau` scan. ADR-077 (medic cockpit role) reviewed for the same short-circuit: its rotate path uses `cockpit-rotate.ts` (kill-pane + new-window per [ADR-167](docs/adr/167-cockpit-rotate-verb.md)) not `bootClaudeMember`, so the bug does NOT apply there.
- **Test coverage** — T8 unit (e97c357, 6 new tests: 4 in `boot-claude.test.ts` covering forceBootPrompt true/false × tokens/no-tokens × verify-fail edges + 2 in `rotate.test.ts` covering rotate-default threads true + operator-override pins false).

**Cross-refs**:

- [ADR-138](docs/adr/138-verified-send-keys.md) §Amendment 2026-05-18 — annotates `detectAndResubmit` as the new downstream consumer + names the wiring sites.
- [ADR-168](docs/adr/168-send-keys-failures-log.md) — escalation log target; `safeSendKeysWithVerify`'s built-in `onFail:"escalate"` path owns disk persistence (helper `failureLogFn` re-emits to verb stderr only).
- memory `feedback_atmux_send_for_queued_panes` — revised: post-fix, cron-fired verbs auto-unstick queued panes; driver-side `atmux send <member>` is now a fallback for the rare verify-exhausted case, not the primary recovery path.
- memory `feedback_shared_index_commit_race_hazard` (NEW, 2026-05-18 e-f28c2596) — observed-twice pattern in this EPIC: shared-worktree shared-index can absorb or swap staged files between concurrent commits (4133af1 pre-push absorption; 7cf5b02/1b6b111 post-push subject-content swap). Mandatory pre/post-commit `git diff --cached --stat` + `git show --stat HEAD` ritual mitigates.

**EPIC commits**: T1 c24ee2b · T2 0d69bf3 · T3 23a33b1 · T4 490c0ec · T5 0505bb4 · T6 7cf5b02 · T7 1b6b111 · T8 e97c357 · T9 (this commit).

### 🟢 Shipped — `atmux story signoff` / `unsignoff` verbs + `mergeMode` field (ADR-175, EPIC e-fa58a2f9, 2026-05-18)

Closes two CLI gaps surfaced during rentx E1 reviewer signoff (operator-authorized raw SQL bypass on `s-425249d0` / `s-dc19b96e` / `s-f5797a08` / `s-cb99f131` at 2026-05-17 13:55 MYT). Per [ADR-175](docs/adr/175-story-signoff-verb-and-trunk-direct-merge-mode.md):

- **`atmux story signoff <id> [--as <member>] [--note <text>]`** (NEW — [ADR-175 GAP 1](docs/adr/175-story-signoff-verb-and-trunk-direct-merge-mode.md)) — flips `stories.review_signoff = 1`. Refuses outside `status=review`. Caller-role gate: pass `--as` (operator override) OR be `role=reviewer` per `team.json`. Audit entry `{ signedOffBy, signedOffAt, note }` appended to `stories.extra.signoffAudit[]` (append-only, epoch-ms timestamps for sub-second ordering).
- **`atmux story unsignoff <id> [--as <member>] [--note <text>]`** (NEW — ADR-175 GAP 1 reversal) — flips back to `0`. Refuses outside `status=review` AND refuses when `story.mergeTaskId` is set (signoff already consumed by gitter dispatch; use the merge-task abort flow instead — ADR-175 OQ-1). Counter-entry `{ unsignedBy, unsignedAt, note }` appended to the same audit array.
- **`atmux story add --merge-mode feature-branch|trunk-direct`** (NEW flag — [ADR-175 GAP 2](docs/adr/175-story-signoff-verb-and-trunk-direct-merge-mode.md)) — opts a Story into one of two integration shapes. Default `feature-branch` preserves the existing state machine (`review → merging → done`, synthesizes the gitter merge-Task). `trunk-direct` skips `merging` entirely (`review → done` becomes legal; signoff bit still required — review gate intact). Suits platform / infra stories (submodule attach, nginx symlink, systemd unit, deploy provisioning) where there is no merge artifact.
- **`KanbanStory.mergeMode`** schema field with trunk-direct state-machine branching at `src/core/story.ts::advanceStory`. Refuses `trunk-direct → merging` with explicit "no merging phase" error (foot-gun gate). Refuses `trunk-direct review → done` without signoff with the documented "reviewer signoff missing" error (matches the existing feature-branch `review → merging` gate verbatim).
- **`stories.extra.signoffAudit[]`** audit trail — rides through the existing `extra` JSON column round-trip in [`src/core/repositories/kanban-repo.ts`](src/core/repositories/kanban-repo.ts) (NOT in `KNOWN_STORY_FIELDS`, per ADR-091's extra-JSON-append pattern). Zero new repo wiring; zero migration impact on the audit array itself.
- **Migration v9 → v10** — `ALTER TABLE stories ADD COLUMN merge_mode TEXT DEFAULT 'feature-branch'` per ADR-126 / ADR-169 pattern. Permissive `TEXT` typing (no `CHECK` constraint); enum gated at the Zod layer + at the verb parser. Forward-compatible — a future third value (e.g. `'no-merge'` per ADR-175 OQ-3) lands additively. Existing rows backfill via the column default.
- **Reviewer brief §6 "Decide"** ([`templates/briefs/reviewer.md`](templates/briefs/reviewer.md)) updated to the canonical 3-step path: `atmux story signoff` → `atmux story advance --to merging` → `atmux done <review-task-id>`. Documents the `--as <member>` operator override + the `--unsignoff` reversal gate.
- **[ADR-007 §Amendment](docs/adr/007-pull-kanban.md)** (append-only) points at ADR-175 from the §OQ2 reviewer-signoff-gate origin.
- **Tests** — 90 paired-test cases under [`tests/unit/verbs/story.test.ts`](tests/unit/verbs/story.test.ts) covering: parseAddArgs (`--merge-mode` happy + bogus enum), parseSignoffFlags (happy + dangling + unknown), `storySignoff` (bit flip + audit append + status gate + role gate + operator override + missing-member ConfigError + idempotent re-call + no-state.db ConfigError), `storyUnsignoff` (counter-entry + `mergeTaskId`-set refusal + status gate + role gate), full feature-branch state-machine via canonical signoff verb path, 4 rentx E1 trunk-direct shape repros (one parameterized test per `s-425249d0` / `s-dc19b96e` / `s-f5797a08` / `s-cb99f131`), feature-branch regression control, trunk-direct-without-signoff refusal, trunk-direct-to-merging foot-gun refusal, verb-layer `$ATMUX_MEMBER` threading. Coverage: `src/core/story.ts` 100% funcs / 95.52% lines; `src/schema/kanban.ts` 100% / 100%; `src/verbs/story.ts` 100% funcs / 82.45% lines. EPIC ships: T0 9551ebf (cherry-pick) / T1 f666ddd (be-1) / T2 13db114 (be-2) / T3 5573cf0 (be-1) / T4 this commit.
- **Closes the rentx-driver SQL-bypass class** — no more `UPDATE stories SET status='done'` operator authorizations on the reviewer-signoff or merging-skip paths. ADR-175 status flip `proposed → accepted` pending reviewer-trunk-signoff (gated per ADR-091).

### 🟢 Shipped — `atmux cockpit rotate <session-name>` — Rung C canonical rotation verb (ADR-167, EPIC e-0b90d6ac, 2026-05-18)

Operator-fired rotation of cockpit role panes (`medic`, `sentinel`, `<team-name>`) with brief-paste-ready handoff. Closes the previously manual `/bruh` skill §3a fallback (Rung C of the escalation chain — Rung A = member rotate, Rung B = lead rotate via medic, Rung D = full cockpit rebuild). Caller-scope=driver only per [ADR-033](docs/adr/033-caller-scope-gate.md). `superdriver` unconditionally refused (operator REPL pane).

- **[`src/verbs/cockpit-rotate.ts`](src/verbs/cockpit-rotate.ts)** (NEW) — full verb implementation. Argv parser + 4 pre-flight gates (user-not-typing on superdriver compose-box, pane-idle on target window, uptime ≥60min on per-role session-start marker, never-rotate-superdriver) + per-role respawn matrix (medic / sentinel-claude / sentinel-cursor / team-driver) + handoff write-path + audit log. Test seams exposed on `CockpitRotateOpts` for hermetic fixtures (`loadCockpit`, `safeSendKeysWithVerify`, `autoStartMedicLoop`, `autoStartSentinelLoop`, `readAuditLog`, `readLeadOutboxTail`, `atomicWrite`).
- **[`src/abstractions/claude-account-wrapper.ts`](src/abstractions/claude-account-wrapper.ts)** (NEW) — pure resolver per [ADR-094](docs/adr/094-c-alias-spawn-convention.md) c-alias convention. Maps `claudeAccount.configDir` to the operator's shell wrapper name (`/root/.claude → claude`, `-unum → c-u`, `-icloud → c-ic`, `-ifca → c-i`); unknown configDirs throw `ConfigError` with the registered-set enumeration. Load-bearing for medic + sentinel-claude respawn lines; skipped for sentinel-cursor (no claude TUI) + team-driver (cageRetryLoop per [ADR-162](docs/adr/162-atmux-owns-tmux-infrastructure.md)).
- **Handoff write-path** ([ADR-167 §Handoff payload schema](docs/adr/167-cockpit-rotate-verb.md)) — per-role Markdown payload written atomically to `~/.claude/teams/__cockpit__/<role>/handoff.md` BEFORE Ctrl-C per §Ordering invariant. 100KB soft cap with truncate-with-trailer (UTF-8 codepoint-safe). On handoff-write failure: exit 70 + `handoff-write-failed` audit row + pane intentionally **untouched** ("retry the verb" not "rotate blind"). V1 heavy state-reads (medic complaints / sentinel classifier / team-driver outbox) ship with placeholder markers + follow-up enrichment pending.
- **Audit log** — NDJSON, append-only, at `~/.atmux/state/cockpit-rotate-audit.log`. Schema: `{ts, role, sessionName, outcome, durationMs, callerScope, error?, handoffPath?}`. Outcomes: `success` / `gate-{1,2,3,4}-refused` / `respawn-failed` / `handoff-write-failed`. No rotation policy in v1 — operator-fired growth is bounded ([§OQ-6](docs/adr/167-cockpit-rotate-verb.md)).
- **Discord refusal** — gate refusals fire the `cockpit-rotate-refused` template; success rotations are intentionally quiet (audit row is source of truth).
- **Exit codes** — `0` success, `64` (EX_USAGE) bad argv, `65` (EX_DATAERR) gate refusal, `70` (EX_SOFTWARE) respawn / handoff-write failure, `78` (EX_CONFIG) caller-scope refusal.
- **Tests** — `tests/unit/verbs/cockpit-rotate.test.ts` (100% line + function coverage on `cockpit-rotate.ts` per fe-1's T6 sweep) + `tests/unit/abstractions/claude-account-wrapper.test.ts` (100% coverage) + e2e capstone (fe-2's T7 — 6 operator-visible runs against a synthetic cockpit cage). EPIC ships: T2 c376f63 / T3 5245e39 / T4 771a104 / T5 057ec5f / T6 990e1f7 / T7 6c98192 / T8 this commit.
- **Docs** — `docs/RUNBOOK-cockpit.md` §6 "Cockpit pane rotation" carries the operator-facing flow (when to invoke, gate matrix, success path, recovery matrix, audit log). [ADR-162 §Amendments](docs/adr/162-atmux-owns-tmux-infrastructure.md) annotates the Rung C formalization. [ADR-167 status](docs/adr/167-cockpit-rotate-verb.md) flips `proposed → accepted`. The `/bruh` skill §3a "manual fallback today" line is operator-managed (claude-skills dotfiles territory); the operator flips it at their next dotfiles-update cycle.

### 🟢 Shipped — `atmux member move | swap | sort` (ADR-161 TR3, t-2f6c81d3, 2026-05-17)

- **[`src/abstractions/tmux-window-orchestrator.ts`](src/abstractions/tmux-window-orchestrator.ts)** (NEW) — shared topographic-normalization primitives consumed by the three new verbs: `resolveMemberToWindowIdx`, `moveMemberWindow`, `swapMemberWindows`, `sortMembersDefaultsFirst`, `candidateWindowNames`. All preserve PIDs + attached clients + claude-process state inside each pane.
- **[`src/verbs/member.ts`](src/verbs/member.ts)** — three new sub-verbs grafted onto the ADR-136 `dispatchMemberSubverb` dispatcher:
  - `atmux member move <id> --to <position>` — absolute reposition (1-indexed per ADR-161 §Open question #3). Auto-picks `tmux swap-window` when the target slot is occupied (preserving the occupant's PIDs) and `tmux move-window` when empty.
  - `atmux member swap <id-a> <id-b>` — pairwise atomic swap via `tmux swap-window` (the version-safe primitive; tmux 1.0+, 2009). Defensive fallback to a three-move temp-index dance if the primitive throws `TmuxError`.
  - `atmux member sort [--defaults-first]` — one-shot normalize per ADR-161 §Decision-anchor #4 canonical order: `team-lead → planner → reviewer → ombudsman` (committer pending ADR-159), then user-added in existing relative order. Iterate-and-swap loop with per-iteration `listWindows` refresh — `move`s shuffle sibling indices, so a stale snapshot would mis-resolve.
- **[`src/abstractions/tmux.ts`](src/abstractions/tmux.ts)** — `tmux.window.swapWindow({source, target})` primitive added alongside existing `moveWindow`. Wraps `tmux swap-window -s -t`.
- **Cockpit refusal** — all three verbs refuse with `UsageError` when the team name is the cockpit reserved literal (`atmux_cockpit` / legacy `atmux_teams`). Defense-in-depth — cockpit lives on its own socket per ADR-162 and has no `team.json`.
- **Team-stopped behavior** — `move`/`swap` no-op with stderr notice; `sort` persists `team.json::members[]` in canonical order so the next `atmux start` materializes windows in place.
- **Persistence** — every successful run rewrites `team.json::members[]` via the existing `updateJson(Team)` flock pattern; ordering is derived from a post-mutation `listWindows` snapshot (authoritative — avoids hand-computed shifts).
- **Tests** — `tests/unit/abstractions/tmux-window-orchestrator.test.ts` (NEW, 23 tests, 100% line + function coverage). `tests/unit/verbs/member.test.ts` extended by 45 tests against a real tmux server with `base-index 1` config (per-test isolated socket). `tests/e2e/member-topographic-normalization.test.ts` (NEW, 8 tests, t-251adc7a) adds the explicit PID-preservation gate per ADR-161 §EPIC-done #3 — captures `tmux.pane.listPanes` PIDs before+after each verb and asserts equality alongside the window-index assertions. Closes §EPIC-done items #3 + most of #4 of ADR-161.
- **Docs (TR4, t-5d90404a)** — README verb-summary entries for `atmux member rename | move | swap | sort`; `docs/ARCHITECTURE.md` §"Tmux topology" gains the default-vs-user-added window-name format table + topographic-normalization verb table referencing ADR-161; `templates/briefs/lead.md` gains a §"Topographic normalization" block; `templates/briefs/planner.md` gains a short aside about reorders not affecting Task ownership; `docs/adr/135-cockpit-naming-convention.md` §Amendment for ADR-161 supersession of §D3 (default-role branch). `gitter` → `committer` cross-references in the canonical-order doc fall back on ADR-159 sequencing.

### 🔄 `atmux sync claude-team-json` — materialize `.claude/team.json` from `.atmux/team.json` (ADR-164)

- **New verb** `atmux sync <subverb>` (dispatcher mirrors `atmux team` / `atmux member`); first subverb `claude-team-json` per [ADR-164](docs/adr/164-sync-claude-team-json.md). Closes the divergence operators hit when migrating off the Claude `/team` skill family — atmux owns the canonical roster at `.atmux/team.json`, the legacy `.claude/team.json` previously had to be hand-edited every `add-member` / `rotate` / `member rename` cycle.
- **Mapping** per ADR-164 §"Context mapping table": `name` verbatim with `lead` → `team-lead` rewrite when `role==team-lead` (matches the Claude `/team rotate-lead` hard-coded identifier); `agentType: "team-lead"` emitted for the lead only; `color` resolved via emoji→color table with `.claude/team-colors.json` sidecar override + deterministic random-from-pool fallback (FNV-seeded on member name); `model` verbatim with `"default"` → `"claude-opus-4-7"` expansion per [ADR-094](docs/adr/094-c-alias-spawn-convention.md); `label`/`lane`/`tui`/`cwd`/`command`/`claudeAccount` dropped (atmux-runtime concerns).
- **`--dry-run`** prints a unified-diff-style preview (+/-/space prefix per field) and exits 0 without writing — safe to fire repeatedly while reviewing.
- **`--overwrite-briefs`** opt-in replacement of hand-authored long-form Claude-side `role` text with the atmux role-enum; preserve-by-default protects expensive briefs from accidental wipe per ADR-164 §OQ-4.
- **`--force`** override for drift refusal. Drift detection compares the on-disk `_atmuxSync.sourceFingerprint` (sha256 over canonical-serialized post-sync roster) to the file's current member roster; mismatch refuses with exit `65` (EX_DATAERR) + 3-line hint per ADR-164 §step 5 + §OQ-5. `--force` proceeds + logs `action=drift-forced` to `.atmux/logs/sync-events.jsonl`.
- **`_atmuxSync` passthrough field** stamped on every write (`{lastSyncedAt, schemaRev: "v1", sourceFingerprint}`). Top-level JSON field per ADR-164 §OQ-1 — the Claude `/team` skill ignores unknown keys, so the marker rides along without breaking the consumer.
- **Docs**: [docs/RUNBOOK-sync.md](docs/RUNBOOK-sync.md) covers operator flow (when to run, dry-run → review → sync, drift recovery, sidecar override). Project [CLAUDE.md](CLAUDE.md) gains a "Migrators" callout. ADR-164's §"Open questions" OQ-6 (auto-cron + post-write hooks) is deferred to a follow-up.

### 🔤 Vocabulary refresh — SV register sweep

- **ADR-158 (proposed)** — `martinet` → `sentinel` rename (cockpit W3 role + schema key + source identifiers). Cockpit role-type identifier change; design preserved verbatim per ADR-132. JSON-shim in `src/core/cockpit.ts::migrateMartinetBlockToSentinel` accepts legacy `martinet:` key for one release cycle with deprecation-warn (mirrors ADR-133 `migrateSuperdoctorBlockToMedic` precedent). Source identifiers renamed via TR2 (`src/abstractions/sentinel.ts`, `src/verbs/sentinel.ts`, `src/core/sentinel-escalation.ts`); same-commit docs sweep via TR4 (this entry).
- **ADR-159 (proposed)** — `gitter` → `committer` rename (in-team git-authority role: brief filename + source identifiers + `TeamMember.role` enum value + cron-template + Discord template prefixes + memory + global/project `CLAUDE.md`). Brief chat-app brand collision (`gitter.im`) + OSS-canon alignment (`committer` matches git's own first-class field). Design preserved verbatim per ADR-134 (in-team auto-merger) + ADR-145 (gitter spawn pattern) + ADR-146 (kanban auto-files trunk-merge); each gets a `## Amendments` annotation pointing here (append-only convention). Schema shim at `TeamMember.role` enum is value-level (`.transform()` canonicalizes legacy `"gitter"` → `"committer"` on parse with deprecation-warn for one release cycle); cron alias `atmux gitter --sweep` retained for one release per migration history. Member id stays `"gitter"` forever per ADR-136 immutability — `<base>-gitter` branch / worktree path / kanban owner are stable across the rename (id-vs-label split, [[project_member_hot_rename_adr_136]]). Source identifiers renamed via TR2 (`src/abstractions/committer.ts`, `src/verbs/committer.ts`, `src/core/committer-sweep.ts`); schema accept-both via TR3; same-commit docs sweep via TR4 (this entry — briefs `gitter.md` → `committer.md` + 11 sibling briefs + README + ARCHITECTURE + PRD + RUNBOOKs + CONVENTION-059 + release-notes README + CLAUDE.md project-local + ADR-134/145/146 §Amendments + memory `feedback_atmux_no_gitter_worker_commits.md` body update + MEMORY.md index). Committer joins ADR-161 default-role set on next `atmux start` — window renders `_committer` (label-only update per ADR-136).

> **Post-0.6.0 follow-ups** (catchup sweep 2026-05-13 per t-a1cc07bc).
> `0.5.0` and `0.6.0` shipped without their own CHANGELOG sections — the
> Epic 1 (pull-model kanban), Epic 2 (whip enrichment), Epic 3 (hot reload),
> Epic 4 (atmux flag) bullet groups below cover the bulk of `0.5.0`'s scope;
> `0.6.0` adds the ADR-077 **superdoctor wave** + ADR-079 / ADR-080 noise-
> drainage + improvement bundles (each bullet now cross-references its ADR
> for traceability). The remaining post-0.6.0 work is grouped below under
> **post-0.6.0 follow-ups** until the next release cut.

### 📐 Proposed — ADR-162 atmux owns its tmux infrastructure (cockpit-socket isolation + canonical `atmux.conf` + version probes)

- **[`docs/adr/162-atmux-owns-tmux-infrastructure.md`](docs/adr/162-atmux-owns-tmux-infrastructure.md)** (Status: proposed) — closes the operator-side foot-gun captured in [[project_atmux_socket_isolation_state.md]]: cockpit windows used to land in the operator's own default-socket tmux server; a stray `tmux kill-server` from the operator wiped atmux + personal state together. ADR §Decision-anchor #1-5 specify dedicated `atmux-cockpit` named socket + canonical `templates/tmux/atmux.conf` loaded via `-f` + two new doctor probes. Implementation spans TR1-TR6 (filed in same session per [[feedback_decomp_same_session_with_deps]]); TR2-TR5 already shipped, TR3 + TR6 land in 2026-05-16. See **🟢 Shipped** entries below for per-TR landings.
- **`atmux cockpit migrate-socket`** (TR3, shipped — see entry below) — one-shot migration verb preserving window topology + scrollback as breadcrumb (PID preservation impossible via tmux primitives — documented in ADR-162 §Amendment 2026-05-16).
- **`templates/tmux/atmux.conf`** (TR4, shipped) — canonical 8-option baseline; loaded via `-f` on every cockpit + per-team session.
- **Doctor probes** (TR5, shipped) — `tmux-version-mismatch` + `cockpit-on-default-socket` (warn-class).
- **`docs/RUNBOOK-cockpit.md`** (TR6 same-commit doc sweep, 2026-05-16) — new 5-section operator runbook covering socket isolation, migration verb, canonical `atmux.conf`, doctor probes, and `ATMUX_COCKPIT_SOCKET` escape hatch. ARCHITECTURE.md gains a §Tmux topology section + new Principles bullet 5.

### 🟢 Shipped — `atmux cockpit migrate-socket` one-shot verb (ADR-162 TR3, t-26346aef, 2026-05-16)

- **New sub-verb** `atmux cockpit migrate-socket` migrates a legacy cockpit session from the operator's default tmux socket to the dedicated `atmux-cockpit` named socket per ADR-162 §Decision-anchor #1 + #4. Idempotent — re-running on an already-migrated cockpit is a no-op. Filed in same session as the TR2/TR4/TR5 implementation per [[feedback_decomp_same_session_with_deps]].
- **Six-phase flow** (per ADR-162 §Decision-anchor #4): discovery on default socket → scrollback capture → recreate session on `atmux-cockpit` socket → recreate windows (additive merge when target session exists) → scrollback breadcrumb to `/tmp/atmux-cockpit-migrate-<epoch>.log` → cleanup legacy session. Both the canonical `atmux_cockpit` session name AND the pre-ADR-135 `atmux_teams` legacy are accepted on the source side; both canonicalise to `atmux_cockpit` on the target.
- **`--dry-run`** previews the planned migration without mutating either socket. Reports discovered legacy windows + cleanup intent; safe to run on production cockpits before commit.
- **`--keep-legacy`** skips Phase 6 cleanup. Legacy default-socket cockpit and new atmux-cockpit cockpit coexist; operator decides when to nuke the legacy via `tmux kill-session -t atmux_cockpit`.
- **`ATMUX_COCKPIT_SOCKET=default` refusal**: when the operator has opted back into the legacy socket via the escape hatch, migration target equals source → refuses with hint to unset the env var.
- **Process-preservation — honest mechanism** (ADR-162 §Decision-anchor #4 amendment): graceful-recreate, NOT PID-preservation. tmux primitives can't transfer running pane processes across servers (sockets) — the PID is bound to a PTY the source tmux server owns; severing severs stdio. ptrace-based reparenting tools (`reptyr`) exist but are not bundled. Scrollback is captured + presented as visual context in the breadcrumb file; operator re-invokes any in-pane Claude/script process in the new panes. Cron-spawned cockpit roles (medic / martinet / sentinel) re-establish themselves on the next cron tick — they're not state-bearing across ticks.
- **Tests** (`tests/unit/verbs/cockpit.test.ts`, ~96% coverage on the new code path): parser arms (bare / --dry-run / --keep-legacy / rejection on rebuild|reload / unknown-verb error mentions new subverb); `buildMigrationBreadcrumb` (per-window separators, empty scrollback placeholder, zero-window edge); mock-driven flow (Phase 1 short-circuit on missing server / no legacy / `ATMUX_COCKPIT_SOCKET=default` refusal; happy-path mixed `atmux_cockpit`+`atmux_teams`; --dry-run zero-mutation; --keep-legacy preserves; idempotent additive merge against pre-existing target; Phase 6 kill-session failure warns + continues; Phase 2 capture failure warns + continues).
- **E2E follow-up**: a real-tmux ephemeral-socket e2e (per ADR-162 TR3 §5) is filed for a sibling Task — the unit-mock coverage of all 6 phases + the deliberate graceful-recreate mechanism narrows the e2e surface to "happy-path on real tmux." Reviewer can request before signoff if desired.

### 🟢 Shipped — atmux 0.8.1 install — templates-dir fix (t-17d413b1, resolves c-003a2a4c, 2026-05-16)

- **Root cause** (verified via `/usr/local/bin/atmux init` repro in `/tmp/atmux-init-test/`): the previous `defaultTemplatesDir()` / `defaultBriefsDir()` resolvers used `resolve(import.meta.dir, "..", "..", "templates"[, "briefs"])` which broke in compiled-bun mode. `bun --compile` produces an ELF where `import.meta.dir` returns a path inside bun's internal $bunfs (rooted at `/`), so the resolve walked to `/templates` (filesystem root). Repro: `atmux init` errored with `fs read failed on /templates/team.example.json`. Same break would hit every brief read from `src/verbs/rotate.ts` + `src/verbs/start.ts` (the `defaultBriefsDir()` consumers) — bug surfaced first on `init` because that's the operator's first call against a fresh install.
- **Fix**: new `src/core/templates-dir.ts` exports `resolveTemplatesDir(env?)` + `resolveBriefsDir(env?)` with a 4-stage resolution chain — (1) `ATMUX_TEMPLATES_DIR` env override; (2) dev-mode probe `<this-file>/../../../templates` via `import.meta.dir` (exists in source tree, falls through when missing in $bunfs); (3) installed-mode probe `<realpath(process.execPath)>/../templates` (resolves `/usr/local/bin/atmux → /opt/atmux/current/bin/atmux → /opt/atmux/<V>/bin/atmux` then up 1 → `/opt/atmux/<V>/templates/`); (4) fallback returns the dev-mode path even if missing so downstream `readJson` / `readText` surfaces a clear actionable error. `src/verbs/init.ts::defaultTemplatesDir` + `src/verbs/rotate.ts::defaultBriefsDir` both delegate to the shared resolver.
- **Companion `build:install` change**: `package.json::scripts.build:install` now runs `sudo rm -rf /opt/atmux/<V>/templates && sudo cp -r templates /opt/atmux/<V>/templates` between the binary install + the atomic symlink swap so the installed-mode resolver has a target. `rm -rf` ahead of the copy makes re-installs of the same version idempotent (handles operators iterating on `build:install` during dev). `docs/RUNBOOK-deploy.md` §Cut procedure step 4 sub-numbered to call out the new static-assets ship step explicitly + cross-link this fix.
- **Version bump `0.8.0 → 0.8.1`** (PATCH per semver — backward-compat bug fix, no new surfaces). `package.json::version` bumped; deployed via `bun run build:install` from the worktree to `/opt/atmux/0.8.1/` + atomic symlink swap. 0.8.0 preserved at `/opt/atmux/0.8.0/` as the rollback target (`ln -sfn /opt/atmux/0.8.0 /opt/atmux/current` reverts in one line).
- **Verification**: post-install `/usr/local/bin/atmux init` in `/tmp/atmux-init-test/` succeeds with no fs read error (full team.json scaffolded with 11 members + tmuxTmpdir + cwd-rewrites). `--version` returns `atmux 0.8.1`. Unit tests in `tests/unit/core/templates-dir.test.ts` (8 tests, 100% line/func coverage on the new module: env override paths, dev-mode probe, edge cases). Installed-mode `process.execPath` branch is exercised via the shell-level repro (can't be covered purely in-process under bun-test because `process.execPath` is the bun binary, not atmux).
- **Complaint c-003a2a4c marked resolved** (high — install UX failure): cross-ref to this commit's SHA in the resolution note.
- **Note on the task body's npm-hypothesis**: the task body proposed adding `templates/` to `package.json::files`. That hypothesis assumes npm-tarball publishing; atmux ships via `bun --compile` to a single-file ELF + sudo install — no npm tarball is involved. The real bug is the resolver's `import.meta.dir` assumption in compiled mode, not a packaging exclusion. `package.json::files` was `null` (i.e. unset) before this fix + remains unset after — irrelevant to the install topology per ADR-047.

### 🟢 Shipped — team-of-teams pre-sopx capstone phase-1 skeleton (t-edc93b42, 2026-05-16) + `docs/RUNBOOK-team-of-teams.md`

- **New `tests/e2e/team-of-teams-pre-sopx.test.ts`** — capstone gate spec authored as a **structured skeleton** (`describe.skip` + 8x `test.todo` covering the full ADR-090/091/134 lifecycle: spawn 2 parallel epics → seed mock Tasks → claim/done lifecycle → auto-merge state machine fan-in to epic-trunk → epic-trunk fan-in to parent-trunk → dissolve-epic → parent KanbanEpic done → no-leakage proof). Fixture-helper signatures locked: `ParentFixture`, `SpawnedEpic`, `LifecycleSnapshot`, `DissolutionResult` interfaces define the phase-2 contract; module-level `activeFixtureDirs` registry + `process.on('exit')` hook + `afterAll` sweep mirror the t-88b60ca7 / c-4698c603 defense pattern so the same cleanup machinery lights up when phase-2 swaps in real fixtures. State-snapshot expectations table (per CLAUDE.md Test finding report pattern) documented in companion RUNBOOK; idempotence proof (post-cleanup snapshot == pre-spawn-baseline) is the closure beat.
- **Phase-1 ship rationale (vs deferring entire file to phase-2)**: reserves the canonical filename + fixture shape so phase-2's diff is implementation-only; documents the INTENDED lifecycle + state-snapshot expectations now while context is hot; locks down helper signatures so phase-2's review gate has a stable structural contract. Per CLAUDE.md "Pair demo runbook beats with rehearsal spec steps" — every RUNBOOK beat name maps to one `test.step()` label verbatim in phase-2; drift surfaces as a failing rehearsal run, not a sopx-flip-morning surprise.
- **WIDER blocker captured in spec header**: phase-2 wires real assertions once gitter sweep fans the following branches into trunk — `geoyws-up-impl-3` (carries 762716f + aac4ee1 + 57b0d0d + b502ebe + a34fafa: ADR-090 schema + spawn-epic/dissolve-epic verbs + ADR-091 state machine + ADR-090↔091 wire-up) + `geoyws-up-impl` (carries ba7ee3f: ADR-092 cross-team tell-lead). All listed branches were `state=null action=queued` or `skipped-in-flight` in the gitter sweep run at 06:14 MYT 2026-05-16; gitter-stuck-bug captured separately at t-f4088323.
- **New `docs/RUNBOOK-team-of-teams.md`** — operator-facing companion: when-to-spawn / sopx-adoption-sequence (8 verbatim beats from driver-inbox 14:03 MYT lines 3122-3132, 1:1 with spec test.step labels) / state-snapshot expectations table (8 stages with parent.KanbanEpic.status / cockpit.epic-entry / worktree / cage / cron-block columns) / failure-mode triage / cross-team tell-lead deferred-to-phase-2 note / doctor D5a/D8/D9 deferred-to-phase-2 note / adjacent-flags from t-cc4c5fd9 audit. `⚠️ Status: phase-1 skeleton` banner at top until phase-2 flips Intended → Verified.
- **Phase-2 deferred to** `t-bc4fdb19` (deps=[t-c2e544b6, ba7ee3f-on-trunk]) with full ADR-092/doctor-D8/D9 + spawn-epic/dissolve-epic real-assertions scope; TODO comment block at end of spec cross-links the 3 cross-team tell-lead paths + 3 doctor checks + 3 adjacent-flag-deferrals so phase-2's claimant has a turnkey wiring spec.

### 🔴 Fixed — `advanceStory` + `advanceEpic` reviewer/team-lead lookup: `dir:` not `teamDir:` for `tryLoadTeam` (t-85846a0b clusters 4+5 of t-2b801707; 8 failures closed)

- **`src/core/story.ts:186`** (`advanceStory` entry) and **`src/core/epic.ts:237`** (`dispatchEpicSummary`): replaced `tryLoadTeam({ teamDir: atmuxDir })` with `tryLoadTeam({ dir: atmuxDir })`. `getAtmuxDir`'s `teamDir` semantics is "project root containing `.atmux/`" (appends `.atmux` to the value); passing the `.atmux/` path itself caused a double-append → `<atmuxDir>/.atmux/team.json` (wrong path; always missed the test fixture's actual `<atmuxDir>/team.json`). The `dir` option is "explicit `.atmux/` path, overrides every other source" per `ResolveDirOpts` — exactly what these call sites have available. Sibling-correct pattern at `src/verbs/groom.ts:565` uses `tryLoadTeam({ teamDir: dirname(atmuxDir) })`.
- **Concrete failure mode**: pre-fix, both call sites threw `ConfigError("no member with role=reviewer in team.json")` / `("no member with role=team-lead in team.json")` regardless of whether the fixture actually had those members. Cluster 4 (advanceStory, 5 fails) and cluster 5 (advanceEpic, 3 fails) of the t-2b801707 release-blocker — both close in this commit.
- **Scope-expand transparency**: t-85846a0b's task body framed clusters 4+5 as "test-fixture additions — missing reviewer / team-lead members". Static analysis disagreed: the global test fixture in `tests/unit/verbs/story.test.ts::seedTeam` (lines 27-42) already seeds `{ name: "lead", role: "team-lead" }, { name: "reviewer", role: "reviewer" }` at the canonical `join(atmuxDir, "team.json")` path. The bug was production-side; the fixtures were always correct. Scope-boundary on T1 (no `src/` touches) bent for the 2-line surgical fix per operator urgency (release-blocker for epic-teams).
- **Cluster 8 deferred to sibling task** (start ADR-063 cockpit auto-reconcile, 3 fails). Static analysis suggests the test recorder + production code's positional args still line up post-ADR-133 rename and post-ADR-135 session-name shift; identifying the precise 3 failures requires bun-test runtime execution which is blocked by [[feedback_pause_bun_tests]] (cage-crash rule). Filed as separate task for test-impl with bun-test access.

### 🟢 Shipped — task update: `--driver-only` / `--no-driver-only` retro-flag (t-2ef0c994; closes the "verb supports retro-flag?" gap)

- **New `setTaskDriverOnly(atmuxDir, id, driverOnly)`** helper in `src/core/kanban.ts` (mirrors `setTaskDeps` shape). Boolean retro-flag setter for ADR-033 `driverOnly`; `true` sets, `false` clears (normalized to `undefined` on write per `task add`'s "only stamp when explicitly true" pattern at line 208 so the on-disk shape stays clean). SQLite-aware via `_useSqlite` / `_withDb` / `transact`; falls through to `updateTaskByIdOrThrow` on the legacy JSON path. Throws `ConfigError` on missing id.
- **`atmux task update --driver-only` / `--no-driver-only`** flag in `src/verbs/task.ts`. Both are boolean flags (no value). Previously `task add --driver-only` was the only entry point — operators who forgot at filing time, or decided to park a Task after filing, had no verb path (the t-2ef0c994 task body explicitly noted "assuming verb supports retro-flag; otherwise direct kanban edit"). Update verb's "at least one of" guard now includes both flags; help text + USAGE_UPDATE string updated.
- **Operational fix applied same session**: `atmux task update t-9319a22c --driver-only` flipped `driverOnly: false → true` on the Supergroomer parking-lot Task. Verified via `atmux task list` showing the `D` marker in the F column. Per the task body's acceptance: t-9319a22c remains visible in `atmux task list --status blocked --json`; auto-pickup by `claim --next --as <member>` is now refuse-gated by `isDriverOnlyBlocked`; `atmux claim t-9319a22c --as driver` retains pickup ability (driver scope bypasses the refuse-gate). Closes the 3+ observed auto-claim loops biting up-impl during 2026-05-15.
- **Same-commit tests** at `tests/unit/core/kanban.test.ts` — 4 new cases in `describe("setTaskDriverOnly", ...)`: set-on-fresh-task, clear-normalizes-to-undefined, idempotent-re-set, missing-id-throws.

### 🔴 Fixed — gitter sweep: `in_progress` no longer blocks re-queue (t-f4088323 P1 — branches stuck while workers task-clean)

- **`src/core/gitter-sweep.ts`** — remove `in_progress` from `IN_FLIGHT_STATES` constant. The initial too-conservative shape (ADR-134 T4 baseline) included `in_progress`, which trapped branches whose dispatcher pre-merge gate (`shouldTransitionFromInProgress`) was held by worker dirty-state at the FIRST tick: once the state was seeded `in_progress`, sweep skipped it forever, so the gate never re-evaluated when the worker became task-clean. Post-fix, `in_progress` is treated like `open` from the sweep's perspective — re-queue every cycle and let the dispatcher re-run the gate.
- **Concrete blocking case observed 2026-05-16 12:2X MYT**: 11/16 branches transitioned to `merger_state=in_progress`, then sat across multiple sweep cycles even after their workers went task-clean. `ba7ee3f` on `geoyws-up-impl` (+2 ahead of trunk) sat 30min stuck; capstone-task `t-edc93b42` was blocked waiting for the trunk-merge so `t-c2e544b6` (ADR-092 dogfood) could claim.
- **Idempotence preserved**: the dispatcher's `shouldTransitionFromInProgress` is idempotent on `in_progress → in_progress` self-loops (BEGIN IMMEDIATE per ADR-134 §state-machine race-protection). A gate-still-held tick returns `{queued:false, reason:"gate-held: <reason>"}`; the sweep records this as `queue-refused` with the dispatcher's note so operators can see WHY the branch didn't advance.
- **Remaining IN_FLIGHT_STATES** (`ready_to_merge`, `rebasing`, `merging`, `tested`, `test_failed`) stay in the skip set — these are genuine mid-walk progress states owned by either the same-tick dispatcher iteration loop OR a caller-driven test gate (the dispatcher's "Stop conditions" loop carve-out for tested/test_failed). Re-queueing these would race the active progressor.
- **Tests at `tests/unit/core/gitter-sweep.test.ts`**: existing `test.each` parameter list trimmed from 6 states to 5 (drops `in_progress`); two new tests pin the post-fix behavior — `state=in_progress + commits ahead → queued` (re-eval gate) and `state=in_progress + dispatcher gate-held → queue-refused` (queue path runs, dispatcher's `{queued:false}` falls through with informative `reason`). Idempotence test's seed transition changed from `in_progress` to `merging` (the original intent — pin sweep-doesn't-double-fire on a mid-walk row); a companion test pins the explicit post-fix `in_progress → re-queue` path.
- **Operator unblock**: branches stuck pre-fix start advancing on the next sweep tick once their workers are task-clean. `t-edc93b42` capstone unblock + `t-c2e544b6` ADR-092 dogfood claim path clear.
- **Skipped optional**: dispatch mentioned options 2 (`--advance <branch>` manual override) + 3 (`--reevaluate` flag) — both deferred to follow-on; the structural fix (option 1, narrowest scope) is sufficient for the live blocker.

### 🟢 Shipped — gitter: post-merge done-flip hook closes duplicate-ship leak at source (t-f8beb03b; Part b of t-dc830eb0)

- **New `src/core/post-merge-task-flip.ts`** + wiring into `src/core/intra-team-merge-dispatcher.ts` (ADR-160 candidate). Closes the duplicate-ship leak at SOURCE: where Part a's groom kanban-vs-git reconcile is read-side reconciliation (catches what already leaked, daily cadence), Part b is write-side prevention — every successful merge tick in the in-team auto-merger scans the just-merged range (`<previousBaseSha>..<mergedSha>`) and flips every referenced open Task to `done` with note `flipped: shipped via merge SHA <hash>` (distinct from groom's `groomed: shipped via SHA` for audit-trail visual distinction).
- **Subject-only matching + EPIC parent-ref filter** mirrored from Part a's t-4ea69dd1 P0 fix: `git log --format=%H%n%s%x00` (subject only; bodies are reference scaffolding, NOT ship signals), plus `PARENT_REF_KEYWORDS = ["EPIC ", "parent ", "Parent: ", "Refs: ", "Ref: "]` filter to skip task IDs preceded by parent-ref keywords in conventional-commits parentheticals. Helpers are intentionally duplicated (not import-shared) per a symmetry contract — both update together when the convention shifts.
- **Dispatcher wiring** in `productionQueueMergeAttempt`: captures `previousBaseSha` from the entry row BEFORE the state-machine walk, captures `mergedSha` during the walk on the `ready_to_merge → tested` transition, then post-walk invokes `flipTasksMergedInRange(atmuxDir, previousBaseSha, mergedSha, opts)`. Wrapped in try/catch — hook failures NEVER fail the dispatcher (merge already succeeded; kanban hygiene is best-effort). Soft-skips on `no-range` (null/empty fromSha — first-ever merge for the branch; that's groom-reconcile's job) and `git-log-failed`.
- **`src/verbs/gitter.ts` wires `atmuxDir` through `ProductionDispatcherDeps`** so the dispatcher's helper can open the kanban DB after every successful merge tick.
- **Window-of-vulnerability closed**: without Part b, members claiming in the 24h window between merge and the next groom tick still hit duplicate-ship pre-flight; the velocity-gate spurious-fire pattern (6× in 75min with 0 SHA per lead's 10:10 MYT outbox ask) recurs whenever groom is behind, even briefly. Post-Part-b, groom-reconcile becomes a backstop, not a primary mechanism.
- **Same-commit tests** at `tests/unit/core/post-merge-task-flip.test.ts` — 12 cases mirroring `groom-reconcile.test.ts`'s coverage: subject-only match → flip with merge-SHA note, body-only → NOT flipped (t-4ea69dd1 mirror), cross-ref guard, EPIC parent-ref guard (verbatim 2026-05-16 commit subjects), Revert ignored, no-range soft-skip (null + empty), git-log-failed soft-skip, skip-not-open, dry-run, first-SHA-wins, range-form invocation `<from>..<to>` + `--format=%H%n%s%x00` assertion.

### 🔴 Fixed — groom reconcile sub-op subject-match-only (t-4ea69dd1 P0 — body-grep was too greedy)

- **`src/core/groom-reconcile.ts`** — change `git log --format` from `%H%n%s%n%b%x00` (subject + body) to `%H%n%s%x00` (subject only). Match `TASK_ID_RE` against the subject line ONLY; commit bodies are no longer scanned. Closes the false-positive class shipped by t-dc830eb0's initial impl: cross-references, EPIC parent refs, deps lists, follow-up filings (`filed as t-X`), CHANGELOG cross-refs all live in commit BODIES, not subjects — they're reference scaffolding, NOT ship signals.
- **Concrete evidence triggering the fix**: 2026-05-16 first live `atmux groom` run flipped 21 actively-open Tasks to `done` as false positives (cross-ref body matches). Lead reverted all 21 to `todo` within minutes. Affected IDs included `t-7e9eed65` (in-flight to up-impl-3), `t-20674483` (ADR-152 EPIC), `t-f8beb03b` (Part b filing-record Task), plus 18 more. `cron-install --template kanban-reconcile-sweep` was unsafe until this fix.
- **Subject-only is the canonical ship signal** per conventional-commits: `feat(scope): t-XXXX — desc` declares "this commit ships t-XXXX". Body content (Closes / Refs / Deps / Cross-refs / CHANGELOG mentions / EPIC parent / Follow-up Tasks) is intentionally NOT scanned — those are coordination scaffolding for human readers, not state-transition signals for automation.
- **EPIC parent-ref filter** (post-dry-run refinement): subject-only matching alone still hit 3/21 false-positives because conventional-commits subjects carry EPIC parent IDs in parentheticals (`(EPIC t-XXXX)`, `(T1 of EPIC t-XXXX)`, `(t-AAAA, EPIC t-BBBB)`). New `PARENT_REF_KEYWORDS = ["EPIC ", "parent ", "Parent: ", "Refs: ", "Ref: "]` constant; `isParentRefAnnotation(subject, matchIdx)` checks the 12-char window before each task ID match against the keyword list (case-insensitive, trailing-space tolerant). Matches preceded by a parent-ref keyword are filtered out of the ship-signal set.
- **Regression-pin tests** at `tests/unit/core/groom-reconcile.test.ts` (14 total now, +2 over t-dc830eb0's 12):
  - "body-only match → NOT flipped" — inverted from the previously-passing flip-on-body-match case (asserts `matched === 0 && flipped === 0 && markDone NOT called`).
  - "cross-ref guard: subject names A, body names B → only A flips" — pins the body-grep bug fingerprint with 5 body mentions of B; only A flips.
  - "EPIC parent-ref in subject → NOT flipped" — pins the 3-of-21 EPIC-parenthetical fingerprint with the verbatim 2026-05-16 commit subjects (`(T1 of EPIC t-83dcef6b)`, `(t-63e3ddc2, EPIC t-51d2c635)`, `(t-f58c6ccc, T1 of EPIC t-5df48a74)`); only shipping IDs flip; EPIC IDs stay open.
- **Live verification**: post-fix `bun -e "reconcileKanbanVsGit(...)"` dry-run against the current kanban + git state reported `scanned: 58, matched: 0, flipped: 0` (no false-positive flips; legitimate ship signals already done in kanban). Pre-fix had matched 21 false-positives.
- **No flag added** — `--kanban-reconcile-strict` (default true with `--no-strict` for body-grep forensics) was in the dispatch as "Optional"; skipped for minimal P0 scope. Future forensics use can shell `git log --all --grep=t-XXXXXXXX --format=%H` directly, which is what the old body-scan was approximating.
- **USAGE_TEXT sub-op #7 description** updated to name the subject-only constraint explicitly; cron template (`kanban-reconcile-sweep`) becomes safe to install post-fix.

### 🟢 Shipped — groom: kanban-vs-git reconcile sub-op auto-flips shipped tasks to done (t-dc830eb0; Part a of two-part fix)

- **New `src/core/groom-reconcile.ts`** + sub-op #7 wired into `src/verbs/groom.ts`. Single bulk `git -C <repo> log --all --format=%H%n%s%n%b%x00` per groom run; for every open task (status ∈ {todo, in-progress}) whose ID appears in a non-revert commit's message (subject or body), auto-flip to `done` with note `groomed: shipped via SHA <hash>`. First SHA wins (git log default reverse-chrono order). Idempotent — re-running on already-done tasks is a no-op (filter scopes to open statuses only). Safe — `Revert ` / `Revert "` subjects are treated as not-a-ship-signal so a revert of a ship doesn't re-flip the task.
- **Closes the duplicate-ship dispatch-collision pattern** (lead 10:10 MYT P0 outbox ask): every claim was hitting `git log --all | grep <id>` pre-flight to avoid duplicate work; velocity-gate fired 6× in 75min with 0 SHA because every dispatch redirected on duplicate-detect (concrete cases: t-a5b01d24 / t-b3a69ac6 / t-82b6aed9 all shipped 2h ago with commit-msg referencing Task ID verbatim, still flagged `todo` in kanban).
- **Default-on; `--no-reconcile` opt-out** for projects that don't follow the "commit msg references Task ID" convention or for one-off groom invocations during a partial-history bisect. Sub-op error-contained — failures (non-versioned project, git log non-zero exit) surface as `skippedReason` not throws; groom returns 0 even when reconcile bails.
- **Runs after lane-drift-check + summarizeKanban** so the open-tasks list reflects post-sweep state, and **before `--archive`** so reconciled-done tasks become eligible for the same-run state.db archive move. Per-task `markTaskDone` invocation passes `callerScope: "driver"` (groom is a system maintenance verb invoked by cron — bypasses ADR-033 driver-only refuse-gate intended for member-pane mistakes, not the daily reconcile).
- **Same-commit tests** at `tests/unit/core/groom-reconcile.test.ts` — 12 cases: subject-only match, body-only match, Revert-commit ignored, no-match no-op, dry-run (no markDone calls), repoDir-missing soft-skip, git-log-failed soft-skip, first-SHA-wins, non-task-ID prefixes (c-/d-) ignored, empty-open-tasks (no git spawn), multi-task mixed match/no-match, --all flag verification. Plus a `tests/unit/verbs/groom.test.ts` update for the new `noReconcile` field in `ParsedGroomArgs`.
- **Companion to [ADR-160 candidate](docs/adr/) (Part b: post-merge done-flip in gitter)** — read-side reconciliation here closes the existing leak; Part b's write-side prevention closes the leak at source by extending [ADR-134](docs/adr/134-in-team-auto-merger.md) T9's production merge dispatcher to call `atmux task move <Task-ID> done` immediately after a merge, parsing the Task ID from the merge commit body. Filed as follow-on task; this commit ships Part a only.

### 🟢 Shipped — groom: wire `--inbox-days` flag → per-entry `## Open` → `## Archive` aging (t-82b6aed9; closes complaint c-7a308f7f)

- **New `ageInboxOpenToArchive(atmuxDir, days, opts)`** in `src/core/groom.ts` (t-82b6aed9). Closes the gap at `src/verbs/groom.ts:60` ("Reserved per bash flag set; not yet consumed") + `:207` ("Reserved for future per-entry inbox parsing") — the `--inbox-days` flag was parsed, validated, defaulted to 7, then dropped. Sub-op parses `driver-inbox.md` + `lead-outbox.md` into HEAD / OPEN / ARCHIVE segments via `## Open` / `## Archive` headers, splits OPEN body on `- [HH:MM MYT ...]` entry-start prefixes (continuation lines attach to preceding entry), parses each entry's timestamp (MYT = UTC+8, today-implicit when date omitted), and migrates entries older than `now - days*86400s` to the same file's `## Archive` section in OPEN order (preserves newest-at-top within ARCHIVE). Unparseable-timestamp entries stay in `## Open` (conservative — convention-violating rows shouldn't silently move).
- **`--aggressive` synonym for `--inbox-days 0`** in `src/verbs/groom.ts` — one-shot historical-bloat clear that moves every entry in `## Open` to `## Archive` regardless of timestamp shape. Use case from complaint c-7a308f7f: sopx team's 10668-line `lead-outbox.md` + 461-line `driver-inbox.md` accumulated across the markdown-storage scaling-wall; aggressive clears the residue in one tick. `--inbox-days 0` at the sub-op layer behaves identically; `--aggressive` is the operator-readable surface in cron lines + manual invocations.
- **Order BEFORE `flushInboxOutboxArchive` in groom verb body** so the just-aged entries get swept to the monthly archive file in the SAME groom pass. Without this ordering, aging would land in `## Archive` but require a SECOND groom tick to reach the monthly file — leaving inbox bloat on the demo path for up to 24h. Task body originally said "Order AFTER" but the "same pass" intent requires chronological-before — fix interpretation applied with cross-ref in the source comment.
- **Same-commit tests** at `tests/unit/core/groom.test.ts` — 4 `ageInboxOpenToArchive` fixture cases (all-fresh, all-stale, mixed-with-unparseable, aggressive) + dryRun-no-mutate + archive-header-synthesis + `sliceOpenArchive` / `parseEntryTimestamp` / `parseOpenEntries` unit coverage. Includes a `tests/unit/verbs/groom.test.ts` update for the new `aggressive` field in `ParsedGroomArgs`.
- **Stopgap until [ADR-154](docs/adr/154-driver-inbox-lead-outbox-sqlite-migration.md)** (markdown→SQLite migration for driver-inbox + lead-outbox, EPIC t-2298cbb0). Post-cutover the legacy `.md` files become read-only renders of SQLite rows and this sub-op becomes dead code. Operator pick per the dispatch literal: ship aging stopgap NOW to clear sopx 10668-line bloat immediately rather than wait for ADR-154 T2-T6.

### 🟢 Shipped — ADR-139 T5 e2e — refusal auto-rotate cold-start walk

- **New `tests/e2e/refusal-pattern-auto-rotate.test.ts`** per [ADR-139](docs/adr/139-refusal-pattern-auto-rotate.md) §D1-D5 + T5 (t-f596a318). Walks the full chain end-to-end: pane capture → `classifyRefusal` (T2) → `refusal_events` write (T3) → threshold check (T2 `shouldRotate`) → `atmux rotate` spawn (T4) → rotations log append + cap accounting + complaint file + Discord `[member-refusal-rotate]` fire. Each scenario re-seeds a throwaway tmpdir + in-memory state.db per `beforeEach` — stateful 1x cold-start walks per CLAUDE.md testing discipline.
- **Six scenarios cover the EPIC acceptance gate**: (1) 3 soft events → rotate fires + log row + Discord 🟡; (2) 2 hard events → rotate with class=hard; (3) 1 role event → instant rotate; (4) cap exhaustion (3/day) → 4th trip files complaint + emits 🚨, NO spawn; (5) exempt member → events recorded for audit but rotation skipped; (6) backward-compat — team without `refusalDetection` block → defaults apply + rotate fires on 3 soft events.
- **Mocking shape**: `paneCapture` returns pre-canned ADR-139-classifier-matching strings per beat (real classifier runs on the captures); `openDb` pins to `:memory:`; `spawnAtmux` + `sendDiscord` are recorders. Per ADR-139 T5 task body's "OR by seeding pre-recorded captures into a fake tmux capture-pane shim" carve-out — full live tmux is unnecessary for the trigger-chain proof.
- **Same-commit doc update**: `docs/RUNBOOK-stall-recovery.md` gains a `[member-refusal-rotate]` runbook entry mirroring the existing `[whip-modal-cycling]` shape — what fires it, auto-recovery surfaces, manual escalation steps, per-team opt-out JSON, rehearsal commands. Per CLAUDE.md "pair demo runbook beats with rehearsal spec steps" rule — runbook reads against the e2e walk's beats.
- **EPIC complete**: ADR-139 T1+T2+T3+T4+T5 all shipped. Reviewer flips `Status: Proposed` → `Status: Accepted` in the follow-up `chore(adr)` commit.

### 🟢 Shipped — ADR-139 T4 refusal-rotate trigger + cap (`team.json::refusalDetection`)

- **New `team.json::refusalDetection` Zod block** per [ADR-139](docs/adr/139-refusal-pattern-auto-rotate.md) §Config + T4 (t-a830d2ee). Strict-mode shape (ADR-054 §D3 drift detection — typos like `softTreshold` reject at load): `enabled`, `softThreshold`, `hardThreshold`, `roleThreshold`, `windowMin`, `exemptMembers`, `maxRotationsPerDay`. All fields optional; absent block resolves to defaults via `resolveRefusalConfig(team.refusalDetection)`. Defaults mirror ADR-139 §D3 table verbatim (soft=3, hard=2, role=1, window=30min, cap=3/day per OQ-2).
- **New `src/core/refusal-trigger.ts::runRefusalTriggerForTeam`** — the trigger glue between SCAN+RECORD (T3) and `atmux rotate` fire. For each team member: read recent `refusal_events` rows (via T3's `listRefusalEventsForMember`), apply outer gates (exempt members, day-cap), call `shouldRotate` (T2 pure decision), spawn `atmux rotate <member>` on green, append row to `<atmuxDir>/state/refusal-rotations.log` (tab-separated, UTC day-key in column 2 for cap arithmetic), file complaint on `cap-hit` HARD escalation, emit Discord `[member-refusal-rotate]` template. Every collaborator (DB, spawn, clock, fs append, Discord send, member filter) is dep-injectable.
- **Cap-hit + spawn-failed HARD paths** — when today's rotation count ≥ `maxRotationsPerDay`, the trigger files a deduped complaint (sourceKind=`refusal-trigger`, sourceId=`refusal-cap-hit:<team>:<member>:<UTC-day>`) AND emits the Discord template with `escalation: 'cap-hit'` → 🚨 verdict + 🙏 Need-from-George bullet. When the rotate spawn returns non-zero exit, the trigger still records the attempt (next tick re-fires if events keep landing) AND emits `escalation: 'spawn-failed'` → 🚨 verdict naming the failure.
- **New Discord `[member-refusal-rotate]` typed renderer** at `src/abstractions/discord.ts::renderMemberRefusalRotate` per CLAUDE.md §Discord format rules. Verdict-first (single load-bearing line), category emoji 🔄 (green path) or 🚨 (HARD path), `topPhrases` surface as 📋 trigger bullets, footer carries `rotations today: N/maxRotationsPerDay · window Xmin`. Mobile-triage on a phone: one verdict line + one footer + (HARD-only) one Need-from-George bullet.
- **Same-commit tests** at `tests/unit/core/refusal-trigger.test.ts` (12 tests: outer gates `disabled`/`exempt`/`skip-no-events`/`skip-below-threshold` + threshold-crossing paths soft/hard/role + cap-hit complaint-file + spawn-failed escalation + log-row UTC-day-key format), `tests/unit/schema/team.test.ts` (12 tests: TeamRefusalDetection empty/full/partial/strict-rejection/default-constant/resolveRefusalConfig defaults applier + Team-integration), and `tests/unit/abstractions/discord.test.ts` (5 tests on the new renderer: rotate vs cap-hit vs spawn-failed verdicts, single-event plural-drop, empty-phrases footer fallback).
- **Same-commit doc updates** — ADR-139 §Implementation plan §Progress annotates T2+T3+T4 ship status; deferred §D4 post-rotate verification path called out so reviewers don't ask "where's the T+5min re-scan" mid-review.
- **Out of scope this commit** — T5 e2e proof (synthetic refusing pane fixture + threshold trip + rotation observation + cap exhaustion + exempt verification); the T+5min post-rotate re-scan (scheduler concern per ADR-139 §D4 — belongs in medic's hourly loop or a dedicated cron, not the trigger module); LLM-based classification (per EPIC out-of-scope); cross-team aggregation (Phase 2). Reviewer flips ADR-139 Proposed → Accepted once T5 lands.

### 🟢 Shipped — ADR-139 T3 refusal-event scan + record (`atmux refusal-scan`)

- **New `atmux refusal-scan` verb** per [ADR-139](docs/adr/139-refusal-pattern-auto-rotate.md) §D2 + T3 (t-841049e4). Captures each team member's tmux pane, runs the ADR-139 T2 classifier (`src/core/refusal-classifier.ts`), and records positive results to a new per-team `refusal_events` SQLite table. Record-only — threshold-trigger logic + auto-rotate fire path ship in T4.
- **Migration v6 → v7** in `src/abstractions/sqlite-migrations.ts` materialises `refusal_events(id TEXT PK, member TEXT, team TEXT, phrases TEXT JSON, severity TEXT, confidence REAL, detected_at INTEGER, minute_bucket INTEGER)` + `UNIQUE(member, minute_bucket, severity)` idempotency constraint per ADR-139 §D2. Same-minute re-scans (medic + martinet ticks overlapping inside 60s, or a tick double-firing on retry) collapse to a single row via `INSERT OR IGNORE`.
- **Pure-of-direct-IO core** at `src/core/refusal-scan.ts` — `scanTeamForRefusals(team, atmuxDir, deps)` walks members, classifies, records via `recordRefusalEvent`. Every external collaborator (pane capture, classifier, DB factory, clock, member filter) is dep-injectable so unit tests pin all dimensions without touching disk or tmux. `listRefusalEventsForMember` exposes the read-side surface T4's threshold gate consumes.
- **Medic invocation contract** (ADR-077 §F7 annotation): medic's hourly per-team sweep now fires `atmux refusal-scan --team-dir <path>` once per enabled team, after the existing complaints sweep. Verb is a record-only no-op when zero detections land — safe every tick. Skill prompt at `~/.claude/skills/superdoctor/superdoctor-prompt.md` (dotfiles-managed per ADR-141 + memory `[[feedback_claude_skills_dotfiles_territory]]`) picks up the hook out-of-band — atmux side ships the verb + ADR annotation.
- **Martinet forward-compat hook** (ADR-132 §D1 cross-ref + new `templates/briefs/martinet.md` scaffold). Same verb at 270s cadence makes martinet the primary detector once its skill prompt lands (post-ADR-132 T8); medic stays the hourly backstop. Shared `UNIQUE(member, minute_bucket, severity)` constraint makes concurrent ticks safe.
- **Same-commit tests** at `tests/unit/abstractions/sqlite-migrations.test.ts` (7 tests on the v6→v7 ladder: column shape + types + NOT NULL + PK, UNIQUE constraint, `json_valid` CHECK, round-trip, INSERT OR IGNORE dedup, severity-differentiation, secondary index presence) + `tests/unit/core/refusal-scan.test.ts` (15 tests across `recordRefusalEvent`, `listRefusalEventsForMember`, `scanTeamForRefusals` happy + dedup + capture-failure + empty-capture + member-filter paths).
- **Out of scope this commit** — T4 threshold-trigger logic + `atmux rotate-member` fire + Discord template + complaint wire (`refusal-threshold.ts::shouldRotate` reads the rows this verb writes); T5 e2e proof (synthetic refusing pane + threshold trip + rotation observation); LLM-based classification (v2 if regex false-negatives become operationally meaningful); cross-team aggregation (Phase 2). Reviewer flips ADR-139 Proposed → Accepted once T3+T4+T5 land.

### 🟢 Shipped — ADR-050 §Brief generator (Tier 2 fallback brief composer)

- **New `src/core/fallback-brief.ts`** per [ADR-050](docs/adr/050-fallback-chain.md) §Brief generator (t-d15b23da). Pure-of-direct-IO module: `composeFallbackBrief(opts)` reads the member's pre-pause in-progress Task body + `templates/briefs/<role>.md` + `git log --oneline -10` + `lead-outbox.md` tail (50 lines), assembles per ADR-050 §step 1-5 order, writes to `<atmuxDir>/state/fallback-brief-<member>.md`. Cage spawn (`src/abstractions/fallback-cage.ts`) pipes this as the initial prompt to `cursor-agent --print`.
- **Tier-2 guardrails preface** inserted verbatim from ADR-050 §step 3: 4 lines naming the executor (`cursor-agent`), the original member, the SAME-branch + SAME-commit-prefix commit policy, the `atmux reply '[fallback-cursor]'` exit protocol, and the mid-resume teardown notice. Substitutes the original member name + agent name at compose time.
- **Missing-input degradation**: per-section notice lines when an input is missing (no in-progress task / brief template absent / git log empty / lead-outbox empty). Composer NEVER throws; the cage agent always sees a coherent document even when state is partial.
- **Dep-injection seams** on every reader (gitLog / readTemplate / readLeadOutboxTail / writeBrief / taskBody override) — unit tests pin deterministic inputs without touching disk or shelling git. Default impls fall through to `Bun.file` / `runSpawn` / `loadInbox`.
- **Same-commit tests** at `tests/unit/core/fallback-brief.test.ts` — 12 tests across 6 describe blocks (happy path, guardrails preface, missing-input degradation x5, section ordering, git-log fail-soft, result-shape contract). 100% line coverage on the new module.
- **Out of scope this commit** — `src/verbs/whip.ts` extension that fires the composer at sustained-pause detection (T2 dep: `t-5881225a` ADR-050 §Trigger semantics); resume-continuity composer (T3 dep: `t-8ec31d4d` ADR-050 §Resume continuity); e2e (T4 dep: `t-7c491368` ADR-050 §E2E gate).

### 🟢 Shipped — ADR-141 Claude shared skills + memories (atmux-side scripts)

- **New [ADR-141](docs/adr/141-claude-shared-skills-memories.md)** — canonical layout under operator's dotfiles repo (`~/work/journals/.sb/_dotfiles/claude-shared/`) with per-account symlinks. Memory + skill workspace dirs shared across all five `~/.claude*` accounts; auth + sessions + plugin-cache + settings.json stay strictly per-account.
- **`scripts/claude-shared-audit.sh`** — read-only audit. Walks every `~/.claude*/projects/*/memory` + `~/.claude*/skills/*` (workspace dirs only — plugin-cache symlinks skipped), reports per-project diffs / sizes / suggested winner (most-recent-mtime) / conflict flag. Pre-flight checks for canonical store presence + running `claude` processes. Safe to run any time.
- **`scripts/claude-shared-migrate.sh`** — dry-run-by-default migration. `--apply` writes changes; refuses to run with `--apply` if any `claude` process is alive (sessions-stopped invariant per ADR-141 §D5; `--force` overrides at operator's risk). Per-project: backup losing-side content to `_archive-<DATE>/`, move winner to canonical, symlink each account's path. Idempotent re-run.
- **Out-of-scope for this commit** — the dotfiles-repo deliverables (`_dotfiles/init-claude-shared.sh` + `_dotfiles/README-claude-shared.md`) and the actual migration execution + cross-account smoke test live in operator's dotfiles repo (`~/work/journals/.sb/_dotfiles`, sibling repo). Operator runs `scripts/claude-shared-migrate.sh --apply` with sessions stopped, then commits the canonical-store + init-script in the dotfiles repo separately.

### 🟢 Shipped — kanban auto-emit trunk-merge Task on Story-done (ADR-146 T2)

- **New `KanbanStory.branch` field** per [ADR-146](docs/adr/146-kanban-auto-files-trunk-merge.md) §D4 — source branch this Story's work lives on (typically `<base>-<member>` per ADR-082+084). Rides through the `extra` JSON column on the `stories` table; zero-migration roll-out.
- **`moveTask` hook** — when a Task's status transitions to `done`, if it's the last non-done child of a branched Story AND the team has `worktreeIsolation: true`, atmux auto-files a `merge t-xxx (branch→trunk): <source-branch> → trunk` Task per ADR-146 §D1+D2 — assigned to `gitter` (or per `autoEmitTrunkMerge.fallbackAssignee`). The auto-file lands in the SAME `BEGIN IMMEDIATE` transaction as the move-to-done write, so the ADR-032 task-done cascade wakes only after BOTH rows commit (no false-positive idle nudge per §Atomic).
- **Short-circuit rules** per ADR-146 §D5: Story without `branch` set, team without `worktreeIsolation`, `autoEmitTrunkMerge.enabled === false`, `Story.branch === team.merger.baseBranch` (when `shortCircuitOnSharedBase: true`), remaining non-done siblings, OR done-Task subject already matches the auto-emit pattern (loop-prevention) — any of these skip emit cleanly.
- **New `team.json::autoEmitTrunkMerge` config block** per ADR-146 §D7 — `enabled` (default `true` when `worktreeIsolation: true`, `false` otherwise), `fallbackAssignee` (default `null` = unassigned), `shortCircuitOnSharedBase` (default `true`). Strict-mode Zod block; typos rejected per ADR-054 §D3 drift detection.
- **Backfill script** at `scripts/backfill-story-branch.ts` — dry-run by default; `--apply` walks every Story with status `in-progress`/`testing`/`review`/`merging`/`done` and infers `<base>-<member>` from child-task owners when all children share a single declared member. Conservative (skips Stories with mixed owners or non-member owners — operator can hand-backfill via SQL). Idempotent; safe to re-run.
- **Out of scope this commit** — `atmux story update s-xxx --branch <b>` verb (deferred per OQ-1 to a future commit); cron-backstop trunk-merge (already handled by ADR-134 §state-machine cron path); `tested → merged` test-gate chaining (separate ADR per §D6).

### 🟢 Shipped — ADR-147 release-event verify (t-3b2d1a26, 2026-05-16) + `docs/RUNBOOK-deploy.md`

- **Release-event verify executed against fresh 0.8.0 install.** `atmux ombudsman tick` under the byte-equal cron env (`PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin TMUX_TMPDIR=<team-tmux-dir> ATMUX_DIR=<team-atmux-dir>`) returned `ombudsman tick: sentinel empty — no-op` (exit 0, steady state — no queued complaints). `atmux gitter --sweep` under the same env returned a rich dispatcher state-machine summary (`team='atmux' base='geoyws' checked=16 queued=1 refused=0 skipped=15`) with one fan-in queued (`geoyws-up-impl +1`). Both `<atmux-dir>/logs/{ombudsman,gitter-sweep}.log` had pre-install `atmux: unknown verb: …` lines through `May 16 06:00` (last 0.7.2 tick) — proves the ARMED-but-no-op → DRAINING flip happened exactly at 0.8.0 swap-in. ADR-135 resolver smoke also re-verified (this verify's `atmux send lead …` calls all exited 0 against the same `🧭-lead` window that 0.7.2 had failed on minutes earlier).
- **New `docs/RUNBOOK-deploy.md`** documents the build:install cut procedure (semver call → CHANGELOG roll → trunk commit → `bun run build:install` → push trunk) + the post-install release-event verify gate (--version round-trip → cron-env verb-presence smoke → cron-log tail proof → ADR-135 send-lead smoke) + one-line atomic rollback + trigger-discipline note for dispatch-only parking-lot Tasks (`⚠️ DO NOT CLAIM via claim --next` convention marker). Cross-refs ADR-047 / ADR-134 §T7 / ADR-147 / ADR-135.
- **Trigger-discipline reinforcement**: t-3b2d1a26's body opens with `⚠️ DO NOT CLAIM via claim --next` and supersedes a previously-closed `t-921deabc` whose looser body language caused a false self-claim 2026-05-16 06:08 MYT. The new RUNBOOK §Trigger discipline (parking-lot Tasks) captures the convention so future release-event parking-lot Tasks inherit the marker rather than reinventing.

### 🟢 Shipped — atmux 0.8.0 install (t-eda081cf, 2026-05-16)

- **Version bump `0.7.2 → 0.8.0`** (`package.json`) + `bun run build:install` cut a fresh binary to `/opt/atmux/0.8.0/bin/atmux` with atomic symlink swap (`/opt/atmux/current → /opt/atmux/0.8.0`; `/usr/local/bin/atmux` unchanged, still resolves through `current`). Rollback target preserved at `/opt/atmux/0.7.2/` (and earlier 0.3.0–0.7.1 dirs) — `sudo ln -sfn /opt/atmux/0.7.2 /opt/atmux/current` reverts in one line.
- **Minor bump rationale**: 0.8.0 packages four backward-compat surface additions accumulated since 0.7.2 (May-13) — `atmux gitter` verb (ADR-134 T9 production merge dispatcher), `atmux ombudsman` verb (ADR-147 T9 complaints sweeper), `atmux cron-install --template gitter-sweep` + `--template ombudsman-tick` options (ADR-134 T7), and the ADR-135 hyphenated-window-name resolver (closes the live `/usr/local/bin/atmux` failure mode `tmux: can't find window: 🧭lead`). No breaking removals — existing `cockpit.json.superdoctor` block still loaded via back-compat shim per ADR-133 (TR8 follow-up scheduled for next release per the existing `🚨 Coming next release` row below).
- **Deploy-time CHANGELOG note**: the bulk of this `[Unreleased]` block was authored against 0.7.2-as-baseline and SHOULD migrate into a formal `## [0.8.0] — 2026-05-16` named section per Keep-a-Changelog; deferred from this deploy commit to keep the diff scope narrow (release-cut housekeeping is a separate Task) — the per-section `🟢 Shipped` / `📋 Proposed` / `🏷️ Renamed` / `⚙️ Migration` / `⚠️ Deprecated` glyphs already encode shipped-vs-pending status in place.

### 🟢 Shipped — ADR-147 ombudsman + release-notes dogfood (T9) + SQLite legacy-DB rescue

- **ADR-147 status flipped `proposed → accepted`** ([docs/adr/147-ombudsman-and-release-notes.md](docs/adr/147-ombudsman-and-release-notes.md)) per its own T9 gate: atmux-team's `.atmux/team.json` gained an `ombudsman` member entry (`emoji: ⚖️`, `claudeAccount: personal`) + `ombudsman: { enabled: true, tickIntervalMins: 15 }` config block; `atmux start` spawned the ombudsman pane (window `⚖️-ombudsman`); ombudsman bootstrap-time drained the singleton open complaint (`c-7a308f7f` groom `--inbox-days` aging gap) by filing task `t-82b6aed9` (planner-routed) + resolving the complaint with cross-ref to ADR-154's SQLite migration; day-file `docs/release-notes/2026/05/2026-05-16.md` landed on `geoyws-ombudsman` @ `b68f2b4`. `atmux cron-install --template ombudsman-tick` installed the `*/15` cron line in the atmux team's crontab block (verified via `crontab -l | grep ombudsman`). End-to-end annotation table + dogfood findings appended to the ADR.
- **SQLite legacy-DB rescue (precursor commit `ed24844`)** — `fix(sqlite-migrations): legacy DB rescue + idempotent CREATEs`. Pre-T9 state.db was at `user_version=4` with `superdoctor_hygiene` present but `superdoctor_attempts` absent — the pre-renumber `v3→v4` (which was hygiene before the 2026-05-14 16:05 MYT renumber) ran, but the renumbered new `v3→v4` (attempts) never did. Worktree atmux crashed on every state.db open with `SQLiteError: table superdoctor_hygiene already exists` (sqlite-migrations.ts:218) which would have blocked every member running new-build atmux until `/usr/local/bin/atmux` is bumped. Fix: `IF NOT EXISTS` guards on v3→v4 (attempts) + v4→v5 (hygiene) `CREATE TABLE` + `CREATE INDEX`, plus a new `v6→v7` migration that re-runs the v3→v4 SQL idempotently to backfill the missing table on legacy DBs. 3 new tests in `tests/unit/abstractions/sqlite.test.ts` (legacy seeded state walks to highest version, fresh DB walks v0→highest, re-open is no-op) — 9 tests pass total, 100% line/func coverage on `sqlite-migrations.ts`. Live state.db now at `user_version=7` with both tables present.

### 🟢 Shipped — ADR-157 T6 e2e goal-primary-drain + failure-injection matrix

- **New e2e** at `tests/e2e/goal-primary-drain.test.ts` per ADR-157 T6 (`t-869a0226`). Deps T3 (`05e9b9c`) + T4 (`33f995c`) + T5 (`675600b`) all shipped this session. Validates the full /goal-primary-drain wiring end-to-end across the lane-tick + goal-injection + cron-cadence stack via the `LaneTickDeps` dependency-injection seams (no real tmux / no real Anthropic API for the CI default path).
- **Mock-default + ATMUX_E2E_LIVE=1 opt-in** per task body. Live mode is a placeholder pending real Claude Code pane availability with `/goal` skill (v2.1.139+); CI runs the mock matrix sub-second.
- **Cell 1 — Latency benchmark (structural proxy)**: 5-tick treatment vs baseline. Treatment (goal-active claude) → 5/5 `skip-goal-active` outcomes, ZERO send-keys fired (drain handled by /goal evaluator). Baseline (goal-inactive claude) → 5/5 `injected` outcomes (cron-driven claim-injection). Ratio assertion 0:5 proves the wiring is correct — real wall-clock latency is sub-second in treatment (when wired to a live Haiku evaluator) and ~150s mean in baseline at the */5 cron cadence T5 ships.
- **Cell 2 — Failure-injection backstop (3 cases)**:
  1. Rate-limit pane → `skip-not-ready` (NOT `skip-goal-active`) — pane-health signal preserved per T4 reviewer pre-flag #1 ordering.
  2. Dead-pane / shell prompt → `skip-not-ready` — lane-tick is the external observer.
  3. Compaction-wipe simulation → `skip-not-ready` — DOCUMENTED as **Branch A-prime** in the spec header: neither "still skip claim-injection" (A) nor "fall back to claim" (B), but "skip via pane-health, defer to operator-driven `atmux rotate` recovery." If operator experience reveals this is too operator-heavy (auto-rotation desired), file an ADR-157 amendment to wire a rotate-on-compaction-detected hook.
- **Cross-check** — Cursor carve-out (§D4) cross-check at e2e level: `runtime: "cursor"` + `goal` set → claim-injection RUNS (cursor has no /goal skill; cron is the only drain). Confirms T4's runtime-gate honors §D4 contract under e2e wiring, not just at unit level.
- **Spec header docstring documents non-idempotence** per CLAUDE.md §Testing Discipline ("Stateful e2e specs are not repeatable smokes"). Each cell stages a fresh tmpdir + tmpdir-scoped `team.json` + `state/session.txt`. No live `~/.atmux/cockpit.json` reads, no live `~/.atmux/state/*` writes — reviewer pre-flag honored.
- **`setDefaultTimeout(120_000)`** per CLAUDE.md bun-test integration rule. Mock mode actually runs sub-second; the headroom is for the cell-scaffold tmpdir creation.
- **Tests**: 7/7 pass + 1 skip (live mode placeholder). Typecheck clean.
- **ADR-157 EPIC code-path scope COMPLETE this session**: T1 draft (`fa5d9c7`) → T2 schema/resolver (`8bbf28c`) → T3 injection (`05e9b9c`) → T4 lane-tick narrow (`33f995c`) → T5 cadence relax (`675600b`) → T6 e2e (this commit). T7 (dogfood, gated on ADR-151 unblocker landing) is the only remaining sub-task.
- **Out of scope**: dogfood on atmux team (T7 — `t-6f8d27e8`, gated on ADR-151 unblocker `t-fba73bf8`); cross-team /goal coordination (not in v1); Cursor-side /goal equivalent (no upstream skill); ATMUX_E2E_LIVE wired against real Claude Code pane (deferred — operator validation gate).

### 🟢 Shipped — ADR-157 T5 cron cadence relaxation `*/2` → `*/5` (lane-tick)

- **Cron template lane-tick cadence relaxed from `*/2 * * * *` to `*/5 * * * *`** per ADR-157 T5 (`t-e847d0ae`). Closes the EPIC's drain-mechanism shift: T3 (/goal injection) + T4 (lane-tick goal-narrow) together mean Claude members drive their own loop via the per-turn Haiku evaluator; lane-tick narrows to a structural backstop for failure modes /goal cannot see (wedged panes, rate-lockouts, compaction-wipe). Sub-2-min cadence is no longer needed.
- **Per-team override `team.crons.laneTickMins`** (sibling to `laneTickEnabled`, mirrors the ADR-148 cadence-knob pattern). Optional; default `5` (new constant `DEFAULT_LANE_TICK_CRON_MINS`). Schema-side refinement REJECTS non-divisors of 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60); `cronEvery` rejects non-divisors as a second line of defense.
- **Lower bound floor** is /goal mean-time-to-detect-failure × 2 (~5min); **ceiling** 10min acceptable with operator validation. Teams that want the pre-T5 fast cadence can opt into it explicitly via `crons.laneTickMins: 2` — backward-compat path verified by test.
- **Operator-facing migration**: existing atmux deployments pick up the new cadence on next `atmux start` / `atmux cron-install` — the cron-block re-install logic replaces the previous `*/2` line idempotently. No code-path semantic change; same lane-tick verb, same logic, just longer interval. T4's skip-branch is what makes the relaxed cadence safe.
- **Tests**: 18 new tests pass — 4 in `tests/unit/core/cron.test.ts` (default `*/5` emit + `*/10` override + `*/2` backward-compat override + the existing test renamed/updated) + 8 in `tests/unit/schema/team.test.ts` (default-5 / explicit-10 / explicit-2 / non-divisor-7 rejected / non-divisor-8 rejected / zero+negative rejected / non-integer rejected / Team.parse round-trip). Full regression run: 216/216 pass on `cron.test.ts` + `team.test.ts`. Typecheck clean.
- **Out of scope**: lane-tick goal-narrow skip-branch (T4 — shipped 33f995c, structural prereq satisfied); /goal injection (T3 — shipped 05e9b9c); e2e (T6); dogfood (T7).

### 🟢 Shipped — ADR-157 T4 lane-tick goal-narrow + 3-safety-net preservation

- **`src/verbs/lane-tick.ts` goal-skip branch** per ADR-157 T4 (`t-e8ad0db5`). Claim-injection (`atmux claim --next --as <member>`) is now SKIPPED for goal-active Claude members; lane-tick narrows to a structural backstop for failure modes `/goal` cannot see (wedged panes, rate-lockouts, compaction-wipe). New `LaneTickMemberOutcome` literal `"skip-goal-active"`.
- **Goal-skip ordering (reviewer pre-flag #1)**: skip-branch lands AFTER the READY classification + AFTER the lead-ctx-rotate override. Wedged goal-active members surface as `skip-not-ready` (the pane-health signal), NOT `skip-goal-active` — operators see dead-pane issues even when /goal is set. Goal-active leads still receive `/team rotate-lead` nudge when ctx ≥ threshold (lead can't self-rotate via /goal).
- **Cursor carve-out (ADR-157 §D4)**: members with `runtime: "cursor"` short-circuit BEFORE goal resolution — claim-injection continues unchanged. Cursor CLI has no /goal equivalent so the cron-driven nudge stays the only drain for those panes.
- **Three safety nets PRESERVED verbatim per ADR-157 §D5**:
  - **#1 auto-done sweep** (`runAutoDoneScan`) — fires AFTER per-member loop for ALL members regardless of goal-state.
  - **#2 lead-ctx-rotate nudge** — fires ABOVE the goal-skip branch for ALL leads regardless of goal-state. Verified: `isRotateNudge: true` bypasses the goal-active early-exit.
  - **#3 dead-pane / rate-limit detection** — fires ABOVE via `skip-not-ready` classification. Wedged goal-active members surface as pane-health issues, not masked as goal-skipped.
- **Operator-debuggable skip log (Task body §3)**: `[lane-tick] skip claim-inject for <member>: goal-active (resolved-via=team.json|brief)`. Source attribution (team.json explicit vs brief Standing Goal) makes goal-phrasing bugs easy to trace.
- **Goal-resolver failure fallback**: if `resolveGoalForMember` throws (corrupt brief, permission denied), the helper falls through to existing claim-injection path with a WARN log. Conservative — drain stays healthy; operator sees the warn rather than a silently-skipped member.
- **Summary log line extended**: `lane-tick: visited=N ... skip-goal-active=M` for cron-log grep.
- **Tests**: 9/9 pass on `tests/unit/verbs/lane-tick-goal-narrow.test.ts`. Full 5-cell matrix per task body (goal-active+claude SKIPPED / goal-active+cursor RAN / goal-active+dead-pane → skip-not-ready / goal-inactive RAN / goal-inactive+dead-pane → skip-not-ready) + 3 safety-net assertions (lead-ctx-rotate over goal-skip / auto-done independence / dead-pane priority) + goal-resolver failure fallback. Typecheck clean. 28/28 existing lane-tick tests still pass.
- **Out of scope**: cron cadence change (T5 — `t-e847d0ae`, structural prereq satisfied by this commit); /goal injection (T3 — shipped 05e9b9c); e2e (T6).

### 🟢 Shipped — ADR-157 T3 `/goal` injection hooks (rotate + start)

- **`/goal` injection wired into `src/verbs/rotate.ts` + `src/verbs/start.ts`** per ADR-157 T3 (`t-c89ead5f`). Both call sites delegate to a shared helper `injectGoalIfActive` in `src/core/goal-injection.ts` (Task body §2 deduplication mandate). Brief-paste ordering preserved: `/goal` fires AFTER `bootClaudeMember` / `pasteBriefForMember` completes (reviewer pre-flag #2 — no injection into a busy compose box).
- **Per ADR-138**: injection routes through `safeSendKeysWithVerify` with `composerEmpty()` verifier — NEVER raw `tmux send-keys`. Re-uses the universal post-Enter signal (slash-command acceptance clears the composer the same way prompts do; same verifier `verifierForTui("claude")` already returns). NO new verifier added — composer-empty covers the slash-command acceptance signal without inventing a goal-specific pattern.
- **Cursor-runtime carve-out (ADR-157 §D4)**: members with `runtime: "cursor"` short-circuit before goal resolution — no `/goal` fired, no brief read wasted. Returns `{ fired: false, reason: "runtime=cursor" }`.
- **Goal resolution**: delegates to `resolveGoalForMember` from ADR-157 T2 (single source of truth). Resolution chain `member.goal` explicit > brief `## Standing Goal` section > null. Empty-string opt-out preserved.
- **Idempotent re-fire**: Claude TUI overwrites the goal silently on a second `/goal` call — re-firing is harmless. Helper logs but does not skip (Task body §4 — simpler than tracking state).
- **Failure semantics (reviewer pre-flag #3)**: verify-failed injection escalates to `send-keys-failures.log` per ADR-138 + helper returns `{ fired: false, reason: "verify-failed" }`. Rotation / cold-spawn pipeline does NOT abort — lane-tick backstop (T4) must still apply to goal-set-but-injection-failed members so the drain isn't deadlocked.
- **Goal-text quoting**: payload is `/goal "<text>"` with embedded `"` chars escaped (`\\"`). Multi-word goals land as a single quoted argument; matches the user-facing `/goal "<text>"` form.
- **Tests**: 7/7 pass on `tests/unit/core/goal-injection.test.ts` + 100% line coverage on `goal-injection.ts`. Full 5-cell matrix from task body (member.goal-set+claude / brief-parsed+claude / runtime=cursor SKIPPED / no-goal SKIPPED / verify-timeout escalates) + 2 edge tests (empty-string opt-out, embedded-quote escaping). Typecheck clean. 124 existing rotate+start tests still pass; 5 pre-existing failures verified unrelated via git stash.
- **Out of scope**: lane-tick narrowing (T4 — `t-e8ad0db5`); cron cadence change (T5 — `t-e847d0ae`); e2e (T6); dogfood (T7).

### 🟢 Shipped — ADR-157 T2 schema + goalResolver helper

- **`Team.members[].goal: z.string().optional()` field** + **`Team.members[].runtime: z.string().optional()`** added to `src/schema/team.ts` TeamMember per ADR-157 T2 (`t-b5b0678e`). Additive optional — back-compat verified (existing teams without these fields parse unchanged). Field JSDocs cite ADR-157 §D2 (resolution chain) + §D4 (cursor runtime carve-out) + §Decision-anchor #1 (goal-phrasing-rule).
- **New `src/core/goal-resolver.ts` module** — single source of truth for "what is this member's standing goal?" Consumed by T3 `/goal` injection hooks + T4 lane-tick narrowing (both forthcoming). Exports:
  - `resolveGoalForMember(member, briefPath?): Promise<string | null>` — resolution chain per ADR-157 §D2 / §OQ3: `member.goal` explicit > `templates/briefs/<role>.md ## Standing Goal` section > `null`. Empty-string member.goal = explicit opt-out (returns null without consulting brief).
  - `parseStandingGoalFromBrief(briefText): string | null` — case-sensitive anchored regex `## Standing Goal` (no trailing colon) per T2 reviewer pre-flag. Multi-line capture until next markdown heading or EOF.
  - `validateGoalRuntime(member): string | null` — WARN-not-refuse helper. Returns one-line WARN string when `runtime === "cursor"` AND `goal` set non-empty (partial-migration no-op case); null otherwise. Zod doesn't have a first-class WARN severity; loader-side warning surface uses the return value.
- **Tests**: 19/19 pass + 100% line coverage on `goal-resolver.ts`. 5-cell resolution matrix per task body (explicit-wins / brief-parsed / brief-missing-section / graceful-degrade / empty-string-opt-out) + runtime-gate WARN matrix + schema back-compat smoke (existing TeamMember without goal/runtime parses unchanged).
- **Out of scope**: `/goal` injection hooks (T3 — `t-c89ead5f`); lane-tick edits (T4 — `t-e8ad0db5`); cron cadence change (T5 — `t-e847d0ae`); e2e (T6); dogfood (T7).

### 🟢 Shipped — cross-team `atmux tell-lead --team <name>` (ADR-092)

- **New `--team <name>` flag on `atmux tell-lead`** per ADR-092 T1 (`t-5f20ba85`). Driver / parent-team / child-epic-team can now route a `tell-lead` ask into another team's inbox in the cockpit tree without `cd`-ing into the target's worktree. Closes the ADR-091 epic-merge conflict-surface gap (T12 migration deferred to its own commit per ADR-092 §Out-of-scope).
- **Cockpit-walk resolution (D1)**: `--team <name>` does a depth-first match on `cockpit.sessions[].name`; resolves target's `root` (own for `type: "team"`, nearest-ancestor `team.root` for `type: "epic-team"`), `team.json`, cage socket via `resolveTeamSocket`, and lead window. Default (no flag): existing cwd-derived single-team path is **byte-identical** to pre-ADR-092 behavior (Decision-anchor #1 — no regression on the hot path).
- **`findTeamByName(cockpit, name): CockpitTeamLookup | null` helper (D2)**: new pure export from `src/core/cockpit.ts`. Reuses existing `walkSessions` DFS walker. Returns the first matching `team` / `epic-team` node (other session types — superdriver, medic, martinet — skipped). Name-collision is operator error per Decision-anchor #2; lookup is deterministic on DFS order.
- **`callerScopeAllowed(cockpit, src, tgt, scope): boolean` gate (D3)**: symmetric four-case policy table — (a) `ATMUX_CALLER_SCOPE === "driver"` master override, (b) same-team trivially allowed, (c) child-epic-team → parent allowed, (d) parent → child-epic-team allowed. Siblings under same parent + unrelated teams refused (must route via parent). Refusal text names both ends per Decision-anchor #5 so operators see the policy violation root, not a generic "scope refused."
- **`ATMUX_CALLER_SCOPE` env var (D3 / Decision-anchor #4)**: exact-match — no `ATMUX_SCOPE` shorthand, no `--scope` flag-form (env-only). Cockpit driver pane sets it once on bootstrap; member panes do NOT inherit it (cage-tier boundary per ADR-058).
- **Socket resolution respects nested cages (D4)**: cross-team heads-up loads target `team.json` directly + calls `resolveTeamSocket(targetTeam)` — no path-construction from source-cage state (Decision-anchor #6 reviewer pre-flag enforces no parent-cage-prefix leak).
- **Tests**: 13 unit tests in `tests/unit/core/cockpit.test.ts` for findTeamByName (depth-3 fixture + own-root vs parent-root + DFS deterministic match + leaf-type skip + null on miss) and callerScopeAllowed (full 7-case matrix: driver / same-team / child→parent / parent→child / siblings-same-parent / siblings-diff-parent / unrelated / unknown). 3 unit tests in `tests/unit/verbs/tell-lead.test.ts` for `--team` flag parsing (populate / missing-value error / bare-invocation fast-path preserved).
- **Out of scope**: member-to-member cross-team messaging (separate `atmux send --team` Task if needed); `atmux doctor` D8 / D9 cross-team-routing health checks (Task `t-c2e544b6` — sibling e2e); sibling-epic-team direct routing (refused per D3 — must route via parent); ADR-091 T12 conflict-surface migration (referenced for traceability; separate commit).
- **Cross-refs**: ADR-089 (`walkSessions` DFS substrate — load-bearing primitive), ADR-090 (epic-team lifecycle; forward-reference — `epicTeam.parent` linkage), ADR-091 (epic-merge conflict-surface; forward-reference — first consumer), ADR-029 (tell-lead bash spec — byte-equal contract preserved on default path), ADR-058 (cage tier; forward-reference — Tier-1 boundary respected), ADR-099 (error-handling — `EX_NOPERM=77` for refusal).

### 🟢 Shipped — `atmux blockers list` unified verb fans across 7 surfaces (ADR-152)

- **New verb** `atmux blockers list [--json] [--class <c>] [--source <s>] [--max-age <duration>]` per ADR-152 T1 (`t-8f3061ef`). Closes complaint `c-1d28fc72` (driver-claude-sopx /bruh sweep 2026-05-15). Foundation for ADR-151 unblocker (`t-fba73bf8`) — single queryable signal source replaces the operator memory-load that grew with team size and compounded across rotations.
- **Fans across 7 surfaces** (no storage migration — markdown stays markdown, SQLite stays SQLite; only joins reads): SQLite tables `tasks` (status=blocked, status=in-progress past `stale_min`), `complaints` (status=open), `merger_state` (state in conflict|reverted) + markdown `decisions.md` (unstruck sections) `flags.md` (open flags w/o resolution rows) `driver-inbox.md` (🔵/⏳/📤 glyph entries OR un-glyphed past stale-age).
- **Normalized row shape** `BlockerRow {id, source, opened_at, age_sec, summary, blocker_class, suggested_action, related_task_id?}`. `id` surface-prefixed (`task:t-...`, `flag:f-...`, `merger:<branch>`) for cross-surface uniqueness. `suggested_action` carries an imperative one-liner (≤200 chars) the unblocker / operator can act on directly.
- **`blocker_class` taxonomy (D3, eight classes)**: `decision-pending` · `member-stuck` · `cross-lane-WIP` · `tooling-broken` · `stale-claim` · `dep-not-shipped` · `review-pending` · `push-policy-gate`. Per-surface defaults documented in ADR §D3 table; markdown surfaces lift class from leading-emoji glyph (🔵 → decision-pending, ⏳ → review-pending, 📤 → stale-claim, 🛠️ → tooling-broken, 🚫 → push-policy-gate, 🔁 → cross-lane-WIP) OR explicit `[class:X]` token (token wins).
- **Class derivation for SQLite surfaces**: blocked tasks → `dep-not-shipped` when any dep not done, else `member-stuck`. Stale in-progress tasks → `stale-claim` (default 24h, per-task `stale_min` override). Open complaints → `tooling-broken` default; lift from `extra.blocker_class` JSON field (forward-compat). Stuck merger_state → `tooling-broken` (conflict) or `push-policy-gate` (reverted).
- **CLI**: `--json` for unblocker + dashboard machine consumption (NO isatty auto-detection — explicit flag avoids SSH/CI footgun); `--class` / `--source` filters for surgical operator queries; `--max-age` accepts suffix-form (`30m`, `2h`, `7d`) or bare seconds.
- **Per-surface helpers exported** (`readBlockedTasks`, `readStaleInProgressTasks`, `readOpenComplaints`, `readStuckMergerState`, `readPendingDecisionsMd`, `readOpenFlagsMd`, `readDriverInboxBlockers`) so unblocker + tests can exercise each in isolation. `queryAllBlockers(atmuxDir, db, opts)` is the verb-facing fan-out; `nowSec` injectable for deterministic tests.
- **Markdown parsers regex-based** — formats are already consistent (the producing verbs enforce them). Reviewer blocks future format drift that doesn't update both producer + `src/core/blockers.ts` consumer in same commit.
- **Unit tests**: per-surface helper tests + integration test seeding all 7 surfaces in a temp dir + asserting row-count, class-mapping, source attribution, and cross-surface ID uniqueness (`ids.size === rows.length`).
- **Out of scope this commit**: lead-outbox.md as 8th source (already surfaced by `atmux outbox`); cross-team blockers fan-out (cockpit-tier concern); auto-promotion (driver-inbox → flag at 12h — separate ADR-153); action execution (unblocker's job per ADR-151); `atmux blockers add/resolve` (resolutions go through per-surface verbs).
- **Cross-refs**: ADR-060 (kanban SQLite canonical), ADR-077 §F2 (complaints), ADR-134 (merger_state), ADR-008 (decisions verb), ADR-022 (flags), ADR-057 §D2 (driver-inbox parser), ADR-151 (unblocker — primary consumer), ADR-148 (sibling single-canonical-truth-signal pattern). Complaint `c-1d28fc72` closed.

### 📋 Proposed — `team.json.autonomy` shared policy block (ADR-166)

- **New ADR drafted** at [docs/adr/166-team-autonomy-policy.md](docs/adr/166-team-autonomy-policy.md) (Status: `proposed`) per EPIC `t-99b85ee9` T1 (`t-446cc619`). Rejects the 2026-05-15 19:02 MYT operator `whip → bruh` rename proposal — instead lifts the per-team **aggression dial** (the actually-shared concern) into ONE shared policy block consumed by all action-class actors (martinet / `/bruh` skill / gitter / reviewer), leaving each role's mechanics where they are.
- **Slot-history (this re-slot is itself the case study)**: planner reserved **ADR-151** for autonomy-policy; sibling `t-b0e6c4ff` shipped `docs/adr/151-unblocker-role.md` on `geoyws-docs-2` (`fabbf30`, 2026-05-15 22:26 MYT) collapsing the slot. Driver routed re-slot to **ADR-165** via `/bruh #5` 2026-05-16 22:38 MYT; by 23:00 MYT ADR-165 had also shipped via my own `t-85b928a9` (atmux team config CLI, `7cdd886` — different topic). Applied lead/driver intent ("next clean gap") to current state — landed at **ADR-166** with full slot-history annotation. Per `[[feedback_pre_claim_verify_protocol]]` no duplicate-slot file was ever written; append-only convention preserved across both prior occupants.
- **Block keys (D3, 7-shape verbatim from EPIC body, reviewer-overridable at signoff)**: `autoMerge: 'off' | 'trunk-merge-tasks' | 'all'` (gitter consumer; default `'trunk-merge-tasks'` per ADR-145); `autoApproveDecisions: boolean` (bruh + martinet event-handler; default `true`); `autoFlipFlags: boolean` (bruh; default `true`); `autoReanimateZombies: 'off' | 'lead-only' | 'all-members'` (bruh + martinet; default `'all-members'`); `autoRotateMembers: 'off' | 'ctx-pressure' | 'ctx-or-stale' | 'all'` (martinet + bruh cascade; default `'ctx-or-stale'`); `autoFileFollowUps: boolean` (martinet; default `true`); `bruhScope: 'narrow' | 'sweep'` (bruh; default `'sweep'`).
- **D4 operator override semantic**: `/bruh` ALWAYS sweeps regardless of policy — the block governs AUTOMATED paths only; deliberate operator action supersedes. Implementation note: `/bruh` skill must distinguish operator-typed invocations from sibling-skill invocations via env-marker.
- **D5 backward compatibility**: missing block defaults all-auto-enabled (today's behavior preserved verbatim across every key). Migration is purely additive — no schema bump, no data migration. Existing per-role aggression toggles (`team.autoMerge.enabled` etc.) coexist for one release window, then deprecate with hard-error pointing operators at the autonomy block.
- **D7 sibling config block pattern** (per ADR-148): `autonomy` joins the family of team-level config blocks alongside `whip` / `cadence` / `eternalImprovement` etc. Zod `.strict()` sub-object (drift-rejection per ADR-054); mirror in `src/schema/cockpit.ts` for `defaultAutonomy` fleet-defaults; resolver helper mirrors `resolveEternalImprovementEnabled` cascade per ADR-149 verbatim.
- **§Reuse statement explicit on zero new abstractions** — schema extension + Zod mirror + cascade resolver + existing consumers + reuse of ADR-165's `atmux team set` CLI for operator edits. All plumbing on top of existing patterns.
- **Cross-refs**: ADR-013 (reviewer), ADR-077 (medic — complaint-handling consumer), ADR-132 (martinet `NudgeAction`), ADR-140 (cheap-model-first — frames why `whip→bruh` rename is unnecessary), ADR-145 (gitter `autoMerge`), ADR-148 (sibling config block pattern), ADR-165 (CLI-surface dep — `/bruh` consumes `atmux team get autonomy.<key>` once ADR-165 T3 lands).
- **Out of scope this commit**: per-member overrides; time-of-day windows; cross-team inheritance via super-driver (ADR-274 concern); time-bounded one-shot overrides; T2 schema impl; T3 consumer wiring; T4 `/bruh` skill update; T5 doc sweep; T6 e2e — sub-task filing is parent EPIC's responsibility per Task body's explicit "T1 ships ADR file ONLY" boundary.

### 📋 Proposed — `atmux team set/get/unset` CLI for `team.json` config edits (ADR-165)

- **New ADR drafted** at [docs/adr/165-atmux-team-config-cli.md](docs/adr/165-atmux-team-config-cli.md) (Status: `proposed`) per EPIC `t-2deb17f0` T1 (`t-85b928a9`). Closes the manual-JSON-edit fragility flagged 2026-05-16 08:07 MYT (driver flag: *"had to bypass atmux to flip `team.json.autoMerge.enabled` (null → true) because no CLI verb exists for it."*). Pre-flight verified: ADR-164 slot taken by `t-846e43dd` (sync claude-team-json); 165 + 166+ clean — resolved to 165.
- **Verb namespace (D1)**: three sub-verbs under existing `team` namespace — `atmux team set <dot.path> <value>` / `team get <dot.path>` / `team unset <dot.path>` — plus `--no-backup` / `--no-audit` / `--force` / `--dry-run` flags.
- **Schema gate (D2)**: every mutation Zod-validates the post-mutation object via `Team.parse()`; refuse-with-stderr on validation failure (fail-closed). `--force` is the migration escape hatch for files already schema-drifted at v1 cutover; audit-log records `caller_scope: "forced"`.
- **Atomic write (D3)** reuses ADR-098's `atmux::jq_update` primitive verbatim — flock sidecar (`team.json.lock`) + tempfile in same dir + `fs.rename`. Permissions preserved across the rename. Same lock that whip + ts-side `updateJson` already use; no new lock-ordering concern.
- **Backup default-on (D4)** snapshots pre-mutation state to `.atmux/team.json.bak.<epoch>`; `--no-backup` opt-out. Pruning delegates to existing `atmux groom --keep-bak N` (default 5) — no new pruning logic.
- **Audit-log NDJSON (D5)** appends `{ts, key, op, old, new, caller_scope, forced}` to `.atmux/logs/team-config-mutations.jsonl` per mutation. Append-only in v1; ~150KB/year/team estimate. `--no-audit` opt-out.
- **Dot-path = JSON-Pointer-lite (D6)**: `autoMerge.enabled` → `team["autoMerge"]["enabled"]`; numeric segments index arrays (`members.0.role`). Keys-containing-dot are out of v1; future escape grammar if needed.
- **Type coercion (D7)**: `true`/`false`→bool, `null`→null, int/float regex, `{...}`/`[...]`→JSON, `"..."`→quote-stripped string, else string. Zod gate is final arbiter.
- **Migration story (D8)**: no automatic schema-drift migration in v1. Operators inspect via `get` (which does NOT round-trip Zod per OQ-1), fix drift manually OR via `--force`, then re-run without `--force` once gate passes.
- **3 OQs with recommended defaults**: get-Zod-roundtrip (defer — raw JSON print); unset-of-required-field (refuse; --force bypasses); audit-log location (`.atmux/logs/` per ADR-147 convention).
- **Cross-refs**: ADR-054 (strict-mode schema — note: 054 file itself is a ghost-ADR similar to pre-`t-75a79d7c` ADR-052; out-of-scope follow-up to backfill), ADR-098 (JSON + locking primitive — reused verbatim), ADR-076 (kanban→SQLite — boundary marker; this verb governs JSON-resident state only), ADR-148 (commit-cadence — config edits NOT git commits, no cadence advance), ADR-097 (tmux abstraction — named by Task body for completeness; not load-bearing).
- **Out of scope this commit**: cross-team batch edits; diff-based / JSON-patch edits; secret handling; `atmux cockpit set/get/unset` sibling verb (same pattern, separate Task); `atmux team migrate` automated rename verb; SQLite-resident state mutations. T2-T6 (impl + tests + docs + e2e) per the §Implementation plan table; sub-task filing is the parent EPIC's responsibility.

### 📋 Proposed — `/goal` as primary drain for Claude service-loop roles (ADR-157)

- **New ADR drafted** at [docs/adr/157-goal-as-primary-drain.md](docs/adr/157-goal-as-primary-drain.md) (Status: `proposed`) per EPIC `t-3c1aab98` T1 (`t-a5b01d24`). Operator-authorized 2026-05-16 00:55 MYT (*"let's remove the lane tick for claudes then and make sure that we use goal instead"*) + driver hybrid-recommendation accepted (`/goal`-primary + lane-tick-backstop). Wires Claude Code v2.1.139+ `/goal` skill as the PRIMARY drain mechanism for Claude service-loop roles (gitter, unblocker, reviewer, lead, ombudsman); narrows lane-tick to a structural BACKSTOP for failure modes the per-turn Haiku evaluator cannot see (wedged panes, rate-lockouts, compaction-wipe).
- **Schema (D2)**: additive optional `team.json.members[].goal: z.string().optional()`. Presence is the gate for the lane-tick skip-claim-injection branch (no pane scan needed). Resolution chain: `team.json` explicit override > `templates/briefs/<role>.md ## Standing Goal` brief-source default.
- **Per-role goal phrasings (D3, load-bearing)**: gitter `"All members' branches are merged to trunk and trunk typechecks green"`; unblocker `"Kanban.status=blocked column is empty"`; reviewer `"No commit in last 24h is unreviewed"`; lead `"All members have a commit in last 30min AND no member is over ctx-threshold"`; ombudsman `"complaints/ sentinel queue is drained"`. Each MUST be unsatisfiable in steady state AND re-satisfy on real-world regression — reviewer pre-flag at every goal addition (failure-mode example: gitter goal without the trailing `"AND trunk typechecks green"` halts indefinitely).
- **Cursor-CLI carve-out (D4)**: members with `runtime: "cursor"` (martinet via ADR-132 + ADR-140) do NOT get `/goal` — Cursor CLI has no equivalent skill. Both `/goal` injection hooks AND lane-tick skip-claim-injection branch short-circuit on `runtime === "cursor"` (structural, not advisory).
- **Lane-tick narrowing (D5)**: skip claim-injection for goal-active non-cursor members; RETAIN three safety-net functions verbatim — (a) ADR-080 §B2 auto-done sweep, (b) ADR-080 §A2 lead-ctx-rotate nudge, (c) dead-pane / rate-limit-lockout detection + logging (escalation signal for medic/canary).
- **Cron cadence (D6)**: `*/2` → `*/5` recommended target; `*/10` ceiling iff validation shows `/goal` mean-time-to-detect-failure × 2 ≥ 5min. Lower bound floor is `/goal` failure-detection latency.
- **Injection via `safeSendKeysWithVerify` per ADR-138 (D7)**: NOT raw `tmux send-keys`. Verification confirms the slash-command was actually accepted by the TUI rather than eaten by a modal or compose-box-already-occupied state.
- **OQ1 (compaction-survives-`/goal`) is LOAD-BEARING** per lead 01:12 MYT note. Branch A (compaction preserves goal): cadence relaxes to `*/5` default; backstop optional. Branch B (compaction wipes goal): cadence stays `*/5` mandatory; backstop is structural failover, not optional. Verify before committing default. OQ4 (gitter-goal + ADR-145/ADR-134 cron interaction) RESOLVED orthogonal — `/goal` halts service-loop, cron-driven sweep is unaffected.
- **Cross-refs**: ADR-138 (verified send-keys — load-bearing dep), ADR-080 (lane-tick substrate — narrow not remove), ADR-145 (gitter-pattern — `/goal` interaction), ADR-134 (in-team auto-merger — cron orthogonality), ADR-132 + ADR-140 (martinet cursor carve-out), ADR-151 (unblocker — first goal-driven consumer), ADR-148 (cadence-as-canonical-truth — `/goal` latency informs new cadence baseline).
- **Slot-ledger note**: originally drafted as ADR-156; re-slotted to ADR-157 per lead 01:08 MYT — t-20674483 (medic→canary rename) had pre-existing planner reservation on 156 in same /bruh-sweep-4 window.
- **Out of scope this commit**: execution slices T2 (schema + loader, `t-b5b0678e`), T3 (rotation + cold-spawn hooks, `t-c89ead5f`), T4 (lane-tick narrow, `t-e8ad0db5`), T5 (cron cadence change, `t-e847d0ae`), T6 (e2e + failure-injection, `t-869a0226`), T7 (dogfood gated on ADR-151 unblocker `t-fba73bf8`, `t-6f8d27e8`) — same-session decomp per `[[feedback_decomp_same_session_with_deps]]`. ADR is doc-only this commit.

### 📋 Proposed — `unblocker` in-team role (ADR-151)

- **New ADR drafted** at [docs/adr/151-unblocker-role.md](docs/adr/151-unblocker-role.md) (Status: `proposed`) per EPIC `t-fba73bf8` T1 (`t-b0e6c4ff`). Integrates the four sibling /bruh-sweep drafts (ADR-152 blockers-list + ADR-153 auto-promotion + ADR-154 SQLite storage + ADR-155 pane-state verb) into a coherent in-team role contract. Each sibling produced a structured signal; ADR-151 names the consumer that drains them.
- **Required in-team role (D1)**: `team.json::requiredRoles` extended (additively) to include `"unblocker"`. New teams default-include; existing teams log warn-class deprecation for one release, then hard-error at `loadTeam`. Epic-team carve-out per ADR-090: epic-teams reuse parent's unblocker via cross-team complaint path. Per planner-anchor #1.
- **Opus model (cheap-model-first carve-out)**: per ADR-140 + planner-anchor #2 + `[[feedback_opus_all_for_agile_flow]]` memory. Classification + write-side authority is judgment work; martinet (cheap-tier) observes, unblocker (Opus) acts. The two compose.
- **In-team cage, not cockpit-W4**: per operator framing 2026-05-16 00:09 MYT ("busy + triage + has to live within teams"). Cross-team failures already have a path (complaint → sibling ombudsman); a cockpit-layer role would duplicate martinet (ADR-132) and pay round-trip context cost. Sibling cage residents (lead / planner / reviewer / docs / gitter / qa / ombudsman) gain one peer.
- **Drain loop — hybrid (D3)**: martinet sentinel-routed primary path (`.atmux/state/unblocker-pending.json` written by ADR-132 observe loop; filesystem-watch + 60s polling fallback) + whip-cycle backstop (15min cadence runs `atmux blockers list --class member-stuck,stale-claim,tooling-broken` and picks oldest unclaimed). Neither pure-event-driven nor pure-polling; backstop covers the (rare) cases martinet misses.
- **Authority matrix (D4)**: MAY triage / reanimate dead panes IN-TEAM (via ADR-138 verified send-keys when `runtime_state=dead` per ADR-155) / mutate kanban `blocked → todo` with audit note / file complaints via ombudsman (ADR-147) for cross-team root causes. MUST NOT move `blocked → done` (original owner ships) / reanimate cross-team panes (martinet) / approve-reject commits (reviewer).
- **Boundary with ombudsman (D5)**: disjoint surfaces — unblocker on `tasks WHERE status='blocked'`, ombudsman on `complaints WHERE status='open'`. Overlap resolved by artifact ownership: complaint adjudication → ombudsman; kanban-row resolution → unblocker. ADR-153 R1 auto-resolves the complaint when unblocker resolves the underlying blocker; no coordination handoff between the two roles.
- **Lane-respect window (D6)**: `team.unblocker.laneRespectMinutes ?? 30` — unblocker waits before acting on a Task whose owner's lane could plausibly fix it. Forced-pickup override when ADR-153 R1 fires (24h threshold = members' lane gave up). Tunable per team; default revisited after one month of dogfood metrics.
- **Spawn integration (D7)**: standard `start.ts` provisioning when role appears in `requiredRoles`; window name `🩹-unblocker` per ADR-135 convention; brief template at `templates/briefs/unblocker.md`; emoji 🩹 chosen for visual distinction from gitter 🌿 / reviewer 🛡 / lead 🧭 / planner 🗺 / ombudsman ⚖ / medic 🩺.
- **Per-team singleton (D10)**: enforced via existing tmux window-name uniqueness; no new locking primitive. Cross-team concurrency intentional + safe (each unblocker operates on its own team's kanban + cage).
- **Cross-team escalation BOUNDARY (D9)**: unblocker stays strictly in-team; cross-team root causes flow via complaint to target team's ombudsman (ADR-150 helpers handle the path). Martinet may write sentinels into sibling teams' `.atmux/state/unblocker-pending.json` for high-frequency cross-team patterns (audit trail stays in complaints).
- **Cross-refs**: ADR-152/153/154/155 (sibling /bruh drafts), ADR-150 (cross-team helpers), ADR-147 (ombudsman boundary), ADR-077/133 (medic substrate), ADR-132 (martinet sentinel-router), ADR-148 (cadence-truth-signal), ADR-140 (cheap-model-first carve-out), ADR-090 (epic-team carve-out), ADR-135 (naming convention), ADR-138 (verified send-keys), ADR-005 (kanban-source-of-truth), ADR-010 (`atmux flag`), ADR-085 (`Status: proposed (deferred: …)` annotation — unblocker does not auto-action deferred ADRs).
- **Out of scope this commit**: execution slices T2-T7 (brief template ship, start.ts wiring, sentinel reader, whip backstop, reanimate authority gate, complaint-file path, 100%-coverage unit tests, dogfood gate) — staged per lead-saturation carve-out. ADR is doc-only; impl Tasks filed post-reviewer-acceptance per the same-session decomp pattern (per `[[feedback_decomp_same_session_with_deps]]`).

### 📋 Proposed — `atmux pane-state` structured verb (ADR-155)

- **New ADR drafted** at [docs/adr/155-pane-state-structured-verb.md](docs/adr/155-pane-state-structured-verb.md) (Status: `proposed`) per EPIC `t-232d0d12` T1 (`t-4a4201de`). Closes complaint `c-6cd891d1` (operator-filed verb framing) + downstream sopx-side `c-068eba4d` / `c-a3c3a42d` (Stuck-input false-positive cascade observed 2026-05-15: `/bau` reported 14–16 of 19 windows "stuck input"; manual scan found 0 actually-user-queued). Replaces the per-consumer `tail -10` heuristic with a single structured verb.
- **Verb surface (D1)**: `atmux pane-state <window> [--json|--table]`. JSON-default (machines first; per the verb's primary consumers — `/bau`, `/bruh`, ADR-151 unblocker, ADR-148 cadence column substrate, ADR-132 martinet observer). Read-only; no side effects. Consumers compose state via their own loop cadence (verb is stateless).
- **Return shape (D2)**: Zod-validated closed schema — `{ pid, runtime_state, composer: { has_text, text, likely_user_typed, residue_class }, last_turn_marker_age_seconds, mode }`. Shape locked at v1; additions require an ADR-155 annotation header per project CLAUDE.md ADR append-only convention.
- **7-state `runtime_state` enum (D3)**: `idle` / `working` / `compacting` / `rate-limited` / `dead` / `shell-prompt` / `welcome-screen`. Spans the observer's decision tree (reanimate / nudge / leave-alone / log) without giving callers states they can't act on. Closed enum; new states require an ADR.
- **Structural marker parsing, not tail-10 (D4)**: composer separator + status footer + turn-execution glyphs (`✽` / `✻` / `✶`) + banner blocks. Markers enumerated in `src/core/pane-state-patterns.ts` (load-bearing constants module; reviewer-audited). TUI version bumps that break a marker land as ADR-155 annotation headers.
- **Projection map to ADR-057 (D5)**: `core/pane-state.ts` (the existing 8-state internal classifier serving `safeSendKeys` per ADR-138) is refactored to consume the new structured reader and project the result. Zero behavioral regression for `safeSendKeys` callers; new structured surface for new consumers.
- **`residue_class` denylist (D7)**: closed string-set, NOT a regex engine — `claim-next` / `pull-next` / `check-status` / `null`. v1 set sourced from the sopx 2026-05-15 false-positive corpus; expands slowly with auto-mode vocabulary. Auditable; reviewer-flagged per addition.
- **`likely_user_typed` defensive-default-false (D6)**: composer text is `likely_user_typed=true` IFF it does NOT match any `residue_class` pattern. Asymmetric-cost rationale: false-positive (residue mis-flagged as user input) sends Enter and triggers residue cascade; false-negative (real input mis-flagged) waits for operator's next checkin. Cheaper failure mode wins.
- **Dead-pane detection (D8)**: triple-check — `tmux display-message` empty OR `kill -0 <pid>` fails OR `/proc/<pid>/status: State: Z`. Zombie-pane states (claude crashed, shell holds defunct PID, tmux shows last frame) read as `dead`, not `idle`. Reanimation can fire.
- **Cross-refs**: ADR-057 (internal classifier — projection target), ADR-138 (verified send-keys — consumer via projection), ADR-148 (cadence-as-truth; pane-state is the proxy — column substrate), ADR-077 / ADR-133 (medic observe-loop), ADR-132 (martinet — primary cheap-model consumer), ADR-151 (unblocker — `runtime_state=dead` consumer), ADR-152 (blockers list — join target), ADR-154 (sibling /bruh sweep draft).
- **Out of scope this commit**: execution slices T2-T6 (verb impl, patterns module, consumer migration for `/bau` / `/bruh` / martinet / unblocker / status, dogfood gate, e2e tests) — staged per lead-saturation carve-out. ADR is doc-only; impl Tasks filed post-reviewer-acceptance per the same-session decomp pattern.

### 📋 Proposed — driver-inbox + lead-outbox SQLite migration (ADR-154)

- **New ADR drafted** at [docs/adr/154-driver-inbox-lead-outbox-sqlite-migration.md](docs/adr/154-driver-inbox-lead-outbox-sqlite-migration.md) (Status: `proposed`) per EPIC `t-2298cbb0` T1 (`t-8b50ab84`). Closes complaint `c-96e5a8f2` (driver-claude-sopx /bruh sweep 2026-05-15 00:17 MYT). Promotes `.atmux/driver-inbox.md` + `.atmux/lead-outbox.md` from markdown-as-canonical to **SQLite-tables-as-canonical with markdown view layer** — same pattern as ADR-076's member-inboxes cut.
- **Schema shape (D2)**: UNIFIED `coordination_messages` table with `direction` discriminator (`'lead-to-driver'` | `'member-to-driver'`), not per-direction tables. Operator + lead recommendation — identical triage semantics, cross-direction queries (ADR-152 blockers list) avoid UNION ALL, threading via `parent_id` composes naturally on a single table. Per-direction shape documented in §Tradeoffs as rejected alternative.
- **Triage shape (D4)**: structured `status` enum (`pending` / `acked` / `routed` / `waiting` / `archived`) + `acked_at` / `archived_at` / `triaged_by` columns, NOT raw glyphs in a `triage TEXT` column. Markdown render translates back to the existing ✅ / 📤 / ⏳ / ❌ / (filter) glyphs so operator muscle-memory survives the cut.
- **Markdown is render-only (D3)**: no background `state.db ↔ .md` sync. `atmux driver-inbox show [--json|--md]` renders from SQLite on demand; `atmux driver-inbox watch` provides committed-row stdout tail for live view.
- **Migration (D7)**: one-shot `atmux migrate inbox-to-sqlite` verb auto-fires on first `atmux start` after upgrade; idempotent re-run via `migration_audit` row + non-zero `coordination_messages` row count. Parses date headers + triage glyphs from existing `.md` files; moves legacy files to `.atmux/legacy/` as read-only archive.
- **Deprecation (D8)**: one-release window — next minor ships SQLite cut + markdown-read+write back-compat path; cut-over release removes the markdown path with a hard-error pointing operators at the migrate verb. Mirrors ADR-076's clean-cut pattern per `[[project_inbox_migration_done]]` memory.
- **Cross-refs**: ADR-060 (kanban SQLite canonical), ADR-076 (inboxes migration precedent), ADR-152 (blockers list — downstream consumer), ADR-153 (auto-promotion inbox→flag at 12h — downstream consumer), ADR-155 (pane-state verb — sibling /bruh draft), ADR-151 (unblocker — consumer).
- **Out of scope this commit**: execution slices T2-T6 (schema migration code, verb impls, dogfood gate, e2e tests) — staged per lead-saturation carve-out. ADR is doc-only; impl Tasks filed post-reviewer-acceptance per the same-session decomp pattern.

### 🟢 Shipped — `gitter-sweep` cron-install template (ADR-134 T7)

- **New `--template gitter-sweep`** option on `atmux cron-install` per [ADR-134](docs/adr/134-in-team-auto-merger.md) §triggers + T7 scope (`t-a87a39f1`). Emits a `*/N * * * * <env> atmux gitter --sweep >> .../gitter-sweep.log` cron line that backstops the intra-team auto-merger when the gitter member misses an event (paused / rate-limited / restart). Mirrors the existing `--template ombudsman-tick` / `lane-stall-watch` shape: install-time `ConfigError` if `team.autoMerge.enabled !== true`; renderer dual-gate also checks the roster for a `role: "gitter"` member before emitting the line.
- **Cadence resolution precedence**: (a) `cron-install --template gitter-sweep --interval <N>` transient override beats (b) `team.json::autoMerge.cronBackstopMin` config beats (c) the schema-side `DEFAULT_AUTO_MERGE_CRON_BACKSTOP_MIN = 10`. Matches ADR-134 §Config OQ-default (10 minutes).
- **Wiring surface**: new `gitterSweepIntervalOverride?: number` on `RenderCronBlockOpts` in `src/core/cron.ts`; new `"gitter-sweep"` entry in the `CRON_INSTALL_TEMPLATES` allowlist + `TEMPLATES_WITH_INTERVAL` set in `src/verbs/cron-install.ts`. Backward-compat: existing teams without `autoMerge.enabled` keep the old rendered block byte-equal (no spurious line; doctor sees no diff).
- **Out of scope this commit** — T7's other scope items (gitter member entry in the atmux team's `.atmux/team.json`, `atmux start` spawn integration, doc updates beyond CHANGELOG) ship in follow-up Tasks under the same EPIC. Cron-install template is the lowest-risk slice that unlocks operator manual-install of the backstop on `autoMerge` teams today.

### 🧹 Trunk fan-in cleanup — dedup duplicate `TeamCadence` Zod (ADR-148 T2 / T3)

- **Removed duplicate `TeamCadence` + `TeamCadenceThresholds` Zod definitions** in `src/schema/team.ts` introduced by the parallel landing of ADR-148 T3 (`ce9467e` via `c22ff1a`) and T2 (`8f2b857` via `51e8362`). Both branches added the same schema independently against an older base; `git merge-ort` accepted both copies additively (different line ranges, no conflict marker), then `tsc` errored with `TS2451: Cannot redeclare block-scoped variable 'TeamCadence'` + `TS1117: object literal cannot have multiple properties with the same name` on the duplicate `cadence:` field in `Team`. Trunk now ships T2's version (`enabled.optional()` matches ADR-148 §D1's "cadence is canonical truth signal — surface by default" intent); `DEFAULT_LANE_STALL_MIN_AGE_SEC` + `DEFAULT_LANE_STALL_CRON_INTERVAL_MINS` consts (T3 origin) preserved unchanged so `lane-stall-tick` + `cron.ts` consumers still resolve.
- **Why this row exists**: this is a trunk-fan-in artifact, not a feature/fix authored against a Task — surfaced post-merge by the T7 ship's `tsc --noEmit` gate. Captured here so future operators reading the CHANGELOG see the dedup context rather than wondering why a "Cadence schema (T2)" row sits next to a "Cadence schema cleanup" row.

### 🟢 Shipped — kanban auto-emit trunk-merge Task on Story-done (ADR-146 T2)

- **New `KanbanStory.branch` field** per [ADR-146](docs/adr/146-kanban-auto-files-trunk-merge.md) §D4 — source branch this Story's work lives on (typically `<base>-<member>` per ADR-082+084). Rides through the `extra` JSON column on the `stories` table; zero-migration roll-out.
- **`moveTask` hook** — when a Task's status transitions to `done`, if it's the last non-done child of a branched Story AND the team has `worktreeIsolation: true`, atmux auto-files a `merge t-xxx (branch→trunk): <source-branch> → trunk` Task per ADR-146 §D1+D2 — assigned to `gitter` (or per `autoEmitTrunkMerge.fallbackAssignee`). The auto-file lands in the SAME `BEGIN IMMEDIATE` transaction as the move-to-done write, so the ADR-032 task-done cascade wakes only after BOTH rows commit (no false-positive idle nudge per §Atomic).
- **Short-circuit rules** per ADR-146 §D5: Story without `branch` set, team without `worktreeIsolation`, `autoEmitTrunkMerge.enabled === false`, `Story.branch === team.merger.baseBranch` (when `shortCircuitOnSharedBase: true`), remaining non-done siblings, OR done-Task subject already matches the auto-emit pattern (loop-prevention) — any of these skip emit cleanly.
- **New `team.json::autoEmitTrunkMerge` config block** per ADR-146 §D7 — `enabled` (default `true` when `worktreeIsolation: true`, `false` otherwise), `fallbackAssignee` (default `null` = unassigned), `shortCircuitOnSharedBase` (default `true`). Strict-mode Zod block; typos rejected per ADR-054 §D3 drift detection.
- **Backfill script** at `scripts/backfill-story-branch.ts` — dry-run by default; `--apply` walks every Story with status `in-progress`/`testing`/`review`/`merging`/`done` and infers `<base>-<member>` from child-task owners when all children share a single declared member. Conservative (skips Stories with mixed owners or non-member owners — operator can hand-backfill via SQL). Idempotent; safe to re-run.
- **Out of scope this commit** — `atmux story update s-xxx --branch <b>` verb (deferred per OQ-1 to a future commit); cron-backstop trunk-merge (already handled by ADR-134 §state-machine cron path); `tested → merged` test-gate chaining (separate ADR per §D6).

### 🟢 Shipped — commit-cadence column in `atmux status` (ADR-148 T2)

- **New cadence column** in `atmux status` output per [ADR-148](docs/adr/148-commit-cadence-truth-signal.md) §D3. Renders the canonical truth-signal for "is this member shipping?": one of `🟢 shipping (Nmin)` / `🟡 idle (HhMm)` / `🔴 dormant (Hh)` / `🚨 ship-zero (Hh)` per ADR-148 §D2 classifier. Sourced from per-member `git -C <worktree> log --since=<windowSec>s --author=<name>` — the cadence is the truth signal; pane-state is the proxy.
- **`state` column renamed to `pane-state`** per ADR-148 §D3 to make the proxy explicit. Existing operators reading the column see the same cage-state values (`active`/`wedged`/`bootstrapping`/`down`); the header rename signals that this is a process observable, NOT a verdict on whether the member is shipping. The cadence column is the new primary verdict; the pane-state column persists for one release cycle so operators with muscle memory still see the process diagnostic.
- **New `team.json::cadence` config block** per ADR-148 §D7 — opt-out via `cadence.enabled: false`; per-member opt-out via `cadence.exemptMembers: ["planner", "reviewer"]` (exempt members render as `(exempt)`); per-team threshold overrides under `cadence.thresholds` (shippingMaxAgeSec / idleMaxAgeSec / dormantMaxAgeSec / shipZeroWindowSec). Defaults match ADR-148 §D7 (30-min ship window, 2-hr ship-zero threshold matching CLAUDE.md whip §0.05 stake floor).
- **JSON output gains `members[].cadence`** with the `CadenceObservation` shape (`windowSec`, `commitsInWindow`, `lastCommitAt`, `lastCommitSha`, `ageOfLastCommitSec`, `verdict`). Backwards-compat: the legacy `paneCommand` + `cageState` fields remain unchanged so existing consumers (dashboards, cockpit aggregators) are not broken.
- **Out of scope this commit** — T3 (lane-stall cron rule) + T5 (`src/core/cadence-classifier.ts` extraction + martinet observe() wiring + `[ship-zero-window]` Discord template) ship in follow-up Tasks under the same EPIC. T2 inlines the classifier in `src/verbs/status.ts` so the column surfaces today; T5 lifts the classifier verbatim into the shared module.

### 🟢 Shipped — ADR-087 §D4 cron quiescence on soft-stop (t-ccabd763)

- **New `quiesceCron` helper** in `src/core/soft-stop.ts` per [ADR-087 §D4 amendment](docs/adr/087-atmux-stop-soft.md#§D4-—-cron-quiescence-amendment-2026-05-16-t-ccabd763). Closes the race where the team's whip + watchdog cron lines remain installed + active during the soft-stop window (notice → grace → manifest → archive → kill-session), so a `*/15` or `*/1` tick landing inside that window re-pokes panes that are shutting down / re-spawns dead members / fires Discord pings against a stopping team.
- **Wired in `src/verbs/stop.ts`** — `quiesceCron({ atmuxDir })` fires BEFORE `softStop()` in the `--soft` branch. Non-fatal: a crontab swap failure surfaces as a stderr warn and soft-stop proceeds (race risk degrades to today's bare soft-stop, not worse). Surfaces a `cron-quiesce: suspended N new line(s), M already suspended` stdout line when a non-zero count of lines was acted on.
- **Scope is whip + watchdog only** — regex `\batmux\s+(whip|watchdog)\b` catches `atmux whip` + `atmux whip-resume-check` (word-boundary at `-`) + `atmux watchdog`. Other team-scoped cron verbs (gitter-sweep / lane-stall-watch / ombudsman-tick / epic-merge-tick / groom / report / decisions-digest / unblocker-tick) are deliberately LEFT running — they manage trunk/state.db, not panes, and don't interact with the panes winding down.
- **Per-team scoping** via the `ATMUX_DIR=<atmuxDir>` env marker every renderer-produced cron line carries (per `src/core/cron.ts::renderCronLines`). Other teams' whip/watchdog lines (different ATMUX_DIR) are left running — counted as `skippedOtherTeam` in the result. Operator-installed out-of-block lines that carry the marker are also suspended.
- **Comment-prefix pattern** `# ATMUX-QUIESCED <epoch> <original-line>` makes cron ignore the line + leaves a forensic trail (timestamp shows WHEN soft-stop fired). The next `atmux start` re-installs the team's cron block via existing `cron-install` path, which renders fresh lines without the comment tag — no companion `unquiesceCron` is needed for the standard in-block lifecycle.
- **Idempotent** — re-runs against an already-quiesced crontab are no-ops (already-tagged lines counted as `alreadySuspended`, no second write to crontab). Test injection seams: `crontab?: CrontabIO` (default `defaultCrontabIO()`), `dryRun?: boolean`, `clock?: () => number` (default `time.now()`).
- **/loop processes** (Claude Code `ScheduleWakeup` self-wakeups) are NOT explicitly cancelled. They die implicitly when the TUI is killed at `tmux kill-session` (the last step of stop.ts). A 5s grace-window race is theoretically possible but bounded by `ScheduleWakeup`'s 60s clamp — any realistic `/loop` cadence (60s–3600s) is >> 5s. Explicit `C-c` pre-kill cancellation is deferred per ADR-087 §D4-OQ1 ("revisit if production logs show a `/loop`-class race post-quiesce"; reversibility: low).
- **Tests** — 8 new unit tests under `tests/unit/core/soft-stop.test.ts::describe("quiesceCron")`: happy path (whip + watchdog suspended, unrelated lines untouched), other-team isolation, idempotent re-run, `whip-resume-check` matched via word-boundary, dryRun reports without writing, no-crontab / crontab-unavailable clean zero, unrelated verbs NOT matched, crontab structure preserved (marker fence + non-atmux lines + line-count invariance).
- **Same-commit doc**: ADR-087 §D4 amendment appended (append-only per ADR convention) with race explanation + decision + scope rationale + `/loop` analysis + cron-remove interaction + 2 open questions. Existing §Refs preserved; new §Refs addendum cites the §D4-specific surfaces.
- **Out of scope this commit** (Task body explicit carve-outs): cockpit-level cascade (parent's `stop --soft` → recursive child stops) — that's ADR-090 §Decision-anchor #7 territory; explicit `pkill -f "atmux whip"` in-flight tick reaping (ADR-053 advisory lock makes this lower-priority — current ticks exit cleanly when the lock is released; the comment-out already prevents NEW ticks from firing).
- **Cross-refs**: ADR-087 (parent), ADR-053 (whip advisory locking), ADR-076 (per-team cron isolation), ADR-083 (`cron-remove` verb — companion post-kill step), CLAUDE.md §Docs Discipline (ADR-first, same-commit doc updates).

### 🟢 Shipped — `atmux groom --zombie-sweep` sub-op (t-0027eec3)

- **New `sweepZombieTmuxSockets` sub-op** in `src/core/groom.ts` per Task body t-0027eec3 (c-4698c603 arm b). Defense-in-depth for SIGKILL'd `bun test` orphans that bypass the (a) primary fix shipped in t-88b60ca7 (`tests/unit/verbs/cockpit.test.ts` module-level fixture registry + `process.on('exit')` + `afterAll` sweep). Under SIGKILL no userland exit hook fires, so the fixture's `mkdtemp` socket dir + tmux server leak; this sub-op walks `os.tmpdir()` for fixture-shape `atmux-*-<suffix>` directories older than `minAgeMs` (default 6h), kills any tmux server bound to a socket inside, then `rm -rf` the parent dir.
- **New `--zombie-sweep` flag** on `atmux groom` (opt-in, default OFF). Wired in `src/verbs/groom.ts` after the existing `--archive` sub-op; error-contained (one failure surfaces as warn + continues). `result.zombieSweep` carries the `ZombieSweepResult` (scanned / killed / removed / per-dir errors).
- **Fixture-shape regex** `/^atmux-(cockpit-)?[^/]+-[^/]+$/` requires the trailing mkdtemp suffix; production cage dirs (e.g. `/tmp/atmux-<team>/sock` without trailing hyphen) are deliberately excluded. Two socket shapes detected per matched dir: `<dir>/sock` (default cage convention) + `<dir>/tmux-<uid>/default` (`resolveTeamSocket` with explicit `team.tmuxTmpdir`).
- **`tmux kill-server` is idempotent** — no-server errors (`"no server running"`, `"server not found"`, `"no such file"`, `"connection refused"`) are EXPECTED on idempotent re-runs and are swallowed. Unexpected errors (permission-denied, garbled socket) surface to `result.errors[]` per groom convention.
- **Test injection seams**: `tmpDir` (defaults to `os.tmpdir()`), `nowMs` (defaults to `time.now()`), `dryRun`, `killServer` (defaults to `createTmux({ socketPath }).server.killServer()`).
- **Cron policy** — `--zombie-sweep` is opt-in / default-off in v1. Rationale: (1) false-positive deletes against an actively-running long-lived test fixture corrupt the in-flight test, (2) the (a) primary fix already covers the common case; defense-in-depth is housekeeping, not load-bearing. Follow-up Task to migrate to `team.json::groom.zombieSweep: true` config knob with cron auto-respect after N weeks of opt-in production proof.
- **Tests** — 13 unit tests in `tests/unit/core/groom-zombie-sweep.test.ts` covering: matched + stale dir cleanup, `atmux-cockpit-*` nested fixture shape, age-threshold gate (5h59m skipped), production-shape exclusion (`atmux-atmux` not matched), unrelated `/tmp` entries ignored, `tmux-<uid>/default` socket shape detection, no-socket cleanup-only path, dryRun reports without mutating, idempotent re-run, expected-class kill errors swallowed, unexpected kill errors surfaced, custom `minAgeMs`, missing tmpDir cold-start safety, top-level file entries skipped. Stubs `killServer` for deterministic execution.
- **Same-commit doc**: new `docs/RUNBOOK-grooming.md` documents all 8 groom sub-ops with the new `--zombie-sweep` flagged + operator usage + cron policy + return shape; existing `parseGroomArgs` unit test updated for the new `zombieSweep: false` default.
- **ADR pointer**: no dedicated ADR (housekeeping scope per Task body); references ADR-068 (groom umbrella — ghost ADR per `t-75a79d7c`), complaint `c-4698c603` (resolved), `t-88b60ca7` (primary fix shipped, `20fccb1`), CLAUDE.md §`bun test` orphan rule (root cause).
- **Out of scope this commit**: cron-default-on migration (follow-up Task once opt-in production proves stable); `team.json::groom.zombieSweep` config knob; cross-`/tmp/atmux-*/sock` enumeration beyond `os.tmpdir()` root (e.g. `/var/folders/.../T/` on macOS — Linux primary first).

### 🟢 Shipped — team-of-teams pre-sopx capstone phase-2 partial — ADR-092 cross-team tell-lead asserted (t-bc4fdb19)

- **Phase-1 skeleton (`tests/e2e/team-of-teams-pre-sopx.test.ts`) extended** with phase-2's narrow scope per Task body: 3 INTEGRATION tests in `describe("ADR-092 cross-team tell-lead (phase-2, t-bc4fdb19)")` that walk the cross-team routing surface end-to-end against real cockpit fixtures + the real `spawnEpic` verb. Phase-1's lifecycle walk (8 `test.todo` stages spanning spawn→fan-in→dissolve→no-leakage) remains at phase-1 scope; phase-2's Task body explicitly bounded the cross-team paths + doctor checks, not the lifecycle.
- **Three canonical paths asserted**: (a) parent driver → epic-lead (with `ATMUX_CALLER_SCOPE=driver` master override per §D3 case a), (b) epic-lead → parent (allowed natively via §D3 case c via cockpit's `epicTeam.parent` linkage), (c) unrelated outsider → epic refused per §D3 case e/g. Refusal-path asserts NO inbox write on either side — refusal lands BEFORE `appendDriverInbox`. Happy-path asserts the inbox-write durability (per ADR-029 §F6 + tell-lead.ts comment "appendDriverInbox already landed before this throw"); tmux send unavoidably fails in test (no cage server) — that's the EXPECTED terminal failure mode the assertion machinery is built around.
- **Phase-1 helper signatures implemented**: `ParentFixture` extends as `ParentFixtureRuntime` (adds `cockpitPath`, `templatesDir`, `capturedLogs`); `SpawnedEpic` returned shape preserved. `makeParentFixture` + `spawnEpicForFixture` follow the same shape as `tests/e2e/epic-auto-merge.test.ts::makeFixture` (bare remote + working clone + tmuxTmpdir pinned at fixture so `resolveTeamSocket` doesn't touch shared `/tmp` paths).
- **Predecessor cherry-picks onto `geoyws-up-impl-3`**: `3822b3b` (ADR-092 cross-team tell-lead from `ba7ee3f` on `geoyws-up-impl`) + `590517c` (phase-1 skeleton from `a670648` on `geoyws-up-impl-2`). Both were queued for trunk fan-in via gitter at sweep time but had not landed; cherry-pick assembles the predecessor stack locally so phase-2 can build on top. Criss-cross history is acceptable per ADR-137 §carve-outs — final fan-in via gitter collapses it.
- **Doctor D5a/D8/D9 remains deferred** to `t-c2e544b6` (the ADR-092 dogfood Task; doctor probe surfaces NOT yet on trunk). Captured as `describe.todo("ADR-092 doctor D5a/D8/D9 (deferred to t-c2e544b6)")` block with 3 `test.todo` entries each spelling out the helper sketch — turnkey wiring spec for t-c2e544b6's claimant. Re-claims on t-c2e544b6 ship.
- **RUNBOOK companion updated** — `docs/RUNBOOK-team-of-teams.md` §Cross-team tell-lead section flips from "deferred to phase-2" → "Verified — phase-2, t-bc4fdb19" with the 3 paths + test pattern documented. Status banner reflects partial phase-2 (cross-team Verified; lifecycle + doctor still pending).
- **Out of scope** (phase-2 carve-outs preserved from Task body): sopx-side migration (operator-driven), PR-mode dissolution (§Decision-anchor #6 deferred), member-to-member cross-team messaging (ADR-092 §Out-of-scope), full lifecycle walk (phase-1's 8 `test.todo` stages — lifecycle is its own scope-class, not bundled into the cross-team capstone delta).
- **Cross-refs**: ADR-092 (cross-team tell-lead — primary contract under test), ADR-099 (`EX_NOPERM=77` refusal exit), ADR-090 (epic-team lifecycle — spawn-epic fixture target), ADR-091 (epic-merge state machine — pre-fixed deferred), ADR-137 §carve-outs (sibling-merge via cherry-pick is acceptable for member-branch predecessor assembly), ADR-029 §F6 (durable inbox-write semantics — assertion machinery foundation).

### 🟢 Shipped — team-of-teams pre-sopx capstone phase-1 skeleton (t-edc93b42, 2026-05-16) + `docs/RUNBOOK-team-of-teams.md`

- **New `tests/e2e/team-of-teams-pre-sopx.test.ts`** — capstone gate spec authored as a **structured skeleton** (`describe.skip` + 8x `test.todo` covering the full ADR-090/091/134 lifecycle: spawn 2 parallel epics → seed mock Tasks → claim/done lifecycle → auto-merge state machine fan-in to epic-trunk → epic-trunk fan-in to parent-trunk → dissolve-epic → parent KanbanEpic done → no-leakage proof). Fixture-helper signatures locked: `ParentFixture`, `SpawnedEpic`, `LifecycleSnapshot`, `DissolutionResult` interfaces define the phase-2 contract; module-level `activeFixtureDirs` registry + `process.on('exit')` hook + `afterAll` sweep mirror the t-88b60ca7 / c-4698c603 defense pattern so the same cleanup machinery lights up when phase-2 swaps in real fixtures. State-snapshot expectations table (per CLAUDE.md Test finding report pattern) documented in companion RUNBOOK; idempotence proof (post-cleanup snapshot == pre-spawn-baseline) is the closure beat.
- **Phase-1 ship rationale (vs deferring entire file to phase-2)**: reserves the canonical filename + fixture shape so phase-2's diff is implementation-only; documents the INTENDED lifecycle + state-snapshot expectations now while context is hot; locks down helper signatures so phase-2's review gate has a stable structural contract. Per CLAUDE.md "Pair demo runbook beats with rehearsal spec steps" — every RUNBOOK beat name maps to one `test.step()` label verbatim in phase-2; drift surfaces as a failing rehearsal run, not a sopx-flip-morning surprise.
- **WIDER blocker captured in spec header**: phase-2 wires real assertions once gitter sweep fans the following branches into trunk — `geoyws-up-impl-3` (carries 762716f + aac4ee1 + 57b0d0d + b502ebe + a34fafa: ADR-090 schema + spawn-epic/dissolve-epic verbs + ADR-091 state machine + ADR-090↔091 wire-up) + `geoyws-up-impl` (carries ba7ee3f: ADR-092 cross-team tell-lead). All listed branches were `state=null action=queued` or `skipped-in-flight` in the gitter sweep run at 06:14 MYT 2026-05-16; gitter-stuck-bug captured separately at t-f4088323.
- **New `docs/RUNBOOK-team-of-teams.md`** — operator-facing companion: when-to-spawn / sopx-adoption-sequence (8 verbatim beats from driver-inbox 14:03 MYT lines 3122-3132, 1:1 with spec test.step labels) / state-snapshot expectations table (8 stages with parent.KanbanEpic.status / cockpit.epic-entry / worktree / cage / cron-block columns) / failure-mode triage / cross-team tell-lead deferred-to-phase-2 note / doctor D5a/D8/D9 deferred-to-phase-2 note / adjacent-flags from t-cc4c5fd9 audit. `⚠️ Status: phase-1 skeleton` banner at top until phase-2 flips Intended → Verified.
- **Phase-2 deferred to** `t-bc4fdb19` (deps=[t-c2e544b6, ba7ee3f-on-trunk]) with full ADR-092/doctor-D8/D9 + spawn-epic/dissolve-epic real-assertions scope; TODO comment block at end of spec cross-links the 3 cross-team tell-lead paths + 3 doctor checks + 3 adjacent-flag-deferrals so phase-2's claimant has a turnkey wiring spec.

### 🟢 Shipped — cross-team `atmux tell-lead --team <name>` (ADR-092)

- **New `--team <name>` flag on `atmux tell-lead`** per ADR-092 T1 (`t-5f20ba85`). Driver / parent-team / child-epic-team can now route a `tell-lead` ask into another team's inbox in the cockpit tree without `cd`-ing into the target's worktree. Closes the ADR-091 epic-merge conflict-surface gap (T12 migration deferred to its own commit per ADR-092 §Out-of-scope).
- **Cockpit-walk resolution (D1)**: `--team <name>` does a depth-first match on `cockpit.sessions[].name`; resolves target's `root` (own for `type: "team"`, nearest-ancestor `team.root` for `type: "epic-team"`), `team.json`, cage socket via `resolveTeamSocket`, and lead window. Default (no flag): existing cwd-derived single-team path is **byte-identical** to pre-ADR-092 behavior (Decision-anchor #1 — no regression on the hot path).
- **`findTeamByName(cockpit, name): CockpitTeamLookup | null` helper (D2)**: new pure export from `src/core/cockpit.ts`. Reuses existing `walkSessions` DFS walker. Returns the first matching `team` / `epic-team` node (other session types — superdriver, medic, martinet — skipped). Name-collision is operator error per Decision-anchor #2; lookup is deterministic on DFS order.
- **`callerScopeAllowed(cockpit, src, tgt, scope): boolean` gate (D3)**: symmetric four-case policy table — (a) `ATMUX_CALLER_SCOPE === "driver"` master override, (b) same-team trivially allowed, (c) child-epic-team → parent allowed, (d) parent → child-epic-team allowed. Siblings under same parent + unrelated teams refused (must route via parent). Refusal text names both ends per Decision-anchor #5 so operators see the policy violation root, not a generic "scope refused."
- **`ATMUX_CALLER_SCOPE` env var (D3 / Decision-anchor #4)**: exact-match — no `ATMUX_SCOPE` shorthand, no `--scope` flag-form (env-only). Cockpit driver pane sets it once on bootstrap; member panes do NOT inherit it (cage-tier boundary per ADR-058).
- **Socket resolution respects nested cages (D4)**: cross-team heads-up loads target `team.json` directly + calls `resolveTeamSocket(targetTeam)` — no path-construction from source-cage state (Decision-anchor #6 reviewer pre-flag enforces no parent-cage-prefix leak).
- **Tests**: 13 unit tests in `tests/unit/core/cockpit.test.ts` for findTeamByName (depth-3 fixture + own-root vs parent-root + DFS deterministic match + leaf-type skip + null on miss) and callerScopeAllowed (full 7-case matrix: driver / same-team / child→parent / parent→child / siblings-same-parent / siblings-diff-parent / unrelated / unknown). 3 unit tests in `tests/unit/verbs/tell-lead.test.ts` for `--team` flag parsing (populate / missing-value error / bare-invocation fast-path preserved).
- **Out of scope**: member-to-member cross-team messaging (separate `atmux send --team` Task if needed); `atmux doctor` D8 / D9 cross-team-routing health checks (Task `t-c2e544b6` — sibling e2e); sibling-epic-team direct routing (refused per D3 — must route via parent); ADR-091 T12 conflict-surface migration (referenced for traceability; separate commit).
- **Cross-refs**: ADR-089 (`walkSessions` DFS substrate — load-bearing primitive), ADR-090 (epic-team lifecycle; forward-reference — `epicTeam.parent` linkage), ADR-091 (epic-merge conflict-surface; forward-reference — first consumer), ADR-029 (tell-lead bash spec — byte-equal contract preserved on default path), ADR-058 (cage tier; forward-reference — Tier-1 boundary respected), ADR-099 (error-handling — `EX_NOPERM=77` for refusal).

### 📋 Proposed — ADR-091 design doc draft (t-4af76f05)

- **New `docs/adr/091-kanban-driven-auto-merge.md`** — standalone design doc for the epic-team auto-merge state machine. Closes the layering deviation flagged across t-04350614 (`a34fafa`), t-9a8b0e4e (`b502ebe`), and t-9d22718b (`d79840b`) where impl + wire-up + e2e shipped first per planner discretion.
- **All 8 reviewer pre-flags folded into §Decision-anchor lines** (sourced from `.atmux/reviewer-preflag-ADR089-091.md` §ADR-091, signed 2026-05-13): #1 `BEGIN IMMEDIATE` on every transition, #2 conflict-surface durability (parent state.db write FIRST then tell-lead), #3 `reviewer-trunk-signoff` marker cited from [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #1 verbatim, #4 stale-epic rebase via `rebasing` intermediate state, #5 wrong-parent merge validation, #6 `dissolved` terminal state, #7 `conflict → in_progress` reverse transition (operator unblock path), #8 `mergeMode: "pr"` schema-accept-runtime-noop.
- **3 post-ship audit recommendations folded into §Decision-anchor lines** (from `.atmux/audits/adr-089-091-adjacent-class-2026-05-13.md` §Class 1): #9 `pr-open` state for pr-mode runtime (deferred), #10 PR-creation durability (`epic.prNumber` written to state.db BEFORE `gh` CLI returns), #11 `gh auth switch` process-global concurrency mutex via `cockpit_gh_lock` (mirrors [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #11).
- **Full state machine documented**: auto-mode chain `open → in_progress → ready_to_merge → [rebasing →] merging → merged → dissolved | conflict` plus pr-mode chain `ready_to_merge → pr-open → (pr-merged | pr-closed | pr-conflict) → dissolved` (deferred). Transition table covers all 15 valid edges with side-effects + priority order. EPIC-done definition mirrors [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #5 verbatim. Reverse-transition unblock path documented end-to-end.
- **Cross-refs canonical**: [ADR-090](docs/adr/090-epic-team-lifecycle.md) (schema + lifecycle), [ADR-134](docs/adr/134-in-team-auto-merger.md) (sibling intra-team merger, shared state machine module), [ADR-092](docs/adr/092-cross-team-tell-lead.md) (cross-team tell-lead, forward-ref for SECOND-line conflict surface). Reuse statement enumerates every primitive — zero new abstractions.
- **Open questions carved out**: §Decision-anchor #6 enum extension (adding `dissolved` to `BranchMergeState` requires scope-discrimination across ADR-091/ADR-134 — follow-up Task to decide), §Decision-anchor #7 verb sugar (`atmux epic advance --to in-progress` — follow-up).
- **Status: proposed** — flips to accepted after operator review or reviewer signoff. Earlier impl commits (a34fafa / b502ebe / d79840b) pin to the design captured here.

### 📋 Proposed — epic-team auto-merge e2e dogfood gate (ADR-091, t-9d22718b)

- **New `tests/e2e/epic-auto-merge.test.ts`** — full ADR-090↔ADR-091 loop walked end-to-end against a real git repo + real SQLite + scratch cockpit.json. Cold-started fixture per test via `mkdtemp` + `afterEach` teardown (stateful e2e per [CLAUDE.md](CLAUDE.md) §Testing Discipline — not a repeatable smoke).
- **Happy-path beat sequence**: parent-team fixture (real git, bare remote, parent state.db with seeded EPIC row) → `spawnEpic` verb provisions the child worktree + `team.json` + state.db + cockpit append → epic-team commits a feature file on its `<parentBase>-epic-<epicId>` branch → child kanban seeded with one done Task + the canonical `reviewer-trunk-signoff` Task in done (per [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #5) → three successive `epicMergeTickVerb` calls drive `open → in_progress → ready_to_merge → merging → merged` per the per-tick contract → on `merged`, the `dispatchDissolve` hook (wired by t-9a8b0e4e in `b502ebe`) invokes the production `dissolveEpic` verb which prunes the child worktree, unregisters the cockpit entry, marks parent's EPIC row done → assertions verify parent's `main` branch carries the child's commit under a `--no-ff` merge commit (`git log --merges`), the child `feature.md` file landed in the parent, cockpit no longer references the child, parent EPIC row is `status='done'` with `completed_at` set.
- **Reviewer-trunk-signoff gate**: separate test asserts a child kanban WITH a done feature Task but WITHOUT the `reviewer-trunk-signoff` Task stays in `in_progress` (gate-veto per §Decision-anchor #5) with the operator-actionable reason in the tick log.
- **Conflict-path beat sequence**: parent + child commit divergent versions to the same file → epic-merge tick observes `baseHasMoved: true` → state machine routes to `rebasing` per the shared `shouldTransitionFromInProgress` contract → no dissolve fires → worktree + cockpit entry persist for operator intervention. (Terminal `conflict` arrives via a subsequent rebase attempt OR future cron-driven rebase resolver — out of scope for this dogfood; the rebasing detour is the observable contract today.)
- **Cleanup-guarantees test**: confirms no orphan worktree + no orphan cockpit entry post-merged; a follow-up `dissolveEpic` invocation against the already-gone epic-team refuses with `not found in cockpit` (idempotent safety-net).
- **Test runtime budget**: each `test()` carries a 30s timeout per pre-flag #3. Real git ops dominate; the 30s ceiling fits CI's per-test slot.
- **Out of scope (per Task body §"Out of scope")**: `pr` mode dogfood (deferred per §Decision-anchor #6); `tell-lead` conflict-path surface to parent (forward-ref ADR-092 / T14 — once the cross-team caller-scope gate lands, the conflict test adds a `tell-lead --team parent-team` assertion).
- **Layering deviation**: ADR-091 `Status: proposed → accepted` from the Task AC is **NOT flipped in this commit** — the ADR-091 design doc (`docs/adr/091-kanban-driven-auto-merge.md`) is not yet on disk (`t-4af76f05` still todo). The dogfood test landed first per the planner-discretion-impl-before-design pattern that produced t-04350614; the doc lands as the Acceptance side under t-4af76f05, then a follow-up commit flips its status. Flagging for reviewer per the [[feedback-test-impl-session-pattern-2026-05-14]] "ship-and-flag" pattern.
- **Status: proposed** until the ADR-091 design doc lands + flips to accepted.

### 📋 Proposed — epic-team `spawn-epic` / `dissolve-epic` verbs (ADR-090, t-b430b185)

- **New `atmux team spawn-epic <epicId> --from <parentTeam>`** (`src/verbs/team/spawn-epic.ts`) — creates a child epic-team end-to-end. Pipeline: caller-scope gate (ADR-033 — refuses non-driver) → cockpit walk to resolve parent → compute `<parentRoot>-epics/<epicId>/` sibling path (per [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #2) + `<parentBase>-epic-<epicId>` branch → roster resolution (`--roster <preset>` / `--roster-file <path>`, mutually exclusive per §Decision-anchor #4, default `templates/epic-rosters/default.json`) → `provisionWorktree` (ADR-082/088 — `initSubmodules: true`) → synthesize + write child `team.json` with `epicTeam` block populated → init child `state.db` via `openDatabase` + `migrations` → append nested `epic-team` session under parent in cockpit.json → log next-step hint.
- **Transactional rollback** on mid-pipeline failure (per Task pre-flag #1): if step 6-8 fails after the worktree landed in step 5, the verb attempts `pruneWorktree(..., dirty: "force")` to undo the side-effect. The cockpit registry append is the LAST mutation; failure exits non-zero with the partial state visible (deliberate — operator can re-run after fixing the cause). Force-mode prune is safe here because the worktree was authored this turn — no operator data lives inside it.
- **New `atmux team dissolve-epic <epicId>`** (`src/verbs/team/dissolve-epic.ts`) — composes `softStop` (ADR-087, `src/core/soft-stop.ts`) + `pruneWorktree` (ADR-082) for the graceful tear-down. Pipeline: caller-scope gate → cockpit walk to locate epic-team + parent → load child `team.json` (best-effort — partially-spawned remnants still clean up) → pre-flight gates (skipped under `--skip-checks`): all child kanban Tasks in `done` / `wontfix` + worktree clean → soft-stop child cage (best-effort, fail-warn-continue) → prune worktree (dirty refuses with operator-actionable error unless `--force-prune` or `--skip-checks`) → remove epic-team entry from parent's cockpit sessions[] → mark parent's kanban EPIC row done (UPDATE epics SET status='done').
- **`--skip-checks` lead-override** per ADR-090 resolved-open #5 — bypasses both pre-flight gates AND switches prune to `force` mode. Logged loudly so the operator owns the consequences (also written to stderr as a WARN).
- **CLI registration** in `src/cli.ts::dispatchTeamSubverb` — `atmux team spawn-epic` + `atmux team dissolve-epic` join `team repair-rename` under the existing team-sub-dispatch.
- **Reuse statement** (per ADR-090 §Reuse statement): zero new abstractions. spawn-epic composes `provisionWorktree` + `openDatabase` + `Team.parse` + raw JSON read/write; dissolve-epic composes `softStop` (via injected `softStopHook` for test seam) + `pruneWorktree` + `isWorktreeDirty` + raw JSON read/write.
- **Tests** (`tests/unit/verbs/team/spawn-epic.test.ts` + `dissolve-epic.test.ts`): 15 + 13 cases respectively. Arg-parser unit tests cover every flag + mutual-exclusion + missing-required refusal. End-to-end tests use a scratch tmpdir + fake `cockpit.json` + mocked `GitSpawn` to exercise the worktree-create, child-team-write, child-state.db-init, cockpit-mutate, parent-EPIC-mark-done paths. Refusal-path coverage: caller-scope-member, parent-not-in-cockpit, epic-team-root-already-exists, roster-preset-not-found, open-tasks-without-skip, dirty-worktree-without-skip-or-force, epic-not-in-cockpit (dissolve).
- **Out of scope** (forward-refs): child cage auto-spawn (operator runs `atmux cockpit rebuild` after spawn-epic in v1; auto-spawn lands as a follow-up Task); `gh` fail-fast assertions for pr-mode (§Decision-anchor #10 — pr-mode runtime deferred; the schema layer's superRefine already refuses pr-mode without `prTarget.base` + `prAuthorUser`); cross-team `tell-lead` from epic-team back to parent (ADR-092 / T14); ADR-091 auto-merge state machine wiring on dissolve (epic-merge cron already auto-dispatches `dissolve-epic --auto` per `src/core/epic-merge.ts` — T9 of ADR-091 t-04350614, the bridge between the auto-merge ledger transition and this verb is the stderr TODO emitted from `tryDispatchDissolve`).
- **Status: proposed** until the cockpit auto-spawn lands + the epic-merge `tryDispatchDissolve` is wired to actually invoke `atmux team dissolve-epic --auto`.

### 📋 Proposed — epic-team auto-merge state machine + cron (ADR-091, t-04350614)

- **New `src/core/epic-merge.ts`** — caller wrapping the shared `branch-merge-state.ts` (ADR-091 + ADR-134 shared module landed in `7da4e85`) with epic-team scope. Exports `EpicMergeContext` + `performEpicMerge(ctx)` + pure `shouldEpicTransitionFromInProgress(gate, hasReviewerTrunkSignoff)`. Sibling of `intra-team-merge.ts` (ADR-134); both compose the same `MergerStateRepo` (rows coexist, addressed by branch name — no schema migration). The state machine is keyed on the epic-team's shared branch (`<parentBase>-epic-<epicId>`) per [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #3 carve-out (one row per epic-team, since members share the worktree).
- **Epic-team-aware gate** refines the shared `shouldTransitionFromInProgress` with ADR-090 §Decision-anchor #5: the `reviewer-trunk-signoff` Task gate. A done Task with `role: "reviewer-trunk-signoff"` MUST exist before `in_progress → ready_to_merge` fires, regardless of the other gate facts. Missing-signoff stays `in_progress` with an operator-actionable reason; the trunk-signoff Task is the EPIC's test-coverage gate (per project [CLAUDE.md](CLAUDE.md) §Testing Discipline).
- **New CLI verb `atmux epic-merge tick`** (`src/verbs/epic-merge.ts`) — one-shot cron entry-point. Resolves gate facts from the epic-team's kanban + git probes (`git status --porcelain` on parent, `git rev-list --count parentBase..HEAD` on epic, `git merge-base` for base-moved detection), composes `EpicMergeContext`, dispatches `performEpicMerge`. Default `by` attribution is `"epic-cron"`; bare invocation outside cron also works (idempotent on unchanged state).
- **New cron-line emission** in `src/core/cron.ts::renderCronLines` gated on `team.epicTeam !== undefined` — fires `atmux epic-merge tick` every `DEFAULT_EPIC_MERGE_CRON_INTERVAL_MINS` (5min default). Threading mirrors the merger / ombudsman / lane-stall override pattern (`cron-install --template epic-merge --interval <N>`). Normal teams (no `epicTeam` block) skip — additive.
- **mergeMode dispatch** per [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Decision-anchor #6: `"auto"` runs `mergeMember(parentBase, epicBranch, parentRepoPath)` (default, v1) — on success, advances directly to terminal `merged` (skips the `tested` intermediate that ADR-134 uses, since the trunk-signoff Task already absorbed the test gate per §Decision-anchor #5). `"pr"` is schema-accept-runtime-noop in v1: short-circuits at `ready_to_merge` with a deferred-runtime reason.
- **Auto-dispatch `dissolve-epic --auto`** stub on `merged` success — until T9 (`t-b430b185`, spawn-epic / dissolve-epic verbs) ships, the dispatch is a stderr-logged TODO with the epicId; operator dissolves manually for now. The verb's wiring lands in T9.
- **Conflict path** per pre-flag #3: surfaces to `merger_state.note` with conflict-paths detail. Cross-team `tell-lead --team <parent>` routing is forward-ref to ADR-092 / T14; until that ships, conflict surface stays in the row (operator-visible via `atmux status`) and the standing flag-add path applies.
- **Gitter brief update** (`templates/briefs/gitter.md`) — adds the EPIC-TEAM CARVE-OUT rule to the auto-merge mode hard-rules section: epic-team gitters do NOT run trunk merges; that's `atmux epic-merge tick`'s job. Parent-team gitters only handle merge-result notifications.
- **Out of scope** (forward-refs): `tested`/`test_failed` test-gate path (ADR-134 territory; epic-teams skip via §Decision-anchor #5); ADR-091 design doc proper (`docs/adr/091-kanban-driven-auto-merge.md` not yet authored under t-4af76f05 — impl ships first per planner discretion, ADR draft follows as the Acceptance side); pr-mode runtime (deferred per §Decision-anchor #6); cross-team `tell-lead --team <parent>` (ADR-092 / T14).
- **Status: proposed** until T9 (`t-b430b185`) wires the auto-dissolve dispatch + ADR-091 design doc lands under t-4af76f05.

### 📋 Proposed — epic-team lifecycle schema (ADR-090 T1)

- **New `team.epicTeam` config block + `TeamEpic` schema** per [ADR-090](docs/adr/090-epic-team-lifecycle.md) §Schema — required fields `parent` / `parentEpicKanbanId` / `parentBase`; defaulted `mergeMode` (enum `auto` | `pr`, default `auto`); optional `prTarget.{remote,base}` + `prAuthorUser` (required-when-pr via Team-level `superRefine`). Absent block = normal team (existing topology unchanged).
- **Three cross-field refinements on `Team`** enforce ADR-090's hard invariants at `loadTeam` time: (#3) `epicTeam` + `worktreeIsolation: true` ⇒ refuse (HARD CONFLICT carve-out vs ADR-084); (#8) `mergeMode: "pr"` ⇒ requires `prTarget.base`; (#9) `mergeMode: "pr"` ⇒ requires `prAuthorUser`. Refuse errors cite the §Decision-anchor # so operators can lookup the rationale.
- **Kanban schema additions** (`src/schema/kanban.ts`): `KanbanTask.role` (reserves `"reviewer-trunk-signoff"` per §Decision-anchor #1); `KanbanEpic.epicTeamName` + `.epicTeamRoot` (filled by `spawn-epic`, cleared by `dissolve-epic`); `KanbanEpic.prNumber` + `.prState` + `.note` (forward-refs for ADR-091 state machine). All `.nullable().optional()` for back-compat.
- **Roster preset** `templates/epic-rosters/default.json` — 7-member preset (lead + planner + reviewer + 2 fe-* + 2 be-*) per §Roster preset. Resolved by `spawn-epic` when no `--roster` / `--roster-file` flag passed (§Decision-anchor #4).
- **Epic-team lead brief** `templates/briefs/epic-lead.md` — delta brief that **extends, does NOT fork** `lead.md` (reviewer pre-flag #3). New placeholders `{{PARENT}}` + `{{EPIC_ID}}`; brief renderer (`renderBrief` in `src/verbs/rotate.ts`) gains optional `parent` + `epicId` vars (back-compat: omitted vars leave placeholders inert).
- **Out of scope this commit** (T1): `spawn-epic` / `dissolve-epic` verbs (T9 — `t-b430b185`); `start.ts` shared-worktree short-circuit (T10 — `t-7e9eed65`); ADR-091 auto-merge state machine logic (T12). Every schema field is purely additive; existing teams parse unchanged.
- **Status: proposed** until T9 + T10 + T12 land green and the ADR-090 + ADR-091 fan-in completes via dogfood gate (`t-9d22718b`).

### 📋 Proposed — commit-cadence ground-truth health signal (ADR-148)

- **New `team.cadence` config block** per [ADR-148](docs/adr/148-commit-cadence-truth-signal.md) §D7 — full schema lands in T3 (this commit, `t-e9424574`) so T2 / T5 land additively. Fields: `enabled`, `windowSec`, `thresholds` (4 verdict bands), `laneStallEnabled`, `laneStallMinAgeSec`, `exemptMembers`. Opt-in via `enabled: true`; lane-stall defaults on once master switch flips.
- **Lane-stall fallback cron** per ADR-148 §D4 (T3, `t-e9424574`): new `atmux lane-stall-tick` verb fires every 5min by default (override via `cron-install --template lane-stall-watch --interval <N>`). Scans `lane=X todo` Tasks older than `laneStallMinAgeSec` (default 30min) against per-member cadence verdicts; when ALL lane-affinity members have verdict ∈ {idle, dormant, ship-zero-window}, fires Enter-push `atmux claim <id>` to the lane's most-recently-active member's pane. Pane-state check mandatory before send-keys per CLAUDE.md (uses `safeSendKeys` for classify + retry + refuse). On refuse, appends to `<atmuxDir>/state/lane-stall-flags.md` for operator review. Dedup via `~/.atmux/state/lane-stall-fires.json` with `(taskId, lane, firedAt)` rows; skips re-fire within `laneStallMinAgeSec / 2` (15min default).
- **Sibling to ADR-127** lane-claim auto-pickup. ADR-127 handles the `member-idle` event (member finishes a turn → cron injects `claim --next`); ADR-148 §D4 adds the `lane-stall` event (Task waits in lane while members idle). Both paths converge on the same `atmux claim` Enter-push; lane-claim is per-member-state, lane-stall is per-Task-age.
- **Cadence verdict source** stubbed at the verb's dep-injection layer until T5 (`src/core/cadence-classifier.ts`) lands — defaults to `"idle"` for every member (worst-case fall-through; lane-stall fires whenever the age + lane-membership gates trip). T5 swaps in the real `classifyMemberCadence` reading per-member `git log --since=<windowSec>s --format='%H %ct'`.
### 📋 Proposed — cross-team complaint storage (ADR-150)

- **ADR-150: cross-team complaint storage semantics — target-team-authoritative writes (proposed)** ([docs/adr/150-cross-team-complaints-routing.md](docs/adr/150-cross-team-complaints-routing.md)). `atmux complaints file --target-team <t>` becomes AUTHORITATIVE for storage: the row is written to the TARGET team's `state.db` via cockpit-registry `atmuxDir` lookup, not the filer's; `origin_team` is set to the filer's `team.name`. Backward-compat preserved when `--target-team` is absent (current behaviour: filer's DB, `origin_team=NULL`). Resolve walks all teams in the cockpit registry (cheap; O(N) at fleet scale) — no globally-unique-ID-by-prefix routing. Listing: default returns rows received by current team; `--sent-by-me` walks the cockpit registry to surface rows where `origin_team === <current-team-name>` across all teams. New helper `lookupTeamAtmuxDir(cockpit, teamName)` reuses existing `walkSessions` DFS (per ADR-089); refuses on multi-match (operator config error) — silent first-pick rejected. New `complaints.origin_team TEXT NULL` column (nullable, optional in Zod; forward-only additive migration). Permission model is open in v1 (any team may file against any other); allowlist deferred to future ADR. Singular alias `atmux complaint` deferred to optional T7 (UX polish, not load-bearing). All 6 §Decision-anchor pre-flags folded (no bidirectional writes / walk-all-teams resolve / cockpit-registry O(N) cheap / `origin_team` nullable / refuse-on-multi-match / singular alias deferred). Kanban Task `t-3b65330b` (T1 doc; T2–T8 staged impl). Foundation routing primitive for ADR-152 cross-team aggregation + ADR-153 cross-team R1 (both currently deferred per their respective §Out of scope).

### 📋 Proposed — auto-promotion rules (ADR-153)

- **ADR-153: auto-promotion rules — kanban-blocked → complaint (24h) / driver-inbox → flag (12h) / lead-outbox → inbox_messages (6h) + `blocked_at` column (proposed)** ([docs/adr/153-auto-promotion-rules.md](docs/adr/153-auto-promotion-rules.md)). Three deterministic, idempotent, cron-driven rules that auto-promote stale signals from low-visibility to high-visibility surfaces. R1: kanban Tasks at `status=blocked` aged >24h auto-file a complaint with `blocker_class="dep-not-shipped"` default (override via `[blocker_class:X]` Task-body marker); auto-resolves when the Task transitions out of blocked. R2: driver-inbox rows with no triage glyph aged >12h auto-append a `[stale-inbox]` flag entry (one-shot, persists until manual `atmux flag resolve`). R3: lead-outbox `## Open` rows unacked >6h auto-emit a heads-up via `inbox_messages` (dedup'd by `relates_to_outbox` predicate; auto-archives via existing `atmux outbox --ack`). New `tasks.blocked_at INTEGER NULL` column set in same transaction as `status='blocked'` UPDATE; existing-row backfill heuristic `blocked_at = claimed_at` is an acknowledged cut-over compromise. Wires into existing whip cycle (extended turn appends `runGroomPass()` — no new cron line); standalone invocation via `atmux groom [--rules R1,R2,R3] [--dry-run]`. Thresholds configurable per-team via `team.json.groom.autoPromotionThresholds` (`r1Hours`/`r2Hours`/`r3Hours`), fleet-default via `cockpit.json`. Every rule carries a `NOT EXISTS (... opened_via=<rule-id> ...)` idempotence predicate — reviewer's load-bearing audit-row. All 8 §Decision-anchor pre-flags folded (default class + idempotence + cron-not-write-hook + flag-stays-one-cycle + backfill compromise + configurable thresholds + cross-team deferred + R3 dedup). Closes complaint `c-33475fd6` (originator: driver-claude-sopx /bruh sweep 2026-05-16 00:17 MYT). Kanban Task `t-28a75ee5` (T1 doc; T2–T7 staged impl). Temporal-overlay sibling of ADR-152; foundation freshness signal for ADR-151 (unblocker).

### 🟢 Shipped — proposed ADRs
- **ADR-152: atmux blockers list unified verb (proposed)** ([docs/adr/152-atmux-blockers-list-unified-verb.md](docs/adr/152-atmux-blockers-list-unified-verb.md)). New `atmux blockers list [--json] [--class <c>] [--source <s>] [--max-age <duration>]` verb fans across the 7 coordination surfaces (kanban / complaints / flags / driver-inbox / lead-outbox / decisions / todo) and emits normalized rows `{id, source, opened_at, age, summary, blocker_class, suggested_action, related_task_id?}`. 8-value `blocker_class` closed enum: `decision-pending` / `member-stuck` / `cross-lane-WIP` / `tooling-broken` / `stale-claim` / `dep-not-shipped` / `review-pending` / `push-policy-gate`. READ-ONLY aggregation layer — markdown surfaces stay markdown; SQLite surfaces (kanban, complaints) gain one additive `blocker_class` column; works BEFORE AND AFTER ADR-154 storage port. Closes complaint `c-1d28fc72` (originator: driver-claude-sopx 2026-05-15). Kanban Task `t-94a1c95e` (T1 doc; T2–T6 staged impl). Foundation for ADR-151 (unblocker) + ADR-153 (auto-promotion) + ADR-154 (storage port).

### 📋 Proposed — ombudsman role + release-notes layout (ADR-147)

- **New per-team role `ombudsman`** per [ADR-147](docs/adr/147-ombudsman-and-release-notes.md) §D1 — adjudicates open complaints (filed by medic / whip-velocity-gate / operator / CLI) and writes a durable response log to the day's release-notes file. Closes the parking-lot task `t-441d6d4c` reframed as the EPIC umbrella.
- **Event-driven wake** per ADR-147 §D2: sentinel file `.atmux/state/ombudsman-pending.json` + 15min `atmux ombudsman tick` cron line. NOT in whip cadence — lane-tick must NOT inject `claim --next --as ombudsman`.
- **Adjudication authority** per ADR-147 §D3: file epic / file task / wontfix / already-addressed / defer. Every action appends a one-line entry to today's `docs/release-notes/<Y>/<M>/<Y-M-D>.md` under `## Complaints adjudicated`.
- **New release-notes layout** per ADR-147 §D4: `docs/release-notes/<YYYY>/<MM>/<YYYY-MM-DD>.md` with append-only sections (`## Shipped`, `## Merges`, `## ADRs landed`, `## Complaints adjudicated`, `## Doctor regressions`, `## Notes`). Each section is owned by a specific agent (gitter for Shipped + Merges, ombudsman for Complaints, medic for Doctor regressions). First writer of the day creates the file; section headers act as natural insertion anchors so concurrent appends stay conflict-free.
- **Entry-point**: new `docs/release-notes/README.md` documents the layout + browsing convention + auto-generated 30-day TOC.
- **Doctor probe `release-note-missing`** (warn-class) per ADR-147 §D5 — fires when today has ≥1 trunk commit AND `docs/release-notes/<Y>/<M>/<Y-M-D>.md` does not exist. Backstop for missed days; not a gate.
- **Status: proposed** until ADR-147 T9 dogfood gate (atmux-team's first day-file lands cleanly + 3 known open complaints adjudicated by ombudsman, not operator).

### 🏷️ Renamed — cockpit naming convention (ADR-135)

- **Cockpit session renamed** from `atmux_teams` to `atmux_cockpit` per [ADR-135](docs/adr/135-cockpit-naming-convention.md). New default for `cockpit.json::cockpitSession`; the literal `atmux_teams` is accepted during the deprecation window with a one-line warning (`deprecated literal, rename to atmux_cockpit per ADR-135`).
- **Cockpit-role windows gain underscore prefix**: `superdriver → _superdriver`, `medic → _medic`, `martinet → _martinet`. Per-team viewer windows stay plain (no underscore). Single-underscore signals "cockpit system role" and sorts before plain team names in `tmux list-windows`. Double-underscore remains reserved for atmux-internal placeholder windows (`__home`, `__driver` in `start.ts`).
- **Member windows gain hyphen separator**: `buildWindowName` emits `<emoji>-<member>` (was `<emoji><member>`). Examples: `🧭-lead` (was `🧭lead`), `📦-whip-impl` (was `📦whip-impl`). Symmetric with hyphenated member names already in use (`whip-impl`, `parity-cron-impl`); regex/tab-completion-friendly; no shell-quoting hazard around variation-selector emoji like `🛠️`.
- **Migration is in-place + idempotent**: `atmux cockpit rebuild` detects legacy `atmux_teams` session + non-underscored cockpit-role windows and renames them via `tmux rename-session` + `tmux rename-window` (preserves pane PIDs, attached clients, scroll history). `atmux start` (or `atmux team rebuild --force-cycle`) applies the member-window hyphen migration the same way. Re-running rebuild after migration is a no-op.
- **Cron migration**: `atmux cron-install` idempotently rewrites emitted cron lines that reference the old session/window names (`atmux_teams:medic` → `atmux_cockpit:_medic`, etc.), same pattern as ADR-133 TR6.
- **No state-file migration**: `cockpit.json` is a value-level (string-literal) field, not a key-level change; legacy literal accepted with warning during the deprecation window. After one semver bump (timeline TBC), the literal becomes a hard error pointing at ADR-135.

### 🏷️ Renamed — `superdoctor` → `medic` (ADR-133)

- **Cockpit self-healing role renamed** from `superdoctor` to `medic` per [ADR-133](docs/adr/133-medic-rename.md) to eliminate the `atmux doctor` verb-vs-process naming collision. `medic` is collision-free and semantically tight for the cockpit-fleet-healer role.
- **Operator-visible surface:** `cockpit.json.medic` is the new canonical config block. The legacy `cockpit.json.superdoctor` key is still accepted during the deprecation window — `atmux cockpit rebuild` emits a one-line deprecation warning (`deprecated key, rename to medic per ADR-133`) but proceeds normally. If both keys are present, `medic` wins and a warning lists `superdoctor` as ignored.
- **Window 2** of the cockpit session is renamed `medic` (was `superdoctor`).
- **Docs:** `docs/superdoctor.md` → `docs/medic.md`. Cross-refs in ADR-081 / ADR-079 / ADR-086 updated with first-occurrence footnotes citing the rename. ADR-077 carries an annotation header per the append-only ADR convention (the file is not renamed).
- **Out of scope this release:** storage-layer identifiers — `superdoctor_attempts` table, `SuperdoctorAttemptsRepo` class, `__superdoctor__` member sentinel, `superdoctor-self-heal-escalation` Discord dedup key, `src/core/superdoctor-activity.ts` source path, `~/.claude/skills/superdoctor/` skill path, and `[superdoctor]` Discord template prefix all remain unchanged. Schema renames require a separate migration ADR; skill source + Discord template renames ship under EPIC `t-d25ff629` TR5+.

### ⚙️ Migration — `atmux superdoctor` → `atmux medic` cron-line rewrite (ADR-133 TR6)

- **`atmux cron-install` now idempotently rewrites any `atmux superdoctor [args]` cron line inside an atmux-managed block** (`# >>> atmux:team=...` / `# >>> atmux:cockpit`) to `atmux medic [args]`. No-op on every current installation (atmux does NOT write `atmux superdoctor` cron lines today — the cockpit superdoctor runs via tmux pane keystroke `/loop /superdoctor`, not crontab), but forward-compat for the deprecation window if any path begins emitting them or if operators have hand-installed legacy lines inside a managed block.
- **Operator-manual cron lines OUTSIDE atmux-managed blocks are PRESERVED** — the migration only touches lines fenced by the `# >>> atmux:...` / `# <<<` markers.
- **Audit log** at `~/.atmux/state/cron-rename-migration.log` records every rewrite (no-op on installs where no migrations fire).
- Source: `src/core/cron.ts::migrateSuperdoctorToMedicCronLines` (pure transform) + `src/verbs/cron-install.ts` wiring + unit + integration tests.

### ⚠️ Deprecated — `cockpit.json.superdoctor` block (ADR-133)

- The `superdoctor` key in `~/.atmux/cockpit.json` is **deprecated as of this release**. Operators should rename their cockpit config to use the new `medic` key. The deprecation window is **one release cycle**; the next release ships the BREAKING removal below.
- Migration path:
  ```bash
  # in ~/.atmux/cockpit.json, rename the block:
  # before: "superdoctor": { ... }
  # after:  "medic": { ... }
  atmux cockpit rebuild
  ```
- The deprecation warning fires on every `atmux cockpit rebuild` until the rename ships. Silent on `atmux status` / `atmux doctor` for now.

### 🚨 Coming next release — BREAKING: drop `cockpit.json.superdoctor` key (ADR-133)

- **Next release will REMOVE the `superdoctor` key acceptance from `cockpit.json` schema.** Operators on the legacy key will fail-fast on `atmux cockpit rebuild` until they migrate. The deprecation warning shipping this release is the operator's one-cycle migration window.
- Plan ahead: rename `superdoctor` → `medic` in your cockpit config before upgrading past the next release. Schema validation will reject the legacy key with a clear error pointing to ADR-133.

### ✨ Added — `atmux pulse` (ADR-086)

- **`atmux pulse`** — cockpit-wide deterministic verdict probe. Iterates every enabled team in `~/.atmux/cockpit.json`, gathers commit count + doctor red count + kanban / driver-inbox / pending-decisions inputs, computes one of five verdicts (`🟢 Shipping` / `🟡 Cool` / `🟡 Idle` / `🔴 Stalled` / `🚨 Need you`), and pings Discord on verdict change or sustained-urgency dedup expiry. Phase 1 of the MiniMax observer (Phase 2 swaps the renderer for an LLM call against the same input bundle).
- **New Discord template `pulse-verdict`** in `src/abstractions/discord.ts` — verdict-first format with per-verdict header emoji (💓 / 📊 / 🛑 / 🚨).
- **New cockpit schema field `pulse`** (`windowMins` / `intervalMins` / `dedupMins`, defaults 30 / 5 / 30).
- **New state file** `~/.atmux/state/pulse-state.json` — cockpit-scoped, one row per team, dedup via `shouldFire(prior, current, now, dedupMins)`.
- **Auto cron install** wired into `atmux cockpit rebuild` Phase 6 — a new `# >>> atmux:cockpit` marker-fenced block (distinct namespace from per-team blocks) lands `*/5 * * * * atmux pulse` idempotently every rebuild. Honors `ATMUX_NO_CRON=1` + cockpit.pulse.intervalMins override. Manual install line preserved in `docs/RUNBOOK-pulse.md` for operators who don't run `cockpit rebuild`.

## [0.5.0] — 2026-05-08

> Themes: **pull-model kanban** (Epic 1, see ADR-007)
> — Epic/Story/Task data model, lane-aware `claim --next`, auto-dispatched
> commit-Tasks, Story-level reviewer signoff, `atmux decisions add` verb;
> plus **whip Since-last-tick delta enrichment + richer decisions** (Epic 2,
> see ADR-009 §S7–§S10 + ADR-008 §S9–§S10) — per-bullet renders for done-
> tasks/commits/advanced-stories with `[E#/S#]`/`<sha>`/`<sid>` anchors,
> `story.advancedAt` schema field, decisions verb gains 4 optional fields
> (`--context` / `--option` ×5 / `--impact` / `--decided-by`) with section-
> aware multi-message Discord chunking + `[N/M]` headers; plus **auto-rotation
> infrastructure** (ADR-009 §S1–§S5) — opt-in `team.whip.autoRotate` flag,
> per-member rotated.epoch anchor, banner handoff; plus **`atmux flag` verb**
> (Epic 4, see ADR-010) — member→lead structured issue surfacing with p0
> Discord gating + `--task --needs unblock` atomic blocked-state mutation;
> plus **hot reload** (Epic 3, see ADR-011) — `atmux brief-reload`,
> `atmux config-reload`, `atmux verify-libs`, versioned briefs with whip
> auto-detect (verbs 3 + 6 carved to recommended **E5** for pane lifecycle +
> per-claim state work).

### ✨ Added — post-0.6.0 follow-ups

- **ADR-148 T5 — commit-cadence classifier lifted + martinet observation cadence field + per-member E6 escalation** (t-ac95b267).
  Lifts the inline cadence classifier T2 (t-1d370b04) inlined in `src/verbs/status.ts` into a shared `src/core/cadence-classifier.ts` module so martinet observe() + future medic + doctor consumers all read one contract. `status.ts` re-exports the public surface (`CadenceObservation`, `CadenceThresholds`, `classifyCadence`, `defaultGitLog`) so pre-T5 importers stay valid. New `classifyMemberCadence(member, worktreePath, config, deps)` async wrapper composes the canonical `git -C <path> log --since=<N>s --author=<member> --format=%H %ct` probe with the pure classification step — sinceSec capped at `max(windowSec, dormantMax)` so the probe sees the actual last commit even when it falls outside `windowSec` (needed for `ageOfLastCommitSec`). Fail-soft probe (returns `[]` on any git error) per T2's status.ts contract; injectable for tests. Martinet `Observation.members[].cadence?: CadenceObservation` field added — composed by the cockpit-W3 dispatcher (T7/T8 wire-up; the type extension is the load-bearing surface). Escalation classifier `src/core/martinet-escalation.ts` extended: alongside the pre-existing team-aggregate `commitCadence.last2hr === 0` path, ANY member's `cadence.verdict === "ship-zero-window"` now fires the `ship-zero-2hr` reason (closed `EscalationReason` enum unchanged — both paths share the literal so the dispatcher's evidence threading stays bounded). `else if` short-circuits the second path so the reason fires exactly once even when both gates trip. Same-commit unit tests: 15 cases under `cadence-classifier.test.ts` covering the full §D2 verdict matrix (shipping / idle / dormant / ship-zero-window with precedence + boundary + empty-log + malformed-line + clock-skew edge cases), the async wrapper's `sinceSec = max(windowSec, dormantMax)` cap, and clock injection; 5 new cases under `martinet-escalation.test.ts` covering the per-member ship-zero-window E6 path (HIT with mixed roster + NEAR-MISS shipping/idle verdicts + reason-deduplication when both team-aggregate AND per-member paths fire). Same-commit docs: `docs/ARCHITECTURE.md` cadence-classifier module-map entry. **Deferred to follow-up** (explicit scope-trim per driver's `/team rotate-lead` at 30% ctx guidance — single focused commit): (a) Discord `[ship-zero-window]` named template — light additive `src/abstractions/discord.ts` extension when the operator-facing render is needed; (b) medic event-driven pickup — ADR-148 task body's spec is "concrete site decided at impl time" between `src/verbs/medic.ts` vs the medic skill brief; not load-bearing for §E6 gate firing. The deferred work is captured in the follow-up TODO chain; T5 closes here with classifier + martinet E6 wire-up green per the load-bearing ADR-132 §E6 contract. typecheck clean; biome lint clean; bun-test gated per `feedback_pause_bun_tests` memory.

- **ADR-134 T4 — `atmux gitter --sweep` cron backstop + `team.autoMerge` schema** (t-64e52aac).
  Per-team cron-fired sweep catching merge attempts missed by the T3 event-driven socket-pubsub path. New `src/verbs/gitter.ts` hosts the `--sweep` sub-verb (also accepts `sweep` positional form for cron-line ergonomics); `src/core/gitter-sweep.ts` is the pure eligibility-analysis layer. Sweep flow: `git -C <teamRoot> branch --list --format=%(refname:short) <baseBranch>-*` enumerates candidates → per-candidate `rev-list --count <base>..<member>` filters to ahead-of-base → `MergerStateRepo.getState(memberBranch)` consultation classifies in-flight (`in_progress`/`ready_to_merge`/`rebasing`/`merging`/`tested`/`test_failed`) vs queue-eligible (terminal `merged`/`conflict`/`reverted` with fresh tip, OR `open`/null) → injected `QueueMergeFn` callback fires the merge attempt. Returns `GitterSweepResult` with per-branch entries + aggregate `checked/queued/skipped/refused` counts; verb-layer logs a one-line summary + per-entry detail to the cron log. Idempotent — re-running when every branch is merged or in-flight is a zero-op pass; `BEGIN IMMEDIATE` transactions in `MergerStateRepo.transition` (per ADR-091 reviewer pre-flag) keep concurrent event-driven + cron-backstop firings on the same branch race-safe. New `TeamAutoMerge` Zod schema landing the full ADR-134 §Config surface (`enabled`, `requireReviewerSignoff`, `skipTestGate`, `testCommand`, `revertOnFail`, `cronBackstopMin`, `maxMergesPerHour`); only `enabled` is consumed by T4 (gate the verb), the rest are forward-compat for T6 gitter member impl + T7 cron-install template + T8 e2e. `team.autoMerge` distinct from existing `team.merger` (ADR-088 bulk merge-cycle) — both coexist; they serialize through the same `MergerStateRepo` shared state machine. `DEFAULT_AUTO_MERGE_CRON_BACKSTOP_MIN = 10` co-located with schema for T7 cron-install consumption. **Sibling-task layering**: the production dispatcher (T3 / t-27b06cda event-driven, parallel work) hasn't shipped — until it lands, T4's `queueMergeAttempt` default factory uses `recordingQueueMergeAttempt` which logs queue intent + returns `{queued: true}` so the sweep emits useful evidence without crashing. When T3 ships, the verb-layer factory swaps the real dispatcher in; the sweep core stays unchanged. CLI dispatch registered at `case "gitter"` in `src/cli.ts`. Same-commit unit tests: 16 cases under `gitter-sweep.test.ts` covering branch enumeration (empty / git-failure / glob format), ahead-of-base check (0 / >0 / non-numeric / non-zero exit), in-flight state recognition (each of 6 in-flight literals + `open` as initial), terminal-state + fresh tip semantics (3 terminals × queue-eligibility), dispatcher refusal (with-reason + without), multi-branch aggregate matching the task body's 3-member acceptance ("2 ahead, 1 already merging → queues exactly the 1 missing"), and idempotence (second sweep after recorded transition skips). 11 cases under `gitter.test.ts` covering arg parsing (--sweep / sweep / --team-dir / errors), recordingQueueMergeAttempt logging, verb integration (autoMerge.enabled !== true → no-op exit 0, autoMerge unset → no-op, 2-branch dispatch + queue + summary log, default factory falls back to recording stub), top-level gitter() dispatch. typecheck clean; biome lint clean; bun-test gated per `feedback_pause_bun_tests` memory.

- **ADR-147 T3 — `atmux cron-install --template ombudsman-tick` + role-gated cron line** (t-94a22bb0).
  Extends `cron-install` to emit a per-team `atmux ombudsman tick` cron line for the ADR-147 complaint-adjudicator role. New `--template ombudsman-tick` flag is the operator-facing "I'm installing for the ombudsman role" assertion — validates `team.ombudsman.enabled === true` at install time (`ConfigError` with hint citing ADR-147 + the role-member step if not). Mirrors the ADR-088 W7 `--template merge-cycle` gating pattern verbatim. The `--interval Nm|Nh` flag now opts in via the new `TEMPLATES_WITH_INTERVAL` allowlist (`merge-cycle` + `ombudsman-tick`); the parsed value threads through `installCronBlock` as `ombudsmanIntervalOverride` (new field on `RenderCronBlockOpts`), wins first against `team.ombudsman.tickIntervalMins`, then the schema's `DEFAULT_OMBUDSMAN_TICK_INTERVAL_MINS` (15 per ADR-147 §D2). `--interval` is transient — `team.json` on disk is not rewritten (unit-tested). The line shape: `<cronEvery(N)> PATH=… ATMUX_DIR=… /usr/local/bin/atmux ombudsman tick >> <atmuxDir>/logs/ombudsman.log 2>&1` — relies on `ATMUX_DIR` for team resolution (consistent with other cron lines; the verb's `requireTeam` reads from env). The ADR's `--team <team>` shorthand reframed as `ATMUX_DIR`-via-baseEnv per the verb's actual `--team-dir <path>` signature. **Renderer gating** (in `renderCronLines` step 9): line emitted IFF `team.ombudsman.enabled === true` AND `team.members[]` contains an entry with `role: "ombudsman"`. Absent either, the line is suppressed silently — matches the `unblocker` precedent of gating cron output on member-roster presence. The template-flag validation surfaces the `enabled` half at install time (operator-friendly fail-fast); the member-role half stays at the renderer (adding/removing a member is a separate team-config step). Bare `cron-install` (no `--template`) on an enabled+member team STILL emits the line — the template flag is the assertion, not the gate. Same-commit unit tests (10 cases): `--template ombudsman-tick` emits expected line shape with default cadence; `enabled=false` rejects with `ConfigError`; no-block-at-all rejects with hint; `--interval 5m` overrides cadence; `--interval` transient (team.json byte-identical pre/post); `team.ombudsman.tickIntervalMins=30` honored when --interval omitted; bare install on enabled+member team emits line; enabled=true but no role=ombudsman member → line absent; enabled=false → line absent; idempotent re-install → byte-identical body. `CRON_INSTALL_TEMPLATES` allowlist updated to `["merge-cycle", "ombudsman-tick"]`. typecheck clean; bun-test gated per `feedback_pause_bun_tests` memory.

- **ADR-132 T3 — `CursorMartinet` impl + cockpit cursor cage wiring** (t-e96d286a).
  Production-default pluggable martinet impl shipping as `src/abstractions/martinets/cursor.ts` per [ADR-132 §D4](docs/adr/132-pluggable-martinet.SUPERSEDED.md) + [ADR-140](docs/adr/140-cheap-model-first.md) cheap-model-first principle. Cage-agnostic class — the dispatcher injects `runCursorAgent` (default factory shells out to `cursor-agent --print --output-format json --model composer-2-fast --force <prompt>` via `src/abstractions/spawn.ts`) and `sendKeys` (defaults absent → `apply()` returns success=false with diagnostic evidence rather than silent no-op). `decide()` always invokes runCursorAgent at least once per tick (T7 e2e Case 5 invariant), parses the canonical `{type, subtype, is_error, result, usage}` envelope, validates the nested `result` JSON as `NudgeAction[]` via Zod, and re-attaches the live `Observation` to escalate-to-claude-lead emissions. Fail-loud paths (spawn throw / unparseable envelope / schema mismatch / `is_error: true` / invalid action shape) all funnel to a single escalate-to-claude-lead carrying a diagnostic reason — no silent regressions on broken-binary scenarios. `shouldEscalateToClaudeLead()` composes T6's `classify()` + `shouldEscalate()` with an empty-history fallback so unit tests that carry only the current Observation exercise the E6 mandatory floor + E2 P0-hygiene gate; `historyFn` injection drives the temporal gates (E1 / E3 / E4 / E5) for the cockpit-tier dispatcher. NudgeAction kind mapping (per task body's six-kind expanded set, mapped onto the four T2 interface kinds): `enter-push` → 1:1; `claim-next` → 1:1; `rotate-routine` → emit `rotate` with reason="routine" per ADR-140 amendment; `modal-release` → emit `enter-push` with reason="modal-release"; `force-push-approved` → emit `escalate-to-claude-lead` (destructive git ops are operator-only per CLAUDE.md push policy); `escalate-to-claude-lead` → 1:1. Verb wiring: `src/verbs/martinet.ts::buildMartinet` constructs `CursorMartinet` when `impl === "cursor"` and threads `cockpit.martinet.cursorBinPath` + `cockpit.martinet.model` into the default spawn factory; existing fleet-default-fallback path warns and falls back to `ClaudeMartinet` only on a forward-compat unknown impl literal. Cockpit window: `src/verbs/cockpit.ts::buildMartinetWindowCommand` cursor variant emits `while true; do atmux martinet tick; sleep 270; done` (no Claude TUI — cursor-agent is a `--print` CLI; the bash loop owns cadence at the W3 window). Cage posture: the cockpit W3 window itself runs as operator UID with full git access per ADR-058 §D1 trust posture — no separate per-team `/tmp/atmux_cursor_martinet_<team>/sock` cage is provisioned (martinet is fleet-wide singleton; per-team cage paths in the original t-e96d286a body predated the §D2 fleet-singleton reshape). Same-commit unit tests: `tests/unit/abstractions/martinets/cursor.test.ts` exercises constructor name + default + override model, observe pass-through, decide happy path (CLI args + multi-line stream-json envelope), six fail-loud branches, four apply variants (enter-push, claim-next, rotate, sendKeys-missing diagnostic), and §D5 gate (E6 mandatory + clean-state false + E2 wedge + E1 historyFn temporal gate); `tests/unit/verbs/martinet.test.ts` updated to assert cursor branch constructs `CursorMartinet` (was: falls back to claude with warn) plus cockpit-binPath-override coverage; `tests/unit/verbs/cockpit.test.ts` adds `buildMartinetWindowCommand` claude-variant + cursor-variant assertions; `tests/e2e/cursor-martinet.test.ts` static import replaces the dynamic-import + `@ts-expect-error` shim per the test's documented "remove when t-e96d286a ships" trip-wire. typecheck clean; bun-test gated per `feedback_pause_bun_tests` memory.

- **ADR-088 W8 — end-to-end merger-fan-in e2e test** (t-7a7f0825).
  `tests/e2e/merger-fan-in.test.ts` walks the full ADR-088 fan-in path against a real git repo with a bare remote + per-member worktrees + 3 members on `develop-<member>` branches: (1) `merge-cycle --dry-run` lists 3 prospective merges without git mutation; (2) `merge-cycle --push` lands all 3 clean + base advances ≥3 commits + remote receives push; (3) conflict isolation — when two members modify the same line of README, the conflict is contained to one member's branch, the sibling still merges, and a `merger-conflict` flag with `severity=high` lands in `flags.md`; (4) doctor's `merger-branch-stale` probe — backdating a member's tip via `GIT_COMMITTER_DATE` triggers a yellow row from `checkMergerFanIn`; (5) fresh commits do NOT fire the stale probe. Uses `develop` as base (non-staging-shaped) so the push-policy gate doesn't refuse; teams using `main`/`master`/`<x>-staging` see `refused-by-policy` per the W2 push-policy contract. Non-idempotent (per CLAUDE.md "stateful e2e specs are not repeatable smokes") — each test cold-starts a fresh mkdtemp'd repo. `.gitignore` in the fixture excludes `.atmux/` so W1's `guardBaseWorktreeClean` doesn't refuse the merge. 5 e2e cases passing. Out-of-scope (defer to a follow-up sibling e2e): `atmux stop --force` cleanup verification — the stop verb's session/tmux state probes are heavy and orthogonal to fan-in correctness. This commit also cherry-picks W5 (templates/briefs/merger.md, t-ab5e31f6) and W6 (doctor merger-fan-in probes, t-81fca58f) from sibling worker branches (`geoyws-parity-state-impl`, `geoyws-up-impl-2`) — needed locally to write the W8 e2e and unblock the chain ahead of gitter's natural merge cycle (operator-authorized cross-lane cherry-pick under the "ship it" policy).

- **ADR-088 W7 — `atmux cron-install --template merge-cycle [--interval 5m|15m|1h]`** (t-2f12839e).
  Extends `cron-install` to emit a `merge-cycle` cron line in the team's standard marker-fenced block. Gated on `team.merger.enabled === true` — operators flip the schema field to opt in. New schema field `team.merger.cycleIntervalMins` (optional, integer minutes) sets per-team cadence; default 15min when unset (matches ADR-088 §Decision-5 default). The new `--template merge-cycle` flag is the operator-facing "I'm installing for merge-cycle" assertion — it validates `merger.enabled === true` at install time (fail-fast `ConfigError` if not set, with a clear hint). The `--interval <N>m|<N>h` flag accepts transient cadence overrides (parsed via the new exported `parseIntervalToMins` helper; rejects bare numbers + 0 + negative + garbage); threaded through `installCronBlock` → `renderCronLines` as `mergerIntervalOverride` so the operator can pin a one-off cadence without rewriting team.json. The merge-cycle line shape: `<cronEvery(N)> PATH=… ATMUX_DIR=… /usr/local/bin/atmux merge-cycle --push >> <atmuxDir>/logs/merge-cycle.log 2>&1`. Idempotent re-install yields byte-identical body. 16 new unit tests covering parser (--template / --interval allowlist + mutual deps + bad input), the new `parseIntervalToMins` helper, and the cronInstall verb's integration paths (enabled-true emits line, enabled-false skips, --interval overrides, idempotence). Unblocks W6 (doctor probe consumes the same gate).

- **ADR-088 W3 — `atmux merge-cycle [--push] [--dry-run]` bulk wrapper** (t-d78127c7).
  Single-shot bulk-merge across every `<base>-<member>` branch in one cycle. Flow: `git fetch origin` once → `git branch --list "<base>-*"` enumerate → per-candidate `git rev-list --count` pre-filter (skip 0-ahead) → W1 primitive call with `fetch: false` (avoids redundant fetch per branch) → per-branch conflict captured but cycle CONTINUES (per ADR-088 §Decision-4 "On conflict per-branch: continue iteration"). Summary at end: `{ merged: [...], noOp: [...], conflicts: [...] }` + (when `--push`) ONE push of `<base>` at cycle-end covering all merges that landed (overrides ADR §OQ-3 default "per-merge" for cycle mode since the cycle is the atomic unit). `--dry-run` lists prospective merges without git mutation; mutually exclusive with `--push`. CLI dispatch registered at `case "merge-cycle"` in `src/cli.ts`. 28 unit tests / 98.55% line coverage. Exit-code contract: `0` on clean cycles + push-refused-by-policy; `1` on any conflict OR push-failure. Unblocks W5 (merger brief), W7 (cron template), W8 (e2e).

- **ADR-088 W2 — `atmux merge-member <member> [--push]` verb wiring** (t-e7724527).
  Wraps the W1 primitive with the policy + surfacing layer. Steps: `requireTeam` → `resolveMergerConfig` to get `baseBranch` (explicit or via current-HEAD) → `wtBranch = ${base}-${sanitizeBranchSegment(member)}` → W1 primitive → outcome handling. Exit-code contract: `0` on merged / no-op / push-refused-by-policy; `1` on conflict / push-failure. Flag surface: appends to `<atmuxDir>/flags.md` (`severity=high` for conflict + push-failure; `severity=medium` for push-refused). Push policy: reuses `isPushAllowed` from `src/core/auto-push.ts` — same staging-pattern regex (`-staging$`, `^main$`, `^master$`, `^production$`) gates both `atmux done` auto-push + merger fan-in push. Refused pushes keep the merge locally + raise a flag for operator's manual follow-up. CLI dispatch registered at `case "merge-member"` in `src/cli.ts`. 20 unit tests / 99.15% line coverage. Unblocks W3 (`merge-cycle` bulk wrapper) + W5/W6/W7/W8 downstream.

- **ADR-088 W1 — `src/abstractions/branch-merge.ts` `mergeMember(base, wtBranch, repoPath, opts)` primitive** (t-bed51da2).
  Per-member branch fan-in primitive ([docs/adr/088-per-member-branch-fan-in.md](docs/adr/088-per-member-branch-fan-in.md) §Decision-3). Pure git-shell wrapper using the `GitSpawn` injectable pattern (mirrors `worktree.ts` / `auto-push.ts`); every invocation routes through `git -C <repoPath>` so the function is repoPath-agnostic at the spawn layer. Idempotent (returns `{ status: "no-op", reason: "no-commits-ahead" }` when re-fired post-merge). Three hard-refuse guards: `guardBaseWorktreeClean` (uncommitted changes), `guardBranchExists` (missing wtBranch), `guardCommitsAhead` (zero-ahead → no-op exit). On conflict: captures porcelain status for the conflicted-path list, fires `git merge --abort` to restore the worktree to clean, throws `MergeConflictError` carrying both `wtBranch` + `conflictPaths`. New `MergeConflictError` class extends `ConfigError`. Unit suite: 27 cases / 100% line + func coverage on the new module (mock-injected GitSpawn for every decision-tree branch; one real-git smoke against `defaultGitSpawn`). Gates 6 downstream ADR-088 W2-W8 tasks (verb wiring, bulk merge-cycle, brief, doctor probe, cron template, e2e).

- **`atmux complaints file` — whip-velocity-gate flag-vocab compat** (t-7bd53cba).
  Three new flags + one default-behavior change so cockpit-level whip
  cron scripts (`/root/.atmux/bin/whip-velocity-gate.sh`) can file
  complaints AGAINST observed teams without their entire CLI call
  failing at the first unknown arg:
  - **`--title <s>`** — alias for `--summary` (canonical field stays `incidentSummary`)
  - **`--body <r>`** — alias for `--root-cause` (canonical field stays `rootCause`)
  - **`--severity <s>`** — free-form severity classifier; stored in `extra.severity` (no first-class column)
  - **`--target-team` defaults to current team's name** when omitted (was: defaults to `null`). Preserves the pre-v3 implicit "complaint in team X's DB is about team X" semantics — cross-team callers still pass `--target-team` to file against a different observed team.
  - **`COMPLAINT_SOURCE_KINDS` allowlist** extended with `"whip"` and `"whip-velocity-gate"` so velocity-gate's `--source-kind whip-velocity-gate` doesn't reject.
  Acceptance: end-to-end smoke test mirroring the velocity-gate's exact CLI invocation lands a row recoverable via `complaints list --source-kind whip-velocity-gate --target-team <team>`. No schema migration required — uses the existing v3 `target_team` column + the existing `extra` JSON bag.

- **ADR-140 — cheap-model-first principle (Cursor composer-2-fast martinet; medic event-driven)** ([docs/adr/140-cheap-model-first.md](docs/adr/140-cheap-model-first.md)).
  ADR text only (T1 of EPIC `t-83dcef6b`). Principle: Claude (Opus
  xhigh) stays for strategic + code-gen + review work; Cursor
  composer-2-fast (via martinet, Tier 2 cage per ADR-058) handles
  ALL mechanical execution loops + uncomfortable-but-routine
  actions. Codifies the operator's 4-message arc on 2026-05-14
  (MiniMax + Kimi explicitly rejected — capability bar too low;
  Cursor composer-2-fast is the production-grade tradeoff).
  Includes canonical roles+responsibilities matrix (superdriver,
  medic, martinet, team-lead, planner/reviewer/workers, gitter)
  and a back-of-envelope token-burn projection: ~440k Claude
  tokens/hour mechanical → ~60k Claude + ~137k Cursor tokens/hour
  post-migration (~65–70% Claude-burn replaced by Cursor cost).
  Rotation authority split: routine triggers (context >400k,
  refusal-pattern, dormancy-window) → martinet; emergency
  triggers (broken claude proc, planner misalignment) → medic
  + lead. T2 — ADR-077/131/139 cross-reference annotations —
  shipped via Task `t-d16c99ae` (commit `ad47419`); ADR-132 was
  pre-annotated 2026-05-14. T3 (medic verb scan-loop → event-
  listener, `t-e057d8ff`, lane=be) + T4 (martinet `NudgeAction`
  enum extension, `t-1cc90cc0`, lane=be) filed and claimable
  for be-lane workers, both deps-cleared on T2. Kanban Task
  `t-83dcef6b` (EPIC; T1 + T2 done; T3 + T4 open).
- **ADR-138 — verified send-keys (verify-and-retry pattern)** ([docs/adr/138-verified-send-keys.md](docs/adr/138-verified-send-keys.md)).
  ADR text only (T1 of EPIC `t-5df48a74`). Decision: new
  `safeSendKeysWithVerify` helper in `src/abstractions/tmux.ts` —
  send once, capture pane, assert state transition via caller-
  supplied `PaneVerifier`, retry once on timeout, escalate to
  `~/.atmux/state/send-keys-failures.log` + doctor probe + Discord
  template `[send-keys-failure]`. Ships 6 built-in verifiers
  (`composerEmpty`, `agentThinking`, `modalClosed`, `contextNonZero`,
  `paneMatchesRegex`, caller-closure). Migration plan touches 6
  caller files (send / dispatch / lane-tick / start / rotate +
  driver modal-release helpers); direct `tmux send-keys` remains
  only for window-rename / layout commands. Rejected blanket-3x-Enter
  alternative inline — state-destructive at every pane mode (would
  submit empty prompts on composer, wrong defaults on modals, etc.).
  Cross-refs ADR-081 §A (C-m submit cascade — layer below) and
  ADR-132 (martinet — long-term home, inherits the helper). Sub-tasks
  T2 (helper impl + tests) and T3 (caller migration + e2e) filed
  under the EPIC. Kanban Tasks `t-5df48a74` (EPIC), `t-f58c6ccc` (T1,
  this commit).
- **ADR-136 — hot-rename member labels (Option B — id + label + emoji split)** ([docs/adr/136-hot-rename-member-labels.md](docs/adr/136-hot-rename-member-labels.md)).
  ADR text only (TR1 of EPIC `t-13367b7a`). Decision: add an optional
  `label` field to `TeamMember`; `name` stays the immutable ASCII ID;
  `atmux member rename` mutates `label` only. Display surfaces render
  `label ?? name`; id-keyed state (worktrees, branches, inboxes,
  kanban owner, lane-tick args, paused.json, resume.json) stays
  pinned to `name`. Option A (emoji-as-stable-ID) was rejected on two
  hazards documented inline — variation-selector trap
  (`🛠️` 2-codepoint vs `🛠` 1-codepoint), and
  `sanitizeBranchSegment` already strips non-ASCII at
  `src/abstractions/worktree.ts:189-195`. All 4 OQs settled in-spec.
  Cross-refs ADR-027 (team-rename sibling), ADR-030 (registry —
  accepts label drift), ADR-082+ADR-084 (worktree substrate uses
  name not label), CONVENTION-059 (id-layer; ADR-136 composes the
  display layer on top). Sub-tasks TR2–TR5 filed under the EPIC for
  schema + verb + display-fallback + e2e implementation. Kanban
  Tasks `t-13367b7a` (EPIC), `t-646bc535` (TR1, this commit).
- **cockpit-pulse meta-watchdog — bypass-page George when superdoctor itself is dormant** ([ADR-086 §Phase 2](docs/adr/086-atmux-pulse.SUPERSEDED.md)).
  Extends the 5-min cockpit-pulse cron tick with an aggregate
  superdoctor-liveness probe. Walks every cockpit-enabled team's
  `state.db`, sums `complaints WHERE status='open'` and takes
  `MAX(superdoctor_attempts.attempted_at)` across teams. When at
  least one open complaint exists AND the latest attempt is ≥2h
  stale (or there's never been an attempt), pulse emits a new
  `[meta-watchdog]` Discord template — verdict-first 2-button menu
  (A: check superdoctor pane, B: kill+respawn) with a 30-min
  default deadline keyed off `whenMs`. Dedup is "1 page per
  dormancy streak": `pulse-state.json::metaWatchdog = { paged,
  dormantSinceSec }`; streak ends when a fresh attempt lands or all
  complaints clear. Closes the "if superdoctor itself goes silent,
  no one notices" gap left by ADR-077. (`src/core/superdoctor-activity.ts`,
  `src/abstractions/discord.ts::renderMetaWatchdog`,
  `src/core/pulse-state.ts::PulseMetaWatchdogSchema`,
  `src/verbs/pulse.ts`.) Kanban Task `t-351318dc`.
- **CONVENTION-059 — Generic indexed member naming** ([docs/CONVENTION-059-indexed-member-naming.md](docs/CONVENTION-059-indexed-member-naming.md)).
  Codifies the `<lane><index>` pattern (`fe0`, `fe1`, `be0`, `be1`,
  `ops0`, ...) for fungible team members — zero-indexed, no separator,
  one of the canonical lane prefixes (`fe` / `be` / `ops` / `test` /
  `review` / `db` / `misc`). Named roles (`lead`, `planner`,
  `reviewer`, `gitter`, `dba`, `devops`, `auditor`, `discorder`,
  `enforcer`, `unblocker`) keep their canonical names. Ships
  `checkIndexedMemberName` + `CONVENTION_059_LANE_PREFIXES` in
  `src/core/common.ts` — advisory-only validator, never throws.
  `templates/briefs/member.md` cross-references the convention for new
  brief consumers. Existing teams with non-indexed names (`whip-impl`
  on atmux, `eng-mobile` on unum, `fe-1` on sopx) keep their names
  until a deliberate migration cycle; the convention is forward-looking,
  not a forced rename. Kanban Task `t-05ad3bb4`.
- **CONVENTION-067 — `develop` branch for integration** ([docs/CONVENTION-067-develop-branch-integration.md](docs/CONVENTION-067-develop-branch-integration.md)).
  Workflow convention codifying the `feat/<topic>` and `<account>-<role>`
  worker branches → `develop` integration tip → `main` release-cut
  topology. First named convention doc in the project. Authored
  2026-05-14 after a docs worker hit a concrete cross-branch dep
  blocker — `t-289119f2` was marked `done` on the kanban (kernel commit
  `2a7db33`) but the kernel files lived on `geoyws-parity-cron-impl`,
  invisible to sibling worker branches. The convention defines the
  integration rhythm that prevents that drift: branch off `develop`,
  merge back to `develop` once green, pull from `develop` before
  claiming a dep-having task. Kanban Task `t-221eb576`.
- **Superdoctor self-escalation primitives** ([ADR-077 §F6](docs/adr/077-superdoctor-cockpit-role.md)).
  Without these, superdoctor silently loops while a team stays broken
  (rotate-lead swallowed under auto-mode; kill+respawn welcome-screen-gates;
  members idle 3h after rebuild). Ships three primitives the deferred
  `~/.claude/skills/superdoctor/` skill consumes: (a) SQLite migration
  v2→v3 materialising `superdoctor_attempts(complaint_id, attempt_n,
  outcome ∈ {resolved, partial, failed}, attempted_at, action, note,
  extra)` per-team — one row per structural-fix attempt with a CHECK
  constraint on `outcome`; (b) typed CRUD via `SuperdoctorAttemptsRepo`
  (`src/core/repositories/superdoctor-attempts-repo.ts`) — load-bearing
  query is `countByOutcomeFor(complaintId, 'failed')`, reaching 3 is the
  page-George trigger; (c) Discord template `[self-heal-failed]` +
  renderer `renderSelfHealFailed` (`src/abstractions/discord.ts`) —
  verdict-first ABC menu (`A` /team stop+start, `B` swap account,
  `C` park for the night) with a 30-min default deadline keyed off
  `whenMs`. Operator replies one letter from a phone. Dedup state lives
  in `state_kv` (feature `superdoctor-self-heal-escalation`, key per
  `complaint_id`, 1h re-fire window). Documented end-to-end in
  [`docs/superdoctor.md` § "Self-escalation when fixes keep failing"](docs/superdoctor.md).
- **`atmux stop --soft` + resume manifest** ([ADR-087](docs/adr/087-stop-soft-resume-manifest.md)).
  Graceful counterpart to bare `stop`. Reads kanban for in-progress Tasks,
  sends a `# soft-stop incoming — finish current operation, no new claims`
  send-keys comment to each non-shell member pane (enter-false so it lands
  in the compose box without auto-submitting), sleeps
  `team.softStopGraceSeconds` (default `5`), then atomic-writes
  `<atmuxDir>/state/resume.json` (mktemp + rename). The next `atmux start`
  surfaces a resume hint. First ADR in the team-of-teams ADR-087…092
  sequence; smallest scope, independent of the rest. (`src/core/soft-stop.ts`,
  `src/verbs/stop.ts`.)
- **`scanNeedsApproval` lib — approval-debt scanner** ([ADR-085](docs/adr/085-whip-approvals-watcher.md)
  §Scan API). New `src/lib/needs-approval.ts` exports
  `scanNeedsApproval(deps?) → NeedsApprovalReport` covering three buckets:
  (A) ADRs under `docs/adr/*.md` / `docs/adr/*.md` with `Status:
  proposed|draft|wip|pending` and no `(deferred: ...)` escape hatch;
  (B) `driver-inbox.md` headings missing `✅`/`📤`/`⏳`/`❌` triage marker
  (`🚨`/`🪫` don't count) and stale (`ageMin > 30`); (C) kanban tasks with
  `status='blocked'` stale beyond `ageMin > 120`. Each bucket is failure-
  isolated (one exception doesn't poison the report); all three reads are
  LIVE per ADR-068 §HC#4. Unblocks the whip §2.5 wire (t-21c3aa64) and
  status-verb row (t-9281649f).
- **`atmux groom` absorbs lane-drift-check** ([ADR-062](docs/adr/062-lane-claim-auto-pickup.md)
  §5). Daily 04:00 sweep gains a 6th sub-op — lane-drift detection across
  every team in the cockpit. Paired with the every-2-min cron lane-tick
  line (below) for fast-feedback drift detection inside the day; groom is
  the catch-the-stragglers pass for drift the cron missed (host suspended
  overnight, cron disabled by `ATMUX_NO_CRON`, pane classifier wedged for
  a window). The standalone `atmux lane-drift-check` verb stays — useful
  for operator ad-hoc diagnosis.
- **Cron emits `lane-tick` line + `crons.laneTickEnabled` kill-switch**
  ([ADR-062](docs/adr/062-lane-claim-auto-pickup.md) §Decision 4).
  `src/core/cron.ts::renderCronLines()` now emits a 7th line at end-of-
  block: `*/2 * * * * <baseEnv> lane-tick >> <atmuxDir>/logs/lane-tick.log
  2>&1`. Hardcoded `*/2` cadence per §OQ2 (tighter amplifies classifier
  bugs; looser dulls auto-claim chain). Gating requires BOTH ≥1
  `team.members[].lane` field set AND `team.crons.laneTickEnabled !==
  false` — teams without lanes see no line; per-team kill-switch lives in
  `team.json`.
- **Complaints schema v3 — provenance columns** (per [ADR-077](docs/adr/077-superdoctor-cockpit-role.md)
  §F2 follow-up). Per-team `complaints` table gains `source_kind`
  (enum: `superdoctor` / `lead` / `member` / `driver` / `cron`),
  `source_id` (free-text ID matching the kind — member name, cron line,
  etc.), and `target_team` (when superdoctor files a complaint in team
  A's `state.db` ABOUT team B). Closes the 2026-05-09 driver-chat ask:
  "complaints box must also capture from whom it came". Cross-team
  analysis (`show me all complaints superdoctor filed last week`) now
  runs via indexed query instead of grep. SQLite migration in
  `src/migrations/`.
- **`atmux epic` + `atmux story` sub-verbs — bun port**
  ([ADR-007](docs/adr/007-pull-model-kanban.md) hierarchy verbs).
  Ports `lib/epic.sh` (318 LOC) + `lib/story.sh` (388 LOC) to TS. New
  `src/core/epic.ts` (state-machine + auto-dispatch summary on review
  entry) + `src/core/story.ts` (4 gates: non-test child tasks done →
  `testing`; test-lane done → `review`; reviewer signoff → `merging`;
  merge task done → `done`). Auto-flips parent Epic `ready → in-progress`
  on first Story claim. Pre-req for proper kanban filing under
  Epic/Story doctypes.

### ✨ Added — atmux superdoctor wave (0.6.0, [ADR-077](docs/adr/077-superdoctor-cockpit-role.md))

- **`superdoctor` cockpit role at window 2**. Self-healing diagnosis-and-
  prevention loop; sits between superdriver (window 1) and per-team
  viewers. Owns the structural-fix loop atmux teams lacked when an
  anomaly fired (`atmux doctor` says *what* is wrong; `atmux whip` says
  *that* something stalled; superdoctor asks *why* and proposes the
  structural fix). Cockpit topology cutover (§D1+D2); inbox key
  `__superdoctor__` for send-key routing (§F3); cockpit-state surface
  on `atmux status` + P0 runbook (§F4+§F5); per-team complaint box +
  `atmux complaints` verb (§F2); cockpit reload hot-edit (`atmux cockpit
  reload`); rebuild prints superdoctor `/loop` nudge when enabled.
- **`atmux complaints` verb** (§F2). Per-team SQLite-backed log of root
  causes + preventive asks, distinct from driver-inbox (per-team asks at
  the lead) and pending-decisions.md (asks at the operator). Verb shape
  mirrors `atmux flag` — `complaints add|list|show|resolve`. Schema
  carries provenance columns post-v3 (see post-0.6.0 follow-ups above).

### ✨ Added — Discord noise drainage wave 2 (0.6.0, [ADR-079](docs/adr/079-discord-noise-drainage.md))

- **§A — cron schedules read from `team.whip.intervalMins`** instead of
  hardcoded `*/5` / `*/30` / `0 */4` / etc. (`src/core/cron.ts`). Schema
  field `intervalMins` was previously written but unread.
- **§B — `atmux audit` verb bun-ported** + ADR-044 driver-name rule
  alignment (bare `driver` not `__atmux__driver`).
- **§C — bare `[whip]` template-namespace lint** as structural CI gate.
  `DiscordTemplate` union (`src/abstractions/discord.ts`) has no `whip`
  literal; the compile-time invariant prevents bun-emit of bare `[whip]`.
- **§D — per-finding hash dedup + transitions-only emit** (highest
  leverage). Whip's per-member previous-state hash gates re-posting; only
  state transitions emit to Discord. Subsumes the auto-handoff-failed
  loop noise. ~70% reduction observed pre-demo-week.

### ✨ Added — Operator-observed improvements bundle (0.6.0, [ADR-080](docs/adr/080-operator-observed-improvements.md))

- **§A1 — ctx-pct rotation policy** in whip. `team.whip.ctxPctMax`
  (default `30`) — leads above this threshold auto-rotate regardless of
  uptime. Resolves the "lead at 67% ctx not rotating" sopx incident.
- **§A2 — lane-tick ctx-threshold lead refusal**. Lane-tick refuses to
  inject `claim --next` into a lead pane already above
  `team.whip.ctxPctMax` — avoids defeating the rotation that whip
  triggered.
- **§B1 — `findCommitForTask` helper** in `src/core/auto-done.ts`. Scans
  git history for `t-<id>` references; backbone for §B2.
- **§B2 — lane-tick auto-done back-fill** for stale `commit t-X` Tasks
  whose commit landed but `atmux done` never fired (sopx had 29 of
  these on 2026-05-09).
- **§C — pane-state `BUSY` for spinner verbs**. `pane-state.ts` gains a
  BUSY classification covering `Honking`/`Cooked for Ns`/`✻`/etc.
  spinners; lane-tick refuses claim injection on BUSY (was wrongly
  classified UNKNOWN → `skip-capture-error`).
- **§D — `task list --status` underscore normalize + did-you-mean error**.
  `--status in_progress` now works (was silent `(no tasks)`); unknown
  values produce `--status: 'xyz' not in {todo,in-progress,...}; did
  you mean 'in-progress'?` instead of empty result.
- **§E — `task list --json` escape audit** + regression fixture for
  bodies containing backticks/newlines/quotes.

### ✨ Added — Per-member worktree isolation (0.6.0+, [ADR-082](docs/adr/082-worktree-isolation-per-member.md) + [ADR-084](docs/adr/084-worktree-per-member-branch-model.md))

- **`team.json.worktreeIsolation` + `worktreeRoot`** Zod fields (W2).
  Each team member gets a private `<atmuxDir>/worktrees/<member>/`
  working tree on a per-member branch (`<base>-<member>` —
  `geoyws-up-impl`, etc.) so `lint-staged` stash-collisions can no
  longer sweep another member's untracked edits into the commit index.
  Demo-week-blocking concurrency-safety fix at 20+ member scale.
- **`atmux start` per-member worktree provisioning** (W3) — provision
  loop runs alongside the existing member spawn, with cwd override
  passed into `tuiClaude()`.
- **`atmux stop --force` worktree teardown** (W4) — `pruneWorktrees`
  with dirty-skip; orphan branches surfaced via doctor.
- **`atmux doctor` worktree-isolation probe** (W5) — four anomaly
  classes (missing worktree, stale/locked, branch drift, dirty state).
- **Per-member branch model** (ADR-084 amends ADR-082 OQ6) — fixes the
  "every member tries to checkout 'geoyws' which git refuses" failure
  surfaced during W6a dogfood-flip. `provisionWorktree` now creates
  `-b <base>-<member>` per call; cockpit's `--force-cycle` safety gate
  prevents accidental cross-member branch overwrite.

### ✨ Added — Driver-only Task refuse-gate ([ADR-033](docs/adr/033-driveronly-task-refuse-gate.md))

- **`Task.driverOnly: boolean`** schema field. `claim --next` skips
  driver-only Tasks during auto-pickup; explicit `atmux claim <id>` from
  a non-driver context refuses with a clear error; `atmux task move` /
  `atmux done` enforce the gate on state transitions. `--driver-only`
  flag on `atmux task add` stamps the field. Prevents auto-lane workers
  from claiming Tasks the planner reserved for driver-side ops.

### ✨ Added — Other 0.6.0 surfaces

- **`atmux send` `__superdoctor__` inbox key** (ADR-077 §F3) — send-keys
  routing for superdoctor pane lookup.
- **`atmux cockpit reload`** sub-verb — hot-reload alias for
  `cockpit.json` edits without process restart.
- **`atmux health` verb** — composed read-only diagnostic snapshot
  ([SPEC-066](docs/SPEC-066-health-verb.md)) bundling doctor + status +
  whip-last-tick + scanNeedsApproval into a single JSON output.
- **`atmux team repair-rename`** verb — V1 explicit-team port
  (ADR-027 ADDENDUM 11) for the per-team rename flow.
- **`atmux cron-install` + `atmux cron-remove`** explicit verbs ([ADR-083](docs/adr/083-cron-install-port-scope.SUPERSEDED.md)).
  Port `installCronBlock` + DI seam from bash to TS; `atmux start`/`stop`
  call into them so cron block management is unified.
- **`atmux task update` sub-verb** ([ADR-084](docs/adr/084-worktree-per-member-branch-model.md) W3)
  — body + deps editor for in-flight tasks.
- **`atmux task` race-condition gate** — refuses member claim of an
  in-progress task owned by a different member (closes a kanban-state
  race surfaced during ADR-084 dogfood).
- **Bootstrap brief-paste port to `atmux start`** ([ADR-081](docs/adr/081-bootstrap-brief-paste-bug.md) §C).
  Lifts `_atmux_paste_brief` from the archived bash path into the TS
  spawn loop — fresh cages no longer silently starve on every `atmux
  start`. Uses the §A `C-m`-after-paste-buffer discipline.
- **Bun-runtime cage-safety preload** — refuses `bun test` inside an
  atmux cage (`bun test` crashes Claude's TUI cage in atmux repo per
  prior memory finding).
- **Events log** ([t-91cd050f](#)) — unified per-verb JSONL observability
  surface under `<atmuxDir>/logs/events.jsonl` (single line per state-
  mutating verb invocation; replaces ad-hoc per-verb logs).
- **`fix(cron)` config-driven schedules** — see ADR-079 §A above.
- **`fix(budget-probe)` opt-in OAuth refresh** ([ADR-078](docs/adr/078-budget-probe-oauth-refresh.md))
  — cockpit-rebuild TUI race resolved.

### ♻️ Changed — post-0.6.0

- **`atmux rotate-lead` team-lead role aliasing** — `team-lead` →
  `lead.md` resolves before existence check via
  `BRIEF_ALIASES: Readonly<Record<string,string>>` (ADR-081 §B; commit
  `7aa7cf2`). The deprecated `templates/briefs/team-lead.md` is now a
  symlink to `lead.md`.
- **`tmux send-keys` paste-submit** uses `C-m` not literal `Enter`
  ([ADR-081](docs/adr/081-bootstrap-brief-paste-bug.md) §A) — bracketed-
  paste envelope eats the trailing Enter as multi-line continuation;
  `C-m` is the literal carriage return that survives the envelope.
  Applied across every paste-buffer call site.
- **`atmux status` honors `team.tmuxTmpdir`** on read-side socket
  lookup; `atmux start`/`whip` honor it on write-side socket resolution.

### ✨ Added — Pull-model kanban (Epic 1)

- **Epic / Story / Task data model on `kanban.json`.** New top-level arrays
  `epics[]` + `stories[]`. Tasks gain optional `.epic` / `.story` / `.lane` /
  `.deliverable` fields. Backwards-compat preserved: legacy kanbans with only
  `tasks[]` still load; `atmux::kanban_normalize` (in `lib/common.sh`) auto-adds
  the new arrays on first mutation. Tasks without the new fields keep working
  (treat missing as `null` on read).
- **`atmux epic add | list | show | advance`** (S2). State machine:
  `planning → ready → in-progress → review → done`. `epic show` renders a tree
  view (Epic → Stories → child Tasks with statuses).
- **`atmux story add | list | show | advance`** (S3). State machine:
  `planning → ready → in-progress → testing → review → merging → done`. `--ac`
  flag captures explicit acceptance criteria — empty `acceptanceCriteria` is an
  automatic REJECT at reviewer signoff (per ADR-007 OQ2).
- **`atmux task add` new flags** (S4): `--epic <eid>`, `--story <sid>`,
  `--lane fe|be|db|ops|test|review|misc`, `--deliverable <text>`. Stories are
  optional; small Epics skip them.
- **`atmux claim --next [--lane <l>] [--as <m>]`** (S4). Pull-mode work
  selection: filters Tasks with non-`done` deps, prefers caller's lane, falls
  back across lanes when `team.kanban.crossLaneClaim` is `true` (default).
  Atomic claim with race-aware retry (3 attempts).
- **Auto-dispatch of commit-Tasks to gitter on `task move done`** (S4). When a
  Task with `.epic` set flips to `done`, a `commit <id>` Task lands in gitter's
  inbox automatically. Storyless-Epics auto-flip `in-progress → review` and
  fire a `draft Epic summary` Task to the lead. Story-level test-lane completion
  flips the Story `testing → review`.
- **`.lane` on the team-member schema** (S5). `templates/team.example.json`
  stamps lane explicitly; the wizard infers lane from member-name prefix
  (`fe-foo` → `fe`, `be-bar` → `be`, etc.) with role overrides for staff
  (`reviewer` → `review`, `devops` → `ops`, `dba` → `db`,
  `team-lead`/`planner`/`gitter` → `misc`). `atmux status` adds a `LANE` column
  (UPPER-CASE in display, lowercase in JSON). Backwards-compat: missing `.lane`
  is inferred at read time.
- **`atmux decisions add | list | show`** (S10, [ADR-008](docs/adr/008-decisions-verb.md)).
  Append-only auto-mode-resolution log at `.atmux/decisions.md`. Each `add`
  pings Discord (silent if no webhook). `--reversibility low|medium|high`
  classifies the call. Question / default / note are truncated to fit the
  ≤80-char Discord per-bullet budget; oversize inputs error rather than
  silent-truncate. Whip integration surfaces a pointer for new decisions
  since the last tick (S10).
- **`team.kanban.crossLaneClaim`** config (default `true`). When `false`, an
  empty caller-lane queue produces a hard error instead of falling back to
  any-lane work.

### ✨ Added — Whip enrichment + richer decisions (Epic 2)

<!-- Bullets land per-Story; this section is populated by sibling
     Tasks t-fc256867 (S7) / t-1b4d63ea (S8) / t-c6ae5307 (S9) and the
     S10 entry below. Order tracks the ADR-009 §S1→§S5 / §S7→§S10 +
     ADR-008 §S9→§S10 narrative. -->

- **Auto-rotation infrastructure** (E2/S5,
  [ADR-009](docs/adr/009-auto-rotation.md)). New `team.whip.autoRotate`
  config flag (boolean, default `false`, opt-in for safety — `/clear`
  is destructive so existing teams must NOT get auto-rotated on
  upgrade). When `true`, whip auto-execs `atmux rotate-lead` at the
  uptime threshold AND auto-execs `atmux rotate <member>` on banner
  detection (`Compacting conversation` / `approaching usage limit` /
  `hit your limit`). Per-member rotation anchor at
  `.atmux/state/<member>-rotated.epoch` (written by `lib/rotate.sh`
  on every successful rotation; whip's uptime calc switches from
  session-anchored to rotation-anchored, falls back to session-start
  when the anchor file is absent so existing teams see zero
  behavioural change until their first rotation lands). Banner
  handoff gated by the same flag and debounced 5 min via the same
  `<member>-rotated.epoch` so a persistent banner doesn't re-rotate
  every cron tick. Discord finding `♻️ AUTO-ROTATED <member> at <ts>`
  fires on every auto-rotation so the driver knows their pane just
  got `/clear`'d. Brief updates: `templates/briefs/lead.md`
  §Auto-rotation rewrite + `templates/briefs/member.md` §Auto-handoff
  callout. (`lib/rotate.sh`, `lib/whip.sh`, `templates/team.example.json`,
  `templates/briefs/lead.md`, `templates/briefs/member.md`.)

- **whip output noise reduction** (E2/S7,
  [ADR-009 §S7](docs/adr/009-auto-rotation.md)). Dedup pings via
  body-hash anchor (`.atmux/state/whip-last.hash`) so a single stuck
  Task doesn't re-fire 12 identical pings/hour. New per-tick
  "Since last tick" delta block with positive signal — commits +
  done-Tasks + advanced-Stories that landed in the window. Raised
  `staleMin` default `30 → 90` (demo-walk Tasks legitimately exceed
  30 min); per-Task override via `atmux task add --stale-min N`.
  Queued-msg flag suppressed when the pane is BUSY (mid-thinking /
  active token-counter / `Esc to interrupt` banner) — those messages
  WILL be submitted when the current turn ends, not stale.
  (`lib/whip.sh`, `lib/kanban.sh`, `templates/team.example.json`.)

- **decisions verb — Discord gating + inline preview + digest** (E2/S8,
  [ADR-008 §S8](docs/adr/008-decisions-verb.md)). Discord ping at
  add-time is now gated on `--reversibility high` only; `low` /
  `medium` decisions skip the per-add ping and surface via whip's
  inline preview block (`📋 N new decisions: …` with top-3 question +
  default per entry) plus a new `atmux decisions digest` verb that
  consolidates all skipped low/med entries since the last digest
  cursor into ONE Discord post (with `[N/M]` split if it exceeds
  2000 chars; silent on empty windows). Driver brief and planner
  brief explain the new ladder + when each tier pings.
  (`lib/decisions.sh`, `lib/whip.sh`, `templates/briefs/lead.md`,
  `templates/briefs/planner.md`, `README.md` cron snippet.)

- **decisions verb — richer template (4 new optional fields)** (E2/S9,
  [ADR-008 §S9](docs/adr/008-decisions-verb.md)). New optional flags:
  `--context` (the WHY behind the decision), `--option` (repeatable
  up to 5 times — alternatives considered), `--impact` (what
  breaks / who notices / what migrates if the default is wrong),
  `--decided-by` (who landed the call: lead / planner / specific
  teammate). Per-field byte caps were temporarily relaxed to
  200/500 chars in the S9 ship and then dropped entirely in S10
  (see chunker entry below). Discord template extended to render
  the new sections in `question · default · decided-by · context ·
  options · impact · note · reversibility` order, skipping any
  empty section. Backwards-compat preserved: a no-new-flags entry
  is bit-identical in `.atmux/decisions.md` to the pre-S9 4-field
  shape; legacy entries also parse cleanly via the extended awk in
  `_decisions_to_json_array`. Brief copy in lead.md + planner.md
  documents per-field guidance + worked examples.
  (`lib/decisions.sh`, `templates/briefs/lead.md`,
  `templates/briefs/planner.md`.)

- **decisions verb — drop per-field caps + section-aware multi-message
  Discord chunker** (E2/S10, [ADR-008 §S10](docs/adr/008-decisions-verb.md)).
  S9's per-field byte caps (200 chars on question/default, 500 on
  note/context/impact, 80 on decided-by, 200/each on options) are gone —
  the data layer accepts arbitrarily long input. The Discord renderer
  now composes the full body, ships a single message when ≤1900 chars,
  and otherwise splits **section-by-section** into up to 5 messages
  with a `[N/M]` header per chunk and a 1s sleep between pings to stay
  under Discord's rate-limit margin. Required fields (question, default,
  decided-by, reversibility, show/override pointers) always live in
  chunk 1; optional sections (context, options, impact, note) flow into
  chunks 2–5 in keep-order. Beyond 5 chunks, fields drop in S9-truncate
  order (note → impact → options → context) and the last chunk gets
  `↳ atmux decisions show <id> for full`. Whip's "Since last tick"
  delta block also gains per-bullet rendering for done-tasks
  (`🏁 \`<id>\` [E#/S#] <subject> — <owner>`), commits
  (`✅ \`<sha>\` <subject> — <author>`), and advanced-stories
  (`📈 \`<sid>\` [<epic>] <title> → <status>`); each truncates to
  ≤80 chars/bullet with cap-5-plus-`+N more`. New `story.advancedAt`
  epoch schema field stamped on every transition; old stories pre-
  dating the field are naturally excluded by the strict-greater-than
  filter. Per-field cap regressions in `tests/unit/decisions.bats`
  retargeted; new `tests/unit/whip_delta.bats` enriched-bullet
  coverage (18/18 incl. real-git regression for the format→tformat
  fix from f-3229e152).

### ✨ Added — SQLite state cutover (ADR-076)

ADR-076 collapses the legacy JSON-canonical inbox (`.atmux/inboxes/<member>.json`)
into the SQLite `state.db` already introduced by ADR-060. Five phases shipped
2026-05-08:

- **Phase 1 — `atmux migrate-state --target=inboxes`** (commit `27d80ee`). One-
  shot backfill: reads every `.atmux/inboxes/*.json` into the `inbox_messages`
  SQLite table, idempotent on re-run, dry-run support. Safety net for operators
  upgrading existing teams (run before flipping to SQL-canonical reads).
- **Phase 2 — SQL-canonical `loadInbox`** (commit `c3c6cc0`). Inbox readers
  switch to `state.db` when present, falling back to the JSON file when not.
  Per-team SQL detection via the presence of `state.db` + the `inbox_messages`
  table; old teams continue working on JSON without migration.
- **Phase 3 — inbox writer no-op on SQL-canonical teams** (commit `95b45c9`).
  Inbox writes route to SQLite on SQL-canonical teams; the JSON-file writer
  is a no-op rather than a dual-write (avoiding drift between the two stores).
  Legacy `inboxes/*.json` files survive untouched as historical artifacts.
- **Phase 4 — `atmux status` column update** (commit `8005c69`). The per-
  member "📨 N pending" inbox column is replaced by "🟡 N active 📌 N todo"
  reading from the kanban directly — pending-inbox semantics were a JSON-era
  artifact (the inbox JSON tracked `{pending, inProgress, done}` slots per
  member); on SQL-canonical teams the kanban `tasks` table is the source of
  truth for what a member is working on.
- **Phase 5 — 0.5.0 release tag** (commit `5c16432`). All four phases bundled
  in a single minor release because the migration story is atomic per-team.
  Operators upgrading from 0.4.x: run `atmux migrate-state --target=inboxes`
  once per team root before the next `atmux start`.

Cross-refs in code: `src/core/inbox.ts`, `src/verbs/migrate-state.ts`,
`src/verbs/status.ts`, `src/verbs/whip.ts`. SQLite schema migration ladder
at `src/abstractions/sqlite-migrations.ts`.

### ✨ Added — atmux flag verb (Epic 4)

- **`atmux flag` — member→lead structured issue surfacing** (E4,
  [ADR-010](docs/adr/010-atmux-flag.md)). Symmetric counterpart to
  `atmux decisions add` but in the reverse direction: members fire
  `atmux flag "<msg>" --severity p0|p1|p2 --needs unblock|decision|review|context|rotate [--task <id>]`
  to surface a structured issue to the lead. Append-only state at
  `.atmux/flags.md` (one `### f-xxxxxxxx` heading per entry, fields
  as bullets, parsed by awk — same shape as `decisions.md`). Verbs:
  `flag add` / `flag list [--status open|resolved]` / `flag show <fid>` /
  `flag resolve <fid> [--note <text>]`. Replaces the silent-suffer
  pattern: workers stuck >10 min now fire a flag instead of grinding.
- **`[atmux-flags]` Discord template at `--severity p0` ONLY**.
  Mirrors ADR-008 §S8's reversibility-gates-Discord pattern: p0 pings
  the team channel immediately (driver gets phone visibility on
  demo-blocking issues); p1/p2 write to `flags.md` + send a tmux
  keystroke to the lead pane (kanban-visible, channel-quiet). Whip's
  `_atmux_whip_check_flags` surfaces `📍 N open p0 flags` inline in
  the next `[whip-progress]` ping so even resolved-late p0s stay
  visible.
- **`--task <id> --needs unblock` is a single-call atomic mutation**.
  When both flags are present, `atmux flag add` (a) writes the flag
  entry to `flags.md`, (b) appends the flag id to `task.note` for
  audit, AND (c) flips the linked Task to `blocked` state — kanban
  state matches reality without forcing the worker to remember a
  second command. Other `--needs` values with `--task` append to
  `.note` only (no status change — could be "I need a clarification
  but can keep working on adjacent stuff").
- **Mid-rotation flag-send: lost-keystroke acceptable; flag persists
  durably**. When a member fires `atmux flag` while the lead pane is
  mid-`/clear` (E2 auto-rotate), the `tmux send-keys` "now signal"
  may land in the void or as the first text in the freshly-bootstrapped
  pane. The flag entry STILL writes to `flags.md` durably; whip
  surfaces it on the next 5-min tick regardless. Banner-detect on
  the lead pane (`Compacting conversation` / `hit your limit`) skips
  the keystroke send pre-emptively.
- **Brief updates**: `templates/briefs/lead.md` whip loop reads
  `flags.md` FIRST (before driver-inbox.md) with triage markers
  (✅ resolved / 📤 routed / ⏳ in-progress / ❌ deferred) plus a
  callout that open p0 flags appear in `[whip-progress]` Discord
  pings. `templates/briefs/member.md` gains §"When to flag" — 4
  triggers (stuck >10 min / ambiguous tool output / decision needed /
  mid-rotation blocker) with 3 worked examples.
  (`lib/flags.sh`, `lib/whip.sh`, `lib/kanban.sh`, `bin/atmux`,
  `templates/briefs/lead.md`, `templates/briefs/member.md`.)

### ✨ Added — Hot reload (Epic 3)

Erlang/OTP-style hot code swap for atmux teams. Edit a brief, change
team.json, or fix a `lib/*.sh` syntax error WITHOUT `/clear`-ing anyone
or restarting the session. See [ADR-011](docs/adr/011-hot-reload.md).

E3 ships verbs 1, 2, 4, 5 of the original 6-verb spec; verbs 3 (TUI
swap) and 6 (Erlang per-claim brief snapshot) are carved into a
recommended **E5** spinoff (multi-day foundational work that deserves
its own ADR — pane lifecycle + per-claim state).

- **`atmux brief-reload <member>`** — re-paste the latest
  `templates/briefs/<role>.md` into the member's pane as a *prepended
  notice* (no `/clear`, no context loss). Use mid-Epic when a brief
  was edited and the member's understanding lags the file. Banner-skip
  safety: if the pane shows `Compacting conversation` /
  `Press up to edit queued messages` / `approaching usage limit` /
  `hit your limit` / `thinking with`, the reload logs and exits 1
  (pasting into those states scrambles queued buffers or interleaves
  with model output). `--force` bypasses for stale-banner edge cases.
- **`atmux config-reload [--member <m>]`** — re-read `team.json`,
  compute per-member delta against `.atmux/state/spawn-snapshot.json`
  (written at `atmux start`), and ping each affected member with
  `⚙️ CONFIG RELOAD: your <field> changed: <old>→<new>. Apply on
  next dispatch.` Members with no delta stay silent. NO tmux
  respawn, NO model swap exec, NO `/clear` — verbal protocol, soft
  cut. Members finish current Task on the OLD config (reasoning
  continuity), apply on next dispatch. Schema-enforced per-claim
  versioning is deferred to E5.
- **`atmux verify-libs`** — sources every `lib/*.sh` in a subshell,
  reports defined `atmux::*` functions per-file, fails fast on bash
  parse errors. Catches "broken lib/whip.sh doesn't propagate to
  running members until they re-shell" before it bites a live team.
  Wired into `atmux doctor` as a `libs:` check (~10 LOC).
- **Versioned briefs** — every `templates/briefs/*.md` carries a
  `<!-- brief-version: vN -->` HTML comment as the first line
  (invisible when the brief renders in-pane — markdown comments
  don't render). State at `.atmux/state/brief-versions.json`
  records each member's pasted version: `{<member>: {role, version,
  pastedAt}}`. Whip's `_atmux_whip_check_brief_versions` diffs
  file-version vs pasted-version every tick; on mismatch emits
  `📋 brief-version mismatch <member>: pane=vN, file=vM`. Lead (or
  driver) responds by dispatching `atmux brief-reload <member>`.
  `v0` is the legacy fallback for marker-less briefs — old teams
  never trip the finding until they upgrade.
- **Brief updates**: `templates/briefs/lead.md` gains §"Hot reload"
  (brief-reload semantics + banner-skip + config-reload delta-only +
  brief-version flow). `templates/briefs/member.md` gains §"When
  whip pings brief version available" (run brief-reload between
  Tasks, NOT mid-Task; config-reload applies at next dispatch).
  (`lib/reload.sh`, `lib/verify_libs.sh`, `lib/common.sh`,
  `lib/start.sh`, `lib/rotate.sh`, `lib/whip.sh`, `lib/doctor.sh`,
  `bin/atmux`, `templates/briefs/lead.md`,
  `templates/briefs/member.md`, all 8 `templates/briefs/*.md`.)

### ♻️ Changed — Briefs rewritten for pull model

- **`templates/briefs/lead.md`** — explicit "DO NOT decompose / DO NOT dispatch
  per-Task"; loop now (1) read `driver-inbox.md`, (2) route Epic asks to the
  planner via `atmux send planner`, (3) compose Epic summary on `draft Epic
  summary` request from `atmux epic show` + `git log`. New "Recording decisions"
  section on `atmux decisions add` usage with reversibility tier explainer.
- **`templates/briefs/planner.md`** — explicit "You decompose. You DON'T
  dispatch. The lead routes; workers pull." Loop covers `atmux epic add` →
  optional `atmux story add` → `atmux task add --epic --lane --deps` → `atmux
  reply`. Lane vocabulary table (FE / BE / DB / OPS / TEST / REVIEW / MISC).
  ADR template included. New "Recording resolved open questions" section.
- **`templates/briefs/member.md`** — pull loop: `atmux claim --next` → execute
  → `atmux done <id> --note "<commit subject>"`. Cross-lane handoff via deps;
  surface-with-evidence pattern for cross-lane bugs. FE workers also own the
  TEST-lane capstone for UI Stories. **DO NOT commit / DO NOT push** preserved
  and reframed as "gitter commits on the back".
- **`templates/briefs/reviewer.md`** — Story-level signoff on cumulative diff
  (not per-commit). Empty `acceptanceCriteria` = automatic REJECT. Approve via
  `atmux story advance --to merging`; reject via push-back + `--to in-progress`.
  System-wide audit bar preserved (exhaustive grep + negative-space proof +
  adjacent-class widening).
- **`templates/briefs/gitter.md`** — three Task shapes auto-arrive:
  `commit t-xxx` (one commit per Task), `merge s-xxx` (Story finalization on
  `merging`), `persist deferred items` (one-shot, only allowed write outside
  `/root/work/src/atmux/`). HEREDOC commit example with `Co-Authored-By:`
  trailers. Hooks always run — never `--no-verify`, never `--amend` after a
  hook failure.

### 📚 Docs

- **`README.md`** — new "Agile vocabulary" section (Epic, Story OPTIONAL,
  Task definitions); revised "How it works" diagram showing pull-model flow
  (driver → lead → planner → kanban → workers pull → gitter commits → lead
  Epic summary). Commands section updated with `atmux epic` / `atmux story` /
  `atmux task add --epic --story --lane --deliverable` / `atmux claim --next` /
  `atmux decisions add | list | show`.
- **`docs/ARCHITECTURE.md`** — Roles table redefined for the pull model
  (lead routes, planner decomposes, reviewer signs off Stories, gitter auto-
  dispatched, member pulls). New "Pull coordination" section covers the
  kanban data model + 3 state machines + `claim --next` selection +
  auto-dispatch flow with ASCII diagram. New "Lead → Planner routing" section
  replaces the old push-model "Lead → Member routing".
- **`docs/GETTING_STARTED.md`** — new "Driving an Epic" 6-step walkthrough
  with realistic `/healthz` example, live `atmux epic show` tree-view
  example mid-flight, example `git log` post-Epic showing one commit per
  Task. Existing first-time-setup + cron + doctor sections preserved.
- **Tab-completions** (`completions/_atmux` zsh, `completions/atmux.bash`
  bash) — `epic`/`story`/`decisions` top-level verbs with sub-verbs;
  `--lane` / `--reversibility` / `--to` / `--status` enum completions
  (state-machine aware: epic-states for `epic advance --to`, story-states
  for `story advance --to`); `task add` new-flag matrix; `claim --next` +
  `--lane` + `--as`.
- **[ADR-081](docs/adr/081-bootstrap-brief-paste-bug.md) §F — first-turn
  precedence over residue-discard memory rules**. New section + brief-
  template anchors in `templates/briefs/lead.md` + `templates/briefs/member.md`
  ensure fresh leads / members accept their FIRST `atmux claim --next
  --as <role>` keystroke as legitimate kick-off, overriding any operator-
  memory rule that says to discard such injections as auto-loop residue.
  Status flipped `proposed → accepted` on the same commit.
- **ADR status hygiene pass** — 4 ADRs flipped `proposed → accepted`
  with per-§ commit-chain inline (ADR-077 superdoctor, ADR-079 discord-
  noise drainage, ADR-080 operator-observed improvements, ADR-084
  worktree per-member branch model); ADR-082 (worktree isolation)
  annotated `proposed (deferred: W6c verify + W9 adversarial regression
  test remain blocked)`. Pre-cleanup before whip §2.5 needs-approval
  scanner lands, so the noise floor stays clean. AC: `rg '^Status:
  proposed$' docs/adr/*.md` returns zero matches.
- **Docs Discipline section in 5 brief templates** —
  `templates/briefs/{lead,member,reviewer,planner,unblocker}.md` now
  carry a Docs Discipline section near the top (after role intro,
  before role-specific mechanics) embedding the ADRs → docs → brief
  templates → source lookup order, peruse-before-working rule, and
  same-commit doc-update rule. `/CLAUDE.md` cited as canonical contract.
- **No-gitter, worker-self-commits pattern in `lead.md` + `member.md`**.
  New §"Commit ownership" section in both briefs describing the two
  topologies (gitter-bearing teams: stage + mark done, gitter commits on
  the back; gitter-less teams: commit + push BEFORE `atmux done`). Five
  contradictory existing lines reworded so the brief is internally
  consistent. Defensively phrased — `team.json:.members[]` `role:
  "gitter"` probe disambiguates at the call site so future gitter-bearing
  teams aren't broken.
- **[ADR-094](docs/adr/094-c-alias-spawn-convention.md) — c-alias
  spawn convention as first-class**. Author the ADR proposing that
  `atmux::tui_claude` bake the global `CLAUDE.md` §Spawn Pattern
  defaults inline so per-team `tuiCommands.claude` overrides aren't
  required for the canonical autonomous-team-member spawn shape
  (CLAUDE_GUARD_AGENT=1 + --plugin-dir + --permission-mode auto). Asks
  A+B+C cohesive design; D (init wizard prompt) cross-linked as
  orthogonal. Three env knobs (`ATMUX_CLAUDE_GUARD_AGENT`,
  `ATMUX_CLAUDE_PLUGIN_DIR`, `ATMUX_CLAUDE_PERMISSION`) gate the bake
  with rollback-friendly defaults; no schema change. Status: proposed.

### 🚨 Breaking changes

- **Brief templates rewritten**. Existing teams should re-init briefs from
  `templates/briefs/*.md` (or run `atmux reconfigure`). Old push-model
  briefs are stale; the lead/member/reviewer/gitter behaviour described
  in them no longer matches the runtime.
- **Lead no longer dispatches per-Task by default**. Workers pull. Manual
  `atmux dispatch <member> <task-id>` is reserved for explicit driver-
  requested priority overrides; default flow is `atmux claim --next`.
- **Per-member inbox JSON files are no longer the source of truth**
  (ADR-076). Reads + writes route to SQLite `state.db` on teams that have
  it; the legacy `.atmux/inboxes/<member>.json` files remain on disk for
  legacy teams + as historical artifacts but new operations do not touch
  them. Operators upgrading from 0.4.x: run `atmux migrate-state
  --target=inboxes` once per team root to backfill the SQLite store from
  the legacy JSON before the next `atmux start`. Same applies to the
  kanban (`atmux migrate-state --target=tasks` per ADR-060).
- **`atmux status` per-member column format changed**. The "📨 N pending"
  inbox column is now "🟡 N active 📌 N todo" reading from the kanban
  rather than the inbox file. Downstream scrapers / dashboards parsing the
  old format need to update their regex.

### ✨ Added — pre-Epic-1 (already in Unreleased before this Epic)

- **`planner` + `dba` as canonical staff roles.** Planner owns task
  decomposition + ADR authorship, so the lead's context budget goes to
  coordination only (per the CLAUDE.md doctrine "team-lead never plans").
  DBA owns schema + migrations + data integrity. Both are toggleable in
  the wizard (`planner` on by default, `dba` off by default). New brief
  templates in `templates/briefs/planner.md` and `templates/briefs/dba.md`.
- **Wizard preset modes.** New top-of-wizard prompt: `perf` (all claude),
  `default` (claude staff + cursor/opencode/kimi workers cycled),
  `eco` (all opencode / MiniMax), `custom` (prompt each worker individually).
  Preset drives staff + worker TUI defaults; other prompts still run so the
  user confirms team shape.
- **Feature-lane worker naming convention.** README + wizard suggest
  `fe-auth`, `be-auth`, `db-auth`, etc. over `cursor-1` / `kimi-2` —
  surfaces ownership and makes kanban/status readable at a glance.
- **Ephemeral specialists pattern.** Documented in README +
  GETTING_STARTED: `atmux add-member planner-auth --role planner`
  spawns a feature-scoped specialist when canonical staff is saturated.
  No new code; formalises an existing capability.
- **`docs/adr/` with 6 initial ADRs** covering planner role, preset modes,
  emoji architecture, ephemeral specialists, doctor preflight, and bare
  `atmux`. Planner uses this directory for new ADRs going forward.

### ♻️ Changed

- **Role rename: `git-committer` → `gitter`.** Role value, brief file,
  emoji pool, status fallback, docs + README + template all updated.
  Shorter + matches the wizard prompt. Existing team.json files with
  `role: "git-committer"` keep working via status.sh fallback but should
  be migrated.

- **Per-member emojis — auto-assigned, displayed everywhere.** Each member in
  `team.json` now carries an optional `.emoji` field, stamped at wizard /
  add-member time. Three assignment modes (`team.emojis.mode`, override via
  `ATMUX_EMOJI_MODE`):
  - `static` — canonical per-role emoji, deterministic (lead=🧭, reviewer=🔍,
    gitter=🌿, devops=⚙️, member=🐝).
  - `random` (default) — random pick from a curated pool per role; avoids
    duplicates within a team for variety.
  - `ai` — `claude -p` picks per-member based on name+role. Falls back to
    `random` if claude is missing or the call fails.
  Display surfaces: tmux window names (`__<team>__<emoji><member>` when
  stamped), `atmux status`, and any future surfaces via `atmux::member_emoji`
  / `atmux::member_display` helpers.
- **Bare `atmux` → one-stop bring-up.** Running `atmux` with no arguments is
  now aliased to `atmux up`: offers the wizard if there's no team.json (with
  the CWD shown prominently so you don't accidentally scaffold in the wrong
  dir), runs doctor preflight, starts the session if it isn't already up, and
  attaches you to it. Idempotent — re-running after the session is up just
  reattaches. Help is still available via `atmux help` / `atmux --help`.
- **`atmux doctor`** — `brew doctor`-style environment check. Validates required
  deps (tmux, jq, git), optional deps (curl, bats, shellcheck), `team.json`
  schema, every member's TUI binary on PATH, `.atmux/` writability, and
  Discord webhook reachability. Flags: `--quiet` (exit-code-only, used by
  start preflight), `--fix` (interactive remediation), `--json` (machine
  readable).
- **`atmux start` preflight.** `start` now runs `doctor --quiet` before
  spawning panes. On red, aborts with a pointer to `atmux doctor`. Use
  `--doctor` for a verbose preflight (or `ATMUX_DOCTOR_ON_START=1` for cron),
  or `--no-doctor` to skip entirely.

## [0.3.0] — 2026-04-24

### ✨ Added

- **`ATMUX_MEMBER` auto-export per pane.** Every TUI launch command now prepends
  `export ATMUX_MEMBER=<name>`, so `atmux claim <id>` and `atmux done <id>` run
  inside a member's pane infer `--as` without any flags.
- **`atmux reply` / `atmux outbox`** — the missing reverse channel. Any member
  writes `atmux reply "..."` to append to `.atmux/lead-outbox.md`; the driver
  reads via `atmux outbox` (with `--ack` to archive, `--json` for pipeability).
  Replaces "attach to lead pane to see what it decided" with an async mailbox.
- **`atmux cost` + budget enforcement.** Parses `~/.claude/projects/*.jsonl`
  `usage` blocks against a pricing table (`lib/pricing.json`; override with
  `ATMUX_PRICING_FILE`). `team.budget.{total,perMember,overrunPolicy}` in
  `team.json` — `overrunPolicy` ∈ `warn | pause | failover`.
- **Budget-exhausted failover.** When `overrunPolicy: "failover"`, `atmux whip`
  auto-invokes `atmux handoff <exhausted> <peer-with-budget>` and pauses the
  exhausted member. Peer selection prefers same `role`.
- **`atmux handoff <from> <to>`.** Two-phase: first asks the source TUI to write
  a handoff summary, waits up to `ATMUX_HANDOFF_WAIT` seconds; if the file
  never materializes, falls back to `tmux capture-pane` screen-scrape. Either
  way the target gets the notes + the in-flight tasks migrated.
- **`atmux pause <member>` / `atmux resume <member>`.** Paused members refuse
  `dispatch` and `claim`. Used by budget enforcement + manual ops.
- **`atmux add-member <name> ...`** — append a member without re-running the
  wizard; spawns immediately if the session is up.
- **`atmux reconfigure`** — re-run the TUI-commands part of the wizard against
  an existing team.json without nuking members.
- **Task `priority` + `deps` enforcement.** `task add --priority N`; `task list`
  sorts ascending by priority. `claim` and `dispatch` refuse tasks whose `deps`
  aren't all `done`.
- **`--json` output** for `atmux status` and `atmux task list` (driver-side
  Claude can now parse team state without grep/awk fragility).
- **`atmux dashboard [--interval <s>]`** — live full-screen status panel.
- **Shell completion**: `completions/atmux.bash` + `completions/_atmux` (zsh).
  Tab-completes verbs + member names read from `.atmux/team.json`.
- **GitHub Actions CI** — `.github/workflows/test.yml` runs shellcheck + bats.
- **`flock` on every JSON mutation.** All `atmux::jq_update` calls now hold a
  per-file lock, preventing read-modify-write races between concurrent
  dispatches / claims.

### 🛡️ Fixed

- shellcheck-clean (with `-e SC1091,SC2154,SC2155,SC2016,SC2034`). Fixes:
  bogus multi-redirect in `cost.sh`, unused vars, `cd` without `|| exit` in
  tests, `A && B || C` misuse in `start.sh`.

### 🧪 Tests

- **139/139 green** (129 unit + 10 e2e) — up from 96 in v0.2.0.
- New suites: `outbox.bats` (6), `env_member.bats` (7), `json_output.bats` (5),
  `add_member.bats` (4), `deps.bats` (5), `cost.bats` (4), `pause.bats` (4),
  `handoff.bats` (5).



### ✨ Added

- **First-run auto-wizard.** Invoking `atmux <verb>` in a directory with no
  `.atmux/team.json` now offers the setup wizard when stdin is a tty. Non-
  interactive paths (cron, piped stdin) keep the normal "no team.json" error so
  `atmux whip` / `atmux report` in cron don't hang. Opt out with
  `ATMUX_NO_WIZARD=1`. Exempt verbs: `init`, `help`, `version`.
- **Per-team TUI launch aliases** via the new `tuiCommands` field in `team.json`.
  Example: `"tuiCommands": {"claude": "claude --plugin-dir=$HOME/work/journals/.sb/claude-skills"}`.
  atmux appends `--model <model>` unless the prefix already contains `--model`.
- **Per-member full-command override** via a new `command` field on a member.
  Takes priority over everything. Use it when one member needs a totally bespoke
  invocation (e.g. a different wrapper script or completely different flags).
- **Custom TUI type names.** Members can now declare `"tui": "claude-fresh"` or
  `"tui": "claude-heavy"` as long as the name has a matching entry in
  `tuiCommands`. Lets you run multiple Claude configs side-by-side.
- **Wizard asks for TUI launch commands.** After the basic team questions, the
  wizard prompts: *"claude launch command [claude]:"* etc. It tries to detect
  existing shell aliases (e.g. `claude='command claude --plugin-dir=…'`) and
  proposes them as defaults. Only non-default entries are written to
  `tuiCommands`, keeping team.json tidy.
- **`examples/opencode-lead-team.json`** — OpenCode driving as `team-lead`
  (cheap coordination turns), Claude for reviewer/gitter, Cursor + Kimi workers.
- **`examples/custom-claude-team.json`** — multiple Claude configs in one team,
  showing `tuiCommands` + per-member `command` override side-by-side.
- **CHANGELOG.md** (this file).

### 🔧 Changed

- `templates/team.example.json` now includes an empty `tuiCommands` block with an
  inline comment showing the common plugin-dir alias pattern.
- `lib/tui.sh` accepts the full member JSON blob so it can read per-member
  `command` overrides.

### 🧪 Tests

- Full suite now 96/96 green (86 unit + 10 e2e).
- New `tests/unit/tui_resolution.bats` (9 tests) covers every branch of the
  3-tier resolution: `member.command` → `team.tuiCommands[tui]` → built-in
  default, plus the "unknown custom tui" error path and a shell-safety test for
  `cwd` with spaces.
- `tests/unit/first_run.bats` (7 tests) covers the first-run wizard offer: tty
  vs non-tty, opt-out env var, exempt verbs, yes/no branches (yes-branch uses
  `script(1)` to fake a tty).

## [0.1.0] — 2026-04-24

### ✨ Initial release

- 🎮 Driver → 🦅 Team Lead → 🐜 Members orchestration via `tmux send-keys`.
- Supports TUIs: `claude`, `opencode` (MiniMax M2.7 highspeed default), `kimi`
  (kimi-latest default), `cursor-agent` (Composer 2 default), `shell`.
- Per-role defaults: team-lead / reviewer / git-committer / devops on Claude;
  workers on any TUI.
- Core verbs: `init`, `start`, `stop`, `attach`, `send`, `broadcast`, `tell-lead`,
  `task` (add / list / show / move / assign / rm), `dispatch`, `inbox`, `claim`,
  `done`, `status`, `report`, `whip`, `rotate`, `rotate-lead`.
- Automation: `atmux whip` (5-min watchdog) + `atmux report` (30-min digest),
  both idempotent for cron. Discord escalation via `ATMUX_DISCORD_WEBHOOK` with
  `DISCORD_WHIP_WEBHOOK` as a fallback.
- State: project-local `.atmux/` with `team.json`, `kanban.json`, per-member
  `inboxes/`, `driver-inbox.md`, `logs/`, `state/`, `archive/`. All
  greppable / diffable JSON + markdown.
- Test suite: 80 bats-core tests (70 unit + 10 e2e), all green. E2E uses
  `tui=shell` so CI needs no AI API keys.

[Unreleased]: https://github.com/geoyws/atmux/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/geoyws/atmux/compare/v0.3.0...v0.5.0
[0.3.0]: https://github.com/geoyws/atmux/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/geoyws/atmux/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/geoyws/atmux/releases/tag/v0.1.0
