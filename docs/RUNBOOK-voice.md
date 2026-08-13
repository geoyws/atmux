# RUNBOOK — `atmux voice` (spoken operator interface)

Operator-facing reference for **`atmux voice`** — the mobile-PWA voice assistant for the fleet. Design and rationale live in [ADR-272](adr/272-voice-operator-interface.md); this runbook is the operating surface and the acceptance checklist.

> **Status: skeleton.** The feature ships in phases P1–P7. Every section below is marked with the phase that fills it in. A section marked **lands in P\<n\>** documents the contract the implementation ships against — running the commands in it before that phase is a usage error, not a bug.

> **Name discipline:** the feature is `voice` / `atmux voice`. Not "Jarvis" — that is how the ask was phrased, not what the thing is called. Not "convoke" — `/root/work/src/convoke` is an abandoned predecessor and reusing the name would be forbidden ambiguity.

## §1 — Purpose

Give the operator a read of the fleet, and a way to move work along, **without a keyboard**. The operating picture is the operator away from the desk — walking, in a lift, in a car — wanting what `atmux status` would tell him and the ability to nudge a lead.

This matters more than a convenience feature because of [ADR-260](adr/260-manual-orchestration-mode-default.md): manual orchestration is the fleet default, so the operator and the lead LLMs **are** the coordination mechanism. An unreachable operator is a missing scheduler.

Two properties bound the whole thing, both from [ADR-272](adr/272-voice-operator-interface.md):

- **Every voice tool is an `atmux` verb invocation** (§D2). No `Database` opens, no raw `tmux`, no shell interpolation, no `run_command` escape hatch. Deleting the voice server removes a microphone, not a power.
- **The server runs as the driver** (§D3, `ATMUX_CALLER_SCOPE=driver`). Whoever reaches the WebSocket *is* the driver. That is why §5's auth is layered and why v1's tool surface is narrow.

## §2 — Architecture sketch

```
  ┌─────────────┐   WSS (TLS)     ┌──────────────┐   WS (loopback)   ┌──────────────────┐
  │  phone PWA  │ ──────────────► │    nginx     │ ────────────────► │  atmux voice     │
  │ AudioWorklet│ ◄────────────── │  TLS + auth  │ ◄──────────────── │ 127.0.0.1:4390   │
  └─────────────┘                 └──────────────┘                   └────────┬─────────┘
     PCM16LE mono 24 kHz              O1: token                               │
     40 ms frames, 4-byte header      O2: + oauth2-proxy                      │
                                                                              │  WS
                                            ┌─────────────────────────────────┴──────────┐
                                            │                                            │
                                            ▼                                            ▼
                                  ┌───────────────────┐                      ┌──────────────────────┐
                                  │  VoiceProvider    │                      │    tool bridge       │
                                  │  adapter (D4)     │                      │  (verb-only, D2)     │
                                  │ openai-realtime   │   tool_call  ──────► │  argv → atmux <verb> │
                                  │ gemini-live       │ ◄──── result ─────── │  ATMUX_CALLER_SCOPE  │
                                  └───────────────────┘                      │      = driver        │
                                   API keys stay on hax                      └──────────┬───────────┘
                                                                                        │
                                                                             ┌──────────▼───────────┐
                                                                             │  atmux CLI verbs     │
                                                                             │  → state.db, tmux    │
                                                                             └──────────────────────┘
```

**Transport is a server relay, deliberately** ([ADR-272](adr/272-voice-operator-interface.md) §Security): phone ↔ our WebSocket ↔ provider WebSocket. `OPENAI_API_KEY` / `GEMINI_API_KEY` never leave hax, and the tool bridge stays server-side where §D2's verb-only guarantee can hold.

**Audio is PCM16LE mono 24 kHz in both directions** (§D5). The phone decimates 48 kHz → 24 kHz at an exact 2:1 ratio; OpenAI is passthrough both ways; Gemini needs a server-side 24 → 16 kHz resample on the **uplink only**. Downlink is a byte-for-byte relay for both providers.

**Uplink frame** — 4-byte header, then payload:

| Bytes | Field | Value |
|---|---|---|
| 0 | magic | `0xA1` — PCM16 canonical, protocol v1. Any other value is a protocol error and closes the session. |
| 1 | flags | bit0 `TURN_END` · bit1 `SYNTHETIC` · bits 2-7 reserved, MUST be zero |
| 2-3 | seq | `uint16` LE, wraps at 65536 — gap detection, not reordering |
| 4+ | payload | PCM16LE mono 24 kHz — **960 samples / 1920 bytes** per 40 ms frame |

Control messages are JSON **text** frames; audio is **binary** frames. The two never mix.

## §3 — Configuration

### Environment variables

Numeric knobs **fail closed to their default** on a non-numeric, non-positive, or non-finite value — the same convention `ATMUX_SPAWN_TIMEOUT_MS` and `ATMUX_GIT_TIMEOUT_MS` already use (`CLAUDE.md` §"Spawn timeout").

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `ATMUX_VOICE_TOKEN` | — none — | **yes** | Shared secret, **minimum 32 characters**. The server **refuses to start** without it: no default, no generated-and-printed fallback. Checked timing-safely before the WebSocket upgrade, then re-asserted in `hello.token`. |
| `ATMUX_VOICE_PROVIDER` | `openai-realtime` | no | Adapter id. `openai-realtime` \| `gemini-live` (P6). Resolved **once, at session construction** — no hot-swap, no mid-session failover (ADR-272 §D4). |
| `ATMUX_VOICE_MODEL` | provider adapter's default | no | Provider-specific realtime model id. |
| `ATMUX_VOICE_PORT` | `4390` | no | Listen port. |
| `ATMUX_VOICE_HOST` | `127.0.0.1` | no | Bind address. **Binding `0.0.0.0` needs its own ADR** — it removes the assumption every other auth layer is designed against (ADR-272 §Security layer 4). |
| `ATMUX_VOICE_ORIGINS` | — none — | **yes** | Comma-separated `Origin` allowlist. This is the **CSRF** defense: browsers do not apply same-origin policy to WebSocket handshakes, so without it any page the operator visits can ride his O2 session cookie into a driver-scope socket. |
| `ATMUX_VOICE_TOOL_TIMEOUT_MS` | `20000` | no | Per-tool wall-clock deadline. A tool that exceeds it returns a spoken error; it does not hang the session. |
| `ATMUX_VOICE_MAX_RESULT_CHARS` | `2000` | no | Truncation ceiling for a tool result before it reaches the model. Voice results are **spoken**, so a 40 KB pane dump is both expensive and useless. |
| `ATMUX_VOICE_READONLY` | unset | no | `1` ⇒ only the 10 read tools exist; the 4 messaging tools are **absent from the catalog**, not merely refused at call time. **This is the setting the feature first ships in.** Carries a `SUNSET` marker per [ADR-266](adr/266-shim-sunset-policy-and-first-sweep.md) §D1; cleared in P7. |
| `ATMUX_VOICE_RESUME_GRACE_MS` | `90000` | no | How long a dropped phone's **provider leg is parked** for `hello.resume` (ADR-272 §D8 — the walking-into-a-lift case). |
| `ATMUX_VOICE_CONFIRM_TTL_MS` | `120000` | no | Lifetime of a D7 confirmation token. Single-use, and bound to `sha256(tool ‖ canonical_json(args) ‖ session_id)`. |
| `ATMUX_VOICE_ASSETS_DIR` | `resolveTemplatesDir()/voice` | no | Override for the client asset root. The default resolves install-mode `/opt/atmux/<v>/templates/voice` and dev-mode `<repo>/templates/voice` through `src/core/templates-dir.ts` — V-1 checks both. |

### Provider API keys

`OPENAI_API_KEY` / `GEMINI_API_KEY` come from the operator's **git-crypt'd dotfiles env** (`~/work/journals/.sb/_dotfiles`; inventory in `keys/KEYS.md`). They are **never committed**, never written into this repo, never passed on argv (tmux pane capture records command lines), and never appear in any client-bound frame — V-2 and the `ready`-frame key-set unit test both assert that.

## §4 — Start / stop

> **lands in P4** (`--serve`, `--status`, `--stop`) and **P4/P7** (`--supervise`).

```bash
atmux voice --serve       # foreground; the development and first-deploy form
atmux voice --supervise   # detached tmux session `atmux-voice`, crash-loop wrapper
atmux voice --status      # is it running, which provider, session state
atmux voice --stop        # stop the server and tear down the supervised session
```

**`--supervise` creates (or idempotently re-attaches to) a detached tmux session named `atmux-voice` on the default socket** and runs the server under a crash-loop wrapper: `trap` on exit, 5-second backoff, and a **circuit breaker at 5 restarts inside 60 seconds** that stops retrying and leaves the failure readable in the pane instead of hiding it in a restart loop.

Why that shape, and not the three obvious alternatives (full reasoning in [ADR-272](adr/272-voice-operator-interface.md) §D10):

- **Not a cockpit window** — the cockpit reconcile pass prunes any window outside its wanted set (`src/verbs/cockpit.ts:1971-2041`, `action: "prune-orphan"`), so a voice window in `atx` would be killed silently at the worst moment.
- **Not a cage window** — cages are per-team ([ADR-162](adr/162-atmux-owns-tmux-infrastructure.md)); `atmux stop` on an unrelated team would end the call.
- **Not systemd** — [ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md) forbids anything atmux ships starting at boot. Convoke's orphaned `deploy/convoke.service` is the cautionary tale.

`atmux-voice` on the **default** socket collides with neither the cockpit (`atx`, on the dedicated `atmux-cockpit` socket) nor any cage (`atmux-<team>`, on path-explicit per-team sockets). It sits alongside the driver session ([ADR-044](adr/044-driver-session-on-default-socket.md)), which is the right tier: voice is operator infrastructure.

## §5 — nginx (phases O1 → O2)

> **lands in P4.** The repo example is **`docs/deploy/atmux.geoy.ws.conf.example`** — *placeholder: that file does not exist yet and lands with P4.* Do not treat its absence as a missing dependency; treat a reference to it before P4 as unwritten.

The vhost lives on `geoy.ws` (personal infra — `ifca.app` and `ifca.dev` are IFCA-only per `CLAUDE.md` §DNS).

**Phase O1 — first deploy, token-only.** TLS termination, WebSocket upgrade headers, `proxy_pass` to `127.0.0.1:4390`. The **only** credential is `ATMUX_VOICE_TOKEN`. This phase ships with `ATMUX_VOICE_READONLY=1` set, so the exposure during O1 is read-only by construction.

**Phase O2 — add `oauth2-proxy`.** An unauthenticated request never reaches Bun. Only after O2 does the claim "voice is behind OAuth" become true; before it, the token is the whole perimeter. `ATMUX_VOICE_READONLY` is cleared in P7, **after** O2 — never before.

**Two nginx requirements are load-bearing, not stylistic:**

1. **`access_log off;` on the WebSocket location.** The token arrives as a `?token=` query parameter, so without this it is written to disk on every connection. V-6 asserts it is absent from the access log.
2. **WebSocket upgrade must be complete** — `proxy_http_version 1.1`, `Upgrade` / `Connection` headers, and a `proxy_read_timeout` longer than a realistic silent pause, or nginx will cut a live call mid-conversation.

## §6 — Probe

> **lands in P4.** `scripts/voice-probe.ts` — *placeholder: not yet written.*

A headless client that connects, authenticates, streams a short synthetic PCM utterance, and asserts on the responses. It is what makes V-3, V-5, and V-7 runnable without a phone, and what a future regression is caught by.

It is **not** a substitute for the phone checks. Two of convoke's four fatal defects (advisory `sampleRate`, `AudioContext` outside a user gesture) are iOS-specific and would pass any headless suite. See the warning at the head of §7.

## §7 — Verification checklist (V-1 … V-18)

> **Filled in progressively: V-1…V-8 in P4, V-9…V-17 in P5, V-18 in P7.** Every row starts as a placeholder. A row is marked done only with a **receipt** — a command and its output, a paste-id, or a screenshot — never "looks fine".

> 🔴 **A green headless run is NOT "voice works".** convoke defect 2 (`sampleRate: 16000` is advisory; iOS delivers 48 kHz) and defect 4 (`AudioContext` created outside a user gesture; iOS leaves it suspended) both pass on desktop Chrome and both make the app silently useless on a phone. **V-9…V-17 are hand-run on a physical device and are not optional.**

### Headless (V-1 … V-8) — lands in P4

| ID | Check | Pass criteria | Status |
|---|---|---|---|
| V-1 | Assets resolve in **both** modes | `ATMUX_VOICE_ASSETS_DIR` unset: dev-mode resolves `<repo>/templates/voice`, compiled resolves `/opt/atmux/<v>/templates/voice`. Both serve `index.html`. | placeholder |
| V-2 | HTTP asset surface | `200` + correct `Content-Type` for `.html` / `.js` / `.css` / `.webmanifest`; `401` without a valid token; `404` on a `../` traversal attempt; `Cache-Control: no-store` on `app.js`; **no API key in any response body or header**. | placeholder |
| V-3 | Probe through **loopback** | `scripts/voice-probe.ts` against `127.0.0.1:4390` completes a full auth → audio → transcript → tool-call → result round trip. | placeholder |
| V-4 | Probe through **nginx + TLS** | Same probe against the public `wss://` URL. Catches upgrade-header and `proxy_read_timeout` misconfiguration that loopback hides. | placeholder |
| V-5 | Negative auth matrix | Each of: no token · wrong token · right token + **disallowed `Origin`** · valid upgrade but missing/mismatched `hello.token` — is **rejected**, and rejected at the documented layer. | placeholder |
| V-6 | Token absent from logs | After V-4, `grep` the nginx access log for the token value → **no match** (`access_log off` in effect). | placeholder |
| V-7 | **Provider swap, zero client diff** | Flip `ATMUX_VOICE_PROVIDER` `openai-realtime` → `gemini-live`, restart, re-run V-3. Passes with **byte-identical client assets**. Any required client change means the D4 seam leaked. | placeholder |
| V-8 | Confirm-token enforcement (D7) | A confirm-gated tool: (a) does **not** execute on first call, (b) executes on redemption, (c) is **refused on a second redemption** (single-use), (d) is **refused after `ATMUX_VOICE_CONFIRM_TTL_MS`**, (e) is **refused when redeemed with mutated arguments** (argument-binding). All five, server-side. | placeholder |

### Phone (V-9 … V-17) — lands in P5

| ID | Check | Pass criteria | Status |
|---|---|---|---|
| V-9 | Mic unlock on gesture | `AudioContext` is created **and resumed** inside the first user gesture; `state === "running"` before any capture. Direct pin for convoke defect 4. | placeholder |
| V-10 | PTT round trip + **pitch check** | Speak a known phrase, hear a coherent reply — and confirm the reply is **at normal pitch and speed**. A rate mismatch presents as slow/deep audio, not as an error. Direct pin for convoke defect 2. | placeholder |
| V-11 | Local barge-in | Releasing PTT / starting to speak stops downlink playback **immediately, client-side**, without waiting for a server round trip. | placeholder |
| V-12 | Lock screen → resume | Lock the phone mid-session, unlock within `ATMUX_VOICE_RESUME_GRACE_MS` → same session resumes via `hello.resume` with history intact. Beyond the window → clean fresh session, no stale audio replayed. | placeholder |
| V-13 | WiFi → LTE handover | Walk out of WiFi range mid-session. Socket drops, client reconnects, provider leg was parked, conversation continues. **The lift case — this is the reason D8 exists.** | placeholder |
| V-14 | Speaker routing | Audio plays through the **intended** output (speaker vs earpiece vs connected Bluetooth), and does not silently route to the earpiece at inaudible volume. | placeholder |
| V-15 | Standalone-PWA mic | Installed to the home screen (`display: standalone`), mic permission still granted and capture still works. A standalone PWA is a different permission context from the browser tab. | placeholder |
| V-16 | Tool chips land on **real** tmux | A spoken `tell_lead` appears in the target team's real lead inbox; a spoken `list_tasks` matches what `atmux task list` prints. The end-to-end proof that the bridge reaches the fleet, not a mock. | placeholder |
| V-17 | Read-only kill switch | With `ATMUX_VOICE_READONLY=1`, the 4 messaging tools are **absent from the catalog the model receives** — not merely refused on call. Ask the assistant to send a message: it reports it has no such capability. | placeholder |

### Hardening (V-18) — lands in P7

| ID | Check | Pass criteria | Status |
|---|---|---|---|
| V-18 | Echo-runaway breaker | With the speaker on and any VAD-style turn detection enabled (OQ-3), the assistant's **own downlink must not re-trigger its input**. A runaway is detected and broken automatically; it must never be left to the operator to notice a self-sustaining loop that is billing per minute. | placeholder |

## §8 — Troubleshooting

> **Stub — filled in as failures are actually met in P4–P7.** Entries are added with the symptom that was really observed and the fix that really worked. Speculative entries are worse than none.

| Symptom | Likely cause | Check |
|---|---|---|
| Connection closes immediately, no audio | Token rejected before upgrade, or `Origin` not in `ATMUX_VOICE_ORIGINS` | *stub — P4* |
| Reply audio is slow and deep-pitched | Sample-rate mismatch — the client is shipping 48 kHz labelled 24 kHz (convoke defect 2) | *stub — P5* |
| No audio at all, no error in the UI | `AudioContext` suspended — created outside a user gesture (convoke defect 4) | *stub — P5* |
| Session drops after ~60 s of silence | nginx `proxy_read_timeout` shorter than a realistic pause | *stub — P4* |
| Assistant describes a tool it cannot run | `ATMUX_VOICE_READONLY=1` still set, or the catalog and the instructions disagree | *stub — P4* |
| Tool call times out | `ATMUX_VOICE_TOOL_TIMEOUT_MS` exceeded — a verb is slow, or the team resolution walked to the wrong `.atmux` | *stub — P4* |
| Supervised server flapping | Circuit breaker tripped (5 restarts in 60 s) — the pane holds the real error | *stub — P4* |

## §9 — Related

- [ADR-272](adr/272-voice-operator-interface.md) — design, decisions D1–D11, security model, deferred scope.
- [ADR-260](adr/260-manual-orchestration-mode-default.md) — why an unreachable operator is a coordination gap.
- [ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md) — no boot autostart; the constraint on §4's supervision shape.
- [ADR-033](adr/033-kanban-driver-only-flag.md) — the `ATMUX_CALLER_SCOPE=driver` gate the server satisfies.
- [ADR-258](adr/258-vendor-agnostic-orchestration-agentbackend.md) — the adapter precedent the provider seam copies, and the orchestration seam ADR-272 §D1 fences itself off from.
- `/root/work/src/convoke` — abandoned predecessor. Prior art and defect corpus only; **no code is ported from it**.
