# ADR-010: CLI dispatcher choice

**Status:** accepted
**Date:** 2026-05-04
**Owner:** architect

## Context

`bin/atmux` (bash) is a 47-line case-statement dispatcher: it parses `$1`, maps to `lib/<verb>.sh`, sources it, and invokes `main "$@"`. There is alias routing (`broadcast` → `send.sh --broadcast`, `task` → `kanban.sh`, `claim`/`done` → `claim.sh --<verb>`), a help banner, a version flag, and a first-run wizard nudge. That's the entire CLI scaffolding.

The TS port needs the equivalent in `src/cli.ts`, with these additional pressures:

1. **Alias routing.** 7 aliases: `broadcast`, `tell-lead`, `outbox`, `task`, `done`, `rotate-lead`, `resume`. ADR-003 routes them at dispatcher level so each maps to a verb file without duplicating logic.
2. **v2 subcommand structure.** ADR-014 introduces `task <sub>` / `member <sub>` in Phase 6. The dispatcher must accommodate this without a rewrite — i.e. v1 ships with a structure that allows nested commands later without churning the dispatcher core.
3. **`--help` / `--version` / unknown-verb error.** Standard plumbing.
4. **Exit codes.** Per ADR-006 — UsageError → 64, ConfigError → 78, etc. Dispatcher's job to translate.
5. **Default verb.** Bare `atmux` → `up` (one-stop bring-up). Per existing bash behaviour.

The decision is between four broad options:

- `citty` — UnJS framework; native nested commands; small (~30KB).
- `commander` — most popular Node CLI lib; explicit nested-command API.
- `oclif` — Salesforce's framework; full plugin/multi-command surface; heavyweight.
- Hand-roll — match the bash pattern with TS types.

## Decision

**Hand-roll the dispatcher in `src/cli.ts`. ~150–200 LOC. Lazy verb-file imports. Pre-built shape for v2 nested subcommands.**

### Sketch

```ts
// src/cli.ts
import { AtmuxError, UsageError } from "./errors";

type VerbHandler = (args: string[]) => Promise<number>;
type AliasRoute = { verb: string; injectArgs: string[] };

// Alias table — explicit, type-safe.
//
// 7 user-visible aliases route to a different verb file:
//   broadcast    → send.ts (--broadcast)
//   tell-lead    → tell.ts
//   outbox       → reply.ts (--outbox)
//   task         → kanban.ts
//   done         → claim.ts (--done)
//   rotate-lead  → rotate.ts (--lead)
//   resume       → pause.ts (resume)
//
// 2 verbs are listed here as self-aliases for arg-injection symmetry with bash:
//   claim → claim.ts (--claim)
//   pause → pause.ts (pause)
// Bash dispatcher injects `--claim` / `pause` to disambiguate the shared
// implementation file; we preserve the same shape so verb-internal arg parsing
// matches bash 1:1 during cutover.
const ALIASES: Record<string, AliasRoute> = {
  "broadcast":   { verb: "send",   injectArgs: ["--broadcast"] },
  "tell-lead":   { verb: "tell",   injectArgs: [] },
  "outbox":      { verb: "reply",  injectArgs: ["--outbox"] },
  "task":        { verb: "kanban", injectArgs: [] },
  "done":        { verb: "claim",  injectArgs: ["--done"] },
  "claim":       { verb: "claim",  injectArgs: ["--claim"] },
  "rotate-lead": { verb: "rotate", injectArgs: ["--lead"] },
  "resume":      { verb: "pause",  injectArgs: ["resume"] },
  "pause":       { verb: "pause",  injectArgs: ["pause"] },
};

// Verbs (canonical file names under src/verbs/<verb>.ts).
const VERBS = new Set<string>([
  "up", "init", "start", "stop", "attach", "status",
  "send", "tell", "reply", "kanban", "dispatch", "inbox", "claim",
  "report", "whip", "cost", "rotate", "handoff", "pause",
  "add-member", "reconfigure", "dashboard", "doctor",
]);

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length === 0) argv = ["up"];
    const [first, ...rest] = argv;

    // Built-in flags / subcommands.
    if (first === "--version" || first === "version" || first === "-V") {
      console.log(await readVersion());
      return 0;
    }
    if (first === "--help" || first === "help" || first === "-h") {
      console.log(usage());
      return 0;
    }

    // Alias routing.
    const aliased = ALIASES[first];
    const verb = aliased?.verb ?? first;
    const args = aliased ? [...aliased.injectArgs, ...rest] : rest;

    if (!VERBS.has(verb)) {
      throw new UsageError({
        what: `unknown verb: ${first}`,
        hint: "run `atmux help` for the list of verbs",
      });
    }

    // Lazy import — only the verb you ran is loaded.
    const handler = await loadVerb(verb);
    return await handler(args);
  } catch (err) {
    return reportError(err);
  }
}

async function loadVerb(verb: string): Promise<VerbHandler> {
  const mod = await import(`./verbs/${verb}.ts`);
  return mod.default as VerbHandler;
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(code => process.exit(code));
}
```

(`reportError` is the implementation from ADR-006.)

### Why hand-roll wins

Five factors make hand-roll the right call here:

1. **Verb set is small + closed.** 23 verb files + 7 aliases + 2 built-ins (`help`, `version`). The whole dispatch table fits in one screen. Frameworks add a layer for problems we don't have (loading commands from npm packages, plugin registries, dynamic command discovery).
2. **The bash dispatcher is already this shape.** The 47-line case statement is the spec; we're translating it to TS with the same semantics. Adding citty/commander would translate it through a framework layer that doesn't earn its weight.
3. **Lazy verb imports are critical for cold start.** ADR-001 cites Bun cold-start ~25ms. Dynamic `import("./verbs/${verb}.ts")` ensures only the verb you ran is loaded — `whip` doesn't pay for `dashboard`'s code. Frameworks vary on this; citty is good, commander+oclif eagerly require everything.
4. **v2 nested subcommand support is straightforward.** When ADR-014 lands `task <sub>`, the dispatcher path becomes:

   ```ts
   if (verb === "kanban") {
     // v2: legacy `task add` → src/verbs/task/add.ts
     return loadSubVerb("task", args[0])(args.slice(1));
   }
   ```

   That's ~10 LOC of incremental dispatcher logic. citty offers nested commands as a feature, but our shape is structured enough that we don't need framework support.
5. **Reviewer reads the dispatcher, no abstraction.** Stack traces from a verb point to `src/cli.ts:NN` directly. No "look in citty for the routing" lookup.

### `--help` content

```ts
function usage(): string {
  return `atmux — agent teams multiplexer.

Usage: atmux <verb> [args]
       atmux                        One-stop: wizard (if new) → doctor → start → attach

Setup:
  up                          Same as bare \`atmux\`: bring a team all the way up
  init [--name <team>]        Scaffold .atmux/team.json in current dir
  start                       Create tmux session, spawn all members
  stop [--force]              Kill tmux session, archive state
  attach                      tmux attach to the team session
  status                      Powerline team overview
  ...
`;
}
```

The full text mirrors `bin/atmux`'s usage output verbatim — bash and TS print byte-identical help so the parity harness validates `atmux help` output trivially.

### `--version`

`readVersion()` reads `package.json` via `Bun.file` + JSON.parse-via-schema (per ADR-005; package.json gets its own minimal schema). Output format matches bash: `atmux v0.4.0` (no leading `atmux`, no SHA).

### Unknown-verb error

```
$ atmux-bun foo
atmux: usage: unknown verb: foo
       hint: run `atmux help` for the list of verbs
```

Exit code 64 (EX_USAGE) per ADR-006.

### First-run wizard nudge (deferred)

Bash atmux nudges the user into a wizard if `team.json` doesn't exist and the verb isn't `init`/`up`/`doctor`/`wizard`. The TS port preserves this in the dispatcher:

```ts
const NUDGE_EXCLUDED = new Set(["init", "up", "doctor", "help", "version"]);
if (!NUDGE_EXCLUDED.has(verb) && !process.env.ATMUX_TEAM) {
  await maybeOfferWizard();    // src/core/common.ts — non-fatal; user-facing prompt
}
```

The nudge function lives in `src/core/common.ts` (it touches `team.json` and `.atmux/` discovery). Dispatcher just calls it.

### v2 nested subcommands — preserved migration path

ADR-014's v2 redesign restructures verbs:
- `task add` / `task list` / `task claim` / `task done` (collapses `claim` and `done` top-level verbs)
- `member add` / `member rm` / `member rename` / `member pause` / `member resume`

When v2 lands, the dispatcher gets one new helper:

```ts
const SUBCOMMAND_VERBS = new Set(["task", "member"]);

if (SUBCOMMAND_VERBS.has(verb)) {
  const sub = args[0];
  if (!sub) throw new UsageError({ what: `${verb} requires a subcommand`, hint: `try \`atmux ${verb} --help\`` });
  const handler = await import(`./verbs/${verb}/${sub}.ts`);
  return handler.default(args.slice(1));
}
```

The flat-file convention (`src/verbs/whip.ts`) and folder-with-subs convention (`src/verbs/task/add.ts`) coexist. v1 ships flat-only; v2 adds folders without touching v1 verbs. Deprecation aliases for old top-level `claim`/`done` route to the new subcommands during the deprecation window.

## Consequences

**Positives:**

- Zero npm deps for CLI scaffolding; supply-chain surface stays minimal.
- Lazy verb imports preserve Bun's cold-start advantage. `atmux whip` doesn't load doctor's deps.
- Stack traces are local to the project; no framework misdirection.
- Help text byte-equal to bash version → parity harness validates `atmux help` trivially.
- v2 subcommand migration is ~10 LOC additive; no rewrite.
- Alias table is data, not control flow; reading it is a glance.

**Negatives:**

- Hand-rolled means we own argument parsing in each verb. Verbs that need structured flag parsing (e.g. `add-member` with `--role`/`--tui`/`--model`/`--cwd`/`--command`) need their own parser. Mitigated by a small `src/core/flags.ts` helper (foundation porter writes it as part of `core/common.ts` or splits into a sibling module).
- `--help` text is hardcoded; adding a verb means editing the help text in cli.ts. Mitigated by lint check that asserts every verb in `VERBS` set appears in usage text.
- No framework-provided shell completion. Bash atmux ships completions in `completions/`; TS port keeps shipping the same bash completion file (it's about verb names, not argv parsing).

**Follow-up tickets:**

- Foundation porter: implement `src/cli.ts` per the sketch + `src/core/flags.ts` for verb flag parsing.
- Foundation porter: write the help-text-coverage lint (`every verb in VERBS appears in usage()`).
- ADR-014 (Phase 6): add `SUBCOMMAND_VERBS` set + `loadSubVerb` helper. Confirm migration path holds.
- Reviewer: verify `bun build --compile` correctly bundles all `verbs/*.ts` despite dynamic import (Bun's bundler resolves `./verbs/${verb}.ts` patterns for `--compile` if the directory is present at build time; smoke-test in CI).

## Alternatives considered

### A. citty (UnJS)

Considered seriously. Pros:
- Native nested-command support (clean for v2).
- Small (~30KB).
- TypeScript-first.
- Auto-generates `--help` from command definitions.

Cons:
- Adds a runtime dep + transitive deps. Goes against the supply-chain-tight stance.
- Auto-generated help differs from bash's hand-written format → parity harness `atmux help` byte-diff would need fuzzy match instead of exact.
- Lazy command loading is a citty pattern but it's manual (`defineCommand({ run: () => import('./...').then(m => m.default()) })`); not magically zero-cost.
- We'd be learning citty's conventions for something the bash case statement made trivial. Net negative.

The case for citty is "nested subcommands for free" but we don't have nested subcommands until v2, and even there our handler shape (`run(args: string[])`) is one line.

### B. commander

Pros:
- Most popular Node CLI lib; reviewers familiar with it.
- Mature; well-documented.

Cons:
- Eager command loading (every `program.command(...)` requires the handler upfront). Negates lazy-import cold-start benefit.
- API style mismatches our `run(args: string[]): Promise<number>` shape — commander wants action-bound functions with parsed-options arg, which is a different verb contract.
- Heavier than citty.

### C. oclif

Rejected without deep evaluation. oclif is for multi-binary tooling (Salesforce CLI, Heroku CLI). atmux is one binary with 23 verbs. Massive overkill.

### D. Hand-roll but with a registry that auto-discovers `src/verbs/*.ts` at startup

Considered. Removes the hardcoded `VERBS` set. Rejected because:
- File-system-driven verb discovery means `bun build --compile` needs to know to bundle every verb. `--compile`'s static analysis is more reliable when imports are explicit.
- Bash atmux discovery is "if `lib/<verb>.sh` exists, route to it". That's filesystem-driven and the fragility is documented; we can do better with a typed manifest.
- The hardcoded set is 23 lines that change once or twice per major version. Trivial to maintain.

### E. Generate dispatcher from a manifest YAML/TOML

Rejected. Code-gen for ~150 LOC is a process tax. The hand-rolled file IS the manifest in TS form.

### F. Use `Bun.argv` directly with a switch statement (literal port of bash case)

This is essentially what we're doing. The "alternative" is to add a `commander`/`citty` layer for no benefit. ADR-010's decision is to keep the bash shape.

## References

- PLAN.md §2 (verb list at frozen scope), §10 (CLI framework TBD note)
- ADR-001 (cold-start budget — lazy imports matter)
- ADR-002 (project layout — `src/cli.ts` + `bin/atmux-bun` shim)
- ADR-003 (module taxonomy — `cli.ts` is the only module that may dynamic-import)
- ADR-006 (error handling — UsageError, exit codes)
- ADR-014 (v2 verb redesign — preserves the dispatcher, adds nested-subcommand handling)
- bash `bin/atmux` — case statement reference being matched
- citty: https://github.com/unjs/citty
- commander: https://github.com/tj/commander.js
- oclif: https://oclif.io
