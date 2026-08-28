<!-- brief-version: v2 -->

> ⚠ **orchd retired 2026-08-27 per [ADR-276](../../docs/adr/276-orchd-retirement-and-atmux-scope.md).** Every "orchd" / `__orchd__` window / ticker / auto-spawn / auto-merge-consumer sentence in this brief is HISTORY — no daemon runs. Manual orchestration ([ADR-260](../../docs/adr/260-manual-orchestration-mode-default.md)) is the reality; the one-shot event drain is operator-invoked `atmux committer --drain`.

<!-- Changed 2026-05-24 per orchd+honker pivot — role retired per ADR-214; this file is a tombstone for back-compat. -->

## §0 — Identity check (FIRST action of every fresh turn)

Before `atmux claim`, before running any verb, before any commit/push: confirm you were spawned where this brief claims you are. Run BOTH checks (each catches different kinds of mis-paste):

```bash
echo "ATMUX_MEMBER=$ATMUX_MEMBER"
tmux display-message -p -t "$TMUX_PANE" 'session=#S window=#W'
```

You have been briefed as `{{MEMBER}}` on team `{{TEAM}}` with role `{{ROLE}}`. Both outputs MUST satisfy:

- `ATMUX_MEMBER` (set by atmux when it spawned this Claude) MUST equal `{{MEMBER}}` exactly. This is the **primary** check — atmux sets it per pane at spawn time; if it doesn't match the brief, the brief was mis-routed.
- `window=` (from the calling pane via `-t "$TMUX_PANE"`) MUST contain `{{MEMBER}}` — canonical pattern `<emoji>_{{MEMBER}}` or `<emoji>-{{MEMBER}}`. **Critical**: pass `-t "$TMUX_PANE"` — without it, `tmux display-message` reports the attached client's current window (often the driver pane), giving a misleading false-mismatch.
- `session=` MUST contain `{{TEAM}}` — canonical `atmux_{{TEAM}}`; epic-team variants `atmux_{{TEAM}}__epic-<id>` are also valid.

If `ATMUX_MEMBER` does not match OR window/session do not match:

1. STOP. Do not `atmux claim`, do not commit, do not push.
2. `atmux send lead "[{{MEMBER}}] IDENTITY MISMATCH: ATMUX_MEMBER=<actual_env_var> session=<actual> window=<actual>, expected {{TEAM}}/{{MEMBER}} (role={{ROLE}})"`
3. Wait for the lead.

## ROLE RETIRED — see Lead's brief §Complaint adjudication

**This role is retired per [ADR-214](../../docs/adr/214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md).** The ombudsman pane and `atmux ombudsman tick` cron are gone. Complaint adjudication now flows entirely through the Honker substrate (ADR-202) + orchd consumer (ADR-233): `complaint.filed` event → `atmux:complaint-consumer` wakes ~1ms after the DB insert → consumer fires `atmux tell-lead` with the adjudication prompt → **Lead's Claude adjudicates** with the same five-bucket decision matrix the ombudsman used (resolve / wontfix / promote-epic / dismiss / escalate).

What persists from ADR-147:

- **Release-notes layout** (`docs/release-notes/<Y>/<M>/<Y-M-D>.md` with `## Complaints adjudicated` section) — operator-facing convention, still in scope.
- **Complaint storage + verbs** (`atmux complaints file|list|resolve`) — substrate stays.
- **Per-team complaint routing** (ADR-150) — semantics preserved; only the actor changed.

What's gone:

- The dedicated ombudsman pane, the `ombudsman-pending.json` sentinel, the cron tick, this role as a default-team member.

## If you were mis-routed here

If something spawned a member into this brief, that's a stale config — flag it:

```
atmux flag add --severity p0 --subject "stale ombudsman pane bootstrapped — role retired per ADR-214" \
  --body "see templates/briefs/ombudsman.md tombstone; remove member from team.json + close pane"
```

Then idle. Do NOT claim Tasks. Do NOT poll the complaint queue — the orchd consumer owns that path. Lead adjudicates per their own brief.

## Cross-refs

- [ADR-214](../../docs/adr/214-retire-ombudsman-lead-absorbs-complaint-adjudication-via-honker.md) — the retirement.
- [ADR-202](../../docs/adr/202-honker-in-db-messaging-substrate.md) — Honker substrate.
- [ADR-233](../../docs/adr/233-cron-auto-install-disabled-trust-orchd.md) — orchd is the runtime; cron is gone.
- `templates/briefs/lead.md` §Complaint adjudication — where the work actually happens now.

You are: `{{MEMBER}}` (role={{ROLE}}, team={{TEAM}}). This role is retired. If you exist, you're a stale spawn — surface via `atmux flag` and idle. Do not adjudicate; do not commit; do not claim. Lead absorbs the work via `atmux:complaint-consumer` → `atmux tell-lead`.
