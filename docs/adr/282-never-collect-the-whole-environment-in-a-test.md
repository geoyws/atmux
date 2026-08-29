# ADR-282: Never collect the whole environment in a test — allowlist at the source

**Status**: accepted — operator-direct 2026-08-29
**Date**: 2026-08-28 (amended — see §Retraction 2026-08-29)
**Amended by**: this ADR's own §Retraction 2026-08-29, which records that its source-scanning guard was **deleted**. ⚠ A follow-on ADR (283, "scrub the test runner's environment") was proposed 2026-08-28 and **withdrawn 2026-08-29**; see §Retraction 2026-08-29 for why, and for what of it is kept.
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

**Amended 2026-08-28.** Two of those three checks were too weak to do the job claimed for them. `outPath` refused quotes only, while being spliced next to every other shell metacharacter — `;`, `&`, backtick, `$(`, `>`, whitespace and a newline were all live; it now takes a character allowlist. And nothing capped `vars`, so the sanctioned helper would build a whole-environment dump on request; there is now a cap of 8 and a refusal of any credential-shaped name.

### D3 — A redactor as the seatbelt, never as the brake

`parseEnvDump` replaces the value of any surviving name matching

```
/(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PAT|WEBHOOK|CREDENTIAL|AUTH)/i
```

with `<redacted>`. It matches the **name** only and never inspects the value, so it cannot itself become a disclosure path.

This is explicitly **not** the defence. A name-pattern list is a guess about what a secret is called, and it will always be incomplete — `DATABASE_URL` carries a password and matches nothing in that pattern. The allowlist is what actually keeps secrets out of the process; the redactor exists to blunt the damage when someone widens `vars` without thinking it through. Stated here so that no future reader mistakes it for sufficient.

**Amended 2026-08-28.** The pattern above matched bare substrings, so it also matched `PATH` (via `PAT`), `MONKEY` and `COMPATIBILITY` (via `KEY`). It is now anchored on `_` segments for the short, collision-prone tokens and left as a substring for the long, unambiguous ones. Pinned in both directions by `tests/unit/helpers/env-dump.test.ts`: `AZURE_DEVOPS_PAT`, `AWS_SECRET_ACCESS_KEY`, `PGPASSWD`, `AUTHORIZATION` and `lowercase_token` match; `PATH`, `MONKEY`, `COMPATIBILITY`, `KEYCHAIN` and `GIT_AUTHOR_NAME` do not.

### D5 — `tests/regression/` and `tests/helpers/` join the lint scope

`biome.json`'s `files.includes` gained both. `tests/regression/` being outside it is why an unlinted, unformatted file sat in the repository and a green `bun run lint` said nothing about it. `tests/helpers/` follows for the same reason — it is where the new shared helper lives, and a helper nothing checks is the next unlit corner.

`tests/helpers/` brings **7 pre-existing warnings** (`lint/style/noNonNullAssertion`) in files this change does not otherwise touch. They are left standing and surfaced rather than silenced: biome exits 0 on warnings so nothing breaks, and the fixes are semantic (`!` → `?.`) in unrelated test helpers. Suppressing them with an `overrides` rule would be loosening a measurement to make a gate green, which is exactly the move `/CLAUDE.md` forbids.

⚠ **Corrected 2026-08-28, re-measured 2026-08-29.** Two errors in the paragraph above.

**(a) It counted the formatting and import-order diagnostics among the harmless warnings. They are errors.** `biome check .` — what CI runs — went **156 → 162** on this include, while the `LINT_EXIT=0` cited at the time came from `bun run lint`, which is `biome lint .` only and skips the format and assist passes. The six are **4 `format` + 2 `assist/source/organizeImports`**; they are fixed and the count is back to **156**.

**(b) It said "four files". It is TWO.** Re-measured 2026-08-29 by diffing the full diagnostic sets of `e50e3266` and `bb47d0b6` under the same pinned binary (`node_modules/@biomejs/cli-darwin-arm64/biome`, 2.4.14): the 7 `noNonNullAssertion` warnings are **6 in `tests/helpers/__smoke__.test.ts` and 1 in `tests/helpers/honker-mock.ts`**. The other two files the include newly brought into scope (`kanban-cli-fixtures-414bfdd.ts`, `kanban-fixtures.ts`) contributed `format` errors, not warnings — which is how the two counts came to be conflated.

Verified counts, same binary, whole repository: **e50e3266 = 156 errors / 181 warnings; bb47d0b6 = 162 / 188.** Only the 7 `noNonNullAssertion` warnings are genuinely left standing.

## Consequences

- A failing assertion in the colour-scrub suite now prints at most four variables. Verified by mutation on 2026-08-28: with the scrub deliberately broken, the received value was `TERM=… NO_COLOR=1 TMUX=… COLORTERM=…` and nothing else.
- One judgement call is now encoded where it can be reviewed: which variables a test may collect. Widening it is a visible edit to a `vars` argument, not an invisible default.

## Retraction 2026-08-29 — ADR-283 withdrawn, and the source-scanning guard deleted

**ADR-283 is withdrawn.** It was proposed on 2026-08-28 as the layer this ADR could not be: rather than recognising capture shapes in source, it emptied the runner's environment so there was nothing to capture. Both of its load-bearing claims failed. The full retraction, with the shell-hop table and the `autoMerge` collision, is in [ADR-281](281-tmux-child-environment-scrub-at-the-spawn-seam.md) §Retraction 2026-08-29; the short form is that a scrubbed runner does not stay scrubbed across one `zsh -lic` hop (**81 names, 25 credential-shaped**, up from 11/0 for `zsh -lc`), and that its bare-`bun test` refusal is indistinguishable from a test failure to this repository's live `autoMerge` gitter, which would have answered it with `git revert`.

**The source-scanning guard test is deleted, and the §D4 that decided it is gone from this document.** A regex over arbitrary source cannot recognise "this program captures the environment", and three rounds of widening it produced a new gap and a new overstatement each time. §D1's allowlist-at-the-source is the standing defence, and it is the one that actually closes the disclosure: what a probe never collects cannot be printed.

### `parseEnvDump`'s newline mitigation was order-dependent

§D2's amendment kept only the FIRST sighting of a repeated name, on the reasoning that a repeat proves a faked variable boundary. The reasoning was right and the implementation was backwards: **the order is chosen by the secret, not by us.** Measured 2026-08-29 against that version, with a placeholder payload — given `["TERM=<fragment>", "TERM=tmux-256color"]` it emitted **the fragment verbatim** and redacted the legitimate value. A repeat proves that the boundary producing *both* lines is fake, so **both** are now redacted, and both orders are pinned by test.

## Out of scope

- **Credential rotation.** Values were disclosed to a log and a transcript on 2026-08-28; whether to rotate them, and which, is the operator's decision and has already been raised separately. This ADR prevents recurrence and does nothing about what already leaked. Nothing in this repository should hold those values in any case — the standing rule is that secrets live in the git-crypt'd dotfiles store with only a non-secret pointer in prose.
- **Environment hygiene in the test runner.** A narrower runner environment would reduce blast radius, but the suites legitimately read `HOME`, `PATH` and `TMUX*`, and pruning it is a separate change with its own failure modes. ⚠ ADR-283 took this into scope on 2026-08-28 and was **withdrawn on 2026-08-29** — a scrubbed runner does not stay scrubbed across an interactive-shell hop, and its `bun test` refusal collided destructively with `autoMerge.revertOnFail`. See §Retraction 2026-08-29. This stays OUT of scope.
- **Other whole-object captures.** Dumping a whole config, request or process table has the same shape and is not covered here; §D1's rule is scoped to the environment, which is the case with a known disclosure.
- **`src/` diagnostic verbs that print environment state to an operator.** An operator-facing diagnostic showing an operator their own environment is a different judgement from a test log.
