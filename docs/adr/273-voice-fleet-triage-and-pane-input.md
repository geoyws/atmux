# ADR-273 — Voice fleet triage and pane input ("what needs me?" + "type that")

Status: proposed
Date: 2026-08-15
Implementation: **D1–D3 built 2026-08-16** (`fleet_attention` + `fleet_quiet`); **D4–D5 not built** (pane input, gated on OQ-1). See §Supplement. Status stays `proposed` pending reviewer signoff — an ADR is not accepted by being implemented.
Extends: [ADR-272](272-voice-operator-interface.md) (voice operator interface)
Related: [ADR-138](138-verified-send-keys.md) (verified send-keys), [ADR-139](139-refusal-pattern-detection.md) (refusal detection), [ADR-140](140-cheap-model-first.md) (cheap-model-first observation loops)

## Context

ADR-272 shipped a voice operator interface with a 14-tool catalog and deployed it read-only. The tools answer *point* questions — one team's status, one member's pane state, one team's blockers. The operator's actual question is neither point-shaped nor per-team:

> "What needs my attention across everything, and what doesn't?"

Answering that today costs N×M calls: `list_teams`, then `team_status` per team, then `member_pane` per member. Roughly twenty teams times several members each. That is unusable in a voice conversation, where every call costs a spoken round trip.

Worse, the answer would still be wrong-shaped. `member_pane` returns a **state label** (`READY`, `TYPING`, `RATE-LIMIT`, `COMPACTING`), not what the agent is actually doing or stuck on. A label cannot distinguish "typing a commit message" from "typing an apology for the fourth failed attempt".

And there is no way to *act*. The catalog can file a task or message a lead, but it cannot do the thing the operator most often needs to do at 2am from a phone: **unstick a wedged pane** — type a reply, or just press Enter.

The north star from ADR-272 stands: atmux as a Jarvis. A Jarvis that can only read is a dashboard with extra latency.

## Decisions

### D1 — Two calls, split by attention, not by team

The fleet survey is **two** tools, deliberately:

- **`fleet_attention`** — every pane across every team that needs the operator, ranked most-urgent first.
- **`fleet_quiet`** — the complement, aggregated rather than enumerated.

Splitting by attention rather than by team is what makes this tractable in speech. The operator does not want twenty team reports; they want the short list of things that are stuck and a one-sentence assurance about everything else.

`fleet_quiet` exists so the assurance is *checkable*. A triage tool that only reports problems is indistinguishable from a triage tool that is silently failing to see anything — the quiet call is what makes an empty attention list mean something.

### D2 — Speech budget is a hard design constraint, not a formatting detail

Twenty teams times roughly six members is on the order of a hundred panes. At one clause each that is several minutes of unbroken speech, which is not an answer — it is a denial of service against the operator's patience.

Therefore:

- `fleet_attention` speaks **at most the top N** (default 5) with a one-clause reason each, then states the remainder as a count: *"…and four more, all rate-limited."*
- `fleet_quiet` **never enumerates panes**. It aggregates: *"Eighteen teams nominal, thirty-one panes working, two compacting."*
- Both carry a **per-pane gist**, not a transcript dump: the last meaningful line or two of the TUI, truncated hard, with prompt chrome and spinner glyphs stripped.

"Short transcript of everything in each TUI" is the operator's request; the honest reading of it for a *spoken* medium is a gist per pane plus the ability to drill into one. Full pane text remains available through the existing per-member read, which is the right place for it — a request for detail should cost a second call, not be paid for on every survey.

### D3 — Attention is classified server-side, from evidence, and says why

Classification does not belong in the model. The model sees only what the tool returns, and "does this need George" is a judgment that must be reproducible and auditable, not re-litigated per conversation.

**Needs attention:** a permission prompt waiting (blocking — the agent has stopped); rate-limited; a refusal pattern (ADR-139); pane or session dead; a visible error or crash; idle-with-residue (the wedge class — text sitting at a prompt that was never submitted); a lead flag or driver-inbox ask; dormant (no commits across a window while nominally active).

**Does not need attention:** actively working (an in-flight turn glyph); compacting; healthy commit cadence; cleanly idle with nothing queued.

Every attention item **states its evidence** — the classification and the gist that produced it. An item the operator cannot verify from the spoken reason is a black box, and a black box that cries wolf gets ignored, which defeats the tool.

Three known traps this classifier must not fall into, all previously observed in this codebase:

1. **`pane-state=down` is a known false positive** for teams whose session anchor contains an underscore — `cage-state.ts` hard-codes `atmux-<team>` instead of resolving the session name. Reporting a live team as dead is exactly the failure that trains an operator to ignore the tool.
2. **The in-flight-turn regex matches past-tense glyphs**, so a genuinely idle pane carrying a completed-turn marker reads as busy. That is the wedge class hiding inside the healthy class.
3. **Absence of output is not health.** A pane that has printed nothing for an hour is either thinking or dead, and the two must be distinguished by something other than silence.

### D4 — Pane input is a distinct, more dangerous capability class

Typing into an agent's pane is **not** another mutating verb. Every existing mutating tool has a bounded effect — file a task, dispatch a task, message a lead. Arbitrary keystrokes into a Claude pane with full tool access is an **unbounded** effect: it is a request for arbitrary action by an agent that can write code, run commands, and push.

It therefore splits in two, with different risk:

- **`pane_nudge`** — sends only a submit (Enter), or one canned resume string from a fixed allow-list. No operator-supplied content. This covers the common overnight case: a pane wedged with unsubmitted residue that needs one keystroke. Bounded, because the content is not free text.
- **`pane_send`** — sends operator-supplied text. Unbounded by construction.

Both are confirm-gated under ADR-272 D7 with the preview **read back verbatim** before redemption — for `pane_send` the exact text and the exact target pane, because a misheard team or member name sends the right words to the wrong agent.

`pane_send` inherits the second-factor requirement ADR-272 placed on `spawn`/`stop`/`kill` (§Deferred). The reasoning there applies unchanged and arguably harder: those verbs are at least enumerable and reversible in principle, whereas "whatever the operator said, typed into an agent" is neither. **Open question OQ-1 below.**

### D5 — Send goes through the verified path, never raw `send-keys`

Input uses the existing `atmux send` machinery (paste-and-submit) and ADR-138's verify-and-retry, never a hand-rolled `tmux send-keys`.

This is settled by evidence, not preference: on wedged panes, bare Enter, triple-Enter, `C-m`, and bracketed-paste **all failed**, and paste-and-submit was the only reliable path. A voice tool that appears to send and silently does not is worse than no tool, because the operator walks away believing the pane was unstuck.

Delivery is **verified** — the tool reports what the pane looked like after the send, not merely that a send was issued. "I pressed Enter" is a claim; "the prompt cleared and the agent is now working" is a receipt.

## Consequences

- Two new read tools and two new input tools, taking the catalog from 14 to 18.
- `fleet_attention` is the most expensive read in the catalog — it sweeps every pane in every team. It must be bounded in wall-clock and degrade gracefully: a team that cannot be read is reported as unreadable, never silently omitted. A survey that quietly drops a team is a survey that lies.
- Both input tools are absent entirely under `ATMUX_VOICE_READONLY=1`, so they do nothing until P7 clears it. That is the correct order: the survey half is useful on its own and can ship first.
- The classifier becomes a documented surface. Changing what counts as "needs attention" changes what the operator is told to worry about, so it carries the same-commit doc rule.

## Open questions

1. **OQ-1 — does `pane_send` require a second factor, or is D7 confirmation plus verbatim read-back enough?** The second factor (a spoken passphrase, or a code echoed from another channel) is real friction on the exact 2am one-handed use case the feature exists for. The counter-argument is that this is the single most powerful tool in the catalog. **Operator decision, required before `pane_send` ships.** `pane_nudge` does not depend on this and can ship first.
2. **OQ-2 — should `fleet_attention` be push rather than pull?** The operator asking "what needs me" is strictly worse than being told when something starts needing them. Push requires a channel to a phone that may be locked, which is a different ADR (and the existing Discord path already does a cruder version). Noted, not decided.
3. **OQ-3 — what is the wall-clock bound for a full sweep, and is a cached-with-age answer acceptable?** A survey that takes forty seconds is not conversational; one that reports a two-minute-old cache may be reporting a pane that has since wedged. Likely answer is a short cache with the age spoken aloud, but it needs measurement against the real fleet first. **→ Answered in §Supplement S4: measured at ~110 ms; no cache needed.**

## Supplement — what the survey half actually built (2026-08-16)

Records the shipped half of D1–D3 (`fleet_attention` + `fleet_quiet`), the `ATMUX_VOICE_BIN` override, the decisions this ADR left open that implementation forced, and the OQ-3 measurement. D4/D5 (pane input) are **not** built; OQ-1 remains an operator decision.

### S1 — Shipped surface

- **`fleet_attention`** and **`fleet_quiet`**, taking the catalog from 14 to 16. Both `mutating: false, confirm: false`, so both survive `ATMUX_VOICE_READONLY=1`.
- **`fleet_attention`** declares one integer parameter, `top` (1..15, default 5). **Neither tool declares any free-text argument**, so neither reaches a bare positional argv slot and the `auditArgvSlots` structural gate (ADR-272 D2 §Supplement) passes without a new dash guard. The catalog test's positional-argument count is unchanged at 3.
- Runner key **`fleet`** → `src/verbs/fleet.ts::fleet`, lazy-imported in `buildVoiceDeps`'s map like the others. The tools are also a first-class CLI verb, `atmux fleet`.
- Classifier + renderer: `src/core/voice/fleet.ts` (pure, no IO). Sweep: `src/verbs/fleet.ts`. The split is what lets every class be tested against fixtures rather than against whatever the live fleet happens to be doing.
- The per-pane gist reuses `src/core/voice/summarize.ts` (`stripAnsi` + the trailing-blank rule + a hard char cap) via a new `paneGist` — no second truncator.

### S2 — The three traps, as found and closed

**Trap 1 — `pane-state=down` false positive.** Confirmed live, not merely inherited: `src/core/cage-state.ts:145` hard-coded `atmux-${team.name}`, while `unum` anchors its session to `atmux_unum` (underscore) and `atmux` to bare `atmux` in `.atmux/state/session.txt`. Neither name is producible from the hard-coded form, so `hasSession` missed and step (1) reported every member of both live teams as `down`.

Closed three ways: (a) `probeCageState` gained a `sessionName` opt — the default is unchanged, so no existing caller shifts; (b) `gatherStatus` (`src/verbs/status.ts`) passes the name it *already resolved* through `getSessionName`; (c) the voice sweep resolves every session name through `resolveCageSessionName` (`src/core/cockpit.ts`), the anchor-aware helper that exists precisely for this.

**Still open, same root cause, deliberately not fixed here:** `src/verbs/doctor/cockpit.ts:138` and `:540` build `atmux-${team.name}` themselves. Line 138 gates its whole check on that name, so for an anchored team `checkMemberCageStates` returns *nothing* rather than a false `down` — blind, not lying. Fixing it changes which doctor rows appear for which teams, which is a behaviour change in a different verb and belongs in its own change with its own doc update. The probe seam is now correct (the default probe threads `sessionName` through instead of discarding it), so the remaining fix is one line in one place.

**Trap 2 — the in-flight-turn regex matches past-tense glyphs.** Verified rather than assumed. Two implementations disagree: `src/core/queued-text-resubmit.ts::ACTIVE_TURN_RE` was *already fixed* (present-tense verbs only, with a comment naming the 2026-05-19 unum 7/7-wedged incident), while `src/core/pane-state.ts::PATTERNS` still classifies BUSY on a bare `/✻\s+\w+/` — which matches `✻ Worked for 22s` — and tests BUSY *before* TYPING. So on that classifier a pane with unsubmitted residue plus a stale completed-turn glyph reads as busy: the wedge inside the healthy class. The voice classifier does not use it for the working/idle axis; it carries the fixed regex, and a test drives all four past-tense glyph forms plus five live forms.

**Trap 3 — silence is not health.** Answered with an independent clock rather than a longer timeout: the sweep reads tmux's `#{window_activity}` per window, which tmux maintains from actual output and no frozen render can forge. Two rules follow. (a) A pane joins the quiet set only on *positive* evidence — a live-turn marker, a compaction banner, or agent chrome with an empty composer; absence of anything bad is never enough. (b) A live-turn marker plus a stale clock is `frozen`, not `working`. A test asserts the *same pane text* classifies both ways depending only on the clock.

### S3 — Decisions the ADR left open

1. **Panes are enumerated from tmux windows, not the roster.** D1 says "every pane across every team" without saying how one is found. The roster is the obvious answer and it is wrong here: 14 of the 15 enabled teams carry `members: []` (driver-only, per the 2026-05-16 decomposition) while their sessions hold live `driver` / `driver-2` / `driver-3` windows. A roster-driven sweep answers "0 panes, all clear" across a fleet of working agents — the exact failure this ADR is written against. The roster is now enrichment (member labels); tmux is the truth. ADR-089 viewer windows are excluded structurally (`pane_current_command === "tmux"`) because they mirror another session's pane.
2. **Epic-teams are reported UNREADABLE.** A cockpit `epic-team` entry inherits the *parent's* root (ADR-089 shared worktree), so neither its roster nor its session anchor is resolvable from the entry — probing one would read the parent's cage and report a confident wrong answer. Reported with the reason rather than skipped, since "never silently omitted" is the load-bearing rule. Five such entries exist on the fleet today, all from dissolved epics.
3. **`dormant` is chronic, and ranked last.** D3 lists "dormant" among the attention classes, but on the live fleet it is 28 of 45 findings — a merely-parked fleet would make every team non-nominal and drown the acute findings. It stays an attention class (silence is not health) but ranks below everything acute, so it normally reaches the operator inside the "+N more" count, and `fleet_quiet` counts it on its own line so the all-clear stays meaningful.
4. **Same-class findings on one team collapse into one spoken entry.** D2 caps *items*; seven `dash` panes blocked on the same modal would have consumed the whole budget for one fact. Collapsing preserves rank order (a group takes its first member's position) and the remainder count still counts items.
5. **Classification reads only the pane TAIL (25 lines).** `capture-pane -S -40` returns scrollback *plus* the whole visible screen, so classifying over all of it made an `Error:` printed an hour ago read as a crash. Trailing blank rows are dropped before the tail is taken — without that, a short TUI's unpainted rows made a live Kimi pane classify as "blank" while its own gist printed the footer.
6. **Three live false-positive classes were found by running it, and had to be closed** — all now regression-pinned:
   - `pane_current_command` is `sh` for perfectly healthy Claude panes (spawned via `sh -c`), so it cannot mean "crashed". It is used only as corroboration once agent chrome is already absent.
   - `/hit your limit/i` (the `pane-state.ts` pattern) is a substring of Claude Code's standing tip *"If you hit your limit, you can continue…"*. Matching it put all five `mx` drivers in the rate-limited bucket. Fixed by requiring the assertive form and dropping any line that merely speculates.
   - `❯ Try "fix lint errors"` is the composer PLACEHOLDER, not operator input. Reading it as residue reported five idle panes as wedged.
   - Related: Claude is not the only TUI in a cage. Codex and Kimi panes (`gpt-5.6-sol … Ready · Approve for me`, `K3 thinking: high`) have their own chrome, and a Claude-only chrome test called every one of them "no agent running".

### S4 — OQ-3 answered: no cache needed

Measured against the real fleet (hax, 20 cockpit entries, 47 panes, 15 readable teams):

| Concurrency | Sweep wall-clock |
|---|---|
| 1 (serial) | 216 ms |
| 8 (default) | **109 / 115 / 119 ms** across three runs |
| 20 | 125 ms |

A sweep is roughly **one tenth of a second** — two orders of magnitude inside the "forty seconds is not conversational" bound the OQ worried about, and far below the round-trip latency of the spoken turn that carries it. **A cache is not needed and should not be added**: a cached answer's whole cost is the risk of reporting a pane that has since wedged, and there is no latency saving here to buy that risk with. Concurrency past 8 buys nothing (the work is ~140 short-lived tmux invocations, not a serial bottleneck), so the default stays 8.

The cache *shape* is nonetheless honoured in the contract rather than left to be retrofitted wrong: `FleetSweep.ageMs` exists, is `0` for a fresh sweep, and both renderers speak the age (`cached 45s ago`) whenever it is non-zero. If a future fleet is large enough to need one, the age is already reportable and tested — the caller can never be handed a stale answer that looks fresh.

**Caveat on the number**: 47 panes, not the ~100 the ADR sizes for, and every team was on the same box. A fleet of ~100 panes should be expected to land near 250 ms at the same concurrency, still comfortably conversational. The 15 s default `--timeout-ms` is therefore ~100× headroom, chosen so the bound only ever fires on a genuinely hung tmux server.

### S5 — `ATMUX_VOICE_BIN` (not in the original decisions)

`--supervise` was unusable in the deployed posture, which is why it is documented as never having been run live. `resolveAtmuxBin()` finds `/usr/local/bin/atmux` → `/opt/atmux/0.8.30`, an installed release that **predates the `voice` verb**, so the crash-loop wrapper ran `/opt/atmux/0.8.30 voice --serve`, got `unknown verb: voice` and exit 64, and looped — observed live going restart 1/5 → 3/5 before the circuit breaker correctly stopped respawning.

`bun run build:install` would fix it by swapping the atmux CLI **fleet-wide for every team on the box**, which is a release decision, not a supervision detail. Instead the already-existing internal `binPath` override is exposed as `ATMUX_VOICE_BIN`:

```bash
ATMUX_VOICE_BIN=$PWD/bin/atmux-bun atmux voice --supervise
```

Precedence is per-call override > `ATMUX_VOICE_BIN` > `resolveAtmuxBin()`, and **both override layers fail closed**: an empty or whitespace-only value falls through rather than producing a wrapper that execs `''`. This mirrors `resolveVoiceConfig` and `resolveGitTimeoutMs` — a fat-fingered export degrades to current behaviour, never to a broken one. Documented in RUNBOOK-voice.md §3 and in `atmux voice`'s own usage line.

This keeps a repo-checkout deploy first-class instead of forcing a fleet-wide release just to use supervision.

### S6 — Not built

- **D4 / D5 — `pane_nudge` and `pane_send`.** Absent from the catalog entirely. `pane_send` still needs the **OQ-1 operator decision** on a second factor before it can ship; `pane_nudge` does not depend on it and can go first.
- **OQ-2 (push rather than pull)** — untouched, still noted-not-decided.
