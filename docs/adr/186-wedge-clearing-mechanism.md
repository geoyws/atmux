# ADR-186: Unified wedge-clearing mechanism — doctor probe library + sentinel runner + `atmux wedges` verb + tiered auto-clear

**Status**: Accepted — ratified by driver 2026-05-21 (3 extensions: doctor probe-class registry + sentinel auto-file pass + `atmux wedges` operator verb; no new cockpit-tier member; tiered auto-clear; §OQ recommendations as-written)
**Date**: 2026-05-19
**Driver-ref**: 2026-05-19 05:45 MYT driver mechanism audit (EPIC e-35dd6274). Five wedges discovered in 1h of manual driver investigation, ~70 lines of orphan crontab hand-cleaned, 1 silent committer/gitter death undetected for hours. Operator: "we need a wedge clearing mechanism."
**Relates**: ADR-027 (doctor self-diagnostics — probe substrate this ADR extends), ADR-132 / ADR-158 (sentinel — observe-pass runner that invokes wedge probes), ADR-140 (cheap-model-first — wedge clearing is mechanical; fits sentinel/cursor scope), ADR-077 + ADR-132 §Amendment 2026-05-19 (medic vs sentinel scope boundary — wedge classification depends on this boundary), ADR-091 (EPIC-done flow — sub-Task fan-in shape), ADR-090 (epic-team lifecycle — orphan-cron + missing-viewer + husk-worktree probes target known failure modes here), ADR-208 (deploy-completeness probe-class — sibling probe-class precedent; the `code-shipped-not-wired` class here generalizes ADR-208's deploy-completeness pattern across all wedge classes), ADR-150 (cross-team complaint storage — future cross-team wedge correlation channel), ADR-178 (test-cage leak reaper — sibling out-of-process reaper pattern; backup-before-destructive convention borrowed from here), ADR-184 (host-wide epic-team cap — wedge meta-cluster is a precondition for tightening the cap intelligently).

## Context

Every wedge filed in the last 7 days shares the same four-piece shape:

1. **Detection** = an invariant that can be expressed as a `doctor` probe (orphan crontab line, defaulSentinel missing in a cockpit JSON, husk worktree with no live cage, partial-dissolve state file, missing-viewer window in a parent session, etc.).
2. **Loop runner** = sentinel already iterates every 270s per ADR-132 §D5; the cron backstop already exists for sentinel itself per the t-e84a1dff installer extension.
3. **Auto-file** = `atmux task add` already accepts arbitrary body + lane + priority + deps; probes need a single helper to dedup and create.
4. **Auto-clear** = destructiveness varies per probe class — orphan-cron is safe to remove; rotate-pane needs confirm; missing-viewer is an installer-class auto-fix.

Manual handling has cost ~30 min per filing + ~30 min per surface + N rounds of driver intervention. Bundling = one EPIC (e-35dd6274), one ADR (this one), one fan-in, reusable across all current + future wedges. Without the mechanism, the wedge backlog grows faster than the team can drain it manually — five filings in 1h of audit today is the canonical evidence.

Today's silent gitter/committer death — TUI wedged but process alive; no `✻` activity, no commit since N hours, no operator response — went uncaught for hours specifically because no probe owned "pane-death detection." The medic vs sentinel boundary §Amendment landed in the same wave (ADR-077 + ADR-132) clarifies which side owns this probe class going forward; **this ADR is what surfaces the probe at all**.

## Decision

Build the wedge-clearing mechanism as **three extensions to existing infrastructure**, not a new cockpit-tier member:

1. **Doctor probe-class registry** (`src/core/doctor-probes/`) — typed registry of probe classes, each one a pure function returning a list of findings plus a stable fingerprint.
2. **Sentinel observe-pass invokes the probe registry** with `autoFile=true` — folds into ADR-132 §D5 tick (T4 of EPIC e-35dd6274).
3. **`atmux wedges`** operator verb — read + clear surface (`list`, `show`, `clear --tier <t>`, `resolve <task-id>`).

### Probe-class registry contract

```ts
type WedgeProbe = {
  id: string;                                  // stable, kebab-case (e.g. "orphan-cron", "missing-viewer")
  severity: "p0" | "p1" | "p2" | "p3";         // routes Task priority + escalation
  tier: "safe" | "fix" | "suggest" | "surface";// routes auto-clear policy (see below)
  describe: (finding: Finding) => string;       // Task subject + body summary
  fingerprint: (finding: Finding) => string;    // stable key for dedup (see below)
  suggestResolution: (finding: Finding) => string; // human-actionable text (CLI invocation, file path)
  probe: () => Promise<Finding[]>;             // pure-ish scan returning current findings
};
```

Probe classes shipped in T2:

| Probe id              | Tier    | Severity | Trigger                                                                   |
| --------------------- | ------- | -------- | ------------------------------------------------------------------------- |
| `orphan-cron`         | safe    | p2       | crontab line references `ATMUX_DIR=<path>` where path no longer exists    |
| `husk-worktree`       | safe    | p2       | `.atmux/worktrees/<m>/` with no `state.db` entry + no live cage           |
| `missing-viewer`      | fix     | p1       | epic-team spawned into running parent but viewer window absent            |
| `default-sentinel`    | fix     | p2       | cockpit JSON missing sentinel block but project has `sentinel.enabled`    |
| `pane-death`          | suggest | p1       | claude TUI alive but no `✻` activity + no commit in `staleMin` window     |
| `partial-dissolve`    | safe    | p2       | `dissolve-epic` half-completed (state file present, worktree gone or vv.) |
| `code-shipped-not-wired` | suggest | p1    | named-function exists in branch but no caller / no installer entry        |

This registry is **open** — additional probes register via `registerProbe(p: WedgeProbe)` at module-init time. The cluster meta-probe (T8) reads `id` to bucket findings.

### Dedup fingerprint contract

For each finding `f` from probe `p`:

```
fp = sha256(p.id + "|" + p.fingerprint(f))
```

When auto-filing a Task, `atmux doctor --auto-file` writes the marker `auto-filed:<p.id>:<fp.slice(0,12)>` into the Task body's first line. Subsequent runs grep open kanban Tasks (status ∈ {todo, in-progress, blocked}) for the marker; if present, **skip filing** — the finding is already represented. Once the Task closes (status → done), the marker no longer matches and a fresh occurrence files a new Task.

`fingerprint(f)` MUST be stable across runs for the **same underlying defect**. Examples:

- `orphan-cron`: hash the crontab line verbatim (one line = one defect).
- `husk-worktree`: hash the worktree path (one path = one defect).
- `missing-viewer`: hash `<parent-session-id>:<epic-id>` (one missing viewer per epic per parent).
- `pane-death`: hash `<team-name>:<member-name>` (one pane per member; transient flap is fine — Task lifecycle handles it).

### Tiered auto-clear policy

Per global CLAUDE.md §"Executing actions with care" destructive-actions rule, every probe declares one of four tiers; the tier dictates what `atmux wedge clear` is willing to do without operator confirmation:

| Tier      | Authority                          | Examples                                            | Cron cadence |
| --------- | ---------------------------------- | --------------------------------------------------- | ------------ |
| `safe`    | Auto-clear without confirm         | `orphan-cron`, `husk-worktree`, `partial-dissolve`  | Every 6h     |
| `fix`     | Auto-apply installer-class repair  | `missing-viewer`, `default-sentinel`                | Every 6h     |
| `suggest` | Write proposal to Task body; wait  | `pane-death`, `code-shipped-not-wired`              | Surface only |
| `surface` | Read-only — never clear            | Meta-probes (cluster detection per T8)              | Daily        |

Operator path for `suggest` tier: review Task body, run `atmux wedge resolve <task-id> [--apply | --reject]`. `--apply` performs the suggested resolution (which may itself be a `safe`/`fix` action); `--reject` closes the Task with `note: "rejected: <reason>"` and adds the fingerprint to a 7-day suppression list so the same defect doesn't immediately re-file.

### Backup-before-destructive convention

Every `safe`/`fix` action writes a backup to `/tmp/wedge-clear-backup-<unix-ts>/<probe-id>/<fp.slice(0,12)>.json` before mutating state. Schema:

```jsonc
{
  "probeId": "orphan-cron",
  "fingerprint": "<12-char fp>",
  "tier": "safe",
  "timestamp": "2026-05-19T06:00:00Z",
  "before": "<crontab line | file contents | state-blob>",
  "action": "<one-line description>",
  "taskId": "t-xxxxxxxx"
}
```

Retention: `/tmp/wedge-clear-backup-*` directories older than 7 days are unlinked by the same `*/6h` cron that fires the clear pass. Operator who wants longer retention copies them out manually. This matches the test-cage leak-reaper (ADR-178) convention — out-of-process state, simple file layout, no schema migrations.

### `atmux wedges` operator surface

```
atmux wedges                        # list open wedge Tasks grouped by probe-id + severity
atmux wedges show <task-id>         # full Task body + finding + suggested resolution
atmux wedges clear --tier <t>       # idempotently apply tier-allowed clears (safe|fix)
atmux wedges resolve <task-id>      # operator-driven path for suggest tier (--apply | --reject)
atmux wedges --json                 # cockpit-dashboard-friendly output (t-351318dc)
atmux wedges --resolved             # audit closed wedges (cleanup metrics + recurrence trends)
```

Output stable enough to grep + parseable as JSON (acceptance criterion from EPIC body).

## Rationale

### Why extend doctor, not build a parallel scanner

Doctor (ADR-027) already owns the "invariant check" semantics; every existing probe (`atmux doctor` code-class / lint / test-class) fits the same `id + describe + severity` shape. Adding wedge probes alongside them keeps one substrate, one cron, one runbook — and `atmux doctor` already has the cockpit + lead surfaces wired. A parallel scanner would duplicate every one of those wiring points.

### Why sentinel owns the loop, not medic

Per ADR-077 + ADR-132 §Amendment 2026-05-19, sentinel owns pane-liveness + mechanical-nudges + member-state observation; medic owns code/test/lint/build/schema health. Wedge probes split across both: `pane-death` is sentinel-side, `code-shipped-not-wired` is medic-side. But the **runner** (the per-tick "iterate every team + invoke registered probes") is sentinel's loop already — adding a `runDoctor({ classes: [...wedge], autoFile: true })` call to the existing observe-pass is one line, vs. a separate medic-side loop that would need its own cadence + escalation channel + cron backstop. Findings still route to the correct owner via Task lane (medic-flavored probes file lane=be/dba; sentinel-flavored file lane=ops).

### Why NOT a new cockpit-tier member

Considered + rejected. The cockpit already has 3 tiers (superdriver W1, medic W2, sentinel W3 per ADR-135). A W4 "wedge-clearer" would (a) need its own brief + role + spawn semantics, (b) duplicate sentinel's per-team iteration with a different cadence, and (c) require operators to learn a new word for what is structurally just "doctor + sentinel doing more." The cheap-model-first principle (ADR-140) explicitly favors mechanical extension of existing roles over new role types when the work fits.

### Why tiered, not one-size-fits-all auto-clear

The destructive-actions rule in global CLAUDE.md is non-negotiable. Treating `orphan-cron` removal the same as `pane-death rotate` would force every clear to require operator confirm (paralysing the safe-tier majority) OR allow every clear to run without confirm (eventually clobbering legitimate state). Four tiers map cleanly to the destructiveness axis: `safe` (purely cleanup), `fix` (installer-class — re-establishes documented state), `suggest` (operator judgment), `surface` (read-only diagnostic). Operators don't have to remember which probes are dangerous; the tier declaration in the registry encodes it.

### Why fingerprint dedup, not Task-body diff matching

Open kanban already has lifecycle semantics — todo/in-progress/blocked all mean "this defect is still active." A 12-char fingerprint marker in the Task body is grep-cheap (one `atmux task list --status open` plus a single regex per finding) and avoids the more complex problem of Task-body fuzzy-matching. Once the Task closes, the marker stops matching — fresh occurrences re-file as intended.

### Why backup before destructive

Same rationale as the `feedback_git_checkout_clobbers_merge` memory: irreversible operations that "should be safe" recover ~10× faster when there's a literal copy of the pre-state on disk. `/tmp/wedge-clear-backup-<ts>/` is cheap, ignored by every backup/snapshot system, and self-cleans on cron cadence.

## Out of scope

- **New cockpit-tier member dedicated to wedge-clearing** — rejected per §Rationale. Sentinel covers observe-pass; cron covers backstop; `atmux wedges` covers operator surface. No new pane class needed.
- **LLM-based wedge classification** (e.g. asking claude to read a pane-capture and decide "is this a wedge?") — defer. v1 is mechanical probe-class registry; every probe is a deterministic invariant check. LLM judgment fits cheap-model-first only if invariants prove insufficient, which 7 named probe classes is enough evidence against today.
- **Cross-team wedge correlation** (e.g. "atmux-team probe finding correlates with sopx-team probe finding") — defer to ADR-150 cross-team complaint storage if/when surfaced. v1 scope is per-host, per-project: probes scan the host-level state (crontab, `~/.atmux/`, all project worktrees) but file Tasks into the owning project's kanban.

## Consequences

### Positive

- 5+ wedge classes detected today + 4 currently-open wedge Tasks (t-186d5910, t-c9c86d1e, t-2183f488, t-3fa47ace) become regression-pins instead of recurring driver-intervention costs.
- Meta-probe `wedge-cluster` (T8) surfaces "code-shipped-not-wired" pattern proactively — would have caught today's `feat(velocity-gate)` eb97ea6 wiring gap before driver noticed manually.
- Cron backstop (T5) fires independent of sentinel uptime; today's situation (sentinel cron block was the issue) is impossible by construction.
- `atmux wedges` operator dashboard is one verb to learn — replaces "remember which doctor flag to run + which cleanup script to invoke" lookup tax.

### Negative

- New probe-class registry adds ~7 typed-function units + their fixtures (~500 LoC at T2 estimate). Maintenance burden scales with probe count.
- Wedge Tasks land in regular kanban — risks crowding planner / lead views if probes false-positive. Mitigations: severity routing, suppression list (resolve --reject), 7-day suppression default.
- Sentinel tick gets ~50-200ms longer per team (probe substrate invocation). Acceptable at 270s cadence; revisit if probe count grows past 20.

### Migration / rollout

- T1 (this ADR) is the only blocking deliverable for the EPIC sub-task fan-in pattern (ADR-091 §EPIC-done) — T2-T9 reference §Decision verbatim.
- T6 `--tier safe` ships before `--tier fix` so the larger blast-radius gates land second with more soak time.
- Cron backstop (T5) ships in `atmux up` installer — operators on older `atmux up` versions miss the backstop until next install; this is acceptable (sentinel observe-pass still fires the probes via T4).
- Reviewer flips status proposed → accepted in the same wave as the EPIC fan-in commit, per ADR-091 §EPIC-done #4 (trunk-signoff at `docs/reviews/t-73128937-trunk-signoff-<date>.md`).

## Cross-refs

- ADR-027 §Decision — doctor probe substrate; this ADR extends with the wedge probe class.
- ADR-132 §D5 + §Amendment 2026-05-19 — sentinel observe-pass cadence + boundary with medic.
- ADR-140 §Decision — cheap-model-first; wedge clearing is mechanical fitting sentinel/cursor scope.
- ADR-091 §EPIC-done — fan-in flow for T1-T9 sub-Tasks.
- ADR-090 §Decision — epic-team lifecycle; missing-viewer + husk-worktree + partial-dissolve probes target known lifecycle seams.
- ADR-208 §Decision — deploy-completeness probe-class precedent (sibling pattern; the `code-shipped-not-wired` probe in this ADR is the generalization of ADR-208's specific probe across all wedge classes per the same probe-class registry contract). (Renumbered from 183 → 208 per 183-collision-resolution 2026-05-21.)
- ADR-178 §Decision — out-of-process reaper convention (sibling pattern; this ADR borrows the backup-on-clear discipline).
- ADR-184 §Decision — host-wide epic-team cap; wedge meta-cluster (T8) is a precondition for tightening the cap intelligently (knowing which projects leak before forcing dormancy reap).
- ADR-150 §Decision — cross-team complaint storage (deferred extension channel for cross-team wedge correlation).
- EPIC e-35dd6274 — body holds T1-T9 sub-task decomposition + acceptance matrix; this ADR is T1.
- t-73128937 — this Task.
- Wedge regression-pins (auto-close when T2-T6 land): t-186d5910 (sentinel deploy), t-c9c86d1e (dissolve-epic cron leak), t-2183f488 (spawn-epic missing viewer), t-3fa47ace (defaultSentinel).
