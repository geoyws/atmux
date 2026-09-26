# ADR-270: Multi-provider budget usage tracker (`atmux budget`)

**Status**: proposed
**Date**: 2026-09-26
**Driver-ref**: e-50 story s-52-2f587abd; spec `docs/briefs/budget-tracker.md` (+ companion `budget-tracker-discovery.md`); scope locked by operator 2026-07-31 (SQLite not Postgres; 7 providers; reuse `budget-probe.ts`/`cost.ts`/migrations/crontab/`http.ts`; usage numbers only, never keys).
**Relates**: [ADR-192](192-cron-arm-idempotency-contract.md) (hourly cron arm must be idempotent), [ADR-126](126-sqlite-state-store.md) (SQLite canonical store), e-38 (flags/role_state `state_kv` migration idiom — the tracker reuses the repo pattern, not the tables).

## Context

`/budget` today is Claude-accounts-only, on-demand, no history. This record authorizes the generalized tracker: hourly snapshots of quota/spend across all seven of the operator's live providers into a global SQLite time-series, plus a report surface the `/budget` skill narrates. Design below is as-built: T3 (t-25764270, `src/abstractions/usage-adapters.ts`, commit 31ccba53) implemented the adapters first and live-smoked every provider 2026-09-26, correcting two payload shapes the discovery doc got wrong (D5).

## Decisions

**D1 — Storage: one global SQLite db.** `~/.atmux/state/budget.db` (global operator state, NOT per-team `.atmux/state.db`). Table `usage_snapshot` exactly per the brief schema (id/ts/provider/account/metric/value/value_text/unit/ok/error/raw_json, indexes on ts and (provider, account, ts)). Long/tidy rows absorb heterogeneous provider shapes; a provider emits only the rows it has. Schema leg is e-50 T2 (t-114d9f8e), not this record.

**D2 — Providers: all 7, all ON by default.** anthropic (gmail + ifca2 only — icloud/personal/proton/unum/ifca11 config dirs are dead accounts, never probed), zai, kimi, deepseek (+ deepseek-ifca), minimax (+ minimax-ifca), openrouter, cursor. Metric vocab: `util_5h`, `util_weekly` (pct), `reset_5h`, `reset_weekly` (epoch/iso per provider), `status` (enum), `balance_usd`, `credits_usd`, `usage_usd`, `tokens_used`, `tokens_limit`, `requests_used`, `requests_limit`, `plan_tier`.

**D3 — Anthropic reuses `budget-probe.ts`.** Probes `~/.claude-<acct>/.credentials.json` → minimal `POST /v1/messages` → rate-limit response headers (5h/7d utilization + resets + status). No Admin API (no `sk-ant-admin` key; 401 expected). No token/$ totals.

**D4 — Other adapters: `src/abstractions/usage-adapters.ts` over `src/abstractions/http.ts`.** One `normalize*` pure fn + one `probe*` per provider/account; `probeAllProviders` aggregates. Probe contract: NEVER throw — missing keys, bad shapes, request failures all become `ok=0` rows with `error`. A failing provider is a row, never a crash, never an aborted batch.

**D5 — As-built payload corrections (live-smoked 2026-09-26, supersede discovery doc where they differ).**
- zai `GET /api/monitor/usage/quota/limit`: limits are `CREDIT_LIMIT{percentage,nextResetTime}`, NOT `TOKENS_LIMIT{usedPct}`. First two entries by reset = 5h + weekly. `data.level` → plan_tier.
- minimax `coding_plan/remains`: fields are `current_interval_remaining_percent` / `current_weekly_remaining_percent` (util = 100 − remaining), counts `current_interval_usage_count` / `current_interval_total_count`; resets `end_time` / `weekly_end_time` (epoch_ms).
- kimi `GET /coding/v1/usages`: live token file is `~/.kimi-code/credentials/kimi-code.json` holding snake_case `access_token` (JWT); `~/.kimi-code/oauth/kimi-code` is empty on this host. Undocumented endpoint — best-effort. An expired local JWT surfaces as `ok=0` (observed: 401), never a throw.
- cursor: NO non-interactive credential exists (usage API needs an interactive OAuth session via `agent.db`). The adapter documents this and always emits `ok=0` with the reason. Best-effort, ToS-gray — record `ok=0`+error on any failure.
- deepseek `GET /user/balance` → `balance_infos[0].total_balance` → balance_usd, `is_available` → status. openrouter `GET /api/v1/credits` → `data.total_credits`/`data.total_usage`.

**D6 — Security posture (NON-NEGOTIABLE, from the brief).** The DB stores ONLY usage numbers — never keys, tokens, JWTs, cookies; `raw_json` is secrets-stripped before persist. Credentials are read from env (by variable name, never hardcoded) and OAuth files at call time, never logged or persisted. The collector phones home to provider APIs only — no telemetry, no other egress. It runs as its own cron process (the operator's interactive classifier is not in the runtime path).

**D7 — Verbs + skill (T4–T6, not yet built at acceptance).** `atmux budget collect` (one batch, shared `ts`), `atmux budget report [--json] [--window] [--provider]` (latest + trend deltas, quota AND actual-spend folded in from `cost.ts`), hourly cron via `crontab.ts` honoring ADR-192, `/budget` skill switched to `report --json` with a `--live` collect-first flag.

## Verification (T3, 2026-09-26)

- `tests/unit/abstractions/usage-adapters.test.ts`: 16/16 green (recorded per-provider fixtures + missing-key/malformed/failing-request `ok=0` paths + batch never-throws).
- `tsc --noEmit` clean; `biome lint` clean on both files.
- Live smoke with real keys (values never printed): anthropic-gmail, zai, deepseek ×2, openrouter, minimax ×2 all `ok=1`; ifca2 `ok=0` (creds missing on host); kimi `ok=0` (expired JWT); cursor `ok=0` (no non-interactive credential).

## Deferred / out of scope

- `usage_snapshot` migration (e-50 T2), collect/report verbs (T4), hourly cron (T5), `/budget` skill wiring (T6).
- kimi/cursor drift: any future failure is an `ok=0` row by contract (D4); no special-casing.
- INDEX.md row deferred per ADR-271 §D9 precedent (index is batch-refreshed; manual edits clobber). Spec pointer: the brief already names ADR-270 — no brief edit needed.

## Acceptance

Authored by the lane executor as e-50 T1 (t-8e1f5050), same branch as the T3 code it ratifies (`atmux-t-25764270-w1-7f9c03`). `proposed` → `accepted` requires reviewer signoff or driver/lead `decisions-add` (lane executor does not self-accept).
