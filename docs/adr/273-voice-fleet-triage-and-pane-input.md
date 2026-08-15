# ADR-273 — Voice fleet triage and pane input ("what needs me?" + "type that")

Status: proposed
Date: 2026-08-15
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
3. **OQ-3 — what is the wall-clock bound for a full sweep, and is a cached-with-age answer acceptable?** A survey that takes forty seconds is not conversational; one that reports a two-minute-old cache may be reporting a pane that has since wedged. Likely answer is a short cache with the age spoken aloud, but it needs measurement against the real fleet first.
