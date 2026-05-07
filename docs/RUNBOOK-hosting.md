# Runbook — atmux docs hosting (`atmux.u-n-u-m.com`)

**Target host:** hax (Hetzner AX42-U, `178.63.205.39`)
**Domain:** `atmux.u-n-u-m.com` (co-tenanted under George's `u-n-u-m.com`
zone — Unum's primary domain; see `~/.claude-ifca/CLAUDE.md` "DNS Layout")
**TLS:** per-host Let's Encrypt cert (u-n-u-m.com has no wildcard; only
`ifca.app` does)
**Generator:** VitePress (Bun-friendly, TS-native, light)
**Tracked branch:** `main` (NOT `worktree-atmux-bun` — publishes shipped
reality, not in-flight ports)

---

## What ships from the repo

| Path                                  | Purpose                                           |
|---------------------------------------|---------------------------------------------------|
| `docs/.vitepress/config.ts`           | Site config — nav, sidebar, theme, search         |
| `docs/index.md`                       | Landing page (hero + features)                    |
| `docs/PRD.md`                         | Canonical PRD (cross-linked from nav)             |
| `docs/ARCHITECTURE.md`, `docs/CI.md`, `docs/GETTING_STARTED.md` | Existing operator docs |
| `docs/adr-bun/`, `docs/adr/`          | ADR trees (worktree-local + parent-symlinked)     |
| `scripts/deploy-docs.sh`              | Cron-pulled build + rsync                         |
| `ops/nginx/atmux-docs.conf`           | nginx site config — symlinked to `/etc/nginx/sites-enabled/` |
| `package.json:scripts.docs:{dev,build,preview}` | local + CI build commands               |

`README.md` and `CHANGELOG.md` live at repo root and are **copied** into
`docs/` by `scripts/deploy-docs.sh` before each build (vitepress only
serves files inside its `srcDir = docs/`). The copies are never committed.

---

## Local dev loop

```bash
cd /root/work/src/atmux/.claude/worktrees/atmux-bun
bun install
bun run docs:dev      # http://127.0.0.1:5173 with HMR
```

To preview the production build:

```bash
bun run docs:build    # output: docs/.vitepress/dist/
bun run docs:preview
```

---

## First-time deploy (one-shot — driver-coordinated)

> 🚨 **All commands below touch HAX shared infrastructure (DNS, TLS, nginx,
> root cron). Each step requires explicit driver authorization in chat
> before firing.** The `docs` lane ships the *runbook*; the driver
> *executes* the steps. Per-step ack avoids accidental DNS flap or
> production nginx breakage.

### Step 1 — DNS A record

Driver-ack required. Cloudflare proxy must be **OFF** for the first LE
issuance (HTTP-01 challenge needs to reach origin unproxied):

```bash
flarectl dns create -z u-n-u-m.com \
  --name atmux \
  --type A \
  --content 178.63.205.39 \
  --proxy=false
```

Verify:

```bash
dig +short atmux.u-n-u-m.com @1.1.1.1
# expect: 178.63.205.39
```

### Step 2 — webroot for LE challenge

On hax:

```bash
sudo install -d -m 755 /var/www/atmux-docs
sudo install -d -m 755 /var/www/atmux-docs/.well-known/acme-challenge
```

### Step 3 — temporary HTTP-only nginx (LE challenge gate)

The committed `ops/nginx/atmux-docs.conf` references the cert that hasn't
been issued yet. To avoid `nginx -t` failure, deploy a minimal HTTP-only
config first:

```bash
sudo tee /etc/nginx/sites-available/atmux-docs-bootstrap.conf <<'EOF'
server {
    listen 80;
    server_name atmux.u-n-u-m.com;

    location /.well-known/acme-challenge/ {
        root /var/www/atmux-docs;
        try_files $uri =404;
    }

    location / { return 503 "atmux docs site bootstrapping; LE issuance in progress\n"; }
}
EOF

sudo ln -sf /etc/nginx/sites-available/atmux-docs-bootstrap.conf \
            /etc/nginx/sites-enabled/atmux-docs-bootstrap.conf

sudo nginx -t && sudo systemctl reload nginx
```

### Step 4 — issue Let's Encrypt cert

Driver-ack required:

```bash
sudo certbot certonly --webroot \
  -w /var/www/atmux-docs \
  -d atmux.u-n-u-m.com \
  --non-interactive --agree-tos -m geoyws@gmail.com
```

Expected output: `Successfully received certificate. Certificate is saved
at: /etc/letsencrypt/live/atmux.u-n-u-m.com/fullchain.pem`.

### Step 5 — swap to the production nginx config

```bash
# Remove the bootstrap config
sudo rm /etc/nginx/sites-enabled/atmux-docs-bootstrap.conf

# Symlink the repo-tracked config into sites-enabled
sudo ln -sf /root/work/src/atmux/.claude/worktrees/atmux-bun/ops/nginx/atmux-docs.conf \
            /etc/nginx/sites-enabled/atmux-docs.conf

sudo nginx -t && sudo systemctl reload nginx
```

> **Note:** symlinking to the worktree pins the prod nginx config to this
> branch. Once the atmux-bun cutover lands and `worktree-atmux-bun` merges
> into main, the symlink target should re-point at the post-merge path
> (likely `/root/work/src/atmux/ops/nginx/atmux-docs.conf` once the
> worktree is collapsed). Re-symlink + `nginx -t` + reload at that point.

### Step 6 — first build + sync

```bash
cd /root/work/src/atmux/.claude/worktrees/atmux-bun
bun install
sudo /root/work/src/atmux/.claude/worktrees/atmux-bun/scripts/deploy-docs.sh
```

Verify:

```bash
curl -sSI https://atmux.u-n-u-m.com | head -5
# expect: HTTP/2 200, valid Let's Encrypt cert
```

### Step 7 — install cron

Driver-ack required (root cron edits production scheduling):

```bash
sudo crontab -e
# add one line:
*/15 * * * * /root/work/src/atmux/.claude/worktrees/atmux-bun/scripts/deploy-docs.sh >> /var/log/atmux-docs-deploy.log 2>&1
```

### Step 8 (optional, post-issuance) — flip Cloudflare proxy ON

After cert is issued + verified loading green, flipping the orange-cloud
gives DDoS protection + caching. Driver-ack required:

```bash
flarectl dns update -z u-n-u-m.com \
  --id "$(flarectl dns list -z u-n-u-m.com --name atmux.u-n-u-m.com | tail -1 | awk '{print $2}')" \
  --proxy=true
```

⚠️ Flipping proxy ON before LE issuance breaks HTTP-01 challenge. Order
matters — only flip after Step 4 verifies green.

---

## Cert renewal

certbot's systemd timer (`certbot.timer`) auto-renews twice daily. Verify:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

The renew hook on hax already reloads nginx (`/etc/letsencrypt/renewal-hooks/post/`).
If not present:

```bash
sudo tee /etc/letsencrypt/renewal-hooks/post/nginx-reload.sh <<'EOF'
#!/usr/bin/env bash
systemctl reload nginx
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/nginx-reload.sh
```

---

## Operations

### Force a rebuild without waiting for cron

```bash
sudo /root/work/src/atmux/.claude/worktrees/atmux-bun/scripts/deploy-docs.sh
```

The `docs-last-built.sha` file under `.atmux/state/` short-circuits when
HEAD hasn't changed; clear it to force:

```bash
sudo rm /root/work/src/atmux/.claude/worktrees/atmux-bun/.atmux/state/docs-last-built.sha
```

### Tail the deploy log

```bash
sudo tail -F /var/log/atmux-docs-deploy.log
```

### Roll back to a known-good build

The deploy script's rsync is `--delete` — no in-place backup. To roll
back:

```bash
cd /root/work/src/atmux
git fetch origin
git checkout <known-good-sha>
sudo /root/work/src/atmux/.claude/worktrees/atmux-bun/scripts/deploy-docs.sh
git checkout main          # (or whatever branch HEAD was on)
```

### Smoke check

```bash
curl -sSI https://atmux.u-n-u-m.com               # 200 + valid cert
curl -sS  https://atmux.u-n-u-m.com | grep -i atmux  # body sanity
curl -sSI https://atmux.u-n-u-m.com/PRD           # PRD page resolves
curl -sSI https://atmux.u-n-u-m.com/adr-bun/      # ADR tree resolves
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `nginx -t` fails: `cannot load certificate` | Step 4 didn't issue (DNS hadn't propagated, or proxy was on) | `dig +short atmux.u-n-u-m.com` should return `178.63.205.39`. Check Cloudflare proxy is OFF. Re-run Step 4. |
| LE challenge fails: `Invalid response from http://...` | Bootstrap nginx not reloaded, or webroot missing | `ls -la /var/www/atmux-docs/.well-known/acme-challenge/` exists; `nginx -T \| grep atmux` shows bootstrap config; `curl -sSI http://atmux.u-n-u-m.com/.well-known/acme-challenge/test` returns 404 (not 503) |
| `bun install` fails on hax cron | bun not on root's PATH | `mise activate` in cron line, or use absolute path: `/root/.local/share/mise/installs/bun/.../bin/bun` |
| Build succeeds but site shows `503 bootstrapping` | Step 5 not run; bootstrap config still active | `ls /etc/nginx/sites-enabled/ \| grep atmux` should show only `atmux-docs.conf`, not `atmux-docs-bootstrap.conf`. Remove + reload. |
| ADR pages 404 | VitePress did not pick up `docs/adr-bun/` | `bun run docs:build` locally — confirm `docs/.vitepress/dist/adr-bun/` exists. If empty, sidebar config in `docs/.vitepress/config.ts` may need a glob. |
| Cron deploys, site doesn't update | `docs-last-built.sha` matches; deploy short-circuits | `sudo rm .atmux/state/docs-last-built.sha`, re-run. If still stale: `git fetch` + check `git log origin/main` for the expected commit. |

---

## Tear-down (if ever)

```bash
# 1. remove cron
sudo crontab -e   # delete the deploy-docs line

# 2. remove nginx site
sudo rm /etc/nginx/sites-enabled/atmux-docs.conf
sudo nginx -t && sudo systemctl reload nginx

# 3. revoke + delete cert
sudo certbot revoke --cert-name atmux.u-n-u-m.com
sudo certbot delete --cert-name atmux.u-n-u-m.com

# 4. remove webroot
sudo rm -rf /var/www/atmux-docs

# 5. remove DNS
flarectl dns delete -z u-n-u-m.com \
  --id "$(flarectl dns list -z u-n-u-m.com --name atmux.u-n-u-m.com | tail -1 | awk '{print $2}')"
```

---

## Ownership

- **Repo-side artifacts** (config, scripts, runbook): owned by the `docs`
  member of the atmux-bun team. PR-gated through reviewer.
- **HAX-side execution** (DNS, TLS, nginx, cron): driver-coordinated.
  No agent fires these without explicit driver ack in chat per the
  docs-lane guardrail in the brief: *"DNS/TLS/nginx work touches HAX —
  driver-coordinated. Don't fire flarectl/certbot/nginx reload without
  explicit driver ack."*

When the atmux-bun cutover lands and the worktree collapses into main,
the nginx symlink target needs re-pointing — see Step 5 note above.
