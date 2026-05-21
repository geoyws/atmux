# ADR-208: Deploy-completeness probe class — extends ADR-027 doctor framework

> **Renumber note (2026-05-21):** Originally filed as ADR-183 (commit `94eb4ca` 2026-05-20 11:06 MYT — `batch land 178/183/184/185/188/190/191/192`). Collided with the earlier-filed `183-sentinel-scope-includes-epic-teams.md` (commit `3b92c9d` 2026-05-20 03:53 MYT). Per the "older keeps the number" convention (memory `project_adr_collision_resolutions_2026_05_18`), the sentinel-scope ADR retains 183; this ADR is renumbered to 208. All cross-refs in the rest of the tree were updated in the same commit.

**Status**: Accepted — ratified by driver 2026-05-21 (deploy-completeness probe-class extends ADR-027; §OQ recommendations as-written: programmatic TS registry, file-based Discord dedup per ADR-126, 15min cron backstop hardcoded, --fail-on-gap = P0+P1 only, name=deploy-completeness, sentinel uses own severity mapping, --list-probes covers introspection)
**Date**: 2026-05-19
**Driver-ref**: driver-inbox P1 2026-05-19 04:25 MYT — "3 confirmed wedges in 30min audit + 5+ open all share root cause: code shipped, tests green, deploy-side wire-up never lands". EPIC `e-b54050b6` (deploy-completeness probe class) Part A `t-e26aced0`. Lead confirmed ADR number 183 in turn 2026-05-19 14:44 MYT (implicit confirmation via "178 + planner sidebar reservations" framing).
**Extends**: ADR-027 (`atmux doctor` framework — probe registry + severity ladder). This ADR adds the **probe-class concept** as a first-class organizing principle within ADR-027's substrate. No supersession; ADR-027 gains a thin §Amendment cross-referencing this ADR.
**Relates**: ADR-132/158 (sentinel — Part B integration), ADR-182 (sentinel scope extension — widened scope inherits the doctor-class call), ADR-184 (host-cap registry — sibling defense-in-depth probe surface), `e-f2d7c7a5` (sentinel-deploy — one probe in this class is the regression-pin), `e-db13ac01` (dissolve-cron-leak — another regression-pin).

## Context

Every wedge filed in the 7 days leading to 2026-05-19 fits one shape:

1. ADR designs surface X (a verb, a cron line, a cockpit window, a state-file schema).
2. Worker ships code + paired tests for X.
3. Reviewer signs off + commit lands.
4. Operator runs `atmux <something>` — surface X works locally, tests green.
5. **The deploy-side wire-up never lands** — cockpit rebuild never installs the new window; `atmux start` never inserts the new cron line; `atmux up` never runs the new migration trigger.
6. Surface X sits dark in source. The wedge is invisible until something else breaks weeks later, at which point the operator realizes "wait, we shipped that — why isn't it running?"

Recent concrete instances:

| Wedge | Code-shipped | Deploy-never-wired |
|---|---|---|
| `t-c9c86d1e` dissolve-epic cron leak | dissolve-epic verb removes worktree + cockpit row | `atmux start` cron block install was never paired with `atmux team dissolve-epic` cron block remove |
| `t-186d5910` sentinel never deployed | ADR-132/158 src/verbs/sentinel.ts + tests green 3 days ago | `atmux cockpit rebuild` never installs W3 window |
| `t-72f90a08` spawn-epic account inheritance | spawn-epic verb works | new epic-team's `team.json::claudeAccount` left empty → 401 on first claude pane spawn |

Three confirmed wedges + 5+ open all share the shape. The team has shipped enough code to reach this failure mode systemically. Catching the class — not the individual wedges — is the right level to intervene.

## Decision

### Probe class as first-class concept

Extend ADR-027's doctor framework: probes group into **classes**. A class is a named set of probes that share invocation semantics + escalation policy. v1 ships one class — `deploy-completeness` — and reserves the namespace for future classes (`network`, `state-integrity`, `auth`, etc.).

CLI surface:

```
atmux doctor [--class <name>] [--list-probes] [--list-probes --by-class] [--fail-on-gap] [--json] [--quiet]
```

| Flag | Effect |
|---|---|
| `--class <name>` | Run only probes in this class. Default: run all probes. |
| `--list-probes` | Enumerate registered probes (id + severity + class + 1-line desc). |
| `--list-probes --by-class` | Same as above grouped + sorted by class. |
| `--fail-on-gap` | Exit non-zero on any P0/P1 fail (vs current default of exit-0-with-report). Used by cron backstop. |
| `--json` | Machine-readable output. |
| `--quiet` | Suppress per-probe stdout; emit only summary (used by cron backstop). |

### `deploy-completeness` v1 probe roster

Each probe maps 1:1 to a documented surface ADR-promised. Severity follows ADR-027's existing ladder (P0 blocks fleet; P1 blocks team; P2 surfaces warning; P3 informational).

| Probe id | Class | Severity | Checks | Regression-pin for |
|---|---|---|---|---|
| `cockpit-has-w3-sentinel` | deploy-completeness | P1 | `cockpit.json::sessions[]` contains `sentinel` AND `tmux -L atmux-cockpit list-windows` includes `_sentinel` | `t-186d5910` / `e-f2d7c7a5` |
| `cockpit-has-w2-medic` | deploy-completeness | P1 | same shape for `_medic` | ADR-077/133 ship |
| `sentinel-state-fresh` | deploy-completeness | P2 | `~/.atmux/state/sentinel-state.json` exists AND `mtime > now - 600` (10 min) | sentinel-tick-stuck class |
| `dissolve-epic-cron-clean` | deploy-completeness | P1 | every `# >>> atmux:team=<eid>` block in crontab has live `ATMUX_DIR` worktree | `t-c9c86d1e` / `e-db13ac01` Part A |
| `spawn-epic-account-inherited` | deploy-completeness | P0 | every live epic-team `team.json::claudeAccount` field is non-empty AND maps to a known account in `~/.claude-*/` | `t-72f90a08` |
| `epic-teams-not-stranded` | deploy-completeness | P2 | `atmux team sweep-epics --json` returns 0 `SAFE-DISSOLVE` candidates (asserts auto-reaper is firing) | `e-db13ac01` Part B |
| `cron-no-acme-fixture` | deploy-completeness | P3 | crontab has no `atmux:team=acme` / `atmux:team=new` / `atmux:team=test-*` blocks (fixture leakage) | fixture-cleanup regression class |

Operators add new probes by extending the registry (`src/core/doctor-registry.ts` or equivalent) — same pattern ADR-027 established. Adding a probe to `deploy-completeness` requires:

- Probe id (kebab-case; unique).
- Class assignment (`class: 'deploy-completeness'`).
- Severity (`P0` | `P1` | `P2` | `P3`).
- Pure-function implementation (cheap shell-out or filesystem read; no network).
- 1-line description (shown in `--list-probes`).
- Regression-pin link (Task ID or ADR §reference) — documented in the probe's source comment.

### Sentinel observe-pass bridge

Per `e-b54050b6` Part B (`t-c5116509`): sentinel's per-tick observe step invokes `runDoctor({ class: 'deploy-completeness', json: true })` and short-circuits the rest of the observe pass with `escalate-to-claude-lead` on non-zero fails. Surfaces deploy gaps within one sentinel cadence (270s).

Cross-tier coordination with ADR-182: post-ADR-182, sentinel iterates both parent teams + epic-teams. The doctor probes are fleet-wide (not per-team), so each sentinel tick re-asserts the same probe set regardless of which team is observed. Cheap (filesystem + crontab reads).

### Cron backstop (sentinel-independent)

Sentinel-independent defense-in-depth — covers the case where sentinel itself isn't deployed (the meta-irony of the original failure mode):

```cron
# Installed by atmux up bootstrap
*/15 * * * * /usr/local/bin/atmux doctor --class deploy-completeness --fail-on-gap --quiet >> ~/.atmux/state/doctor-deploy.log 2>&1 || /usr/local/bin/atmux discord-notify p1 "deploy-gap detected: see ~/.atmux/state/doctor-deploy.log"
```

Cadence: 15min. Dedup: Discord-ping fires once per gap-signature per 24h (state in `~/.atmux/state/doctor-deploy-ping.json`). Installer lives in `atmux up` (the one-shot bootstrap any operator runs) so the backstop deploys itself transitively.

### Severity → action mapping

| Severity | Cron-backstop action | Sentinel-tick action |
|---|---|---|
| P0 | Discord ping (immediate); audit-log to `~/.atmux/state/doctor-deploy.log` | `escalate-to-claude-lead` with `kind: 'p0-deploy-gap'` |
| P1 | Discord ping (deduped 1/24h); audit-log | `escalate-to-claude-lead` with `kind: 'p1-deploy-gap'` |
| P2 | Audit-log only; no Discord | observe verdict, no escalation |
| P3 | Audit-log only; no Discord | no-op |

P0 gaps surface immediately (account-inheritance is the only v1 P0; broken auth blocks the whole epic-team). P1 gaps dedupe but surface within 15min (cockpit-window-missing, cron-leak). P2/P3 are log-only.

## Consequences

| Lane | What changes |
|---|---|
| **be** | New `src/core/doctor-class.ts` — probe-class registry abstraction extending ADR-027's existing probe-registry shape. ~80-120 LOC. |
| **be** | 7 probe implementations in `src/core/doctor-probes/deploy-completeness/*.ts`. ~30-60 LOC per probe + paired test. |
| **be** | `src/verbs/doctor.ts` gains `--class` + `--list-probes` + `--list-probes --by-class` + `--fail-on-gap` + `--quiet` flags. |
| **be** | Sentinel observe-pass extension (`e-b54050b6` Part B) — invokes `runDoctor({class: 'deploy-completeness'})` per tick. |
| **be** | Discord-notify wrapper for cron backstop — dedup via `~/.atmux/state/doctor-deploy-ping.json`. |
| **ops** | `atmux up` installs the */15 cron line; `atmux down` (or stop) prunes idempotently. |
| **test** | 7 probe unit tests + integration test for cron-backstop end-to-end + snapshot test for `--list-probes --by-class` output stability. |
| **docs** | NEW `docs/RUNBOOK-doctor-probes.md` — §probe classes / §deploy-completeness table / §Discord-ping policy + dedup / §operator runbook (probe-fail → fix recipe). ADR-027 §Amendment cross-referencing ADR-183. CHANGELOG + planner brief pointer. |

**Forward enablement**:

- Future probe classes (`network`, `state-integrity`, `auth`) plug into the same `doctor-class.ts` registry without further ADR work.
- Sentinel + cron-backstop bridges generalize — adding a new class to the sentinel call requires only adding the class name to the call site.
- ADR-184 host-cap can add probes like `host-cap-not-exceeded` (P0) to a sibling `host-integrity` class once that ADR ships impl.

**Rollback**:

- Drop the `--class` flag + revert sentinel observe-pass + remove the cron line. Probes themselves stay registered (no harm idle) but are not invoked from any bridge.
- Per-probe disable via `team.json::doctor.disabledProbes[]` (operator-gated; default empty).

## Open questions

1. **OQ1 — Probe registration: declarative (probe.json) or programmatic (TypeScript registry)?**
   - Default: **programmatic TypeScript registry**. Each probe is a TS function exported from `src/core/doctor-probes/<class>/<id>.ts` + auto-discovered by class. Cheaper than maintaining a parallel probe.json; the probe-id + severity + class metadata travel with the impl. No new schema surface.
   - Reversibility: medium — migrating to declarative later requires touching every probe.

2. **OQ2 — Discord dedup state: file (`~/.atmux/state/doctor-deploy-ping.json`) or state.db?**
   - Default: **file (`~/.atmux/state/doctor-deploy-ping.json`)** per ADR-126 fallback convention. Dedup writes are O(N) per cron-tick (low contention) + survive state.db migrations independently. Mirror of the host-cap registry's choice in ADR-184.
   - Reversibility: medium.

3. **OQ3 — Cron backstop cadence: 15min default — tunable?**
   - Default: **15min hardcoded in `atmux up` installer**; operator edits crontab directly to tune. No `host-config.json::doctor.cronCadence` knob in v1 — the cadence is conservative + balances signal latency vs cron noise. Adding a knob is cheap if operators need it.
   - Reversibility: low.

4. **OQ4 — `--fail-on-gap` semantics: P0+P1 fails, or all severities?**
   - Default: **P0 + P1 only**. P2/P3 are surface-and-watch; treating them as "gaps" inflates Discord noise. `--fail-on-gap-strict` reserved for a future P2-inclusive mode if operators want it.
   - Reversibility: low.

5. **OQ5 — Probe-class names: `deploy-completeness` (verbose) vs `deploy` (terse)?**
   - Default: **`deploy-completeness`** — names a property, not an action. Reads cleanly in `atmux doctor --class deploy-completeness`. Future sibling classes (`state-integrity`, `auth-completeness`) follow the same shape.
   - Reversibility: low — alias via shell completion if shortening desired.

6. **OQ6 — Sentinel ALSO calls `--fail-on-gap` semantics, or its own logic?**
   - Default: **sentinel uses its own severity mapping** (see §Severity → action mapping above). Cron-backstop uses `--fail-on-gap`; sentinel reads the full json + decides per-probe. Different surfaces, different policies — keeps the contract simple.
   - Reversibility: low.

7. **OQ7 — Should probe-class registry expose introspection via `atmux doctor --probes-of-class <name> --json`?**
   - Default: **`--list-probes --by-class` covers it.** Adding a separate flag is over-fitting. If a class has 30+ probes and `--list-probes` output becomes unwieldy, add a `--filter-by-class` later.
   - Reversibility: low.

## Sub-tasks

Already filed under `e-b54050b6` — see `t-e26aced0` (Part A: 7 probes), `t-c5116509` (Part B: sentinel observe-pass), `t-21fb9aef` (Part C: cron backstop), `t-ef08bcd0` (Part D: `--list-probes --by-class`), `t-21633ffa` (Part E: e2e), `t-179ca7d6` (Part F: docs). This ADR is the doc deliverable Part A ships; impl is documented in §Consequences.

## Acceptance

- [ ] ADR-208 file lands at `docs/adr/208-deploy-completeness-probe-class.md` (renumbered from 183 — see header note).
- [ ] `src/core/doctor-class.ts` probe-class registry abstraction extends ADR-027.
- [ ] 7 deploy-completeness probes registered + green against current hax state (post the wedge-fixes landing).
- [ ] `atmux doctor --class deploy-completeness --json` lists ≥ 7 probes + per-probe severity.
- [ ] `atmux doctor --list-probes --by-class` output stable + grep-able + snapshot-pinned in tests.
- [ ] Sentinel observe-pass invokes `runDoctor({class: 'deploy-completeness'})` per tick + escalates per severity ladder.
- [ ] Cron backstop installed by `atmux up` + idempotent install + prune.
- [ ] Synthetic gap (kill W3 _sentinel) detected within 15min + Discord ping fires (with mocked discord-send asserted).
- [ ] ADR-027 §Amendment cross-referencing ADR-183 lands same-commit.
- [ ] Reviewer signs off; status flip proposed → accepted after T5 e2e green.

## Out of scope

- Other probe classes (`network`, `state-integrity`, `auth`) — namespace reserved; v1 ships only `deploy-completeness`.
- Per-team probe overrides beyond `team.json::doctor.disabledProbes[]` opt-out.
- Real-time probe-fail dashboarding (web/TUI) — CLI + Discord suffice for v1.
- Auto-remediation of P0 gaps (operator-gated; doctor only surfaces, never auto-fixes per ADR-140 §judgment-stays-with-claude).
- Probe execution sandboxing — probes run with same privileges as `atmux doctor` invoker; defense-in-depth is operator-side (probes are atmux-team code, not user-supplied).

## Cross-refs

- ADR-027 (doctor framework — substrate this ADR extends; gains §Amendment cross-ref).
- ADR-132/158 (sentinel — Part B integration consumer).
- ADR-140 (cheap-model-first — probes are mechanical pass/fail, no claude judgment).
- ADR-126 (JSON fallback storage — Discord dedup state uses this convention).
- ADR-182 (sentinel scope extension — widened scope inherits the doctor-class call automatically).
- ADR-184 (host-cap registry — sibling defense-in-depth surface; future `host-integrity` class candidate).
- `e-b54050b6` (deploy-completeness EPIC — impl substrate; this ADR is the doc deliverable).
- `e-f2d7c7a5` (sentinel-deploy — `cockpit-has-w3-sentinel` regression-pins this Task's success).
- `e-db13ac01` (dissolve-cron-leak — `dissolve-epic-cron-clean` regression-pins this fix).
- Driver-inbox 2026-05-19 04:25 MYT (origin).
