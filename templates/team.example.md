# team.example.json — per-member model selection

The shipped template now carries the three-driver floor from ADR-239/ADR-288:
`driver`, `driver-2`, `driver-3`. The later worker-left / attention-right
pair contract is defined in `src/core/drivers.ts`. This template stores the
canonical pair explicitly, and callers resolve the same fresh canonical preset
through `resolveDriverPair(team)` when older configs omit `driverPair`. The
attention pane keeps `command: null` by default so it starts as an interactive
shell unless a later slice deliberately wires auto-launch in.

Companion notes for `team.example.json`. The schema field `.members[].model`
exists today (read by `lib/start.sh`, propagated by `lib/tui.sh` as
`claude --model <id>`). This file documents which value to set per role
and why.

## Per-role model assignment (per ADR-024 revised)

| Role          | Model                | Rationale                                                                  |
|---------------|----------------------|----------------------------------------------------------------------------|
| `lead`        | Opus (`default`)     | Coordination + dispatch + rotation = heavy multi-decision judgment         |
| `planner`     | Opus (`default`)     | Decomposition + ADR authorship + tradeoff weighing                         |
| `be-kanban`   | Opus (`default`)     | Writing code, designing tests, debugging                                   |
| `fe-kanban`   | Opus (`default`)     | Same                                                                       |
| `test-kanban` | Opus (`default`)     | Same                                                                       |
| `gitter`      | Opus (`default`)     | Commit composition + lint-staged-trap edge cases + scope-check             |
| `reviewer`    | Opus (`default`)     | Audit-bar judgment on others' work (exhaustive grep + class-widening)      |
| `unblocker`   | Opus (`default`)     | `/team clear` blast-radius + classify-and-route on others' work            |
| `auditor`     | Opus (`default`)     | Exhaustive-grep + verdict pattern on already-committed code                |
| `discorder`   | **`claude-sonnet-4-6`** | Pure narrative formatter; writes Discord pings only; no judgment-on-correctness |

`discorder` is the **only** Sonnet team member — narrowed from the v1 four-role
proposal (reviewer / discorder / unblocker / auditor) per decision **d-c3f8d980**
which superseded **d-a26b4211**. The Sonnet-fit criterion is *read-and-summarise
WITHOUT judgment-on-correctness*; reviewer / unblocker / auditor all make
consequential calls on others' work and stay on Opus.

The `lib/llm-judge.sh` helper (Sonnet `claude --print` invocation called from
`lib/whip.sh` SOFT-tier path per ADR-023) is **not** a team member — no
`.members[]` entry, no spawn pane, no rotate. Its Sonnet usage is part of
ADR-023's design, not ADR-024.

## Field semantics

### `.members[].claudeAccount` (per ADR-094)

Per-member Claude config-dir isolation. Optional — when set, the spawned
shell exports `CLAUDE_CONFIG_DIR=<HOME>/.claude-<value>` so the member's
nested `claude` invocations inherit an account-isolated config tree (no
cross-OAuth, no fresh-spawn re-auth dance).

Valid values:

- `"default"` (or field absent) — host default config dir. The member's
  TUI reads Claude's standard `$HOME/.claude` directory.
- `"personal"` / `"icloud"` / `"ifca"` / `"unum"` — common operator
  suffixes; the spawn prefixes `CLAUDE_CONFIG_DIR=$HOME/.claude-personal`
  (etc.). These are conventions, not a closed enum.
- Any custom suffix — e.g. `"work-2"`, `"client-acme"`. Operators
  maintain the corresponding `$HOME/.claude-<suffix>` dir out-of-band
  (typically copy + re-auth via `claude login`).

Refs: ADR-024 spawn-account-matching · ADR-094 c-alias spawn convention.

### `.members[].model`

The `.members[].model` field accepts:

- `"default"` (or field absent) — claude CLI default. Currently Opus via the
  global `CLAUDE_CODE_EFFORT_LEVEL=xhigh` env; teammates inherit `xhigh` effort.
- `"claude-opus-4-7"` / `"claude-sonnet-4-6"` / `"claude-haiku-4-5-20251001"` /
  any future model ID — passed verbatim as `claude --model <id>`. Sonnet
  members still inherit `xhigh` effort (read-only roles benefit from full
  reasoning depth even on the smaller model).

## Override workflow

To flip a member's model after the team is already running:

```bash
# Edit team.json
jq '(.members[] | select(.name == "discorder") | .model) = "claude-sonnet-4-6"' \
  .atmux/team.json > .atmux/team.json.new \
  && mv .atmux/team.json.new .atmux/team.json

# Re-spawn the member with the new model
atmux rotate discorder
```

`atmux rotate <member>` reads the updated field and re-launches the pane with
the new `--model` flag. If the running session is mid-work, defer the rotate
to the next natural cycle — the model change isn't urgent enough to interrupt
in-flight work.

## Reversibility

HIGH. Driver may flip `discorder` back to Opus (or any role to a different
model) with one `jq` edit + one `atmux rotate <name>`. No schema migration,
no data loss, no in-flight task disruption.
