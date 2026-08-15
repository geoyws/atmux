# ADR-273 — Voice fleet triage and pane input ("what needs me?" + "type that")

Status: proposed
Date: 2026-08-15
Implementation: **D1–D3 built 2026-08-16** (`fleet_attention` + `fleet_quiet`); **D4's `pane_nudge` + D5 built 2026-08-16** (see §Supplement-2); **`pane_send` still not built** — it remains gated on OQ-1. Status stays `proposed` pending reviewer signoff — an ADR is not accepted by being implemented.
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
2. **Epic-teams are reported UNREADABLE.** A cockpit `epic-team` entry inherits the *parent's* root (ADR-089 shared worktree), so neither its roster nor its session anchor is resolvable from the entry — probing one would read the parent's cage and report a confident wrong answer. Reported with the reason rather than skipped, since "never silently omitted" is the load-bearing rule. Five such entries exist on the fleet today, all from dissolved epics. — **Superseded by §Supplement-3 (2026-08-17): the claim "not resolvable" was wrong, and the resulting per-sweep noise was the tool's worst quality problem.**
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

- **D4 / D5 — `pane_nudge` and `pane_send`.** Absent from the catalog entirely. `pane_send` still needs the **OQ-1 operator decision** on a second factor before it can ship; `pane_nudge` does not depend on it and can go first. — **`pane_nudge` superseded by §Supplement-2 (2026-08-16); `pane_send` still stands.**
- **OQ-2 (push rather than pull)** — untouched, still noted-not-decided.

## Supplement-2 — `pane_nudge` as built (2026-08-16)

Records the shipped half of D4 and all of D5. **`pane_send` is still not built and OQ-1 is still an open operator decision** — nothing here is precedent for it.

### T1 — Shipped surface

- **`pane_nudge`** — catalog entry 17, `mutating: true`, `confirm: true`. Both flags are load-bearing: `confirm` puts it behind D7's server-enforced token, and `mutating` makes it **absent** from the catalog under `ATMUX_VOICE_READONLY=1`. It is therefore unreachable until P7 clears readonly, which is the correct order and is pinned by a test rather than left as an intention.
- **`atmux nudge --member <name> [--action submit|continue]`** — a first-class CLI verb, same shape as `atmux fleet` for D1. Allow-list + after-state classifier + receipt renderer in `src/core/voice/nudge.ts` (pure); IO in `src/verbs/nudge.ts`.
- **`atmux send --submit-only <member>`** — a new flag on the existing send verb, and the only new capability in the delivery path. See T3.

### T2 — The bound that lets it ship without OQ-1, stated structurally

D4 says `pane_nudge` "sends only a submit, or one canned resume string from a fixed allow-list". As built that is not a convention, it is three independent structural facts:

1. The catalog declares `action` as a **zod enum** over `NUDGE_ACTIONS`, so a transcript can *select* an action and can never *author* one. Free text fails validation as `bad_args` before any argv exists.
2. The word actually pasted is a **compile-time constant** looked up from that enum name in `NUDGE_ACTION_SPECS`. The enum value reaches argv as `--action submit`; the *text* never comes from the model at all.
3. `pane_nudge` declares **no free-text parameter of any kind** — a test enumerates its schema and fails if a `text` / `message` / `body` property ever appears, because that is the exact shape of `pane_nudge` silently becoming `pane_send`.

**The allow-list is two entries, and each exists because a `fleet_attention` class exists that it answers** — an action nothing on the fleet asks for would be unbounded capability bought for nothing:

| Action | Sends | Answers |
|---|---|---|
| `submit` | **nothing** — a bare verified submit | `idle-residue` (the overnight wedge) and `permission-prompt` (Claude Code's modals take the default selection on Enter) |
| `continue` | the single word `continue` | `dormant` / `frozen` — a pane that stopped with an EMPTY composer |

They are two actions rather than one with an optional string precisely because pasting onto residue **concatenates**: `continue` into a composer holding `claim --next` submits `claim --nextcontinue`. `submit` pasting nothing is what makes the wedge case safe.

### T3 — D5 as built, and the one new capability it needed

Delivery is `src/verbs/nudge.ts` building an argv and calling the **`send` verb**, not `sendToMember` and not tmux. Going through the verb means the nudge path inherits the member lookup, the ADR-135/ADR-161 window-rename shim, the ADR-025 driver-pane type gate, the safe-send modal preflight, the bracketed-paste envelope and ADR-138's verify-and-retry — the same argument ADR-272 D2 makes for the whole bridge, applied one layer down. A test injects a tmux namespace whose every input-injection method **throws**, so a hand-rolled `send-keys` creeping in later is a red suite rather than a silent regression.

**`atmux send` gained `--submit-only`, and it had to.** A bare Enter is not expressible as a message: `send <member> ""` is a usage error, and `send <member> "continue"` pastes onto the residue it is meant to submit. So `SendOpts.submitOnly` skips the load-buffer / paste-buffer pair and runs the **same** settle + `C-m` + ADR-138 verify step the paste path runs — extracted into one shared `submitStep`, so there is no second implementation to drift. Three combinations are **refused** rather than silently resolved, because each silent resolution would drop something the operator asked for: `--submit-only` with a message body, with `--no-submit`, and with `--broadcast`. The post-send `looksLikeNotConsumed` heuristic is skipped on this path — with no message its snippet is the empty string, which every capture contains, so it would report `warn-not-consumed` on every good submit; the ADR-138 verifier is the verification instead.

### T4 — The receipt, and the lie it was one line away from telling

D5's "delivery is verified" is implemented as: read the pane, deliver, read the pane again, classify both with the fleet classifier, speak the pair plus a verdict sentence. **Ordering and dependence are both tested** — a call log pins that the second read follows the send, and the *same* delivery against a pane that did not move produces a different receipt and **exit 1**. A hard-coded "the composer cleared" cannot survive both.

**The one place the fleet classifier is NOT reused verbatim, and why.** `classifyPaneObservation` treats composer residue in a window tmux saw activity in within `RESIDUE_FRESH_SEC` (60s) as *someone is typing* and files it under `quiet: idle`. For a survey that is correct — it stops the tool reporting the pane the operator is mid-sentence in. For an after-nudge read it is exactly wrong: **the recent activity is our own paste, one second ago.** Left alone, a nudge that changed nothing at all would be reported as "idle and clear" — the tool announcing success for a failure, which is the precise thing D5 exists to prevent. `classifyAfterNudge` therefore overrides `quiet: idle` back to `idle-residue` when residue is still in the composer, and the override is deliberately narrow to that one bucket so a genuinely working pane (whose tail can carry a stale `❯` line) is never demoted. Both directions are pinned, including a test asserting the bare survey classifier really does disagree — the bug is demonstrated, not merely described.

### T5 — Driver panes cannot be nudged, and this is the biggest practical limit

**ADR-239 §D2 is absolute: atmux never sends keystrokes into a driver pane**, enforced at the lowest level by `DriverSendKeysViolation` in `tmux.pane.sendKeys`. On the live fleet most `idle-residue` findings sit on `driver` / `driver-N` windows (§S3.1: 14 of 15 enabled teams carry `members: []` while their sessions hold live driver windows), so **the most common finding `fleet_attention` reports is one `pane_nudge` structurally cannot act on.**

Two consequences, both deliberate:

- The refusal is raised **up front**, by the same `isDriverPaneName` predicate the runtime guard uses, so the operator hears a rule ("that pane is yours, I will not type into it") instead of a deep abstraction throw that reads like a bug. The `member` parameter's own description says so, so the model can decline before calling.
- `pane_nudge` addresses **roster members**, because `atmux send` does. A tmux window the roster never heard of is reported by the sweep and is not nudgeable. That asymmetry is real and is not papered over: the sweep enumerates from tmux by design (§S3.1) while delivery goes through the roster by design (D5). Closing it would mean either a roster-driven sweep (which reports "all clear" across a working fleet) or a non-`send` delivery path (which D5 forbids). **Neither is acceptable, so the gap stays and is documented rather than hidden.**

### T6 — The confirm preview is per-tool now

`VoiceToolEntry` gained an optional `preview(args, team)` hook, used by the bridge instead of the generic `<key> <value>` rendering when present. `pane_nudge` is the only entry that declares one, and a test pins that it stayed the only one. The generic line is adequate for `dispatch_task` (the arguments *are* the action) and inadequate here, where the danger is in what the action *means* — D4 requires the preview to name the exact target and the exact action because the failure it guards is a misheard member name nudging the wrong agent. What the operator hears:

```
Confirm nudge: driver-2 on team atmux — press Enter to submit whatever is already
sitting in that pane's composer; nothing is typed. Say yes to proceed.
```

```
Confirm nudge: be-1 on team atmux — type the single word "continue" into that pane
and submit it. Say yes to proceed.
```

**A hazard worth stating plainly:** `submit` on a `permission-prompt` accepts that modal's **default selection**. That is the behaviour the operator wants at 2am and it is still a real grant of authority, made by a keystroke he confirmed by voice. The preview says "submit whatever is already sitting in that pane's composer", which is true of a modal too; the operator is expected to have heard the finding from `fleet_attention` first.

### T7 — Not built, still (as of Supplement-2)

- **`pane_send`.** Unchanged: it needs the **OQ-1 operator decision** on a second factor. A test asserts it is absent from the catalog, so it cannot arrive by drift on `pane_nudge`'s coat-tails.
- **OQ-2 (push rather than pull)** — untouched.

## Supplement-3 — epic-teams are swept, not written off (2026-08-17)

A correction to §S3.2: the survey told the operator something unactionable on every single call, and the claim underneath it was false.

### U1 — §S3.2 was wrong: an epic-team's cage IS resolvable

§S3.2 recorded "neither its roster nor its session anchor is resolvable from the entry" and reported every `epic-team` as UNREADABLE. That was true of the cockpit *entry* and false of the *cage*. `spawn-epic` gives an epic-team a root of its own, carrying its own `team.json` (hence its own `tmuxTmpdir`, hence its own socket) and its own session anchor. Only the pointer is missing from the entry, and this repo already knew how to rebuild it: `src/core/cage-resolver.ts::resolveCageForEpic` has resolved exactly this since e-11-446429c9, against two on-disk conventions —

1. **ADR-089 §F, in-parent** — `<parentRoot>/.atmux/worktrees/<name>`
2. **ADR-090 §Disk layout, sibling** — `<parentRoot>-epics/<epicId>` (what `spawn-epic` writes today)

Both are live on the fleet, so a consumer knowing only one silently misses half the cages. The pair is now a single exported helper, `epicCageRootCandidates` / `resolveEpicCageRoot`, and `resolveCageForEpic` was refactored onto it — one source of truth rather than a third copy of the convention.

The sweep now **rewrites the entry's `root` to the epic-team's own cage before probing**. That is the whole fix, and it needs no epic-specific branch in `probeTeamLive`: everything that function reads — `tryLoadTeam`, `resolveTeamSocket`, `resolveCageSessionName`, `readTeamAsks` — already keys off the root. A live epic-team is therefore swept in full: panes, classification, gists, driver-inbox and flag asks.

### U2 — Why "no live cage" is one compact line and not a `dead` item

An epic-team with no live cage stays on the UNREADABLE line, under **one shared reason** (`EPIC_TEAM_NO_CAGE_REASON`) covering both cases the operator cannot tell apart and would not act on differently: the cage root is gone from disk, or the root survives but no tmux server does. One constant rather than two is what lets `renderUnreadable`'s group-by-reason collapse the whole set into a single spoken clause.

The reason **names the action** — `atmux team dissolve-epic <name>` — because the old text named none. That is the substance of the fix, not cosmetics: §D3's own argument is that an item the operator cannot verify or act on is a black box, and a black box that cries wolf gets ignored. A reason whose action removes the row permanently stops being noise the first time he acts on it.

**The asymmetry, stated rather than hidden.** A *top-level* team whose session is absent is a `dead` attention item; an *epic-team* in the same state is not. This rests on what the two cockpit entries mean. A top-level entry is a standing declaration that the team should be up (`atmux start` maintains it, cron re-arms it), so its session being absent is news. An epic-team is ephemeral by construction — spawned per epic, `autoDissolve` on fan-in — so its cage ending is its **normal terminal state**, and its entry outliving it is bookkeeping. Ranking chronic state below news is the same call §S3.3 already made for `dormant`, for the same reason, and it was measured rather than assumed: promoting the two resolvable entries to `dead` took **two of the five spoken slots** on the live fleet and pushed `hx`'s crashed panes and `atmux`'s 1255 unread driver-inbox asks into the remainder count — permanently, for epics dissolved in May.

**What that costs, plainly:** an epic-team that *should* be running right now and whose cage just died is reported on the unreadable line rather than as an acute `dead` item. It is still named on every sweep — never omitted — but ranked as bookkeeping. Everything short of total cage death (wedged, rate-limited, crashed, refusing panes) reaches the operator through the normal classes, because a live epic cage is swept in full. `cageIsAbsent` recognises total absence from the probe's own evidence (every observation carrying `sessionUp: false`) rather than from a second source of truth, and guards the empty-list case explicitly — `[].every()` is vacuously true, so without it a probe that found nothing would report a dead cage.

**Measured on the live fleet (hax, 20 cockpit entries):** five `epic-team` entries, three under `unum` with no cage root at all and two under `mx` whose sibling worktrees survive with no running server. Before: five names and an unactionable reason on every sweep. After: one clause, one action, and the attention list unchanged — same top five as before the change, which is the point.

## Supplement-4 — §S2's deferral closed: the doctor's last two `atmux-<team>` literals (2026-08-17)

§S2 left two sites in `src/verbs/doctor/cockpit.ts` building the session name by hand and said fixing them "changes which doctor rows appear for which teams, which is a behaviour change in a different verb and belongs in its own change with its own doc update". This is that change.

### V1 — Two probes, two resolvers, and why it is not one

Both sites now go through one helper, `probeSessionName(team, source)`, whose two arms are a decision rather than a convenience:

- **`checkMemberCageStates`** gated its *entire* check on `hasSession('atmux-<team>')` and returned `[]` on a miss — blind rather than lying, which is why it survived longer than the `cage-state.ts` twin that reported false `down` rows. It already receives `atmuxDir`, so it resolves through `getSessionName({ dir: atmuxDir, team })` — the same anchor-aware resolver `gatherStatus` uses, `ATMUX_SESSION` pin included, which is correct for a check scoped to the current team.
- **`checkLegacyWindowNameFormat`** walks *many* teams, so it resolves through `resolveCageSessionName({ name, root })` — the anchor-only resolver, deliberately **not** `getSessionName`. `ATMUX_SESSION` is a process-level pin for the CURRENT team; honouring it inside a cockpit walk would point every team's probe at whichever cage the operator's shell happened to be pinned to. The cockpit root each target came from is now carried for exactly this purpose. Its `currentTeam` fallback (cockpit absent or team unregistered) keeps `getSessionName`, where the pin does refer to that team. Both directions are pinned by tests using one env var and asserting opposite answers.

Resolution **fails soft** to the old literal: `getSessionName` throws `ConfigError` for a `singleSession` team with no anchor, and one misconfigured team must not take down the whole `atmux doctor` run.

ADR-161's "cages whose canonical session name isn't on the socket silently skip (out of scope for this warn)" carve-out is therefore **removed** — see ADR-161 §Amendment 2026-08-17.

**Not in scope, and correct as it stands:** `checkOrphanSessions` also builds `atmux-<team>` by hand. That literal is the point of the check — it looks for the LEGACY session lingering beside a `singleSession` team — so resolving it through the anchor would break it.

### V2 — What changes on the live fleet: nothing today, and that is the finding

Measured, not asserted: both checks were run against the real cockpit before and after, and the output is **byte-identical** — `dash` emits its same five `member-cage-state` rows, every other team emits none, and `legacy-window-name-format` emits none either way.

That is not evidence the fix did nothing. The mechanism is broken exactly as §S2 described, and it is provable directly:

```
tmux -S <atmux cage socket> has-session -t atmux        → exit 0
tmux -S <atmux cage socket> has-session -t atmux-atmux  → exit 1, can't find session
tmux -S <unum cage socket>  has-session -t atmux_unum   → exit 0
tmux -S <unum cage socket>  has-session -t atmux-unum   → exit 1, can't find session
```

The gate really was unreachable for both anchored teams. No row appears today because **both are driver-only** (`members: []`, per the 2026-05-16 decomposition recorded in §S3.1) and both checks are member-scoped — `checkMemberCageStates` returns at its empty-roster guard before the session name is even resolved, and `checkLegacyWindowNameFormat`'s inner loop is over `team.members`. `dash` is the only team on the fleet with a roster, and it carries no anchor, so its name resolves to the same `atmux-dash` both ways.

So the change is **strictly additive and currently latent**: no row disappears (a blind check emits nothing to lose), and the rows that were structurally unreachable for `unum` and `atmux` become reachable the moment either team regains members. Reporting this as "N new rows appeared" would have been the lie; reporting a silent probe as proof of nothing would have been the other one.
