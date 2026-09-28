# team.example.json — companion notes

Companion notes for `team.example.json`, the template `atmux init` copies.

## Roster: drivers-only by default (ADR-288 §D5)

The template ships `drivers[]` (three driver windows per ADR-239's
restored floor) and `members: []`. A fresh team spawns the superdriver
seat plus drivers, and nothing else — drivers work kb rows directly
(ADR-275), so no in-cage lead → planner → member loop runs.

The `lead` / `planner` / `reviewer` / generic `member` windows are
**deprecated, not removed**. `members[]` is the opt-in: a team that still
runs the lead → planner → member loop declares its members there and
they spawn exactly as before (lead first, then teammates). `atmux doctor`
renders a yellow `deprecated-member-windows` row for any team that
declares one or more members. Briefs for every declared role remain under
`templates/briefs/`. Lead-dependent verbs (`atmux tell-lead`,
`atmux rotate-lead`, and siblings) fail closed with their existing errors
on a drivers-only team — that is expected, not a config bug (ADR-288 §D6):
file the ask on the kb board instead.

## Canonical driver pair (ADR-288)

Later materializers consume one declarative pair source rather than
re-deriving the layout from runtime state. The canonical shape is:

- horizontal layout;
- worker pane on the left;
- attention pane on the right;
- attention is not a member;
- attention workflow = `kb-att`;
- attention authority = `decision-only`;
- attention `tui` / `command` default to `null` so the pane starts an
  interactive shell unless deliberately configured.

## Per-role model assignment for declared members (per ADR-024 revised)

Applies only to entries you declare in `members[]`.

| Role          | Model                | Rationale                                                                  |
|---------------|----------------------|----------------------------------------------------------------------------|
| `lead`        | Opus (`default`)     | Coordination + dispatch + rotation = heavy multi-decision judgment         |
| `planner`     | Opus (`default`)     | Decomposition + ADR authorship + tradeoff weighing                         |
| `reviewer`    | Opus (`default`)     | Audit-bar judgment on others' work (exhaustive grep + class-widening)      |
| `gitter`      | Opus (`default`)     | Commit composition + lint-staged-trap edge cases + scope-check             |
| `unblocker`   | Opus (`default`)     | `/team clear` blast-radius + classify-and-route on others' work            |
| `discorder`   | **`claude-sonnet-4-6`** | Pure narrative formatter; writes Discord pings only; no judgment-on-correctness |

`discorder` is the only Sonnet-fit member role (read-and-summarise
WITHOUT judgment-on-correctness, per decision d-c3f8d980); every role that
makes consequential calls on others' work stays on Opus.

## Field semantics

### `claudeAccount` (per ADR-094)

Per-entry Claude config-dir isolation on `members[]` and `drivers[]`.
Optional — when set, the spawned shell exports
`CLAUDE_CONFIG_DIR=<HOME>/.claude-<value>` so nested `claude` invocations
inherit an account-isolated config tree. `atmux init --claude-account
<suffix>` stamps every driver and every declared member with `<suffix>`;
`--claude-account default` strips the field so the schema default applies.
`bot.claudeAccount` is deliberately not stamped or stripped by the flag:
ADR-285 requires the bot account to be chosen explicitly in `team.json`
before automated offers are enabled, so a `bot` block carried over from
an older scaffold renders verbatim.

Valid values:

- `"default"` (or field absent) — host default config dir (`$HOME/.claude`).
- `"personal"` / `"icloud"` / `"ifca"` / `"unum"` — common operator
  suffixes; conventions, not a closed enum.
- Any custom suffix — e.g. `"work-2"`. Operators maintain the matching
  `$HOME/.claude-<suffix>` dir out-of-band (copy + `claude login`).

On a driver the value only takes effect when that driver sets a non-shell
`tui` (for example `claude`); `null`, absent, `shell`, `bash` and `zsh` never
reach the harness command resolver. The template ships `tui: null`, which
starts a plain zsh pane.

### `.members[].model`

- `"default"` (or field absent) — claude CLI default (Opus; teammates
  inherit `CLAUDE_CODE_EFFORT_LEVEL=xhigh`).
- Any model ID (`"claude-opus-4-7"`, `"claude-sonnet-4-6"`, and so on) —
  passed verbatim as `claude --model <id>`.

- `"default"` (or field absent) — claude CLI default. Currently Opus via the
  global `CLAUDE_CODE_EFFORT_LEVEL=xhigh` env; teammates inherit `xhigh` effort.
- `"claude-opus-4-7"` / `"claude-sonnet-4-6"` / `"claude-haiku-4-5-20251001"` /
  any future model ID — passed verbatim as `claude --model <id>`. Sonnet
  members still inherit `xhigh` effort (read-only roles benefit from full
  reasoning depth even on the smaller model).

### `.superdriver` (per ADR-296)

Top-level orchestration seat, not a `drivers[]` or `members[]` entry. Cage
window 1 (drivers shift to 2..N+1); no worktree, no branch — cwd is pinned
to the repo root. Runs `/sync-drivers` and coordinates across driver lanes.

- `"enabled": true` (or block absent) — seat is created. Explicit
  `{"enabled": false}` opts out and restores the old drivers-first layout.
- `"tui": null` (or absent) — plain zsh floor like nullable drivers;
  a non-null harness alias launches two-stage into the verified-idle shell.

## Override workflow

To flip a member's model after the team is already running:

```bash
jq '(.members[] | select(.name == "discorder") | .model) = "claude-sonnet-4-6"' \
  .atmux/team.json > .atmux/team.json.new \
  && mv .atmux/team.json.new .atmux/team.json
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
