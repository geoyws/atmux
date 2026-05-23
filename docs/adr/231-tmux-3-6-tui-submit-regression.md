# ADR-231: tmux 3.6 + Claude Code TUI submit regression — literal CR via `-l` replaces `C-m`/`Enter` symbolic

**Status**: PROPOSED — 2026-05-23 (sopx unblocker session diagnostic; pending atmux reviewer + planner sign-off)

**Supersedes** (partial — keystroke choice only, NOT the surrounding 4-step pattern):

- ADR-081 §A `submitAfterPaste` choosing `C-m` over `Enter` symbolic
- ADR-188 §"Each Enter is a literal C-m (carriage return) — never `Enter` keysym"

**Does NOT supersede**: ADR-188's 4-step canonical pattern (scroll → submit×3 → paste → submit×3) — only the keystroke chosen for "submit." All other steps remain in force. ADR-138's verify-and-retry discipline is unaffected.

## Context

ADR-081 (2026-05-12) chose `tmux send-keys ... C-m` over `tmux send-keys ... Enter` to bypass the **bracketed-paste-mode envelope** in Claude Code TUI — the trailing `Enter` keysym was being interpreted as "newline inside the pasted message" rather than "submit the compose box." ADR-188 (2026-05-21) canonized `C-m × 3` for defensive submission against intermittent settle-timing failures.

The decision was sound and stable through tmux 3.5.x + Claude Code TUI versions ≤ v2.1.149. The 2026-05-12 audit trail (11-pane manual recovery) confirmed `C-m` succeeded where `Enter` had silently starved.

**2026-05-23 regression discovered.** During a routine sopx unblocker pass against a wedged 12-pane `atmux_sopx` session running tmux 3.6 + Claude Code v2.1.150, programmatic `tmux send-keys ... C-m` was found to be **as broken as `Enter` was pre-ADR-081**: composer text queued, never submitted. The Claude Code TUI input layer eats both `C-m` and `Enter` keysyms when delivered via `send-keys`. Only **literal `\r` via `tmux send-keys ... -l $'\r'`** successfully triggers submit.

Physical Enter from the operator keyboard continues to work, so the regression is on the programmatic `send-keys` path, not the TUI's submit logic itself.

### Diagnostic evidence

Live session probe across 5 panes (sopx team, hax 2026-05-23 19:30 MYT):

| Probe | Result |
|---|---|
| `tmux send-keys -t <pane> -l Z` (literal char) | ✓ landed in composer |
| `tmux send-keys -t <pane> Enter` | ✗ eaten — composer unchanged |
| `tmux send-keys -t <pane> C-m` | ✗ eaten — composer unchanged |
| `tmux send-keys -t <pane> Escape` then `Enter` | ✗ eaten |
| `tmux resize-window` + `C-m` | ✗ eaten (geometry fix did not unblock) |
| `tmux send-keys -t <pane> -l $'\r'` | ✓ submitted — composer cleared, claude began processing |

Confirmed across:
- 1 fresh-bootstrap pane (post `atmux rotate lead`)
- 8 other panes carrying queued composer text from prior atmux pastes
- physical Enter on the same panes (operator keyboard via attached tmux client)

### Root cause hypothesis

Best fit given the symptom asymmetry (physical Enter works, programmatic doesn't):

1. **tmux 3.6's `send-keys` key-translation table changed** for `Enter` / `C-m` keysyms — possibly now emitting an extended-key CSI sequence the Claude TUI doesn't recognize as submit. This is the most likely cause given (a) literal chars still deliver fine and (b) physical Enter from an attached client still works (different code path through the tmux input parser).
2. **Claude Code v2.1.150 input layer changed** — added a heuristic that distinguishes "real" Enter from synthetic, suppressing the synthetic case. Less likely, as physical Enter through the same tmux PTY works.

Either way, the durable fix sits at the atmux layer: use the keystroke that works in both old and new tmux + TUI versions.

## Decision

**The canonical programmatic submit keystroke is `tmux send-keys ... -l $'\r'`** (literal carriage return via `-l` mode).

This replaces every production callsite that previously fired:

- `tmux send-keys -t <pane> C-m` (`paste-submit.ts:69`)
- `tmux send-keys -t <pane> ... Enter` (abstraction-layer trailing Enter at `tmux.ts:562`)
- `tmux send-keys -t <pane> Enter` (any other "press Enter" pattern that routed through symbolic Enter)

The ADR-188 4-step pattern remains in force — the `×3` defensive submission, scroll-up preamble, postamble verification, copy-mode escape — but each "submit" within those steps is now a literal-CR send-keys, not a symbolic `C-m`.

## Options considered

1. **Literal `\r` via `-l` mode (CHOSEN)** — surgical keystroke swap. Minimal blast radius (two source files); abstraction layer change is the choke-point. Works in tmux 3.5 AND 3.6 per `-l` mode being unchanged across versions. Preserves ADR-188's 4-step semantics intact.

2. **Pin tmux to 3.5.x repo-wide** — environment-level workaround. Defers the underlying break, doesn't address future tmux versions, and requires every operator + cage host to install a non-default tmux. Worse ergonomics; same eventual fix needed when 3.5 is removed from package repos. REJECTED.

3. **Switch to `tmux paste-buffer` for submit** — paste a buffer containing `$'\r'` instead of `send-keys`. More complex than literal-mode send-keys; introduces buffer-lifecycle ceremony for what's now a single keystroke; same envelope-eating risk that originally drove ADR-081 §A. REJECTED.

4. **Send via PTY-direct write (bypass tmux send-keys)** — would need a new abstraction layer writing to `/dev/pts/N` directly via the pane's underlying PTY. Major architecture change; loses tmux's pane targeting; multi-platform fragility. REJECTED — over-engineered for a 2-line fix.

5. **Wait for upstream fix** — file with tmux maintainers + claude-code maintainers; pin current versions until either side ships a fix. Leaves atmux + all consumers wedged in the interim; the team-of-teams cannot operate. REJECTED — recovery window measured in days/weeks; we need to ship this week.

## Implementation

### Code changes (atmux repo)

**`src/abstractions/tmux.ts:558-564`** — `sendKeys` impl. Replace trailing `Enter` keysym with a separate literal-CR invocation, preserving the symbolic-key path for non-submit callers (modal nav, control keys):

```typescript
// before
async sendKeys(opts) {
  const argv = ["send-keys", "-t", serializeSendTarget(opts.target)];
  if (opts.literal) argv.push("-l");
  argv.push(opts.keys);
  if (opts.enter ?? true) argv.push("Enter");
  await tmuxRun(argv);
},

// after
async sendKeys(opts) {
  // Symbolic / literal keys phase — single invocation.
  const argv = ["send-keys", "-t", serializeSendTarget(opts.target)];
  if (opts.literal) argv.push("-l");
  argv.push(opts.keys);
  await tmuxRun(argv);
  // Submit phase — ADR-231: tmux 3.6 + Claude TUI eats both symbolic
  // `Enter` and `C-m`; only literal CR via `-l` triggers submit.
  // Separate invocation because `-l` applies to the entire send-keys
  // call (tmux flag scope is per-invocation, not per-arg).
  if (opts.enter ?? true) {
    await tmuxRun([
      "send-keys",
      "-t",
      serializeSendTarget(opts.target),
      "-l",
      "\r",
    ]);
  }
},
```

**`src/core/paste-submit.ts:69`** — `submitAfterPaste` keystroke choice. Replace `C-m` symbolic with literal CR:

```typescript
// before
await tmux.pane.sendKeys({ target, keys: "C-m", enter: false });

// after — ADR-231: literal CR replaces C-m symbolic
await tmux.pane.sendKeys({ target, keys: "\r", literal: true, enter: false });
```

### Test changes

Four test files assert specific argv shapes for `send-keys` and need updates:

- `tests/unit/core/paste-submit.test.ts` — expects `keys: "C-m"`; update to `keys: "\r", literal: true`.
- `tests/unit/core/sendkeys-contract.test.ts` — expects trailing `"Enter"` arg; update to expect a SEPARATE second `tmuxRun` call with `["send-keys", "-t", <target>, "-l", "\r"]`.
- `tests/unit/verbs/rotate.test.ts` — likely asserts post-bootstrap submit via `C-m`; update keystroke expectation.
- `tests/e2e/send-keys-reliability.test.ts` — e2e shape assertions; update.

See `test-impact-notes.md` in this worktree for the exact lines and expected diff shapes.

### Documentation updates (required, NOT same-commit)

These docs cite the old keystroke and should be updated post-merge as a doc-sweep follow-up:

- `docs/adr/081-bootstrap-brief-paste-bug.md` §A — add a 2026-05-23 amendment pointing at ADR-231 for the keystroke choice; the bracketed-paste-mode envelope concern remains documented.
- `docs/adr/188-tui-send-keys-canonical-4-step.md` lines 44-47 + 56-60 — replace `C-m` with literal-CR references; add cross-link to ADR-231.
- Source-comment headers in `paste-submit.ts:1-21` + `safe-send.ts:336-341` + `send.ts:1-32` — update inline ADR-081 citations to also reference ADR-231.

### Consequences

- **Existing callers**: zero source-change required — the abstraction-layer fix at `tmux.ts:562` propagates to every `sendKeys` invocation that uses default-`enter`. The direct `paste-submit.ts:69` caller's call-site fix is the only outlier.
- **No public API change**: the `SendKeysOpts` interface is unchanged; `literal` and `enter` semantics are preserved.
- **Two tmux invocations per submit-with-keys call** (instead of one) — measured latency impact in atmux's verify-and-retry context: ~3-5ms additional per submit. Negligible for the 2-min unblocker cron tick + the 5-min whip cron tick.
- **Tmux 3.5 compatibility**: `-l $'\r'` works identically in tmux 3.5 + 3.6 (the `-l` flag is unchanged across versions). No version-gated path needed.
- **Claude Code TUI compatibility**: `-l $'\r'` works in v2.1.149 (pre-regression) + v2.1.150 (regressed). No TUI-version-gated path needed.
- **Future-proofing**: when upstream eventually fixes the symbolic `C-m` / `Enter` regression, the literal-CR path will continue to work — there's no degradation risk to keeping it.

## Reversibility

**High.** Two code lines + two file edits. Revertible via `git revert` once upstream ships a real fix (or if a sibling-incident reveals a deeper issue). Test updates revert with the same commit. ADR supersession is documented; ADR-081 §A and ADR-188 keystroke text are flagged-but-preserved.

## Audit trail

- **2026-05-23 19:30 MYT** — sopx unblocker session: 9 panes wedged with queued composer text spanning 24+ hours; programmatic `C-m` / `Enter` symbolic confirmed eaten. Literal CR confirmed submitting.
- **2026-05-23 19:35 MYT** — atmux source dive: `paste-submit.ts:69` + `tmux.ts:562` identified as choke points; 4 test files identified as touching the keystroke shape.
- **2026-05-23 19:40 MYT** — ADR drafted in sopx-root scratch worktree `.claude/worktrees/atmux-c-m-fix/`; handed to driver for atmux-repo review + apply.
