# RUNBOOK — `atmux vox` (spoken operator interface)

Operator-facing reference for **`atmux vox`** — the mobile-PWA voice assistant for the fleet. Design and rationale live in [ADR-272](adr/272-voice-operator-interface.md); this runbook is the operating surface and the acceptance checklist.

> **Status: P1–P6 landed; first live deploy 2026-08-15.** The feature ships in phases P1–P7. §3–§6 describe shipped behaviour. A section still marked **lands in P\<n\>** documents the contract the implementation ships against — running the commands in it before that phase is a usage error, not a bug.
>
> **What the 2026-08-15 deploy actually closed:** the headless rows **V-2 … V-7** — assets and headers through nginx, the loopback probe, the `wss://` probe through nginx + TLS, the full negative-auth matrix, token-absent-from-logs (with a control), and the provider swap to `gemini-live` against the **real** Google endpoint. Both adapters have now dialled their real APIs.
>
> 🔴 **Still true, and it is the part that matters: no part of this has run on a phone.** V-9 … V-17 are hand-run on a physical device and every one is still a placeholder. Two of convoke's four fatal defects pass a desktop test, so a green headless set is **not** "voice works". Also still open: V-1's compiled/`$bunfs` leg, and `atmux vox --supervise`, which has never been run as a live supervised server. §7 marks each honestly; read it before believing the feature works.

> **Name discipline:** the feature is `voice` / `atmux vox`. Not "Jarvis" — that is how the ask was phrased, not what the thing is called. Not "convoke" — `/root/work/src/convoke` is an abandoned predecessor and reusing the name would be forbidden ambiguity.

## §1 — Purpose

Give the operator a read of the fleet, and a way to move work along, **without a keyboard**. The operating picture is the operator away from the desk — walking, in a lift, in a car — wanting what `atmux status` would tell him and the ability to nudge a lead.

This matters more than a convenience feature because of [ADR-260](adr/260-manual-orchestration-mode-default.md): manual orchestration is the fleet default, so the operator and the lead LLMs **are** the coordination mechanism. An unreachable operator is a missing scheduler.

Two properties bound the whole thing, both from [ADR-272](adr/272-voice-operator-interface.md):

- **Every voice tool is an `atmux` verb invocation** (§D2). No `Database` opens, no raw `tmux`, no shell interpolation, no `run_command` escape hatch. Deleting the voice server removes a microphone, not a power.
- **The server runs as the driver** (§D3, `ATMUX_CALLER_SCOPE=driver`). Whoever reaches the WebSocket *is* the driver. That is why §5's auth is layered and why v1's tool surface is narrow.

## §2 — Architecture sketch

```
  ┌─────────────┐   WSS (TLS)     ┌──────────────┐   WS (loopback)   ┌──────────────────┐
  │  phone PWA  │ ──────────────► │    nginx     │ ────────────────► │  atmux vox     │
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

> ⚠️ **`ATMUX_VOICE_*` still works, and warns** — `SUNSET(v0.9.1)`, [ADR-274](adr/274-atmux-vox-rename.md) D2. Every knob below is read under its pre-rename `ATMUX_VOICE_*` name too, but **only as a fallback, where the `ATMUX_VOX_*` equivalent is unset**. An exported-but-empty value counts as unset and cannot shadow a real one.
>
> **When both are set, `ATMUX_VOX_*` wins** and the legacy name is called out — louder when the two values *differ*, because that is the failure that costs the most time: everything looks configured and the wrong value is the one in play. If a knob is not taking effect, check for a stale `ATMUX_VOICE_*` twin before anything else.
>
> The fallback exists for shells and dotfiles that predate the rename, not as a configuration. Rename them, and the warnings stop. In `v0.9.1` the fallback is deleted and an unrenamed `ATMUX_VOICE_TOKEN` becomes a hard refusal to start.

| Variable | Default | Required | Meaning |
|---|---|---|---|
| `ATMUX_VOX_TOKEN` | — none — | **yes** | Shared secret, **minimum 32 characters**. The server **refuses to start** without it: no default, no generated-and-printed fallback. Checked timing-safely before the WebSocket upgrade, then re-asserted in `hello.token`. |
| `ATMUX_VOX_PROVIDER` | `openai-realtime` | no | Adapter id. `openai-realtime` \| `gemini-live` — both adapters shipped. Resolved **once, at session construction** — no hot-swap, no mid-session failover (ADR-272 §D4). |
| `ATMUX_VOX_MODEL` | provider adapter's default | no | Provider-specific realtime model id. |
| `ATMUX_VOX_PORT` | `4390` | no | Listen port. |
| `ATMUX_VOX_HOST` | `127.0.0.1` | no | Bind address. **Binding `0.0.0.0` needs its own ADR** — it removes the assumption every other auth layer is designed against (ADR-272 §Security layer 4). |
| `ATMUX_VOX_ORIGINS` | — none — | **in practice, yes** | Comma-separated `Origin` allowlist. This is the **CSRF** defense: browsers do not apply same-origin policy to WebSocket handshakes, so without it any page the operator visits can ride his O2 session cookie into a driver-scope socket. ⚠️ **The server does NOT refuse to start without it** (only `ATMUX_VOX_TOKEN` does that). An empty allowlist means every *present* `Origin` is rejected — so the PWA cannot connect at all — while a request with **no** `Origin` header is allowed through to the token check (`checkOrigin` in `src/core/vox/auth.ts`: native apps and `scripts/vox-probe.ts` send none). Set it before the PWA is expected to work. |
| `ATMUX_VOX_TOOL_TIMEOUT_MS` | `20000` | no | Per-tool wall-clock deadline. A tool that exceeds it returns a spoken error; it does not hang the session. |
| `ATMUX_VOX_MAX_RESULT_CHARS` | `2000` | no | Truncation ceiling for a tool result before it reaches the model. Voice results are **spoken**, so a 40 KB pane dump is both expensive and useless. |
| `ATMUX_VOX_READONLY` | unset | no | `1` ⇒ only the 14 read tools exist (12, plus `host_pressure` + `token_budget` from [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) §Supplement-6); the 4 messaging tools **and `pane_nudge`** are **absent from the catalog**, not merely refused at call time. **This is the setting the feature first ships in**, which is why `pane_nudge` is unreachable until P7 despite being built. Carries a `SUNSET` marker per [ADR-266](adr/266-shim-sunset-policy-and-first-sweep.md) §D1; cleared in P7. |
| `ATMUX_VOX_RESUME_GRACE_MS` | `90000` | no | How long a dropped phone's **provider leg is parked** for `hello.resume` (ADR-272 §D8 — the walking-into-a-lift case). |
| `ATMUX_VOX_CONFIRM_TTL_MS` | `120000` | no | Lifetime of a D7 confirmation token. Single-use, and bound to `sha256(tool ‖ canonical_json(args) ‖ session_id)`. |
| `ATMUX_VOX_TRANSCRIPTS` | unset (**off**) | no | `1`/`true` ⇒ write session transcripts to `~/.atmux/vox-logs/vox-<sessionId>.jsonl` — one file per session, one JSON line per **final** utterance (`ts` / `iso` / `session` / `role` / `text`), file `0600` inside a `0700` directory. **Off is the shipped posture** ([ADR-272](adr/272-voice-operator-interface.md) OQ-4): a transcript is a durable record of everything said near the microphone, so the operator opts in. The banner says `transcripts=true|false` so you can see which you are running. There is deliberately **no directory override** — the path is derived from `$HOME` so a transcript can never land in a product checkout ([ADR-268](adr/268-managed-repo-state-isolation-enforcement.md)) or on a synced path. |
| `ATMUX_VOX_TRANSCRIPT_RETENTION_DAYS` | `7` | no | Retention window. Swept at server start and every 24h after; a file **exactly** 7 days old is kept, an older one is deleted. The sweep runs **even when `ATMUX_VOX_TRANSCRIPTS` is off** (it only deletes), so turning recording off still ages out what is already there. It deletes **only** names matching `vox-<id>.jsonl` — anything else you leave in that directory is untouched at any age. Fails closed to 7 on a bad value; shortening is the operator's call, lengthening wants a reason. |
| `ATMUX_VOX_ASSETS_DIR` | `resolveTemplatesDir()/vox` | no | Override for the client asset root. The default resolves install-mode `/opt/atmux/<v>/templates/vox` and dev-mode `<repo>/templates/vox` through `src/core/templates-dir.ts` — V-1 checks both. |
| `ATMUX_VOX_SKIP_MODEL_CHECK` | unset | no | `1`/`true` ⇒ skip the boot-time **model-pin drift check** (§6.7). For offline and dev use. The startup line says loudly that it was skipped, because a retired model id will then not be caught until a call fails with 4500. |
| `ATMUX_VOX_BIN` | the `atmux` on `PATH` | no | The atmux binary **`--supervise`** re-execs in its crash-loop wrapper. Precedence: per-call override > this > `resolveAtmuxBin()` (`Bun.which("atmux")` → `process.execPath`). **Fails closed** — an empty or whitespace-only value falls through to the next layer rather than producing a wrapper that execs `''`. Set it when supervising from a **repo checkout**: the installed `/usr/local/bin/atmux` → `/opt/atmux/<v>` may predate the `vox` verb, in which case the wrapper prints `unknown verb: vox`, exits 64, and crash-loops until the breaker trips (observed live 2026-08-15). The alternative — `bun run build:install` — swaps the atmux CLI **fleet-wide** for every team on the box, which is a release, not a supervision detail. See [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) §Supplement. |

### Provider API keys

`OPENAI_API_KEY` / `GEMINI_API_KEY` come from the operator's **git-crypt'd dotfiles env** (`~/work/journals/.sb/_dotfiles`; inventory in `keys/KEYS.md`). They are **never committed**, never written into this repo, never passed on argv (tmux pane capture records command lines), and never appear in any client-bound frame — V-2 and the `ready`-frame key-set unit test both assert that.

## §4 — Start / stop

> **Shipped in P4** — `src/verbs/vox.ts`.

```bash
atmux vox --serve       # foreground; the development and first-deploy form
atmux vox --supervise   # detached tmux session `atmux-vox`, crash-loop wrapper
atmux vox --status      # is it running, and what the RUNNING SERVER says it is doing
atmux vox --stop        # stop the server and tear down the supervised session
```

**Flags** (all actions default to `--serve`; two *different* action flags in one invocation is a usage error, never a silent last-wins):

| Flag | Meaning |
|---|---|
| `--port <n>` | Listen port override (flag > `ATMUX_VOX_PORT` > 4390). Must be a positive integer. |
| `--provider <p>` | `openai` \| `openai-realtime` \| `gemini` \| `gemini-live`. |
| `--model <m>` | Realtime model id; defaults to the adapter's (`factory.ts::defaultModelFor`). |
| `--readonly` | Force readonly. Removes the 4 messaging tools from the catalog the model receives. |
| `--max-frames <n>` | Exit 0 after `n` **binary** phone frames are processed. The bound that makes a serve scriptable in a probe or e2e run; JSON control frames do not count. |
| `--print-assets-dir` | Print the resolved PWA assets dir and exit 0. The dev-vs-`$bunfs`-compiled verification hook (V-1). Does **not** require an API key. |

**Exit codes.** `--serve` returns 0 on SIGINT / SIGTERM / frame budget. `--status` returns **0 only when the session is up AND `/healthz` answered with a readable body**, else 1 — so it is usable directly in a shell conditional. Bad argv is `UsageError` → 64; a missing `ATMUX_VOX_TOKEN` or provider API key is `ConfigError` → 78, raised **before anything binds a port**. (`--status` needs the token only because it resolves the same config object for the host and port; it never sends it.)

### `--status` output — the SERVER's state, never yours

**Every `vox: server:` field is parsed out of the fetched `/healthz` body.** The local environment of the shell you typed the command in is *not* a fallback: it appears only under an explicit `local config (NOT the server)` label, and only when the server could not be read at all.

Why the rule is spelled out this way: until 2026-08-16 `--status` fetched `/healthz`, threw the body away, and printed its own `deps.config.provider` / `deps.config.readonly` in its place. Observed live against `atmux.geoy.ws` — the server was `readonly:true`, `--status` said `readonly=false`, purely because the invoking shell had not exported the flag. **The inverse is the dangerous one**: a shell that *does* export `ATMUX_VOX_READONLY=1` would have reported `readonly=true` about a server on which every mutating tool was live — a false all-clear on the exact check an operator runs before trusting a deployment.

Reachable and healthy — three lines; every field on lines 2 and 3 came out of the server's `/healthz` body:

```
vox: session=up  healthz=ok  http://127.0.0.1:4390/healthz
vox: server: provider=openai-realtime  readonly=true  degraded=none
vox: server: bridge=ok  stuckTool=none  heldMs=-  queueDepth=0  wedgeThresholdMs=60000
```

Reachable but wedged — the whole `bridge` block is visible here now, not only from a raw `curl`:

```
vox: session=up  healthz=degraded  http://127.0.0.1:4390/healthz
vox: server: provider=openai-realtime  readonly=true  degraded=tool-bridge-wedged
vox: server: bridge=WEDGED  stuckTool=team_status  heldMs=184213  queueDepth=6  wedgeThresholdMs=60000
```

Unreachable — **no `vox: server:` line exists**, and the local values are labelled as local:

```
vox: session=up  healthz=unreachable  http://127.0.0.1:4390/healthz
vox: server state UNKNOWN — /healthz did not answer
vox: local config (NOT the server): provider=openai-realtime  readonly=true
```

A body that is not a `/healthz` body (wrong service on the port, truncated reply, an HTML 502 page) reads `healthz=malformed` with `server state UNKNOWN — /healthz answered with a body atmux could not parse`, and is treated as unreachable for the exit code. Unknown *extra* keys are fine — the parse is non-strict on purpose, so an older installed `atmux` can still read a newer server's `/healthz`.

| Line-1 word | Meaning |
|---|---|
| `healthz=ok` | Body read; the server reports `ok:true`. |
| `healthz=degraded` | Body read; the server reports `ok:false` — read line 3 for which lane is stuck. Still **exit 0**: the exit code carries reachability, the body carries the verdict. |
| `healthz=unreachable` | Nothing answered (refused / DNS / non-2xx / timeout ≥ 5s). **Exit 1.** |
| `healthz=malformed` | Something answered, but not a `/healthz` body. **Exit 1.** |

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

**Why `ok` can be false.** Every voice tool serializes through one verb mutex (`src/core/verb-capture.ts`) because the stdout-capture wrapper cannot run two verbs concurrently. The tool timeout bounds the **response**, not the **execution** — so a wired verb that never returns holds that mutex, and none of the wired verbs calls `process.exit`, so the process **wedges rather than crashing**. Voice runs unattended in a detached tmux session, so a probe reporting green through all of that is worse than no probe at all.

**What a wedge costs you now.** Since 2026-08-15 the lane degrades instead of dying ([ADR-272](adr/272-voice-operator-interface.md) §Supplement-P7 §R2): the queue is bounded, every `tool_timeout` carries a `reason` and names `stuckTool`, and calls whose deadline passed while queued are **skipped rather than executed late** — so the moment a stuck verb returns, the backlog drains and the next thing you say works. `atmux vox --stop` is still the only cure for a verb that never returns at all.

| `reason` on a `tool_timeout` | What actually happened |
|---|---|
| `still_running` | **Your** verb holds the lane and has not finished. Usually a genuinely slow `topo`. |
| `queued_behind` | You never started — `stuckTool` holds the lane and `heldMs` says for how long. |
| `queue_full` | The lane was already at its cap. **Nothing was run**; `stuckTool` names the blocker. |
| `abandoned` | You waited past your own deadline, so the call was skipped instead of running late. For a mutating tool this is the point: a `dispatch_task` must not fire minutes after you were told it timed out. |

- `wedgeThresholdMs` = `WEDGE_THRESHOLD_MULTIPLE` (3) × `ATMUX_VOX_TOOL_TIMEOUT_MS`. Past its own response deadline a tool is merely **slow** — already reported to the operator as a `tool_timeout`. Three deadlines in, it is **stuck**.
- `stuckTool` is the tool **name** only. Arguments are never put here: `/healthz` is unauthenticated, and arguments carry what the operator said.
- `queueDepth` is reported **and bounded** at `VERB_MUTEX_MAX_QUEUE` (8) since 2026-08-15 — this reverses the earlier "never capped" ([ADR-272](adr/272-voice-operator-interface.md) §Supplement-P7 §R2). The cap costs the signal nothing because `wedged` and `stuckTool` come from the **holder**, not the depth; and a call refused at the cap is answered with `reason:"queue_full"` **naming the stuck verb**, which is more than the bare timeout it used to get after waiting out its full deadline.
- The HTTP status stays **200** while wedged. `--status` reads any non-2xx as *unreachable* — and a wedged-but-listening server is a different fault from an absent one. The status carries reachability; the body carries the verdict. `--status` fetches and **parses** this body, so the wedge shows up as `healthz=degraded` + `bridge=WEDGED` in its output without exiting non-zero.
- The keys `ok` / `provider` / `readonly` are unchanged in meaning and position, so an existing reader keeps working; `degraded` and `bridge` are additions.

**Boot order is fail-closed and deliberate** (`buildVoiceDeps`): token → provider kind → API key → team index → catalog → bridge → registry → provider. A missing key is a startup refusal naming the variable, not a spoken error on the first tool call.

**Output discipline.** Everything the running server says goes to **stderr**. `process.stdout` is capture-owned while a tool's verb runs (`src/core/verb-capture.ts`), so a stdout write would be spliced into a spoken tool result. Only `--print-assets-dir` and `--status` — one-shot reads that exit before any capture exists — write to stdout. The startup banner prints host, port, provider, model, readonly, transcripts and the assets dir, and **never** the token or an API key.

### What the server logs, and what it will never log

Every stderr line goes through `createVoiceLogger` (`src/core/vox/log.ts`), which redacts **structurally** rather than by convention — the callsite cannot forget it and cannot bypass it. Two layers: the secrets the server actually holds (`ATMUX_VOX_TOKEN` and the provider API key), plus shape patterns for a credential it was never told about (`?key=` / `&api_key=` / `?token=` query auth, `Bearer …`, `openai-insecure-api-key.…`, bare `sk-…`).

**No speech, ever.** These lines are protocol and connection events — attempt counters, close codes, provider error codes, tool *names*. They carry no transcript text and no tool *arguments*. Transcripts are the sensitive payload bounded by [ADR-272](adr/272-voice-operator-interface.md) OQ-4 (local-only, `~/.atmux/vox-logs/`, 7-day retention) and go to a **separate sink** — see below.

### Transcripts (off by default)

Speech has exactly one persistence path, and it is not this one. With `ATMUX_VOX_TRANSCRIPTS=1`:

```
~/.atmux/vox-logs/vox-<sessionId>.jsonl
{"ts":1755216000000,"iso":"2026-08-15T00:00:00.000Z","session":"0192…","role":"user","text":"<what you said>"}
```

- **Finals only.** Providers stream partial deltas; only the closing `final: true` line of an utterance is written, so the file is the conversation rather than the same sentence in a dozen pieces.
- **Lazy.** The file is created on the first recorded line — a session where nobody spoke leaves nothing behind, not even the directory.
- **Never fatal.** A failed write (full disk, read-only `$HOME`) is logged **once** per session on the stderr sink and swallowed; it cannot end a live call. A failed retention sweep is counted and reported, never raised.
- **Retention** is `ATMUX_VOX_TRANSCRIPT_RETENTION_DAYS` (default 7), swept at boot and daily. The sweep runs regardless of whether recording is on, and touches only `vox-<id>.jsonl` names.

Where they go when they age out is `rm`, and nowhere else: nothing here ships, syncs, or forwards. If you want them gone now, `rm -rf ~/.atmux/vox-logs`.

> ⚠️ **`~/.atmux/voice-logs/` is now orphaned, and nothing will ever prune it.** [ADR-274](adr/274-atmux-vox-rename.md) moved both the directory (`voice-logs` → `vox-logs`) and the file prefix (`voice-` → `vox-`). The sweep only ever opens the NEW directory and only ever matches the NEW prefix, so anything recorded before the rename ages forever. That matters more here than for an ordinary leftover: these files are a verbatim record of everything said near the microphone, which is the exact thing the 7-day retention exists to bound. **If you ever ran with `ATMUX_VOICE_TRANSCRIPTS=1`, deal with the old directory by hand** — `ls ~/.atmux/voice-logs` to see what is there, then `rm -rf ~/.atmux/voice-logs`. If it does not exist, you never opted in and there is nothing to do.

The dial story, which is what the first live deploy went without:

| Event | Line |
|---|---|
| Successful dial (the whole happy path) | `vox: provider ready — openai-realtime/gpt-realtime attempt 1/5 in 312ms` |
| Provider reported a fault | `vox: provider error (openai-realtime/gpt-realtime) [beta_api_shape_disabled] The Realtime Beta API is no longer supported.` |
| Attempt failed — provider hung up pre-handshake | `vox: dial attempt 1/5 failed (openai-realtime/gpt-realtime) — provider closed before session-ready (code=4000 reason=beta shape disabled); last provider error [beta_api_shape_disabled] …; retrying in 500ms` |
| Attempt failed — socket opened, provider silent | `vox: dial attempt 1/5 failed (openai-realtime/gpt-realtime) — no session-ready within 12000ms (socket opened, provider handshake never completed); retrying in 500ms` |
| Attempt failed — socket refused | `vox: dial attempt 1/5 failed (openai-realtime/gpt-realtime) — connect failed — voice provider (openai-realtime): websocket connection failed — ECONNREFUSED; retrying in 500ms` |
| Budget exhausted → 4500 | `vox: dial exhausted — 5 attempts in 7500ms (openai-realtime/gpt-realtime); closing phone 4500 provider-unrecoverable; last failure: …; last provider error [beta_api_shape_disabled] …` |
| Mid-session provider close | `vox: provider closed mid-session (openai-realtime/gpt-realtime) code=1006 reason=network — redialing` |

Non-fatal provider errors are **capped at 3 per provider leg**, followed by one `further provider errors on this leg suppressed (logged 3)` notice — a misbehaving provider must not turn the log into a per-frame stream. The cap resets on every dial attempt, and the *record* is kept regardless, so the dial-failure line always quotes the real cause.

**`--supervise` creates (or idempotently re-attaches to) a detached tmux session named `atmux-vox` on the default socket** and runs the server under a crash-loop wrapper: `trap` on exit, 5-second backoff, and a **circuit breaker at 5 restarts inside 60 seconds** that stops retrying and leaves the failure readable in the pane instead of hiding it in a restart loop.

Why that shape, and not the three obvious alternatives (full reasoning in [ADR-272](adr/272-voice-operator-interface.md) §D10):

- **Not a cockpit window** — the cockpit reconcile pass prunes any window outside its wanted set (`src/verbs/cockpit.ts:1971-2041`, `action: "prune-orphan"`), so a voice window in `atx` would be killed silently at the worst moment.
- **Not a cage window** — cages are per-team ([ADR-162](adr/162-atmux-owns-tmux-infrastructure.md)); `atmux stop` on an unrelated team would end the call.
- **Not systemd** — [ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md) forbids anything atmux ships starting at boot. Convoke's orphaned `deploy/convoke.service` is the cautionary tale.

`atmux-vox` on the **default** socket collides with neither the cockpit (`atx`, on the dedicated `atmux-cockpit` socket) nor any cage (`atmux-<team>`, on path-explicit per-team sockets). It sits alongside the driver session ([ADR-044](adr/044-driver-session-on-default-socket.md)), which is the right tier: voice is operator infrastructure.

## §5 — nginx (phases O1 → O2)

> **Shipped in P4.** The repo example is **[`docs/deploy/atmux.geoy.ws.conf.example`](deploy/atmux.geoy.ws.conf.example)**. It contains **two files** separated by a banner comment — `limit_req_zone` / `map` live in an `http{}`-context `conf.d` snippet, the vhost in `sites-available`; nginx will not accept them concatenated. Install both, then `nginx -t && systemctl reload nginx`.

The vhost lives on `geoy.ws` (personal infra — `ifca.app` and `ifca.dev` are IFCA-only per `CLAUDE.md` §DNS).

**Phase O1 — first deploy, token-only.** TLS termination, WebSocket upgrade headers, `proxy_pass` to `127.0.0.1:4390`. The **only** credential is `ATMUX_VOX_TOKEN`. This phase ships with `ATMUX_VOX_READONLY=1` set, so the exposure during O1 is read-only by construction.

**Phase O2 — add `oauth2-proxy`.** An unauthenticated request never reaches Bun. Only after O2 does the claim "voice is behind OAuth" become true; before it, the token is the whole perimeter. `ATMUX_VOX_READONLY` is cleared in P7, **after** O2 — never before.

**Two nginx requirements are load-bearing, not stylistic:**

1. **`access_log off;` on the WebSocket location.** The token arrives as a `?token=` query parameter, so without this it is written to disk on every connection. V-6 asserts it is absent from the access log.
2. **WebSocket upgrade must be complete** — `proxy_http_version 1.1`, `Upgrade` / `Connection` headers, and a `proxy_read_timeout` longer than a realistic silent pause, or nginx will cut a live call mid-conversation.

## §6 — Probe

> **Shipped in P4.** `scripts/vox-probe.ts` — a thin shim; the logic lives in `src/core/vox/probe.ts` (so it sits inside the `src/**` coverage universe, the same split `scripts/lint-socket-resolver.ts` already uses).

A headless client that connects, authenticates, streams a short synthetic PCM utterance, and reports on the responses. It is what makes V-3, V-5 and V-7 runnable without a phone, and what a future regression is caught by.

```bash
bun scripts/vox-probe.ts --url ws://127.0.0.1:4390/ws --token "$ATMUX_VOX_TOKEN"
bun scripts/vox-probe.ts --url wss://atmux.geoy.ws/ws --token "$T" --seconds 12
bun scripts/vox-probe.ts --url ws://127.0.0.1:4390/ws --token "$T" --text "fleet status"
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

> **Shipped alongside [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) D1–D3.** Classifier + renderer: `src/core/vox/fleet.ts`. Sweep: `src/verbs/fleet.ts`, also reachable as the CLI verb `atmux fleet`. **Acceptance: §7 V-20** — and read what that row leaves unproven before treating the voice path as covered.

The operator's actual question is not per-team — it is **"what needs my attention across everything, and what doesn't?"**. Answering that with the per-team reads costs `list_teams` + `team_status` × N + `member_pane` × N × M: roughly twenty teams times several panes, each one a spoken round trip. These two tools replace that with one call each.

Both are **read-only** (`mutating: false`, `confirm: false`), so both work under `ATMUX_VOX_READONLY=1`. That is deliberate: the survey half is useful on its own and ships before any input capability.

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
- **Epic-teams are swept, not written off.** A cockpit `epic-team` entry carries the *parent's* root, so it is first resolved to the epic-team's own cage (`<parent>/.atmux/worktrees/<name>`, else `<parent>-epics/<epicId>`) and then swept exactly like any other team — panes, classes, asks. Only an epic-team with **no live cage** stays on the UNREADABLE line, under one shared reason naming `atmux team dissolve-epic`. See [ADR-273 §Supplement-3](adr/273-voice-fleet-triage-and-pane-input.md).
- **Session names are resolved through the anchor** (`.atmux/state/session.txt` via `resolveCageSessionName`), never rebuilt as `atmux-<team>`. On this fleet `unum` anchors to `atmux_unum` and `atmux` to bare `atmux`; the rebuilt form names no session at all and reported every member of a healthy team as down.

### Speech budget

`fleet_attention` speaks at most `top` entries. Same-class findings on the same team **collapse into one entry** (`dash — 7 panes (docs, driver, driver-2 +4)`) so one team's single cause cannot eat the whole budget. Everything beyond the budget becomes a count with a reason breakdown. `fleet_quiet` never names a pane.

## §6.55 — Infrastructure: `host_pressure` + `token_budget`

> **Shipped alongside [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) §Supplement-6.** Probe + renderer: `src/core/vox/host-report.ts` and `src/core/vox/token-budget.ts`. IO: `src/verbs/host-pressure.ts` / `src/verbs/token-budget.ts`, also reachable as the CLI verbs `atmux host-pressure` and `atmux token-budget`.

Two questions the fleet tools cannot answer, because neither is about a team: **"how is the box holding up?"** and **"how much budget have I got left?"**. `cost_report` looks adjacent and is not — it reports per-member AI *spend* for one team since session start.

Both are **read-only** (`mutating: false`, `confirm: false`) and work under `ATMUX_VOX_READONLY=1`. Neither takes a `team` param: a host and a provider quota belong to the whole fleet.

### `host_pressure` — CPU / memory / disk, both hosts

```bash
atmux host-pressure                     # every host, spoken form
atmux host-pressure --host hig          # one host (CLI only; the voice tool has no filter)
atmux host-pressure --json              # verdict + summary + per-host entries
atmux host-pressure --timeout-ms 5000   # tighten the per-host ssh budget
```

```
HOSTS: all 2 healthy.
hax — HEALTHY: cpu 73% of 16 cores over 15 min (72% right now), memory 36% used with 79.7 GB available, disk / 80% full (86.9 GB free).
hig — HEALTHY: cpu 16% of 12 cores over 15 min (35% right now), memory 28% used with 45.2 GB available, disk / 71% full (123.8 GB free).
```

**hax** is read locally from `/proc` + `df`. **hig** is read over `ssh hig` in one round trip — `cat` on two `/proc` files, `grep -c` on a third, and `df`. Nothing is written to hig and nothing is installed on it.

Load is normalised against **each host's own core count**, read per host rather than assumed. The same absolute load of 6.00 is 38% of hax's 16 cores and 50% of hig's 12, and speaking the raw number would make those sound identical.

#### Unreachable is never healthy

A host that cannot be reached — ssh failure, timeout, or a payload that will not parse — reports `UNREACHABLE` **with the reason**, stays in the report, and forces the overall verdict (and the exit code) to non-zero.

```
HOSTS: 1 of 2 UNREACHABLE (hig) — that is not an all-clear.
hax — HEALTHY: cpu 75% of 16 cores over 15 min (108% right now), memory 36% used with 79.7 GB available, disk / 79% full (87.2 GB free).
hig — UNREACHABLE: ssh to hig timed out after 250ms. Its headroom is unknown, not free.
```

**Exit codes carry "did the read happen", NOT the verdict.** `0` whenever a report was produced, including one that says a host is on fire. The verdict lives in the rendered text and in `--json`'s `ok`, so a shell gate reads `atmux host-pressure --json | jq -e .ok`.

> This was the opposite way round first, and driving the real tool bridge end to end disproved it. Every read verb the catalog wires (`health`, `fleet`, `blockers`) returns 0 unconditionally, and [ADR-272](adr/272-voice-operator-interface.md) D2's bridge maps a **nonzero exit to a `verb_failed` envelope** — so "hig is unreachable", the most important thing this tool can say, reached the model as a *broken tool* rather than as the answer. Neither half was wrong on its own, which is why only an end-to-end run found it.

#### Thresholds

| Env | Default | Trips when |
|---|---|---|
| `ATMUX_SPAWN_MAX_LOAD_RATIO` | `0.75` | load(15min) > cores × ratio |
| `ATMUX_SPAWN_MIN_FREE_MB` | `8192` | MemAvailable below the floor |
| `ATMUX_SPAWN_MAX_DISK_PERCENT` | `90` | any probed mount above it |
| `ATMUX_HOST_PROBE_TIMEOUT_MS` | `15000` | per-host ssh budget |

All four fail **closed** to the default on a missing / non-numeric / non-positive value.

⚠️ **Disk is new to `host-pressure.ts` and it GATES.** The same probe backs `atmux doctor`'s host-pressure row and the [ADR-184](adr/184-host-wide-epic-team-cap.md) spawn-epic gate, so a host over 90% on a probed mount now **refuses spawn-epic** where it previously did not. That is intended — a full disk is what breaks `git worktree add` — but it is a behaviour change worth knowing before it surprises you. Override with `--force-spawn`, or tune `ATMUX_SPAWN_MAX_DISK_PERCENT`.

A **mount `df` does not report is a reason, not a pass** — it renders as `NOT REPORTED — unknown` and trips the verdict. Mount matching is exact on df's "Mounted on" column, so `mounts` must name mount **points**, not arbitrary paths.

### `token_budget` — provider quota headroom

```bash
atmux token-budget                        # live probe, every provider
atmux token-budget --provider claude      # all | codex | claude | zai | kimi
atmux token-budget --cache-only           # instant, from the last snapshot
atmux token-budget --json
```

```
BUDGET: CACHED snapshot 28m old — not a live reading. 3 of 15 at capacity or unusable — not healthy. Also: 1 unmeasured (counted as unknown, not as free).
codex pro 7d codex:primary — AT CAPACITY, 100% consumed, resets 2026-08-20 06:04 UTC, in 74h37m [rejected] (rate_limit_reached) [CACHED 28m ago — not a live reading]
claude icloud account — AT CAPACITY, usage not reported, reset time not reported [error:token_invalid] [CACHED 28m ago — not a live reading]
claude aix 7d — WARNING, 97% consumed, resets 2026-08-18 16:00 UTC, in 36h32m [warning] [CACHED 28m ago — not a live reading]
zai current account — UNAVAILABLE, no usage figure: unavailable:no_api_key [CACHED 28m ago — not a live reading]
claude unum 5h — ok, 1% consumed, resets 2026-08-17 05:10 UTC, in 1h42m [allowed] [CACHED 28m ago — not a live reading]
```

It **shells out to the operator's own budget probe** rather than reimplementing four provider APIs. Resolution order: `ATMUX_BUDGET_PROBE`, then `~/.agents/skills/budget/scripts/probe-budgets.sh` (the one tree Claude and Codex share), then the `~/.claude*` fallbacks. `ATMUX_BUDGET_PROBE_TIMEOUT_MS` (default `45000`) bounds it, fail-closed.

Five rules that keep the spoken answer honest:

1. **The number is percent CONSUMED, never remaining.** Every line says "consumed". 97 means 97 gone.
2. **Reset times are exact or absent.** When the probe reports no reset, the line says *reset time not reported* — it never extrapolates one from the window length.
3. **`rejected` and `error:*` are capacity LOSS.** The report cannot be healthy while one exists; an account whose token is invalid is an account you do not have.
4. **Cached says so, with its age** — in the headline before any number, and again on every row.
5. **Kimi is UNAVAILABLE, not 0%.** It exposes credential validity and no quota-usage API. Reporting an unmeasured quota as zero would be heard as headroom.

**Exit codes**: `0` whenever the probe ran and at least one row was read — *including* a report that says three budgets are at capacity. That is a successful read of bad news. Nonzero is reserved for "could not measure anything at all" (the probe failed to run, or emitted nothing usable), which genuinely is a tool failure. Same reasoning as `host_pressure` above.

**Secrets**: no token, key or refresh token reaches the output of either tool — including `--json` and including the probe's stderr on the failure path, which is where an interpolated credential would otherwise land.

**Both tools write their report to `stdout`.** That is load-bearing, not incidental: `captureVerbRun` collects a verb's output from `console.log` + `process.stdout.write` and does **not** read stderr, so a verb that writes its receipt to stderr yields empty captured stdout and the bridge renders it as `verb_output_unparseable` — "the verb produced no usable output". The verb succeeds and the model is told it failed. Pinned by `tests/unit/verbs/vox-infra-stdout-contract.test.ts`, including on the failure paths, so neither tool depends on the bridge-side fix for that class.

## §6.6 — Pane input: `pane_nudge` / `atmux nudge`

> **Shipped alongside [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) D4 (`pane_nudge` half) + D5.** Allow-list, after-state classifier and receipt renderer: `src/core/vox/nudge.ts`. IO: `src/verbs/nudge.ts`, also reachable as the CLI verb `atmux nudge`. **`pane_send` is NOT shipped** — it is still gated on ADR-273 OQ-1.

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

## §6.7 — Model-pin drift guard + the opt-in live smoke

> **Shipped alongside [ADR-272](adr/272-voice-operator-interface.md) §Supplement.** Guard: `src/core/vox/model-check.ts` + `src/abstractions/voice/model-catalog.ts`. Smoke: `scripts/vox-live-smoke.ts` (shim) → `src/core/vox/live-smoke.ts`.

The OpenAI adapter was built against a **retired API** and nobody knew until a live dial. The same class is already loaded again: `factory.ts::defaultModelFor("gemini-live")` pins `gemini-2.5-flash-native-audio-preview-09-2025` — a **dated preview id**, which by construction will be retired. When it goes, the operator's whole experience of the fault is a phone call that goes quiet and closes **4500 after roughly 68 seconds** of dial retries.

### The guard (always on, at boot)

`atmux vox --serve` GETs the provider's model index **after the listener binds** and prints one verdict. Good pin — one quiet line:

```
vox: model check ok — gemini-live/gemini-2.5-flash-native-audio-preview-09-2025 is in the provider's list of 312 models
```

Retired pin — a banner you cannot skim past:

```
vox: ########################################################################
vox: ## MODEL PIN DRIFT — 'gemini-2.5-flash-native-audio-preview-09-2025' is NOT in gemini-live's model list (312 models)
vox: ## The server WILL start, and every dial will fail with close code 4500.
vox: ## A retired or renamed dated-preview id is the usual cause.
vox: ## Closest available: gemini-2.5-flash-native-audio-latest, gemini-2.5-flash-preview-native-audio-dialog
vox: ## Fix: export ATMUX_VOX_MODEL=<id>, or pass --model <id>.
vox: ## Skip this check with ATMUX_VOX_SKIP_MODEL_CHECK=1 (offline / dev only).
vox: ########################################################################
```

Four properties, each with the failure it prevents:

| Property | Why |
|---|---|
| **A network failure is `unreachable`, never `missing`** | An unreachable provider at boot is a different fault from a bad model id. Reporting an egress hiccup as DRIFT sends you hunting a model that is fine, and after two of those the warning gets ignored — which is how the guard dies. |
| **It never blocks or fails the boot** | Failing closed here would make the voice server refuse to start whenever the box's egress hiccups: a rare loud problem traded for a common total one. It warns and serves. Even a bug inside the checker degrades to one line. |
| **Bounded and skippable** | 3s timeout, **no retries** (the only cost is boot latency, and a retry multiplies exactly that); `ATMUX_VOX_SKIP_MODEL_CHECK=1` for offline. |
| **The key never appears** | It rides an auth **header** (`Authorization: Bearer` / `x-goog-api-key`), never a query parameter — so it stays out of logs, shell history and `ps` — and every server line goes through the redacting `createVoiceLogger` on top of that. |

A `401`/`403` is reported as its own thing (`the provider rejected the API key`) rather than as drift: it is actionable, and it is not a model problem.

### The live smoke (opt-in — it costs money)

The guard answers *"does this model id exist?"*. It does **not** answer *"will a realtime session with it actually open, negotiate and return audio?"* — and the 2026-08-15 failure was the second question, since `gpt-realtime` was a perfectly real id and the session-frame SHAPE was retired. A model-list GET would not have caught it. A dial would.

```bash
OPENAI_API_KEY=… bun scripts/vox-live-smoke.ts
GEMINI_API_KEY=… bun scripts/vox-live-smoke.ts --provider gemini
GEMINI_API_KEY=… bun scripts/vox-live-smoke.ts --provider gemini --model gemini-2.5-flash-native-audio-latest
```

It dials a real provider and asserts **two** things: a `session-ready` event **and a non-zero downlink byte count**. Bytes rather than "an event arrived", because a provider that accepts the socket, negotiates and then says nothing is a real observed fault class — a smoke that passed on the event alone would be green for it.

**It is deliberately NOT part of `bun test`.** It bills per minute, it needs keys that live only in the git-crypt'd dotfiles, and it goes red on a provider outage — a CI failure that says nothing about the commit is one people learn to ignore. The orchestration it drives is unit-tested against a fake provider, so the logic is covered without a network; only the shim dials.

**Run it: before a deploy, and after ANY provider or model bump.** Those are the two moments the adapter's assumptions can go stale without a line of atmux changing.

The key comes from the **environment**, never argv (a tmux pane capture records command lines). Exit 0 iff both assertions hold; all output is on stderr.

## §6.8 — The behavioural e2e harness (opt-in — it costs money)

The live smoke answers *"does a session open and return audio?"*. It does **not** answer *"did the assistant understand the question and answer it correctly?"* — a session that opens, negotiates, and confidently reports a team that does not exist passes the smoke. `scripts/vox-e2e.ts` is the gate for the second question.

```bash
ENV=~/work/journals/.sb/_dotfiles/.devcontainer/env/shared.env
# NOTE the [^ #] class: these lines carry trailing "# [PERSONAL]" comments, and a
# naive `cut -d= -f2-` swallows the comment into the value — a malformed key and a
# mystifying failure on every dial.
export OPENAI_API_KEY=$(sed -n 's/^OPENAI_API_KEY=\([^ #][^ #]*\).*/\1/p' "$ENV")
export ANTHROPIC_API_KEY=$(sed -n 's/^ANTHROPIC_API_KEY=\([^ #][^ #]*\).*/\1/p' "$ENV")

unset TMUX
bun scripts/vox-e2e.ts                     # every scenario
bun scripts/vox-e2e.ts --scenario attention
bun scripts/vox-e2e.ts --list
bun scripts/vox-e2e.ts --keep-temp          # leave the cage on disk to inspect
```

### What it actually does

Real speech in, real provider, throwaway cage, independent judge:

1. **A fake cage.** A `mkdtemp` root gets its own `cockpit.json`, one live team (`vox-e2e-alpha`) and one deliberately-absent one (`vox-e2e-ghost`). The live team's tmux session holds four fixture pane states — a pane blocked on a permission prompt, a pane idle with unsubmitted composer text (the wedge class), a pane working normally, and the ghost team's missing session. Those fixtures are checked against the **real** `classifyPaneObservation` by the unit suite, so the ground truth the judge grades against cannot silently drift.
2. **TTS.** The utterance is synthesized to PCM16 mono 24 kHz — the wire format, so no resampling — and cached on disk by (model, voice, text). Re-runs are free and byte-identical.
3. **A real session.** The harness connects through the same `connectWebSocket` abstraction the PWA uses, `hello`s, streams the speech as 40 ms frames at real-time pace, sets `TURN_END`, and collects the transcript, `tool.start`/`tool.done`, downlink audio bytes, and close code.
4. **Two gates per scenario.** A **mechanical** one — did the assistant invoke a tool this question should route to, read straight off the `tool.start` frames — and a **judge** one.
5. **The judge is Claude, not the model under test.** Grading OpenAI Realtime with OpenAI Realtime measures self-consistency, not correctness, and a shared failure mode cancels into a green run. The verdict is structured: pass/fail plus reasoning per named criterion, plus an explicit list of any team or pane the assistant invented. **Its own `overall_pass` is recomputed** from the criteria — a judge that fails three criteria and then reports "overall: pass" is a real failure mode.

### Safety — why this cannot touch the real fleet

The operator's fleet is 20+ live teams on the **default tmux socket**. The harness is *structurally* unable to address them, and refuses to start unless it can prove it:

- `ATMUX_COCKPIT_CONFIG` and `HOME` are pinned into the temp dir on `process.env` (the fleet verbs resolve the cockpit at **call** time, so an env object passed downward would leave the real path live).
- Each fake team carries its own `tmuxTmpdir`, so `resolveTeamSocket` — the same function the live sweep uses — yields a socket under the temp dir.
- `assertIsolated` then refuses, with a `ConfigError`, unless: the cockpit path is under the temp root and is not `$HOME/.atmux/cockpit.json`; the cockpit lists **exactly** the teams the harness created (set equality, not a blocklist — a blocklist rots as the fleet grows); every root and socket is under the temp root; no socket equals the default tmux socket; and no fake name collides with a name in the operator's real cockpit (read read-only, purely as extra evidence).
- The gate runs **after** the cage is on disk and **before** the server starts or a provider is dialed. Teardown asserts which socket it is killing before killing it.

Point it at a real-looking cockpit and it aborts; `tests/unit/core/vox/e2e/isolation.test.ts` proves that rather than asserting the happy path.

It also never touches `atmux.geoy.ws` — it binds its own server on an ephemeral loopback port (`port: 0`), read-only, with a per-run random token.

### The residue wait

One fixture needs the tmux activity clock to be older than `RESIDUE_FRESH_SEC` (60 s), because residue in a freshly-touched window is someone **typing**, not a wedge — the classifier is right to distinguish them. The harness therefore tops up to 70 s from when the panes were painted, crediting the time spent on TTS and boot. On a warm cache expect a ~70 s wait on the first scenario and none afterwards.

### Cost and when to run it

Roughly **$0.05–0.15 per full three-scenario run**: a few seconds of realtime audio each way, ~3 short TTS syntheses (free after the first run — they cache), and three Opus-tier judge calls of a few thousand tokens. Wall clock is ~2–4 minutes, most of it the residue wait and the realtime turns.

**It is deliberately NOT part of `bun test`** — same reasoning as the live smoke: it bills, it needs three real keys, and it goes red on a provider outage. Everything under `src/core/vox/e2e/**` is unit-tested against fakes at 100%, so the logic is covered without a network; only the shim dials.

**Run it: after any change to the tool catalog, the instructions, the fleet classifier, or the provider/model pin.** Those are the four places where the server keeps working and the *answers* quietly get worse — exactly what no other gate in this runbook checks.

### `drilldown` — the scenario that was red on purpose, and how it went green (2026-08-16 → 2026-08-17)

On the first full run, `attention` and `all_ok` passed and **`drilldown` failed**. It was left failing on purpose: the fault was in `team_status`, not in the harness, and loosening the scenario to make the suite green is exactly the move that turns a gate into decoration. **All three scenarios pass as of 2026-08-17** — the receipt is at the end of this section, and nothing in `scenarios.ts` or `fixtures.ts` was touched to get there.

The assistant said, of `vox-e2e-alpha`: *"three members: be-1, fe-1, and docs, all panes down, and no active or pending tasks … 19 ADRs and over a thousand inbox items."* The judge scored that as hallucination against the fixture ground truth (be-1 blocked, fe-1 wedged, docs working). But the model was relaying the tool faithfully — running `status --team-dir <fake team>` against the same cage prints, verbatim:

```
🟢 🧭 TEAM vox-e2e-alpha  session=atmux-vox-e2e-alpha [up]
  🐝 be-1   member  claude  down  …
  🐝 fe-1   member  claude  down  …
  🐝 docs   member  claude  down  …
📝 NEEDS APPROVAL: 19 ADRs / 1157 inbox / 2 kanban
```

Two separate faults, both in `status`, both invisible until something asked the question out loud:

1. **`pane-state=down` for three demonstrably live panes.** The session is reported `[up]` on the same line, and `fleet_attention` classifies all three panes correctly from the same tmux socket — so the pane-state column disagrees with the sweep about panes it can evidently see.
2. **The approval row is not team-scoped.** A team rooted in a `mkdtemp` directory cannot have 19 ADRs or 1157 inbox entries; those counts are the *harness's own repo*. Asking about one team can therefore report another's approval debt.

`fleet_attention` and `fleet_quiet` are unaffected — they were exactly right on the same cage, which is what makes the contrast diagnostic rather than ambiguous.

#### How it was closed, in three passes

Each pass fixed a real fault and the scenario stayed red, which is the point of keeping it red — a gate that goes green early stops finding the next thing.

1. **[ADR-273](adr/273-voice-fleet-triage-and-pane-input.md) §Supplement-5 (W1–W5).** The `down` panes and the foreign approval counts above. `status` was synthesizing window names instead of enumerating them, and `scanNeedsApproval` was walking up from `process.cwd()`. Both fixed; the scenario still failed, on something else.
2. **§Supplement-5 W6 — diagnosed, deliberately NOT fixed.** With the probes honest, the judge failed on `described_alpha_accurately`: `team_status` reported all three panes `active` (true under the process taxonomy) while `fleet_attention` called one of them blocked on a permission prompt (true under the behavioural one). Two classifiers, one spoken surface, two incompatible pictures. Closing it meant *deciding* which vocabulary `team_status` speaks — a decision, not a bug fix, so it was recorded as the open item rather than taken unilaterally.
3. **§Supplement-6 — the decision, taken and implemented.** `team_status` now surfaces the behavioural verdict from `classifyPaneObservation` **alongside** the cage state, with the behavioural one leading, both produced from **one** pane capture inside `probeCageState`. Plus the two model-side legibility residues W6 named (the `kanban` / `NEEDS APPROVAL` fusion, and the cadence column's bare `idle` read as a pane state), and one further NO-LIES fault the full run exposed: `probeTeamLive` stamped a down team's synthetic observation with the literal string `"cage"`, which `renderAttention` printed in the member slot and the model spoke aloud as "member cage" — a hallucination the tool handed it. It now reports the team by name alone.

#### Receipt — full run, all three scenarios (2026-08-17)

`bun scripts/vox-e2e.ts`, live provider, exit 0.

```
=== attention ===
tools=[fleet_attention]
transcript: Checking now. Three things need attention. First: in vox-e2e-alpha, member
be-1 is waiting on a permission prompt: "Do you want to make this edit?" Second: the
vox-e2e-ghost session is down. Third: in vox-e2e-alpha, member fe-1 is idle with
unsubmitted text: "also add the rollback path before you push."
judge verdict: PASS (model claude-opus-5)
  [PASS] answered_the_question
  [PASS] no_hallucination
  [PASS] named_blocked_pane
  [PASS] named_residue_pane
  [PASS] did_not_flag_healthy_pane
  hallucinations: none

=== all_ok ===
tools=[fleet_attention]
transcript: Checking now. Three findings in total. First: in vox-e2e-alpha, the be-1 pane
is waiting on a permission prompt: "Do you want to make this edit?" Second: vox-e2e-ghost
session is down. Third: in vox-e2e-alpha, the fe-1 pane is idle with unsubmitted text:
"also add the rollback path before you push." Rest is one pane working.
judge verdict: PASS (model claude-opus-5)
  [PASS] answered_the_question
  [PASS] no_hallucination
  [PASS] did_not_invent_problems
  [PASS] was_honest_about_state
  hallucinations: none

=== drilldown ===
tools=[team_status]
transcript: Alpha team is up. One member is working, one is idle with unsubmitted text,
and one is waiting on a permission prompt. All their processes look active, but not
confirmed. There are no tasks on the board.
judge verdict: PASS (model claude-opus-5)
  [PASS] answered_the_question
  [PASS] no_hallucination
  [PASS] scoped_to_the_right_team
  [PASS] described_alpha_accurately
         It correctly reported one working, one idle with unsubmitted text, and one
         waiting on a permission prompt, matching docs, fe-1, and be-1; the hedged
         'processes look active, but not confirmed' does not clearly contradict this.
  hallucinations: none

vox-e2e: PASS
  PASS  attention
  PASS  all_ok
  PASS  drilldown
```

Note the drilldown transcript speaking the `?` marker aloud — *"look active, but not confirmed"* — which is the ADR-272 inferred-state clause working end to end, and the judge explicitly accepting the hedge.

#### The judge is not deterministic — one run is not a receipt for a claim about the tool

Measured directly while closing W6: `--scenario drilldown` alone **passed**, and the same build in a full three-scenario run **failed**, on wording the model chose differently that time. In another run the model volunteered "member cage" for the down team and in the previous one it did not — the *tool output was identical in both*.

Two consequences worth stating rather than learning twice:

- **Run the full suite, not the one scenario you changed.** Scenario order and conversation length shift the model's phrasing, and `attention` / `all_ok` are the legs most likely to surface a rendering fault in a tool the *other* scenario calls.
- **A red run is evidence of a real defect even when a green run of the same build exists.** Both of the faults found this way (`"cage"`, and the kanban line's collision with pane vocabulary) were genuine tool defects that a re-roll would have hidden. Re-rolling until green is the same move as loosening a criterion.

### What it does not prove

It is not a phone: no microphone, no browser audio pipeline, no PWA. It exercises the read-only half of the catalog only — the mutating verbs are never invoked, and confirmation flows are untested here. And a passing run is evidence about these fixtures and these three questions, not a general claim about the assistant's judgement.

## §7 — Verification checklist (V-1 … V-20)

> **Filled in progressively: V-1…V-8 in P4, V-9…V-17 in P5, V-18…V-19 in P7, V-20 alongside [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md).** Every row starts as a placeholder. A row is marked done only with a **receipt** — a command and its output, a paste-id, or a screenshot — never "looks fine". **A row goes green because the underlying thing became true, never because the wording was loosened.**
>
> **The receipt must cover the criteria it is filed under.** A row whose criteria name several legs is not green because *a* run passed — it is green when the legs are each pointed at evidence, and the row says which run proved which. V-3 was marked PASS on a run that never exercised its tool-call leg (corrected 2026-08-16); that is the failure mode this line exists to stop, and it is the same rule as the one above wearing different clothes — a receipt that does not cover the claim is a loosened claim.
>
> 📎 **Quoted output in this table is verbatim, and predates the [ADR-274](adr/274-atmux-vox-rename.md) rename.** Server log lines captured on 2026-08-15/16 read `voice: …`; the server prints `vox: …` today. Command paths in the receipts *were* updated so each one still runs (`./tests/unit/verbs/vox.test.ts`), but no captured output and **no row's status** was touched by the rename — rewriting evidence to match a new name is how a receipt stops being one.

> 🔴 **A green headless run is NOT "voice works".** convoke defect 2 (`sampleRate: 16000` is advisory; iOS delivers 48 kHz) and defect 4 (`AudioContext` created outside a user gesture; iOS leaves it suspended) both pass on desktop Chrome and both make the app silently useless on a phone. **V-9…V-17 are hand-run on a physical device and are not optional.**

### Headless (V-1 … V-8) — lands in P4

> **Status vocabulary.** ✅ **PASS (live)** = run against the real deployed server — and, where the row is about the provider, against the real provider API. ✅ **headless-verified** = a command was run in this repo and its outcome recorded here. ⚠️ **partial** = the mechanism is verified, but a leg of the check is still open; the row says which leg. ⏳ **operator step** = nothing in this repo can close it.
>
> A green automated suite is evidence about the *transport and the state machine*, not about the *provider*. **That gap closed on 2026-08-15**: the first live deploy dialled both providers against their real APIs, and V-2…V-7 were closed there. The rows below say which evidence each one rests on.
>
> **Still open, deliberately — do not read the table as "P4 is finished":**
>
> - **V-1's compiled/`$bunfs` leg.** `build:install` swaps the atmux CLI fleet-wide, so it was **not** run during the deploy. Dev-mode is verified; compiled mode is not, and V-1 stays ⚠️ until it is.
> - **`atmux vox --supervise`.** The detached-session + crash-loop + circuit-breaker path has unit coverage of the script it generates, but has **never been exercised as a running supervised server**. The deploy ran `--serve` in the foreground. There is no V-row for it; treat it as untested until someone runs it and records the result.

| ID | Check | Pass criteria | Status |
|---|---|---|---|
| V-1 | Assets resolve in **both** modes | `ATMUX_VOX_ASSETS_DIR` unset: dev-mode resolves `<repo>/templates/vox`, compiled resolves `/opt/atmux/<v>/templates/vox`. Both serve `index.html`. | ⚠️ **partial** — dev-mode verified: `atmux vox --print-assets-dir` prints `<repo>/templates/vox`, and a test now drives **every key of the `VOICE_ROUTES` map** (all 11, including `js/protocol.js`, `js/audio.js` and `worklet/capture.js`), asserting 200 + the declared mime + the declared cache-control + a non-empty body for each. **Compiled mode is an operator step** — it needs `build:install` + the `/opt/atmux/<v>` binary; run `atmux vox --print-assets-dir` from the installed binary and expect `/opt/atmux/<v>/templates/vox`. |
| V-2 | HTTP asset surface | `200` + correct `Content-Type` for `.html` / `.js` / `.css` / `.webmanifest`; **`401` on `/ws` without a valid token** (the PWA shell itself is served unauthenticated in O1 by design — only the WebSocket is token-gated); `404` on a `../` traversal attempt; `Cache-Control: no-store` on `app.js`; **no API key in any response body or header**. | ✅ **headless-verified** — `bun test ./tests/unit/verbs/vox.test.ts`. Asserts the four content-types + `no-store` on html/css/js/manifest and `immutable` on icons; `/ws` without a token → 401; six traversal/prototype shapes (`/../etc/passwd`, `/%2e%2e/...`, `/js/../../../etc/passwd`, `/toString`, `/constructor`, `/nope.html`) → 404; and that no served body or header contains the api key or the token. Traversal is structurally impossible: `VOICE_ROUTES` is an exact-key map with no filesystem lookup. **Also ✅ PASS (live) 2026-08-15** — assets served, and mime + cache headers confirmed, through the deployed nginx vhost rather than only against a test `Bun.serve`. |
| V-3 | Probe through **loopback** | `scripts/vox-probe.ts` against `127.0.0.1:4390` completes a full auth → audio → transcript → tool-call → result round trip. | ⚠️ **partial — no single run covers this row, and the two probe modes cover different halves of it.** **(a) Fake-provider round trip, ✅ headless-verified** — against a real `Bun.serve` (`bun test ./tests/unit/core/vox/probe.test.ts`): hello (authenticating at the **pre-upgrade** gate via `Authorization: Bearer`) → ready → all 50 tone frames arrive at the provider leg, reassembled and compared **byte-for-byte against the synthesized PCM** with one `TURN_END` → downlink audio frames + `transcript.assistant` return to the client. **(b) Audio + transcript legs, ✅ PASS (live) 2026-08-15** — the **tone** probe against a real listening `atmux vox --serve` over loopback, against the real provider API. (This is the run whose first attempt exposed the retired-beta dial failure and the silent server log; both are fixed, and the probe then completed.) **(c) Tool-call leg, ✅ PASS (live — but over `wss://`, not loopback) 2026-08-16** — a **`--text`** probe against `wss://atmux.geoy.ws/ws`: `ok=true uplinkFrames=0 downlinkFrames=95 downlinkBytes=1135200 frameTypes=[ready,status,transcript.assistant,tool.start,tool.done] closeCode=1000`. **Correction, 2026-08-16:** this row read PASS on (b) alone, and (b) does **not** exercise the tool call — its observed frames were `[ready,status,transcript.assistant,transcript.user]`, with **no `tool.start` and no `tool.done`**. Which mode proves which leg is structural, not incidental: `--tone` streams 50 PCM frames and asks nothing, so it can prove audio and transcript and never a tool; `--text` sends one `text` frame and **no audio at all** (`uplinkFrames=0`), so it can prove the tool call and never the audio leg. **Still open:** (c) was run against the public `wss://atmux.geoy.ws/ws` (the V-4 path), so the tool-call leg has **not** been proven over **loopback**, and no single run has yet carried audio → transcript → tool-call end to end. Re-run `--text` against `127.0.0.1:4390` to close the first; the server now names the tool in its own log (§8), so a repeat also records *which* tool ran rather than only that one did. |
| V-4 | Probe through **nginx + TLS** | Same probe against the public `wss://` URL. Catches upgrade-header and `proxy_read_timeout` misconfiguration that loopback hides. | ✅ **PASS (live) 2026-08-15** — `docs/deploy/atmux.geoy.ws.conf.example` (both files) installed, and `scripts/vox-probe.ts` run against the public `wss://` URL through nginx + TLS. The upgrade headers and `proxy_read_timeout` are exercised by the fact the probe completed rather than being cut mid-session. **Re-confirmed 2026-08-16** by V-3's `--text` run over the same public URL — 95 downlink frames / 1,135,200 bytes returned through nginx and the socket closed 1000, so the path carries a long tool-bearing session and not merely a handshake. |
| V-5 | Negative auth matrix | Each of: no token · wrong token · right token + **disallowed `Origin`** · valid upgrade but missing/mismatched `hello.token` — is **rejected**, and rejected at the documented layer. | ✅ **headless-verified** — `bun test ./tests/unit/verbs/vox.test.ts` + `./tests/unit/core/vox/session.test.ts`. All four, each at its documented layer: no token → HTTP **401**; wrong token → **401**; right token + disallowed `Origin` → HTTP **403** (and wrong-origin-*and*-no-token also reads 403 — the CSRF verdict wins, per the ordering pin in `auth.ts`); valid upgrade + bad `hello.token` → WS close **4401**. Plus: no `hello` within 3s → **4408**, pre-hello garbage → **4400**. **Also ✅ PASS (live) 2026-08-15** — the full negative matrix re-run against the deployed server through nginx, including the origin-checked-before-token ordering. |
| V-6 | Token absent from logs | After V-4, `grep` the nginx access log for the token value → **no match** (`access_log off` in effect). | ✅ **PASS (live) 2026-08-15** — grepped the live nginx access log for the token value after V-4: no match. Verified **with a control** — a value known to be present was grepped from the same file in the same way, so the empty result is evidence that the token is absent, not that the grep was looking at the wrong file. |
| V-7 | **Provider swap, zero client diff** | Flip `ATMUX_VOX_PROVIDER` `openai-realtime` → `gemini-live`, restart, re-run V-3. Passes with **byte-identical client assets**. Any required client change means the D4 seam leaked. | ✅ **PASS (live) 2026-08-15** — swapped to `gemini-live` and re-ran the probe against the **real Google endpoint**, with no client-side change of any kind. Receipt: `provider=gemini-live model=gemini-2.5-flash-native-audio-preview-09-2025` · `vox-probe: ok=true uplinkFrames=50 downlinkFrames=14 downlinkBytes=71040` · `frameTypes=[ready,status,transcript.user,transcript.assistant]` · `closeCode=1000`. Downlink audio came back and both transcript directions appeared, so the D4 seam holds across a real provider swap — the concrete acceptance test for ADR-272 §D4. |
| V-8 | Confirm-token enforcement (D7) | A confirm-gated tool: (a) does **not** execute on first call, (b) executes on redemption, (c) is **refused on a second redemption** (single-use), (d) is **refused after `ATMUX_VOX_CONFIRM_TTL_MS`**, (e) is **refused when redeemed with mutated arguments** (argument-binding). All five, server-side. | ⚠️ **partial** — all five are enforced and unit-tested server-side in P3 (`tests/unit/core/vox/confirm.test.ts` + `tool-bridge.test.ts`). P4 adds the relay half: a `needs_confirmation` envelope sets the pinned snake_case `needs_confirmation` flag on `tool.done` and the **full envelope** reaches the provider verbatim (`session.test.ts`). **End-to-end through a live model is an operator step** — ask the assistant to dispatch a task and confirm the preview is read back verbatim before anything runs. It stays an operator step (nothing server-side observes the operator saying yes — D7's own clarification), but since 2026-08-16 the server log makes the round trip *auditable after the fact*: the gated call logs `previewed … NOT executed`, and a redemption logs `(confirmation redeemed)`, so a preview with no redemption after it is now visible rather than silent (§8). |

### Phone (V-9 … V-17) — lands in P5

| ID | Check | Pass criteria | Status |
|---|---|---|---|
| V-9 | Mic unlock on gesture | `AudioContext` is created **and resumed** inside the first user gesture; `state === "running"` before any capture. Direct pin for convoke defect 4. | placeholder |
| V-10 | PTT round trip + **pitch check** | Speak a known phrase, hear a coherent reply — and confirm the reply is **at normal pitch and speed**. A rate mismatch presents as slow/deep audio, not as an error. Direct pin for convoke defect 2. | placeholder |
| V-11 | Local barge-in | Releasing PTT / starting to speak stops downlink playback **immediately, client-side**, without waiting for a server round trip. | placeholder |
| V-12 | Lock screen → resume | Lock the phone mid-session, unlock within `ATMUX_VOX_RESUME_GRACE_MS` → same session resumes via `hello.resume` with history intact. Beyond the window → clean fresh session, no stale audio replayed. | placeholder |
| V-13 | WiFi → LTE handover | Walk out of WiFi range mid-session. Socket drops, client reconnects, provider leg was parked, conversation continues. **The lift case — this is the reason D8 exists.** | placeholder |
| V-14 | Speaker routing | Audio plays through the **intended** output (speaker vs earpiece vs connected Bluetooth), and does not silently route to the earpiece at inaudible volume. | placeholder |
| V-15 | Standalone-PWA mic | Installed to the home screen (`display: standalone`), mic permission still granted and capture still works. A standalone PWA is a different permission context from the browser tab. | placeholder |
| V-16 | Tool chips land on **real** tmux | A spoken `tell_lead` appears in the target team's real lead inbox; a spoken `list_tasks` matches what `atmux task list` prints. The end-to-end proof that the bridge reaches the fleet, not a mock. | placeholder |
| V-17 | Read-only kill switch | With `ATMUX_VOX_READONLY=1`, the 4 messaging tools are **absent from the catalog the model receives** — not merely refused on call. Ask the assistant to send a message: it reports it has no such capability. | placeholder |

### Hardening (V-18 … V-19) — lands in P7

| ID | Check | Pass criteria | Status |
|---|---|---|---|
| V-18 | Echo-runaway breaker | With the speaker on and any VAD-style turn detection enabled (OQ-3), the assistant's **own downlink must not re-trigger its input**. A runaway is detected and broken automatically; it must never be left to the operator to notice a self-sustaining loop that is billing per minute. | placeholder |
| V-19 | VAD barge-in cuts the assistant off | With VAD enabled, speak over the assistant mid-sentence: playback stops at once and **no straggler audio** follows the cut — the provider-side barge-in now suppresses the interrupted response exactly like the phone-side `cancel` ([ADR-272](adr/272-voice-operator-interface.md) §Supplement-P7 §R4). Then, on a turn where the assistant was **silent**, speak and confirm the reply is fully audible — that half is the regression guard, because suppressing unconditionally would swallow the whole next response on OpenAI. | placeholder |

### Fleet triage (V-20) — lands with [ADR-273](adr/273-voice-fleet-triage-and-pane-input.md)

> **Why this row exists at all.** `fleet_attention` / `fleet_quiet` are the daily-use half of the voice surface — they are what "what needs my attention" actually calls — and until 2026-08-16 §7 had **no row for them**. An uncovered feature is not a passing feature; it is an unmeasured one.

| ID | Check | Pass criteria | Status |
|---|---|---|---|
| V-20 | Fleet triage survey | Four legs, each of which a real regression would break. **(a) Bounded** — the sweep returns within `--timeout-ms`, and a team that does not answer inside it is reported, never waited on. **(b) Unreadable ≠ omitted** — a team that cannot be read appears on an `UNREADABLE` line with a reason an operator can act on; it never silently disappears from the counts. **(c) Speech budget** — `--attention --top N` speaks at most N entries and turns the remainder into a count **with a reason breakdown**, and same-class findings on one team collapse into one entry so a single cause cannot eat the budget. **(d) `fleet_quiet` aggregates** — counts and rollups only; **no pane or member is ever named**. | ⚠️ **partial — (a)–(d) all ✅ headless-verified, and the whole survey ✅ PASS (live CLI) 2026-08-16; the VOICE path is unproven.** Unit receipts: (a) `bun test ./tests/unit/verbs/fleet.test.ts` — *"a probe that never returns is bounded and reported, not awaited forever"* + *"once the budget is spent, remaining teams are reported as unread — never dropped"*; (b) same file, *"an epic-team with NO cage on disk is reported once, with an ACTIONABLE reason"* + `./tests/unit/core/vox/fleet.test.ts` *"renderAttention includes the unreadable line — a dropped team would be a lie"*; (c) `./tests/unit/core/vox/fleet.test.ts` — *"speaks at most `top` entries and counts the remainder BY REASON"* + *"rank order survives collapsing — a group never gets promoted"*; (d) the whole `renderQuiet — aggregated, NEVER enumerated (D2)` block, whose first test asserts **no member name appears anywhere** in the output. Live CLI receipt, this fleet, 2026-08-16: `atmux fleet --attention --top 3` → `ATTENTION 46 findings across 49 panes in 21 teams (0.1s)` — 3 numbered entries and no more, `dash` collapsed as `7 panes (docs, driver, driver-2 +4)`, remainder rendered as `+ 37 more: 2 no agent running in the pane, 6 asks waiting for you, 29 parked with nothing queued`, and `UNREADABLE 5 teams: … — epic-team has no live cage — an ephemeral team that ended; prune with 'atmux team dissolve-epic <name>'`. `atmux fleet --quiet` → `QUIET 8 of 21 teams nominal, 9 of 49 panes (0.3s)` with counts and rollups only. Well inside the 15s bound at 0.1s. **Explicitly UNPROVEN:** every leg above was exercised through the **CLI verb**, not through a **voice tool call**. The two share `src/core/vox/fleet.ts`, so the classifier and renderer are the same code — but the tool-bridge path around them (argv construction, the `top` param, summarization into the spoken envelope, `maxResultChars` budgeting) is **not** covered by this receipt. **Voice-path leg CLOSED 2026-08-16** — re-run once tool logging landed. Asked *"What needs my attention across the fleet right now?"* over `wss://atmux.geoy.ws/ws`, the probe returned `ok=true downlinkFrames=92 downlinkBytes=1111200 frameTypes=[ready,status,transcript.assistant,tool.start,tool.done] closeCode=1000`, and the server log names the tool for the first time:<br>`voice: tool 'fleet_attention' invoked (no confirmation gate)`<br>`voice: tool 'fleet_attention' ok in 153ms`<br>So the model routed the natural question to `fleet_attention` unaided, the bridge executed it against the live fleet in 153ms, and the answer was spoken back. That is the whole chain — speech-in → model → tool → verb → summarised result → speech-out — proven end to end with server-side evidence rather than inferred from frame types. Still unproven on this row: the same round trip over **loopback** (this receipt is via nginx+TLS), and every leg under `ATMUX_VOX_READONLY` cleared, since the mutating half of the catalog is absent today. |

## §8 — Troubleshooting

> **Stub — filled in as failures are actually met in P4–P7.** Entries are added with the symptom that was really observed and the fix that really worked. Speculative entries are worse than none.

| Symptom | Likely cause | Check |
|---|---|---|
| Server refuses to start, exit 78 | Missing `ATMUX_VOX_TOKEN` (or <32 chars), or the provider's API key | The stderr line names the exact variable. `openssl rand -hex 32` for the token; source the API key from the git-crypt'd dotfiles env, never argv. |
| HTTP 401 on `/ws` | Token missing or wrong at the **pre-upgrade** gate | Token precedence is `Authorization: Bearer` → `?token=` → `atmux_voice` cookie (`src/core/vox/auth.ts::extractToken`). Confirm the URL actually carries `?token=`. |
| HTTP 403 on `/ws` | `Origin` present but not in `ATMUX_VOX_ORIGINS` | Origin is checked **before** the token, so a 403 means CSRF, not credentials — even when the token is also absent. Confirm nginx passes `Origin` through unmodified (the example conf sets `proxy_set_header Origin $http_origin`). |
| Socket opens then closes 4408 | No valid `hello` within 3s | The client connected but never sent `hello` — usually a client-side JS error before the first send. Check the browser console. |
| Socket closes 4401 after opening | `hello.token` mismatched | The pre-upgrade token and the `hello.token` are checked separately; both must be the same secret. |
| Socket closes 4001 | Another device claimed the session | Latest-wins by design (ADR-272 D8). The displaced client receives a `takeover` frame first. |
| Socket closes 4500 | Provider dial exhausted 5 attempts (250ms→4s backoff) | **Read the server's stderr — it now names the cause.** Look for the `vox: dial exhausted — 5 attempts in <n>ms …; last provider error [<code>] <message>` line and the five preceding `dial attempt N/5 failed` lines. Each names the provider, the model, which of the three faults occurred, and the provider's own error code. The server also sends `error{code:"provider-unrecoverable",fatal:true}` to the phone before closing. |
| 4500 and the server log is EMPTY except the banner | Pre-2026-08-15 build | This was the original defect: the dial had every fact and discarded all of them, so a 5-attempt exhaustion diagnosed only by hand-probing the live provider API. If the log is still silent on a failed dial, the running binary predates the fix — check `atmux --version` against the deployed `/opt/atmux/current`. |
| Long pause, then 4500, with no obvious network fault | The provider opened its socket and went quiet — no `session-ready` | The log says so explicitly: `no session-ready within 12000ms (socket opened, provider handshake never completed)`. `connectWebSocket` bounds only the WS *handshake* (10s); `session-ready` arrives afterwards from an inbound provider frame (OpenAI `session.created`, Gemini `setupComplete`). A provider that accepts the socket then stalls — or sends a frame its adapter cannot parse — is caught by the 12s `SESSION_READY_TIMEOUT_MS` budget and retried. Worst case is ~68s before 4500, deliberately inside the 120s idle close so the cause is reported honestly rather than as an idle timeout. |
| Log says `connect failed — …` rather than `no session-ready …` | The socket was **refused**, not stalled | A different fault from the row above, and deliberately worded differently: nothing opened. Check DNS, egress, and provider status from hax. |
| 4500 on every call, and the boot log printed **MODEL PIN DRIFT** | The pinned model id no longer exists at the provider | The banner names the closest available ids. `export ATMUX_VOX_MODEL=<id>` (or `--model <id>`) and restart. This is the whole reason §6.7's guard exists: before it, a retired dated-preview id presented only as a silent 4500 about 68 seconds into a call. |
| Boot says `model check could not run — …` | The model list could not be fetched: egress, DNS, TLS, or a provider 5xx | **Not** a model problem — the pin is simply UNVERIFIED and the server is serving normally. If the detail says `rejected the API key`, that IS the problem: the same credential is about to fail the dial too. |
| Boot says `model check SKIPPED` | `ATMUX_VOX_SKIP_MODEL_CHECK` is set | Intended for offline / dev. Unset it on any box that actually takes calls, or a retired id will only surface as a 4500. |
| A model id looks right but the dial still fails | The id exists; the session-frame SHAPE is what drifted | The model-list check cannot see this — it is exactly the 2026-08-15 fault. Run the opt-in live smoke (§6.7): `bun scripts/vox-live-smoke.ts`. |
| 4500 immediately, log shows `[beta_api_shape_disabled]` | Something reintroduced an **OpenAI Realtime BETA opt-in** | The beta API is retired: the server rejects the first frame with `error{code:"beta_api_shape_disabled"}` and closes **4000**. There are two independent opt-ins and either one is fatal — the `OpenAI-Beta: realtime=v1` **header** and the `openai-beta.realtime-v1` **subprotocol** element. Neither belongs in `src/abstractions/voice/openai-realtime.ts`; the GA dial is Bearer-only (or a two-element protocol list). See that file's header for the GA `session.update` nesting. |
| You need to know **which tool** the assistant just ran | Read the pair of `vox: tool …` lines | Every tool call writes exactly two lines ([ADR-272](adr/272-voice-operator-interface.md) §Supplement-2026-08-16 T2): `vox: tool 'fleet_attention' invoked (no confirmation gate)` then `vox: tool 'fleet_attention' ok in 412ms`. A failure names its **class** — `vox: tool 'team_status' failed in 43ms (unknown_team)`. Before 2026-08-16 there were no such lines at all: a call could be seen on the wire as `tool.start` / `tool.done` and still not be identified server-side. |
| A tool line reads `invoked (not in catalog)` | The model named a tool it was never offered | Either a hallucinated name, or `ATMUX_VOX_READONLY=1` — under readonly the 4 messaging tools are **absent** from the catalog, so a reach for a mutation lands here. The `tool.done` line that follows says `bad_args`. |
| A confirm-gated tool logs `previewed … NOT executed` and nothing follows | The D7 preview was issued and never redeemed | Working as designed *up to that line*: a gated tool does not run on first call. The question the line answers is what happened next — a redemption logs `ok in <n>ms (confirmation redeemed)`. **No redeemed line means the model never came back**, which is a refusal (or a dropped turn), not an outage. `confirm_expired` on a later call means the token aged out past `ATMUX_VOX_CONFIRM_TTL_MS` — it is reported as a failure class, never as a redemption. |
| A tool log line has no arguments in it | Working as designed | Arguments are **speech** ("dispatch task 4a2f to driver-2" is a sentence you said), and this sink is bounded to protocol facts by ADR-272 OQ-4. Name, gate, outcome, duration and error class only. If you need the arguments, turn on transcripts (§4) — that is the sink built to hold speech, and it carries the retention rule. |
| Log shows `dropping tool result for '<tool>' — the provider leg that issued it is gone` | A redial completed while that tool was still running | Working as designed ([ADR-272](adr/272-voice-operator-interface.md) §Supplement-P7 §R3). A tool call id only means anything inside the provider session that minted it, so the result is dropped rather than handed to a leg that never asked. The **phone** still received `tool.done`, so the operator saw the outcome; the assistant simply will not narrate it. If this line appears often, the dial is unstable — read the `dial attempt` rows above. |
| Log shows `further provider errors on this leg suppressed` | A provider is erroring repeatedly on one leg | Expected, not a fault in itself: the log caps non-fatal provider errors at 3 per leg so a per-frame error cannot flood stderr. The first 3 carry the diagnosis; the eventual `dial attempt` / `dial exhausted` line still quotes the last one. |
| A log line shows `<redacted>` where a URL or header should be | Working as designed | `createVoiceLogger` redacts the API key, the voice token, and anything shaped like a credential (`?key=`, `Bearer …`, `sk-…`) before the line is written. If you need the raw value, read it from the dotfiles env — it is deliberately not recoverable from a log. |
| Looking for what the operator SAID in the server log | Wrong place, by design | Connection logs carry no speech. Transcripts are a separate, **opt-in** sink: `ATMUX_VOX_TRANSCRIPTS=1` → `~/.atmux/vox-logs/vox-<sessionId>.jsonl` (§4 "Transcripts"). With the flag unset — the shipped default — nothing was recorded and there is nothing to find. |
| `~/.atmux/vox-logs/` is empty (or absent) although recording is on | Nobody spoke in that session, or the flag was set after the server started | The file is created on the **first final utterance**, and config is read once at boot. Check the banner: it prints `transcripts=true|false` for the process that is actually running. |
| A stray file in `~/.atmux/vox-logs/` never ages out | It does not match the sweep's own name pattern | Retention deletes **only** `voice-<id>.jsonl`. Anything else you put there is left alone at any age — deliberately, so a sweep in a directory under `$HOME` can never delete something that was not ours. Remove it by hand. |
| Session drops after ~60 s of silence | nginx `proxy_read_timeout` shorter than a realistic pause | The example conf sets `proxy_read_timeout 3600s` on `/ws`. A 60s drop means the default is still in effect — you edited the wrong server block. |
| Session closes 1000 after ~2 min idle | `IDLE_CLOSE_MS` (120s, no phone frames of any kind) | By design; the session is **parked**, not destroyed. Reconnect with `hello.resume=<sessionId>` inside `ATMUX_VOX_RESUME_GRACE_MS`. |
| Assistant says it cannot send messages | `ATMUX_VOX_READONLY=1` | Intended for O1. The 4 messaging tools are **absent from the catalog**, so the model is telling the truth. `/healthz` reports `readonly`. |
| Tool call times out | `ATMUX_VOX_TOOL_TIMEOUT_MS` exceeded | The timeout bounds the **response**, not the execution — the verb keeps running under the mutex and the next tool queues behind it. A slow `topo` on a large fleet is the usual cause. If it happens **once**, that is all it is; if **every** tool call times out from then on, read the next row. |
| **Every** tool call answers `tool_timeout` from some point onward, and the assistant otherwise sounds fine | The tool bridge is **wedged** — a verb never returned and still holds the verb mutex | `curl -s localhost:4390/healthz \| jq`. `ok:false` with `degraded:"tool-bridge-wedged"` confirms it, and `bridge.stuckTool` names the verb — as does the `stuckTool` on each `tool_timeout` envelope. If the verb ever returns, the lane **drains by itself** and the next tool call works; if it never does, recovery is `atmux vox --stop` then `--supervise`. Capture `bridge.stuckTool` + `bridge.heldMs` first — that pair is the whole bug report. |
| `/healthz` says `ok:true` but voice does nothing | Pre-2026-08-15 build, or a fault outside the bridge | `ok` became a real verdict on 2026-08-15; before that it was the literal `true` and a wedged bridge reported green. Check the deployed version first. If `ok:true` is current and correct, the bridge is fine — look at the provider dial (§8 rows above) instead. |
| `bridge.queueDepth` sits at 8 and tools answer `queue_full` | The lane is at its cap behind a stuck (or very slow) verb | 8 is `VERB_MUTEX_MAX_QUEUE`, so the depth stops there by design — the wedge verdict is `wedged` + `stuckTool`, which are unaffected. A depth of 8 alongside `wedged:false` means genuinely slow verbs; alongside `wedged:true` it is the wedge above. Refused calls were **not run**. |
| `atmux vox --status` **exits 0** while the bridge is wedged | Expected — the exit code and the body measure different things | `/healthz` stays **200** while wedged on purpose, so a wedged-but-listening server is distinguishable from an absent one, and the exit code follows reachability. The wedge is not hidden: the printed report says `healthz=degraded` and `bridge=WEDGED  stuckTool=… heldMs=…`. Read the lines, not just `$?`. |
| `--status` reports a `provider` / `readonly` you did not expect | It is telling you what the **server** is running | Since 2026-08-16 every `vox: server:` field is parsed from the fetched `/healthz` body, not from your shell. A mismatch with your own env means the running server was started from a different environment — that is a real finding, not a display bug. Before that date `--status` printed its own config here and this row read the other way round. |
| `dispatch_task` answers `bad_args: member` | The member was not spoken | **`member` is required** (ADR-272 D6 §Supplement-2026-08-16). It used to be optional in the schema and never optional in the verb, so omitting it was a guaranteed `verb_failed` whose message named a member you never said. Say the member; there is no inferred assignee. |
| Tool answers about the wrong team | Team resolution walked to a different cockpit entry | Resolution is a ladder (exact → case-fold → suffix-strip → unique prefix → **segment run** → Levenshtein ≤2, per ADR-273 §Supplement-8); an ambiguous utterance returns `ambiguous_team` with candidates rather than guessing. The segment rung is why a distinctive TRAILING or INTERIOR segment resolves — "alpha" → `vox-e2e-alpha`, "driver 2" → `px-crm-geoyws-driver-2` — and spoken filler ("the alpha team") is dropped first. A segment shared by siblings ("px", "geoyws") is still `ambiguous` with every candidate, by design. `atmux vox --status` shows the provider the running server actually dialled; `list_teams` shows what the index actually holds. |
| Supervised server flapping | Circuit breaker tripped (5 restarts in 60 s) | `tmux -L default attach -t atmux-vox` — the wrapper stops respawning and drops to a shell so the real error stays on screen. |
| `--supervise` says "already running" but nothing answers | Session alive, server dead inside it | `atmux vox --status` distinguishes the two (`session=up healthz=unreachable`). Attach to read the pane, then `atmux vox --stop` and re-supervise. |
| Reply audio is slow and deep-pitched | Sample-rate mismatch — the client is shipping 48 kHz labelled 24 kHz (convoke defect 2) | *stub — P5* |
| No audio at all, no error in the UI | `AudioContext` suspended — created outside a user gesture (convoke defect 4) | *stub — P5* |

## §9 — Related

- [ADR-272](adr/272-voice-operator-interface.md) — design, decisions D1–D11, security model, deferred scope.
- [ADR-260](adr/260-manual-orchestration-mode-default.md) — why an unreachable operator is a coordination gap.
- [ADR-233](adr/233-cron-auto-install-disabled-trust-orchd.md) — no boot autostart; the constraint on §4's supervision shape.
- [ADR-033](adr/033-kanban-driver-only-flag.md) — the `ATMUX_CALLER_SCOPE=driver` gate the server satisfies.
- [ADR-258](adr/258-vendor-agnostic-orchestration-agentbackend.md) — the adapter precedent the provider seam copies, and the orchestration seam ADR-272 §D1 fences itself off from.
- `/root/work/src/convoke` — abandoned predecessor. Prior art and defect corpus only; **no code is ported from it**.
