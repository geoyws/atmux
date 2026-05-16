# ADR-155: `atmux pane-state` — structured TUI-viewport verb to replace tail-10 heuristics

**Status**: proposed
**Date**: 2026-05-16
**Author**: atmux team (driver-claude-sopx complaint `c-6cd891d1` + sopx-side downstream `c-068eba4d` / `c-a3c3a42d`, /bruh sweep 2026-05-16 00:17 MYT)
**Relates**: [ADR-057] (`src/core/pane-state.ts` internal classifier for `safeSendKeys`), [ADR-138](./138-verified-send-keys.md) (verified send-keys; consumes pane state for verifier policy), [ADR-148](./148-commit-cadence-truth-signal.md) (cadence is canonical truth; pane-state is the proxy), [ADR-077] (medic substrate; consumes pane-state), [ADR-133](./133-medic-rename.md) (medic rename; carries the pane-state read in its observe loop), [ADR-132](./132-pluggable-martinet.md) (martinet observe-loop; primary pane-state consumer), [ADR-151] (unblocker role; uses `runtime_state=dead` signal for reanimation), [ADR-152] (blockers list; joins pane-state with kanban for member-stuck classification), [ADR-154](./154-driver-inbox-lead-outbox-sqlite-migration.md) (sibling /bruh sweep draft).
**Kanban**: closes EPIC `t-232d0d12`; T1-of-N decomposition (this commit drafts only). Closes complaint `c-6cd891d1` (operator-filed verb framing) + downstream sopx-side complaints `c-068eba4d` + `c-a3c3a42d` (Stuck-input false-positive cascade).

## Context

### The tail-10 problem

`/bau` (cockpit Stuck-input verdict), `/bruh` (zombie-reanimation), and ad-hoc lead introspection all reach for the same primitive today: `tmux capture-pane -p -t <window> | tail -N`, then string-match the last N lines for *"is this pane stuck"*, *"is the operator typing"*, *"is this a residue self-nudge that needs Enter"*. The N is usually 10, sometimes 20, occasionally a full scroll-buffer dump. The matchers are bespoke per-consumer.

This worked when the Claude Code TUI was simpler and the residue-class vocabulary was empty. It no longer works:

- **Auto-mode self-nudges look like user-typed input.** Members on auto-mode self-emit `claim next task` / `pull next` / `check status` text into their compose box as part of a turn the agent itself authored. A naïve tail-10 scan sees text-in-composer and reports "operator queued input" — Enter-press then triggers a residue cascade. Observed sopx 2026-05-15: `/bau` reported 14–16 of 19 windows had "stuck input"; manual scan found 0 actually-user-queued.
- **TUI version drift breaks bespoke matchers silently.** Each consumer has its own copy of "the spinner glyph is one of `✻ ✽ ✶`" / "the rate-limit banner reads `You've hit your limit`" / "the compaction banner reads `Compacting conversation`". When the TUI bumps a glyph (`✻ Cooked → ✻ Working`), every consumer that didn't update independently regresses.
- **No structural composer / status-bar boundary.** The composer (the box at the bottom where text lives) and the conversation transcript (everything above) have a stable separator line in the TUI viewport. tail-10 doesn't know about that separator — it reads the last 10 *lines* regardless of which region they came from. A spinner glyph in the transcript reads identical to a spinner glyph in the composer for purposes of "is this pane currently working", which is wrong.
- **No dead-pane signal.** A Claude process can be killed (OOM, manual `kill -9`, parent-shell exit during compaction), leaving the tmux pane attached to a defunct PID. tail-10 sees the last frame the TUI rendered before death — sometimes a perfectly valid-looking prompt — and reports "ready". Reanimation never fires; the member sits dead for hours until a cadence-gap surfaces it.
- **No `welcome-screen` signal.** Fresh-spawned panes briefly show the `Welcome to Claude Code` banner before the agent boots. tail-10 reads that as "TUI active, ready" and consumers send keystrokes that land in the welcome screen and get lost.

### Why now

Three near-term consumers concretely need the structured surface:

- **ADR-151 unblocker** — its drain-loop reads pane-state for the blocked-task owner's window and decides reanimate (`runtime_state=dead`) vs nudge (`runtime_state=idle` + composer has residue) vs leave-alone (`runtime_state=working`). Without a structured primitive, the unblocker re-implements four bespoke matchers and inherits every existing consumer's drift.
- **ADR-148 §D3 `pane-state` column** — the renamed status column already commits to "process observable, not cadence verdict" framing. Today the column synthesizes its value from `paneCommand` + `cageState` heuristics; the structured verb gives it a sharper read.
- **`/bau` Stuck-input verdict (cockpit)** — the false-positive cascade is the immediate operator-pain trigger; replacing the tail-10 path with `atmux pane-state` calls eliminates the cascade at root.
- **Martinet observe-loop (ADR-132)** — cheap-model-first observer (Cursor composer-2-fast) needs a *structured* pane read to write sentinels reliably. Asking the cheap model to parse free-form TUI output is the failure mode this ADR closes.

If we do the parsing once, in a verb, with a closed-enum return shape, all consumers share the same access path and TUI-version drift becomes a one-place fix.

### Relationship to ADR-057's internal classifier

`src/core/pane-state.ts` already exists (per ADR-057) and serves `safeSendKeys` with an **8-state internal enum** focused on *send-safety*: `READY / TYPING / BUSY / MODAL / RATE-LIMIT / COMPACTING / SHELL / UNKNOWN`. That enum is the right shape for *"is it safe to send keystrokes now?"* — its consumer asks a binary question and the enum's eight states give it eight precise refusals.

The ADR-155 verb has a **different consumer question**: *"what is this pane doing right now, from the observer's perspective?"* — reanimate / nudge / leave-alone / log-as-anomaly. The send-safety enum is too coarse for `dead` (`UNKNOWN` swallows it) and too fine for `working` (TYPING + BUSY collapse into one observer-visible state). The two enums are not redundant; they're sibling projections of the same underlying capture, optimized for different questions.

§D5 documents the projection map (ADR-155 verb → ADR-057 enum) so `safeSendKeys` can continue consuming the verb instead of re-parsing.

## Decision

### (D1) New verb — `atmux pane-state <window> [--json|--table]`

A first-class verb, sibling to `atmux status` / `atmux blockers` / `atmux doctor`. Takes a tmux window target (`<session>:<window>` or just `<window>` resolved against the current session) and emits a structured JSON document (or human-readable table with `--table`) describing the pane's current observable state.

**JSON is the default output** (machines first; per planner-anchor #8 + operator complaint quote "structured atmux pane-state verb"). `--table` is the opt-in human render — useful for ad-hoc operator inspection but not the canonical contract. This inverts the `atmux status` default (table-first) because pane-state's primary consumers are programs (martinet, unblocker, /bau, /bruh, ADR-148 status renderer), not humans.

The verb is **read-only** — it does not move kanban rows, write sentinel files, or send keystrokes. Side-effect-free reads compose freely with retry/cache layers above; no observer ever has to worry about "calling pane-state changed state."

### (D2) Return shape — closed-schema JSON, Zod-validated

```ts
{
  pid: number | null,            // claude process pid; null when no PID resolvable (dead / shell-prompt)
  runtime_state: RuntimeState,   // closed enum, see (D3)
  composer: {
    has_text: boolean,
    text: string | null,         // verbatim composer content; null when has_text=false
    likely_user_typed: boolean,  // defensive default false; see (D6)
    residue_class: ResidueClass | null  // hardcoded denylist match; see (D7)
  },
  last_turn_marker_age_seconds: number | null,  // null when no glyph in scroll window
  mode: ClaudeMode | null        // 'auto' | 'accept-edits' | 'dont-ask' | 'plan' | null
}
```

The shape is fixed at v1; any addition (new enum member, new composer field) requires an ADR-155 annotation header per the project CLAUDE.md ADR append-only convention. This forces consumer-coupling visibility — anyone adding a state must enumerate the four consumers whose dispatch tables now need updating.

### (D3) `runtime_state` — 7-state closed enum

Per planner-anchor #1 — Zod literal-union, expansion is a new ADR (or annotation). The seven states are chosen to span the **observer's decision tree** without giving callers states they can't act on.

| State | Detection | Observer action |
|-------|-----------|-----------------|
| `idle` | Composer empty AND no turn-execution glyph in last 5min of scroll buffer AND not in any banner state | Safe to send keystrokes; safe to leave alone if no work queued |
| `working` | Turn-execution glyph (`✽ Honking…` / `✻ Cooked for Ns` / `✻ Working` / `✶`) present in last 60s of scroll buffer | Leave alone; backoff if scheduler-aware |
| `compacting` | `Compacting conversation` banner present in last 60s | Leave alone; sends during compaction lose input |
| `rate-limited` | `Now using extra usage` / `You've hit your limit` / `approaching usage limit` banner present | Leave alone; budget refresh required before sends are useful |
| `dead` | No resolvable PID OR PID exists but `kill -0 <pid>` fails OR `/proc/<pid>/status` reports `State: Z` (zombie) | Reanimate via `/team rotate-member` or raw send-keys boot path |
| `shell-prompt` | Pane shows a shell prompt (no TUI active; usually post-crash exit or pre-spawn) | Reanimate via boot pipeline; pane is alive but the agent isn't |
| `welcome-screen` | Pane shows `Welcome to Claude Code` banner; agent has booted but hasn't accepted input yet | Wait for transition; sends sent during welcome are absorbed |

The enum is intentionally **not** a strict subset of ADR-057's 8-state internal enum — it answers a different question (see §Context). Projection map in §D5.

### (D4) TUI structural marker parsing, NOT tail-10

The Claude Code TUI viewport has stable structural markers the verb parses **structurally**, not by reading the last N lines:

1. **Composer separator** — the horizontal rule line above the composer region. Stable Unicode box-drawing characters; matched as `/^[─━-╿]{N,}$/m` where `N` is a width-threshold (terminal-width-1).
2. **Status footer** — the bottom-of-pane status line carrying the model name + mode glyphs + budget meter. Always present; absence is itself a signal (`shell-prompt` candidate).
3. **Turn-execution glyphs** — the spinner set `✽`, `✻`, `✶` followed by a verb-of-the-moment (`Honking…`, `Cooked for Ns`, `Working`). Match anywhere in the transcript region, **not** the composer region.
4. **Banner blocks** — fixed strings that appear in the conversation transcript region. `Welcome to Claude Code`, `Compacting conversation`, `You've hit your limit`, `Now using extra usage`. Pinned to the transcript-only because matching banner strings inside the composer would be wrong — the operator can paste-in any text.

Per planner-anchor #2 — the marker enumeration is **load-bearing**. ADR §Implementation MUST list each marker with the exact byte-shape it matches and the TUI version it was sourced from. Future TUI bumps require an ADR-155 annotation. The matcher constants live in a single `src/core/pane-state-patterns.ts` module so reviewer audits land in one place.

### (D5) Projection map — ADR-155 verb → ADR-057 internal enum

`safeSendKeys` (ADR-138) continues to consume the existing 8-state classifier through `src/core/pane-state.ts`. Internally, `core/pane-state.ts` is refactored to call the new structured reader and project the result:

| ADR-155 `runtime_state` + composer | ADR-057 `PaneState` |
|------------------------------------|---------------------|
| `idle` + composer empty | `READY` |
| `idle` + composer has text + `likely_user_typed=true` | `TYPING` |
| `idle` + composer has text + `likely_user_typed=false` + `residue_class != null` | `TYPING` *(safeSendKeys still treats as queue-blocked)* |
| `working` | `BUSY` |
| `compacting` | `COMPACTING` |
| `rate-limited` | `RATE-LIMIT` |
| `dead` | `UNKNOWN` *(no send-safe target)* |
| `shell-prompt` | `SHELL` |
| `welcome-screen` | `BUSY` *(transient; send-policy treats as not-ready)* |

Modal detection (ADR-057's `MODAL` state) is orthogonal to ADR-155 — it lives in the composer region and is detected via a separate banner-block match that the projection layer adds. Modal handling stays where it is (`src/core/known-modals.ts`); ADR-155 does not re-implement it.

The projection means ADR-155 lands as a **strict refinement** of the existing capture pipeline: zero behavioral regression for `safeSendKeys` callers; new structured surface for new consumers.

### (D6) `likely_user_typed` — defensive-default-false heuristic

Per planner-anchor #4. When the composer has text, the verb returns `likely_user_typed: true` IFF the text **does not** match any `residue_class` pattern. Defensive default is `false` — assume not-user-typed unless the residue check explicitly clears it.

**Why defensive default false:** consumers like `/bau`'s Stuck-input verdict press Enter on panes flagged "operator queued input." A false positive (residue text mis-classified as user-typed) sends Enter and triggers a residue cascade. A false negative (real operator input mis-classified as residue) leaves the pane untouched — the operator presses Enter themselves on next checkin. Asymmetric cost favors the false-negative side.

Documented in §Decision-anchor pre-flags #4 + the verb's own help text. Consumers SHOULD never press Enter on `likely_user_typed=false` panes without driver confirmation; reviewer flags any caller that does without a written carve-out.

### (D7) `residue_class` — hardcoded denylist of known auto-mode self-nudge patterns

Closed string-set, NOT a regex engine. Lives in `src/core/pane-state-patterns.ts` alongside the marker constants. Each addition is one line of TypeScript that reviewer can audit at commit time.

v1 set (sourced from the sopx 2026-05-15 false-positive corpus):

| `residue_class` value | Trigger text (composer prefix-match) |
|------------------------|--------------------------------------|
| `claim-next` | `claim next task`, `atmux claim --next --as`, `atmux claim --next` |
| `pull-next` | `pull next`, `pull T`, `pull next task` |
| `check-status` | `check status`, `atmux status`, `status check` |
| `null` | composer text does not match any of the above |

The class set evolves slowly with TUI / auto-mode vocabulary — a year-scale cadence, not a sprint-scale one. The denylist is intentionally tiny and human-auditable; an ML-classifier or regex engine here would trade auditability for power we don't need.

Per planner-anchor #3.

### (D8) PID resolution + dead-pane semantics

`pid` is resolved via `tmux display-message -t <window> -p '#{pane_pid}'` (per planner-anchor #6) — the tmux primitive returns the **shell** PID, then ADR-155 walks `/proc/<pid>/task/<pid>/children` (Linux) or `pgrep -P <pid> claude` (mac fallback) to find the actual `claude` process.

`dead` is asserted IFF **any** of:
- `tmux display-message` returns empty (window doesn't exist).
- Resolved PID exists but `kill -0 <pid>` returns nonzero (no such process).
- `/proc/<pid>/status` reports `State: Z` (zombie, parent hasn't reaped).

Per planner-anchor #7. The triple-check matters because zombie-pane states are a real failure mode in the cockpit fleet — claude crashes, parent shell holds the PID slot as a defunct entry, tmux happily shows the last-rendered frame. Without `State: Z` detection, the pane reads `idle` (no glyph, no banner) and never gets reanimated.

### (D9) `last_turn_marker_age_seconds` — scroll-window-bounded measurement

Per planner-anchor #5. The verb computes the age of the most-recent turn-execution glyph (`✽` / `✻` / `✶`) in the captured scroll buffer by:

1. `tmux capture-pane -p -e -S -<N>` (N defaults to 200 lines; configurable via `--scroll-lines <N>`).
2. Locating the LAST glyph occurrence in the transcript region (not composer).
3. Computing age = `now - capture_timestamp + glyph_offset_from_buffer_tail` (where offset is line-based with ~1s/line assumption for typing speed).

When no glyph is found in the scroll window, the field is `null`. Consumers (`/bau`, unblocker) treat `null` as "no observable turn activity in the read window" — not as "definitely idle for >N seconds." The semantic is "didn't see it within N lines," not "didn't happen within N seconds."

This is intentionally rougher than wall-clock — exact age would require tmux's pane-tty timing data (not exposed) or per-line timestamping (cost-prohibitive). The N-lines bound is sufficient for the existing consumer needs (reanimation, lane-stall classification); precise observability lives in martinet's pluggable observer layer (ADR-132), not in this verb.

### (D10) Caching + cost discipline

Each `atmux pane-state` invocation runs ~3 tmux/proc syscalls (capture-pane, display-message, kill -0). On a 12-pane cockpit, a full fleet scan is ~36 syscalls. That's cheap by atmux standards, but consumer-side caching is still worth doing — `/bau`'s Stuck-input verdict, for example, naturally batches across panes per tick.

The verb itself does **not** cache — it's a pure read each call. Consumers cache; the verb stays stateless. Each consumer's cache TTL is a property of that consumer's loop cadence (martinet's observe loop owns its TTL; unblocker's drain loop owns its TTL; `/bau` recomputes every dashboard render).

Per the existing kanban-verb design pattern: verbs are stateless probes, callers compose state.

## Tradeoffs + alternatives considered

### Extending ADR-057's 8-state enum instead of a new verb, NOT chosen

Considered. Rejected per (D5) rationale:

- The send-safety question and the observer question are different; collapsing them into one enum produces eight states that under-serve both consumers.
- The internal `core/pane-state.ts` classifier has a sharp single consumer (`safeSendKeys`) and shouldn't be re-purposed as a public surface.
- A projection layer (D5) gives observer-question callers a structured shape AND keeps the send-safety question answered through the existing layer with zero refactor at consumer sites.

### Regex-engine residue classifier, NOT chosen

Considered. Rejected per (D7) rationale:

- Regex power buys nothing — the residue vocabulary is a closed string-set with prefix-match semantics.
- Audit cost goes up: every regex addition becomes a reviewer puzzle ("what does this NOT match?").
- An auditable string-set in a constants module is the cheapest, fastest, most-correct shape.

### ML-classifier (small local model) for `runtime_state`, NOT chosen

Considered briefly for the `working` vs `idle` discrimination edge case (panes where the glyph just disappeared but the agent is mid-tool-call). Rejected:

- Adds runtime dependency (model file, inference engine) for a question the structural markers answer with adequate accuracy.
- Tunes the answer per local-distribution rather than per-TUI-shape, which is the actual source of drift.
- Cheap-model-first principle (ADR-140) — Claude reserved for judgment, structural parsers reserved for structure. ML inside the parser inverts that.

### Tmux pane-pty timestamp data (richer age measurement), NOT chosen

Considered for (D9)'s `last_turn_marker_age_seconds`. Rejected:

- Tmux doesn't expose per-line timestamps via the public CLI; would need tmux server patches.
- Scroll-buffer offset measurement is adequate for the current consumer set.
- Precise wall-clock age belongs in martinet's observer (ADR-132) if needed; this verb stays cheap.

### Streaming output (`atmux pane-state --watch`), NOT chosen for v1

Considered. Rejected for v1 (kept open as §OQ4):

- Watch-mode complicates the stateless contract; the verb would need to hold tmux capture state across emissions.
- Existing consumers all pull on their own cadence; streaming would push state they don't ask for.
- Sibling pattern with `atmux outbox` / `atmux blockers` — both are pull-on-demand; consistency favors the same shape here.

## Open questions (proposed → accepted gate)

- **OQ1** — should `runtime_state` include an explicit `unknown` state for capture failures (tmux command errored, /proc inaccessible) versus inferring `dead`? Default v1: NO; capture failures surface as a non-zero exit code + stderr, not a JSON `runtime_state` value. JSON-typed consumers handle exit code; table render shows `?`.
- **OQ2** — should the verb accept a `--all` flag to scan all windows in the session and emit an array? Default v1: NO; consumers loop themselves. The `--all` path can be added in T2+ when a concrete consumer asks.
- **OQ3** — should `composer.text` ever be truncated for output? Default v1: full verbatim (no truncation). Operator pastes can be long; observability needs the full text for residue detection. Caller-side truncation if rendering.
- **OQ4** — should v1 ship `--watch` for streaming-mode? Default v1: NO (per §Tradeoffs). Revisit when a streaming consumer lands.
- **OQ5** — `welcome-screen` detection: should it carry a sub-state distinguishing fresh-boot from post-`/clear` welcome banners? Default v1: NO; both are "agent not ready for input"; the discriminator (boot vs post-clear) is observable via the scroll buffer's prior content, but no consumer asks for it yet.
- **OQ6** — should `mode` (auto / accept-edits / dont-ask / plan) be a hard enum or pass-through any string the TUI footer shows? Default v1: closed enum (`'auto' | 'accept-edits' | 'dont-ask' | 'plan' | null`); unknown modes return `null` + warn-class log entry. Forces the enum to track TUI mode additions through an ADR annotation.

Reviewer / operator: any non-default flips `Status: proposed → accepted`.

## Acceptance (T1 commit)

- [x] ADR-155 Status: `proposed`, ready for reviewer pre-flag
- [x] Cross-refs ADR-057 (internal classifier — projection target), ADR-138 (verified send-keys — consumer via projection), ADR-148 (cadence-truth-signal — pane-state column substrate), ADR-077 / ADR-133 (medic observe-loop — consumer), ADR-132 (martinet — primary cheap-model consumer), ADR-151 (unblocker — `runtime_state=dead` consumer), ADR-152 (blockers list — join target), ADR-154 (sibling /bruh sweep draft)
- [x] §Decision documents the verb surface (D1) + return shape (D2) + 7-state runtime_state (D3) + structural marker parsing (D4) + projection map to ADR-057 (D5) + `likely_user_typed` defensive default (D6) + `residue_class` denylist (D7) + PID resolution + dead-pane (D8) + age measurement (D9) + caching discipline (D10)
- [x] §Tradeoffs documents the four rejected alternatives (extending ADR-057, regex engine, ML, --watch v1)
- [x] §Out-of-scope: capture-failure `unknown` (OQ1), `--all` flag (OQ2), text truncation (OQ3), `--watch` (OQ4), `welcome-screen` sub-state (OQ5), open-vocab mode (OQ6) — all OQ-routed
- [x] Single commit (ADR only)
- [x] CHANGELOG `[Unreleased]` entry under `📋 Proposed` (the doc + structural ADR; impl T2-T6 deferred per scope below)

## Out of scope

- Blockers list verb (ADR-152 T1+)
- Auto-promotion rules (ADR-153 T1+)
- Storage migration (ADR-154 T1+)
- Unblocker role (ADR-151 T1+)
- TUI-version-specific marker patches (each future TUI bump that breaks a marker is a separate ADR-155 annotation header per project CLAUDE.md ADR append-only convention)
- Execution slices T2-T6 — verb impl, `core/pane-state-patterns.ts` module, consumer migration (status / `/bau` / `/bruh` / martinet / unblocker), dogfood gate, e2e tests. Filed as separate Tasks post-acceptance per the same-session decomp pattern (per `[[feedback_decomp_same_session_with_deps]]`); the staged carve-out is operator-decided.
- Cross-team pane-state aggregation (cockpit fleet roll-up; ADR-150 cross-team helpers — different layer)

## Related work + sibling patterns

- **ADR-057 internal classifier** — `src/core/pane-state.ts` 8-state enum for `safeSendKeys`. Direct predecessor; ADR-155 refines the capture pipeline and adds a public verb surface, with a projection layer keeping ADR-057's consumers byte-equal.
- **ADR-138 verified send-keys** — primary projection consumer. `safeSendKeysWithVerify` reads pane-state through the projection map (D5); the verb-side refactor lands transparently at the existing `core/pane-state.ts` boundary.
- **ADR-148 cadence-truth-signal** — establishes "cadence is the verdict; pane-state is the proxy." ADR-155 sharpens that proxy without changing its role: cadence answers "is this member shipping?", pane-state answers "what is this pane doing this instant?". The two compose; pane-state never overrides cadence.
- **ADR-132 pluggable martinet** — the cheap-model observer needs a structured read to write reliable sentinels. ADR-155 is the primitive martinet's observe-loop is built on.
- **ADR-151 unblocker role** — the `runtime_state=dead` signal is unblocker's reanimation trigger. ADR-155 makes that signal queryable, which is what makes ADR-151's authority enforceable in code (without a structured "dead" signal, unblocker would re-implement bespoke PID checks).
- **`[[feedback_decomp_same_session_with_deps]]` memory** — T2-T6 execution slices are filed in the same session with populated deps, per the established pattern.
- **`[[project_martinet_pattern]]` memory** — martinet is the primary cheap-model consumer; ADR-155 is one of the load-bearing primitives that makes the cheap-model-first principle tractable.
