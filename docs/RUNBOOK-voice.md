# RUNBOOK — `atmux voice` (spoken operator interface)

Operator-facing reference for **`atmux voice`** — the mobile-PWA voice assistant for the fleet. Design and rationale live in [ADR-272](adr/272-voice-operator-interface.md); this runbook is the operating surface and the acceptance checklist.

> **Status: P1–P6 landed; first live deploy 2026-08-15.** The feature ships in phases P1–P7. §3–§6 describe shipped behaviour. A section still marked **lands in P\<n\>** documents the contract the implementation ships against — running the commands in it before that phase is a usage error, not a bug.
>
> **What the 2026-08-15 deploy actually closed:** the headless rows **V-2 … V-7** — assets and headers through nginx, the loopback probe, the `wss://` probe through nginx + TLS, the full negative-auth matrix, token-absent-from-logs (with a control), and the provider swap to `gemini-live` against the **real** Google endpoint. Both adapters have now dialled their real APIs.
>
> 🔴 **Still true, and it is the part that matters: no part of this has run on a phone.** V-9 … V-17 are hand-run on a physical device and every one is still a placeholder. Two of convoke's four fatal defects pass a desktop test, so a green headless set is **not** "voice works". Also still open: V-1's compiled/`$bunfs` leg, and `atmux voice --supervise`, which has never been run as a live supervised server. §7 marks each honestly; read it before believing the feature works.

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
| `ATMUX_VOICE_PROVIDER` | `openai-realtime` | no | Adapter id. `openai-realtime` \| `gemini-live` — both adapters shipped. Resolved **once, at session construction** — no hot-swap, no mid-session failover (ADR-272 §D4). |
| `ATMUX_VOICE_MODEL` | provider adapter's default | no | Provider-specific realtime model id. |
| `ATMUX_VOICE_PORT` | `4390` | no | Listen port. |
| `ATMUX_VOICE_HOST` | `127.0.0.1` | no | Bind address. **Binding `0.0.0.0` needs its own ADR** — it removes the assumption every other auth layer is designed against (ADR-272 §Security layer 4). |
| `ATMUX_VOICE_ORIGINS` | — none — | **in practice, yes** | Comma-separated `Origin` allowlist. This is the **CSRF** defense: browsers do not apply same-origin policy to WebSocket handshakes, so without it any page the operator visits can ride his O2 session cookie into a driver-scope socket. ⚠️ **The server does NOT refuse to start without it** (only `ATMUX_VOICE_TOKEN` does that). An empty allowlist means every *present* `Origin` is rejected — so the PWA cannot connect at all — while a request with **no** `Origin` header is allowed through to the token check (`checkOrigin` in `src/core/voice/auth.ts`: native apps and `scripts/voice-probe.ts` send none). Set it before the PWA is expected to work. |
| `ATMUX_VOICE_TOOL_TIMEOUT_MS` | `20000` | no | Per-tool wall-clock deadline. A tool that exceeds it returns a spoken error; it does not hang the session. |
| `ATMUX_VOICE_MAX_RESULT_CHARS` | `2000` | no | Truncation ceiling for a tool result before it reaches the model. Voice results are **spoken**, so a 40 KB pane dump is both expensive and useless. |
| `ATMUX_VOICE_READONLY` | unset | no | `1` ⇒ only the 12 read tools exist; the 4 messaging tools **and `pane_nudge`** are **absent from the catalog**, not merely refused at call time. **This is the setting the feature first ships in**, which is why `pane_nudge` is unreachable until P7 despite being built. Carries a `SUNSET` marker per [ADR-266](adr/266-shim-sunset-policy-and-first-sweep.md) §D1; cleared in P7. |
| `ATMUX_VOICE_RESUME_GRACE_MS` | `90000` | no | How long a dropped phone's **provider leg is parked** for `hello.resume` (ADR-272 §D8 — the walking-into-a-lift case). |
| `ATMUX_VOICE_CONFIRM_TTL_MS` | `120000` | no | Lifetime of a D7 confirmation token. Single-use, and bound to `sha256(tool ‖ canonical_json(args) ‖ session_id)`. |
| `ATMUX_VOICE_ASSETS_DIR` | `resolveTemplatesDir()/voice` | no | Override for the client asset root. The default resolves install-mode `/opt/atmux/<v>/templates/voice` and dev-mode `<repo>/templates/voice` through `src/core/templates-dir.ts` — V-1 checks both. |
| `ATMUX_VOICE_BIN` | the `atmux` on `PATH` | no | The atmux binary **`--supervise`** re-execs in its crash-loop wrapper. Precedence: per-call override > this > `resolveAtmuxBin()` (`Bun.which("atmux")` → `process.execPath`). **Fails closed** — an empty or whitespace-only value falls through to the next layer rather than producing a wrapper that execs `''`. Set it when supervising from a **repo checkout**: the installed `/usr/local/bin/atmux` → `/opt/atmux/<v>` may predate the `voice` verb, in which case the wrapper prints `unknown verb: voice`, exits 64, and crash-loops until the breaker trips (observed live 2026-08-15). The alternative — `bun run build:install` — swaps the atmux CLI **fleet-wide** for every team on the box, which is a release, not a supervision detail. See [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) §Supplement. |

### Provider API keys

`OPENAI_API_KEY` / `GEMINI_API_KEY` come from the operator's **git-crypt'd dotfiles env** (`~/work/journals/.sb/_dotfiles`; inventory in `keys/KEYS.md`). They are **never committed**, never written into this repo, never passed on argv (tmux pane capture records command lines), and never appear in any client-bound frame — V-2 and the `ready`-frame key-set unit test both assert that.

## §4 — Start / stop

> **Shipped in P4** — `src/verbs/voice.ts`.

```bash
atmux voice --serve       # foreground; the development and first-deploy form
atmux voice --supervise   # detached tmux session `atmux-voice`, crash-loop wrapper
atmux voice --status      # is it running, which provider, session state
atmux voice --stop        # stop the server and tear down the supervised session
```

**Flags** (all actions default to `--serve`; two *different* action flags in one invocation is a usage error, never a silent last-wins):

| Flag | Meaning |
|---|---|
| `--port <n>` | Listen port override (flag > `ATMUX_VOICE_PORT` > 4390). Must be a positive integer. |
| `--provider <p>` | `openai` \| `openai-realtime` \| `gemini` \| `gemini-live`. |
| `--model <m>` | Realtime model id; defaults to the adapter's (`factory.ts::defaultModelFor`). |
| `--readonly` | Force readonly. Removes the 4 messaging tools from the catalog the model receives. |
| `--max-frames <n>` | Exit 0 after `n` **binary** phone frames are processed. The bound that makes a serve scriptable in a probe or e2e run; JSON control frames do not count. |
| `--print-assets-dir` | Print the resolved PWA assets dir and exit 0. The dev-vs-`$bunfs`-compiled verification hook (V-1). Does **not** require an API key. |

**Exit codes.** `--serve` returns 0 on SIGINT / SIGTERM / frame budget. `--status` returns **0 only when the session is up AND `/healthz` answers**, else 1 — so it is usable directly in a shell conditional. Bad argv is `UsageError` → 64; a missing `ATMUX_VOICE_TOKEN` or provider API key is `ConfigError` → 78, raised **before anything binds a port**.

### `/healthz`

Open by design (nginx exposes it for probes). **`ok` is a real verdict, not a constant.**

```json
{ "ok": true,  "provider": "openai-realtime", "readonly": false, "degraded": null,
  "bridge": { "wedged": false, "stuckTool": null, "heldMs": null, "queueDepth": 0, "wedgeThresholdMs": 60000 } }
```

```json
{ "ok": false, "provider": "openai-realtime", "readonly": false, "degraded": "tool-bridge-wedged",
  "bridge": { "wedged": true, "stuckTool": "team_status", "heldMs": 184213, "queueDepth": 6, "wedgeThresholdMs": 60000 } }
```

**Why `ok` can be false.** Every voice tool serializes through one verb mutex (`src/core/verb-capture.ts`) because the stdout-capture wrapper cannot run two verbs concurrently. The tool timeout bounds the **response**, not the **execution** — so a wired verb that never returns holds that mutex forever, every later tool call answers `tool_timeout` permanently, and none of the 13 wired verbs calls `process.exit`, so the process **wedges rather than crashing**. The only recovery is `atmux voice --stop`. Voice runs unattended in a detached tmux session, so a probe reporting green through all of that is worse than no probe at all.

- `wedgeThresholdMs` = `WEDGE_THRESHOLD_MULTIPLE` (3) × `ATMUX_VOICE_TOOL_TIMEOUT_MS`. Past its own response deadline a tool is merely **slow** — already reported to the operator as a `tool_timeout`. Three deadlines in, it is **stuck**.
- `stuckTool` is the tool **name** only. Arguments are never put here: `/healthz` is unauthenticated, and arguments carry what the operator said.
- `queueDepth` is **reported, never capped**. Capping would swap a visible wedge for an invisible one; the whole point is to surface it.
- The HTTP status stays **200** while wedged. `--status` probes via `isReachable`, which reads any non-2xx as *unreachable* — and a wedged-but-listening server is a different fault from an absent one. The status carries reachability; the body carries the verdict.
- The keys `ok` / `provider` / `readonly` are unchanged in meaning and position, so an existing reader keeps working; `degraded` and `bridge` are additions.

**Boot order is fail-closed and deliberate** (`buildVoiceDeps`): token → provider kind → API key → team index → catalog → bridge → registry → provider. A missing key is a startup refusal naming the variable, not a spoken error on the first tool call.

**Output discipline.** Everything the running server says goes to **stderr**. `process.stdout` is capture-owned while a tool's verb runs (`src/core/verb-capture.ts`), so a stdout write would be spliced into a spoken tool result. Only `--print-assets-dir` and `--status` — one-shot reads that exit before any capture exists — write to stdout. The startup banner prints host, port, provider, model, readonly and the assets dir, and **never** the token or an API key.

### What the server logs, and what it will never log

Every stderr line goes through `createVoiceLogger` (`src/core/voice/log.ts`), which redacts **structurally** rather than by convention — the callsite cannot forget it and cannot bypass it. Two layers: the secrets the server actually holds (`ATMUX_VOICE_TOKEN` and the provider API key), plus shape patterns for a credential it was never told about (`?key=` / `&api_key=` / `?token=` query auth, `Bearer …`, `openai-insecure-api-key.…`, bare `sk-…`).

**No speech, ever.** These lines are protocol and connection events — attempt counters, close codes, provider error codes, tool *names*. They carry no transcript text and no tool *arguments*. Transcripts are the sensitive payload bounded by [ADR-272](adr/272-voice-operator-interface.md) OQ-4 (local-only, `~/.atmux/voice-logs/`, 7-day retention) and are a separate concern from this sink.

The dial story, which is what the first live deploy went without:

| Event | Line |
|---|---|
| Successful dial (the whole happy path) | `voice: provider ready — openai-realtime/gpt-realtime attempt 1/5 in 312ms` |
| Provider reported a fault | `voice: provider error (openai-realtime/gpt-realtime) [beta_api_shape_disabled] The Realtime Beta API is no longer supported.` |
| Attempt failed — provider hung up pre-handshake | `voice: dial attempt 1/5 failed (openai-realtime/gpt-realtime) — provider closed before session-ready (code=4000 reason=beta shape disabled); last provider error [beta_api_shape_disabled] …; retrying in 500ms` |
| Attempt failed — socket opened, provider silent | `voice: dial attempt 1/5 failed (openai-realtime/gpt-realtime) — no session-ready within 12000ms (socket opened, provider handshake never completed); retrying in 500ms` |
| Attempt failed — socket refused | `voice: dial attempt 1/5 failed (openai-realtime/gpt-realtime) — connect failed — voice provider (openai-realtime): websocket connection failed — ECONNREFUSED; retrying in 500ms` |
| Budget exhausted → 4500 | `voice: dial exhausted — 5 attempts in 7500ms (openai-realtime/gpt-realtime); closing phone 4500 provider-unrecoverable; last failure: …; last provider error [beta_api_shape_disabled] …` |
| Mid-session provider close | `voice: provider closed mid-session (openai-realtime/gpt-realtime) code=1006 reason=network — redialing` |

Non-fatal provider errors are **capped at 3 per provider leg**, followed by one `further provider errors on this leg suppressed (logged 3)` notice — a misbehaving provider must not turn the log into a per-frame stream. The cap resets on every dial attempt, and the *record* is kept regardless, so the dial-failure line always quotes the real cause.

**`--supervise` creates (or idempotently re-attaches to) a detached tmux session named `atmux-voice` on the default socket** and runs the server under a crash-loop wrapper: `trap` on exit, 5-second backoff, and a **circuit breaker at 5 restarts inside 60 seconds** that stops retrying and leaves the failure readable in the pane instead of hiding it in a restart loop.

Why that shape, and not the three obvious alternatives (full reasoning in [ADR-272](adr/272-voice-operator-interface.md) §D10):

- **Not a cockpit window** — the cockpit reconcile pass prunes any window outside its wanted set (`src/verbs/cockpit.ts:1971-2041`, `action: "prune-orphan"`), so a voice window in `atx` would be killed silently at the worst moment.
- **Not a cage window** — cages are per-team ([ADR-162](adr/162-atmux-owns-tmux-infrastructure.md)); `atmux stop` on an unrelated team would end the call.
- **Not systemd** — [ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md) forbids anything atmux ships starting at boot. Convoke's orphaned `deploy/convoke.service` is the cautionary tale.

`atmux-voice` on the **default** socket collides with neither the cockpit (`atx`, on the dedicated `atmux-cockpit` socket) nor any cage (`atmux-<team>`, on path-explicit per-team sockets). It sits alongside the driver session ([ADR-044](adr/044-driver-session-on-default-socket.md)), which is the right tier: voice is operator infrastructure.

## §5 — nginx (phases O1 → O2)

> **Shipped in P4.** The repo example is **[`docs/deploy/atmux.geoy.ws.conf.example`](deploy/atmux.geoy.ws.conf.example)**. It contains **two files** separated by a banner comment — `limit_req_zone` / `map` live in an `http{}`-context `conf.d` snippet, the vhost in `sites-available`; nginx will not accept them concatenated. Install both, then `nginx -t && systemctl reload nginx`.

The vhost lives on `geoy.ws` (personal infra — `ifca.app` and `ifca.dev` are IFCA-only per `CLAUDE.md` §DNS).

**Phase O1 — first deploy, token-only.** TLS termination, WebSocket upgrade headers, `proxy_pass` to `127.0.0.1:4390`. The **only** credential is `ATMUX_VOICE_TOKEN`. This phase ships with `ATMUX_VOICE_READONLY=1` set, so the exposure during O1 is read-only by construction.

**Phase O2 — add `oauth2-proxy`.** An unauthenticated request never reaches Bun. Only after O2 does the claim "voice is behind OAuth" become true; before it, the token is the whole perimeter. `ATMUX_VOICE_READONLY` is cleared in P7, **after** O2 — never before.

**Two nginx requirements are load-bearing, not stylistic:**

1. **`access_log off;` on the WebSocket location.** The token arrives as a `?token=` query parameter, so without this it is written to disk on every connection. V-6 asserts it is absent from the access log.
2. **WebSocket upgrade must be complete** — `proxy_http_version 1.1`, `Upgrade` / `Connection` headers, and a `proxy_read_timeout` longer than a realistic silent pause, or nginx will cut a live call mid-conversation.

## §6 — Probe

> **Shipped in P4.** `scripts/voice-probe.ts` — a thin shim; the logic lives in `src/core/voice/probe.ts` (so it sits inside the `src/**` coverage universe, the same split `scripts/lint-socket-resolver.ts` already uses).

A headless client that connects, authenticates, streams a short synthetic PCM utterance, and reports on the responses. It is what makes V-3, V-5 and V-7 runnable without a phone, and what a future regression is caught by.

```bash
bun scripts/voice-probe.ts --url ws://127.0.0.1:4390/ws --token "$ATMUX_VOICE_TOKEN"
bun scripts/voice-probe.ts --url wss://atmux.geoy.ws/ws --token "$T" --seconds 12
bun scripts/voice-probe.ts --url ws://127.0.0.1:4390/ws --token "$T" --text "fleet status"
```

| Flag | Default | Meaning |
|---|---|---|
| `--url` | — required — | `ws://` or `wss://` endpoint, including `/ws`. |
| `--token` | — required — | Sent **twice**: as an `Authorization: Bearer` header on the upgrade request (the pre-upgrade gate) and again in the `hello` frame (the post-upgrade re-assert). You do **not** need `?token=` in the URL — the header is preferred precisely because a query parameter would land in nginx access logs, shell history and `ps` output. |
| `--seconds` | `8` | Collect window after the burst. Also bounds the `ready` wait. |
| `--tone <hz>` | `440` | Sine frequency. The tone is synthesized in TypeScript — **no ffmpeg dependency** — as 2s of PCM16LE mono 24 kHz, i.e. 50 frames of 1920 bytes. |
| `--text <s>` | — | Send one `text` frame **instead of** the audio burst. |

**Behaviour.** Connects via the `connectWebSocket` abstraction (never a raw socket) carrying `Authorization: Bearer <token>` so the **pre-upgrade** gate passes, sends `hello{v:1,token,mode:"ptt"}` for the post-upgrade re-assert, waits for `ready` and prints it, then streams the tone as 40 ms frames **at real-time pace** with correct sequence numbers and `TURN_END` on the last frame. A server that only works when fed faster than real time is not working. It then collects for `--seconds`, counting downlink binary frames/bytes and recording every JSON frame type seen.

**Exit 0 iff** `ready` arrived **and** the socket did not close with an error code (1000 and still-open both pass). All output is on **stderr**, so stdout stays clean for piping. A connect failure is reported as a non-zero exit with a `failure=` reason — never an unhandled throw.

It is **not** a substitute for the phone checks. Two of convoke's four fatal defects (advisory `sampleRate`, `AudioContext` outside a user gesture) are iOS-specific and would pass any headless suite. See the warning at the head of §7.

## §6.5 — Fleet triage: `fleet_attention` + `fleet_quiet`

> **Shipped alongside [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) D1–D3.** Classifier + renderer: `src/core/voice/fleet.ts`. Sweep: `src/verbs/fleet.ts`, also reachable as the CLI verb `atmux fleet`.

The operator's actual question is not per-team — it is **"what needs my attention across everything, and what doesn't?"**. Answering that with the per-team reads costs `list_teams` + `team_status` × N + `member_pane` × N × M: roughly twenty teams times several panes, each one a spoken round trip. These two tools replace that with one call each.

Both are **read-only** (`mutating: false`, `confirm: false`), so both work under `ATMUX_VOICE_READONLY=1`. That is deliberate: the survey half is useful on its own and ships before any input capability.

```bash
atmux fleet --attention            # ranked, most urgent first (default)
atmux fleet --attention --top 3    # speak fewer; 1..15, default 5
atmux fleet --quiet                # the aggregated all-clear
atmux fleet --json                 # the full verdict, nothing elided
```

| Flag | Default | Meaning |
|---|---|---|
| `--attention` / `--quiet` | `--attention` | Which view. Last flag wins. |
| `--top <n>` | `5` | How many entries are spoken in full before the rest become a count. **1..15**; outside that is a usage error, never a silent clamp. |
| `--json` | off | The whole verdict — every finding, the quiet list, the unreadable teams, the timing. What the speech elides on purpose. |
| `--timeout-ms <n>` | `15000` | Wall-clock bound for the whole sweep. |
| `--concurrency <n>` | `8` | Teams read in parallel. |

### What counts as needing you

Classification is **server-side and evidence-bearing** (D3): the model receives a verdict plus the marker and the pane gist that produced it, never a pane dump to judge for itself. Ranked most-urgent first:

| Class | Spoken as | Fires on |
|---|---|---|
| `permission-prompt` | waiting on a permission prompt | A modal has stopped the agent — it waits forever. Includes Claude Code's trust-folder prompt (`Enter to confirm`). |
| `rate-limited` | rate-limited | The assertive limit banner. **Not** the standing tip that merely mentions the limit. |
| `refusal` | refusing the work | An [ADR-139](adr/139-refusal-pattern-detection.md) refusal phrase in the pane tail. |
| `dead` | session is down | The team's tmux session, or the member's window, is absent under its **resolved** name. |
| `crashed` | no agent running in the pane | tmux reports the pane process exited, or there is no agent chrome and the pane is a shell. |
| `frozen` | spinner stalled | A live-turn marker on screen while the window's tmux activity clock has not moved for 5 min. |
| `unresponsive` | no agent output at all | No recognizable agent chrome — blank, or something that is not a TUI. |
| `idle-residue` | idle with unsubmitted text | The wedge class: text sitting in the composer, no active turn, and the window has been still for over a minute. |
| `lead-ask` | asks waiting for you | Unread `driver-inbox.md` entries and/or open `flags.md` rows. Team-level, not per-pane. |
| `dormant` | parked with nothing queued | Agent chrome, empty composer, no output for over an hour. **Chronic, not news** — ranked last, and `fleet_quiet` counts it separately so a merely-parked fleet still reports as nominal. |

Quiet classes — `working`, `compacting`, `starting up`, `idle and clear` — are counted, never enumerated.

### The rules that keep it honest

- **A pane joins the quiet set only on POSITIVE evidence** — a live-turn marker, a compaction banner, or agent chrome with an empty composer. Absence of anything bad is never enough.
- **A live-turn marker is corroborated against tmux's own activity clock**, which is not derived from the pane text. A spinner that has not repainted in 5 min is `frozen`, not `working`.
- **Panes are enumerated from tmux windows, not the roster.** Most teams on this fleet carry `members: []` while their sessions hold live `driver` windows; a roster-driven sweep would report "0 panes, all clear" across working agents.
- **A team that cannot be read is reported as UNREADABLE, never omitted.** Rows are grouped by reason so five teams sharing one cause cost one clause, not five.
- **Session names are resolved through the anchor** (`.atmux/state/session.txt` via `resolveCageSessionName`), never rebuilt as `atmux-<team>`. On this fleet `unum` anchors to `atmux_unum` and `atmux` to bare `atmux`; the rebuilt form names no session at all and reported every member of a healthy team as down.

### Speech budget

`fleet_attention` speaks at most `top` entries. Same-class findings on the same team **collapse into one entry** (`dash — 7 panes (docs, driver, driver-2 +4)`) so one team's single cause cannot eat the whole budget. Everything beyond the budget becomes a count with a reason breakdown. `fleet_quiet` never names a pane.

## §6.6 — Pane input: `pane_nudge` / `atmux nudge`

> **Shipped alongside [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) D4 (`pane_nudge` half) + D5.** Allow-list, after-state classifier and receipt renderer: `src/core/voice/nudge.ts`. IO: `src/verbs/nudge.ts`, also reachable as the CLI verb `atmux nudge`. **`pane_send` is NOT shipped** — it is still gated on ADR-273 OQ-1.

The overnight case `fleet_attention` finds and could not act on: a pane wedged with unsubmitted text that needs one keystroke.

```bash
atmux nudge --member be-1                       # press Enter on what the composer holds
atmux nudge --member be-1 --action continue     # type the single word "continue" and submit
atmux nudge --member be-1 --json                # the structured receipt
```

| Flag | Default | Meaning |
|---|---|---|
| `--member <name>` | — required — | Roster member whose pane to nudge. **Not** an arbitrary tmux window — see the two limits below. |
| `--action <a>` | `submit` | `submit` \| `continue`. The allow-list is **fixed in code**; anything else is a usage error. |
| `--team-dir <dir>` | cwd walk-up | Team root. |
| `--socket <path>` | `resolveTeamSocket(team)` | Cage socket override. |
| `--settle-ms <n>` | `1500` | Wait between delivery and the after-read, so a TUI repaint is not mistaken for "unchanged". |
| `--json` | off | The receipt as JSON — both verdicts with their evidence. |

**Exit codes carry the verdict, not merely that a send went out.** `0` = delivered and the pane moved. `1` = delivered and the pane is in the same classified state it was in before — *the nudge did not take*. `64` = bad argv or an action outside the allow-list. `78` = a driver pane, or a member the roster does not carry.

### It never sends operator text — that is the whole reason it can ship

`pane_send` (free text into an agent with full tool access) inherits [ADR-272](adr/272-voice-operator-interface.md) §Deferred's **second-factor** requirement and is still an operator decision. `pane_nudge` does not, because three separate things bound it:

1. `action` is a **zod enum**, so a transcript *selects* an action and can never *author* one.
2. The word pasted is a **compile-time constant** looked up from that enum name. The model's string never reaches the pane.
3. The tool declares **no free-text parameter at all** — a unit test fails if one ever appears, because that is exactly what `pane_nudge` becoming `pane_send` looks like.

| Action | Sends | Use it for |
|---|---|---|
| `submit` | **nothing** — a bare verified submit | `idle-residue` (the wedge) and `permission-prompt`. Pastes nothing, so it cannot corrupt the residue it is submitting. |
| `continue` | the single word `continue` | `dormant` / `frozen` — a pane that stopped with an **empty** composer. Never use it on residue: it would concatenate. |

⚠️ **`submit` on a permission prompt accepts that modal's default selection.** That is the intended 2am behaviour and it is still a real grant of authority. Hear the finding from `fleet_attention` first.

### Two limits you will hit immediately

- **Driver panes are refused, by rule.** [ADR-239](adr/239-three-driver-minimum-per-team-and-no-sendkeys-invariant.md) §D2: atmux never sends keystrokes into a `driver` / `driver-N` pane. Most `idle-residue` findings on this fleet are on driver windows, so this is the first thing you will try. The refusal is raised up front and names the ADR; press Enter yourself.
- **The member must be in `team.json`.** Delivery goes through `atmux send`, which addresses roster members. The sweep enumerates from **tmux windows** (most teams carry `members: []`), so a pane can be *reported* and not be *nudgeable*. Closing the gap would mean either a roster-driven sweep — which reports "all clear" across a working fleet — or a delivery path that is not `atmux send`, which D5 forbids. The gap is documented, not hidden.

### The receipt

Delivery is **verified**: the pane is read before, delivered to, then read again and classified with the same fleet classifier the survey uses.

```
NUDGE atmux/be-1 (window ⚙-be-1) — pressed Enter to submit what was already in the composer
before: idle with unsubmitted text — unsubmitted: claim --next
after: working
the composer cleared and the agent is now working
```

…and when it does not work, it says so and exits 1:

```
NUDGE atmux/be-1 (window ⚙-be-1) — pressed Enter to submit what was already in the composer
before: idle with unsubmitted text — unsubmitted: claim --next
after: idle with unsubmitted text — still unsubmitted: claim --next
the pane is unchanged — the nudge did not take
```

The after-read deliberately **does not** use the survey classifier's "residue plus recent activity means someone is typing" rule: the recent activity is our own paste, and honouring it would report a failed nudge as "idle and clear". See ADR-273 §Supplement-2 T4.

### `atmux send --submit-only`

The delivery primitive `submit` uses, and the only new capability in the send path: skip the buffer/paste pair and run the **same** settle + `C-m` + [ADR-138](adr/138-verified-send-keys.md) verify-and-retry step the paste path runs.

```bash
atmux send --submit-only <member>     # single-member only; takes NO message
```

It is refused with a usage error when combined with a message body, with `--no-submit`, with `--broadcast`, or with the cockpit-tier `__medic__` key — each of those would silently drop something you asked for, or write an empty inbox row and call it success.

## §7 — Verification checklist (V-1 … V-18)

> **Filled in progressively: V-1…V-8 in P4, V-9…V-17 in P5, V-18 in P7.** Every row starts as a placeholder. A row is marked done only with a **receipt** — a command and its output, a paste-id, or a screenshot — never "looks fine". **A row goes green because the underlying thing became true, never because the wording was loosened.**

> 🔴 **A green headless run is NOT "voice works".** convoke defect 2 (`sampleRate: 16000` is advisory; iOS delivers 48 kHz) and defect 4 (`AudioContext` created outside a user gesture; iOS leaves it suspended) both pass on desktop Chrome and both make the app silently useless on a phone. **V-9…V-17 are hand-run on a physical device and are not optional.**

### Headless (V-1 … V-8) — lands in P4

> **Status vocabulary.** ✅ **PASS (live)** = run against the real deployed server — and, where the row is about the provider, against the real provider API. ✅ **headless-verified** = a command was run in this repo and its outcome recorded here. ⚠️ **partial** = the mechanism is verified, but a leg of the check is still open; the row says which leg. ⏳ **operator step** = nothing in this repo can close it.
>
> A green automated suite is evidence about the *transport and the state machine*, not about the *provider*. **That gap closed on 2026-08-15**: the first live deploy dialled both providers against their real APIs, and V-2…V-7 were closed there. The rows below say which evidence each one rests on.
>
> **Still open, deliberately — do not read the table as "P4 is finished":**
>
> - **V-1's compiled/`$bunfs` leg.** `build:install` swaps the atmux CLI fleet-wide, so it was **not** run during the deploy. Dev-mode is verified; compiled mode is not, and V-1 stays ⚠️ until it is.
> - **`atmux voice --supervise`.** The detached-session + crash-loop + circuit-breaker path has unit coverage of the script it generates, but has **never been exercised as a running supervised server**. The deploy ran `--serve` in the foreground. There is no V-row for it; treat it as untested until someone runs it and records the result.

| ID | Check | Pass criteria | Status |
|---|---|---|---|
| V-1 | Assets resolve in **both** modes | `ATMUX_VOICE_ASSETS_DIR` unset: dev-mode resolves `<repo>/templates/voice`, compiled resolves `/opt/atmux/<v>/templates/voice`. Both serve `index.html`. | ⚠️ **partial** — dev-mode verified: `atmux voice --print-assets-dir` prints `<repo>/templates/voice`, and a test now drives **every key of the `VOICE_ROUTES` map** (all 11, including `js/protocol.js`, `js/audio.js` and `worklet/capture.js`), asserting 200 + the declared mime + the declared cache-control + a non-empty body for each. **Compiled mode is an operator step** — it needs `build:install` + the `/opt/atmux/<v>` binary; run `atmux voice --print-assets-dir` from the installed binary and expect `/opt/atmux/<v>/templates/voice`. |
| V-2 | HTTP asset surface | `200` + correct `Content-Type` for `.html` / `.js` / `.css` / `.webmanifest`; **`401` on `/ws` without a valid token** (the PWA shell itself is served unauthenticated in O1 by design — only the WebSocket is token-gated); `404` on a `../` traversal attempt; `Cache-Control: no-store` on `app.js`; **no API key in any response body or header**. | ✅ **headless-verified** — `bun test ./tests/unit/verbs/voice.test.ts`. Asserts the four content-types + `no-store` on html/css/js/manifest and `immutable` on icons; `/ws` without a token → 401; six traversal/prototype shapes (`/../etc/passwd`, `/%2e%2e/...`, `/js/../../../etc/passwd`, `/toString`, `/constructor`, `/nope.html`) → 404; and that no served body or header contains the api key or the token. Traversal is structurally impossible: `VOICE_ROUTES` is an exact-key map with no filesystem lookup. **Also ✅ PASS (live) 2026-08-15** — assets served, and mime + cache headers confirmed, through the deployed nginx vhost rather than only against a test `Bun.serve`. |
| V-3 | Probe through **loopback** | `scripts/voice-probe.ts` against `127.0.0.1:4390` completes a full auth → audio → transcript → tool-call → result round trip. | ⚠️ **partial** — the full round trip is verified against a **real `Bun.serve` with a FAKE provider** (`bun test ./tests/unit/core/voice/probe.test.ts`): hello (authenticating at the **pre-upgrade** gate via `Authorization: Bearer`) → ready → all 50 tone frames arrive at the provider leg, reassembled and compared **byte-for-byte against the synthesized PCM** with one `TURN_END` → downlink audio frames + `transcript.assistant` return to the client. **Also ✅ PASS (live) 2026-08-15** — run against a real listening `atmux voice --serve` over loopback, against the real provider API. (This is the run whose first attempt exposed the retired-beta dial failure and the silent server log; both are fixed, and the probe then completed.) |
| V-4 | Probe through **nginx + TLS** | Same probe against the public `wss://` URL. Catches upgrade-header and `proxy_read_timeout` misconfiguration that loopback hides. | ✅ **PASS (live) 2026-08-15** — `docs/deploy/atmux.geoy.ws.conf.example` (both files) installed, and `scripts/voice-probe.ts` run against the public `wss://` URL through nginx + TLS. The upgrade headers and `proxy_read_timeout` are exercised by the fact the probe completed rather than being cut mid-session. |
| V-5 | Negative auth matrix | Each of: no token · wrong token · right token + **disallowed `Origin`** · valid upgrade but missing/mismatched `hello.token` — is **rejected**, and rejected at the documented layer. | ✅ **headless-verified** — `bun test ./tests/unit/verbs/voice.test.ts` + `./tests/unit/core/voice/session.test.ts`. All four, each at its documented layer: no token → HTTP **401**; wrong token → **401**; right token + disallowed `Origin` → HTTP **403** (and wrong-origin-*and*-no-token also reads 403 — the CSRF verdict wins, per the ordering pin in `auth.ts`); valid upgrade + bad `hello.token` → WS close **4401**. Plus: no `hello` within 3s → **4408**, pre-hello garbage → **4400**. **Also ✅ PASS (live) 2026-08-15** — the full negative matrix re-run against the deployed server through nginx, including the origin-checked-before-token ordering. |
| V-6 | Token absent from logs | After V-4, `grep` the nginx access log for the token value → **no match** (`access_log off` in effect). | ✅ **PASS (live) 2026-08-15** — grepped the live nginx access log for the token value after V-4: no match. Verified **with a control** — a value known to be present was grepped from the same file in the same way, so the empty result is evidence that the token is absent, not that the grep was looking at the wrong file. |
| V-7 | **Provider swap, zero client diff** | Flip `ATMUX_VOICE_PROVIDER` `openai-realtime` → `gemini-live`, restart, re-run V-3. Passes with **byte-identical client assets**. Any required client change means the D4 seam leaked. | ✅ **PASS (live) 2026-08-15** — swapped to `gemini-live` and re-ran the probe against the **real Google endpoint**, with no client-side change of any kind. Receipt: `provider=gemini-live model=gemini-2.5-flash-native-audio-preview-09-2025` · `voice-probe: ok=true uplinkFrames=50 downlinkFrames=14 downlinkBytes=71040` · `frameTypes=[ready,status,transcript.user,transcript.assistant]` · `closeCode=1000`. Downlink audio came back and both transcript directions appeared, so the D4 seam holds across a real provider swap — the concrete acceptance test for ADR-272 §D4. |
| V-8 | Confirm-token enforcement (D7) | A confirm-gated tool: (a) does **not** execute on first call, (b) executes on redemption, (c) is **refused on a second redemption** (single-use), (d) is **refused after `ATMUX_VOICE_CONFIRM_TTL_MS`**, (e) is **refused when redeemed with mutated arguments** (argument-binding). All five, server-side. | ⚠️ **partial** — all five are enforced and unit-tested server-side in P3 (`tests/unit/core/voice/confirm.test.ts` + `tool-bridge.test.ts`). P4 adds the relay half: a `needs_confirmation` envelope sets the pinned snake_case `needs_confirmation` flag on `tool.done` and the **full envelope** reaches the provider verbatim (`session.test.ts`). **End-to-end through a live model is an operator step** — ask the assistant to dispatch a task and confirm the preview is read back verbatim before anything runs. |

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
| Server refuses to start, exit 78 | Missing `ATMUX_VOICE_TOKEN` (or <32 chars), or the provider's API key | The stderr line names the exact variable. `openssl rand -hex 32` for the token; source the API key from the git-crypt'd dotfiles env, never argv. |
| HTTP 401 on `/ws` | Token missing or wrong at the **pre-upgrade** gate | Token precedence is `Authorization: Bearer` → `?token=` → `atmux_voice` cookie (`src/core/voice/auth.ts::extractToken`). Confirm the URL actually carries `?token=`. |
| HTTP 403 on `/ws` | `Origin` present but not in `ATMUX_VOICE_ORIGINS` | Origin is checked **before** the token, so a 403 means CSRF, not credentials — even when the token is also absent. Confirm nginx passes `Origin` through unmodified (the example conf sets `proxy_set_header Origin $http_origin`). |
| Socket opens then closes 4408 | No valid `hello` within 3s | The client connected but never sent `hello` — usually a client-side JS error before the first send. Check the browser console. |
| Socket closes 4401 after opening | `hello.token` mismatched | The pre-upgrade token and the `hello.token` are checked separately; both must be the same secret. |
| Socket closes 4001 | Another device claimed the session | Latest-wins by design (ADR-272 D8). The displaced client receives a `takeover` frame first. |
| Socket closes 4500 | Provider dial exhausted 5 attempts (250ms→4s backoff) | **Read the server's stderr — it now names the cause.** Look for the `voice: dial exhausted — 5 attempts in <n>ms …; last provider error [<code>] <message>` line and the five preceding `dial attempt N/5 failed` lines. Each names the provider, the model, which of the three faults occurred, and the provider's own error code. The server also sends `error{code:"provider-unrecoverable",fatal:true}` to the phone before closing. |
| 4500 and the server log is EMPTY except the banner | Pre-2026-08-15 build | This was the original defect: the dial had every fact and discarded all of them, so a 5-attempt exhaustion diagnosed only by hand-probing the live provider API. If the log is still silent on a failed dial, the running binary predates the fix — check `atmux --version` against the deployed `/opt/atmux/current`. |
| Long pause, then 4500, with no obvious network fault | The provider opened its socket and went quiet — no `session-ready` | The log says so explicitly: `no session-ready within 12000ms (socket opened, provider handshake never completed)`. `connectWebSocket` bounds only the WS *handshake* (10s); `session-ready` arrives afterwards from an inbound provider frame (OpenAI `session.created`, Gemini `setupComplete`). A provider that accepts the socket then stalls — or sends a frame its adapter cannot parse — is caught by the 12s `SESSION_READY_TIMEOUT_MS` budget and retried. Worst case is ~68s before 4500, deliberately inside the 120s idle close so the cause is reported honestly rather than as an idle timeout. |
| Log says `connect failed — …` rather than `no session-ready …` | The socket was **refused**, not stalled | A different fault from the row above, and deliberately worded differently: nothing opened. Check DNS, egress, and provider status from hax. |
| 4500 immediately, log shows `[beta_api_shape_disabled]` | Something reintroduced an **OpenAI Realtime BETA opt-in** | The beta API is retired: the server rejects the first frame with `error{code:"beta_api_shape_disabled"}` and closes **4000**. There are two independent opt-ins and either one is fatal — the `OpenAI-Beta: realtime=v1` **header** and the `openai-beta.realtime-v1` **subprotocol** element. Neither belongs in `src/abstractions/voice/openai-realtime.ts`; the GA dial is Bearer-only (or a two-element protocol list). See that file's header for the GA `session.update` nesting. |
| Log shows `further provider errors on this leg suppressed` | A provider is erroring repeatedly on one leg | Expected, not a fault in itself: the log caps non-fatal provider errors at 3 per leg so a per-frame error cannot flood stderr. The first 3 carry the diagnosis; the eventual `dial attempt` / `dial exhausted` line still quotes the last one. |
| A log line shows `<redacted>` where a URL or header should be | Working as designed | `createVoiceLogger` redacts the API key, the voice token, and anything shaped like a credential (`?key=`, `Bearer …`, `sk-…`) before the line is written. If you need the raw value, read it from the dotfiles env — it is deliberately not recoverable from a log. |
| Looking for what the operator SAID in the server log | Wrong place, by design | Connection logs carry no speech. Transcripts are bounded separately by [ADR-272](adr/272-voice-operator-interface.md) OQ-4 (`~/.atmux/voice-logs/`, local-only, 7-day retention) and are off-by-default until P7 decides otherwise. |
| Session drops after ~60 s of silence | nginx `proxy_read_timeout` shorter than a realistic pause | The example conf sets `proxy_read_timeout 3600s` on `/ws`. A 60s drop means the default is still in effect — you edited the wrong server block. |
| Session closes 1000 after ~2 min idle | `IDLE_CLOSE_MS` (120s, no phone frames of any kind) | By design; the session is **parked**, not destroyed. Reconnect with `hello.resume=<sessionId>` inside `ATMUX_VOICE_RESUME_GRACE_MS`. |
| Assistant says it cannot send messages | `ATMUX_VOICE_READONLY=1` | Intended for O1. The 4 messaging tools are **absent from the catalog**, so the model is telling the truth. `/healthz` reports `readonly`. |
| Tool call times out | `ATMUX_VOICE_TOOL_TIMEOUT_MS` exceeded | The timeout bounds the **response**, not the execution — the verb keeps running under the mutex and the next tool queues behind it. A slow `topo` on a large fleet is the usual cause. If it happens **once**, that is all it is; if **every** tool call times out from then on, read the next row. |
| **Every** tool call answers `tool_timeout` from some point onward, and the assistant otherwise sounds fine | The tool bridge is **wedged** — a verb never returned and still holds the verb mutex | `curl -s localhost:4390/healthz \| jq`. `ok:false` with `degraded:"tool-bridge-wedged"` confirms it, and `bridge.stuckTool` names the verb. There is **no self-recovery**: the mutex has no abandon path, and no wired verb calls `process.exit`, so the process stays up and useless. Recovery is `atmux voice --stop` then `--supervise`. Capture `bridge.stuckTool` + `bridge.heldMs` first — that pair is the whole bug report. |
| `/healthz` says `ok:true` but voice does nothing | Pre-2026-08-15 build, or a fault outside the bridge | `ok` became a real verdict on 2026-08-15; before that it was the literal `true` and a wedged bridge reported green. Check the deployed version first. If `ok:true` is current and correct, the bridge is fine — look at the provider dial (§8 rows above) instead. |
| `bridge.queueDepth` is large and growing | Tool calls piling up behind a stuck (or very slow) verb | Depth is reported rather than capped, deliberately: a cap would answer each call cheerfully and hide the wedge. A rising depth alongside `wedged:false` means genuinely slow verbs; alongside `wedged:true` it means the wedge above. |
| `atmux voice --status` says `healthz=ok` while the bridge is wedged | Expected — they measure different things | `--status` probes reachability (`isReachable`, any 2xx). `/healthz` stays **200** while wedged on purpose, so a wedged-but-listening server is distinguishable from an absent one. **Read the body, not the status**, when you care about function rather than presence. |
| Tool answers about the wrong team | Team resolution walked to a different cockpit entry | Resolution is a ladder (exact → case-fold → suffix-strip → unique prefix → Levenshtein ≤2); an ambiguous utterance returns `ambiguous_team` with candidates rather than guessing. `atmux voice --status` shows the provider; `list_teams` shows what the index actually holds. |
| Supervised server flapping | Circuit breaker tripped (5 restarts in 60 s) | `tmux -L default attach -t atmux-voice` — the wrapper stops respawning and drops to a shell so the real error stays on screen. |
| `--supervise` says "already running" but nothing answers | Session alive, server dead inside it | `atmux voice --status` distinguishes the two (`session=up healthz=unreachable`). Attach to read the pane, then `atmux voice --stop` and re-supervise. |
| Reply audio is slow and deep-pitched | Sample-rate mismatch — the client is shipping 48 kHz labelled 24 kHz (convoke defect 2) | *stub — P5* |
| No audio at all, no error in the UI | `AudioContext` suspended — created outside a user gesture (convoke defect 4) | *stub — P5* |

## §9 — Related

- [ADR-272](adr/272-voice-operator-interface.md) — design, decisions D1–D11, security model, deferred scope.
- [ADR-260](adr/260-manual-orchestration-mode-default.md) — why an unreachable operator is a coordination gap.
- [ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md) — no boot autostart; the constraint on §4's supervision shape.
- [ADR-033](adr/033-kanban-driver-only-flag.md) — the `ATMUX_CALLER_SCOPE=driver` gate the server satisfies.
- [ADR-258](adr/258-vendor-agnostic-orchestration-agentbackend.md) — the adapter precedent the provider seam copies, and the orchestration seam ADR-272 §D1 fences itself off from.
- `/root/work/src/convoke` — abandoned predecessor. Prior art and defect corpus only; **no code is ported from it**.
