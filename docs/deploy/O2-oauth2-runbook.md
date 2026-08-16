# O2 — putting `atmux.geoy.ws` behind oauth2-proxy

Phase O2 of [ADR-272](../adr/272-voice-operator-interface.md) §Security. **This is the gate on clearing `ATMUX_VOICE_READONLY=1`**, because layer 5 (readonly) is what currently closes the O1 gap of token-only auth. Clear readonly before O2 lands and a single bearer token is the only thing between the public internet and tools that drive the operator's tmux agents.

Modelled on the working `dash.geoy.ws` deployment (`/opt/unum-identity-staging/dash-pilot`), which is the house pattern — same image pin, same hardening, same realm.

---

## READ THIS FIRST — one decision the operator must make

**Does oauth2 cover `/ws`, or only the page routes?**

ADR-272 §Security layer 1 says the vhost sits behind the proxy "so an unauthenticated request never reaches the Bun server at all". Taken literally that includes `/ws`. But `/ws` is authenticated by a **bearer token**, and the headless probe (`scripts/voice-probe.ts`) sends exactly that and nothing else. If oauth2 fronts `/ws`, **the probe stops working** — and the probe is how V-3/V-4 are verified before and after every deploy.

Two coherent options. Pick one deliberately; do not let it be decided by whichever config gets pasted first.

| | **A — oauth2 on page routes only** | **B — oauth2 on everything** |
|---|---|---|
| `/` , `/js/*`, `/css/*`, icons | oauth2 | oauth2 |
| `/ws` | token + origin (unchanged) | oauth2 cookie **and** token |
| `/healthz` | open (unchanged) | open (must stay open) |
| Headless probe | keeps working | **breaks** — needs a cookie or a bypass |
| Matches ADR-272 layer 1 literally | no — the ADR wording needs amending | yes |
| Real protection delta | the PWA shell (which holds no secret) | the actual dangerous endpoint |

**Recommendation: B, with a narrow, explicit probe exemption** — either a separate localhost-only listener for loopback probes, or an allow-rule on a dedicated path. B is the only option that puts an auth layer in front of the endpoint that can drive agents, which is the entire point of O2; A protects the one surface that holds nothing secret. But B must not be adopted by accident, because it silently breaks the deploy verification path, and a deploy you cannot verify is worse than one you can.

Whichever is chosen, record it as an ADR-272 §Security amendment. Right now the ADR's wording implies B while the shipped nginx vhost is shaped for A (its `/oauth2/` blocks are present but commented out).

---

## Prerequisites — operator only, cannot be automated

1. **A Keycloak client** in realm `unum` at `https://id-staging.u-n-u-m.com`:
   - Client ID: `atmux-voice`
   - Access type: confidential (client authentication ON)
   - Standard flow ON, Direct access grants OFF
   - Valid redirect URI: `https://atmux.geoy.ws/oauth2/callback`
   - Web origin: `https://atmux.geoy.ws`
   - A group for authorisation — `/atmux-operators` (mirrors dash's `/dash-operators`). Add yourself.
2. **Two secret files on the host**, root-owned, `0600`, **outside this repo** (they are mounted into the container):
   - the Keycloak client secret
   - a cookie secret: `openssl rand -base64 32 | tr -- '+/' '-_'`
   Record both in the git-crypt'd dotfiles with a `keys/KEYS.md` pointer row, per the standing credential rule — value in the encrypted store, pointer only in any plaintext doc.
3. **A dedicated private subnet** for the compose network (dash uses its own; do not share).

## Install

Both files live in `docs/deploy/atmux-voice-oauth2/`. Copy the directory to `/opt/atmux-voice-oauth2/`, then:

```sh
cd /opt/atmux-voice-oauth2
export VOICE_OIDC_CLIENT_SECRET_FILE=/etc/atmux-voice/oidc_client_secret
export VOICE_OIDC_COOKIE_SECRET_FILE=/etc/atmux-voice/oidc_cookie_secret
export VOICE_OIDC_NETWORK_SUBNET=172.31.241.0/24   # NOT dash's subnet
export VOICE_OIDC_NETWORK_GATEWAY=172.31.241.1
docker compose up -d
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:14181/ping   # expect 200
```

`trusted_proxy_ips` in the cfg **must** be set to this network's gateway, not dash's. Getting it wrong makes oauth2-proxy trust the wrong hop and mis-read the client IP.

## Wire nginx

The vhost at `/etc/nginx/sites-enabled/atmux.geoy.ws` already carries the `/oauth2/` blocks, commented out, matching the dash pattern. Uncomment them, change the upstream port from dash's `14180` to **`14181`**, and set every `Host` / `X-Forwarded-Host` / `X-Auth-Request-Redirect` to `atmux.geoy.ws`.

Then apply the decision above: add `auth_request /oauth2/auth;` to the page `location /` (option A), and additionally to `location = /ws` (option B).

```sh
nginx -t && systemctl reload nginx
```

`nginx -t` before reload is doing real work here, not ceremony — a bad vhost makes nginx refuse the **entire** config and takes down every other site on the box. That exact failure was caught once already on this vhost (an `http2 on;` directive nginx 1.24.0 does not support).

## Verify before clearing readonly

1. Log out / private window → `https://atmux.geoy.ws/` redirects to Keycloak, not to the PWA.
2. Log in as a user **not** in `/atmux-operators` → denied.
3. Log in as yourself → the PWA loads.
4. `/healthz` still answers **without** auth (monitoring depends on it, and it holds nothing sensitive).
5. Probe still works per the option chosen — under B, via the exemption; under A, unchanged.
6. `grep -F "$ATMUX_VOICE_TOKEN" /var/log/nginx/*.log` → no match. Verify the check itself with a planted control first, or a clean result proves nothing.

## Only then

Clear `ATMUX_VOICE_READONLY`. The four messaging tools and `pane_nudge` become reachable.

Note what that does **not** give you: ADR-272 D7's affirmation half is still model-side (see the D7 clarification). The server enforces the token's binding, TTL and single use; it does **not** observe the operator saying yes. After readonly clears, the operator's ear is the only check on that step.

---

# Alternative: nginx basic auth (no Keycloak)

Everything above assumes OIDC. It does not have to be. **What ADR-272 §Security actually requires is that an unauthenticated request never reaches the Bun server** — OIDC is one way to satisfy that, and `auth_basic` is another. This alternative exists because the OIDC path has a long-lead prerequisite (a Keycloak client, a group, two secret files, a compose stack) and this one is a single command.

It is already a house pattern on this box, not an improvisation: `33dmg.geoy.ws.conf` uses `auth_basic`, and there are three htpasswd files under `/etc/nginx` (`dash-break-glass/htpasswd`, `htpasswd.chartdb`, `htpasswd.dash`). `htpasswd` is installed.

## Why it may actually fit better here

It **dissolves the `/ws` dilemma** that OIDC creates. oauth2-proxy in front of `/ws` breaks `scripts/voice-probe.ts`, which authenticates with a bearer token and holds no cookie — and that probe is how V-3/V-4 are verified on every deploy. Basic auth works for both sides without an exemption:

- the PWA gets a browser prompt, saved once in the phone's keychain
- the probe sends `Authorization: Basic …` alongside its existing bearer token

So the endpoint that can actually drive agents gets a second layer, and deploy verification keeps working. That is the combination option B could not give without carving a hole in itself.

## What it costs — state this plainly, it is a real downgrade

Basic auth is **weaker than OIDC**: no SSO, no group-based revocation (revoking means editing the htpasswd file), no MFA, no session expiry, and the credential is typed into a browser prompt rather than federated. If the phone is lost, the remedy is rotating the file rather than disabling an account.

The honest framing is not "as good as OIDC". It is: **a second layer today beats a stronger second layer whenever the Keycloak client happens to get made.** If OIDC lands later, this comes out in one edit.

## Install

```sh
# one operator-chosen credential
sudo htpasswd -B -c /etc/nginx/htpasswd.atmux-voice geoyws
sudo chmod 640 /etc/nginx/htpasswd.atmux-voice
sudo chown root:www-data /etc/nginx/htpasswd.atmux-voice
```

Record it the same way as `ATMUX_VOICE_TOKEN`: **value in the git-crypt'd dotfiles, a pointer row in `keys/KEYS.md`, never in this repo.**

Then in `/etc/nginx/sites-enabled/atmux.geoy.ws`, inside **both** `location = /ws` and the page `location /`:

```nginx
    auth_basic            "atmux voice";
    auth_basic_user_file  /etc/nginx/htpasswd.atmux-voice;
```

Leave `location = /healthz` **without** it — monitoring depends on that staying open, and it discloses nothing sensitive.

```sh
nginx -t && systemctl reload nginx
```

`nginx -t` before reload is doing real work: a bad vhost makes nginx refuse the **entire** config and takes every other site on this box down with it. That exact failure was caught once already here (an `http2 on;` directive nginx 1.24.0 does not support).

## Verify before clearing readonly

1. `curl -sI https://atmux.geoy.ws/` → **401**, and the body is nginx's, not the PWA shell.
2. `curl -sI -u geoyws:<pw> https://atmux.geoy.ws/` → 200.
3. `/healthz` still answers with **no** credentials.
4. Probe with both credentials → still `ok=true`. If this fails, stop: you have just broken deploy verification.
5. The PWA prompts on the phone, and the mic still works after authenticating.

Then, and only then, clear `ATMUX_VOICE_READONLY` — with the same D7 caveat as above: the server enforces the token's binding, TTL and single use, but nothing server-side observes the operator saying yes.
