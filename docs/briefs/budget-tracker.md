# atmux feature brief — Multi-provider token/budget usage tracker (`atmux budget`)

**Author:** handed off from George's main-loop session 2026-07-31. **Discovery:** verified live against real keys (see companion `budget-tracker-discovery.md` for full per-provider specs + sample responses). **Owner:** atmux drivers.

## Goal

Take an **hourly** snapshot of token/quota/spend across **all** of George's live AI providers + accounts, persist it to **SQLite**, and expose a report the `/budget` skill (or any LLM) can narrate. Today's `/budget` is Claude-accounts-only, on-demand, and doesn't persist history — this generalizes it to every provider + a real time-series.

## Scope (George's decisions — do not re-litigate)

- **Storage: SQLite** at `~/.atmux/state/budget.db` (global operator state — NOT a per-team `.atmux/state.db`). George explicitly chose SQLite over Postgres.
- **Providers: all 7, all ON by default** — anthropic, z.ai, kimi, deepseek, minimax, openrouter, cursor.
- **Live Claude accounts: ONLY `gmail` (`~/.claude-gmail`) + `ifca2` (`~/.claude-ifca2`).** The other config dirs (icloud/personal/proton/unum/ifca11) are dead accounts — do NOT probe them.
- **Home: this repo (atmux).** ADR → docs → code, tests same commit, reviewer gate — full atmux discipline.

## Integration map — REUSE, don't duplicate

| Concern | Existing atmux piece to reuse/extend |
|---|---|
| Anthropic adapter | `src/abstractions/budget-probe.ts` **already is it** — probes `~/.claude-<acct>/.credentials.json` → rate-limit response headers, OAuth-refresh, cache, `budget-history.jsonl`. Point it at gmail + ifca2 and feed its output into the new snapshot writer. |
| Other adapters | new `src/abstractions/usage-probe.ts` (or `usage-adapters/`) over the existing `src/abstractions/http.ts` helper. One normalized row-set out per provider. |
| Persistence | new `usage_snapshot` table via `src/abstractions/sqlite-migrations.ts` in a NEW global `~/.atmux/state/budget.db`. |
| Client-side actuals | `src/verbs/cost.ts` already sums real tokens/$ from Claude session `*.jsonl` vs `src/schema/pricing.ts`. Fold it in so the report shows **provider quota (remaining)** AND **actual consumption (spent)**. |
| Hourly cron | `src/abstractions/crontab.ts` + `cron-install`/`cron-remove` verbs. Respect **ADR-192** cron-arm idempotency. |
| Decision record | **ADR-270** BEFORE code lands. (Re-pinned 2026-08-07 from the original **ADR-267** reservation: that pin was positional — "next free number, 266 is the current tail" — and on 2026-08-06 a docs batch landed ADR-267/268/269 on disk for unrelated decisions. Tail is 269; 270 is this record. Verify with `ls docs/adr/ \| tail -5` before authoring — siblings may have claimed further numbers. Collision + resolution recorded in `.atmux/decisions.md`.) |

## SQLite schema (long/tidy — absorbs heterogeneous provider shapes)

```sql
CREATE TABLE usage_snapshot (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL,            -- ISO8601 UTC — one value shared by all rows in a collect batch
  provider   TEXT    NOT NULL,            -- anthropic|zai|kimi|deepseek|minimax|openrouter|cursor
  account    TEXT    NOT NULL,            -- gmail|ifca2|zai|kimi|deepseek|deepseek-ifca|minimax|minimax-ifca|openrouter|cursor
  metric     TEXT    NOT NULL,            -- see metric vocab below
  value      REAL,                        -- numeric (nullable)
  value_text TEXT,                        -- non-numeric (status enum, plan tier, ISO reset)
  unit       TEXT,                        -- pct|usd|tokens|requests|epoch_s|epoch_ms|iso8601|enum
  ok         INTEGER NOT NULL DEFAULT 1,  -- 0 if this provider/account probe failed
  error      TEXT,                        -- error message when ok=0
  raw_json   TEXT                         -- raw provider response, SECRETS STRIPPED, for audit
);
CREATE INDEX idx_usage_ts ON usage_snapshot(ts);
CREATE INDEX idx_usage_pa ON usage_snapshot(provider, account, ts);
```

**Metric vocab (normalize every provider into these):** `util_5h`, `util_weekly` (pct), `reset_5h`, `reset_weekly` (epoch/iso), `status` (enum), `balance_usd`, `credits_usd`, `usage_usd`, `tokens_used`, `tokens_limit`, `requests_used`, `requests_limit`, `plan_tier`. A provider emits only the rows it has; the rest are simply absent (tidy, not a sparse wide table).

## Provider adapters — verified endpoints (2026-07-31; full specs in `budget-tracker-discovery.md`)

All GET/read-only except Anthropic. **Auth = `Authorization: Bearer <key>`** unless noted. Keys come from the env / git-crypt `~/work/journals/.sb/_dotfiles/.env` by **variable name** — never hardcode them.

| Provider | Account(s) | Endpoint | Emits (→ metric) |
|---|---|---|---|
| **anthropic** | gmail, ifca2 | `POST https://api.anthropic.com/v1/messages` (body `{model:"claude-haiku-4-5",max_tokens:1,messages:[{role:"user",content:"."}]}`), read **response headers**. Hdrs: `authorization: Bearer <oauth>`, `anthropic-version: 2023-06-01`, `anthropic-beta: oauth-2025-04-20`. OAuth token from `$CLAUDE_CONFIG_DIR/.credentials.json .claudeAiOauth.accessToken`. **This is exactly what `budget-probe.ts` does — reuse it.** | `anthropic-ratelimit-unified-5h-utilization`→util_5h (fraction→pct), `-7d-utilization`→util_weekly, `-5h-reset`/`-7d-reset`→reset (epoch_s), `-status`→status. No token/$ totals (no `sk-ant-admin` key exists — Admin usage/cost API is 401; note for later if George provisions one). |
| **zai** | zai | `GET https://api.z.ai/api/monitor/usage/quota/limit` | `data.level`→plan_tier; two `data.limits[type==TOKENS_LIMIT]` sorted by `nextResetTime` = 5h+weekly → util_5h/util_weekly (pct) + reset (epoch_ms); `limits[type==TIME_LIMIT]`→tool-search requests. |
| **deepseek** | deepseek, deepseek-ifca | `GET https://api.deepseek.com/user/balance` (both `$DEEPSEEK_API_KEY` and `$DEEPSEEK_API_KEY_IFCA`) | `balance_infos[0].total_balance`→balance_usd, `.granted_balance`, `.topped_up_balance`, `.currency`; `is_available`→status. |
| **openrouter** | openrouter | `GET https://openrouter.ai/api/v1/credits` (+ `/api/v1/auth/key`) | `data.total_credits`→credits_usd, `data.total_usage`→usage_usd, derived balance = credits−usage; `/auth/key` `data.usage`,`.usage_daily`,`.limit`. |
| **minimax** | minimax, minimax-ifca | `GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains` | `model_remains[model_name=="general"]`: `current_interval_*`→util_5h + requests_used/limit, `current_weekly_*`→util_weekly, `end_time`/`weekly_end_time`→reset (epoch_ms). (remaining% → util% = 100−remaining.) |
| **kimi** ⚠️ | kimi | `GET https://api.kimi.com/coding/v1/usages` (OAuth token from `~/.kimi-code/oauth/kimi-code` or `~/.kimi-code/credentials`) | `usage.used`/`.limit`(=100)/`.remaining`→util_weekly (pct), `usage.resetTime`→reset (iso); `limits[0].detail.used`→util_5h. **Undocumented endpoint — best-effort.** |
| **cursor** ⚠️ | cursor | `GET https://cursor.com/api/usage?user=<id>` + `GET /api/auth/stripe` (session/JWT from `~/.cursor/cli-config.json`) | `["gpt-4"].numRequests`→requests_used, `.maxRequestUsage`→requests_limit (null on usage-based plan), `.numTokens`→tokens_used, `startOfMonth`→reset anchor, `customerBalance`→balance_usd. **Reverse-engineered — best-effort, ToS-gray.** |

**⚠️ kimi + cursor** are undocumented/reverse-engineered: on ANY failure record `ok=0`+`error` and move on — never abort the batch. Expect them to break when the providers change internals.

## Verb design

- `atmux budget collect` — probe every provider/account, write ONE batch of `usage_snapshot` rows (shared `ts`), each with `ok`/`error`. Best-effort: a failing provider is a row, not a crash.
- `atmux budget report [--json] [--window 24h|7d] [--provider <p>]` — read latest snapshot + trend deltas, emit a normalized structure (per provider/account: util% + reset + spend/balance + status, plus deltas). `--json` for the skill.
- Wire `collect` into the hourly cron; `report` is on-demand.

## `/budget` skill (claude-skills, coordination plugin)

Replace/extend the current probe-only skill: call `atmux budget report --json`, hand the structure to whatever LLM is running, narrate **verdict-first** (George's Discord style — 🟢/🟡/🔴 per account, resets, spend). Keep a `--live` flag that runs `collect` first for a fresh "right now."

## Security requirements (NON-NEGOTIABLE)

1. **The DB stores ONLY usage numbers — NEVER keys, tokens, JWTs, or cookies.** Strip secrets from `raw_json` before persisting.
2. Read credentials from env / dotfiles `.env` (by var name) + OAuth files at call time; never log or persist them.
3. This is a **credential-aggregating daemon** by nature (it reads every provider cred to phone home). That's the accepted design — George opted in — but it means: no telemetry, no external egress except the provider APIs themselves, and the collector runs as its own cron process (that's why the operator's Claude classifier — which blocks these calls interactively — is not in the runtime path).

## Acceptance criteria

- [ ] **ADR-270** written + accepted (design, schema, provider list, security posture) — same PR as code.
- [ ] `usage_snapshot` migration in `sqlite-migrations.ts`; `~/.atmux/state/budget.db` created on first `collect`.
- [ ] One adapter per provider, normalized to the metric vocab; anthropic reuses `budget-probe.ts`.
- [ ] **Unit tests** per adapter: feed the recorded sample response (from discovery doc) → assert the exact normalized rows. 100% coverage on adapters/verb/schema (atmux rule).
- [ ] **One live `atmux budget collect`** run inserts a full batch — every provider present, each with `ok=1` (or `ok=0`+meaningful error for kimi/cursor if they've drifted).
- [ ] `atmux budget report` renders quota + actual-spend per provider/account with resets as absolute local + relative.
- [ ] Hourly cron installed **idempotently** (ADR-192); `cron-remove` cleanly reverses it.
- [ ] `/budget` skill updated to consume `atmux budget report --json`.
- [ ] Docs + ADR pointer updated same commit.

## Notes / gotchas

- Discovery agents for anthropic/kimi/cursor tripped the security classifier (credential-exploration shaped) — expected; their outputs are captured in `budget-tracker-discovery.md`, treat as leads and re-verify live in the drivers' own context.
- `ifca2` on-disk creds are OAuth `subscriptionType=max` (same shape as gmail) despite the "API Usage Billing" label — so it probes fine via the header mechanism; no admin key needed for util%.
- reset units differ: anthropic = epoch **seconds**, z.ai/minimax = epoch **milliseconds**, kimi = **ISO8601**. Normalize on write.
