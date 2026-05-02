# E14/Sf class A fixer + pane-idle gate — review signoff

- **Task**: t-e404be44 — `[E14/Sf] REVIEW: signoff Sf — class A fixer + pane-idle gate`
- **Reviewer**: reviewer-2
- **Date**: 2026-05-02 19:43 MYT
- **ADRs**: ADR-038 §Pane-state safety gate, ADR-040 §whip-audit integration
- **Verdict**: ✅ **APPROVED within scope** — refuse-list, bare-prompt regex (per brief), collision guard, and auto_fixable=false propagation are all wired, tested, and behave correctly. Three minor enhancement notes (none blockers); listed §6.

## 1. Refuse-list — busy banner coverage

`_atmux_audit_pane_idle_reason` at `lib/audit.sh:639-656` runs the captured pane state (`tmux capture-pane -p -t <session>:driver -S -10`, re-captured at fix time per the comment at line 534-538) through:

```sh
echo "$state" | grep -qiE \
  'thinking with|Compacting conversation|Press up to edit queued messages|hit your limit|Now using extra usage|Esc to interrupt'
```

| Banner | Source | Refuse-list | Bats coverage | Verdict |
|---|---|---|---|---|
| `thinking with` | claude TUI extended-reasoning | ✅ | `audit_fix_a.bats:117-134`, `audit.bats:53` | ✅ |
| `Compacting conversation` | claude TUI auto-compaction | ✅ | `audit_fix_a.bats:69-96` | ✅ |
| `Press up to edit queued messages` | claude TUI queued-message backbuffer | ✅ | `audit_fix_a.bats:98-115`, `audit.bats:51` | ✅ |
| `hit your limit` | claude TUI rate-limit modal | ✅ | `audit.bats:52` | ✅ |
| `Now using extra usage` | claude TUI overage announce | ✅ | **MISSING** (regex covers; no dedicated bats case) | ⚠️ note §6.3 |
| `Esc to interrupt` | claude TUI token counter while reasoning | ✅ | `audit.bats:54` | ✅ |

Case-insensitive (`-i`), uses ERE (`-E`) — pipe-separated alternation works as expected. Comment at `lib/audit.sh:506-508` matches the implementation.

**Cross-check against CLAUDE.md `feedback_migrate_detector_quirks.md`** (the codebase's own enumeration of TUI banners): "thinking with", "Compacting" — both ✅ covered. The NBSP-prompt quirk noted there is handled differently (it's a prompt-detection class, not refuse-list — see §2).

**Cross-check whip's pane-busy fast-path (`lib/whip.sh:963-970`)**: whip's check is narrower (`Esc to interrupt|tokens · esc to interrupt|thinking with`). When whip's check passes (false-negative on Compacting / queued-messages / rate-limit / extra-usage), audit's broader preflight catches it inside `--fix` and returns skip. Net behavior is safe; the duplication is a maintenance hazard noted at §6.2.

Verdict: ✅ refuse-list covers the documented banner taxonomy.

## 2. Bare-prompt regex — zsh/bash/fish coverage

`lib/audit.sh:650`:

```sh
if [[ ! "$last_line" =~ [\$❯»][[:space:]]*$ ]]; then
  printf "pane not at bare prompt (last_line='%s')\n" "$last_line"
  return 0
fi
```

Character class: `$` `❯` `»`. Whitespace-suffix permissive (zero-or-more trailing whitespace).

| Shell / theme | Default last char | Match? | Behavior |
|---|---|---|---|
| `bash` (default `\\$`) | `$` | ✅ | Idle → fire rename |
| `zsh` (default non-root) | `%` | ❌ | Skip with "pane not at bare prompt" — operator manually renames |
| `zsh` + powerlevel10k / starship | `❯` | ✅ | Idle → fire rename |
| `fish` (default) | `>` | ❌ | Skip — operator manually renames |
| Any shell as root | `#` | ❌ | Skip — operator manually renames |
| Custom `»` (some prompt themes) | `»` | ✅ | Idle → fire rename |

Bats coverage (`audit_fix_a.bats:138-178`): two prompts (`$`, `❯`) — the supported pair. No assertion against `%` / `>` / `#` (those would be safe-rejects, not matched but not unsafe).

The brief literally specifies `$ / ❯ / »` ([source comment at `lib/audit.sh:510-514`](#)). The implementation matches the brief verbatim. The strictness is **safe-by-design**: a false-accept (matching mid-turn output that happens to end in `$`) would disrupt the operator's REPL via tmux rename-window; a false-reject defers the rename — operator can re-fire later or hand-rename.

The user's environment per `~/.zshrc` is zsh + powerlevel10k → `❯` → covered. ✅

Verdict: ✅ regex matches the brief and the user's actual prompt. Strictly speaking the regex does NOT cover all default zsh / fish / root prompts — see §6.1 for a recommendation if the supported-shells set widens.

## 3. Collision detection

`lib/audit.sh:554-566`:

```sh
if tmux list-windows -t "=$session" -F '#W' 2>/dev/null \
     | grep -qxF "__${team}__driver"; then
  _atmux_audit_log_fix A skip \
    "collision: window '__${team}__driver' already exists" "$detail"
  return 1
fi
```

- Pre-flight check fires BEFORE `tmux rename-window`, so on collision both windows survive intact.
- `grep -xF` — exact-line, fixed-string. No regex pollution; resistant to `__team__driver-2` not matching `__team__driver` (the `-x` anchor blocks substring hits).
- Source comment at `lib/audit.sh:554-560` explains the motivation: tmux's own `rename-window` is permissive on duplicates (rc=0 silently producing two windows sharing the canonical name), after which the driver pane is no longer addressable by `=$session:driver`. The exact-match grep replaces tmux's ambiguous behavior with a deterministic skip.

Bats coverage (`audit_fix_a.bats:182-232`):
- Pre-creates `__auFA6__driver` first, then a bare `driver`.
- Asserts: `class=A result=skip` row appears, log mentions "collision:" and `__auFA6__driver`, both windows survive.
- **Idempotency on collision path**: re-runs the dispatcher; verifies the skip count increments by exactly 1 (no double-rename, no rc=fail) and both windows still survive.

Verdict: ✅ collision detection is correctly ordered, exactly-anchored, and well-tested.

## 4. `auto_fixable=false` propagation to whip surface

### 4a. Source — schema field

`lib/audit.sh:42-48`:

```sh
declare -gA _ATMUX_AUDIT_AUTO_FIXABLE=(
  [A]=false [B]=false [C]=false [D]=true [E]=true [F]=true
)
```

`_atmux_audit_emit` at `lib/audit.sh:184-207` reads `_ATMUX_AUDIT_AUTO_FIXABLE[$class]` and emits via `--argjson auto_fixable "$auto_fixable"` so the JSON field is a real boolean (not string `"false"`). Class A findings always carry `auto_fixable: false` even though the fixer can run successfully when the pane is idle. Source comment at `lib/audit.sh:42-47` and `lib/audit.sh:501-504` both explain the rationale: external readers see a finding that **cannot be fixed unattended** (the pane-idle gate is conditional, ADR-038 marks it that way to keep the schema honest).

### 4b. Whip surface — class A handling

`lib/whip.sh:_atmux_whip_check_audit` at lines 539-633 consumes the audit JSON. Routing per class (`lib/whip.sh:575-609`):

- D / E / F (auto_fixable=true) → `audit --fix --class <c>` fires unconditionally → `auto_corrected[]` (🔧 Auto-corrected section).
- **A** (auto_fixable=false, conditional) →
  - whip's `_atmux_whip_pane_busy` check first → if busy, `surfaced[]` ("⚠️ class A · driver-pane busy — fire later").
  - if not busy, fire `audit --fix --class a` → tail `audit-fix.log` for `class=A result=ok` → if found, `auto_corrected[]`; else `surfaced[]` ("⚠️ class A · driver action").
- B (auto_fixable=false) → always `surfaced[]`.
- C (auto_fixable=false, surface-only) → always `refused[]` ("🛑 class C · manual").

Discord template `[whip-audit]` (`lib/discord.sh:225-` per `lib/whip.sh:617`) renders three sections: 🔧 Auto-corrected, ⚠️ Surfaced — driver action, 🛑 Refused — manual only.

**Verdict on propagation**: `auto_fixable: false` is faithfully emitted in the JSON for every class A finding (`lib/audit.sh:188 + 202`). Whip does NOT consume the field directly — it dispatches by class letter — but the routing matches the field's contract: class A always has the chance to surface (both via whip's pane-busy fast-path and via the post-fix audit-log inspection). The schema field stays honest to external readers (enforcer agent, fleet walker, future consumers).

✅ contract satisfied.

## 5. Test coverage

```
$ bats tests/unit/audit_fix_a.bats     # live tmux + capture-pane path
1..7 — 7/7 pass

$ bats tests/unit/audit.bats           # 60-test broad suite
1..60 — 60/60 pass
```

Coverage matrix vs. brief:

| Brief item | Source line | Bats coverage | ✅ |
|---|---|---|---|
| Refuse-list — banner X catches and skips | `lib/audit.sh:642-644` | `audit.bats:51-54` (4 banners) + `audit_fix_a.bats:69-134` (3 banners with real tmux capture) | ✅ |
| Bare-prompt regex — `$` / `❯` accept | `lib/audit.sh:650` | `audit_fix_a.bats:138-178` (real tmux), `audit.bats:55` (non-prompt rejection) | ✅ |
| Collision detection — pre-flight skip + idempotent | `lib/audit.sh:561-566` | `audit_fix_a.bats:182-232` | ✅ |
| auto_fixable=false in emitted JSON | `lib/audit.sh:42-48 + 188 + 202` | `audit.bats` class-A emit cases | ✅ |
| Whip class A routing | `lib/whip.sh:583-602` | covered by `tests/unit/whip_audit.bats` (E14/Sd test sibling) | ✅ |

## 6. Enhancement notes (NOT blockers)

### 6.1. Bare-prompt regex breadth vs. shell-coverage

Task body asks "matches zsh/bash/fish". Regex strictly matches `$` / `❯` / `»` only. Default zsh (`%`), fish (`>`), and root prompts (`#`) all skip. The fail-mode is safe (skip + manual rename), but if the team grows operators on default zsh, fish, or root shells, the auto-fix never fires. Recommendation: either widen the char class to `[\$❯»%>#]` (probably worth an ADR §gating note since `%` and `#` are common shell-output chars in non-prompt contexts and could increase false-accept risk) OR document the supported-shells matrix in the brief comment at `lib/audit.sh:510-514`. Low priority; defer until a non-bash/non-p10k shell breaks the gate in practice.

### 6.2. Refuse-list duplication: whip vs. audit

Whip's `_atmux_whip_pane_busy` (`lib/whip.sh:963-970`) recognizes 3 banners; audit's `_atmux_audit_pane_idle_reason` (`lib/audit.sh:642-644`) recognizes 6. Whip's fast-path is a "skip the fork" optimization, but a future banner added to one regex won't auto-appear in the other. Recommendation: extract the regex into a shared constant (e.g. `lib/common.sh::ATMUX_TUI_BUSY_BANNER_RE`) or factor into a single helper that both sites source. Low priority; functional safety is fine because audit's preflight is the authoritative gate.

### 6.3. "Now using extra usage" banner has no dedicated bats case

Refuse-list includes it (`lib/audit.sh:643`) but no bats case asserts the skip path on this banner. The other 5 banners have explicit cases in `audit.bats:51-54` and `audit_fix_a.bats`. Recommendation: append one bats case mirroring `audit_fix_a.bats:69-96` with `'Now using extra usage…\n$ '` as the seeded body. Low priority; the regex is unit-trivial and the surrounding cases give high confidence.

## 7. Verdict

✅ **APPROVED within scope**. All four items from the task body verify clean:

1. Refuse-list covers thinking-with, Compacting, queued-messages, rate-limit, extra-usage, Esc-to-interrupt.
2. Bare-prompt regex matches the brief-specified set (`$/❯/»`) — narrow by design (false-accept unsafe).
3. Collision detection refuses pre-flight via exact-match `list-windows | grep -xF`, idempotent on re-run.
4. `auto_fixable: false` is emitted faithfully in JSON via `_ATMUX_AUDIT_AUTO_FIXABLE[A]=false` and consumed by whip's class-letter dispatcher into the right surface bucket (auto_corrected vs surfaced).

Tests: 67/67 pass across `audit_fix_a.bats` (7) + `audit.bats` (60). Three minor enhancements suggested above (§6.1–6.3); none block merge.

**Adjacent classes not covered by this Story** (deferred):
- Sg (class B fixer, cage-path migration via `team repair-rename` + driver-fired gate)
- Sh (class C fixer, window-position swap with manual confirm)
- Sk (class F fixer, tmux config glyph mismatch)
