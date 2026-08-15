# Provider usage-API discovery — full verified specs (2026-07-31)

## DeepSeek  (key=None)
- works: True | has_credential: True | http: 200
- accounts: ['PERSONAL ($DEEPSEEK_API_KEY): HTTP 200, is_available=true, total_balance USD 50.76 (topped_up 50.76, granted 0.00)', 'IFCA ($DEEPSEEK_API_KEY_IFCA): HTTP 200, is_available=true, total_balance USD 86.94 (topped_up 86.94, granted 0.00)']
- credential_source: env $DEEPSEEK_API_KEY (PERSONAL) and env $DEEPSEEK_API_KEY_IFCA (IFCA); both also present in /root/work/journals/.sb/_dotfiles/.env (git-crypt decrypted) as export DEEPSEEK_API_KEY / export DEEPSEEK_API_KEY_IFCA
- endpoint: https://api.deepseek.com/user/balance
- method: GET
- auth_scheme: Bearer token — header "Authorization: Bearer <REDACTED>"
- reset_info: No reset/quota window. DeepSeek is a prepaid-balance model: balance persists until consumed by API usage or increased by a top-up. There is no rolling 5h/daily/weekly reset and no rate-limit-quota reported by this endpoint.
- metrics:
    - is_available :: `$.is_available` [boolean]
    - currency :: `$.balance_infos[0].currency` [ISO-4217 currency code]
    - total_balance (remaining spendable balance) :: `$.balance_infos[0].total_balance` [USD (string decimal)]
    - granted_balance (free/promotional credit remaining) :: `$.balance_infos[0].granted_balance` [USD (string decimal)]
    - topped_up_balance (paid credit remaining) :: `$.balance_infos[0].topped_up_balance` [USD (string decimal)]
- sample_response_redacted: PERSONAL: {"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"50.76","granted_balance":"0.00","topped_up_balance":"50.76"}]}  |  IFCA: {"is_available":true,"balance_infos":[{"currency":"USD","total_balance":"86.94","granted_balance":"0.00","topped_up_balance":"86.94"}]}  (response body carries no secret; shown verbatim)
- notes: VERIFIED LIVE on hax, 2026-07-31. Exact working request (key redacted): curl -sS --max-time 20 https://api.deepseek.com/user/balance -H "Authorization: Bearer <REDACTED>". Both credentials authenticate and return HTTP 200 with usable data — PERSONAL ($DEEPSEEK_API_KEY) = USD 50.76 remaining; IFCA ($DEEPSEEK_API_KEY_IFCA) = USD 86.94 remaining. Both env vars were already populated (len 35 each); no .env grep fallback was needed, but the dotfiles .env cross-check confirmed the same two keys (per its comment, code-gen must read DEEPSEEK_API_KEY_IFCA explicitly). balance_infos is an array (one entry per currency); today only a single USD entry per account — a budget tracker should iterate the array rather than hard-index [0] if multi-currency is possible. IMPORTANT for the hourly budget tracker: this endpoint exposes ONLY remaining $ balance, NOT utilization %, tokens used/limit, or a reset time — DeepSeek meters by prepaid dollars, so track balance drawdown (delta of total_balance over time) as the spend signal; there is no percentage-utilization or token-quota field to map. No spend-to-date or usage-history field is returned by /user/balance; DeepSeek has no public GET usage/cost-report endpoint, so cumulative spend must be derived by differencing total_balance across polls. All GET/read-only; no writes performed; raw keys never printed.

## OpenRouter  (key=None)
- works: True | has_credential: True | http: 200
- accounts: ['OpenRouter key label sk-or-v1-<REDACTED> (is_free_tier=false, creator_user_id=user_<REDACTED>)']
- credential_source: env $OPENROUTER_API_KEY (set; also present in ~/work/journals/.sb/_dotfiles/.env, git-crypt-decrypted). Never printed — redacted as <REDACTED>.
- endpoint: GET https://openrouter.ai/api/v1/credits (primary balance) + GET https://openrouter.ai/api/v1/auth/key (per-key usage/limit)
- method: GET
- auth_scheme: Bearer token — header "Authorization: Bearer <REDACTED>"
- reset_info: Prepaid credit model — credits do NOT reset. /auth/key limit_reset=null and limit_remaining=null (no hard cap set on this key). Rolling usage windows are exposed as usage_daily / usage_weekly / usage_monthly ($, trailing windows) but there is no reset timestamp field.
- metrics:
    - total_credits (credits purchased/granted) :: `GET /credits → $.data.total_credits` [USD]
    - total_usage (lifetime spend, account) :: `GET /credits → $.data.total_usage` [USD]
    - balance_remaining (DERIVED) :: `GET /credits → $.data.total_credits - $.data.total_usage` [USD]
    - utilization_pct (DERIVED) :: `GET /credits → $.data.total_usage / $.data.total_credits * 100` [percent]
    - key_usage (lifetime spend, this key) :: `GET /auth/key → $.data.usage` [USD]
    - key_usage_daily :: `GET /auth/key → $.data.usage_daily` [USD]
    - key_usage_weekly :: `GET /auth/key → $.data.usage_weekly` [USD]
    - key_usage_monthly :: `GET /auth/key → $.data.usage_monthly` [USD]
    - key_limit (spend cap on key; null=uncapped) :: `GET /auth/key → $.data.limit` [USD or null]
    - key_limit_remaining (null=uncapped) :: `GET /auth/key → $.data.limit_remaining` [USD or null]
    - is_free_tier :: `GET /auth/key → $.data.is_free_tier` [boolean]
- sample_response_redacted: GET /credits (HTTP 200): {"data":{"total_credits":50,"total_usage":9.445676165}}
GET /auth/key (HTTP 200): {"data":{"label":"sk-or-v1-<REDACTED>","is_management_key":false,"is_provisioning_key":false,"limit":null,"limit_reset":null,"limit_remaining":null,"include_byok_in_limit":false,"usage":9.435468785,"usage_daily":1.18721232,"usage_weekly":1.81355587,"usage_monthly":1.95435277,"byok_usage":0,"is_free_tier":false,"expires_at":null,"creator_user_id":"user_<REDACTED>","rate_limit":{"requests":-1,"interval":"10s","note":"deprecated"}}}
- notes: LIVE-VERIFIED on hax 2026-07-31, both endpoints HTTP 200 with real data (GET/read-only). Exact working curls (key redacted):
  curl -sS --max-time 20 -H "Authorization: Bearer <REDACTED>" https://openrouter.ai/api/v1/credits
  curl -sS --max-time 20 -H "Authorization: Bearer <REDACTED>" https://openrouter.ai/api/v1/auth/key

RECOMMENDED for the hourly tracker: use BOTH. /credits gives the account-level dollar picture (total_credits=50, total_usage≈9.4457 → balance≈$40.554, utilization≈18.9%); /auth/key gives per-key spend plus trailing daily/weekly/monthly windows and any key-level limit.

Field-mapping caveats: (1) There is NO direct "utilization %" or "balance" field — both are DERIVED (balance = total_credits - total_usage; utilization = total_usage/total_credits). (2) On THIS key limit / limit_remaining / limit_reset are all null → no key-level spend cap, so the only real ceiling is the account credit balance from /credits; a tracker should compute utilization against total_credits, not against key limit. (3) No reset timestamp exists (prepaid credits don't reset); usage_daily/weekly/monthly are rolling trailing sums, not window-anchored counters. (4) rate_limit.requests=-1 with a deprecation note — ignore it, not a usable quota signal. (5) total_usage (/credits, account-wide) ≈ 9.4457 is slightly higher than usage (/auth/key, this key) ≈ 9.4355 — expected if the account has/had more than one key. Raw key never printed; every occurrence redacted as <REDACTED>.

## z.ai GLM Coding Plan  (key=None)
- works: True | has_credential: True | http: 200
- accounts: ['z.ai GLM Coding Plan — level=max (IFCA-tagged, hax)']
- credential_source: env $ZAI_API_KEY (already set in shell; per dotfiles this is the IFCA-tagged z.ai GLM Coding Plan key stored git-crypt'd in ~/work/journals/.sb/_dotfiles/.env). Never printed; sent only in the Authorization header.
- endpoint: https://api.z.ai/api/monitor/usage/quota/limit
- method: GET
- auth_scheme: Bearer token — header "Authorization: Bearer <REDACTED>"
- reset_info: nextResetTime is epoch MILLISECONDS (UTC). To distinguish the two TOKENS_LIMIT windows, sort ascending by nextResetTime: earliest = rolling 5h window, latest = weekly window. Live values at probe time (now=2026-07-31T08:51:23Z): 5h window (TOKENS_LIMIT unit=3,number=5) 71% used, resets 1785500518829 = 2026-07-31T12:21:58Z (~3h out); weekly window (TOKENS_LIMIT unit=6,number=1) 91% used, resets 1785899481997 = 2026-08-05T03:11:21Z (~114h/~4.75d out); TIME_LIMIT tools/search window resets 1787973081987 (~28d out).
- metrics:
    - plan_tier :: `$.data.level` [string enum (observed: "max")]
    - token_5h_utilization :: `$.data.limits[?(@.type=='TOKENS_LIMIT')] | sort by nextResetTime asc | [0].percentage  (live index: $.data.limits[1].percentage)` [percent (0-100)]
    - token_5h_reset_time :: `$.data.limits[?(@.type=='TOKENS_LIMIT')] | sort by nextResetTime asc | [0].nextResetTime  (live: $.data.limits[1].nextResetTime)` [epoch milliseconds (UTC)]
    - token_weekly_utilization :: `$.data.limits[?(@.type=='TOKENS_LIMIT')] | sort by nextResetTime asc | [1].percentage  (live index: $.data.limits[2].percentage)` [percent (0-100)]
    - token_weekly_reset_time :: `$.data.limits[?(@.type=='TOKENS_LIMIT')] | sort by nextResetTime asc | [1].nextResetTime  (live: $.data.limits[2].nextResetTime)` [epoch milliseconds (UTC)]
    - tools_search_used :: `$.data.limits[?(@.type=='TIME_LIMIT')].currentValue  (live: $.data.limits[0].currentValue)` [requests/calls (used)]
    - tools_search_limit :: `$.data.limits[?(@.type=='TIME_LIMIT')].usage  (live: $.data.limits[0].usage)` [requests/calls (limit; observed 4000)]
    - tools_search_remaining :: `$.data.limits[?(@.type=='TIME_LIMIT')].remaining  (live: $.data.limits[0].remaining)` [requests/calls (remaining)]
    - tools_search_reset_time :: `$.data.limits[?(@.type=='TIME_LIMIT')].nextResetTime  (live: $.data.limits[0].nextResetTime)` [epoch milliseconds (UTC)]
- sample_response_redacted: {"code":200,"msg":"Operation successful","data":{"limits":[{"type":"TIME_LIMIT","unit":5,"number":1,"usage":4000,"currentValue":17,"remaining":3983,"percentage":1,"nextResetTime":1787973081987,"usageDetails":[{"modelCode":"search-prime","usage":17},{"modelCode":"web-reader","usage":0},{"modelCode":"zread","usage":0}]},{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":71,"nextResetTime":1785500518829},{"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":91,"nextResetTime":1785899481997}],"level":"max"},"success":true}  [no secret present in body; Authorization header key = <REDACTED>]
- notes: LIVE VERIFIED on hax with `curl -sS --max-time 20 -H "Authorization: Bearer <REDACTED>" "https://api.z.ai/api/monitor/usage/quota/limit"` -> HTTP 200, `success":true`, `code":200`. Read-only GET; no writes performed; no files created; key never printed. FIELD AVAILABILITY: (1) Plan tier = data.level (\"max\"). (2) Token budgets are reported as PERCENTAGE ONLY — the two TOKENS_LIMIT entries expose `percentage` + `nextResetTime` but NO absolute tokens-used / tokens-limit counts, and NO $ spend or $ balance. So the tracker can chart utilization % and reset ETA for the 5h and weekly windows, but cannot show raw token counts or dollar figures for those windows (they are not in the API). (3) The TIME_LIMIT entry is a separate tools/search quota (search-prime / web-reader / zread) and DOES give absolute counts: usage=4000 (limit), currentValue=17 (used), remaining=3983 — this is calls, not LLM tokens. ROBUSTNESS: `data.limits[]` order is not guaranteed; select by `type` and (for the two TOKENS_LIMIT rows) sort by `nextResetTime` ascending rather than trusting array index. The live index mapping at probe time was [0]=TIME_LIMIT, [1]=5h TOKENS_LIMIT, [2]=weekly TOKENS_LIMIT. For an hourly poller: utilization % + reset-ms are the two directly-usable per-window signals.

## MiniMax  (key=None)
- works: True | has_credential: True | http: 200
- accounts: ['MINIMAX_API_KEY (George PERSONAL) — 200 OK', 'MINIMAX_API_KEY_IFCA (IFCA) — 200 OK']
- credential_source: env $MINIMAX_API_KEY (present, len 125); also $MINIMAX_API_KEY_IFCA (present, len 125). Both confirmed live-working. Also declared in ~/work/journals/.sb/_dotfiles/.env as `export MINIMAX_API_KEY=sk-cp-m...` (Coding-Plan key) + `MINIMAX_API_KEY_IFCA` + `MINIMAX_API_HOST=https://...`. Keys NOT printed — redacted.
- endpoint: https://api.minimax.io/v1/api/openplatform/coding_plan/remains
- method: GET
- auth_scheme: Bearer token (Authorization: Bearer sk-cp-... Coding-Plan key)
- reset_info: Two rolling windows per model. 5h window: fields start_time/end_time (epoch ms, 18,000,000 ms = 5h span) with remains_time = ms until reset. Weekly window: weekly_start_time/weekly_end_time (epoch ms, 604,800,000 ms = 7d span) with weekly_remains_time = ms until reset. Live sample: 5h resets 2026-07-31 18:00 MYT, weekly resets 2026-08-03 08:00 MYT.
- metrics:
    - 5h-window remaining quota % (general/text models) :: `$.model_remains[?(@.model_name=='general')].current_interval_remaining_percent` [percent remaining (utilization% = 100 - value); array[0]=general, array[1]=video]
    - weekly-window remaining quota % (general) :: `$.model_remains[?(@.model_name=='general')].current_weekly_remaining_percent` [percent remaining (utilization% = 100 - value)]
    - 5h-window usage count / limit :: `$.model_remains[?(@.model_name=='general')].current_interval_usage_count  (limit: .current_interval_total_count)` [requests (used / total in 5h window)]
    - weekly usage count / limit :: `$.model_remains[?(@.model_name=='general')].current_weekly_usage_count  (limit: .current_weekly_total_count)` [requests (used / total in weekly window)]
    - 5h-window reset time :: `$.model_remains[?(@.model_name=='general')].end_time` [epoch milliseconds (window end; verified 1785492000000 = 2026-07-31 18:00 MYT). ms-until-reset also at .remains_time]
    - weekly-window reset time :: `$.model_remains[?(@.model_name=='general')].weekly_end_time` [epoch milliseconds (verified 1785715200000 = 2026-08-03 08:00 MYT). ms-until-reset at .weekly_remains_time]
    - call success sentinel :: `$.base_resp.status_code` [0 = success (status_msg='success')]
- sample_response_redacted: {"model_remains":[{"start_time":1785474000000,"end_time":1785492000000,"remains_time":4104244,"current_interval_total_count":0,"current_interval_usage_count":0,"model_name":"general","current_weekly_total_count":0,"current_weekly_usage_count":0,"weekly_start_time":1785110400000,"weekly_end_time":1785715200000,"weekly_remains_time":227304244,"current_interval_status":1,"current_interval_remaining_percent":75,"current_weekly_status":3,"current_weekly_remaining_percent":100},{ ...model_name":"video"... "current_interval_remaining_percent":100,"current_weekly_remaining_percent":100}],"base_resp":{"status_code":0,"status_msg":"success"}}  (key redacted; second model object truncated)
- notes: WORKING endpoint for the hourly tracker: `curl -sS --max-time 20 -H "Authorization: Bearer <REDACTED>" https://api.minimax.io/v1/api/openplatform/coding_plan/remains` -> HTTP 200, base_resp.status_code=0. GET, read-only. Short alias `https://api.minimax.io/v1/coding_plan/remains` returns identical data (also 200); prefer the full /v1/api/openplatform/... path (documented + stable). No GroupId header needed. Both the personal and IFCA keys are Coding-Plan (sk-cp-) subscription keys and both return 200.\n\nSHAPE: response is `model_remains[]`, one object per model bucket (`general` = text/coding models; `video`). For a token-budget tracker key off model_name=='general'. Quota is expressed as REMAINING PERCENT per window (current_interval_remaining_percent for 5h, current_weekly_remaining_percent for weekly); compute utilization as 100 - remaining_percent. There are also request counters (current_interval_usage_count/total_count, weekly_usage_count/total_count) — note these can read 0/0 for 'general' even when remaining_percent<100, so the authoritative budget signal is the *_remaining_percent field, not the counts.\n\nNO DOLLAR FIELDS: this is a subscription Coding/Token Plan key, so there is NO $ spend or $ balance in the response — budget is token/quota-percent based only. If a pay-as-you-go $ wallet balance is ever needed, that is NOT exposed here and (per MiniMax docs + GitHub MiniMax-AI/MiniMax-M2 issue #88) is only visible in the web console; the China host www.minimaxi.com's copy of this endpoint requires cookie-session auth (status 1004 'cookie is missing') — but the international api.minimax.io host accepts the API key directly, which is what we verified. status enum: current_interval_status/current_weekly_status observed values 1 and 3 (1=active-consuming, 3=idle/full is the likely meaning — not documented, treat as opaque).

## Cursor CLI (cursor-agent)  (key=None)
- works: True | has_credential: True | http: 200
- accounts: ['geoyws@gmail.com — George Yong — plan pro_plus, subscriptionStatus active, yearly, numeric id 220335669, WorkOS sub user_01JY4J7S9DGC29YQZAPAPX1J1X']
- credential_source: /root/.config/cursor/auth.json → field `accessToken` (424-char JWT, prefix eyJ). IMPORTANT correction to the task brief: the bearer credential is NOT in ~/.cursor/cli-config.json — that file only holds authInfo (email/displayName/userId=220335669/authId) and serverConfigCache.authCacheKey (a 50-char cache key, prefix "auth", NOT a usable token) + backendUrl https://api2.cursor.sh. The <userId> used in the cookie/query is the JWT `sub` claim (a google-oauth2|... id from authInfo.authId; the WorkOS id user_01JY... from /api/auth/me also works). No env var (CURSOR_*) set; nothing needed from dotfiles .env.
- endpoint: https://cursor.com/api/usage?user=<REDACTED_USERID>
- method: GET
- auth_scheme: Session JWT sent as a cookie: `Cookie: WorkosCursorSessionToken=<userId>%3A%3A<accessToken>` (the `::` separator URL-encoded). The accessToken is an HS256 session JWT with claims aud=https://cursor.com, type=session, exp=1788255956 (2026-12-xx). No Bearer/Authorization header needed for the cursor.com/api/* GET routes — the cookie alone authenticates. The `?user=` query value is echoed from the cookie; auth is enforced by the JWT, not the query param.
- reset_info: Usage window is anchored by `startOfMonth` from GET /api/usage (e.g. 2026-07-14T04:52:09Z); the request/token counters reset ~monthly from that anchor. There is no rolling 5h/weekly reset field like Anthropic's. No explicit next-reset timestamp is returned — compute reset ≈ startOfMonth + 1 month.
- metrics:
    - requests_used_this_period :: `$["gpt-4"].numRequests` [requests (count since startOfMonth; also numRequestsTotal)]
    - request_limit :: `$["gpt-4"].maxRequestUsage` [requests (null on pro_plus usage-based plan = no fixed request cap; utilization % NOT derivable from GET when null)]
    - tokens_used_this_period :: `$["gpt-4"].numTokens` [tokens]
    - token_limit :: `$["gpt-4"].maxTokenUsage` [tokens (null = no token cap exposed)]
    - period_reset_anchor :: `$.startOfMonth` [ISO-8601 datetime (monthly usage window start; period rolls ~monthly from this)]
    - usd_credit_balance :: `$.customerBalance` [USD (Stripe customer balance credit; from GET /api/auth/stripe; 0 = none)]
    - plan_tier :: `$.membershipType` [string enum e.g. pro_plus/pro/free (GET /api/auth/stripe)]
    - subscription_status :: `$.subscriptionStatus` [string enum active/trialing/cancelled/past_due (GET /api/auth/stripe)]
- sample_response_redacted: GET /api/usage?user=<REDACTED_USERID> (HTTP 200): {"gpt-4":{"numRequests":0,"numRequestsTotal":0,"numTokens":0,"maxTokenUsage":null,"maxRequestUsage":null},"startOfMonth":"2026-07-14T04:52:09.000Z"}  ||  GET /api/auth/stripe (HTTP 200): {"membershipType":"pro_plus","paymentId":"<REDACTED>","subscriptionStatus":"active","trialEligible":false,"customerBalance":0,"isOnBillableAuto":true,"isTeamMember":false,"individualMembershipType":"pro_plus","lastPaymentFailed":false,"pendingCancellationDate":null,"isYearlyPlan":true}
- notes: WORKS via GET, read-only — two endpoints returned HTTP 200 with usable JSON, both live-run with `curl -sS --max-time 20`. Exact working curl (key redacted): curl -sS --max-time 20 'https://cursor.com/api/usage?user=<REDACTED_USERID>' -H 'Cookie: WorkosCursorSessionToken=<REDACTED_USERID>%3A%3A<REDACTED_JWT>' -H 'Accept: application/json'  (and the same cookie against https://cursor.com/api/auth/stripe and /api/auth/me). CAVEAT for the budget tracker: this account is pro_plus on the new usage-based/billable-auto pricing, so /api/usage returns maxRequestUsage=null and maxTokenUsage=null — meaning you get RAW consumption counts but NO percent-utilization or dollar-spend-vs-limit from GET endpoints alone. The real $-based current-period usage + hard limit live behind POST-only routes (https://cursor.com/api/dashboard/get-hard-limit returned HTTP 405 on GET; the api2.cursor.sh .../GetCurrentPeriodUsage is a Connect/POST RPC) which were deliberately NOT called per the GET/read-only rule. RECOMMENDATION: usable for a lightweight tracker (poll /api/usage for numRequests/numTokens + startOfMonth, and /api/auth/stripe for plan/status/customerBalance), but if you need true % utilization or $ spend you must relax to a POST call against get-hard-limit + GetMonthlyInvoice — flag that as a follow-up decision. Token expires exp=1788255956; cursor-agent auto-refreshes ~/.config/cursor/auth.json, so read the file fresh each poll rather than caching the JWT. Sources: unofficial reverse-engineered endpoints (github.com/Tendo33/cursor-usage-tracker, github.com/eisbaw/cursor_api_demo) — subject to change without notice.

## Kimi Code (Moonshot)  (key=None)
- works: True | has_credential: True | http: 200
- accounts: ['George PERSONAL Kimi Code (Allegretto tier). membership.level=LEVEL_STANDARD, region=REGION_OVERSEA, subType=TYPE_PURCHASE, userId=<REDACTED>']
- credential_source: ~/.kimi-code/credentials/kimi-code.json → .access_token
- endpoint: https://api.kimi.com/coding/v1/usages
- method: GET
- auth_scheme: OAuth2 Bearer access token. Header: `Authorization: Bearer <REDACTED>`. Token is a JWT (alg ES256, iss=kimi-auth, scope=kimi-code, type=access). User-Agent is NOT required (tested: 200 with and without `KimiCLI/1.6`). The `/coding/v1/usage` singular path 404s; the working path is `/usages` (plural).
- reset_info: Weekly cycle ($.usage.resetTime) resets 2026-08-06T01:06:30Z (~7 days out). 5-hour rolling window ($.limits[0].detail.resetTime, window.duration=300 TIME_UNIT_MINUTE) resets 2026-07-31T12:06:30Z. Booster-wallet monthly $ counter implied monthly.
- metrics:
    - weekly_quota_used :: `$.usage.used` [quota-units (limit is normalized to 100, so used ≈ utilization %)]
    - weekly_quota_limit :: `$.usage.limit` [quota-units (=100)]
    - weekly_quota_remaining :: `$.usage.remaining` [quota-units]
    - weekly_reset_time :: `$.usage.resetTime` [ISO-8601 UTC timestamp]
    - window5h_used :: `$.limits[0].detail.used` [quota-units (limit normalized to 100 ≈ utilization %)]
    - window5h_limit :: `$.limits[0].detail.limit` [quota-units (=100)]
    - window5h_remaining :: `$.limits[0].detail.remaining` [quota-units]
    - window5h_duration :: `$.limits[0].window.duration` [minutes (timeUnit=TIME_UNIT_MINUTE; 300 = 5h)]
    - window5h_reset_time :: `$.limits[0].detail.resetTime` [ISO-8601 UTC timestamp]
    - monthly_spend :: `$.boosterWallet.monthlyUsed.priceInCents` [USD cents (5000 = $50.00)]
    - monthly_spend_limit :: `$.boosterWallet.monthlyChargeLimit.priceInCents` [USD cents (10000 = $100.00)]
    - booster_wallet_balance :: `$.boosterWallet.balance.amount` [UNIT_CURRENCY micro-units (5000000000)]
    - parallel_concurrency_limit :: `$.parallel.limit` [max concurrent requests (=30)]
- sample_response_redacted: {"user":{"userId":"<REDACTED>","region":"REGION_OVERSEA","membership":{"level":"LEVEL_STANDARD"},"businessId":""},"usage":{"limit":"100","used":"95","remaining":"5","resetTime":"2026-08-06T01:06:30.997582Z"},"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","used":"34","remaining":"66","resetTime":"2026-07-31T12:06:30.997582Z"}}],"parallel":{"limit":"30","details":["<REDACTED>","<REDACTED>"]},"totalQuota":{},"authentication":{"method":"METHOD_ACCESS_TOKEN","scope":"FEATURE_CODING"},"subType":"TYPE_PURCHASE","boosterWallet":{"balance":{"feature":"FEATURE_OMNI","type":"BOOSTER","amount":"5000000000","unit":"UNIT_CURRENCY"},"status":"STATUS_ACTIVE","monthlyChargeLimit":{"currency":"USD","priceInCents":"10000"},"monthlyUsed":{"currency":"USD","priceInCents":"5000"}},"domain":"DOMAIN_NEXUS"}
- notes: VERIFIED LIVE (2026-07-31 ~08:53 UTC). Exact working curl (token redacted):

  curl -sS --max-time 20 -H "Authorization: Bearer <REDACTED>" https://api.kimi.com/coding/v1/usages

Returned HTTP 200 with real quota data. `/coding/v1/usage` (singular) returns 404 {"type":"resource_not_found_error"} — use the plural `/usages`. User-Agent header optional (200 with none, with KimiCLI/1.6, and with curl/8.0).

Endpoint discovery: matched the community tracker Golden0Voyager/kimi-code-usage (src/kimi_code_usage/providers/kimi.py), which GETs `{base}/usages` with `{base}/usage` as a 404 fallback — confirmed live.

RESPONSE MAP FOR BUDGET TRACKER (3 windows in one call):
- Weekly utilization: $.usage.used / $.usage.limit = 95/100 = 95% used, 5 remaining, resets 2026-08-06T01:06:30Z.
- 5-hour window (300 min): $.limits[0].detail.used / .limit = 34/100 = 34% used, 66 remaining, resets 2026-07-31T12:06:30Z. `limits[]` is an array — iterate; each item has window{duration,timeUnit} + detail{limit,used,remaining,resetTime}.
- Monthly $ spend: $.boosterWallet.monthlyUsed.priceInCents = 5000 = $50.00 of monthlyChargeLimit 10000 = $100.00 (50%). balance.amount 5000000000 in UNIT_CURRENCY is the booster wallet reserve.
- Concurrency: $.parallel.limit = 30.
- limit/used strings are limit-normalized to 100, so `used` doubles as the utilization percent; compute pct = used/limit*100 to be safe (matches the tracker).

CRITICAL OPERATIONAL CAVEAT for an HOURLY cron: the access_token is short-lived — expires_in=900 (15 min); the live token in credentials/kimi-code.json had expires_at=1785488654 (2026-07-31T09:04:14Z), ~13 min ahead of probe time. An hourly job reading the stored access_token WILL hit an expired token and 401 most runs. Two options: (a) run the hourly probe only while `kimi-cli` is active (it refreshes credentials/kimi-code.json continuously), or (b) before each probe, mint a fresh access_token from `.refresh_token` via the kimi-auth OAuth token endpoint — that is a POST and out of scope for this read-only verification (not performed). Recommend the tracker read `.access_token` from ~/.kimi-code/credentials/kimi-code.json at probe time and, if expired ($.expires_at <= now), do the refresh-token grant first. All identifiers (userId, wallet ids, parallel session ids, JWT) redacted as <REDACTED>; raw token never printed.

## Anthropic Claude  (key=None)
- works: True | has_credential: True | http: GET /v1/models: 200 (gmail), 200 (ifca2) — OAuth tokens live. Admin usage_report/messages: 401. Admin cost_report: 401 (both "invalid x-api-key" — regular key, no admin key). Budget-header POST /v1/messages: NOT fired this run — blocked by read-only sandbox classifier (rule 4); mechanism confirmed by code-read of probe-budget.sh + live 200 on GET /v1/models for both accounts.
- accounts: ['gmail', 'ifca2']
- credential_source: OAuth (both accounts): $CLAUDE_CONFIG_DIR/.credentials.json → .claudeAiOauth.accessToken (also .refreshToken, .expiresAt). gmail = $HOME/.claude-gmail, ifca2 = $HOME/.claude-ifca2. Both live, non-expired (gmail expiresAt=1785502317360, ifca2 expiresAt=1785507200564; both subscriptionType=max, scopes include user:inference). Admin key: NOT FOUND — grep for sk-ant-admin across .env + keys/KEYS.md + all git-crypt'd files returned zero hits. Only a PERSONAL regular sk-ant-api03 key exists (.devcontainer/env/shared.env), which cannot access the Admin API.
- endpoint: Budget/quota (OAuth Max accounts, both gmail + ifca2): POST https://api.anthropic.com/v1/messages — read unified rate-limit values from RESPONSE HEADERS (there is no GET quota endpoint for OAuth/Max). Minimal body: {"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"."}]}. Admin usage/cost (org API-billing): GET https://api.anthropic.com/v1/organizations/usage_report/messages and GET https://api.anthropic.com/v1/organizations/cost_report — require an sk-ant-admin key (ABSENT → 401).
- method: POST (/v1/messages, budget headers) + GET (admin usage/cost reports, unusable — no admin key); GET /v1/models used as read-only liveness check
- auth_scheme: OAuth Bearer for the header probe: header `authorization: Bearer <accessToken>` + `anthropic-version: 2023-06-01` + `anthropic-beta: oauth-2025-04-20`. Admin reports: header `x-api-key: <sk-ant-admin...>` + `anthropic-version: 2023-06-01`.
- reset_info: 5h window reset: response header anthropic-ratelimit-unified-5h-reset (epoch seconds, UTC). Weekly window reset: anthropic-ratelimit-unified-7d-reset (epoch seconds, UTC). The /budget skill renders these as absolute local time + relative delta. status header (allowed / allowed_warning / rejected) signals whether the account is currently throttled. Admin reports use time-bucketed rows keyed by starting_at/ending_at (RFC3339) — unverified, no admin key.
- metrics:
    - 5h rolling-window utilization :: `response-header: anthropic-ratelimit-unified-5h-utilization` [fraction 0.0-1.0 (x100 = percent)]
    - weekly (7d) rolling-window utilization :: `response-header: anthropic-ratelimit-unified-7d-utilization` [fraction 0.0-1.0 (x100 = percent)]
    - 5h window reset time :: `response-header: anthropic-ratelimit-unified-5h-reset` [epoch seconds (UTC)]
    - weekly (7d) window reset time :: `response-header: anthropic-ratelimit-unified-7d-reset` [epoch seconds (UTC)]
    - rate-limit status :: `response-header: anthropic-ratelimit-unified-status` [enum: allowed | allowed_warning | rejected]
    - input tokens (Admin API — requires admin key, unverified/401) :: `$.data[].results[].uncached_input_tokens` [tokens]
    - output tokens (Admin API — requires admin key, unverified/401) :: `$.data[].results[].output_tokens` [tokens]
    - spend/cost (Admin cost_report — requires admin key, unverified/401) :: `$.data[].results[].amount` [USD (currency in .currency)]
- sample_response_redacted: GET /v1/models (gmail & ifca2, 200): {"data":[{"id":"claude-opus-5","type":"model",...},{"id":"claude-sonnet-5",...}],"has_more":true} (no anthropic-ratelimit-* headers on GET). Admin usage_report/messages & cost_report (401): {"type":"error","message":"invalid x-api-key"}. Documented budget-header shape from probe-budget.sh (POST /v1/messages 200/429 response, NOT fired here): anthropic-ratelimit-unified-5h-utilization: 0.12; anthropic-ratelimit-unified-7d-utilization: 0.34; anthropic-ratelimit-unified-5h-reset: 1785502317; anthropic-ratelimit-unified-7d-reset: 1785900000; anthropic-ratelimit-unified-status: allowed. All tokens/keys shown as <REDACTED>.
- notes: PART (a) OAuth rate-limit header probe (gmail + ifca2) — MECHANISM CONFIRMED, creds live. probe-budget.sh (/root/work/journals/.sb/claude-skills/plugins/coordination/skills/budget/scripts/probe-budget.sh) auto-discovers ~/.claude-*/.credentials.json, reads .claudeAiOauth.accessToken per account, then POSTs a 1-token haiku request to https://api.anthropic.com/v1/messages with headers authorization: Bearer <token>, anthropic-version: 2023-06-01, anthropic-beta: oauth-2025-04-20, content-type: application/json. It scrapes five RESPONSE headers: anthropic-ratelimit-unified-{5h,7d}-utilization (fraction 0-1), -{5h,7d}-reset (epoch seconds), -status (allowed/allowed_warning/rejected). 200 and 429 are both treated as success (429 still carries the headers). OAuth REFRESH: the script never calls a token endpoint directly — it shells out `CLAUDE_CONFIG_DIR=$HOME/.claude-<label> claude --print "." --model claude-haiku-4-5`, relying on the claude CLI to refresh + rewrite .credentials.json at the start of any API-touching command; it pre-refreshes when expiresAt is within 60s and retries once on a 401. LIVE VERIFICATION: I could not fire the actual budget POST — the read-only sandbox classifier blocks POST /v1/messages (correctly enforcing task rule 4 "GET/read-only only"). Instead I confirmed both credentials are live via read-only GET https://api.anthropic.com/v1/models → HTTP 200 for BOTH gmail and ifca2 (returns claude-opus-5, claude-sonnet-5; both tokens non-expired, scope user:inference present). GET /v1/models does NOT return the unified rate-limit headers, confirming those are specific to /v1/messages. So: mechanism + endpoint + header field names verified by code-read; both accounts' OAuth creds verified live by GET 200; the utilization NUMBERS themselves were not captured live in this run due to the POST block. This is George's production /budget skill, run regularly, so the mechanism is proven.

PART (b) Admin usage/cost API for ifca2 — NOT USABLE (no admin key). No sk-ant-admin key exists anywhere: grep sk-ant-admin across .env, keys/KEYS.md, and all git-crypt'd dotfiles = 0 hits. The only Anthropic key present is a PERSONAL regular sk-ant-api03 (in .devcontainer/env/shared.env, George's LLM account). I live-tested (read-only GET) both admin endpoints with that regular key: GET /v1/organizations/usage_report/messages?starting_at=... → 401 {"type":"error","message":"invalid x-api-key"}, and GET /v1/organizations/cost_report?starting_at=... → 401 same. Regular keys cannot access the org Admin API; it strictly requires an Admin key. The documented token/cost field paths ($.data[].results[].{uncached_input_tokens,output_tokens} for usage_report; $.data[].results[].amount for cost_report) are included in metrics but are UNVERIFIED — I have no admin credential to fire them successfully.

CORRECTION on ifca2 classification: the task described ifca2 as "API Usage Billing", but its on-disk .credentials.json is OAuth with subscriptionType=max (identical shape to gmail). So ifca2 IS probeable via the part-(a) OAuth header mechanism regardless of the billing label; the part-(b) Admin API is a separate path that is unavailable (no admin key). To enable Admin usage/cost tracking for the IFCA org, provision an sk-ant-admin key from the Anthropic Console (Settings > Admin keys) and store it in the IFCA-tagged dotfiles; then the two GET report endpoints become live.

