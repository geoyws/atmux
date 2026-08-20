# ADR-273 — Voice fleet triage and pane input ("what needs me?" + "type that")

Status: proposed
Date: 2026-08-15
Implementation: **D1–D3 built 2026-08-16** (`fleet_attention` + `fleet_quiet`); **D4's `pane_nudge` + D5 built 2026-08-16** (see §Supplement-2); **`pane_send` still not built** — it remains gated on OQ-1. Status stays `proposed` pending reviewer signoff — an ADR is not accepted by being implemented.
Extends: [ADR-272](272-voice-operator-interface.md) (voice operator interface)
See also: [ADR-274](274-atmux-vox-rename.md) — the naming decision moved there: the feature is `atmux vox`. This ADR's title and body stand as written; the `atmux fleet` and `atmux nudge` verbs it adds are deliberately NOT renamed (ADR-274 §What this ADR does not decide).
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

## Supplement-5 — `team_status` stops guessing which pane is whose (2026-08-17)

Found by the voice e2e harness against its isolated fake cage, and left failing rather than greened. `team_status` printed:

```
🟢 TEAM vox-e2e-alpha  session=atmux-vox-e2e-alpha [up]
  be-1 … down    fe-1 … down    docs … down
```

Three `down` panes on the line directly beneath a session the same verb had just called `[up]`, while `fleet_attention` classified those same panes correctly **off the same socket**. `team_status` is in the catalog and visible under readonly, so this was spoken to the operator as fact — the "cries wolf" class §D3 is written against, arriving through the tool rather than the model (the transcript shows the model relaying it faithfully).

**Not §D3 trap 1, and not §Supplement-4.** Both concern the *session* name. This team's session is `atmux-vox-e2e-alpha`, which the `atmux-<team>` literal produces correctly, so neither could fire here.

### W1 — Root cause: the verb SYNTHESIZED window names instead of enumerating them

`probeCageState` built its target as `member.emoji ?? defaultEmojiForRole(role)` → `buildWindowName(...)`, inventing a `🐝` for a roster entry that carries none and probing `<session>:🐝-be-1`. The cage's windows are plainly named `be-1` / `fe-1` / `docs`; `list-panes` answers `can't find window`, the catch below step (2) returns `down`.

`fleet.ts` never had it because it **enumerates** — `tmux.window.listWindows(session)` and then uses the names tmux gives back. That is the whole difference between the two verbs, from one socket.

The fix moves `cage-state.ts` onto the same discipline: `cageWindowCandidates()` states every naming form a live window may carry (spawn form, roster-verbatim, ADR-135 hyphen, pre-ADR-135 no-separator, bare id) and `resolveCageWindowName()` picks the first that tmux actually reports, falling back to the spawn form when the list is unreadable — never *worse* than the guess it replaced. `gatherStatus` hoists one `list-windows` for the whole roster and hands it to every member's probe.

**A member with no window still reports `down`.** This is a resolution fix, not a "stop saying down" fix.

### W2 — The same root cause was also silently attributing one member's pane to another

Found while fixing W1, and worse than a false `down`. `readPaneCommand` synthesized its own (differently-derived) target and passed it to `display-message`, which **does not fail on a missing window** — it resolves to the session's CURRENT window and exits 0:

```
$ tmux -S <sock> display-message -p -t 'atmux-vox-e2e-alpha:🐝-nope' '#{window_name} / #{pane_current_command}'
be-1 / sleep          # exit 0
```

So every member whose synthesized name missed was reported with a *sibling's* command, with no error anywhere. `list-panes` (what the cage probe uses) does error, so only this call site needs the guard: a name absent from the enumerated list now short-circuits to `(down)` rather than being asked about.

### W3 — The approval row described the CALLER's repo, not the team

`gatherStatus` called `scanNeedsApproval()` with no arguments, so it walked up from `process.cwd()`. Against a `mkdtemp` team with an empty root it reported `📝 NEEDS APPROVAL: 19 ADRs / 1157 inbox / 2 kanban` — the harness's own repo, spoken as a fact about someone else's team. Under the voice bridge (`team_status` → `atmux status --team-dir <root>`) the caller is always the server's checkout, so the row was never describing the team asked about.

It now passes `projectRoot` derived from the team's `atmuxDir`. `ScanDeps.projectRoot` already existed for exactly this; nothing called it. The pre-existing approval tests only passed by pinning `ATMUX_DIR`/`ATMUX_TEAM_DIR` process-wide — the leak was known-shaped and worked around in the fixture rather than closed. The new tests deliberately do **not** pin either, because `--team-dir` is all the voice bridge passes.

### W3b — The same call, a second time, in `poke` §2.5

`scanNeedsApproval()` had exactly two callers and BOTH were unscoped. The other is `runNeedsApprovalCheck` in `src/verbs/poke.ts`, which holds `ctx.atmuxDir` one line below the call and then stamps the resulting Discord ping with `ctx.team.name` — another team's paperwork backlog, pushed to the wire under this team's name, on a cron tick whose cwd is wherever the crontab line landed.

Both call sites were known-broken and worked around in their tests rather than fixed. `tests/unit/verbs/poke.test.ts::seedTeam` disabled the feature outright with a comment naming the leak ("walks the REAL repo's docs/adr/ … leaking into tests' `sent[]` assertions"); `tests/e2e/whip-needs-approval.test.ts` pinned `process.env.ATMUX_DIR` because "mutating WhipOpts.env doesn't reach the lib". Both workarounds are now removed and replaced by assertions: the e2e CLEARS those env vars so its counts prove the scoping, and a new poke test turns the feature ON against a scratch root and asserts silence.

### W4 — A verdict manufactured from a probe that could not look

`defaultGitLog` collapsed a non-zero `git` exit to `[]`, and `[]` means "a repository with no matching commits" — so `git -C <not-a-repo> log` (exit 128) became `🟡 idle (never)`. A confident cadence verdict about work that was never observable.

It reached the operator spoken. The vox drilldown transcript below relayed the word "idle" about a scratch team whose only sin was living outside a git repository, and the judge scored it as a hallucination — correctly, from its side: nothing in the ground truth was idle.

`GitLogFn` now returns `string[] | null`, `null` being "I could not read a repository here". `classifyMemberCadence` returns `null` for it and `status` leaves the cell `—` ("no signal"), which is what the renderer already had for exactly this case. `[]` still reads `idle` — the distinction is the whole point.

**A test asserted the bug.** `status.test.ts`'s "text mode shows 'idle' cadence for tmpdir worktree (no .git)" encoded the defect as the contract, comment and all ("no .git → git log probe fails → empty log → verdict='idle'"). It now asserts the opposite, with the history recorded in place so the next reader does not "restore" it.

### W5 — The tool can now say "I could not tell"

The second finding from the main loop: `team_status` returned `ok=true` and stated pane states as fact with no way to signal that it had inferred rather than measured them.

`CageHealth.inferredFromRender` records when a state was read off the pane's render because `ps` could not identify the occupant, and `status`'s pane-state column renders it as a trailing `?` (`active?`). It is set ONLY on non-`down` rows: a `down` row is reached when both signals AGREE nothing is there, which is a confident conclusion, not a hedge — flagging it would advertise doubt the probe does not have.

Related, and NOT fixed here: `defaultPaneChildIsClaude` runs `ps -o comm= --ppid <panePid>`, which is DIRECT CHILDREN only, while this module's own docs say "child-process tree" three times. A real cage whose claude sits deeper than one level (shell → wrapper → claude) is a false `down` today. The `?` marker now covers its symptom; the probe itself still needs the tree walk.

### W6 — The e2e drilldown scenario: failure moved, scenario still FAILS

Run verbatim, `bun scripts/vox-e2e.ts --scenario drilldown`, against the live provider. Both causes the main loop reported are gone; the judge now fails on something else entirely.

**Before (reported by the main loop):** *"Alpha team is up, but all members' panes are down and idle. No tasks are active or in progress. There are 21 ADRs and a large inbox needing approval."*

**After W1–W5:** *"Alpha team is up, with three members: be-1, fe-1, and docs. All panes are active, and no tasks are in progress or blocked. There's a note that the kanban is clear and needs approval."*

```
judge verdict: FAIL (model claude-opus-5)
  [PASS] answered_the_question
  [FAIL] no_hallucination
         It invented conditions that do not exist: 'All panes are active, and no tasks
         are in progress or blocked' and a note that 'the kanban is clear and needs
         approval' — no such state exists, and be-1 is blocked on a permission prompt
         while fe-1 is wedged with unsubmitted text.
  [PASS] scoped_to_the_right_team
  [FAIL] described_alpha_accurately
         It claimed all panes are active with nothing blocked, directly contradicting
         be-1's permission prompt and fe-1's unsubmitted composer text, and omitted
         both panes needing attention.
```

`down` is gone, the ambient ADR/inbox counts are gone, "idle" is gone. What remains is **not a defect in any probe**: `team_status` and `fleet_attention` speak different vocabularies about the same panes. `team_status` reports the 4-state PROCESS taxonomy (`down` / `bootstrapping` / `active` / `wedged`), and `active` is true of all three fixture panes under its documented definition ("has produced output"). The ground truth is a BEHAVIOURAL classification — permission-prompt / idle-residue / working — which only `classifyPaneObservation` in `src/core/vox/fleet.ts` produces, and `team_status` never calls it.

So no amount of making the process probe more honest can satisfy `described_alpha_accurately`. Closing it means deciding that `team_status` surfaces the fleet classifier's per-pane verdict alongside (or instead of) the cage state — which changes a documented output surface and picks a winner between two classifiers. **That is a decision, not a bug fix, and it is deliberately NOT taken here.** Recording it as the open item rather than reshaping the surface unilaterally. — **→ Decided 2026-08-17: ALONGSIDE, with the behavioural verdict leading. See §Supplement-6.** This section is left as written: it is the record of the state before the decision.

Two smaller residues visible in the same transcript, both model-side reads of an ambiguous table rather than false tool output: the model fused the `📋 kanban` and `📝 NEEDS APPROVAL` lines into "the kanban is clear and needs approval", and in the pre-W4 run it read the `cadence` column's "idle" as a pane state. Every individual line the tool printed was true.

### W7 — What is still ambient, stated rather than fixed

Two reads in `status.ts` remain keyed by `$HOME` + team **name** while everything else is keyed by team **root**, so a scratch team that merely shares a name with a real one inherits its state. Reproduced directly — a team created seconds earlier in `/tmp`, named `atmux`:

```
🧭 lead lead  session_uptime=2044h17m
```

That is the real `atmux` team's `~/.claude/teams/atmux/lead-session-start.txt`, and this number is the **ADR-009 rotation gate's** source. `readMemberContextSignal` (the `ctx %` column) has the identical shape. Not fixed here: the producer is the bash-side whip, so re-keying is a cross-process protocol change and belongs in its own ADR, not smuggled into a truthfulness fix.

Also noted, and correct as it stands: the `📋 medic` row is cockpit-global by design (§F5 / ADR-133) though it renders inside a team block; and `defaultGitLog`'s `git -C <path> log` walks up to the enclosing repository, which is right when a member's cwd is a subdirectory of its repo and wrong only for a team root that is not a repo at all.

### W8 — Before and after, the harness's own cage

Built from `buildCagePlan` + `materializeCage` — the same planner and the same fixture texts the e2e uses, so this is the cage the judge grades, not an approximation.

```
# before
🟢 🧭 TEAM vox-e2e-alpha  session=atmux-vox-e2e-alpha [up]
  🐝 be-1  claude  down    🐝 fe-1  claude  down    🐝 docs  claude  down
                          🟡 idle (never)  ×3
📝 NEEDS APPROVAL: 21 ADRs / 1160 inbox / 2 kanban

# after
🟢 🧭 TEAM vox-e2e-alpha  session=atmux-vox-e2e-alpha [up]
  🐝 be-1  claude  active?   🐝 fe-1  claude  active?   🐝 docs  claude  active?
                          —  (no repo ⇒ no cadence verdict)
📝 NEEDS APPROVAL: ✅ clear
```

Every difference is a claim the tool can now support: the panes resolve to windows tmux actually reports, the `?` says the occupant was never identified, the cadence cell says nothing because nothing was readable, and the approval row describes this team.


## Supplement-6 — infrastructure reads: `host_pressure` + `token_budget` (2026-08-17)

> Two tools the operator asked for and the catalog never had: *"get info about the token budget and other things of interest, and also the cpu/mem/disk pressure for hax and hig both"*. `cost_report` looked adjacent and is not — it is per-member AI **spend** for one team since session start, which answers neither question.

### X1 — Shipped surface

| Tool | Runner | Verb | Params | Mutating |
|---|---|---|---|---|
| `host_pressure` | `hostPressure` | `atmux host-pressure` | none | no |
| `token_budget` | `tokenBudget` | `atmux token-budget` | `provider` (enum), `cache_only` (bool) | no |

Both are reads, so both survive `ATMUX_VOX_READONLY=1`. Neither is team-scoped: a host and a provider quota belong to the whole fleet, and scoping either to a team would invite answering "how is hig" with one team's slice of a machine every team shares. The catalog is 19 tools.

Implementation: `src/core/vox/host-report.ts` + `src/core/vox/token-budget.ts` (pure, fixture-testable), `src/verbs/host-pressure.ts` + `src/verbs/token-budget.ts` (IO), both also reachable as CLI verbs.

### X2 — The two judgment calls

1. **Unreachable is not healthy.** A host that cannot be reached — ssh failure, timeout, or a payload we cannot parse — reports `UNREACHABLE` with its reason, is never dropped from the report, and forces the overall verdict to not-ok. `hig` being down is exactly what the operator needs to hear, and a report that folded it into an all-clear would be using absence of evidence as evidence.
2. **Cached is not live.** A `--cache-only` budget row is labelled `CACHED` with its snapshot age, in the headline *before* any number and again on every row. A stale snapshot described as a measurement is the same lie one domain over.

### X3 — Reuse, not reimplementation

- **Host pressure** extends the existing `src/core/host-pressure.ts` rather than adding a second probe. The remote host runs `probeHostPressure` too — with readers that serve text pre-fetched by one ssh round trip — so every parse, threshold and verdict is shared. A separate remote implementation is how two hosts start disagreeing about what 90% full means.
- **Token budget** shells out to the operator's maintained `probe-budgets.sh` through the `spawn()` seam. That script already handles Codex's rate-limit JSON, Claude's five OAuth headers, Z.ai's quota windows and Kimi's absent quota API; a second copy in atmux would drift on the first provider header change, and would put four sets of credentials in a process that today never touches any. Resolution order: `ATMUX_BUDGET_PROBE`, then `~/.agents/skills/...` (the one tree both Claude and Codex read), then the `.claude*` fallbacks.

### X4 — The disk dimension was added to `host-pressure.ts`, and it gates

`host-pressure.ts` had load and memory but no disk. Disk was added **there**, so `atmux doctor`'s host-pressure row and the ADR-184 spawn-epic gate benefit alongside the voice tool.

Disk **participates in the verdict**; it is not merely measured. A probe that reads a dimension and then excludes it from `ok` would return `ok: true` on a 99%-full host — and a full disk is exactly what breaks `git worktree add`, the first thing spawn-epic does. Threshold `ATMUX_SPAWN_MAX_DISK_PERCENT`, default **90**, matching the line the hig sentinel already alerts on so one host does not carry two definitions of "full".

**This changes spawn-epic's refusal criteria**: a host over 90% on a probed mount now refuses spawn where before it did not. Deliberate, and named here rather than left to be discovered.

A **missing mount is a reason, not a pass**. Matching is exact on df's "Mounted on" column: an ancestor-prefix rule was written first and rejected, because `/` is an ancestor of every absolute path, so it marked an absent `/data` as covered whenever `/` was also probed — the default configuration — leaving the check dead on arrival.

### X5 — Three faults the live run found that the unit tests did not

1. **`echo #atmux:loadavg` is a shell comment.** The snapshot markers begin with `#`, and unquoted they printed nothing, so hig's payload came back with no section headers. The failure was at least honest — an unparseable payload reported `UNREACHABLE`, exactly as X2.1 requires — but the host was wrongly unreachable for a week's worth of a wrong character. The test that "passed" asserted the marker *text* appeared in the command, which is true either way; it now asserts the **quoting**.
2. **Two Codex budgets rendered identically.** `codex:primary` and `GPT-5.3-Codex-Spark:primary` share the 7d window, so both spoke as "codex pro 7d" — one `AT CAPACITY`, one fine, back to back and indistinguishable. The bucket is now appended whenever it is not already the window label.
3. **`SpawnTimeoutError` embeds the whole argv.** The first live timeout produced a ~200-character dump of the remote shell script as the spoken reason. `speakProbeError` reduces it to `ssh to hig timed out after 250ms`, and surfaces the ssh failure phrases (`Connection refused`, `Permission denied`, …) that each imply a different fix.

### X6 — Secrets

Neither tool prints, logs or returns a token. `redactSecrets` masks credential-shaped substrings (JWTs, `Bearer …`, `sk-`/`ghp_`-style keys, and any opaque 40+ character run) on every free-text field that reaches output — including `--json`, since a leak that only happens under a flag is still a leak, and including the probe's stderr on the failure path, which is where an interpolated URL would otherwise land. The tests plant a control value and assert a benign note **is** rendered verbatim before asserting a planted token is not, so "no secret present" cannot pass by the field having been dropped.

### X7 — Timeouts

`ATMUX_HOST_PROBE_TIMEOUT_MS` (default 15_000) bounds each ssh; `ATMUX_BUDGET_PROBE_TIMEOUT_MS` (default 45_000) bounds the budget probe. Both resolve with the fail-closed contract `src/abstractions/spawn.ts::resolveDefaultTimeoutMs` uses — missing, non-numeric, non-finite or non-positive silently becomes the default. A voice tool that hangs is worse than one that errors.

### X8 — Two ways a SUCCESSFUL read reaches the model as a failure

Both were found by driving the real `tool-bridge` end to end with the real lazy runners, not by unit tests — each half was correct on its own, and only their composition was wrong. Both are the same failure class as X2: a confident answer that is not what the operator thinks it is.

**1. A nonzero exit becomes `verb_failed`.** The bridge maps a verb's nonzero exit to an error envelope. Both tools originally returned 1 on bad news — an unreachable host, a rate-limited account — reasoning that the exit code should carry the verdict for shell chaining. The consequence: *"hig is unreachable"*, the single most important thing `host_pressure` can say, arrived at the model as a **broken tool** rather than as the finding. Every other read verb the catalog wires (`health`, `fleet`, `blockers`) returns 0 unconditionally; these now match. **The exit code says whether the read happened; the rendered text and `--json.ok` carry the verdict**, and a shell gate reads `--json | jq -e .ok`. Nonzero survives only for "could not measure anything at all", which genuinely is a tool failure.

**2. Output on stderr becomes `verb_output_unparseable`.** `captureVerbRun` collects stdout only (`console.log` + `process.stdout.write`), so a verb writing its receipt to stderr yields empty captured stdout, which the bridge renders as *"the verb produced no usable output"*. `tell_lead` has that shape today and a **separate lane owns the bridge-side fix**; `src/core/vox/tool-bridge.ts` and `src/core/verb-capture.ts` were deliberately NOT touched here. *(Pointer, added 2026-08-20: that bridge-side fix landed — see [ADR-272](272-voice-operator-interface.md) §Supplement-2026-08-20. The reasoning below stands as written; a read tool's report belongs on stdout regardless.)* Instead both tools write to stdout — the correct shape for a read tool regardless of what the bridge does — and `tests/unit/verbs/vox-infra-stdout-contract.test.ts` pins it on the success, failure and `--json` paths so neither tool depends on that fix landing.

A note on why the second needed its own test rather than an assertion inside an existing one: `console.log` does **not** route through `process.stdout.write` in Bun (verified directly), which is why `verb-capture` patches both. A capture harness that watched only one channel would have reported an empty stderr for the wrong reason, so the harness itself carries a control test proving it can see a stderr write before any `expect(stderr).toBe("")` is trusted.

### X9 — Not built

- No per-host filter on the voice tool (`--host` exists on the CLI verb only). The spoken question is "how is the box holding up", which means every box.
- No historical trend for either tool. Both answer "right now".
- The **voice path** is unproven for both, the same gap §7 V-20 records for `fleet_attention`: the CLI verb and the tool share the renderer, but the tool-bridge path around it (argv construction, summarization, `maxResultChars` budgeting) has no live receipt yet.
## Supplement-7 — W6 decided: `team_status` speaks the fleet classifier's verdict, alongside the cage state (2026-08-17)

§Supplement-5 W6 stated an open decision precisely and declined to take it. This records the decision, taken by the operator, and what implementing it changed. **W6 above is left exactly as written** — it is the honest record of the state before the decision, and rewriting it would erase the fact that the surface was not reshaped unilaterally.

### The decision

**`team_status` surfaces the behavioural per-pane verdict from `classifyPaneObservation`, ALONGSIDE — not instead of — the process cage-state.** The behavioural verdict leads.

Three reasons, in the order they carry weight.

1. **Two classifiers contradicting each other on one spoken surface is the defect.** `fleet_attention` said "be-1 is blocked on a permission prompt"; `team_status` said "be-1 is active". Both true in their own vocabulary, and an operator asking two questions in one voice conversation got two incompatible pictures of the same pane. ADR-273 D3 already made `classifyPaneObservation` the fleet's truth; `team_status` disagreeing with it was drift, not a second opinion.
2. **On a spoken interface the process taxonomy is the wrong vocabulary to lead with.** "Active", read aloud, means "working fine" to a human listener. A pane blocked on a permission prompt is technically active and practically stuck. The word actively misleads in the one place it matters most.
3. **Alongside, not instead of.** The process state is real information — is the process alive, did it produce output — and `down` is exactly what you want when a cage has died. The behavioural verdict answers a different question. Both belong.

### Y1 — One pane, one read, two verdicts

The obvious implementation is to call the fleet classifier from `status.ts` on a fresh capture. That is the same defect one layer down: two probes over one pane drift the moment either one's capture depth, timing, or target resolution changes. `fleet.ts` and `cage-state.ts` reading the same socket at different moments is precisely how W6 happened.

So the verdict is produced **inside `probeCageState`**, from the capture it already takes:

- `tryCapture` now returns `string | null` and captures `CAPTURE_LINES = 40` — matching `src/verbs/fleet.ts::CAPTURE_LINES`. `null` (the capture FAILED) is preserved for the behavioural classifier, which reports `unreadable` for it; the process ladder still sees `""`, byte-identically to before. `""` and `null` are different claims — "I looked and saw nothing" versus "I could not look" — and collapsing them is how a probe manufactures confidence out of a failure.
- `ProbeCageStateOpts.windowProbe` supplies the three INDEPENDENT window signals the classifier needs (`#{window_activity}` / `#{pane_dead}` / `#{pane_current_command}`). `gatherStatus` reads `#{pane_current_command}` for its own column anyway, so `readPaneCommand` was widened to `readMemberPane`, rendering the full `WINDOW_PROBE_FORMAT` in the SAME `display-message` and handing the result down. Net tmux calls per member: unchanged.
- `CageHealth.agentState` carries the `PaneVerdict` on every return path, including the ones that never reach a capture (session absent, window absent) — routed through `classifyPaneObservation` with a synthetic observation rather than hand-written as `dead`, so the words match `fleet_attention`'s by construction rather than by discipline.

`parseWindowProbe` + `WINDOW_PROBE_FORMAT` moved from `src/verbs/fleet.ts` to `src/core/vox/fleet.ts` for this (core must not import from `src/verbs/**`); the verb re-exports them, so every prior importer resolves unchanged.

`tests/unit/core/cage-state.test.ts` pins the anti-drift property directly: the same fixture text through `probeCageState` and through `classifyPaneObservation` must yield **byte-equal** verdicts. A second copy of the ladder inside `cage-state.ts` would fail there the day either moved.

### Y2 — What the row looks like now

```
member       role          tui        agent-state                                process-state      ctx      commit-cadence                 tasks
  🐝 be-1      member        claude     agent: 🛑 waiting on a permission prompt   process: active?   —        commits: no signal             🟡 0 active  📌 0 todo
       ↳ evidence for be-1: │ Do you want to make this edit?                           │
  🐝 fe-1      member        claude     agent: 🛑 idle with unsubmitted text       process: active?   —        commits: no signal             🟡 0 active  📌 0 todo
       ↳ evidence for fe-1: unsubmitted: also add the rollback path before you push
  🐝 docs      member        claude     agent: 🟢 working                          process: active?   —        commits: no signal             🟡 0 active  📌 0 todo
```

The clause after the glyph is `paneVerdictPhrase` — the same `ATTENTION_REASON` / `QUIET_LABEL` lookup `renderAttention` uses, so the two tools cannot describe one pane in different words. The glyph is `paneVerdictGlyph`: 🛑 acute, 🟡 chronic (`dormant` only), 🟢 nothing needed — the same three-way call `renderQuiet` already makes when it counts parked panes separately from findings.

The indented `↳ evidence` line mirrors `renderAttention`'s `> gist`: D3 requires every attention item to carry the evidence that produced it, and an operator who hears the same claim from both tools should be shown the same evidence for it. Quiet rows get no line — the budget belongs to the findings.

`--json` gains `members[].agentState` = `{ bucket, kind, reason, marker? }`, key-presence.

### Y3 — The two model-side legibility residues W6 named, fixed

Both were cases where every line the tool printed was individually TRUE and the TABLE was ambiguous read aloud. This surface is consumed by a language model, so legibility to a model is a functional requirement, not polish — and a model reading a column-aligned table row by row has no header in front of it.

- **The `📋 kanban` / `📝 NEEDS APPROVAL` fusion** ("the kanban is clear and needs approval"). Each line now names its own subject in full: `📋 kanban board: …` and `📝 awaiting your approval: ✅ nothing is waiting for sign-off` / `📝 awaiting your approval: 2 proposed ADRs, 2 driver-inbox asks, 1 blocked kanban tasks`. Neither can be read as a predicate of the other.
  - **A second turn of the same screw, found by the full run.** With the subject fixed, the enumerated form still spent the words *in-progress* and *blocked* — which are ALSO pane vocabulary — and the model relayed "no tasks are in progress or blocked" about a team with a blocked pane. Every word true; the judge scored the sentence as contradicting the ground truth, and it was right to. An empty board now gets its own sentence, `📋 kanban board: no tasks on it at all`, spending no state words at all; a non-empty board keeps the noun welded to every number (`📌 1 tasks todo, … 🛑 1 tasks blocked`) so no count can travel without its subject.
- **The cadence column's bare `idle`, read as a pane state.** Every cell is now prefixed `commits:` and the header is `commit-cadence`. The absent case reads `commits: no signal` rather than `—`: a dash read aloud is nothing at all, and "no signal" is the actual claim (§Supplement-5 W4).

Same reasoning applied to the two state columns: the cells are `agent: …` and `process: …`, self-labelled, because a bare `active` in a row of bare cells is exactly what the model turned into "all panes are active".

### Y4 — The vox system prompt moved with the surface

The prompt clause landed on trunk in `b8bddef` describes the `?` marker BY ITS RENDERED TEXT, and `team_status` sends the text table (no `--json`). Renaming the column without touching the clause would leave the prompt pointing at something that no longer renders — nothing would fail, which is what makes it worth stating.

- The `?` marker itself is **untouched**: `formatPaneStateColumn` is unchanged, and `formatProcessStateColumn` only prefixes it, so the cell still ENDS in `active?`, which is what the clause keys on. The clause's column name changed `pane-state` → `process-state` to match the header; every pinned phrase in `instructions.test.ts` still holds, plus a new assertion that the clause names the column it is about.
- A **new pinned clause** teaches the two-states rule: the agent-state is what the agent is doing and answers the operator's question; the process-state says only that a process is running, and a pane can be process-active while its agent is stopped forever on a permission prompt. Lead with the agent-state. The evidence line is named so a "why" can be answered from tool output rather than invented.
- The same clause also says **do NOT volunteer the process-state for a pane whose agent-state already says it is stuck**. "Lead with" was not enough on its own: a run produced *"be-1 is waiting on a permission prompt, process looks active but not confirmed"* — both halves true, the `?` correctly hedged per the `b8bddef` clause — and the judge read the second half as a claim the pane was fine. A running process is not news about a stopped agent, so the reassuring half should not be offered at all. Speaking it when ASKED is still required to carry the hedge; the two clauses compose rather than compete.
- The `?` pin is now anchored to the RENDERER as well as the prose — it asserts `formatProcessStateColumn` actually emits the token the prompt quotes. A pin that only reads the prompt cannot notice the column that stopped producing the marker.

### Y5 — Stated rather than fixed

- **A non-claude TUI gets no behavioural reading.** `probeCageState` is claude-specific (it looks for `claude` in the pane's process tree), so a Codex / Cursor / Kimi pane renders `agent: ❔ no reading`. The classifier itself is NOT claude-specific — `ALT_AGENT_CHROME_RE` exists precisely for those panes, and `fleet_attention` classifies them fine. Closing the gap means a capture for non-claude members too, which is a second read of a pane this verb does not otherwise open; deliberately not smuggled into this change. `no reading` is the honest cell meanwhile — it must never render as anything that could be heard as "fine".
- **The `ctx` column's `—`** has the same read-aloud problem the cadence column's `—` had. Left alone: it was not among the residues W6 observed reaching the operator, and changing it is a separate legibility pass.
- **§Supplement-5 W7 is unchanged** — the `$HOME`+team-name-keyed reads and the one-level `ps` child walk are still ambient. Neither is touched here.

### Y6 — One more lie the full run exposed: `probeTeamLive`'s `"cage"`

Not part of the decision, found by running the whole suite rather than the one scenario, and fixed here because it is the same failure class the decision is about — a tool handing the model something to say that was never observed.

A team whose session is absent yields ONE synthetic observation. It carried `member: roster?.members[0]?.name ?? "cage"`, so `renderAttention` printed `vox-e2e-ghost/cage` and the model faithfully spoke *"member cage"*. The judge scored it a hallucination on `attention` AND `all_ok`, correctly: no such member exists. `members[0]` is the same lie with a plausible name — it attributes a whole-team fact to one arbitrary member, and on a real team it would name a member who is fine.

`PaneObservation.member` and `QuietItem.member` are now `string | null`, `null` meaning "this observation is about the TEAM, not an identified pane". `AttentionItem.member` was ALREADY `string | null` and `who()` already rendered a null member as the bare team name — the type was right and the producer was wrong. `fleet_quiet` never enumerates panes (D2), so nothing spoken is lost. `tests/unit/verbs/fleet.test.ts` asserted `${teamName}/cage` and so encoded the bug as the contract; it now asserts `${teamName} — session is down` and that the slash form is absent, with the history recorded in place.

### Y7 — The judge is not deterministic, and that is load-bearing

Measured while closing this: `--scenario drilldown` alone PASSED and the same build FAILED in a full three-scenario run, on wording the model chose differently. The `"cage"` hallucination appeared in one full run and not the previous one, with **identical tool output** both times.

So: **run the full suite, never the single scenario you changed**, and treat a red run as evidence of a real defect even when a green run of the same build exists. Both faults X6 and X3 fixed were found exactly this way and would have been hidden by a re-roll. Re-rolling until green is the same move as loosening a criterion — it makes the gate measure its own variance instead of the system.

### Y8 — Acceptance

`bun scripts/vox-e2e.ts` — all three scenarios, verbatim judge output — is recorded in [RUNBOOK-vox.md](../RUNBOOK-vox.md) §6.8. The `drilldown` scenario, left failing on purpose since §Supplement-5, is the gate this decision was taken to close; `attention` and `all_ok` are regression legs. No judge criterion, grading rule, or fixture was altered to reach it: the scenario table (`src/core/vox/e2e/scenarios.ts`) and the fixtures (`src/core/vox/e2e/fixtures.ts`) are byte-identical to the run that failed.

## Supplement-8 — team resolution stops requiring the LEADING segment (2026-08-20)

`resolveTeamName` (`src/core/vox/team-context.ts`) could not resolve a team by the part of its name a human actually says. Probed directly against an index holding `vox-e2e-alpha` and `vox-e2e-ghost`:

| spoken | before |
|---|---|
| `"alpha"` | `unknown` |
| `"ghost"` | `unknown` |
| `"the alpha team"` | `unknown` |
| `"vox"` | `ambiguous [vox-e2e-alpha, vox-e2e-ghost]` — correct |
| `"vox-e2e-alpha"` | `ok` |

### Z1 — Why the ladder was backwards for this fleet, specifically

The ladder ran exact → case-fold → strip `-root`/`-team` → **unique prefix** → Levenshtein ≤2. It had no suffix or segment rung, so **only a team's leading segment resolved.**

That is a defensible default for repo-shaped names (`sopx-root`, `crm-react`) and it is exactly wrong here. This fleet's teams are named `<product>-<feature>-<user>[-driver-N]` per [CLAUDE.md](../../CLAUDE.md) §Branch naming, deliberately, so that one snapshot identifier can be checked out across every submodule. The consequence for speech is that **the prefix is the shared, least distinctive part of the name and the trailing segment is the one a person says:**

| team | operator says | before |
|---|---|---|
| `px-crm-geoyws-driver-2` | "driver 2" | `unknown` |
| `atmux-geoyws` | "geoyws" | `unknown` |
| `vox-e2e-alpha` | "alpha" | `unknown` |
| any of `px-*` | "px" | `ambiguous` across every sibling |

So the one rung that could fire was the one guaranteed to collide, and the segments that identify a team uniquely were unreachable. A naming convention chosen for git correctness had silently set the voice surface's resolution up to fail.

### Z2 — How it surfaced, and the flakiness it explains

An e2e scenario failed with **`hallucinations: none`**. The model was behaving correctly — it asked rather than guessed, exactly as `instructions.ts` tells it to on `unknown_team` — and the tool had genuinely failed to resolve. Nothing in the transcript pointed at the resolver; the model's honesty is what made the defect legible instead of masking it as a bad answer.

It also explains an observed flake: **when the model OMITS the team argument the current-team default answers fine; when it PASSES `"alpha"` resolution fails.** Same build, two outcomes, split on whether the model volunteered an optional argument. That is the signature of a resolver gap, not a model gap, and it is worth naming because "flaky, sometimes the model gets it right" is how this class of defect gets written off.

### Z3 — The new rung, and why it is ONE rung

The ladder is now:

```
1. exact
2. case-fold
3. case-fold after stripping -root / -team from BOTH sides
4. unique prefix
5. segment run          <- new
6. Levenshtein <= RESOLVE_MAX_EDIT_DISTANCE (2)
```

Rung 5 matches when the normalized utterance is a **contiguous run of the name's `-`-separated segments**. Implementation is a boundary-anchored substring test — both name and needle are wrapped in `-`, so a plain `includes` can only match whole segments and `"e"` never hits `vox-e2e-alpha`.

**Placement, both ends.** BELOW prefix: a leading-segment match is the more specific claim and that rung's behaviour is already pinned by tests that predate this change. ABOVE Levenshtein: a segment run is an EXACT match on token boundaries, so letting a fuzzy whole-string typo match outrank a segment the operator actually pronounced would be strictly worse than the bug being fixed. The regression pin for the second half is `rung 5 (segment) beats rung 6 (Levenshtein)` — `"alpha"` against `[vox-e2e-alpha, alpht]`, where `alpht` is edit-distance 1.

**One rung, not two.** A separate trailing-segment rung sitting above an any-segment rung was considered and rejected. It would resolve `"crm"` against both `px-geoyws-crm` and `atmux-crm-tools` by preferring the one where the segment happens to be LAST — breaking a real collision on **position alone, a fact the operator never uttered.** Every other rung resolves on something that was said; that one would resolve on where a word sits in a string the operator never saw. It is a guess wearing a rung's clothes, and this module's whole posture (file header, [ADR-150](150-cross-team-complaints-routing.md) §D5) is ask-don't-guess. The cost is accepted deliberately: such a collision comes back `ambiguous` with both names and the operator says one more word. An extra rung is an extra chance to be confidently wrong.

### Z4 — Spoken filler: a second mechanism, kept deliberately distinct from `stripSuffix`

`normalizeSpoken` (new, exported) rewrites the **utterance**; `stripSuffix` rewrites a **name**. They are easy to confuse and are separate on purpose:

| | `stripSuffix` | `normalizeSpoken` |
|---|---|---|
| operates on | a hyphenated NAME | an UTTERANCE |
| applied to | BOTH sides of rung 3 | the spoken side only |
| removes | repo-naming noise (`-root`, `-team`) | English filler + word breaks |

`normalizeSpoken` case-folds, drops a possessive clitic (straight and curly apostrophe), drops a leading `the` and a trailing `team`/`teams`, and joins word breaks with `-` — **speech gives spaces where the name has hyphens**, which is what routes "driver 2" to `driver-2` and "px crm geoyws driver 2" to the whole name.

Two boundaries worth stating:

- **`-root` is NOT duplicated into the spoken filler set.** It is repo-naming noise, never an English word an operator speaks; duplicating it is exactly the confusing overlap the split exists to avoid. The one genuine overlap is `team`, which is both an English noun and a repo suffix — the two mechanisms agree there **by construction**, so `alpha`, `alpha-team` and "the alpha team" all reduce to the same thing.
- **Merging the two would apply article-stripping to real team names**, which is how a team called `the-hive` stops resolving.

Filler is only dropped while something is left to match — a team really can be called `team`. The guard is per-step, so `"the team"` normalizes to `"team"` (article gone, noun kept) rather than to nothing. A normalizer that can return the empty string is a rung that matches everything, so the rung additionally refuses to build a needle from an empty run; `"-"` and `"'s"` match NOTHING, including against a pathological name carrying an empty segment.

### Z5 — What did NOT change, and the pins that hold it

The ladder's core discipline is correct and is untouched: **the first rung with exactly one hit wins, and >1 hit on a rung returns `ambiguous` with the candidate names.** No result is collapsed into a best guess; no rung was reordered so a fuzzy match can beat an exact one. `RESOLVE_MAX_EDIT_DISTANCE` is still 2 and the fuzzy rung's behaviour is unchanged at distance 2 (resolves) and distance 3 (unknown).

Five regression pins in `tests/unit/core/vox/team-context.test.ts` exist solely to hold rung order — each builds an index where the segment rung would hit ≥2 names, so hoisting it above the rung under test turns a resolve into an `ambiguous`. They were mutation-verified, not assumed: hoisting the segment rung above rung 1 reddens 5 tests, demoting it below Levenshtein reddens 1, dropping the boundary anchoring reddens 3, and collapsing `ambiguous` into a first-pick reddens 8.

The honest consequence of a real fleet: **`"geoyws"` resolves only where that segment is unique.** Across `atmux-geoyws` + three `px-*-geoyws` teams it is `ambiguous` with all four candidates, and that is the right answer — the brief's table row is a statement about a fleet where the segment distinguishes, not a promise to pick one.

### Z6 — Not built

- **Number-words.** "driver two" does not route to `driver-2`; only the digit form does. A word→digit map is another normalization pass with its own collision surface (a team segment really can be `one`), and no evidence yet says ASR emits the word form here. Named rather than added.
- **`my` / `our` as leading filler.** Only `the` is stripped. Every word added to the filler set is a word the segment rung can no longer match, and a team can be named after a common word.
- **The voice path is unproven for this change.** Acceptance is the unit matrix; the e2e harness costs real API calls and its judge is non-deterministic (§Supplement-7 Y7), so it is run on the main loop, not here.


## Acceptance

`fleet_attention` / `fleet_quiet` are covered by **[RUNBOOK-voice.md](../RUNBOOK-voice.md) §7 V-20** (added 2026-08-16 — until then the daily-use half of the voice surface had no acceptance row at all). Four legs: the sweep is bounded, unreadable teams are reported rather than omitted, the attention list honours the top-N speech budget, and `fleet_quiet` aggregates without naming a pane. All four are headless-verified and confirmed by a live CLI sweep; the **voice tool path** around the shared classifier is explicitly recorded there as unproven.
