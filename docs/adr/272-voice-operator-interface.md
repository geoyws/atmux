# ADR-272: `atmux voice` — a spoken operator interface (mobile PWA + provider-neutral realtime seam + verb-only tool bridge)

**Status**: proposed
**Date**: 2026-08-14
**Driver-ref**: operator-direct 2026-08-14 — a Jarvis-style voice assistant for the fleet: talk to atmux from a phone, hear back what the teams are doing, and move work along by speaking. The operating picture the design is built for is the operator away from the desk — walking, in a lift, in a car — wanting the same read of the fleet he gets from `atmux status`, plus the ability to nudge a lead, without opening a laptop.
**Relates**: [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) (the `AgentBackend` adapter — the precedent D4's provider seam copies in shape, and the ADR whose scope D1 draws a boundary against), [ADR-260](260-manual-orchestration-mode-default.md) / [ADR-237](237-no-llm-discord-and-whip-removal.md) (the "no LLM in atmux's own loop" line — D1 explains why an operator interface is on the other side of it), [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) (no boot autostart, nothing heavy at reboot — the constraint D10's supervision shape obeys), [ADR-033](033-kanban-driver-only-flag.md) (the `ATMUX_CALLER_SCOPE=driver` gate D3 grants deliberately), [ADR-271](271-sqlite-sole-store-rust-orchd-coordinator.md) (`state.db` is the sole store, and its D3 hazard — the `{ create: true }` footgun D2 makes structurally unreachable), [ADR-126](126-sqlite-state-store.md) (SQLite canonical), [ADR-245](245-singleton-atmux-per-project.md) (one `.atmux/` per project — the resolution the tool bridge inherits by going through verbs), [ADR-268](268-managed-repo-state-isolation-enforcement.md) (managed-repo state isolation — why no voice artifact is written into a product repo), [ADR-244](244-per-repo-pre-commit-kanban-decisions-snapshot.md) / [ADR-239](239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §Supplement-2026-05-26 (operator-private state residency), [ADR-044](044-driver-session-on-default-socket.md) (the driver session on the default socket — the tier D10's `atmux-voice` session joins), [ADR-162](162-atmux-owns-tmux-infrastructure.md) (atmux owns its tmux infrastructure — the cockpit/cage socket split D10 stays out of), [ADR-135](135-cockpit-naming-convention.md) (cockpit window-name contract — the reconcile pass D10 avoids being pruned by), [ADR-264](264-cockpit-session-atx-rename.md) / [ADR-265](265-atx-canonical-shorthand.md) (the `atx` cockpit session name D10 must not collide with), [ADR-266](266-shim-sunset-policy-and-first-sweep.md) (sunset discipline — the phase-gated flags in §Security carry expiries), [ADR-192](192-cron-arm-idempotency-contract.md) (cron-arm idempotency — why D10 is a supervised session, not a cron arm), [ADR-009](009-auto-rotation.md) §2 + [ADR-254](254-coverage-gate-completeness.md) (the 100%-on-tracked-paths gate D9 refuses to widen), [ADR-217](217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D5 (the `templates/` staging pattern D9 reuses), [ADR-203](203-event-topic-taxonomy.md) (closed event-topic set — deliberately NOT amended; see §Deferred, proactive narration).

---

## Context

### What atmux has today, and what it does not

atmux's operator surface is a terminal. `atmux status`, `atmux pulse`, `atmux report`, `atmux tell-lead`, `atmux task` — every one of them assumes a keyboard and a shell. The cockpit ([ADR-162](162-atmux-owns-tmux-infrastructure.md), [ADR-264](264-cockpit-session-atx-rename.md)) assumes a terminal emulator wide enough to read panes in. There is no remote read path at all: **atmux has no HTTP surface** — [ADR-261](261-issue-sync-external-tracker-ingestion.md) §Context states it plainly, and its issue-sync design pays a real cost (outbound polling only, no webhooks) to keep it that way.

The consequence is a hard availability floor. Away from the desk, the operator's read of the fleet is zero, and his ability to unblock a stalled lead is zero. Under [ADR-260](260-manual-orchestration-mode-default.md) — manual orchestration is the fleet default, verified in [ADR-271](271-sqlite-sole-store-rust-orchd-coordinator.md) as 20 of 20 `team.json` files — **the operator and the lead LLMs are the coordination mechanism.** An operator who cannot be reached is not a missing convenience; he is a missing scheduler. That is what this ADR addresses, and it is why the feature is worth a WebSocket server in a codebase that has deliberately avoided one.

### Prior art: `/root/work/src/convoke`, and what it teaches

`/root/work/src/convoke` is an abandoned attempt at the same idea, built on discrete STT → LLM → TTS rather than a realtime bidirectional stream. It is a **cautionary corpus, not a starting point**, and its four client-side audio defects are recorded here because every one of them is a design constraint on the new client. All four verified in-source on 2026-08-14 in `public/index.html`:

| # | Defect | Site | Why it is fatal on a phone |
|---|---|---|---|
| 1 | `createScriptProcessor(4096, 1, 1)` | `:250` | `ScriptProcessorNode` is deprecated and runs on the **main thread**. Any UI work — a re-render, a chip animation — drops audio frames. The replacement is an `AudioWorklet` on the audio render thread. |
| 2 | `getUserMedia({ audio: { sampleRate: 16000 } })` then raw `getChannelData()` | `:244`, `:255-258` | `sampleRate` is an **advisory constraint**; iOS Safari ignores it and delivers the hardware rate (48 kHz). The code then ships those samples labelled as 16 kHz. The server receives 48 kHz PCM interpreted as 16 kHz — audio at one-third speed, an octave and a half down. **There is no resampler anywhere in the client.** |
| 3 | `decodeAudioData(arrayBuffer, …)` on the inbound stream | `:228` | `decodeAudioData` decodes **container formats** (WAV, MP3, AAC) — it requires a header. Raw PCM16 has none, so every inbound frame lands in the error callback at `:233`. Downlink audio never played. |
| 4 | `new AudioContext()` constructed inside `playAudio()` | `:225` (and again at `:248`) | The context is created on the **inbound-audio** path, i.e. outside any user gesture. iOS starts such a context `suspended` and never resumes it. Even with defect 3 fixed, nothing would be audible. |

Defects 2 and 4 are iOS-specific and would both pass a desktop-Chrome test. That is the single most important lesson in the table: **the acceptance criteria for this feature are on a phone, not on a laptop** — which is why §Verification in [docs/RUNBOOK-voice.md](../RUNBOOK-voice.md) splits headless checks from phone checks and refuses to treat the headless set as sufficient.

Convoke's deployment shape is the fifth lesson: `deploy/convoke.service` is a systemd unit for a project that no longer runs. A dead unit file that survives its project is exactly the boot-time residue [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) was written after a load-27 boot storm to prevent. D10 is shaped by that.

**One rule from convoke is kept, and it is the important one: voice never reaches a shell directly.** Convoke's tools were bounded, named operations, not a `bash` passthrough. D2 hardens that from a convention into a structural property.

### Why this is not a violation of "atmux doesn't speak any AI provider API"

`docs/ARCHITECTURE.md` §Principles item 1 reads: *"tmux is the IPC. atmux doesn't speak any AI provider API."* The principle is real and load-bearing, and a WebSocket to OpenAI or Google appears to contradict it head-on. It does not, and D1 states the boundary rather than leaving a future reader to litigate it.

---

## Decision

### D1 — The operator-interface carve-out: principle #1 governs the *orchestration* seam; voice is an *operator* seam

`docs/ARCHITECTURE.md` §Principles item 1 is a claim about **how atmux drives agents**. Its whole content is that atmux writes into a TUI and reads pane output, so any coding-agent TUI works and no vendor SDK is on the orchestration path. That line has been maintained deliberately: [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) introduced `AgentBackend` (`src/abstractions/agent-backend.ts`) precisely so that a vendor SDK, if ever added, sits behind an adapter rather than in the core; [ADR-237](237-no-llm-discord-and-whip-removal.md) removed the LLM whip cadence so no model call happens on a timer inside atmux; [ADR-260](260-manual-orchestration-mode-default.md) went further and made the LLMs external drivers of the kanban.

**Voice sits on the other side of that seam.** The realtime provider does not orchestrate anything, does not spawn a member, does not appear in any brief, and is invisible to every team. It is a **transducer between the operator's voice and the atmux CLI** — the operator's own interface, in the same category as his terminal emulator or his SSH client. atmux is not calling a provider to *do its job*; it is calling a provider so a human can *give it instructions by speaking*. Removing the voice server removes a way for George to talk; it removes no capability from atmux.

Stated as the invariant a reviewer can enforce, so the carve-out cannot widen by drift:

> **Import fence.** `src/abstractions/voice/**` is importable **only** from `src/core/voice/**` and `src/verbs/voice.ts`. No orchestration module — nothing under `src/core/orchd*`, `src/core/spawn*`, `src/abstractions/backends/**`, or any member/lead/reviewer path — may import it, directly or transitively. Any future need for a provider call on the orchestration path is [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md)'s business and needs its own ADR, not this one's precedent.

A lint check pins the fence (§Consequences). `docs/ARCHITECTURE.md` §Principles item 1 gains a same-commit sentence citing this ADR, so the principle and its one carve-out are read together and no future reader finds an apparent contradiction with no explanation.

### D2 — Verb-only capability: every voice tool is an `atmux` verb invocation

The tool bridge does not import `src/core/kanban.ts`, does not open a `Database`, and does not shell out to `tmux`. It builds an argv and runs the atmux CLI. This is the load-bearing security decision, and it is stated as a property rather than a guideline because the properties fall out of it for free:

1. **The `state.db` auto-create footgun is unreachable.** `src/abstractions/sqlite.ts:33` opens `{ create: true }` — the hazard [ADR-271](271-sqlite-sole-store-rust-orchd-coordinator.md) §D3 exists to guard against, where a stray open on a team with no DB manufactures an empty one and makes a populated store invisible. A bridge that never calls `openDatabase` cannot trigger it. It also inherits ADR-271 §D3's refusal, and [ADR-245](245-singleton-atmux-per-project.md)'s one-kanban-per-project resolution, without restating either.
2. **The driver-pane send-keys guard and the [ADR-033](033-kanban-driver-only-flag.md) caller-scope gates apply unchanged.** They live in the verbs (`src/core/common.ts:933`, `src/verbs/orchd.ts:800`, `src/verbs/team/dissolve-worker.ts:104-105`). Going through the CLI means the voice path is gated by the same code the operator's own shell is gated by — not by a parallel implementation that can drift.
3. **The blast radius is enumerable by reading one file.** The tool catalog is the complete list of things a voice session can do. There is no escape hatch, no `run_command`, no `eval`.

**No shell interpolation, ever.** Tools are invoked with an argv array through the spawn abstraction — never a composed command string, never `sh -c`. A speech-recognition transcript is untrusted input from a noisy channel; it must not be able to become a shell token. Arguments are validated against a per-tool Zod schema before the argv is built, and a validation failure is a spoken error, not a best-effort call.

**Delete `src/core/voice/**` and the operator loses a microphone, not a power.** Every capability voice exposes is reachable from the operator's terminal today and remains so.

#### D2 §Supplement — a CLI flag is a shell token one layer up (2026-08-15)

"No shell interpolation" closes the shell. It does **not** close the CLI. An argv array is safe from `sh`, but `atmux`'s own `parse*Args` functions read a `-`-prefixed token as a **flag**, so a model-supplied string dropped into a bare positional slot is reinterpreted exactly the way a shell metacharacter would be. Two escapes were live and are the reason this supplement exists:

| Spoken call | argv built | What the verb actually did |
|---|---|---|
| `claim_task(task_id="--next", member="x")` | `["--next", "--as", "x", …]` | `parseClaimDoneArgs` sets `next=true`; `claim` routes to `claimNext()` and claims **whatever is next in the lane**, not the task the operator named. |
| `dispatch_task(member="be-1", task_id="--socket")` | `["be-1", "--socket", "--team-dir", "<root>"]` | `parseDispatchArgs` eats `--team-dir` as the **socket value** — the dispatch is aimed at an attacker-named tmux socket **and** silently loses its team scope, falling back to the voice server's cwd team. |

**The invariant.** Every catalog argument is classified by the argv slot it can reach, and each slot carries an obligation:

| Slot | Obligation | Why it holds |
|---|---|---|
| **positional** (bare token) | MUST use the shared `positionalParam` validator, which rejects a leading `-` **or leading whitespace** | Every parser in the runner map treats a bare `-`-prefixed token as a flag. Whitespace is rejected too so that a parser which ever learns to `.trim()` cannot route around the dash check; none trims today. |
| **flag-value** (after `--flag`) | No dash guard required | Every parser takes `argv[i + 1]` unconditionally, so a dash-led value is read as data. Re-proved against the real parsers by test, not assumed. |
| **terminated** (after `--`) | Runner's parser MUST honour `--` | True of `parseTellLeadArgs` and `parseAddArgs` only. Free text stays free there — an operator genuinely says "-urgent". |
| **absent** | none | `team` resolves through the team index to a trusted root; `limit` is consumed by the bridge; `confirm_token` is stripped before argv. |

**`--` is not added to `parseDispatchArgs` / `parseClaimDoneArgs`, and this is a decision, not an omission.** Both end their flag chain with `if (a?.startsWith("-")) throw UsageError` and have no `--` case, so an appended `--` would not be inert — it would hard-fail every call with `unknown flag: --`. Teaching them the terminator is a change to verbs the entire team system drives (`claim --next` is the pull model's core loop), and that regression risk dominates the redundancy it would buy. The schema guard is therefore the **complete** fix for those two parsers.

**The guard is structural, not a reject-list.** `auditArgvSlots` derives each argument's real slot from the entry's own argv builder — probing the full arg set *and* the reduced sets, because an absent optional argument shifts the positional slots after it (`dispatch_task` is `[member?, task_id, …]`). The catalog test enumerates the catalog, demands a sample for every tool and every string argument, and fails if any argument reaching a positional slot lacks the guard. A future tool cannot reintroduce the class by being added; it fails the gate on the way in. This is how `member_pane` was found — nobody reported it, and the sweep named it anyway.

**The guard cannot leak into the provider schema.** `positionalParam` is a `.regex()`, which raw JSON Schema renders as `pattern` — not a legal key in D6's flat contract. `toolJsonSchema`'s whitelist post-pass drops it, and a test asserts no `pattern` survives for any entry.

### D3 — The server runs as the driver, and that is a real privilege grant

The voice server sets `ATMUX_CALLER_SCOPE=driver` in the environment of every verb it invokes. This is stated in the Decision section, not buried in an implementation note, because it is the single most consequential line in the feature.

The operator **is** the driver ([ADR-260](260-manual-orchestration-mode-default.md): the human and the lead LLMs are the coordination mechanism), so a voice session that could not act as the driver would be able to read the fleet and change nothing — half a feature. But it means **anyone who reaches the WebSocket is the driver.** Not a member, not a read-only observer: the driver, with the caller-scope gates of [ADR-033](033-kanban-driver-only-flag.md) already satisfied.

That is why the authentication in §Security is triple-layered rather than "a token is fine", and why D6's v1 surface is deliberately narrow. The grant is the reason for the caution; the caution is not decoration.

### D4 — Provider-neutral seam: `VoiceProvider` / `VoiceSession`, no native frames past the adapter

`src/abstractions/voice-provider.ts` declares two types and nothing else — **types-only, zero runtime**, following the `src/abstractions/agent-backend.ts` precedent set by [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md):

- **`VoiceProvider`** — a factory: `connect(config) → Promise<VoiceSession>`.
- **`VoiceSession`** — the neutral duplex: send canonical audio, send a tool result, receive neutral events (`audio` / `transcript` / `tool_call` / `error` / `closed`), close.

**No provider-native frame shape crosses the adapter boundary in either direction.** OpenAI's `response.audio.delta` and Gemini's `serverContent.modelTurn` are both translated inside their adapter into the same neutral event before anything else sees them. The core, the tool bridge, the wire protocol, and the client know only the neutral shape. The concrete test of this decision is V-7 in [docs/RUNBOOK-voice.md](../RUNBOOK-voice.md): **swapping `ATMUX_VOICE_PROVIDER` from `openai-realtime` to `gemini-live` must require zero client-side diff.** If a client change is needed, the seam leaked and the adapter is wrong.

**Provider selection is resolved once, at session construction, from `ATMUX_VOICE_PROVIDER`.** There is no hot-swap and no mid-session fallback: a provider change takes effect on the next session. Mid-session failover would have to reconcile two different conversation-history models and two different audio negotiations while the operator is mid-sentence, and the honest failure mode — the session ends, the operator redials — is better than a half-migrated session. (History resume across a redial is explicitly deferred; see §Deferred.)

### D5 — Canonical audio is PCM16LE mono 24 kHz in **both** directions

One format, chosen so the phone never performs a lossy or fractional operation.

| Leg | Rate | Conversion | Where |
|---|---|---|---|
| iOS/Android mic → canonical | 48 kHz → 24 kHz | **exact 2:1 decimation** (integer ratio, anti-aliased) | on-phone, in the `AudioWorklet` |
| canonical → OpenAI Realtime | 24 kHz → 24 kHz | none — passthrough | adapter |
| canonical → Gemini Live | 24 kHz → 16 kHz | rational 2:3 resample (×2 then ÷3 — exact, no fractional-delay interpolation) | **server-side**, in the adapter |
| provider → canonical (both) | 24 kHz → 24 kHz | none — **byte-for-byte relay** | adapter |

**Why 24 kHz and not 16 kHz.** 48 → 24 is an exact halving; 48 → 16 is a 3:1 decimation that is also exact, but choosing 16 kHz as canonical would push the *irreversible* quality decision onto the phone, where it is made once and cannot be undone. At 24 kHz canonical, the OpenAI path never resamples at all and the Gemini path's downsample happens **on the server**, where CPU is free and the input is already clean. **Quality is never destroyed on the device.** This is the direct fix for convoke defect 2, which shipped a rate mismatch precisely because the client assumed it controlled the rate.

**Wire framing** — a 4-byte header, then payload:

```
byte 0    magic     0xA1   = PCM16 canonical, protocol v1
byte 1    flags     bit0 TURN_END      (final frame of an utterance)
                    bit1 SYNTHETIC     (server-generated, e.g. a confirmation prompt)
                    bits 2-7 reserved, MUST be zero
bytes 2-3 seq       uint16 LE, wraps at 65536 — gap detection, not reordering
bytes 4+  payload   PCM16LE mono 24 kHz
```

**Uplink frames are 40 ms = 960 samples = 1920 bytes payload + 4 header = 1924 bytes.** 40 ms is the smallest frame that stays comfortably under a mobile radio's wake threshold while keeping barge-in latency imperceptible. A magic byte that is not `0xA1` is a protocol error and closes the session — a version mismatch must be loud, because the failure mode it prevents is a client speaking v1 to a v2 server and producing noise instead of an error. Control messages are JSON text frames; audio is binary frames. The two never mix.

### D6 — v1 tool surface: 10 read tools, 4 messaging tools, nothing destructive

**Read (10)** — no confirmation, no side effects:

`list_teams` · `fleet_overview` · `team_status` · `team_health` · `list_tasks` · `member_pane` · `driver_inbox` · `lead_outbox` · `cost_report` · `list_blockers`

**Messaging (4)** — two append-only, two confirm-gated:

| Tool | Gate | Why |
|---|---|---|
| `tell_lead` | none | Append-only to the lead inbox. The worst case is a lead reading a garbled sentence; it destroys nothing and matches what the operator already does from a terminal without ceremony. |
| `add_task` | none | Append-only. A spurious task is visible, editable, and removable. Making the common case ("remind the team to check the deploy") require a confirmation round-trip would make the feature tiring to use, which is its own failure. |
| `dispatch_task` | **confirm** | Assigns work to a named member — it changes what a member does next. |
| `claim_task` | **confirm** | Changes ownership. Wrong under a misheard member name. |

**`post_reply` is cut from v1.** The operator **is** the driver; a driver posting a reply into his own inbox is a loop with no reader. It is not deferred pending a decision — it is removed because the role model makes it meaningless.

**No `spawn`, `stop`, `kill`, or any git verb in v1.** These are the operations where a misheard word is unrecoverable, and they are the ones a phone is worst at confirming. They are deferred to their own ADR, which inherits D7's confirmation machinery rather than inventing a second one (§Deferred).

### D7 — Mutation confirmation is enforced by the **server**, not by prompt instruction

This is a correctness decision, not a UX one. Instructing a model to "always confirm before mutating" is a request, not a constraint: it degrades under a long session, an adversarial transcript, or a provider-side prompt change. The mechanism:

1. A confirm-gated tool call **does not execute**. It returns a **preview** — the human-readable action, its resolved arguments, and a single-use **confirmation token**.
2. The token is `sha256(tool_name ‖ canonical_json(args) ‖ session_id)`, truncated to a short spoken-safe form, held server-side with a TTL (`ATMUX_VOICE_CONFIRM_TTL_MS`, default 120000).
3. The model reads the preview aloud and waits.
4. Only a **clear affirmative** redeems the token — the tool is re-invoked with the token, the server verifies it matches the current session and has not been redeemed or expired, executes, and **burns the token**.

**Argument-binding is what makes this real.** Because the token hashes the canonical arguments, a token minted for `dispatch_task(task=t-abc, member=driver-2)` cannot be redeemed for `dispatch_task(task=t-abc, member=driver-3)`. The model cannot confirm one action and perform another, whether by error or by transcript corruption. Single-use prevents a redeemed confirmation from being replayed; the TTL prevents a token left over from a dropped call being redeemed after a resume.

Spawn/stop, when they land, use **this** machinery plus a second factor (§Deferred) — the confirmation layer is built once, here, and inherited.

**Clarification (2026-08-14, from the P4 adversarial review).** The heading is broader than what the server actually enforces, so be precise about which half is a constraint and which is still a request. **Server-enforced:** the token's existence, its argument/tool/session binding, its TTL, its single-use burn, and the refusal to execute a gated tool without a valid token. Those cannot be talked around — verified under mutation, where removing the burn, the binding check, the TTL check, the session component, or the gate itself each failed a test. **Not server-enforced:** the *affirmation* itself. Step 3 and the "clear affirmative" judgment in step 4 are the model's — the token is handed to the model inside the preview envelope, and nothing server-side observes the operator saying yes. A model that redeemed its own token without speaking the preview would not be stopped by the server; it would only be stopped by the fact that the operator never heard a preview and would notice.

This is the same deliberate split as D4's provider-side tool-call judgment: the model decides *whether* to act, the server decides *what is permitted*. Recorded because "enforced by the server" invites a reader to assume the affirmation is a hard gate. It is not, and the difference matters when P7 clears `ATMUX_VOICE_READONLY` and the mutating tools become reachable — at that point the operator's ear is the only check on step 3.

### D8 — One session, latest-wins takeover, 90-second resume park

**Exactly one active voice session per server.** No multi-session, no queue. Two live sessions would let two conversational contexts issue driver-scope mutations with no serialization between them, and the operator is one person.

- **Takeover is latest-wins.** A new authenticated connection displaces the existing one, which is closed with an explicit reason. Rationale: the realistic cause of a second connection is the *same operator* on a second device or after a browser reload — refusing him access to his own assistant because a zombie tab holds the slot is the worse failure.
- **A dropped phone parks the provider leg for `ATMUX_VOICE_RESUME_GRACE_MS` (default 90000).** This is the walking-into-a-lift case, and it is the difference between a usable assistant and a toy: signal drops for 20 seconds and the conversation survives. Reconnecting within the window with `hello.resume` and a matching session id re-attaches to the **same** provider session, with its history intact. After the window the provider leg is torn down and the next connection is a fresh session.
- **Mic audio buffered during a disconnect is discarded, never replayed.** Frames captured while the socket was down describe a moment that has passed; replaying them into a resumed session injects stale speech into a live conversation — the model would answer a question the operator has already stopped asking. Discard is correct, and it must be explicit so no future implementer "improves" it into a buffer flush.

### D9 — Client assets live in `templates/voice/`, and the coverage gate is not widened

The PWA is **vanilla ESM with no build step** — no bundler, no transpile, no `node_modules` at runtime. It ships as static files under `templates/voice/`, staged by the existing `templates/` copy in `build:install` (`package.json:27` — `cp -r templates /opt/atmux/$npm_package_version/templates`) and located at runtime by `resolveTemplatesDir()` (`src/core/templates-dir.ts:49`), which already resolves install-mode `/opt/atmux/<v>/templates/` versus dev-mode `<repo>/templates/`. This is the [ADR-217](217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D5 staging pattern, reused rather than reinvented; it also means dev and compiled builds are served from one code path, which V-1 checks in both modes.

**The coverage consequence is the point of putting the assets there.** `bunfig.toml:32-37` sets `coveragePathIgnorePatterns` to exactly four entries — `src/types/generated/**`, `**/index.ts`, `tests/**`, `**/*.fixtures.ts`. Browser code cannot be unit-tested under `bun test` without a DOM and a `WebAudio` shim, so client code inside `src/**` would force a fifth exclusion, and the cheapest way to satisfy a coverage gate is always to widen its denominator. **`templates/` is outside the `src/**` lcov universe by construction**, so the client is out of the denominator because of where it structurally belongs, not because it was excused.

**Binding, and reviewer-enforced:** every new file under `src/**` in this feature carries 100% line/function/statement/branch coverage per [ADR-009](009-auto-rotation.md) §2 and [ADR-254](254-coverage-gate-completeness.md), and **`coveragePathIgnorePatterns` gains zero new entries.** A coverage gate that goes green because the measurement was loosened is not a gate.

### D10 — Supervision: a dedicated detached `atmux-voice` tmux session, not a cockpit window, not a cage, not systemd

`atmux voice --supervise` creates (or re-attaches to, idempotently) a **detached tmux session named `atmux-voice` on the default socket** and runs the server inside it under a crash-loop wrapper: `trap` on exit, 5-second backoff between restarts, and a **circuit breaker at 5 restarts within 60 seconds** that stops retrying and leaves the failure visible in the pane rather than hiding it in a restart loop.

Each rejected alternative is rejected for a specific, checkable reason:

- **Not a cockpit window.** The cockpit reconcile pass performs an **orphan-prune**: `src/verbs/cockpit.ts:1971-2041` computes the set of wanted window names and prunes everything else (`action: "prune-orphan"`). A voice window in the `atx` session ([ADR-264](264-cockpit-session-atx-rename.md)) is not in that set and would be killed by the next reconcile — silently, and at the worst possible moment. Adding it to the wanted set would make a per-operator feature part of the fleet-wide cockpit contract ([ADR-135](135-cockpit-naming-convention.md)), which it is not.
- **Not a cage window.** Cages are per-team, on path-explicit sockets ([ADR-162](162-atmux-owns-tmux-infrastructure.md)). Voice is fleet-wide and belongs to no team; putting it in one team's cage would tie the operator's microphone to that team's lifecycle — `atmux stop` on an unrelated team would end the call.
- **Not systemd, and not a unit file in this repo.** [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) is unambiguous that nothing atmux ships starts at boot; the operator's standing position in that ADR is verbatim *"atmux should never start when the server restarts. it is way too heavy."* Convoke's `deploy/convoke.service` is the cautionary tale — a unit file that outlived its project. A tmux session dies with its server and starts only when the operator asks, which is the same lifecycle property `PR_SET_PDEATHSIG` gives orchd.
- **Not a cron arm.** [ADR-192](192-cron-arm-idempotency-contract.md) governs recurring arms; a supervised long-lived process is not a cadence and creates no scheduler artifact, so it is outside that contract by construction.

**Name-collision check.** `atmux-voice` on the **default** socket cannot collide with the cockpit (session `atx`, on the dedicated `atmux-cockpit` socket per [ADR-162](162-atmux-owns-tmux-infrastructure.md)) and cannot collide with a team cage named `voice` (cages are `atmux-<team>` on a **path-explicit** per-team socket, not the default one). It shares the default socket with the driver session ([ADR-044](044-driver-session-on-default-socket.md)) as a sibling, which is the correct tier: the voice server is operator infrastructure, exactly like the driver's own shell.

### D11 — No service worker in the PWA. This is a stated non-goal, not an omission

A service worker is the obvious "make it a real PWA" move and it is refused on purpose.

The client and the server share a versioned binary protocol (D5). A service worker's entire job is to serve a **cached** `app.js` — which means the one failure mode it reliably produces is a phone speaking last week's protocol to today's server, on a page the operator cannot fix by reloading, at the exact moment he is away from a laptop. The symptom is silence or garbled audio, not an error message, and the fix requires clearing site data on a phone.

The PWA still installs to the home screen (manifest, icons, `display: standalone`) — installability does not require a service worker. **What is given up is offline capability, which is worthless here**: the app's only function is to hold a live WebSocket to a server on hax. An offline voice assistant has nothing to say.

If a future decision wants caching, it must ship a protocol-version check that hard-refuses a stale client with a spoken error — and that is its own ADR.

---

## Security

The threat model follows directly from D3: **reaching the WebSocket means acting as the driver.** Layers, outermost first:

1. **nginx `oauth2-proxy` (phase O2).** The vhost sits behind an OAuth2 proxy so an unauthenticated request never reaches the Bun server at all. **This is phase O2, not phase O1** — the first deploy (O1) is token-only, and that gap is closed by `ATMUX_VOICE_READONLY=1` (layer 5) plus the fact that the token is the only way in. The phase boundary is recorded here rather than glossed, because "there is an OAuth layer" is only true after O2 lands.
2. **`?token=` query parameter, checked *before* the WebSocket upgrade.** `ATMUX_VOICE_TOKEN` is required, must be **≥32 characters**, and the server **refuses to start** without one — no default, no generated-and-printed fallback. Comparison is **timing-safe**. The check runs before the upgrade so an unauthenticated peer never gets a socket. **`access_log off` is mandatory on the WebSocket location**, because a token in a query string is otherwise written to disk on every connection; V-6 asserts the token is absent from the access log.
3. **`hello.token` re-assertion + `Origin` allowlist.** The first application-level message must re-assert the token, and the `Origin` header must be in `ATMUX_VOICE_ORIGINS`. The Origin check is what blocks **cookie-riding CSRF**: browsers do not apply the same-origin policy to WebSocket handshakes, so once layer 1 sets a session cookie, *any* page the operator visits could open a socket to the voice server and inherit his authenticated session. An Origin allowlist is the defense; without it, layers 1 and 2 combined are insufficient.
4. **Loopback bind.** The server binds `127.0.0.1` by default (`ATMUX_VOICE_HOST`). Only nginx can reach it, so layers 1–3 cannot be bypassed by addressing the port directly. **Binding `0.0.0.0` needs its own ADR** — it removes the assumption every other layer is designed against, and must not be reachable by setting an env var without a recorded decision.
5. **`ATMUX_VOICE_READONLY=1` — the first-deploy kill switch.** Set, the tool bridge exposes only D6's 10 read tools; the 4 messaging tools are absent from the catalog, not merely refused at call time. This is the setting the feature **first ships in**, so the deploy, the nginx route, and the phone client are all proven before any mutation is possible. It carries a `SUNSET` marker per [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D1 and is cleared in phase P7.

**API keys never leave hax.** The transport is a **server relay** — phone ↔ our WebSocket ↔ provider WebSocket — specifically so that `OPENAI_API_KEY` / `GEMINI_API_KEY` are read from the operator's git-crypt'd dotfiles env and used only for the server→provider leg. The alternative (an ephemeral client token minted for a direct phone→provider connection) was rejected: it puts provider credentials on a device, and it moves the tool bridge to the client where D2's verb-only guarantee cannot hold.

**A unit test asserts the key set of every client-bound frame.** The `ready` frame in particular is the one that echoes session configuration back to the client, and it is the natural place for a key to leak by accident. The test asserts an exact allowlist of keys — not a substring scan for the key value, which would pass trivially on a fixture with a fake key.

**No voice artifact is written into any managed product repo** ([ADR-268](268-managed-repo-state-isolation-enforcement.md), [ADR-244](244-per-repo-pre-commit-kanban-decisions-snapshot.md)). Session state is in-memory and dies with the session; logs go to the voice server's own log path.

---

## Deferred

Explicitly out of v1. Each names what it needs, so a future implementer does not read "deferred" as "just add it".

- **`spawn` / `stop` / `kill` tools.** Need D7's confirmation **plus a second factor** — a spoken passphrase or a code echoed from another channel. A misheard team name that stops the wrong team is unrecoverable by talking. Their own ADR; they inherit D7's token machinery unchanged.
- **Proactive narration** (the assistant speaking unprompted when something happens). Needs a `watchEvents()` subscription, a **rate limit**, and a **don't-interrupt policy** — an assistant that talks over the operator, or narrates 40 events during a merge sweep, is worse than silence. It would also likely need an event topic, and [ADR-203](203-event-topic-taxonomy.md)'s topic set is closed and deliberately **not** amended here.
- **Wake word.** Requires always-on mic capture, which is a different privacy posture and a different battery profile. v1 is push-to-talk.
- **Conversation-history resume across a provider redial.** D8's 90-second park resumes the *same* provider session. Carrying history into a *new* provider session means replaying a transcript into a fresh context — provider-specific, and it interacts with cost in ways worth measuring first.
- **Multi-session / multi-device concurrency.** D8 is one session by design. Concurrency needs a serialization story for driver-scope mutations.
- **A per-session cost tool.** `cost_report` in D6 reports **fleet** cost from existing atmux surfaces. Attributing realtime-audio spend per voice session needs provider usage plumbing the seam does not yet carry.

---

## Consequences

**Positive**

- **The operator's read of the fleet stops being zero when he is away from the desk.** Under [ADR-260](260-manual-orchestration-mode-default.md)'s manual default, that is a coordination capability, not a convenience.
- **The blast radius is a readable list.** D2 + D6 mean "what can the voice assistant do?" is answered by one catalog file, and every entry is a verb the operator can already run. There is no path from a transcript to a shell.
- **Provider risk is contained to one adapter.** D4's seam plus V-7's zero-client-diff acceptance means a provider outage, a pricing change, or a deprecation is an adapter swap. This is the same insurance [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) bought on the orchestration side, bought again on the operator side for the same reason.
- **The coverage gate is honored without widening it.** D9's `templates/` placement means zero new `coveragePathIgnorePatterns` entries and 100% on every new `src/**` path.
- **Convoke's four client defects are designed out, not rediscovered.** `AudioWorklet` over `ScriptProcessorNode`; explicit on-device 2:1 decimation over an advisory `sampleRate` constraint; raw-PCM playback over `decodeAudioData`; `AudioContext` created and resumed inside the first user gesture.

**Negative / risks, stated plainly**

- **atmux gains a listening socket.** [ADR-261](261-issue-sync-external-tracker-ingestion.md) §Context recorded "no inbound HTTP" as a property worth paying for, and this ADR spends it. The mitigations are the five layers in §Security, the loopback default, and read-only first deploy — but the honest statement is that the attack surface grew from zero to one port, and it is a port whose holder is the driver.
- **A misheard word can dispatch work.** D7 gates the two riskiest messaging tools and D6 keeps `tell_lead` / `add_task` ungated as a deliberate usability trade. Both ungated tools are append-only and visible; neither deletes or reassigns anything. If practice shows spurious tasks are a real nuisance, the fix is to move `add_task` behind D7 — one catalog flag, no new machinery.
- **Provider dependency is real even behind the seam.** D4 keeps the *code* neutral; it does not make the *feature* work without a provider. No provider reachable means no voice — there is no offline degradation path, and D11 removes even the illusion of one.
- **The realtime audio bill is per-minute and not yet measured.** A long idle session costs money for silence. v1 has no per-session cost tool (§Deferred), so early usage should be watched from the provider console rather than assumed cheap.
- **Phone acceptance cannot be automated in this repo.** V-9…V-16 in the runbook are hand-run on a physical device. Two of convoke's four defects would have passed a desktop-Chrome suite, so a green headless run must never be reported as "voice works" — the runbook's split exists to make that misreport hard.
- **One more long-lived process on hax.** D10's session is operator-started and dies with its pane; it adds nothing at boot ([ADR-233](233-cron-auto-install-disabled-trust-orchd.md)). But it is a process that can be forgotten while running, which is why `atmux voice --status` and `--stop` are part of the verb surface rather than an afterthought.
- **The import fence needs enforcement, or D1's carve-out erodes.** A fence stated only in an ADR is a convention. A lint check over `src/**` imports of `src/abstractions/voice/**` ships with the feature; without it, the first orchestration module that imports the provider seam turns a bounded carve-out into a general precedent.

**Reversibility: HIGH.** Removing this ADR = delete `src/verbs/voice.ts`, `src/core/voice/**`, `src/abstractions/voice-provider.ts` + `src/abstractions/voice/**`, `templates/voice/`, the nginx vhost, and the `atmux-voice` tmux session. No schema change, no migration, no event topic, no change to any existing verb's behavior, nothing written into any managed repo. The tool bridge only *calls* verbs; it does not modify them.

---

## Out of scope

- **Re-deciding `docs/ARCHITECTURE.md` §Principles item 1 or [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md)'s orchestration seam.** D1 is a carve-out for the operator interface with an enforced import fence; it is not a general license to call provider APIs, and it must not be cited as precedent for one.
- **Any change to [ADR-203](203-event-topic-taxonomy.md)'s closed topic set.** Proactive narration is deferred and would be the thing that needs it.
- **Reviving convoke.** `/root/work/src/convoke` stays abandoned. It is referenced as prior art and as a defect corpus; no code is ported from it.
- **A general remote-control HTTP API for atmux.** This is a voice interface with an enumerated tool catalog, not a REST surface.

---

## Open questions

1. **OQ-1 — provider default.** D4 makes the choice a config value and V-7 proves the swap, but `ATMUX_VOICE_PROVIDER` needs a shipped default. Recommendation: `openai-realtime` for v1, on the strength of D5's passthrough (no server-side resample on either leg). Revisit after both adapters have run on a phone.
2. **OQ-2 — should `add_task` be confirm-gated after all?** D6 leaves it ungated for usability. This is the one D6 line most likely to be wrong in practice, and it is cheap to reverse (one catalog flag). Decide from real usage, not in advance.
3. **OQ-3 — turn detection: push-to-talk only, or server VAD as an option?** v1 is PTT (D5's `TURN_END` flag carries the boundary explicitly). Provider-side VAD would be more natural and is also the classic route to an **echo runaway**, where the assistant's own downlink re-triggers its input. V-18's breaker exists for exactly that, and PTT is the safe default until it is proven on hardware. Phase P7.
4. **OQ-4 — where do voice server logs live, and what is their retention?** They will contain transcripts, i.e. everything the operator said. Not decided here; it must be decided before P7 clears `ATMUX_VOICE_READONLY`, and the answer must respect [ADR-268](268-managed-repo-state-isolation-enforcement.md) (nothing in a managed product repo). — **RESOLVED 2026-08-15 (operator): local-only, short retention.**
   - **Location:** `~/.atmux/voice-logs/` — atmux's own state directory, which is not a managed product repo, so ADR-268 is satisfied by construction. Never inside a product checkout, never a shared or network path, never anything a deploy or a `git add -A` could sweep up.
   - **Retention:** 7 days, pruned on server start and daily thereafter. Chosen as the shortest window that still lets the operator debug "what did I say that made it do that?" the morning after. Operator may shorten it; lengthening it should come with a reason.
   - **Scope:** transcripts are the sensitive payload. Connection and protocol events (frame counts, close codes, dial failures, tool names) carry no speech and are not what this bounds — and note the first real deploy found the server logging *nothing* on a failed dial, so the protocol-event side needs more logging, not less.
   - **Not decided here:** whether transcripts are written at all by default. The safest posture is off-by-default with an explicit opt-in flag, since a transcript file is the one artifact that turns a voice session into a durable record of everything said near the microphone. If P7 ships them on by default, that is its own decision to argue.
   - **Why this shape:** the recording is the risk, not the disk. Anything that leaves the box — a log shipper, a crash reporter, a synced directory — converts a local convenience into an exfiltration path for the operator's speech, so the decision is deliberately "local-only" rather than "local-first".
5. **OQ-5 — is `atmux voice` the right verb name, or should it be a subverb of an operator-surface family?** Cosmetic today; renaming a shipped verb costs an [ADR-266](266-shim-sunset-policy-and-first-sweep.md) shim, so the question is worth asking before P4 rather than after. **RESOLVED 2026-08-14 (operator): `voice` stands as a top-level verb.** Asked and answered before P4 landed, so no shim is owed. Reopening this after P4 ships costs an ADR-266 shim by definition — treat it as closed.

---

## Decision-anchors

Every row verified against disk on **2026-08-14** unless dated otherwise.

| Claim | Source |
|---|---|
| Principle #1 — "atmux doesn't speak any AI provider API" — is a claim about the orchestration seam (D1) | `docs/ARCHITECTURE.md` §Principles item 1 |
| `AgentBackend` is the types-first adapter precedent D4's seam copies | `src/abstractions/agent-backend.ts`; [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) |
| atmux has **no** HTTP surface today — the property this ADR spends | [ADR-261](261-issue-sync-external-tracker-ingestion.md) §Context |
| The `{ create: true }` open that D2 makes structurally unreachable | `src/abstractions/sqlite.ts:33`; hazard analysis in [ADR-271](271-sqlite-sole-store-rust-orchd-coordinator.md) §D3 |
| `ATMUX_CALLER_SCOPE=driver` is the existing driver-scope gate D3 grants | `src/core/common.ts:933`; `src/verbs/orchd.ts:800`; `src/verbs/team/dissolve-worker.ts:104-105`; [ADR-033](033-kanban-driver-only-flag.md) |
| Manual orchestration is the fleet default → operator + lead LLMs **are** the coordination mechanism | [ADR-260](260-manual-orchestration-mode-default.md) §D1; 20-of-20 fleet measurement in [ADR-271](271-sqlite-sole-store-rust-orchd-coordinator.md) §Limb 2 |
| convoke defect 1 — `createScriptProcessor(4096, 1, 1)`, deprecated + main-thread | `/root/work/src/convoke/public/index.html:250` |
| convoke defect 2 — `sampleRate: 16000` is advisory; no resampler exists anywhere in that client | `/root/work/src/convoke/public/index.html:244`; `grep -rn sampleRate` → that one hit |
| convoke defect 3 — `decodeAudioData` called on raw PCM (needs a container header) | `/root/work/src/convoke/public/index.html:228`, error callback `:233` |
| convoke defect 4 — `AudioContext` constructed on the **inbound-audio** path, outside a user gesture | `/root/work/src/convoke/public/index.html:225` (and again `:248`) |
| convoke's dead systemd unit — the D10 cautionary tale | `/root/work/src/convoke/deploy/convoke.service` |
| No boot autostart; operator verbatim "atmux should never start when the server restarts" | [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) §Driver-ref |
| Cockpit reconcile **prunes** any window outside the wanted set → why voice is not a cockpit window | `src/verbs/cockpit.ts:1971-2041` (`action: "prune-orphan"`) |
| Cockpit session is `atx` on the dedicated `atmux-cockpit` socket; cages are `atmux-<team>` on path-explicit sockets → `atmux-voice` on the default socket collides with neither | `docs/ARCHITECTURE.md` §Tmux topology; [ADR-162](162-atmux-owns-tmux-infrastructure.md); [ADR-264](264-cockpit-session-atx-rename.md) |
| The default socket is the driver's tier — the correct sibling for operator infrastructure | [ADR-044](044-driver-session-on-default-socket.md) |
| `build:install` copies `templates/` to `/opt/atmux/<version>/templates` — D9's staging path, no new plumbing | `package.json:27` |
| `resolveTemplatesDir()` already resolves install-mode vs dev-mode | `src/core/templates-dir.ts:49` |
| `coveragePathIgnorePatterns` has exactly **4** entries; D9 adds **zero** | `bunfig.toml:32-37` |
| 100%/100%/100%/100% coverage gate on tracked paths | `bunfig.toml:16`; [ADR-009](009-auto-rotation.md) §2; [ADR-254](254-coverage-gate-completeness.md) |
| `templates/` currently holds only `briefs/`, `epic-rosters/`, `prompts/`, `tmux/`, `cursor-cli-permissions.json`, `team.example.{json,md}` → `templates/voice/` is net-new, colliding with nothing | `ls templates/` |
| Current version `0.8.30` — the release the phase plan lands against | `package.json:3` |
| 270 is a deliberate gap in the ADR sequence; 271 is the highest on disk → 272 is next | `ls docs/adr/` (no `270-*.md`) |
| Shim/flag sunset discipline for `ATMUX_VOICE_READONLY` | [ADR-266](266-shim-sunset-policy-and-first-sweep.md) §D1 |
| Operator-private residency — no voice artifact in a managed product repo | [ADR-268](268-managed-repo-state-isolation-enforcement.md); [ADR-244](244-per-repo-pre-commit-kanban-decisions-snapshot.md) §Supersession-2026-05-26 |

## Cross-references

- **Carves out from**: `docs/ARCHITECTURE.md` §Principles item 1 — for the **operator** seam only, behind D1's enforced import fence. [ADR-258](258-vendor-agnostic-orchestration-agentbackend.md) continues to own the orchestration seam, unchanged.
- **Depends on**: [ADR-033](033-kanban-driver-only-flag.md) (caller-scope gate), [ADR-271](271-sqlite-sole-store-rust-orchd-coordinator.md) §D3 (the store-safety refusal D2 inherits by going through verbs), [ADR-217](217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D5 (`templates/` staging).
- **Constrained by**: [ADR-233](233-cron-auto-install-disabled-trust-orchd.md) (no boot autostart — D10), [ADR-268](268-managed-repo-state-isolation-enforcement.md) (state residency), [ADR-009](009-auto-rotation.md) §2 + [ADR-254](254-coverage-gate-completeness.md) (coverage gate not widened — D9), [ADR-203](203-event-topic-taxonomy.md) (closed topic set — untouched).
- **Does not change**: any existing verb's behavior, any schema, any event topic, any team's configuration. The tool bridge calls verbs; it does not modify them.
- **Operator-facing companion**: [docs/RUNBOOK-voice.md](../RUNBOOK-voice.md) — env vars, start/stop, nginx, and the V-1…V-18 verification checklist.
