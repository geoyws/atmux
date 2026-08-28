# ADR-283: Scrub the test runner's environment — a property of the environment, not a pattern over code

**Status**: proposed
**Date**: 2026-08-28
**Amends**: [ADR-282](282-never-collect-the-whole-environment-in-a-test.md) — keeps its helper and its guard, **retracts** its two coverage claims (see §Retraction). ADR-282's §Out of scope entry "Environment hygiene in the test runner" is **taken into scope here**.
**Amends**: [ADR-281](281-tmux-child-environment-scrub-at-the-spawn-seam.md) — makes its `templates/tmux/atmux.conf` claim true (§C1) and pins the invariants it stated only in prose (§B1, §B2).
**Relates**: [ADR-277](277-cage-color-environment-scrub.md), [ADR-102](102-test-strategy.md), [ADR-191](191-vendored-tmux-binary.md) (`resolveTmuxBin`, §C4), [ADR-171](171-tmux-conf-local-override.md) (the override that must still win, §C1)

## Context

Three adversarial reviews of `bb47d0b6` returned DEFECTIVE with nine MAJOR findings. The governing one is a single sentence, and it is the reason this ADR exists rather than a patch:

> The previous round shipped documentation claiming a guarantee the code did not deliver — the exact sin it convicted ADR-277 of.

### The secrets defence had the wrong shape

ADR-282 responded to a credential disclosure by (a) filtering probes at the source and (b) adding a source scan that fails the suite on "an unfiltered environment capture". Then it wrote, in §D4 and §Consequences, that this meant "the class cannot come back" and that "taking any other route fails the suite".

A reviewer drove sixteen whole-environment-capture shapes through that scan's own matcher and reported it caught four. That report's arithmetic does not close (it says "caught 4 and missed 15" of sixteen), so rather than restate a number that cannot be reproduced, the comparison was **re-derived here** against an enumeration written down in full:

| | shapes enumerated | caught by the `bb47d0b6` matcher | caught by the matcher in this change |
|---|---|---|---|
| measured 2026-08-28 | **21** | **9** | **21** |

The twelve the old matcher missed: a bare relative redirect target (`env > out`) and its statement-terminated append; `Bun.spawnSync({ cmd: ["env"] })` in double, single and backtick quoting; a dumper as the last element of any argv array (`["sh","-c","env"]`); `env -0`, `env --null`, `printenv -0` and the argv form `["env","-0"]`; and command substitution in both `` `$(env)` `` and `x=$(env)` shapes.

The most damaging was the first argv one:

```ts
Bun.spawnSync({ cmd: ["env"], stdout: "pipe" })
```

— the idiomatic TypeScript route, which **the very file the guard protects already used four times** for other commands.

**"Catches 21 of 21" is not the claim it looks like.** The matcher was widened *against this enumeration*, so of course it now covers it; that says nothing about a shape nobody wrote down. Pattern-matching arbitrary code for "captures the environment" is a losing game — source can be assembled at runtime, split across lines, or spelled in a way no one anticipated. A guard over code shapes is worth having; it is not worth *claiming*.

### Where the secrets come from, and the fix that follows from it

The operator's `.zshrc` sources a git-crypt'd `.env` into **every** shell, including the one that runs `bun test`. Measured 2026-08-28 on `geoywsMBP`: that shell carries ~125 variables and **29 of the names match a credential pattern**. The 2026-08-28 disclosure put roughly 180 of them, with values, into a test log and an agent transcript.

So the fix is not a better regex. **If the variables are not in the runner's environment, no test can leak them, whatever shape it uses — today or in a shape nobody has invented yet.** That is a property of the environment, not of a matcher, so there is nothing to evade.

### Why this cannot be done in a preload

The obvious cheap version — a bunfig preload that `delete`s the offending names from `process.env` — **does not work**, and the reason is specific enough to record.

Measured on bun 1.3.14, 2026-08-28: `Bun.spawn` / `Bun.spawnSync` called **without an explicit `env`** do not read the live `process.env`. They use the environment as it stood when the process started.

| what the child sees | variable set after startup | variable deleted after startup |
|---|---|---|
| default `env` (omitted) | **not visible** | **still visible** |
| explicit `env: { ...process.env }` | visible | not visible |

A preload that deleted secrets would therefore leave `Bun.spawnSync({ cmd: ["env"] })` — precisely the shape that walks through ADR-282's matcher — still dumping every one of them. Only an environment that never contained them holds. Pinned by a test (`tests/unit/helpers/test-env.test.ts`, "premise: Bun's default child environment is a start-time snapshot") so that if bun changes, the reasoning here is revisited rather than the assertion quietly loosened.

## Decision

### D1 — `scripts/test.ts` is the repository's test entrypoint, and it builds the runner's environment from an allowlist

`bun run test`, `bun run test:coverage` and the CI test step all go through it; arguments pass straight to `bun test`.

**Allowlist, not denylist, and the choice matters.** A denylist over names is a guess about what a secret is called, and a reviewer was right that `DATABASE_URL` carries a password and matches nothing in the obvious pattern. An allowlist inverts the failure mode: a name nobody thought about is **withheld** rather than admitted. The cost is that a new `process.env` read has to be classified, which is enforced rather than hoped for — see §D3.

Two passes, in this order:

1. **The allowlist decides.** `TEST_ENV_ALLOW_EXACT` (30 names: process/filesystem basics, locale, the terminal-capability quartet, tmux addressing, XDG paths, `CI`) plus `TEST_ENV_ALLOW_PREFIXES` (4 entries: `ATMUX_`, `BUN_`, `KANBAN_`, `LC_`).
2. **The credential filter cleans up after the prefixes.** `ATMUX_` is allowed wholesale and three real credentials live inside it — `ATMUX_VOX_TOKEN`, `ATMUX_VOICE_TOKEN`, `ATMUX_DISCORD_WEBHOOK`. This pass exists for exactly that, and is **not** the wall.

Measured on `geoywsMBP`, 2026-08-28: **21 variables reach the runner, 103 are withheld.**

**Escape hatch**: `ATMUX_TEST_ENV_PASSTHROUGH=NAME1,NAME2` admits named variables, and every admitted name is echoed to stderr. An unlogged widening is a hole; a logged one is a decision.

**The receipt prints counts, never names.** A list of withheld names is a smaller version of the disclosure this exists to prevent — it tells a reader which services this box holds credentials for. The escape hatch is the single exception, because a silent one would be worse.

### D2 — A preload tripwire, so the wall cannot be walked around by habit

`tests/helpers/test-env-guard.ts` (bunfig `[test] preload`, beside the existing `sandbox-guard.ts`) **refuses** to run when the runner's own environment carries credential-shaped names, unless `ATMUX_TEST_ENV_OK=1`. It refuses rather than scrubs, for the reason in §Context.

The two layers **check each other**: `scripts/test.ts` sets the `ATMUX_TEST_ENV_OK` marker only when the environment it built has **zero** credential-shaped names left. A `scrubTestEnv` that regressed into a pass-through would not get its own marker, and the preload would refuse — instead of a silent hole. It also means a passthrough that deliberately admits a credential has to be accepted twice, once per layer, by hand.

Same shape and same precedent as `ATMUX_CAGE_TEST_OK`: a hard refusal with one documented override.

### D3 — The allowlist is checked against what the repository actually reads

`tests/unit/helpers/test-env.test.ts` scans `src/`, `tests/`, `scripts/` and `bin/` for every `process.env.<NAME>` reference (comment lines excluded) and requires each to be either admitted by the allowlist, credential-shaped, or listed in a `DELIBERATELY_WITHHELD` table **with a stated reason**. A companion leg asserts the scan is not vacuous — it must find `HOME`, `PATH`, `TMPDIR`, `NO_COLOR`, `ATMUX_DIR`, `TMUX` and more than 30 names in total.

Without that second leg the first is the same vacuity ADR-282's guard had: a scanner that finds nothing passes everything.

### D4 — The ADR-282 guard is kept, widened, and its claim cut to what it does

It stays because catching the mistake at the place it is written, with a message naming the safe route, is worth having. What changes is what is said about it.

**Widened matcher.** Added: a redirect to a bare relative filename (ADR-282 §D4's stated gap — closed by requiring the end of a shell statement, and by refusing a `dumper` that is itself preceded by `>`, which is what the repository's `flag > env > default` prose looks like); `env -0` / `--null` in both shell and argv form; a dumper as the **last element** of an argv array (`["env"]`, `["sh","-c","env"]`) while a prefix (`["env","-u","NO_COLOR","tmux"]`) and a single-variable read (`["printenv","TERM"]`) stay legal; and command substitution `$(env)`.

**Widened roots.** `src/`, `tests/`, plus `scripts/`, `bin/`, `templates/`, `plugins/` — all carry executable shell, and `scripts/` and `bin/` are outside biome's `files.includes`, so nothing else in the repository reads them at all. Extensionless files with a shebang are scanned (`bin/atmux`, `bin/atmux-tmux`).

**Non-vacuous now.** `scan()` returns `[]` both when nothing violates and when nothing was scanned; a reviewer set `SCAN_EXTS` to the empty set with a real violation planted on disk and the suite stayed green. Two legs fix that: a per-root file-count floor, and a leg that plants a real violation in a `mktemp` tree and requires `scan()` to find it — pinning `walk()` and `scan()`, not only `isOffending()`. Verified: emptying `SCAN_EXTS` now turns both red while the headline assertion stays green, which is the point.

**The claim, stated as it actually is:** the guard is a **tripwire for enumerated shapes, not a proof of absence.** §Residual gaps below lists what it does not see.

### D5 — `dumpEnvCommand` is capped, and its input validation is fixed

- **Cap.** `ENV_DUMP_MAX_VARS = 8`, and any credential-shaped name is refused outright. Without a cap the sanctioned helper would build the whole-environment dump it exists to prevent, at a call site the guard reads as an ordinary helper call.
- **`outPath`.** It refused quotes only, while being spliced into `… > <path> || true` inside a single-quoted `sh -c '…'` — `;`, `&`, backtick, `$(`, `>`, `*`, whitespace and a newline were each as live as a quote. Now an allowlist: `/^[A-Za-z0-9_@:+=./-]+$/`. Every real call site builds its path with `join(mkdtemp(…), …)` and satisfies it.
- **`parseEnvDump`.** The line-oriented filter had a hole: a secret whose value contains a newline followed by `TERM=` produces a line that looks exactly like a legitimate assignment, and that line is a **fragment of the secret**. Fixed by keeping only the FIRST sighting of each name (a real environment cannot hold a name twice, so a repeat proves the split found something that was never a variable boundary) and redacting any value over 256 characters.
- **One credential pattern, not two.** `SENSITIVE_NAME_RE` is now `CREDENTIAL_NAME_RE` from `tests/helpers/test-env.ts`. Two copies of a security predicate are two answers to one question, and the copy in `env-dump.ts` was the unanchored one described next.

### D6 — The credential pattern is anchored where anchoring matters, and substring where it does not

The pattern was `/(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PAT|WEBHOOK|CREDENTIAL|AUTH)/i`, matching bare substrings. It therefore matched **`PATH`** (via `PAT`), **`MONKEY`** and **`COMPATIBILITY`** (via `KEY`). Redacting `PATH` in a projection is how a filter earns being switched off.

One rule cannot serve both halves, so there are two:

```
/(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|WEBHOOK|CREDENTIALS?|APIKEY|SIGNATURE)|(?:^|_)(?:KEYS?|AUTH(?:ORIZATION)?|PAT)(?:_|$)/i
```

- **Long words, substring.** Nothing benign is called `…PASSWORD…`, and substring matching is what catches `PGPASSWD`, where the token sits on no `_` boundary at all.
- **Short words, `_`-segment anchored.** `KEY`, `PAT` and `AUTH` are the collision-prone ones. `AUTH(?:ORIZATION)?` rather than substring `AUTH`, so `AUTHORIZATION` matches and `GIT_AUTHOR_NAME` does not.

Verified in both directions by test: `AZURE_DEVOPS_PAT`, `AWS_SECRET_ACCESS_KEY`, `PGPASSWD`, `AUTHORIZATION` and `lowercase_token` match; `PATH`, `MONKEY`, `COMPATIBILITY`, `KEYCHAIN` and `GIT_AUTHOR_NAME` do not.

## Retraction

Three sentences shipped in `bb47d0b6` claimed a guarantee the code did not deliver. They are **retracted**, and the files carry the correction in place:

1. **ADR-282 §D4** — *"A guard test, so the class cannot come back."* It cannot. Re-measured 2026-08-28: that matcher caught **9 of 21** enumerated capture shapes.
2. **ADR-282 §Consequences** — *"Every future environment probe has one obvious route, and taking any other route fails the suite."* False for the twelve routes measured above, including the idiomatic TypeScript one — and unprovable in general, which is the deeper problem.
3. **CHANGELOG** — the heading *"a test can no longer capture the whole environment."* It could, and can — what has changed is that there is nothing worth capturing in the runner.

The replacement claim, stated so a reviewer can try to falsify it: **through the repository's test entrypoint, the runner process's environment contains only allowlisted names, so the operator's credentials are not present for any test to capture by any means.** §Residual gaps says what that does not cover.

A fourth false claim was ADR-281's, and it came from the instructions the previous round was given rather than from that agent's own work — recorded here as an **instruction defect**, not as its mistake. See §C1.

## Findings applied, one by one

### C1 — ADR-281's `templates/tmux/atmux.conf` claim was false; it is now true

ADR-281 stated it twice (§D2, §Consequences) and `docs/ARCHITECTURE.md` a third time — that `templates/tmux/atmux.conf` "keeps its `COLORTERM truecolor` line" — and leaned on it as the compensating control for withdrawing the spawn-level injection. **It did not.** At `bb47d0b6` the only `set-environment` in that file was `NO_COLOR` (line 55) and the only `COLORTERM` occurrence was inside a comment (line 47). The line existed only in the operator's personal `~/.tmux.conf:39`, which this repository does not ship.

Fixed by making the claim true: `set-environment -g COLORTERM truecolor` now sits immediately after the ADR-277 `NO_COLOR` scrub and **above** the ADR-171 `source-file -q ~/.config/atmux/tmux.conf.local`, so ADR-277 §D2 still holds — the scrub is a default, not a lock, and the operator's own conf still loads last and still wins.

**Measured before shipping it, on `geoywsMBP`, tmux 3.7c, 2026-08-28** (harness in §C5):

| leg | result |
|---|---|
| server has `COLORTERM=truecolor`, client's own environment has none → `#{client_termfeatures}` | `bpaste,ccolour,clipboard,cstyle,focus,title` — **no RGB** |
| pane on that server | `TERM=tmux-256color`, `COLORTERM=truecolor` |
| pane on a server with **no** conf and **no** `COLORTERM` in its environ | `TERM=tmux-256color`, `COLORTERM=truecolor` |

So: the server-level option is the safe half — it does **not** make tmux advertise 24-bit colour on the operator's behalf, which is the harm ADR-281 §D2 withdrew the client-side injection for. And on tmux 3.7c it is **inert for the pane**, because tmux sets `COLORTERM=truecolor` in every pane itself. Its stated value is the tmux **3.6b** servers ADR-281 measured with `COLORTERM=` empty — **that 3.6b measurement is ADR-281's, not reproduced here**, and is recorded as such rather than restated as fact.

Guarded by two legs in `tests/regression/atmux-conf-no-color-scrub.test.ts` (the line exists; it sits after the scrub and before the override), both mutation-proven.

### B1 — Seven spawn sites, seven tests

ADR-281 §D2's stated reason for a shared constant is "the failure this prevents is a **future call site forgetting**", and nothing detected that. A reviewer deleted `unsetEnv` from six of the seven sites and the full 10,404-test suite came back **byte-identical**; `rg TMUX_CHILD_UNSET_ENV tests/` returned zero hits.

`tests/unit/abstractions/tmux-child-env.test.ts` drives every site with `process.env.NO_COLOR = "1"` and asserts the environment that actually reached `Bun.spawn` (via a recorder at that single seam: all seven routes through `src/abstractions/spawn.ts`, which R4 — [ADR-006](099-error-handling.md), implemented per [ADR-100](100-spawn-pattern.md) — makes the only module permitted to call `Bun.spawn`, so one seam covers all of them). ⚠ Noticed while verifying that: **`src/adapters/kanban-cli.ts:243` calls `Bun.spawn` directly**, which is an R4 violation. It is not a tmux path, nothing here depends on it, and it is left alone rather than folded into a security change — but it is a real finding and is recorded rather than passed over. It asserts the **effective environment**, not the `unsetEnv` option: an option still passed but no longer honoured by `mergeEnv` would satisfy an options check and fail this one. A control leg drives the same seam with no policy and requires `NO_COLOR` to arrive, so the seven cannot be green because nothing ever passes it.

`sendCageBrief` is exported for this (`src/verbs/poke.ts`, marked "exported for testing"): reaching it in production goes through `runBudgetTickCheck` → `runBudgetCheck` and needs a whole fallback-enabled team fixture to assert one spawn option.

### B2 — The ARGV/`unsetEnv` correspondence is enforced, not asserted in prose

ADR-281 §D2 says `TMUX_CHILD_ENV_ARGV` is "kept byte-for-byte equivalent to `TMUX_CHILD_UNSET_ENV`, so the sudo path can never drift". Nothing enforced it, and the sudo branch is the one running under another UID where `env_reset` discards a spawn-level override. Now: `TMUX_CHILD_ENV_ARGV` must equal `TMUX_CHILD_UNSET_ENV.flatMap(n => ["-u", n])`, and both must be frozen.

### C3 — The biome include no longer regresses the CI gate

`bunx biome check .` — what CI runs — went **156 → 162 errors** when ADR-282 added `tests/regression/**` and `tests/helpers/**` to `files.includes`. The previous round's `LINT_EXIT=0` came from `bun run lint`, which is `biome lint .` only and skips the format and assist passes. The six were 4 `format` + 2 `assist/source/organizeImports` in four pre-existing `tests/helpers/` files that the include newly brought into scope; they are fixed, and the count is back to **156**. The includes are kept — the whole point of ADR-282 §D5 was that those directories were an unlit corner.

**Stated plainly rather than left implied: `bunx biome check .` still exits 1 at 156 errors, and did before any of this work.** All 156 are `format` (103) and `assist/source/organizeImports` (53). Cross-referencing the diagnostic file list against `git diff --name-only` shows **zero** of them in a file this change or `bb47d0b6` touched — the only two touched files that still appear carry `noNonNullAssertion` WARNINGS, which biome exits 0 on and which ADR-282 §D5 deliberately left standing. Fixing the 156 is a repository-wide formatting sweep and is deliberately **not** bundled into a security change.

### C4 — Four smaller defects

- **`SENSITIVE_NAME_RE`** — §D6.
- **The newline-fragment leak** in `parseEnvDump` — §D5.
- **`describe.if(HAS_TMUX)`** — the reviewer's diagnosis is half right and the correction is worth recording. bun 1.3.14 **does** count a `describe.if(false)` block's tests in the skip total — measured 2026-08-28 against a purpose-built probe file, where a `describe.if(false)` holding three tests reported all three as `(skip)` and the run's tally read `0 pass / 9 skip / 0 fail` across the three gating forms — so they were never invisible. What was missing is a **gate**: nothing anywhere made an absent tmux a failure. Added a `@skip-reason` comment and an unconditional leg asserting `not (on CI and no tmux)` — locally an absent tmux is legitimate, on CI the workflow installs tmux on purpose and a skip there silently removes every behavioural assertion in the file.
- **`HAS_TMUX` probed the bare PATH** (`command -v tmux`) while the code under test resolves through `resolveTmuxBin()` (ADR-191's three-tier chain). On a box with `ATMUX_TMUX_BIN` set, or a vendored binary and no system tmux, the gate and the subject disagreed — and worse, the raw-tmux **control** legs ran a different binary from the one `createTmux` drives, which makes the comparison between them meaningless. Both now use `resolveTmuxBin()`.

### C5 — The client-path measurement, reproduced, with the harness

One reviewer could not reproduce ADR-281 §D2's `#{client_termfeatures}` table; two could. Re-measured first-hand on `geoywsMBP`, tmux 3.7c (`/Users/geoyws/.local/share/mise/installs/tmux/latest/tmux`), 2026-08-28, against a server started with `-f /dev/null` whose `show-environment -g COLORTERM` reports `unknown variable: COLORTERM`:

| client environment | `#{client_termfeatures}` |
|---|---|
| `TERM=xterm-256color`, no `COLORTERM` | `bpaste,ccolour,clipboard,cstyle,focus,title` |
| `TERM=xterm-256color`, `COLORTERM=truecolor` | `bpaste,ccolour,clipboard,cstyle,focus,`**`RGB`**`,title` |

**ADR-281's table is confirmed.** Three details decide whether it reproduces, and are the likely reason one reviewer did not see it:

1. **The client needs a controlling terminal.** `tmux attach` without a pty never becomes a client at all. Run it under `script -q /dev/null` (macOS) in the background and read the feature string from OUTSIDE via `tmux -S <sock> list-clients -F '#{client_termfeatures}'`.
2. **`TERM` must be held constant across both legs.** It is the dominant input to the feature list; varying it swamps the `COLORTERM` difference.
3. **The server must have no `COLORTERM` of its own**, or the reading can come from the server side and both legs look the same.

The script is `.scratch/measure-termfeatures.sh` in the working tree of this change (not committed — it touches no repository surface); the three points above are the whole of it.

**Version scope, stated because it bounds every number here.** Every measurement in this ADR and in ADR-281 is tmux **3.7c on macOS**. The vendored pin (ADR-191) is **3.6a** and CI installs **3.4**. Nothing here has been measured on either.

## Consequences

- **A bare `bun test` on a box with credentials in its shell now refuses**, naming `bun run test` and the `ATMUX_TEST_ENV_OK=1` override. This is a real change to muscle memory, and it is the price of the claim in §Retraction being safe to make: without it the wall is one word away from being walked around. **The refusal is conditional, not absolute** — it fires only when the environment actually carries credential-shaped names, so on a clean machine (a fresh contributor's checkout, a bare container) `bun test` still works exactly as before.
- **CI goes through the same door.** The workflow's test step is `bun scripts/test.ts --coverage --coverage-reporter=lcov`. A bare `bun test` there would very likely also be refused — `actions/cache` and `actions/upload-artifact`, both used by this workflow, put `ACTIONS_RUNTIME_TOKEN` in the job environment — though that has not been observed on a runner from here, only reasoned from those actions' documented requirements.
- **The full suite is unchanged by the scrub.** Run at `bb47d0b6`, and again through the entrypoint with the scrub as the ONLY change: **10327 pass / 8 skip / 2 todo / 67 fail / 5 errors** both times, 10404 tests across 350 files, and the 67-name failure SET identical in both directions. (Those 67 are pre-existing on this box and untouched here.)
- **With every change in place the failure SET is back to the baseline exactly.** Final run through the entrypoint: **10367 pass / 8 skip / 2 todo / 67 fail / 5 errors**, 10444 tests across 352 files (the extra 40 tests and 2 files are this change's own), and the 67-name failure set is identical to `bb47d0b6`'s in both directions — zero new, zero gone.
- **One pre-existing race was surfaced by the rest of the change and fixed.** `tests/unit/verbs/start.test.ts` read `#{pane_current_command}` immediately after `runStart` in two legs, with no settle — a race by construction, reproduced at **1 failure in 4 isolated runs** of that file under load. It is now polled to a 2s deadline. Mutation-proven not to be a loosening: making a null-`tui` driver launch `sh` turns both legs red, reverting turns them green. Fixed rather than reported because a suite one failure worse than its baseline is not a result anyone can act on.
- **One benign behavioural difference, recorded so nobody re-derives it.** The scrub withholds `CLAUDECODE`, and bun's test reporter suppresses `(pass)` lines when it is set. A wrapped run therefore prints ~12,700 lines where a bare one printed ~1,500. The totals are identical; only the reporter's verbosity differs. `CLAUDECODE` is deliberately not allowlisted — nothing in the repository reads it, and harness-dependent test behaviour is worth removing.
- **A new `process.env.<NAME>` read is a visible decision.** §D3's scan fails until the name is admitted or withheld-with-a-reason.
- **`sendCageBrief` is exported.** Production callers still route through `deps.sendCageBrief`.

## Residual gaps

Enumerated rather than left for the next reviewer, because the last round's mistake was claiming completeness.

**The runner-environment scrub (§D1) does not cover:**

1. **Secrets in files.** `HOME` is allowlisted, so `~/.aws/credentials`, the git-crypt'd dotfiles and `~/.gitconfig` are all reachable by a test that goes looking. This ADR is about the environment only.
2. **The two deliberate overrides.** `ATMUX_TEST_ENV_OK=1 bun test` runs against the live environment, and `ATMUX_TEST_ENV_PASSTHROUGH=NAME` admits a named variable through the wall. Both are by design and both are logged; neither is a hole anyone falls into.
3. **A credential inside an allowed prefix with an unfamiliar name.** `ATMUX_` and `KANBAN_` are allowed wholesale; a future `ATMUX_GITEA_PW` matches nothing in §D6's pattern and would pass. The mitigation is §D3 making every new name a visible decision, not the pattern.
4. **A secret injected into an allowlisted name** — writing a token into `ATMUX_DIR` would carry it through. Nothing detects that.
5. **`/proc/self/environ` on Linux** shows a process's environment as it started. Since the runner *starts* scrubbed this is not a hole for the runner itself, but it is worth knowing the mechanism exists.

**The source guard (§D4) does not cover:**

6. **Line-oriented scanning.** An argv array split across lines (`cmd: [\n  "env",\n]`) is not matched.
7. **Runtime assembly.** A command built by concatenation, held in a variable, or `eval`'d is invisible to a source scan by construction.
8. **Whole-object captures that are not the environment** — a config, a request, a process table. Same class, out of scope here, as ADR-282 already said.

## Out of scope

- **Credential rotation.** Values were disclosed on 2026-08-28; whether and which to rotate is the operator's decision and was raised separately. This ADR prevents recurrence and does nothing about what already leaked.
- **The 156 pre-existing `biome check` errors.** §C3.
- **The coverage gate.** `bun tests/lcov-gate.ts` — CI's step 6 — reports **206 breaches across 302 tracked files** on this branch. Recorded because a reader should not discover it in a CI log and wonder whether this change caused it: it cannot have. The only production edit here is an `export` keyword on `sendCageBrief`, and the file it is in sits at 78.44% line / 80.95% function, a gap a keyword does not open. It was not measured at `bb47d0b6`, so it is reported as observed rather than as a proven baseline.
- **Adding `scripts/**` to biome's `files.includes`.** It would light a genuine unlit corner and it would also add errors to an already-red gate, which is the regression §C3 exists to undo. The scrub's decision logic therefore lives in `tests/helpers/test-env.ts`, which **is** linted, and `scripts/test.ts` is kept to glue. Worth doing on its own.
- **Measuring any of this on tmux 3.6a or 3.4.** §C5.
