# ADR-118: `SendTarget` discriminated union — type-system enforcement of "no send-keys to driver pane"

**Status:** accepted
**Date:** 2026-05-05
**Owner:** driver

## Context

CLAUDE.md pins a hard rule: **agent → teammate or lead pane is OK; agent → driver pane is banned, no exceptions.** The driver pane is the human REPL (George's interactive Claude Code session); send-keys into it overwrites whatever the human is typing — at best a UX glitch, at worst a destructive accidental keystroke into a sensitive prompt.

The rule is currently enforced by:

1. Operator memory (saved as `feedback_no_send_keys_to_driver.md`).
2. Reviewer-grep at commit time.
3. Author discipline — every `tmux.pane.sendKeys` / `tmux.buffer.pasteBuffer` callsite must voluntarily pick a non-driver target.

Historically violated. The TS port currently has 6 callsites across 3 files (`src/verbs/rotate.ts`, `src/core/send.ts`, `src/verbs/stop.ts`). Each passes `target: <tmuxString>` — a bare string with no semantic guard. A new caller could trivially pass `${sessionName}:driver` (or any other driver-window naming convention a future operator adopts) and only be caught at review or in production.

The bash side has the same problem — `lib/send.sh`, `lib/rotate.sh`, `lib/stop.sh` all build target strings ad-hoc with no safety net. Bash can't fix this without a static analyzer; TypeScript can, with a discriminated union.

This ADR pins the contract before Phase 4 cutover. Once `atmux-bun` ships as v1, downstream user code (skills, plugins, future verbs) inherits the rule. Type-system enforcement at the abstraction boundary makes the rule load-bearing rather than aspirational.

## Decision

### 1. New type: `SendTarget` (discriminated union)

Defined and exported from `src/abstractions/tmux.ts`:

```ts
export type SendTarget =
  | { kind: "member"; member: string; team: string; target: Target }
  | { kind: "lead"; team: string; target: Target };
```

`Target` is the existing tmux target type (`PaneId | WindowId | string`) — unchanged. The discriminated union wraps it with a `kind` discriminator + audit metadata.

**`"driver"` is intentionally absent.** A caller attempting to construct `{ kind: "driver", ... }` triggers a compile error: `kind: "driver"` is not assignable to `kind: "member" | "lead"`. The compiler's structural narrowing catches it at the source — no runtime check, no reviewer-grep, no production surprise.

### 2. Signature change: `sendKeys` + `pasteBuffer`

```diff
- sendKeys(opts: { target: Target; keys: string; literal?: boolean; enter?: boolean }): Promise<void>;
+ sendKeys(opts: { target: SendTarget; keys: string; literal?: boolean; enter?: boolean }): Promise<void>;

- pasteBuffer(opts: { name?: string; target: Target; deleteAfter?: boolean }): Promise<void>;
+ pasteBuffer(opts: { name?: string; target: SendTarget; deleteAfter?: boolean }): Promise<void>;
```

Internally, both methods serialize `target.target` via the existing `serializeTarget(...)` helper — argv construction stays identical. The kind + member + team fields are inert to the tmux command line; they exist solely to force the caller to declare intent.

### 3. Surgical scope — exactly two methods affected

`sendKeys` and `pasteBuffer` are the only methods that **inject input** into a pane (the rule's surface area). Read-only methods stay untouched:

- `capturePane`, `displayMessage`, `listPanes`, `splitWindow`, `killPane` — keep `target: Target`. These are observe / structural ops; reading from a driver pane is fine.
- `loadBuffer` — has no `target` arg (loads the *server-side* buffer, then `pasteBuffer` injects).
- All `window.*`, `session.*`, `client.*`, `option.*`, `server.*`, `buffer.deleteBuffer` — unchanged.

This minimises the diff surface and keeps `Target` itself stable for ~25 unaffected callsites.

### 4. Caller migration — 3 files

| File | Lines | Caller intent |
|---|---|---|
| `src/verbs/rotate.ts` | 217, 238, 244 | rotates a single member or lead pane — `kind: "member"` (or `"lead"` when role is `team-lead`) |
| `src/core/send.ts` | 147, 164 | sends a message to one member's pane — `kind: "member"` always (driver-targeted send is `tell-lead`, which routes through the `lead` pane, not driver) |
| `src/verbs/stop.ts` | 163 | iterates the team roster cancelling each member — `kind: "member"` (the `team-lead` role member also gets `C-c` here, modeled as `kind: "lead"` for clarity) |

Each callsite gains an explicit `kind` declaration. The `member` and `team` audit fields come from existing context (`team.name` is in scope at every callsite; `member.name` is the current iteration variable).

### 5. Test pattern — `// @ts-expect-error driver kind banned`

`tests/unit/abstractions/tmux.test.ts` gains a compile-time check:

```ts
test("SendTarget — driver kind is type-system banned (compile-time check)", () => {
  // @ts-expect-error — driver kind is intentionally absent from SendTarget
  const _badConstruct: SendTarget = {
    kind: "driver",
    team: "any",
    target: "session:0",
  };
});
```

If anyone widens `SendTarget` to admit `"driver"`, the `// @ts-expect-error` directive *itself* becomes an error (TS2578: "Unused '@ts-expect-error' directive") because the line below it compiles cleanly — and tsc fails the build. The directive is the gate.

### 6. Interaction with future cage / super-driver topology

ADR-119 cage variants and super-driver ADRs (045/046) are likely to add new pane kinds (e.g. `cockpit-viewer`, `cage-attach`, `super-driver-relay`). The migration path is:

1. **Add the new kind** to `SendTarget`'s union (`| { kind: "cockpit-viewer"; ... }`).
2. **Update existing exhaustive switches** if any caller switches on `kind` — TS exhaustiveness check catches missing cases.
3. **`"driver"` stays absent.** No matter how many new pane kinds the topology adds, the human REPL is still inviolable.

The discriminated union pattern is forward-compatible by construction; new kinds are additive.

### 7. NOT in scope

- **Caller refactor (R-6).** This ADR designs the contract; the refactor that updates `sendKeys` / `pasteBuffer` signatures + the 3 callers + tests lands in a separate `refactor(abstractions): tmux sendKeys + pasteBuffer accept SendTarget (R-6, ADR-118)` commit.
- **tmux argv construction.** `serializeTarget` is unchanged. The argv string built for every `tmux send-keys -t ...` is byte-identical to today.
- **Other tmux methods.** `Target` stays the input type for `capturePane`, `displayMessage`, `listPanes`, `splitWindow`, `killPane`, etc. — they're read / structural ops, not input-injection.
- **Bash side.** Bash atmux can't enforce this at the language level. Reviewer-grep stays the bash-side gate; the rule's text already lives in `feedback_no_send_keys_to_driver.md`.
- **Runtime check.** No `if (target.kind === "driver") throw` defensive runtime branch. The compile-time check is sufficient *and* unbypassable; a runtime check would be redundant on the happy path and miss nothing the compiler doesn't already catch.
- **Driver-pane SENDS via the `tell-lead` flow.** `tell-lead` writes a file (`~/.claude/teams/<team>/driver-inbox.md`) — no tmux send-keys; the lead reads the file. Driver pane is never an injection target. The discriminated union preserves this invariant by design.

## Migration plan (this ADR's commit chain)

1. **Commit A — `docs(adr,plan): ADR-118 — SendTarget discriminated union (R-6 design)`**: this ADR file + PLAN.md §7 backlog row + PLAN.md §6.2 R-6 row marker.
2. **Commit B — `refactor(abstractions): tmux sendKeys + pasteBuffer accept SendTarget (R-6, ADR-118)`**: type definition added to `src/abstractions/tmux.ts`, signature change on `sendKeys` + `pasteBuffer`, 3 callers updated, existing tests updated to construct `SendTarget` instead of bare `Target`, new `// @ts-expect-error` block added to `tests/unit/abstractions/tmux.test.ts`. Status flip on R-6 in §6.2.

Each commit standalone-passes typecheck + 100% coverage gate. Commit B is mechanical (signature change forces caller updates; tests update mechanically).

## Out of plan / future work

- **More pane kinds when topology lands.** ADR-119 cage and super-driver variants will widen `SendTarget`'s union — additive, no contract break.
- **Subscriber widget / dashboard read panes.** If a future verb gains a "watch a member's pane and stream its content elsewhere" capability, that's a `capturePane` (read) consumer, not a `sendKeys` consumer — `Target` is the right type. Don't widen `SendTarget` unless we actually need to inject.
- **Bash-side enforcement.** If the bash port grows a static analyzer step (shellcheck plugin, ad-hoc grep in CI), the rule could be enforced there too. Not a priority; bash's days are numbered post-cutover.

## Consequences

- **One rule, three layers.** Operator memory (intent) + reviewer-grep (review-time) + type system (compile-time). The type system is the strongest gate; the others stay as defense-in-depth.
- **No public-API churn for callers that already do the right thing.** They were passing `target: <tmuxString>`; they now pass `target: { kind: "member", member, team, target: <tmuxString> }`. ~6 LOC delta across 3 files.
- **Forward-compatible.** Future pane-kind additions are additive; the "driver" exclusion is structural and survives.
- **R-6 unblocks.** The refactor commit can land immediately after this ADR — a small, mechanical follow-up.
- **v1 ships with the rule load-bearing.** Downstream consumers of `atmux-bun`'s tmux abstraction (skills, plugins, future verbs) get the rule for free at compile time.
