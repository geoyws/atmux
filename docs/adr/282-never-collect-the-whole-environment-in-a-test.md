# ADR-282: Never collect the whole environment in a test — allowlist at the source, guard the class

**Status**: proposed
**Date**: 2026-08-28 (amended same day — see §Retraction 2026-08-28)
**Amended by**: this ADR's own §Retraction 2026-08-28 — which **retracts §D4's and §Consequences' coverage claims**. ⚠ A follow-on ADR (283, "scrub the test runner's environment") was proposed 2026-08-28 and **withdrawn 2026-08-29**; see §Retraction 2026-08-29 for why, and for what of it is kept.
**Relates**: [ADR-281](281-tmux-child-environment-scrub-at-the-spawn-seam.md) (whose regression suite is the file this is about), [ADR-277](277-cage-color-environment-scrub.md) (the invariant that suite guards), [ADR-102](102-test-strategy.md) (the test-strategy this adds a rule to)

## Context

### What happened

`tests/regression/atmux-conf-no-color-scrub.test.ts` verifies that a tmux pane does not inherit `NO_COLOR`. To do that it has to read a real pane's environment, so it started a probe pane running

```
sh -c 'env > <file>; sleep 3'
```

read the file back, and asserted on the resulting string.

On 2026-08-28 an assertion in that suite failed. `expect(received)` prints the received value **in full**, so approximately 180 environment variables — **with their values** — went into the test output, and from there into an agent transcript. The operator's `.zshrc` sources a git-crypt'd `.env`, so that set included live API tokens, database and documentation-site passwords, and Discord webhook URLs.

Nothing about the assertion was wrong. The suite was doing exactly what it was written to do, and the fault surfaced the moment it did its job.

### Why the obvious repair is not enough

The first repair filtered the dump by variable name before asserting. That is a real improvement and it is not sufficient:

- The full environment still enters the test process. The projection is one `expect(raw)` away, and the raw value is right there in scope.
- It is a habit, not a mechanism. The next probe someone writes will reach for `env` again, because that is the obvious way to read an environment, and nothing in the repository will say otherwise.
- The directory it lives in, `tests/regression/`, was absent from `biome.json`'s `files.includes`, so `bun run lint` passing said nothing about it. The problem was in an unlit corner.

### The general shape

A test that (a) captures data it does not need, and (b) asserts on it, converts *any* future assertion failure into a disclosure. The severity is set by what is in the environment, which the test author neither controls nor sees. This is the same class as logging a whole request object because the one field you wanted was inside it.

## Decision

### D1 — Never collect the whole environment

A probe collects an **allowlist**, filtered inside the probe itself, before the data can reach the test process:

```
env | grep -E "^(NO_COLOR|COLORTERM|TERM|TMUX)=" > <file> || true
```

The four names are terminal-capability flags and a tmux socket address; none can carry a secret. Filtering at the source rather than on the way in is the whole decision: what is never collected cannot be printed by a failure, by a debug `console.log`, by a snapshot, or by a future author who did not read this ADR.

`|| true` is load-bearing rather than defensive noise. `grep` exits 1 on no match, and "no match" is the *expected* result for the leg asserting `NO_COLOR` is absent; without it the probe pane exits non-zero, writes nothing, and the test times out on a missing file instead of asserting on an empty projection.

### D2 — One shared helper, so the next test cannot get it wrong

`tests/helpers/env-dump.ts` (the repo's existing test-support directory — no new convention) exports:

| Export | Role |
|---|---|
| `ENV_DUMP_ALLOWLIST` | the four names above |
| `dumpEnvCommand(outPath, vars?, keepAliveSeconds?)` | builds the probe's `sh -c '…'` command |
| `parseEnvDump(dump, vars?)` | filters again on the way in, and redacts |
| `SENSITIVE_NAME_RE`, `REDACTED` | the redactor's rule and its substitute |

`dumpEnvCommand` validates its inputs rather than trusting them: an `outPath` containing a quote is refused (it is spliced into a shell word), a name that is not a plain identifier is refused (it is spliced into an ERE), and an empty allowlist is refused (that would dump everything). A widened `vars` at one call site stays visible in the test that wanted it, instead of widening every probe in the repository.

**Amended 2026-08-28.** Two of those three checks were too weak to do the job claimed for them. `outPath` refused quotes only, while being spliced next to every other shell metacharacter — `;`, `&`, backtick, `$(`, `>`, whitespace and a newline were all live; it now takes a character allowlist. And nothing capped `vars`, so the sanctioned helper would build a whole-environment dump on request, at a call site §D4's guard reads as an ordinary helper call; there is now a cap of 8 and a refusal of any credential-shaped name.

### D3 — A redactor as the seatbelt, never as the brake

`parseEnvDump` replaces the value of any surviving name matching

```
/(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PAT|WEBHOOK|CREDENTIAL|AUTH)/i
```

with `<redacted>`. It matches the **name** only and never inspects the value, so it cannot itself become a disclosure path.

This is explicitly **not** the defence. A name-pattern list is a guess about what a secret is called, and it will always be incomplete — `DATABASE_URL` carries a password and matches nothing in that pattern. The allowlist is what actually keeps secrets out of the process; the redactor exists to blunt the damage when someone widens `vars` without thinking it through. Stated here so that no future reader mistakes it for sufficient.

**Amended 2026-08-28.** The pattern above matched bare substrings, so it also matched `PATH` (via `PAT`), `MONKEY` and `COMPATIBILITY` (via `KEY`). It is now anchored on `_` segments for the short, collision-prone tokens and left as a substring for the long, unambiguous ones. Pinned in both directions by `tests/unit/helpers/env-dump.test.ts`: `AZURE_DEVOPS_PAT`, `AWS_SECRET_ACCESS_KEY`, `PGPASSWD`, `AUTHORIZATION` and `lowercase_token` match; `PATH`, `MONKEY`, `COMPATIBILITY`, `KEYCHAIN` and `GIT_AUTHOR_NAME` do not.

### D4 — A guard test for the shapes it enumerates

> ⚠ **This section's original title and framing — "so the class cannot come back" — are RETRACTED.** See §Retraction 2026-08-28. The guard catches enumerated shapes; it is not a proof of absence, and it was written here as though it were.

`tests/regression/no-unfiltered-env-dump.test.ts` scans every `.ts/.tsx/.js/.mjs/.cjs/.sh/.bash/.bats/.conf` file under `src/`, `tests/`, `scripts/`, `bin/`, `templates/` and `plugins/` and fails the suite on an unfiltered environment capture, naming the file, the line, and the safe alternative. The matcher and the roots were widened 2026-08-28 and the scan's own discovery was made non-vacuous; see §Retraction 2026-08-29 for the measured catch/miss ratio and for the `templates/` root's real justification.

The rule is deliberately blunt rather than clever, because a rule an author can reason around is not a guard:

| Shape | Verdict |
|---|---|
| `env` redirected to a path or an expansion | **fail** |
| `env` piped to anything that is not `grep` | **fail** |
| `env \| grep …` | allowed — filtered at the source |
| the same, spelled `printenv` | identical treatment |

Two scoping choices, both stated rather than left to be discovered:

- **Comment lines are skipped.** A comment does not execute, so a documented example of the forbidden shape is not a violation. This is not an exclusion list anyone can hide live code behind.
- **A redirect only counts when its target looks like a path or an expansion** (`${out}`, `/tmp/x`, `"$D/out"`, `./out`, `~/x`). This is what separates a shell fragment from English: the repository's prose writes precedence chains as `flag > env > default`, and help text as `per-call > env > the atmux on PATH`. Measured 2026-08-28: 12 such lines across `src/` and `tests/`, all prose, all excluded, zero real dumps excluded. **The known gap, stated rather than papered over:** a redirect to a bare relative filename (`env > out`) is not matched, because by this rule it is indistinguishable from prose. No probe in this repository writes one — they all use `mkdtemp` absolute paths or a `${…}` expansion — and the pipe rule has no such gap. **CLOSED 2026-08-28**: it IS distinguishable, because prose runs on past the target into a sentence while a redirect ends the statement, and because the precedence-chain prose always puts an arrow immediately BEFORE the word.

The guard applies to itself. There is **no path exclusion list**; the forbidden fragments in its own fixtures are assembled from pieces at runtime, precisely because an exclusion list is the first thing a future author would reach for to get past it.

### D5 — `tests/regression/` and `tests/helpers/` join the lint scope

`biome.json`'s `files.includes` gained both. `tests/regression/` being outside it is why an unlinted, unformatted file sat in the repository and a green `bun run lint` said nothing about it. `tests/helpers/` follows for the same reason — it is where the new shared helper lives, and a helper nothing checks is the next unlit corner.

`tests/helpers/` brings **7 pre-existing warnings** (`lint/style/noNonNullAssertion`) in files this change does not otherwise touch. They are left standing and surfaced rather than silenced: biome exits 0 on warnings so nothing breaks, and the fixes are semantic (`!` → `?.`) in unrelated test helpers. Suppressing them with an `overrides` rule would be loosening a measurement to make a gate green, which is exactly the move `/CLAUDE.md` forbids.

⚠ **Corrected 2026-08-28, re-measured 2026-08-29.** Two errors in the paragraph above.

**(a) It counted the formatting and import-order diagnostics among the harmless warnings. They are errors.** `biome check .` — what CI runs — went **156 → 162** on this include, while the `LINT_EXIT=0` cited at the time came from `bun run lint`, which is `biome lint .` only and skips the format and assist passes. The six are **4 `format` + 2 `assist/source/organizeImports`**; they are fixed and the count is back to **156**.

**(b) It said "four files". It is TWO.** Re-measured 2026-08-29 by diffing the full diagnostic sets of `e50e3266` and `bb47d0b6` under the same pinned binary (`node_modules/@biomejs/cli-darwin-arm64/biome`, 2.4.14): the 7 `noNonNullAssertion` warnings are **6 in `tests/helpers/__smoke__.test.ts` and 1 in `tests/helpers/honker-mock.ts`**. The other two files the include newly brought into scope (`kanban-cli-fixtures-414bfdd.ts`, `kanban-fixtures.ts`) contributed `format` errors, not warnings — which is how the two counts came to be conflated.

Verified counts, same binary, whole repository: **e50e3266 = 156 errors / 181 warnings; bb47d0b6 = 162 / 188.** Only the 7 `noNonNullAssertion` warnings are genuinely left standing.

## Consequences

- A failing assertion in the colour-scrub suite now prints at most four variables. Verified by mutation on 2026-08-28: with the scrub deliberately broken, the received value was `TERM=… NO_COLOR=1 TMUX=… COLORTERM=…` and nothing else.
- ~~Every future environment probe has one obvious route, and taking any other route fails the suite with a message naming the route it should have taken.~~ **RETRACTED — see §Retraction 2026-08-28.** At least twelve other routes did not fail the suite, including `Bun.spawnSync({ cmd: ["env"] })`. What is true: the guard names the sanctioned route in its failure message, for the shapes it recognises.
- The guard is itself mutation-proven: reintroducing the exact 2026-08-28 shape in the colour-scrub suite turned it red naming that file and line; so did a mutation that removed the filter from `dumpEnvCommand` — the guard caught its own helper regressing.
- One judgement call is now encoded where it can be reviewed: which variables a test may collect. Widening it is a visible edit to a `vars` argument, not an invisible default.

## Retraction 2026-08-28 (same day)

Three adversarial reviews of the commit that shipped this ADR returned DEFECTIVE. Two of this ADR's coverage claims were false in the same way ADR-277's was — documentation asserting a guarantee the code did not deliver — and are retracted rather than softened:

1. **§D4's title and premise, "so the class cannot come back."** A reviewer drove sixteen whole-environment-capture shapes through §D4's matcher: **it caught four and missed twelve**, including `Bun.spawnSync({ cmd: ["env"], stdout: "pipe" })` — the idiomatic TypeScript route, which the very file the guard protects already used four times for other commands. The guard is a tripwire for enumerated shapes.
2. **§Consequences' "taking any other route fails the suite."** Same measurement, same verdict.

Recognising an arbitrary program as "captures the environment" is not something a source pattern can do. A follow-on ADR (283) tried to sidestep that by emptying the runner's environment instead; it was withdrawn on 2026-08-29 because its own guarantee did not hold either — see §Retraction 2026-08-29. This ADR's helper, its guard and its ADR-102 rule all stand; only the two coverage claims fall. Per the append-only rule the file is not rewritten — the retracted sentences are struck in place.

## Retraction 2026-08-29 — ADR-283 withdrawn; this ADR's guard measured honestly

**ADR-283 is withdrawn.** It was proposed on 2026-08-28 as the layer this ADR could not be: rather than recognising capture shapes in source, it emptied the runner's environment so there was nothing to capture. Both of its load-bearing claims failed. The full retraction, with the shell-hop table and the `autoMerge` collision, is in [ADR-281](281-tmux-child-environment-scrub-at-the-spawn-seam.md) §Retraction 2026-08-29; the short form is that a scrubbed runner does not stay scrubbed across one `zsh -lic` hop (**81 names, 25 credential-shaped**, up from 11/0 for `zsh -lc`), and that its bare-`bun test` refusal is indistinguishable from a test failure to this repository's live `autoMerge` gitter, which would have answered it with `git revert`.

So **this ADR's guard is the standing defence again**, and it is now described by measurement rather than by hope.

### The matcher's measured catch/miss ratio

Re-enumerated first-hand 2026-08-29 over **36** genuine whole-environment-capture shapes, and pinned by an executing test (`tests/regression/no-unfiltered-env-dump.test.ts`, "the matcher's catch/miss ratio is measured, not assumed") so the number cannot drift away from the code:

| | shapes enumerated | caught | missed |
|---|---|---|---|
| measured 2026-08-29 | **36** | **23** | **13** |

Both halves are asserted: every "caught" shape must be caught **and every "missed" shape must still be missed**, so the ratio is a fact about the matcher rather than a claim about it.

**The missed 13, by class** — the alternate-dumper class first, because it was absent from the previous residual-gaps list entirely, which is how a guard comes to be trusted for more than it does:

- **5 × runtime object** — `console.log(process.env)`, `JSON.stringify(process.env)`, `{ ...process.env }`, `Object.entries(process.env)`, a snapshot assertion. Missed **by design**: `process.env` is read legitimately throughout `src/`, so matching it would be all false positives.
- **3 × shell builtin** — `export -p`, `declare -x`, `set`. Each prints the environment as surely as `env` does; none is in the `DUMPERS` roster.
- **1 × kernel interface** — `cat /proc/self/environ`.
- **1 × process table** — `ps eww <pid>`.
- **1 × quoted shell word** — `sh -c "env" > file`: the redirect sits outside the quotes, so neither the redirect rule nor the argv rule fires.
- **1 × line-split argv** and **1 × runtime assembly** — the two gaps §D4 already named.

**The claim, stated as it is: a tripwire for enumerated shapes, not a proof of absence.**

### The `templates/` root's justification was false, and it hid a live blind spot

§D4's roots were widened on 2026-08-28 with the reason "all carry executable shell". That is **false of `templates/`**, which holds no `.sh`, `.bash` or `.bats` file at all. Worse, the false reason concealed a real gap: `templates/tmux/atmux.conf` — the file this series' own colour work edits — was **unscannable**, because `.conf` was not in `SCAN_EXTS`. A `run-shell 'env > /tmp/x'` in a shipped tmux conf would have sailed through.

Fixed by measuring the actual reason. A tmux conf **does** execute shell: on tmux 3.7c against a throwaway `mktemp` socket (2026-08-29), a conf containing `run-shell "echo … > <marker>"` wrote the marker. `.conf` is now in `SCAN_EXTS`, and a new leg enumerates the extensions actually present in the scanned roots and fails if an executable one is not scanned — so the roster cannot go stale behind a stale justification again.

### `parseEnvDump`'s newline mitigation was order-dependent

§D2's amendment kept only the FIRST sighting of a repeated name, on the reasoning that a repeat proves a faked variable boundary. The reasoning was right and the implementation was backwards: **the order is chosen by the secret, not by us.** Measured 2026-08-29 against that version, with a placeholder payload — given `["TERM=<fragment>", "TERM=tmux-256color"]` it emitted **the fragment verbatim** and redacted the legitimate value. A repeat proves that the boundary producing *both* lines is fake, so **both** are now redacted, and both orders are pinned by test.

## Out of scope

- **Credential rotation.** Values were disclosed to a log and a transcript on 2026-08-28; whether to rotate them, and which, is the operator's decision and has already been raised separately. This ADR prevents recurrence and does nothing about what already leaked. Nothing in this repository should hold those values in any case — the standing rule is that secrets live in the git-crypt'd dotfiles store with only a non-secret pointer in prose.
- **Environment hygiene in the test runner.** A narrower runner environment would reduce blast radius, but the suites legitimately read `HOME`, `PATH` and `TMUX*`, and pruning it is a separate change with its own failure modes. ⚠ ADR-283 took this into scope on 2026-08-28 and was **withdrawn on 2026-08-29** — a scrubbed runner does not stay scrubbed across an interactive-shell hop, and its `bun test` refusal collided destructively with `autoMerge.revertOnFail`. See §Retraction 2026-08-29. This stays OUT of scope.
- **Other whole-object captures.** Dumping a whole config, request or process table has the same shape and is not covered here; the guard is scoped to the environment, which is the case with a known disclosure.
- **`src/` diagnostic verbs that print environment state to an operator.** None exist today (the scan is clean), and an operator-facing diagnostic showing an operator their own environment is a different judgement from a test log.
