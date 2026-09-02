---
name: budget
description: Live rate-limit probe across all configured Claude accounts. Reports 5h + weekly utilization and reset times. Auto-refreshes expired OAuth tokens; caches to `~/.atmux/state/budget-probe-<account>.json`.
argument-hint: [--json] [--account <name>] [--no-refresh] [--cache-only]
---

<!-- carved per ADR-217 §D4 -->

# /atmux:budget — cross-account budget probe

Single-shot, reliable budget snapshot across every configured Claude account on the host. Returns 5-hour + weekly utilization, reset times, status, and a budget-flip recommendation.

## Why this exists

Pane footer rate-limit indicators (`5h X% ↻Yh`, `wk X%`) **freeze during active turns** and are routinely stale by minutes — always check the API for token/rate limits, not pane footers. The cached budget probes under `~/.atmux/state/budget-probe-*.json` go stale within hours and don't auto-refresh on demand.

When deciding whether to swap a team's `claudeAccount` (per [ADR-199](../../../../docs/adr/199-claude-account-pool-for-epic-team-spawning.md)), rotate a lead, or fire a heavy task, the API headers (`anthropic-ratelimit-unified-{5h,7d}-utilization`, `…-reset`, `…-status`) are the only source of truth. This skill probes them on demand.

## Behaviour

1. **Auto-discover accounts** — every `~/.claude-<label>/.credentials.json` becomes a probe target. Skipped silently if no `.credentials.json` exists. Configure new accounts by creating the dir; no skill code changes required.
2. **Check token freshness BEFORE probing** — if `expiresAt` (ms) is past or within 60s of now, refresh via the `claude --print` warmup trick first (see §Refresh strategy). This is cheaper than failing the probe + retrying.
3. **Probe** — POST `/v1/messages` with a 1-token cheap-model request. Read `anthropic-ratelimit-unified-*` response headers.
4. **On 401 (token rejected post-refresh)** — record `error: token_invalid`, continue. Don't loop-refresh.
5. **On 429 (rate-limit rejected)** — still record headers if present (utilization will be 100%, reset is set).
6. **On any other non-2xx** — record `error: http_<code>`.
7. **On timeout / network fail** — record `error: <reason>`, fall back to last-cached probe under `~/.atmux/state/budget-probe-<account>.json` if it exists (marked `stale: true`).
8. **Persist** — write fresh probe to `~/.atmux/state/budget-probe-<account>.json` (atmux-compatible schema: `h5_util, wk_util, h5_reset, wk_reset, status, probedAt`). Locked via `flock` so concurrent probes don't corrupt the file.
9. **Render** — pretty table by default; `--json` emits one JSON object per account (one line each, NDJSON).

## Refresh strategy

The Anthropic OAuth refresh endpoint (`/v1/oauth/token`) requires a `client_id` field the public surface doesn't document; calling it directly with just `grant_type + refresh_token` returns `invalid_request_error`. Instead, this skill relies on `claude` itself to refresh:

```bash
CLAUDE_CONFIG_DIR=~/.claude-<account> timeout 15 claude --print "." --max-turns 0 --model claude-haiku-4-5 < /dev/null > /dev/null 2>&1
```

`claude` refreshes the OAuth token at the start of any command that contacts the API. `--print "." --max-turns 0` is the cheapest such command — it costs 1 cheap-model request, which counts against the budget being probed, but is negligible (<0.001% of weekly).

Disable with `--no-refresh` if you want to see raw 401s without spending the warmup tokens. Cheap-model choice (`claude-haiku-4-5` here) aligns with [ADR-140](../../../../docs/adr/140-cheap-model-first.md) — never warm up with Opus.

## Arguments

| Flag | Effect |
|---|---|
| `--json` | NDJSON output (one line per account) instead of pretty table |
| `--account <name>` | Probe only this account (matches the `<label>` portion of `~/.claude-<label>/`) |
| `--no-refresh` | Skip the `claude --print` warmup on expired tokens; show `401` errors as-is |
| `--cache-only` | Read cached `~/.atmux/state/budget-probe-*.json` files without making any API calls; mark stale entries explicitly |

Default (no args): probe all discovered accounts, refresh expired tokens, write cache, render pretty table.

## Output — pretty table

```
=== Account budgets — 2026-05-21 09:38 UTC ===

Account     5h util   5h reset           wk util   wk reset           Status
─────────   ──────    ──────────────     ──────    ──────────────     ────────────────
acct-a      15%       12:00 UTC +2h22m   97%       11:00 UTC +1h22m   allowed_warning
acct-b      16%       13:20 UTC +3h42m   94%       16:00 UTC +6h22m   allowed_warning
acct-c      0%        09:40 UTC +2min    100%      May 23 19:00 UTC   rejected
acct-d      18%       11:50 UTC +2h12m   88%       13:00 UTC +3h22m   allowed
```

Sorted ascending by `wk_util` (best headroom first). Status colours (terminal-supports-color only):

- `allowed` → green
- `allowed_warning` → yellow
- `rejected` → red
- `error: …` → red bold

## Output — JSON

One object per line:

```json
{"label":"<account>","h5_util":0.15,"wk_util":0.97,"h5_reset":1778472000,"wk_reset":1778468400,"status":"allowed_warning","probedAt":1778463528}
```

Stable schema, compatible with atmux's `~/.atmux/state/budget-probe-<label>.json` files (same field names).

## Implementation

All logic lives in the bundled probe script:

```bash
bash ~/.claude/plugins/atmux/skills/budget/scripts/probe-budget.sh [args]
```

Or invoke via the skill harness (with the args passed through). The script is bundled at `plugins/atmux/skills/budget/scripts/probe-budget.sh` per [ADR-217](../../../../docs/adr/217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D1.5 (adjacent-asset bundling) and symlinked into Claude Code's plugin discovery path during atmux's install-wizard step per [ADR-200](../../../../docs/adr/200-install-wizard-guided-first-run-setup.md) §D6 / ADR-217 §D5.

**Timezone:** output uses UTC by default. Operators on a fixed timezone export `ATMUX_BUDGET_TZ=<tz-spec>` (any value accepted by `date -d` / `TZ=`, e.g. `America/Los_Angeles`, `Europe/London`) to get local-time rendering in the pretty table.

## Reliability invariants

- **Account auto-discovery** — never hardcode account labels. Whatever exists at `~/.claude-*/.credentials.json` is a probe target. New accounts work without code changes.
- **Pre-refresh on expired tokens** — don't waste a probe call on a token you already know is dead. Read `expiresAt` from `credentials.json` *first*.
- **Atomic credentials.json reads** — `claude` rewrites `credentials.json` during refresh. Read inside `flock -s` on the file to avoid mid-write reads.
- **Atomic probe-cache writes** — write to `<file>.tmp` then `mv` (atomic on same filesystem). `flock -x` on the destination during write.
- **Timeouts on every external call** — `curl --max-time 15`, `timeout 20 claude --print …`. No unbounded hangs.
- **Graceful degradation** — every probe path emits a result row. Network failures → `stale + cached`. Missing creds → `no_credentials`. Refresh refused → `token_invalid`. Never silently drop an account from the report.
- **Side-effect minimization** — `--cache-only` runs read-only (for monitor cron jobs / status lines). `--no-refresh` avoids spending probe tokens. Default is one probe call + maybe one refresh per stale account.

## Use cases

- **"Which account has headroom?"** — `/atmux:budget` → eyeball the table.
- **"Why is the lead stuck on `hit your limit`?"** — `/atmux:budget --account <label>` returns the live `wk_reset` time, distinguishing actual lockout from stale pane footer (which freezes when claude is mid-turn).
- **Pre-rotate-lead sanity** — `/atmux:budget --json | jq 'select(.label=="<label>") | .wk_util'` before flipping a team's `claudeAccount` per ADR-199.
- **Cockpit / status-line integration** — `/atmux:budget --cache-only --json` for a fast read-only display.

## Out of scope

- This skill does NOT swap accounts on its own. It reports. Use `/atmux:team` verbs or edit `team.json` / `cockpit.json` per [ADR-199](../../../../docs/adr/199-claude-account-pool-for-epic-team-spawning.md) (claude account pool — least-loaded selection by budget probe).
- It does NOT poll continuously. Run on demand, or wire to a cron via `/schedule` or `/loop` if periodic refresh is wanted.
- It does NOT touch running tmux panes. Read-only on team state.

## Operator-facing report format — attention + verdict markers

After the verbatim table/JSON output, prepend a one-line operator-attention summary so the operator can scan-skim without re-reading the table. Same scheme as `/atmux:whip`, `/atmux:bau`, `/atmux:session`, `/atmux:team`, `/atmux:tell-lead`.

**Verdict-derivation rules (account-status aggregate):**

- **✅** when every account is `allowed` AND every `wk_util` < 0.80. Plenty of headroom across the cluster.
- **⚠** when ANY account is `allowed_warning` (≥80% util), or ANY `wk_util` between 0.80–0.95. Sliding; watch one cycle. NOT actionable on its own.
- **🔴** when ANY account is `rejected` (locked out) or shows `error: token_invalid` / `error: http_*`. Active capacity loss.
- **👁** attaches when the operator is mid-decision (e.g. about to `/atmux:team start` / rotate-lead / dispatch a heavy task) AND the cluster picture changes that decision — e.g. their preferred account just hit `rejected` and they need to pick an alternate.

**Examples (prepended above the standard table):**

```
✅ /atmux:budget — all 4 accounts allowed, best headroom: acct-d (wk 18%, 5h 12%)
```

```
⚠ /atmux:budget — 2 accounts allowed_warning (acct-a wk 97%, acct-b wk 94%); 2 allowed
ℹ Cluster still serving; if a heavy task is imminent, prefer the lower-util accounts
```

```
👁 🔴 /atmux:budget — acct-c REJECTED (wk 100%, resets in 2 days)
👁 Operator: rotate any team currently configured for that account NOW
acct-a allowed_warning (wk 97%, resets in 1h22m), acct-b allowed_warning, acct-d allowed (best headroom)
```

**Anti-patterns:**

- ❌ Marking `✅` when one account is `rejected` just because others have headroom. Worst-marker wins.
- ❌ Marking `🔴` for a single account at 80% util while the rest are fine. `allowed_warning` is `⚠`, not `🔴`.
- ❌ Suppressing the table when ✅. The table is the artifact; the verdict line is the scan-skim layer above it.

## Cross-references

- [ADR-199](../../../../docs/adr/199-claude-account-pool-for-epic-team-spawning.md) — Claude account pool; least-loaded selection consumes this probe's output
- [ADR-140](../../../../docs/adr/140-cheap-model-first.md) — cheap-model-first principle (warmup uses haiku, not Opus)
- [ADR-200](../../../../docs/adr/200-install-wizard-guided-first-run-setup.md) §D6 — install-wizard step that symlinks the plugin (including this skill's `scripts/`) into Claude Code's plugin path
- [ADR-217](../../../../docs/adr/217-atmux-skills-plugin-bundled-and-wizard-installed.md) §D4 + §D5 — generalization pass + wizard integration; this carve marker
