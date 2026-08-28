# ADR-281: The `NO_COLOR` scrub moves to the spawn seam — a tmux server atmux starts can never inherit it

**Status**: proposed
**Date**: 2026-08-28 (revised same day — see §Revision 2026-08-28)
**Amends**: [ADR-277](277-cage-color-environment-scrub.md) — keeps its conf directive, **retracts** its coverage claim (see §Retraction). ADR-277 is not superseded: its `set-environment -gr NO_COLOR` stays exactly where it is, and stays the layer an operator can override.
**Relates (safety)**: [ADR-282](282-never-collect-the-whole-environment-in-a-test.md) — this ADR's own regression suite is what leaked an operator environment; ADR-282 filters every probe at the source. [ADR-283](283-scrub-the-test-runner-environment.md) then removes the credentials from the runner's environment entirely, corrects this ADR's `templates/tmux/atmux.conf` claim (§C1), and adds the tests that make §D2's and §D3's invariants enforced rather than merely stated (§B1, §B2).
**Relates**: [ADR-100](100-spawn-pattern.md) (the `spawn()` abstraction this widens), [ADR-097](097-tmux-abstraction.md) (the tmux wrapper whose call sites this touches), [ADR-180](180-human-attach-verb.md) (`spawnInheritStdio`, the tty-inherit carve-out — also patched), [ADR-162](162-atmux-owns-tmux-infrastructure.md) (atmux owns the canonical tmux.conf — the `-f` threading whose universality this ADR disproves), [ADR-171](171-tmux-conf-local-override.md) (the operator override that must still be able to win), [ADR-191](191-vendored-tmux-binary.md) (`resolveTmuxBin()` — the call sites enumerated in §D3)

## Context

### The mechanism, restated because it is the whole argument

A tmux **server** freezes its own environ at start and initialises its global environment from it. Every pane that server ever creates is built from that frozen copy. `TERM` is re-derived per pane from `default-terminal`, and the `update-environment` list is re-read per attach — **`NO_COLOR` is in neither**, so it survives, unchanged, into every shell and every TUI on that server for as long as the server lives.

Claude Code's Bash tool exports `NO_COLOR=1` (and an empty `COLORTERM`) so captured command output is plain text. That is correct for a captured subprocess and wrong for a long-lived interactive cage. Starting a cage from inside an agent session is a normal way to start a cage, so the fault recurs by construction — ADR-277 established all of this.

### Why the conf-only fix was not enough

ADR-277 fixed it in `templates/tmux/atmux.conf`, and asserted:

> Because atmux passes `-f <this file>` on every invocation (ADR-162), this covers every cage, however it was launched.

**That premise is false, in two independent ways.**

1. **`-f` is only on the argv when the caller supplied a `configFile`.** `createTmux(config)` builds its global-flag prefix from `config.socket`/`config.socketPath` plus `-f` *only if* `config.configFile` is a string. Most call sites pass it (`start.ts`, `cockpit.ts`, `fallback-cage.ts` all thread `getAtmuxTmuxConfPath()`); several do not — `vox.ts`'s supervisor (`createTmux({ socket: VOX_TMUX_SOCKET })`), `scripts/vox-e2e.ts`, and every `createTmux({ socketPath })` in the read-path modules. A server started by one of those has never seen the conf.
2. **The conf only loads for the command that actually STARTS the server, and that command is frequently not the one anybody thinks of as "creating the cage".** tmux starts a server implicitly for *any* subcommand that needs one against a dead socket — `attach-session`, and even a read-only `list-keys`. So a probe, a doctor check, or an operator's own `attach` can be the process whose environ gets frozen, permanently, before any `-f`-carrying command ever runs. The conf that the *next* command passes is read by a server that already exists, and a running tmux server does not re-read a conf.

There are two further vectors that defeat a conf-only fix and are worth naming so nobody re-derives them: `getAtmuxTmuxConfPath()` honours `ATMUX_TMUX_CONF` verbatim and explicitly blesses `ATMUX_TMUX_CONF=/dev/null` as an operator opt-out; and cages resolve the conf through `/opt/atmux/<version>/templates/`, where ADR-277 §D4 deliberately patched only `0.8.30` and left `0.8.29` alone.

### Measured evidence

Recon on `geoywsMBP`, 2026-08-28, across **47 live tmux servers**:

| Finding | Count | Which |
|---|---|---|
| Servers carrying a live `NO_COLOR=1` | **2** | `rx`, `hrx` |
| Servers that had never loaded any atmux conf | **6** | `rx`, `hrx`, `fmx`, `hx`, `ifca-docs`, `grp-geoyws` |

Both poisoned servers were created by a bare `tmux -S <sock> new-session` with **no `-f`** — i.e. exactly failure mode 1. And `grp-geoyws`'s server was born from **`attach`**, which is failure mode 2 in the wild: a read-only command permanently fixed the colour configuration of a cage, and `attach` goes through `client.attachSessionInheritStdio`, so §D3 covers it.

**`hx`'s server was born from `tmux list-keys`, and this ADR's fix does NOT cover that — stated plainly because it is the honest limit of the change.** `list-keys` appears **nowhere** in atmux's source: `rg 'list-keys' src/ scripts/ templates/ bin/` returns zero matches (verified 2026-08-28). So that server was created by something *outside* atmux — an operator keystroke, a shell function, another tool — and a seam inside `spawn()` cannot reach a process atmux never spawned. It is real evidence for the *mechanism* (any subcommand against a dead socket starts a server, read-only ones included) and it is **not** evidence that this fix covers it. For servers atmux did not start, the covering layer is ADR-277's conf (layer 2) when the conf loads, and the §D3 in-place repair when it did not. Nothing here closes the case of a third-party tool starting a cage server with a poisoned environ; that would need a different mechanism and is out of scope.

Note what the numbers do *not* say. Only 2 of 6 conf-less servers were actually poisoned, because the other four happened to be started from an environment that had no `NO_COLOR` to inherit. The conf scrub is not failing at scrubbing; it is simply absent from six servers, and whether that absence hurts is decided by who happened to type the command. That is a coin-flip, not a guarantee — which is the case for moving the fix somewhere the coin cannot be flipped.

## Decision

### D1 — The scrub moves to the spawn seam, where the variable can be removed before tmux can freeze it

`src/abstractions/spawn.ts` gains an env-**deletion** seam:

```ts
unsetEnv?: ReadonlyArray<string>;
```

on `SpawnOpts` and `SpawnInheritStdioOpts` (`SpawnStreamOpts` inherits it through `Omit<SpawnOpts, …>`). All three exported spawn functions funnel through the same `mergeEnv`, which now takes it.

This was previously **unrepresentable**, not merely unused. `env` is typed `Readonly<Record<string, string>>` and `mergeEnv` only ever assigns, so the nearest a caller could get was `{ NO_COLOR: "" }` — a *different* observable state. ADR-277 §D1 already rejected the empty form for the right reason: some consumers treat a defined-but-empty `NO_COLOR` as unset and others do not, and the intent is "this variable does not exist".

**Ordering**: deletion runs **after** the `env` merge, so `unsetEnv` wins over a contradicting `env` key. The alternative — throwing on the contradiction — would make the invariant runtime-conditional at every call site. Making deletion the last word keeps "this variable cannot reach the child" unconditional, which is the only property worth having here. Documented in `mergeEnv`'s docblock, not left to be inferred.

### D2 — The policy is a DELETION, and only a deletion

`src/abstractions/tmux.ts` exports:

```ts
export const TMUX_CHILD_UNSET_ENV = Object.freeze(["NO_COLOR"]);
export const TMUX_CHILD_ENV_ARGV = Object.freeze(["-u", "NO_COLOR"]);
```

and passes the first at **every** `spawn()` / `spawnInheritStdio()` call in the module — `tmuxRunRaw` (which every namespace method routes through), `buffer.loadBuffer` (which bypasses `tmuxRun` for stdin, and must not therefore become a second, divergent environment policy), and `client.attachSessionInheritStdio` (attach against a dead socket starts a server — failure mode 2 exactly).

A constant rather than three inline literals, because the failure this prevents is a *future* call site forgetting. The module header records the one documented exception to its own "argv-shape-only" contract.

**atmux SETS no colour variable on any tmux child.** The first revision of this ADR also shipped `TMUX_CHILD_ENV = { COLORTERM: "truecolor" }` and passed it at all three sites. That half is **withdrawn**; the rationale given for it was wrong on the pane path and the mechanism was harmful on the client path.

**Pane path — the stated rationale was false.** §D2 originally justified it as "an agent Bash tool exports `COLORTERM` **empty**, which several TUIs read as no 24-bit colour". tmux sets `COLORTERM` in every pane **itself**, overriding whatever the server froze. Measured on `geoywsMBP`, tmux 3.7c, 2026-08-28: a server started with `-f /dev/null` whose own environ carried `COLORTERM=` (empty) reports `COLORTERM=` on `show-environment -g`, and yet its pane comes out `COLORTERM=truecolor`. A reviewer reached the same conclusion by mutation — emptying `TMUX_CHILD_ENV` outright still left the regression suite 9 pass / 0 fail, because nothing in it depended on atmux having set the variable. The knob was inert.

**Client path — the mechanism was actively harmful.** `attachSessionInheritStdio` runs the tmux **client**, in the operator's terminal, and tmux reads `COLORTERM` **from the client** to decide whether that terminal advertises 24-bit colour. Measured the same day, against a server started with no `COLORTERM` at all so the reading cannot come from the server side:

| Client environment | `#{client_termfeatures}` |
|---|---|
| no `COLORTERM` | `bpaste,ccolour,clipboard,cstyle,focus,title` |
| `COLORTERM=truecolor` | `bpaste,ccolour,clipboard,cstyle,focus,`**`RGB`**`,title` |

**Re-measured and confirmed 2026-08-28** ([ADR-283](283-scrub-the-test-runner-environment.md) §C5), after one of three reviewers could not reproduce it. Three details decide whether it reproduces, and are recorded because their absence is the likely reason it did not: the client needs a **controlling terminal** (`tmux attach` with no pty never becomes a client — run it under `script -q /dev/null` and read the feature string from outside via `list-clients -F`); **`TERM` must be identical in both legs**, since it dominates the feature list; and the **server** must carry no `COLORTERM`, or the reading can come from the server side and both legs look alike. Binary: `/Users/geoyws/.local/share/mise/installs/tmux/latest/tmux`, tmux 3.7c, macOS. ⚠ The vendored pin (ADR-191) is **3.6a** and CI installs **3.4**; nothing in this ADR has been measured on either.

`RGB` appears only when the **client** has it. So `atmux attach` was asserting RGB capability on the operator's behalf: tmux stops downconverting and writes raw `\033[38;2;R;G;Bm` at a terminal that never claimed to understand it. That is precisely the harm this ADR already cites as its reason for refusing to force `TERM` — the rule was stated and then broken one field over.

**The distinction to hold: server-level `COLORTERM` is fine; client-level `COLORTERM` is not ours to assert.** What is withdrawn is only atmux injecting it into a process environment, which is the one place it can reach a client.

> ⚠ **CORRECTED 2026-08-28 by [ADR-283](283-scrub-the-test-runner-environment.md) §C1.** This paragraph originally read "The operator's own `~/.tmux.conf` and `templates/tmux/atmux.conf` **keep** their `COLORTERM truecolor` line, deliberately and unchanged", and §Consequences said the same. **`templates/tmux/atmux.conf` had no such line.** Its only `set-environment` was `NO_COLOR`; its only `COLORTERM` occurrence was inside a comment. The line existed solely in the operator's personal `~/.tmux.conf`, which this repository does not ship — so the compensating control this section leaned on did not exist in anything atmux deploys. The claim is now TRUE: `set-environment -g COLORTERM truecolor` is in the shipped conf, after the ADR-277 scrub and above the ADR-171 `source-file`, and two regression legs keep it there. Measured before shipping it, tmux 3.7c: with the option set server-side and the client carrying no `COLORTERM` of its own, `#{client_termfeatures}` is `bpaste,ccolour,clipboard,cstyle,focus,title` — **no RGB**, so the server-side half genuinely does not assert on the operator's behalf. On 3.7c it is also **inert for the pane** (tmux sets `COLORTERM=truecolor` there itself, measured with and without the line); its stated value is the **3.6b** servers measured below, and that 3.6b measurement has not been reproduced since. The error came from the instructions the implementing agent was given, not from its own work.

Keeping a knob whose only proven effect is on the path where it does harm is worse than not having it, so the export is gone rather than emptied — an empty `TMUX_CHILD_ENV` is a dead seam that invites a future author to refill it.

**`TERM` is deliberately NOT set here either**, for the original and still-correct reason: tmux re-derives `TERM` per pane from `default-terminal`, so setting it client-side buys nothing on the pane side and risks breaking an operator whose own terminal is not 256-colour.

`TMUX_CHILD_ENV_ARGV` is the same policy expressed as `env(1)` flags, for the call sites that reach tmux through `sudo -u <agent> env … tmux …`. A spawn-level override does **not** survive `sudo` (`env_reset`), so those sites must rebuild it in argv. It is kept byte-for-byte equivalent to `TMUX_CHILD_UNSET_ENV` — it dropped its `COLORTERM=truecolor` element with the rest — so the sudo path cannot drift into a second colour policy. `env -u NAME` on an unset variable is a no-op, not an error.

### D3 — Every path that starts a tmux process carries it, including the read-only ones

Enumerated rather than asserted, because "every invocation" is the claim this ADR exists to retract:

| Call site | Route | How it is covered |
|---|---|---|
| `abstractions/tmux.ts` × 3 | direct | `TMUX_CHILD_UNSET_ENV` |
| every `createTmux(…)` consumer — `start.ts`, `cockpit.ts` (team/group/cockpit servers), `vox.ts`, `groom.ts`, `status.ts`, `doctor.ts`, the read-path modules | via `createTmux` → `spawn()` | **already covered** by the row above; no change needed at those sites, and none was made |
| `fallback-cage.ts` Tier-2 `newSession` | via `createTmux` → `spawn()` | **already covered** |
| `fallback-cage.ts` Tier-3+ `sudo … new-session` / `kill-session` | direct, through `sudo` | `TMUX_CHILD_ENV_ARGV` in the `env(1)` prefix |
| `fallback-cage.ts` `capture-pane` | direct | spawn-level `unsetEnv` |
| `poke.ts` `sendCageBrief` (load-buffer / paste-buffer / send-keys) | direct, both UID branches | spawn-level `unsetEnv` on both, plus `TMUX_CHILD_ENV_ARGV` on the sudo branch |
| `doctor/types.ts::defaultTmuxSpawn` | direct | spawn-level `unsetEnv` |
| `cursor-recipes/fix-supervisor-missing.ts` (`list-windows`, unpinned socket) | direct | spawn-level `unsetEnv` |

The last two are read-only probes. They are covered **because** they are the shape that bit `hx` and `grp-geoyws`: a read-only command against a dead socket is a server-creating command.

### D4 — Three layers, in this order, and the operator still wins

1. **spawn env** (this ADR) — removes the variable before tmux can freeze it. Holds whether or not a conf loads.
2. **`templates/tmux/atmux.conf`** `set-environment -gr NO_COLOR` (ADR-277) — holds for servers atmux did not start, and for a stale deployed binary that predates this change.
3. **`~/.config/atmux/tmux.conf.local`** (ADR-171) — loads last, so an operator who genuinely wants monochrome cages re-sets `NO_COLOR` there and wins. Unchanged, and still pinned by its ordering test.

Layers 1 and 2 are belt-and-braces on purpose: `set-environment -gr` on an already-absent variable is a documented no-op (ADR-277 §D1), so running both costs nothing and each covers a hole the other does not.

### D5 — atmux's own output is untouched, and that is tested

`mergeEnv` rewrites only the **child's** copy. Nothing in this change writes to `process.env`, and nothing may: `src/core/tui.ts::defaultPalette` reads `process.env.NO_COLOR` at call time, so a `delete process.env.NO_COLOR` anywhere in atmux would silently re-colour atmux's own stdout inside an agent Bash tool, break the no-color.org contract, and break `tests/helpers/setup.bash`'s `export NO_COLOR=1` parity harness. A regression leg asserts that after driving a real tmux spawn with `NO_COLOR=1` set, `process.env.NO_COLOR` is still `"1"` and `defaultPalette({ isTty: true })` still returns the empty palette.

### D6 — The scrub is scoped to tmux, not applied inside `mergeEnv` by default

Doing it in `mergeEnv` unconditionally would have been one line and would have changed the environment of every `git`, `sudo`, `mkdir`, `tee`, `rsync` and nested `atmux` child atmux spawns — colourising output that the parity and unit suites assert the plain shape of. The seam is generic; the policy is tmux's.

## Retraction

ADR-277 §D1's sentence — *"Because atmux passes `-f <this file>` on every invocation (ADR-162), this covers every cage, however it was launched"* — **is retracted.** It is false for the two reasons in §Context, and the 2026-08-28 measurement shows both firing in production. ADR-277's directive, its `-r`-verb reasoning, its D2 override ordering, its D3 repair-in-place procedure and its D4 deployment reasoning all stand; only the coverage claim falls. Per the append-only ADR rule the file is not rewritten — it gains a pointer line to this ADR.

## Consequences

- A tmux server **atmux starts** cannot inherit `NO_COLOR`, regardless of `-f`, of `ATMUX_TMUX_CONF`, of which deployed template version is `current`, and of whether the creating command was a `new-session`, an `attach`, or a read-only probe. A server started by anything **other** than atmux is outside this seam entirely (§Measured evidence, `hx`); layer 2 and the in-place repair remain the only tools there.
- `SpawnOpts` grows one optional field. Every existing caller is unaffected — absent `unsetEnv` means `mergeEnv` behaves exactly as before, which its unit tests still assert.
- Servers **already running** are unaffected: a tmux server freezes its environ once. The ADR-277 §D3 in-place repair (`tmux -S <sock> set-environment -gr NO_COLOR`) remains the tool for those, and remains preferable to a restart, which would destroy live agent context.
- `atmux vox --supervise` starting a fresh server on the default socket now hands it a scrubbed environment where before it handed it the operator's. Named here rather than left as a surprise, because that socket is the operator's daily driver in the common case — an already-running server is untouched, only a newly-started one differs.
- **`atmux attach` no longer changes what the operator's terminal advertises.** The first revision passed `COLORTERM=truecolor` to the attach client, which made tmux report `RGB` in `#{client_termfeatures}` and stop downconverting — on a terminal that had said nothing of the sort. Withdrawn per §D2. The attach path still carries the `NO_COLOR` deletion, because an attach against a dead socket is a server-creating command; that deletion has no client-side rendering effect, which is exactly the asymmetry that decided the two cases differently.
- ~~**Nothing in this change writes to a tmux conf.** `~/.tmux.conf` and `templates/tmux/atmux.conf` keep their `COLORTERM truecolor` lines untouched and deliberately.~~ **CORRECTED 2026-08-28 ([ADR-283](283-scrub-the-test-runner-environment.md) §C1)** — `templates/tmux/atmux.conf` had no such line to keep, so this bullet described a compensating control that did not exist in anything atmux ships. It does now: the line was added, after the ADR-277 scrub and above the ADR-171 `source-file`. What stands unchanged: server-level `COLORTERM` is fine, only atmux's process-level injection is withdrawn, and the operator's own conf still loads last and still wins.
- Guarded by `tests/regression/atmux-conf-no-color-scrub.test.ts`, which gains a leg that starts a server **through atmux's own tmux namespace, with `NO_COLOR=1` in `process.env` and no `-f`** — the shape the conf-only guard structurally could not test, since every pre-existing leg passed `-f CONF_PATH` and so could only ever prove the conf was correct, never that it arrived. Its control leg starts a server the same way via raw tmux and asserts the pane **is** poisoned, so a green result cannot come from the probe never exercising the mechanism.

## Out of scope

- **`TMUX` is not unset.** It would be a tempting rider — an inherited `$TMUX` overrides `-S` per tmux(1) — but socket-routing and nesting-refusal semantics are load-bearing fleet-wide and changing them is a separate decision with its own blast radius. The load-bearing isolation remains the explicit `-S`/`-L` flag.
- **`CLAUDECODE`, `CLAUDE_CODE_*` and the rest of ADR-277 §Out of scope** stay out of scope for the same reason they were: scrubbing tool-detection variables could change how tools inside a cage behave.
- **`sudo` paths beyond the argv prefix.** Tier-3+ cage creation is currently unreachable (`createFallbackCage` throws `FallbackTierDroppedError` for any tier ≠ 2), but `poke.ts`'s sudo branch is live for Tier-3 handles. Both carry `TMUX_CHILD_ENV_ARGV`; nothing else about sudo's environment handling is addressed here.

## Revision 2026-08-28 (same day)

Three adversarial reviews of the first revision landed the same day it did. Their findings are folded in above rather than kept as a diff, because the ADR had **not** been legitimately accepted and was therefore still editable in band.

1. **Status demoted `accepted` → `proposed`.** It was marked `accepted` by the implementing agent, in the same commit as its own code. `/CLAUDE.md` §"Binding discipline" #4 permits `proposed → accepted` only via reviewer signoff or a driver/lead `decisions-add`; a self-acceptance is neither. Recorded rather than quietly corrected, because "who accepted this" is the whole value of the field.
2. **`TMUX_CHILD_ENV` withdrawn** — §D2, with the measurements that decided it.
3. **The `hx` / `list-keys` evidence rescoped** — §Measured evidence. It was cited among the cases the fix covers; it is not one, and `list-keys` appears nowhere in atmux's source.
4. **The regression suite's vacuous `COLORTERM` assertion deleted**, not repaired. `expect(env).toMatch(/^COLORTERM=truecolor$/m)` could not fail: tmux sets that value in every pane itself, so the assertion held with or without atmux's policy, and it survived the mutation that emptied `TMUX_CHILD_ENV`. An assertion that cannot fail is a lie about coverage (`/CLAUDE.md` §Engineering, "NO LIES").
5. **The suite's environment probes were narrowed to an allowlist** and the class made unrepresentable — [ADR-282](282-never-collect-the-whole-environment-in-a-test.md).

One reviewer note needed no code change: an implementation summary described the ADR-093 renumber offset as `+94`. It is **+93** for the ADRs this ADR cites (`adr-bun/007 → adr/100`, `adr-bun/004 → adr/097`); `+94` holds only for `adr-bun/001 → adr/095`, the one entry the collision resolution shifted. Verified 2026-08-28 that no committed comment, doc or ADR carries the wrong figure — the error was confined to a session summary.
