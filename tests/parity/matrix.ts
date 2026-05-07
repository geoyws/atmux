// ADR-009: Test strategy — parity matrix.
//
// One row per (verb, args, fixture-preset) combination the harness
// exercises. `index.test.ts` iterates this array and runs runner+compare
// per row. Phase 0 ships an empty matrix; rows are added incrementally
// as verbs land in Phase 2.

/**
 * Fixture preset names. The factory under `tests/parity/fixtures/`
 * publishes these once it lands (Phase 1, after ADR-005 ratifies schemas).
 *   - `minimal`              — 2-member team, empty kanban, no inboxes
 *   - `lifecycle`            — 4-member template mirroring tests/e2e/lifecycle.bats
 *   - `multi-team`           — state shapes for atmux / sopx-mvp / ifca_aux / unum (deferred)
 *   - `cron-tasks`           — lifecycle + mixed-shape kanban + open ask (ADR-028 commit 2)
 *   - `cron-tasks-decisions` — lifecycle + decisions.md scaffold (ADR-028 commit 2)
 *   - `cron-tasks-groom`     — lifecycle + archive tails + .bak.* + old kanban (ADR-028 commit 2)
 */
export type FixturePreset =
  | "minimal"
  | "lifecycle"
  | "multi-team"
  | "cron-tasks"
  | "cron-tasks-decisions"
  | "cron-tasks-groom";

/**
 * What the row's authors expect a parity-green outcome to look like.
 * Used by `index.test.ts` to choose between strict-byte-equal and
 * semantic-aware diffing on stdout (ADR-009 §3 timestamp-mask rule).
 */
export type ParityExpectation =
  | "exit-zero-stable-stdout"
  | "exit-zero-timestamped-stdout"
  | "exit-nonzero-stable-stderr";

/**
 * Per-row, per-channel mask config. ADR-027 contract.
 *
 *   - `exitCode: true` skips exit-code comparison entirely (e.g. bash
 *     `exit 1` vs TS `exit 78` BSD-sysexits divergence per ADR-006).
 *   - `stdout` / `stderr`: a `RegExp` or `string` pattern fed straight
 *     to `String.replace(pattern, "")` on BOTH sides before byte-equal.
 *     Patterns lacking a `/g` flag replace only the first match — by
 *     design (anchored masks at line start are common).
 *   - `stateAfter`: glob → regex map. Glob shape `<filename-stem>.<path>`
 *     where `<filename-stem>` matches files like `*<stem>.json` in the
 *     fs snapshot, and `<path>` is a dot-separated JSON path with `[*]`
 *     wildcards for arrays. Matching string/number values are elided
 *     from BOTH sides' parsed JSON before canonicalised diff.
 *
 * Reviewer rule (ADR-027 §4): every mask entry MUST carry an inline
 * `// reason:` comment + ADR class label (`ADR-027 error-rendering
 * class` / `ADR-027 state-after class`). Uncited masks fail review.
 */
export type ChannelMask = {
  exitCode?: true;
  stdout?: RegExp | string;
  stderr?: RegExp | string;
  stateAfter?: Record<string, RegExp>;
};

export type ParityRow = {
  verb: string;
  args: ReadonlyArray<string>;
  fixturePreset: FixturePreset;
  expect: ParityExpectation;
  /**
   * Optional human-readable label for the bun:test row name. Defaults
   * to `<verb> ${args.join(" ")} [${fixturePreset}]` if omitted.
   */
  label?: string;
  /**
   * Optional channel-mask config (ADR-027). Absent = byte-equal /
   * canonical-JSON exact comparison across all channels (existing
   * `version` + `not-a-verb` rows). Present = per-channel mask
   * applied symmetrically before comparison.
   */
  mask?: ChannelMask;
  /**
   * Optional row-level pre-state (ADR-029 §3). Each `<relPath>` is
   * resolved against the cloned per-side fixture root and written
   * BEFORE `runVerb` fires. JSON-shaped values stringify with 2-space
   * indent + trailing newline; strings write verbatim. Both sides
   * receive identical pre-state (per-side asymmetry is iter-4+ work).
   *
   * Reviewer rule: every entry MUST have an inline `// reason:` comment
   * naming the verb-class need (e.g. `// reason: dispatch needs a
   * pre-seeded task to UPDATE — ADR-029 row 1`).
   */
  preState?: Record<string, unknown>;
  /**
   * Optional golden-file harness mode (ADR-028 §Golden-file harness mode).
   *
   * When `true`, only the bash side runs. Output is compared against a
   * checked-in golden snapshot at `tests/parity/golden/<row-id>.txt`
   * where `<row-id>` is the row's `label` slugified, falling back to
   * `<verb>-<args.join("-")>`. Use for verbs whose TS port is absent
   * (per ADR-028: `decisions`, `groom` — bash exists at the parent
   * atmux's `lib/`; worktree-bun's carve-out per ADR-022/026 omits them).
   * Auto-promotes to full bash↔TS parity when this field is removed AND
   * the TS verb dispatcher routes the verb.
   *
   * Capture/update flag: `ATMUX_PARITY_UPDATE_GOLDENS=1 bun test
   * tests/parity/` writes/overwrites the golden file with the bash
   * side's current output (no comparison; pass unconditionally).
   */
  bashOnly?: true;
  /**
   * Per-row override for the bash binary path. Defaults to `runner.ts`'s
   * `BIN_BASH` (worktree's `bin/atmux`). Use to point at parent atmux's
   * `/root/work/src/atmux/bin/atmux` for verbs that exist on the parent's
   * `lib/` but were excluded from worktree-bun's carve-out per
   * ADR-022/026 (e.g. `decisions`, `groom`, `cron`).
   *
   * Reviewer rule: paired with `bashOnly: true` only — overriding the
   * bash binary on a full bash↔TS row would compare two different
   * implementations of bash atmux against TS, which isn't a parity
   * statement worth shipping. Iter-2+ may relax if a use case emerges.
   */
  bashBin?: string;
};

/**
 * The parity matrix. Phase 3 iter-1 (per ADR-026) wires the 2 currently
 * parity-green verbs: `version` (happy-path proof) + unknown-verb
 * (`not-a-verb`, exit-code-class divergence proof).
 *
 * The 4 wired-but-`test.todo` skeletons (init/start/send/add-member)
 * stay parked: a probe at `/tmp/parity-probe` (2026-05-05) confirmed
 * real bash↔TS divergence on the no-team error path — bash emits
 * `💥 atmux …`/exit 1, TS emits `atmux: config: …`/exit 78 (BSD
 * sysexits). Reconciliation is per-verb porter work + an open
 * meta-decision (mirror-bash vs parity-mask exit codes); see
 * ADR-026's deferred table for the durable handle.
 */
export const PARITY_MATRIX: ReadonlyArray<ParityRow> = [
  {
    verb: "version",
    args: [],
    fixturePreset: "minimal",
    expect: "exit-zero-stable-stdout",
  },
  {
    verb: "not-a-verb",
    args: [],
    fixturePreset: "minimal",
    expect: "exit-nonzero-stable-stderr",
  },
  // ADR-027 commit 4: state-mutating happy-path rows. Per the lead's
  // dispatch (`adjust which 4 verbs you row` license), all four exercise
  // `task add` shape variations rather than {task, dispatch, inbox, done}
  // — dispatch involves tmux ping side effects, inbox has stylistic
  // header divergence, and done depends on dispatch + member inference.
  // Four `task add` variants cleanly isolate the state-mutation INSERT
  // class without bringing other systems' divergences into commit-4
  // scope. Variant coverage: bare subject / --priority / --body /
  // --assignee. All use `lifecycle` preset (so the .atmux/ shape is
  // present + Zod-validated). ADR-026 row 3 closes through this set.
  {
    verb: "task",
    args: ["add", "parity-add"],
    fixturePreset: "lifecycle",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: random task ID echoed to stdout (ADR-027 state-after class)
      stdout: /t-[0-9a-f]{8}/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux added task t-[0-9a-f]{8}: [^\n]*\n?/,
      stateAfter: {
        // reason: 8-hex random per invocation (ADR-027 state-after class)
        "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/,
        // reason: Unix epoch per invocation (ADR-027 state-after class)
        "kanban.tasks[*].createdAt": /^\d{10,}$/,
      },
    },
  },
  {
    verb: "task",
    args: ["add", "parity-prio", "--priority", "5"],
    fixturePreset: "lifecycle",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: random task ID echoed to stdout (ADR-027 state-after class)
      stdout: /t-[0-9a-f]{8}/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux added task t-[0-9a-f]{8}: [^\n]*\n?/,
      stateAfter: {
        // reason: 8-hex random per invocation (ADR-027 state-after class)
        "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/,
        // reason: Unix epoch per invocation (ADR-027 state-after class)
        "kanban.tasks[*].createdAt": /^\d{10,}$/,
      },
    },
  },
  {
    verb: "task",
    args: ["add", "parity-body", "--body", "detailed description"],
    fixturePreset: "lifecycle",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: random task ID echoed to stdout (ADR-027 state-after class)
      stdout: /t-[0-9a-f]{8}/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux added task t-[0-9a-f]{8}: [^\n]*\n?/,
      stateAfter: {
        // reason: 8-hex random per invocation (ADR-027 state-after class)
        "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/,
        // reason: Unix epoch per invocation (ADR-027 state-after class)
        "kanban.tasks[*].createdAt": /^\d{10,}$/,
      },
    },
  },
  {
    verb: "task",
    args: ["add", "parity-assignee", "--assignee", "lead"],
    fixturePreset: "lifecycle",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: random task ID echoed to stdout (ADR-027 state-after class)
      stdout: /t-[0-9a-f]{8}/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux added task t-[0-9a-f]{8}: [^\n]*\n?/,
      stateAfter: {
        // reason: 8-hex random per invocation (ADR-027 state-after class)
        "kanban.tasks[*].id": /^t-[0-9a-f]{8}$/,
        // reason: Unix epoch per invocation (ADR-027 state-after class)
        "kanban.tasks[*].createdAt": /^\d{10,}$/,
      },
    },
  },
  // ADR-027 commit 5: error-rendering rows. Closes ADR-026 row 6.
  // Per ADR-006: TS keeps BSD sysexits (exit 78 EX_CONFIG) + structured-tag
  // stderr; bash uses exit 1 + 💥-emoji prefix. Per ADR-027 Option B
  // (George 2026-05-05 ~20:35 MYT): mask the stylistic divergence,
  // don't reconcile. Each row exercises an error path with the same
  // 3-pattern stderr mask shape (prefix + per-side fixture-clone path
  // suffix + bash/TS hint phrasing) — the latter omitted on init's
  // already-initialized row where both sides emit identical em-dash +
  // identical `— pass --force` hint phrasing.
  //
  // Probe-verified at /tmp/parity-probe (deleted post-confirmation):
  //   bash: `💥 atmux <msg> at <path>.bash/.atmux/... <hint>\n` / exit 1
  //   ts:   `atmux: <tag>: <msg> at <path>.ts/.atmux/...   <hint>\n` / exit 78 (or 64 for UsageError; init's already-initialized is ConfigError → 78)
  //
  // 4-of-4 ADR-026 row 6 verbs covered: init / start / send / add-member.
  {
    verb: "init",
    args: [],
    fixturePreset: "lifecycle",
    label: "init [lifecycle: already-initialized error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 2-pattern mask — bash `💥 atmux ` prefix vs TS `atmux: <tag>: `
      // prefix (ADR-027 error-rendering class) + per-side fixture-clone path
      // suffix `.bash` / `.ts` before /.atmux/ (commit 3 cloning artefact).
      // Both sides use ` — pass --force to overwrite` so no hint-phrase mask
      // needed here (contrast no-team rows below).
      stderr: /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)/g,
    },
  },
  {
    verb: "start",
    args: [],
    fixturePreset: "minimal",
    label: "start [minimal: no-team error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask — bash `💥 atmux ` vs TS `atmux: config: ` prefix
      // (ADR-027 error-rendering class) + per-side fixture-clone path suffix
      // `.bash` / `.ts` before /.atmux/ (commit 3 cloning artefact) + hint
      // phrasing divergence (bash ` — run …` em-dash vs TS ` (hint: run …)`
      // parens form, ADR-027 error-rendering class)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  {
    verb: "send",
    args: ["lead", "hi"],
    fixturePreset: "minimal",
    label: "send [minimal: no-team error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask — bash `💥 atmux ` vs TS `atmux: config: ` prefix
      // (ADR-027 error-rendering class) + per-side fixture-clone path suffix
      // (commit 3 cloning artefact) + hint phrasing divergence (bash em-dash
      // vs TS parens form, ADR-027 error-rendering class)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  {
    verb: "add-member",
    args: ["new-member"],
    fixturePreset: "minimal",
    label: "add-member [minimal: no-team error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask — bash `💥 atmux ` vs TS `atmux: config: ` prefix
      // (ADR-027 error-rendering class) + per-side fixture-clone path suffix
      // (commit 3 cloning artefact) + hint phrasing divergence (bash em-dash
      // vs TS parens form, ADR-027 error-rendering class)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  // ADR-031 commit B: 13 lifecycle-lane error-path rows. Closes ADR-031
  // §Decision row "13 error-path rows for up / start --bad-flag / stop /
  // pause / resume / attach / rotate / rotate-lead / reconfigure".
  // Per ADR-027 Option B: mask the stylistic divergence; ADR-006 stands
  // (TS keeps BSD sysexits + structured-tag stderr; bash keeps 💥 + exit 1).
  //
  // Three mask shape families used here, each cited per-row:
  //   (a) standard no-team `init` hint (7 rows: stop / pause-foo / resume-foo
  //       / attach / rotate-foo / rotate-lead / reconfigure) — same shape
  //       as the existing start/send/add-member rows above
  //   (b) `up` no-team-no-tty `init --wizard` hint variant (1 row)
  //   (c) lifecycle `no such member` rows (3 rows: pause / resume / rotate)
  //       — adds a `(?:pause: |resume: |rotate: )?` verb-name prefix mask
  //       absorbing TS-only verb-tag in ConfigError what
  //   (d) UsageError no-args (2 rows: pause / rotate) — different mask shape
  //       absorbing bash `💥 atmux usage:` vs TS `atmux: usage:` (or `atmux:`
  //       for rotate whose USAGE constant lacks the literal "usage:" prefix).
  //
  // Rows referencing tmux session state (start happy path, stop --force,
  // attach existing-session, rotate w1) are deferred to iter-3 per ADR-031
  // §Decision — they need the new `tmuxAfter` channel.
  {
    verb: "up",
    args: [],
    fixturePreset: "minimal",
    label: "up [minimal: no-team + no-tty error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (family b — `init --wizard` hint variant) —
      // bash `💥 atmux ` vs TS `atmux: <tag>: ` prefix (ADR-027 error-
      // rendering class) + per-side fixture-clone path suffix + bash em-dash
      // vs TS parens hint phrasing on the `init --wizard` variant
      // (lib/up.sh:54-55 vs src/verbs/up.ts:264-269)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init --wizard' first\)?/g,
    },
  },
  {
    verb: "stop",
    args: [],
    fixturePreset: "minimal",
    label: "stop [minimal: no-team error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (family a — same as start/send/add-member rows)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  {
    verb: "pause",
    args: ["foo"],
    fixturePreset: "minimal",
    label: "pause [minimal: no-team error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (family a)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  {
    verb: "resume",
    args: ["foo"],
    fixturePreset: "minimal",
    label: "resume [minimal: no-team error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (family a)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  {
    verb: "attach",
    args: [],
    fixturePreset: "minimal",
    label: "attach [minimal: no-team error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (family a)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  {
    verb: "rotate",
    args: ["foo"],
    fixturePreset: "minimal",
    label: "rotate [minimal: no-team error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (family a)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  {
    verb: "rotate-lead",
    args: [],
    fixturePreset: "minimal",
    label: "rotate-lead [minimal: no-team error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (family a)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  {
    verb: "reconfigure",
    args: [],
    fixturePreset: "minimal",
    label: "reconfigure [minimal: no-team error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (family a)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  {
    verb: "pause",
    args: ["unknown-foo"],
    fixturePreset: "lifecycle",
    label: "pause [lifecycle: no-such-member error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 2-pattern mask (family c) — bash `💥 atmux ` vs TS
      // `atmux: config: pause: ` prefix (ADR-027 error-rendering class — TS
      // adds verb-name tag in ConfigError what per src/verbs/pause.ts:115;
      // bash dies via atmux::member_json without verb prefix per
      // lib/common.sh:156). No path suffix needed (member name has no path);
      // body is identical post-mask: "no such member in team.json: unknown-foo".
      stderr: /(💥 atmux |atmux: \S+: (?:pause: |resume: |rotate: )?)/g,
    },
  },
  {
    verb: "resume",
    args: ["unknown-foo"],
    fixturePreset: "lifecycle",
    label: "resume [lifecycle: no-such-member error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 2-pattern mask (family c) — same shape as pause no-such-member row above
      stderr: /(💥 atmux |atmux: \S+: (?:pause: |resume: |rotate: )?)/g,
    },
  },
  {
    verb: "rotate",
    args: ["unknown-foo"],
    fixturePreset: "lifecycle",
    label: "rotate [lifecycle: no-such-member error]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 2-pattern mask (family c) — same shape
      stderr: /(💥 atmux |atmux: \S+: (?:pause: |resume: |rotate: )?)/g,
    },
  },
  {
    verb: "pause",
    args: [],
    fixturePreset: "lifecycle",
    label: "pause [lifecycle: usage error (no args)]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 64 EX_USAGE (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 1-pattern mask (family d-pause) — bash `💥 atmux usage: ` vs TS
      // `atmux: usage: ` prefix. Both surfaces include the literal "usage:" body
      // (bash via atmux::die "usage: atmux pause <member>" pre-rendered, TS via
      // UsageError what="usage: …" per src/verbs/pause.ts:76). Symmetric body
      // after strip: "atmux pause <member>". Lifecycle preset required — bash
      // pause.sh:6 calls atmux::require_team BEFORE the usage check, so
      // minimal preset would fire the no-team error class instead.
      stderr: /(💥 atmux usage: |atmux: usage: )/g,
    },
  },
  {
    verb: "rotate",
    args: [],
    fixturePreset: "lifecycle",
    label: "rotate [lifecycle: usage error (no args)]",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 64 EX_USAGE (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 1-pattern mask (family d-rotate) — bash `💥 atmux usage: ` vs TS
      // `atmux: ` prefix. Asymmetry: bash atmux::die "usage: atmux rotate …"
      // includes literal "usage:" in the body; TS UsageError what="atmux rotate
      // <member>  |  atmux rotate-lead" (rotate.ts:195) lacks the "usage:" prefix.
      // After strip both sides yield "atmux rotate <member>  |  atmux rotate-lead".
      // Lifecycle preset required (same require_team-before-usage rationale as
      // pause-no-args row above).
      stderr: /(💥 atmux usage: |atmux: )/g,
    },
  },
  // ADR-031 commit C: pause happy-path state-after row. Closes ADR-031
  // §Decision row "2 state-after rows for pause w1 happy path on
  // lifecycle preset" — landed as 1 row, not 2: the `--reason
  // custom-reason` variant was dropped during commit-C authoring after
  // probing proved bash lib/pause.sh has NO --reason flag handling
  // (lib/pause.sh:22 only honours $ATMUX_PAUSE_REASON env var). The TS
  // port's --reason flag (pause.ts:48-55) diverges silently — bash
  // writes reason="manual", TS writes reason="custom-reason". Cross-
  // side parity requires identical reason values; the variant defers
  // to iter-3 per-row env-var injection in the harness (re-enable
  // handle: `ATMUX_PAUSE_REASON=custom-reason atmux pause w1` row that
  // both sides honour symmetrically).
  //
  // `paused.json` is single-key state-after (no array wildcard); `at`
  // field is Unix epoch (ADR-027 state-after-class mask).
  //
  // Channel-asymmetric rendering: bash emits `✅ atmux paused w1
  // (dispatch/claim will refuse)` to stderr via atmux::ok
  // (lib/pause.sh:23); TS emits `paused w1 (dispatch/claim will refuse)`
  // to stdout (src/verbs/pause.ts:92). Mirror the task-add row pattern
  // from `1890278` — mask both channels.
  {
    verb: "pause",
    args: ["w1"],
    fixturePreset: "lifecycle",
    label: "pause [lifecycle: w1 happy path]",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: TS-only stdout confirmation (channel-asymmetric — bash uses
      // stderr via atmux::ok, TS uses stdout via process.stdout.write —
      // ADR-027 error-rendering class)
      stdout: /^paused w1 \(dispatch\/claim will refuse\)\n?/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux paused w1 \(dispatch\/claim will refuse\)\n?/,
      stateAfter: {
        // reason: Unix epoch per invocation (ADR-027 state-after class).
        // Single-key glob — paused.json shape is `{<member>: {at, reason}}`;
        // mask the `at` field on the `w1` member entry.
        "paused.w1.at": /^\d{10,}$/,
      },
    },
  },
  // ADR-029 commit C: 2 dispatch rows. UPDATE+INSERT class — kanban.tasks[*]
  // gets `owner` / `status` / `claimedAt` UPDATE; inboxes/<member>.json gets
  // `inProgress[]` INSERT with `dispatchedAt`. Both rows use `--no-ping` to
  // suppress the tmux side-effect (fixture has no panes; bash `atmux::die`s
  // on no-tmux-window post-write — out of scope for iter-3 UPDATE-class
  // isolation; tmux-channel deferred to iter-4 per ADR-029 §Out of plan).
  //
  // Discriminative axes:
  //   row 1: lead (team-lead role) — exercises lead.json inbox stem
  //   row 2: w1 (member role)     — exercises w1.json inbox stem
  //
  // Pattern: same channel-asymmetric stdout/stderr shape as ADR-031 pause
  // happy-path row (bash `atmux::ok` writes ✅ to stderr; TS writes
  // `dispatched <id> → <member>` to stdout via process.stdout.write).
  // ADR-029 NOTE: per ADR-029 §1 the planned row-2 axis was `--no-ping`
  // flag presence, but probe at /tmp/run-dispatch-probe* (2026-05-06)
  // showed bash dies on no-tmux post-write regardless of flag, requiring
  // --no-ping on BOTH rows for clean UPDATE-class isolation; deviation
  // documented as iter-3 mechanics-discovery (ADR-029 §1 may amend in
  // close-commit if reviewer prefers).
  {
    verb: "dispatch",
    args: ["lead", "t-seed1", "--no-ping"],
    fixturePreset: "lifecycle",
    label: "dispatch lead t-seed1 --no-ping [lifecycle: UPDATE-class]",
    expect: "exit-zero-stable-stdout",
    preState: {
      // reason: dispatch needs a pre-seeded todo task to UPDATE — ADR-029 row 1
      ".atmux/kanban.json": {
        tasks: [{ id: "t-seed1", subject: "seeded", status: "todo", createdAt: 1700000000 }],
        epics: [],
        stories: [],
      },
    },
    mask: {
      // reason: TS-only stdout confirmation (channel-asymmetric — bash uses
      // stderr via atmux::ok, TS uses stdout via process.stdout.write —
      // ADR-027 error-rendering class)
      stdout: /^dispatched t-seed1 → lead\n?/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux dispatched t-seed1 → lead\n?/,
      stateAfter: {
        // reason: Unix epoch per invocation (ADR-027 state-after class)
        "kanban.tasks[*].claimedAt": /^\d{10,}$/,
        // reason: Unix epoch per invocation; lead.json inbox stem (ADR-027 state-after class)
        "lead.inProgress[*].dispatchedAt": /^\d{10,}$/,
      },
    },
  },
  {
    verb: "dispatch",
    args: ["w1", "t-seed2", "--no-ping"],
    fixturePreset: "lifecycle",
    label: "dispatch w1 t-seed2 --no-ping [lifecycle: UPDATE-class, member-role inbox stem]",
    expect: "exit-zero-stable-stdout",
    preState: {
      // reason: dispatch needs a pre-seeded todo task to UPDATE — ADR-029 row 2
      ".atmux/kanban.json": {
        tasks: [{ id: "t-seed2", subject: "seeded-2", status: "todo", createdAt: 1700000000 }],
        epics: [],
        stories: [],
      },
    },
    mask: {
      // reason: TS-only stdout confirmation (channel-asymmetric — ADR-027 error-rendering class)
      stdout: /^dispatched t-seed2 → w1\n?/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux dispatched t-seed2 → w1\n?/,
      stateAfter: {
        // reason: Unix epoch per invocation (ADR-027 state-after class)
        "kanban.tasks[*].claimedAt": /^\d{10,}$/,
        // reason: Unix epoch per invocation; w1.json inbox stem (ADR-027 state-after class)
        "w1.inProgress[*].dispatchedAt": /^\d{10,}$/,
      },
    },
  },
  // ADR-029 commit D: 2 claim rows. UPDATE-class — kanban.tasks[*] gets
  // owner / status / claimedAt UPDATE; inboxes/<member>.json INSERTs the
  // pre-update task into inProgress[] with claimedAt epoch. Same channel-
  // asymmetric stdout/stderr shape as dispatch (bash atmux::ok via stderr,
  // TS process.stdout.write).
  //
  // Discriminative axes: explicit --as varies (lead vs w1) for inbox-stem
  // coverage; cwd-inferred member (no --as) deferred since lifecycle
  // fixture's all-members-share-cwd shape would force `head -1` selection
  // and add a second axis (inference path) on top of state mutation.
  {
    verb: "claim",
    args: ["t-seed1", "--as", "lead"],
    fixturePreset: "lifecycle",
    label: "claim t-seed1 --as lead [lifecycle: UPDATE-class]",
    expect: "exit-zero-stable-stdout",
    preState: {
      // reason: claim needs a pre-seeded todo task to UPDATE — ADR-029 row 3
      ".atmux/kanban.json": {
        tasks: [{ id: "t-seed1", subject: "seeded", status: "todo", createdAt: 1700000000 }],
        epics: [],
        stories: [],
      },
    },
    mask: {
      // reason: TS-only stdout confirmation (channel-asymmetric — ADR-027 error-rendering class)
      stdout: /^lead claimed t-seed1\n?/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux lead claimed t-seed1\n?/,
      stateAfter: {
        // reason: Unix epoch per invocation (ADR-027 state-after class)
        "kanban.tasks[*].claimedAt": /^\d{10,}$/,
        // reason: Unix epoch per invocation; lead.json inbox stem (ADR-027 state-after class)
        "lead.inProgress[*].claimedAt": /^\d{10,}$/,
      },
    },
  },
  {
    verb: "claim",
    args: ["t-seed2", "--as", "w1"],
    fixturePreset: "lifecycle",
    label: "claim t-seed2 --as w1 [lifecycle: UPDATE-class, member-role inbox stem]",
    expect: "exit-zero-stable-stdout",
    preState: {
      // reason: claim needs a pre-seeded todo task to UPDATE — ADR-029 row 4
      ".atmux/kanban.json": {
        tasks: [{ id: "t-seed2", subject: "seeded-2", status: "todo", createdAt: 1700000000 }],
        epics: [],
        stories: [],
      },
    },
    mask: {
      // reason: TS-only stdout confirmation (channel-asymmetric — ADR-027 error-rendering class)
      stdout: /^w1 claimed t-seed2\n?/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux w1 claimed t-seed2\n?/,
      stateAfter: {
        // reason: Unix epoch per invocation (ADR-027 state-after class)
        "kanban.tasks[*].claimedAt": /^\d{10,}$/,
        // reason: Unix epoch per invocation; w1.json inbox stem (ADR-027 state-after class)
        "w1.inProgress[*].claimedAt": /^\d{10,}$/,
      },
    },
  },
  // ADR-029 commit E: 2 done rows. UPDATE-class — kanban.tasks[*] gets
  // status="done" / completedAt / note UPDATE; inboxes/<member>.json
  // moves the pre-update task from inProgress[] to done[] with
  // completedAt epoch.
  //
  // Discriminative axes: empty-note path (row 5: --note "") vs
  // non-empty-note path (row 6: --note "shipped"). Both rows pass
  // --note explicitly to work around F10 (TS markTaskDone skips note
  // field when undefined; bash always writes note: ""; key-set
  // divergence canonicaliseJson cannot mask). F10 surfaced to lead;
  // when fixed, a follow-up commit can add a no-flag row covering
  // the implicit-empty-note path.
  {
    verb: "done",
    args: ["t-seed3", "--as", "lead", "--note", ""],
    fixturePreset: "lifecycle",
    label: "done t-seed3 --as lead --note '' [lifecycle: UPDATE-class, empty-note path]",
    expect: "exit-zero-stable-stdout",
    preState: {
      // reason: done needs a pre-seeded in-progress task to UPDATE — ADR-029 row 5
      ".atmux/kanban.json": {
        tasks: [
          {
            id: "t-seed3",
            subject: "seeded-3",
            status: "in-progress",
            owner: "lead",
            createdAt: 1700000000,
            claimedAt: 1700000100,
          },
        ],
        epics: [],
        stories: [],
      },
      // reason: done expects task in member's inProgress[] to move to done[] — ADR-029 row 5
      ".atmux/inboxes/lead.json": {
        pending: [],
        inProgress: [
          {
            id: "t-seed3",
            subject: "seeded-3",
            status: "in-progress",
            createdAt: 1700000000,
            claimedAt: 1700000100,
          },
        ],
        done: [],
      },
    },
    mask: {
      // reason: TS-only stdout confirmation (channel-asymmetric — ADR-027 error-rendering class)
      stdout: /^lead completed t-seed3\n?/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux lead completed t-seed3\n?/,
      stateAfter: {
        // reason: Unix epoch per invocation (ADR-027 state-after class)
        "kanban.tasks[*].completedAt": /^\d{10,}$/,
        // reason: Unix epoch per invocation; lead.json inbox stem (ADR-027 state-after class)
        "lead.done[*].completedAt": /^\d{10,}$/,
      },
    },
  },
  {
    verb: "done",
    args: ["t-seed4", "--as", "w1", "--note", "shipped"],
    fixturePreset: "lifecycle",
    label: "done t-seed4 --as w1 --note 'shipped' [lifecycle: UPDATE-class, non-empty-note]",
    expect: "exit-zero-stable-stdout",
    preState: {
      // reason: done needs a pre-seeded in-progress task to UPDATE — ADR-029 row 6
      ".atmux/kanban.json": {
        tasks: [
          {
            id: "t-seed4",
            subject: "seeded-4",
            status: "in-progress",
            owner: "w1",
            createdAt: 1700000000,
            claimedAt: 1700000100,
          },
        ],
        epics: [],
        stories: [],
      },
      // reason: done expects task in member's inProgress[] to move to done[] — ADR-029 row 6
      ".atmux/inboxes/w1.json": {
        pending: [],
        inProgress: [
          {
            id: "t-seed4",
            subject: "seeded-4",
            status: "in-progress",
            createdAt: 1700000000,
            claimedAt: 1700000100,
          },
        ],
        done: [],
      },
    },
    mask: {
      // reason: TS-only stdout confirmation (channel-asymmetric — ADR-027 error-rendering class)
      stdout: /^w1 completed t-seed4\n?/,
      // reason: bash atmux::ok confirmation line not emitted by TS (ADR-027 error-rendering class)
      stderr: /^✅ atmux w1 completed t-seed4\n?/,
      stateAfter: {
        // reason: Unix epoch per invocation (ADR-027 state-after class)
        "kanban.tasks[*].completedAt": /^\d{10,}$/,
        // reason: Unix epoch per invocation; w1.json inbox stem (ADR-027 state-after class)
        "w1.done[*].completedAt": /^\d{10,}$/,
      },
    },
  },
  // ADR-029 commit H: 2 inbox auto-init rows. INSERT-class file-creation
  // — `atmux inbox <member>` for a member whose inboxes/<member>.json
  // doesn't yet exist lazily creates the file with the empty shape
  // `{"pending":[],"inProgress":[],"done":[]}`. Both bash + TS emit the
  // identical text-render to stdout (no divergence to mask) and write
  // identical-canonical empty JSON (compact bash vs pretty-printed TS,
  // canonicaliseJson handles).
  //
  // Discriminative axes: member stem varies (lead vs w1) — exercises
  // the lazy-init path on both team-lead and member roles. The --json
  // flag axis (originally planned for row 12) is deferred pending F12
  // fix (TS atmux-bun --json prints pretty-printed multiline; bash uses
  // `cat $f` literal compact form). Member-stem axis preserved.
  {
    verb: "inbox",
    args: ["lead"],
    fixturePreset: "lifecycle",
    label: "inbox lead [lifecycle: INSERT auto-init + render]",
    expect: "exit-zero-stable-stdout",
    // No mask — render is byte-equal across both sides; JSON file is
    // canonicalised by compare.ts.
  },
  {
    verb: "inbox",
    args: ["w1"],
    fixturePreset: "lifecycle",
    label: "inbox w1 [lifecycle: INSERT auto-init, member-role stem]",
    expect: "exit-zero-stable-stdout",
    // No mask — same as row 11; only the stem name differs (w1 vs lead).
  },
  // ADR-029 commit F (post-F11): 2 reply rows. INSERT-class markdown
  // line-append on lead-outbox.md.
  //
  // `reply --from <member> <msg>` appends a `- [HH:MM MYT] **<from>**:
  // <msg>\n` line under `## Open` in `.atmux/lead-outbox.md` (lib/
  // reply.sh:50-69 + src/verbs/reply.ts:140-160). Lifecycle preset does
  // NOT seed lead-outbox.md (factory.ts:189 only seeds driver-inbox.md),
  // so both sides hit the auto-create path: write the full markdown
  // template (header + section labels + `## Open\n`) THEN insert the
  // entry. Both sides emit byte-equal 284b (row 7) / 294b (row 8) post-
  // F11 fix at @69119af (regex /^## Open$/m no longer greedy-consumes
  // the trailing `\n` after the freshly-seeded header).
  //
  // Discriminative axes: --from lead (row 7, team-lead member) vs
  // --from w1 (row 8, member-role) — exercises the from-name embedding
  // in the entry line for both team-lead and worker member identities.
  // Same auto-create + insert path; only the entry-line `<from>` token
  // varies. Probe-verified 2026-05-06 17:58 MYT against post-F11 HEAD.
  //
  // Mask: stdout path-suffix elision for the success line `✅ atmux
  // reply recorded (<from> → driver) in <ob-path>` — `<ob-path>` embeds
  // the per-side fixture-clone artefact (`<root>.bash` / `<root>.ts`)
  // per ADR-027 §3 path-suffix shape (introduced for error-rendering;
  // writes to stderr (atmux::ok) per lib/common.sh success line per ADR-029 §2).
  // No stateAfter mask needed — fs byte-equal.
  {
    verb: "reply",
    args: ["--from", "lead", "test msg"],
    fixturePreset: "lifecycle",
    label:
      "reply --from lead 'test msg' [lifecycle: auto-create + insert under ## Open] (ADR-029 row 7)",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: per-side fixture-clone path suffix `<root>.bash` / `<root>.ts`
      // before /.atmux/ in the success line (ADR-027 error-rendering class —
      // path-suffix shape on stderr per atmux::ok writing to stderr)
      stderr: /(\.bash|\.ts)(?=\/\.atmux\/)/g,
    },
  },
  {
    verb: "reply",
    args: ["--from", "w1", "test msg from member"],
    fixturePreset: "lifecycle",
    label:
      "reply --from w1 'test msg from member' [lifecycle: member-role from-name, auto-create + insert] (ADR-029 row 8)",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: same as row 7 — per-side fixture-clone path suffix in the
      // success line (ADR-027 error-rendering class — path-suffix shape)
      stderr: /(\.bash|\.ts)(?=\/\.atmux\/)/g,
    },
  },
  // ADR-029 commit G: 2 tell-lead rows. INSERT-class markdown line-append.
  //
  // `tell-lead <msg>` appends `- [HH:MM MYT] <msg>\n` to driver-inbox.md
  // then dispatches a tmux send-keys heads-up to the lead's pane (lib/
  // tell.sh:30-43 + src/verbs/tell-lead.ts:140-205). The lifecycle preset
  // ships a 0-byte driver-inbox.md (factory.ts:189), so both sides hit
  // the empty-file append path AND the no-tmux-window die path. Both
  // bash and TS append the line, then atmux::send_to_member /
  // sendToMember dies with "no tmux window for lead (is the team
  // running?)" — exit 1 (bash) vs exit 78 (TS, ConfigError → EX_CONFIG).
  //
  // Discriminative axes: short msg (row 9) vs long 80+-char msg (row 10).
  // The long-msg axis was originally chosen to exercise the heads-up
  // truncation logic (`msg:0:80…` ellipsis suffix); since both sides die
  // BEFORE send_to_member fires the tmux dispatch, the truncation path
  // is unreached, but the long-msg axis still verifies the file-write
  // path doesn't drift on payload size — both sides write 88-byte byte-
  // equal `- [HH:MM MYT] <long-msg>\n` (probe-verified 2026-05-06 17:28
  // MYT, fs.driver-inbox.md byte-equal both sides post-mask).
  //
  // ADR-029 §1 row spec originally listed `--from w1` flag axis; probe-
  // verified at HEAD that neither bash (lib/tell.sh:16) nor TS (src/
  // verbs/tell-lead.ts:86 USAGE) accepts `--from` — bash silently
  // consumes as message body, TS rejects with usage error. Drop the
  // `--from` axis; single-arg `<msg>` is the canonical bash-frozen shape.
  // ADR-029 §1 row table is amended in this commit's deferred-row block.
  {
    verb: "tell-lead",
    args: ["test ask"],
    fixturePreset: "lifecycle",
    label: "tell-lead 'test ask' [lifecycle: append-then-die-no-window short msg] (ADR-029 row 9)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 1-pattern Pattern A prefix mask (ADR-027 error-rendering
      // class) — bash `💥 atmux ` vs TS `atmux: config: ` prefix on the
      // no-tmux-window die line. Both sides emit identical body `no tmux
      // window for lead (is the team running?)` after prefix strip. The
      // tell-lead verb-tag is NOT prepended on either side here (bash
      // atmux::die from send_to_member, TS ConfigError without verb
      // prefix per src/verbs/tell-lead.ts no-window path). Probe-verified
      // 2026-05-06 17:25 MYT.
      stderr: /(💥 atmux |atmux: config: )/g,
    },
  },
  {
    verb: "tell-lead",
    args: ["test long ask with 80+ chars to exercise heads-up truncation logic mirror"],
    fixturePreset: "lifecycle",
    label:
      "tell-lead '<long-msg>' [lifecycle: append-then-die-no-window long msg] (ADR-029 row 10)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: same as row 9 — Pattern A prefix-only divergence (ADR-027
      // error-rendering class). The long-msg payload doesn't change the
      // die-line shape; both sides write 88-byte byte-equal driver-inbox.md
      // line then die with identical no-tmux-window stderr body post-mask.
      stderr: /(💥 atmux |atmux: config: )/g,
    },
  },
  // ADR-030 commit B: 4 read-only happy-path rows (status / doctor x2 / cost).
  // ADR-030 §Decision pinned a 10-row scope (rows 1-10); commit B was originally
  // 6 happy rows (1-6). Iter-3 mechanics-discovery reduced to 4:
  //   - Row 4 (`inbox lead [lifecycle]` no-mask byte-equal) is duplicated by
  //     ADR-029 commit H rows 11-12 above (same verb/args/preset/expect — the
  //     INSERT auto-init shape covers ADR-030's read-render coverage too).
  //     Re-adding would fail bun:test's unique-test-name rule.
  //   - Row 5 (`cost --json [lifecycle]`) deferred to iter-4: probe surfaced
  //     bash `"totalUsd": 0.0000` vs TS `"totalUsd": 0` JSON-render divergence
  //     in the totalUsd field (bash awk `printf "%.6f"` accumulator preserved
  //     by jq `--argjson` raw-input vs TS plain `number` via `JSON.stringify`).
  //     Per ADR-027 §4 anti-semantic-mask rule a regex `0\.0+` → `0` would
  //     absorb actual usage values, so deferral pending iter-4 JSON-canonical-
  //     stdout mask class (already named in ADR-030 §"Re-enable handles").
  // Re-enable handles documented in ADR-030 §"Re-enable handles". Close-commit
  // (commit D) updates ADR-030 §"Iter-3 actual delivery" mirroring ADR-026 shape.
  {
    verb: "status",
    args: [],
    fixturePreset: "lifecycle",
    label: "status [lifecycle: read-render mask] (ADR-030 row 1)",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: 2-pattern stdout mask (ADR-030 read-render class) — bash + TS
      // disagree on (a) the table header column-widths line (`member role tui
      // pane inbox` with bash `\s` padding vs TS `\s` padding — different
      // total widths; status.sh:64-68 vs status.ts:226-230) and (b) the
      // `📬 driver-inbox  open=N` footer line (bash unconditionally emits per
      // status.sh:120-122; TS gates on count > 0 per status.ts:258-260). Both
      // anchored line-wise via `^…$\n` so post-mask body alignment is
      // unaffected. /gm flags required: /g for multi-line line-anchored
      // alternation, /m so `^`/`$` match line boundaries.
      stdout: /(^member\s+role\s+tui\s+pane\s+inbox\s*$\n)|(^📬 driver-inbox  open=\d+\n)/gm,
    },
  },
  {
    verb: "doctor",
    args: ["--quiet"],
    fixturePreset: "lifecycle",
    label: "doctor --quiet [lifecycle: green path, exit-only contract] (ADR-030 row 2)",
    expect: "exit-zero-stable-stdout",
    // No mask — `--quiet` skips render on both sides; stdout/stderr empty.
    // Probe-confirmed: bash exit 0, TS exit 0, both channels empty. The
    // green-path agreement IS the contract per ADR-030 §"Probe-time channel
    // inventory" — no rendered output to mask, just exit-code parity.
  },
  {
    verb: "doctor",
    args: ["--quiet"],
    fixturePreset: "minimal",
    label: "doctor --quiet [minimal: red path, exit-only contract] (ADR-030 row 3)",
    expect: "exit-nonzero-stable-stderr",
    // No mask — `--quiet` skips render in red mode too; stdout/stderr empty.
    // Probe-confirmed: bash exit 1 (no team.json → red), TS exit 1 (same).
    // Both sides agree on exit-1-on-red without BSD-sysexits divergence
    // because doctor's red path uses plain exit 1 (lib/doctor.sh:200 + the
    // TS doctor `process.exit(1)` per src/verbs/doctor.ts), NOT the
    // ConfigError → exit 78 path used by start/send/etc. Confirms the
    // green-vs-red exit-code agreement is the contract regardless of preset.
  },
  {
    verb: "cost",
    args: [],
    fixturePreset: "lifecycle",
    label: "cost [lifecycle: read-render + timezone mask] (ADR-030 row 6)",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: 2-pattern stdout mask combining (a) ADR-030 timezone-render class
      // — header ` — since 1970-01-01 01:00:00 (epoch 0)` (bash, host-local tz
      // via `date -d @0 +'%Y-%m-%d %H:%M:%S'`, lib/cost.sh:84) vs ` — since -
      // (epoch 0)` (TS, ADR-012 UTC-pin emits `-` placeholder when epoch=0,
      // src/verbs/cost.ts:411-416) — strip ` — since [^\n]+` so both header
      // lines collapse to `💰 cost (epoch 0)` post-mask; and (b) ADR-030
      // read-render class — per-row USD column padding divergence (bash
      // `$0         ` from `printf '%-12d'` for raw integer usd in
      // lib/cost.sh:88 vs TS `$0.0000    ` from `m.usd.toFixed(4)` per
      // cost.ts:397). Both renders pad to identical 11-char column width but
      // the textual content differs; mask `\$0(?:\.0+)?\s+(?=\d)` strips the
      // entire `$VALUE<padding>` segment up to the next column's leading digit
      // (the tokens count). Anchored with positive-lookahead so we don't eat
      // the tokens column. The TOTAL line `TOTAL: $0.0000` matches byte-for-
      // byte (both sides use `%.4f` there, lib/cost.sh:91 vs cost.ts:401) so
      // it survives the mask intact. /g flag for multiple per-row matches.
      stdout: / — since [^\n]+|\$0(?:\.0+)?\s+(?=\d)/g,
    },
  },
  // ADR-030 commit C: 4 read-only error-path rows (inbox usage / inbox config /
  // dashboard no-team / cost no-team). Reuses iter-2 error-rendering vocabulary
  // (ADR-027 §"error-rendering class") with two narrow extensions:
  //   - inbox usage row 7: TS USAGE_INBOX adds ` [--json]` suffix vs bash's
  //     bare `<member>` per lib/inbox.sh USAGE; mask absorbs the suffix on
  //     both sides via a literal `\[--json\]` strip alongside the standard
  //     `(💥 atmux usage: |atmux: usage: )` prefix mask.
  //   - inbox config row 8: TS adds `inbox: ` verb-name tag in ConfigError
  //     (`atmux: config: inbox: no such member …`) vs bash's bare config
  //     prefix; same pattern as the existing pause/resume/rotate no-such-
  //     member rows above (family c). The mask extends the optional
  //     `(?:pause: |resume: |rotate: )?` group to also accept `inbox: `.
  // Dashboard + cost no-team rows (9 + 10) reuse the standard 3-pattern
  // family-a mask shared with start/send/add-member/stop/etc — bash 💥
  // prefix vs TS structured-tag prefix + per-side fixture-clone path
  // suffix + `init` hint phrasing divergence. No new mask shape needed.
  {
    verb: "inbox",
    args: [],
    fixturePreset: "lifecycle",
    label: "inbox [lifecycle: usage error (no args)] (ADR-030 row 7)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 64 EX_USAGE (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 2-pattern mask (ADR-027 error-rendering class) — bash
      // `💥 atmux usage: ` vs TS `atmux: usage: ` prefix on the usage line +
      // strip ` [--json]` suffix that TS USAGE_INBOX includes (src/verbs/
      // inbox.ts) but bash USAGE in lib/inbox.sh omits (bash USAGE = "atmux
      // inbox <member>"). Post-mask both sides: "atmux inbox <member>\n".
      // Lifecycle preset required — bash inbox.sh:6 calls atmux::require_team
      // BEFORE the usage check, so minimal preset would fire the no-team
      // error class instead.
      stderr: /(💥 atmux usage: |atmux: usage: )| \[--json\]/g,
    },
  },
  {
    verb: "inbox",
    args: ["bogus"],
    fixturePreset: "lifecycle",
    label: "inbox bogus [lifecycle: no-such-member error] (ADR-030 row 8)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 1-pattern mask (ADR-027 error-rendering class — family c
      // shape) — bash `💥 atmux ` vs TS `atmux: config: inbox: ` prefix.
      // Bash dies via atmux::member_json without verb prefix per lib/common.sh;
      // TS adds verb-name tag in ConfigError what (src/verbs/inbox.ts).
      // Inline the optional `(?:inbox: )?` for inbox-specific verb tag.
      // Post-mask both sides: "no such member in team.json: bogus\n".
      stderr: /(💥 atmux |atmux: \S+: (?:inbox: )?)/g,
    },
  },
  {
    verb: "dashboard",
    args: [],
    fixturePreset: "minimal",
    label: "dashboard [minimal: no-team error] (ADR-030 row 9)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (ADR-027 error-rendering class — family a,
      // identical shape to start/send/add-member/stop/pause-foo/etc rows
      // above) — bash `💥 atmux ` vs TS `atmux: config: ` prefix + per-side
      // fixture-clone path suffix `.bash`/`.ts` before /.atmux/ + bash em-
      // dash vs TS parens hint phrasing on the `init` variant.
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  {
    verb: "cost",
    args: [],
    fixturePreset: "minimal",
    label: "cost [minimal: no-team error] (ADR-030 row 10)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (ADR-027 error-rendering class — family a,
      // same as dashboard row 9 above)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  // ADR-032 commit B (partial post-D18): 2 family-A cross-lane error
  // rows. Rows 1+2 (claim/dispatch task-not-found) deferred to D18 —
  // TS-side `claimTask` / `markTaskDone` (src/core/kanban.ts:225-261 +
  // 270+) call `updateJson` (WITH lock) for the existence check, leaving
  // a `.atmux/kanban.json.lock` sidecar that bash never creates (bash
  // dies BEFORE jq_update at lib/claim.sh:36 + lib/dispatch.sh:40). Real
  // fs-channel divergence; mask would be a presence-on-one-side
  // absorption which ADR-027 §4 anti-broad-mask rule bans. Re-enable on
  // up-impl hoisting the existence-check above the lock acquisition (see
  // ADR-032 Out-of-plan §D18). Probe-verified at .atmux/notes-adr-032-
  // research.md "Probe-rerun for ADR-032 amendments" + post-resume
  // parity-test run @2026-05-06 ~17:25 MYT.
  //
  // Rows 11 + 12 fire BEFORE claimTask is reached (member-paused via
  // dispatch.ts isPaused() check; member-not-in-team via dispatch.ts
  // teamMembers validation), so they don't trigger the lock-leak. Both
  // probe-clean Pattern A. Mirrors ADR-031 family-c precedent at line
  // 454 `(?:pause: |resume: |rotate: )?` shape.
  {
    verb: "dispatch",
    args: ["lead", "t-seed1", "--no-ping"],
    fixturePreset: "lifecycle",
    label: "dispatch lead t-seed1 --no-ping [lifecycle: member-paused error] (ADR-032 row 11)",
    expect: "exit-nonzero-stable-stderr",
    preState: {
      // reason: dispatch needs a pre-seeded todo task (else hits task-
      // not-found before the paused-check) — ADR-032 row 11
      ".atmux/kanban.json": {
        tasks: [{ id: "t-seed1", subject: "seeded", status: "todo", createdAt: 1700000000 }],
        epics: [],
        stories: [],
      },
      // reason: lead must be paused (state/paused.json drives the
      // member-paused error path in lib/dispatch.sh:35 +
      // src/verbs/dispatch.ts) — ADR-032 row 11
      ".atmux/state/paused.json": { lead: { at: 1700000000, reason: "manual" } },
    },
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: pure Pattern A prefix divergence (ADR-027 error-rendering
      // class). Both sides emit identical body `dispatch: lead is paused
      // — resume with \`atmux resume lead\`` after prefix strip — bash
      // and TS both include the `dispatch:` verb-tag in body here (per
      // lib/dispatch.sh:35 `atmux::die "dispatch: $m is paused …"` +
      // dispatch.ts ConfigError "dispatch: $m is paused …"). Probe-
      // verified at .atmux/notes-adr-032-research.md row 11.
      stderr: /(💥 atmux |atmux: config: )/g,
    },
  },
  {
    verb: "dispatch",
    args: ["no-such-member", "t-seed1", "--no-ping"],
    fixturePreset: "lifecycle",
    label:
      "dispatch no-such-member t-seed1 --no-ping [lifecycle: member-not-in-team error] (ADR-032 row 12)",
    expect: "exit-nonzero-stable-stderr",
    preState: {
      // reason: dispatch validates the <member> arg via member-exists
      // lookup (lib/dispatch.sh:40 + dispatch.ts teamMembers check). The
      // pre-seeded task ensures both sides hit the member-not-in-team
      // site for the same input regardless of internal check order —
      // ADR-032 row 12
      ".atmux/kanban.json": {
        tasks: [{ id: "t-seed1", subject: "seeded", status: "todo", createdAt: 1700000000 }],
        epics: [],
        stories: [],
      },
    },
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: Pattern A prefix divergence + TS-only `dispatch: `
      // verb-tag insertion (ADR-027 error-rendering class). Bash:
      // `💥 atmux no such member in team.json: no-such-member` (no
      // verb-tag); TS: `atmux: config: dispatch: no such member in
      // team.json: no-such-member` (TS ConfigError prepends `dispatch: `
      // verb-tag per dispatch.ts). Mask absorbs prefix on both sides +
      // optional `dispatch: ` on TS side. Mirrors ADR-031 family-c at
      // line 454 `(?:pause: |resume: |rotate: )?` shape. Probe-verified
      // at .atmux/notes-adr-032-research.md row 12.
      stderr: /(💥 atmux |atmux: config: (?:dispatch: )?)/g,
    },
  },
  // ADR-032 commit C: 5 cross-lane error rows mixing kanban subverb +
  // arg-parse paths (rows 6, 7, 8, 9, 10 per ADR-032 §1 row table).
  // Family B ("prefix + TS hint-line tail") covers rows 6, 7, 10; rows
  // 8 + 9 reclassify to family A pure prefix (probe-confirmed: row 8
  // TS USAGE has no `\n  ` continuation, row 9 already-exists is
  // ConfigError without USAGE).
  //
  // Mask design note: TS UsageError rendering at src/cli.ts:175 is
  // `atmux: ${ctx.what}\n` — verb-tag is body content, NOT a structured
  // tag separator. Mask strips bash `💥 atmux ` (9 chars) and TS
  // `atmux: ` (7 chars) ONLY; both sides retain verb-tag in body.
  // Earlier draft used `atmux: \S+: ` which over-stripped TS asymmetric
  // (probe-confirmed 2026-05-06 ~17:48 MYT on rows 6, 10).
  {
    verb: "task",
    args: ["bogus"],
    fixturePreset: "lifecycle",
    label: "task bogus [lifecycle: unknown-subverb error] (ADR-032 row 6)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 64 EX_USAGE (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: family B mask (ADR-027 error-rendering class) — prefix
      // divergence + TS-only hint-line tail. Bash: `💥 atmux task:
      // unknown verb: bogus (use add|list|show|move|assign|rm)`; TS:
      // `atmux: task: unknown verb: bogus (...)\n  atmux task <add|
      // list|show|move|assign|rm> [args] (...)`. Hint-line `\n  atmux
      // task <…>` is TS-only (UsageError ctx.hint at src/cli.ts:178).
      // Probe-verified at .atmux/notes-adr-032-research.md row 6
      // (probe id 16).
      stderr: /(💥 atmux |atmux: )|\n {2}atmux task <[^\n]+/g,
    },
  },
  {
    verb: "task",
    args: ["add"],
    fixturePreset: "lifecycle",
    label: "task add [lifecycle: missing-subject error] (ADR-032 row 7)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 64 EX_USAGE (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: family B mask (ADR-027 error-rendering class) — prefix
      // divergence + TS-only hint-line tail. Bash: `💥 atmux task add:
      // <subject> required`; TS: `atmux: task add: <subject>
      // required\n  atmux task add <subject> [--body T] [--assignee M]
      // [--deps a,b] [--priority N]`. Hint-line `\n  atmux task add
      // <…>` is TS-only. Probe-verified at .atmux/notes-adr-032-
      // research.md row 7 (probe id 15).
      stderr: /(💥 atmux |atmux: )|\n {2}atmux task add <[^\n]+/g,
    },
  },
  {
    verb: "task",
    args: ["show"],
    fixturePreset: "lifecycle",
    label: "task show [lifecycle: missing-id error] (ADR-032 row 8)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 64 EX_USAGE (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: family A pure prefix (ADR-027 error-rendering class) —
      // probe-confirmed reclassify from B to A: TS USAGE for `task show`
      // doesn't include the `\n  ` hint-line continuation other subverbs
      // have (probe-verified at .atmux/notes-adr-032-research.md row 8 +
      // ADR-032 deferred-row D17). Both sides emit identical body
      // `task show: <id> required` after prefix strip.
      stderr: /(💥 atmux |atmux: )/g,
    },
  },
  {
    verb: "add-member",
    args: ["lead"],
    fixturePreset: "lifecycle",
    label: "add-member lead [lifecycle: already-exists error] (ADR-032 row 9)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: family A pure prefix (ADR-027 error-rendering class).
      // Lifecycle preset already has `lead` in team.json, so re-adding
      // hits the already-exists path on both sides. Bash dies via
      // atmux::die `add-member: 'lead' is already in team.json`; TS
      // throws ConfigError rendered as `atmux: config: add-member:
      // 'lead' is already in team.json` (src/cli.ts:182 routes
      // AtmuxError as `atmux: <tag>: <message>`). Both sides body
      // `add-member: 'lead' is already in team.json` after prefix strip.
      // Probe-verified at .atmux/notes-adr-032-research.md row 9 NEW
      // (substituted from D15 send-bogus deferral).
      stderr: /(💥 atmux |atmux: config: )/g,
    },
  },
  {
    verb: "add-member",
    args: ["--bogus"],
    fixturePreset: "lifecycle",
    label: "add-member --bogus [lifecycle: unknown-flag error] (ADR-032 row 10)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 64 EX_USAGE (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: family B mask (ADR-027 error-rendering class) — prefix
      // divergence + TS-only hint-line tail. Bash: `💥 atmux add-member:
      // unknown flag: --bogus`; TS: `atmux: add-member: unknown flag:
      // --bogus\n  usage: atmux add-member <name> [--role <role>] [--tui
      // <tui>] [--model <model>] [--cwd <cwd>] [--command <command>]`.
      // Hint-line `\n  usage: atmux add-member …` is TS-only. Probe-
      // verified at .atmux/notes-adr-032-research.md row 10.
      stderr: /(💥 atmux |atmux: )|\n {2}usage: atmux add-member [^\n]+/g,
    },
  },
  // ADR-032 commit D: 3 cross-lane error rows for usage-line divergence
  // (rows 3, 4, 5 per ADR-032 §1 row table). Family A (#3 pure prefix —
  // both sides keep `usage:` body) + family C (#4 + #5 per-side
  // usage-line literal divergence — TS adds flag-suffix that bash USAGE
  // omits, narrow per-row regex per ADR-027 §4 cite-locality).
  //
  // Coverage by mask shape:
  //   - Row 3: tell-lead missing-msg (lib/tell.sh:16 USAGE_TELL_LEAD +
  //     src/verbs/tell-lead.ts:86 USAGE) — both sides emit `usage:
  //     atmux tell-lead <msg...>` body, only prefix differs (family A).
  //   - Row 4: dispatch missing-args (lib/dispatch.sh:27 +
  //     src/verbs/dispatch.ts USAGE) — bash USAGE = `atmux dispatch
  //     <member> <task-id>`; TS adds ` [--no-ping]` flag-suffix
  //     (family C, narrow per-row strip).
  //   - Row 5: handoff missing-args (lib/handoff.sh:36 +
  //     src/verbs/handoff.ts USAGE) — bash USAGE = `atmux handoff
  //     <from> <to> [--reason <text>]`; TS adds ` [--no-native]
  //     [--pause-from]` flag-suffix (family C, narrow per-row strip).
  //
  // Note row 4 + 5 mask asymmetry: bash USAGE wraps with `usage: ` body
  // (lib/common.sh::usage prepends it); TS USAGE constants for these
  // verbs DON'T include the literal `usage: ` substring — so mask
  // strips `💥 atmux usage: ` from bash AND `atmux: ` from TS,
  // collapsing both sides to `atmux <verb> <args> [...]`. Row 3 keeps
  // `usage:` body on both sides because TS USAGE for tell-lead DOES
  // start with `usage:` literal (probe-verified). All probe-verified
  // at .atmux/notes-adr-032-research.md "Probe-rerun for ADR-032
  // amendments" rows 3, 4, 5.
  {
    verb: "tell-lead",
    args: [],
    fixturePreset: "lifecycle",
    label: "tell-lead [lifecycle: missing-msg error] (ADR-032 row 3)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 64 EX_USAGE (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: family A pure prefix (ADR-027 error-rendering class) —
      // both sides emit identical body `usage: atmux tell-lead <msg...>`
      // after prefix strip. Bash: `💥 atmux usage: atmux tell-lead
      // <msg...>`; TS: `atmux: usage: atmux tell-lead <msg...>`. TS
      // USAGE constant at src/verbs/tell-lead.ts:86 starts with `usage:`
      // literal (unlike dispatch/handoff USAGE which omit it), so this
      // row stays family A. Probe-verified at .atmux/notes-adr-032-
      // research.md row 3.
      stderr: /(💥 atmux |atmux: )/g,
    },
  },
  {
    verb: "dispatch",
    args: [],
    fixturePreset: "lifecycle",
    label: "dispatch [lifecycle: missing-args error] (ADR-032 row 4)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 64 EX_USAGE (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: family C per-side usage-line literal divergence (ADR-027
      // error-rendering class). Bash: `💥 atmux usage: atmux dispatch
      // <member> <task-id>` (lib/common.sh::usage prepends `usage: `);
      // TS: `atmux: atmux dispatch <member> <task-id> [--no-ping]` (TS
      // USAGE constant at src/verbs/dispatch.ts has no `usage:` literal
      // and includes ` [--no-ping]` flag suffix). Mask strips bash
      // `💥 atmux usage: ` (16 chars) and TS `atmux: ` (7 chars) +
      // narrow per-row TS-side ` [--no-ping]` flag-suffix elision per
      // ADR-027 §4 cite-locality. Both sides reduce to `atmux dispatch
      // <member> <task-id>`. Probe-verified at .atmux/notes-adr-032-
      // research.md row 4.
      stderr: /(💥 atmux usage: |atmux: )| \[--no-ping\]/g,
    },
  },
  {
    verb: "handoff",
    args: [],
    fixturePreset: "lifecycle",
    label: "handoff [lifecycle: missing-args error] (ADR-032 row 5)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 64 EX_USAGE (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: family C per-side usage-line literal divergence (ADR-027
      // error-rendering class). Bash: `💥 atmux usage: atmux handoff
      // <from> <to> [--reason <text>]`; TS: `atmux: atmux handoff
      // <from> <to> [--reason <text>] [--no-native] [--pause-from]` (TS
      // USAGE constant at src/verbs/handoff.ts has no `usage:` literal
      // and includes ` [--no-native] [--pause-from]` flag-suffix). Mask
      // strips bash `💥 atmux usage: ` (16 chars) and TS `atmux: ` (7
      // chars) + narrow per-row TS-side ` [--no-native] [--pause-from]`
      // flag-suffix elision per ADR-027 §4 cite-locality. Both sides
      // reduce to `atmux handoff <from> <to> [--reason <text>]`. Probe-
      // verified at .atmux/notes-adr-032-research.md row 5.
      stderr: /(💥 atmux usage: |atmux: )| \[--no-native\] \[--pause-from\]/g,
    },
  },
  // ADR-028 commit 4: 3 full-parity cron-fired rows.
  //
  // Row 1: `report --no-discord` on `lifecycle` (empty kanban). Exercises
  //   the report verb's stdout body builder Shipped:0 + In-progress (none)
  //   branches. `--no-discord` sidesteps the bash-recorder gap (bash side
  //   doesn't honour ATMUX_DISCORD_RECORDER yet per
  //   intercept-discord.ts:14-20). Both sides write `state/last-report.epoch`
  //   post-invocation; the value is a Unix epoch that may differ by one
  //   second across the parallel spawn — masked via stateAfter (commit-4
  //   compare.ts extension wires non-JSON files through the same mask
  //   path as JSON files, anchored on the file's full basename glob stem).
  //
  // Row 2: `report --no-discord` on `cron-tasks` (mixed kanban + 1 open ask).
  //   Exercises ALL 4 body sections (Shipped + In-progress + Blocked + Open
  //   asks). Pre-seeded kanban shape from `cron-tasks` preset (1 done + 1
  //   in-progress + 1 blocked + 1 driver-inbox open ask). Same mask shape
  //   as row 1 — only the body content differs.
  //
  // Row 3: `whip` on `minimal` (no team — refuses early). Both sides die
  //   on require_team / requireTeam → exit-code class divergence (bash 1
  //   vs TS 78 EX_CONFIG, ADR-006). Same 3-pattern stderr mask family as
  //   the existing start/send/add-member no-team rows above.
  {
    verb: "report",
    args: ["--no-discord"],
    fixturePreset: "lifecycle",
    label:
      "report --no-discord [lifecycle: empty kanban, Shipped:0 + In-progress (none)] (ADR-028 row 1)",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: bash atmux::log "report: ..." trace lines on stderr (atmux::log
      // writes to stderr unconditionally per lib/common.sh) not emitted by TS
      // (TS routes equivalent traces to .atmux/logs/report.log via append-mode,
      // not stderr). ADR-027 error-rendering class.
      stderr: /^atmux: report: [^\n]*\n/gm,
      stateAfter: {
        // reason: Unix epoch per invocation; non-JSON file (plain text). ADR-027
        // state-after class. Glob stem `last-report.epoch` matches the file's
        // full basename; commit-4 compare.ts extension applies the regex to
        // byte content for non-JSON files.
        "last-report.epoch.value": /^\d{10,}\n?$/,
      },
    },
  },
  {
    verb: "report",
    args: ["--no-discord"],
    fixturePreset: "cron-tasks",
    label:
      "report --no-discord [cron-tasks: mixed kanban (Shipped+In-progress+Blocked+open ask)] (ADR-028 row 2)",
    expect: "exit-zero-stable-stdout",
    mask: {
      // reason: same as report row 1 — bash atmux::log trace lines on stderr (ADR-027 error-rendering class)
      stderr: /^atmux: report: [^\n]*\n/gm,
      stateAfter: {
        // reason: same as report row 1 — Unix epoch on non-JSON last-report.epoch (ADR-027 state-after class)
        "last-report.epoch.value": /^\d{10,}\n?$/,
      },
    },
  },
  {
    verb: "whip",
    args: [],
    fixturePreset: "minimal",
    label: "whip [minimal: no-team error] (ADR-028 row 3)",
    expect: "exit-nonzero-stable-stderr",
    mask: {
      // reason: bash exit 1 vs TS exit 78 EX_CONFIG (ADR-006 BSD sysexits)
      exitCode: true,
      // reason: 3-pattern mask (family a — same as start/send/add-member no-team rows) —
      // bash `💥 atmux ` vs TS `atmux: <tag>: ` prefix (ADR-027 error-rendering class) +
      // per-side fixture-clone path suffix `.bash` / `.ts` before /.atmux/ (commit 3
      // cloning artefact) + bash em-dash vs TS parens hint phrasing (ADR-027 error-
      // rendering class)
      stderr:
        /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
  // ADR-028 commit 5: 6 bash-only baseline rows for cron-fired verbs whose
  // TS port is absent (decisions, groom — see ADR-028 §F2-corrected).
  //
  // Mechanism: ParityRow.bashOnly + ParityRow.bashBin (ADR-028 commit 3,
  // landed @76bd071). Per-row bashBin points at parent atmux's
  // /root/work/src/atmux/bin/atmux — the bash impl exists in the parent
  // tree but was excluded from worktree-bun's lib/ per ADR-022/026 carve-
  // out. Capture goldens via ATMUX_PARITY_UPDATE_GOLDENS=1 against the
  // checked-in tests/parity/golden/<row-id>.txt path.
  //
  // Auto-promotion path: when src/verbs/{decisions,groom}.ts land in
  // Phase 4b, parity-cron-impl removes `bashOnly: true` from each row and
  // the test flips to full bash↔TS parity. Goldens become redundant (or
  // historical baseline in tests/parity/golden/archive/ if useful).
  //
  // Stdout-only contract: bash-only rows compare against golden via
  // compareGolden which reads stdout only (compare.test.ts §"stderr / fs
  // / discord channels are NOT compared (bash-only contract)"). For
  // groom and decisions-digest's 1-entry / over-threshold scenarios,
  // stdout is empty (output via atmux::log to stderr or via discord).
  // The empty-golden baseline still catches: exit-code regression,
  // unexpected stdout emission, and verb-not-found regressions.
  //
  // Preset choice: ADR-028 §Decision specs cron-tasks-decisions for the
  // 3 decisions rows and cron-tasks-groom for the 3 groom rows. The
  // groom "clean" row deviates to `lifecycle` preset because preState
  // is write-only (cannot delete the cron-tasks-groom preset's 7 .bak
  // files); the "orphaned" row also uses lifecycle for the same reason.
  // Only the "over-threshold archive" row uses cron-tasks-groom natively.
  // Documented as iter-2 deferral handle: when a `preState.delete` field
  // or `cron-tasks-groom-clean` preset lands, all 3 groom rows
  // standardise on cron-tasks-groom.
  //
  // Decisions: all 3 rows on cron-tasks-decisions preset. Empty case
  // uses preset defaults (empty decisions.md + cursor=0); 1-entry and
  // over-threshold inject decisions via preState writing the markdown
  // body verbatim (preState handles strings as raw content per
  // pre-state.ts:46). Timestamps are fixed literals 1700000001+ so the
  // golden is stable across captures.
  {
    verb: "decisions",
    args: ["digest"],
    fixturePreset: "cron-tasks-decisions",
    label:
      "decisions digest [cron-tasks-decisions: empty pending — no new since cursor] (ADR-028 row 5a)",
    expect: "exit-zero-stable-stdout",
    bashOnly: true,
    bashBin: "/root/work/src/atmux/bin/atmux",
  },
  {
    verb: "decisions",
    args: ["digest"],
    fixturePreset: "cron-tasks-decisions",
    label:
      "decisions digest [cron-tasks-decisions: 1-entry — digest sent via discord, empty stdout] (ADR-028 row 5b)",
    expect: "exit-zero-stable-stdout",
    bashOnly: true,
    bashBin: "/root/work/src/atmux/bin/atmux",
    preState: {
      // reason: 1 valid decision entry with fixed timestamp > cursor (=0).
      // Format mirrors lib/decisions.sh:_decisions_to_json_array awk
      // grammar (### d-<id> + bulleted **timestamp** / **question** /
      // **default** / **reversibility**). Stdout: empty (digest body
      // posts via atmux::discord_embed_ping → ATMUX_DISCORD_WEBHOOK=""
      // sandbox early-returns + atmux::log on stderr); stderr unchecked
      // by compareGolden contract.
      ".atmux/decisions.md":
        "# atmux decisions — append-only log\n\n### d-aaaa0001\n- **timestamp**: 1700000001\n- **question**: test question 1\n- **default**: test answer 1\n- **reversibility**: low\n",
    },
  },
  {
    verb: "decisions",
    args: ["digest"],
    fixturePreset: "cron-tasks-decisions",
    label:
      "decisions digest [cron-tasks-decisions: 6 entries over-threshold — multi-chunk digest, empty stdout] (ADR-028 row 5c)",
    expect: "exit-zero-stable-stdout",
    bashOnly: true,
    bashBin: "/root/work/src/atmux/bin/atmux",
    preState: {
      // reason: 6 valid decisions exercises the over-threshold branch in
      // lib/decisions.sh:_atmux_decisions_digest (atmux::ok "decisions:
      // digest sent ($n decisions)" path with n=6 — but stderr; stdout
      // remains empty per the discord-routed body). Fixed sequential
      // timestamps 1700000001..1700000006 keep the golden stable.
      ".atmux/decisions.md":
        "# atmux decisions — append-only log\n\n" +
        "### d-aaaa0001\n- **timestamp**: 1700000001\n- **question**: q1\n- **default**: a1\n- **reversibility**: low\n\n" +
        "### d-aaaa0002\n- **timestamp**: 1700000002\n- **question**: q2\n- **default**: a2\n- **reversibility**: medium\n\n" +
        "### d-aaaa0003\n- **timestamp**: 1700000003\n- **question**: q3\n- **default**: a3\n- **reversibility**: high\n\n" +
        "### d-aaaa0004\n- **timestamp**: 1700000004\n- **question**: q4\n- **default**: a4\n- **reversibility**: low\n\n" +
        "### d-aaaa0005\n- **timestamp**: 1700000005\n- **question**: q5\n- **default**: a5\n- **reversibility**: medium\n\n" +
        "### d-aaaa0006\n- **timestamp**: 1700000006\n- **question**: q6\n- **default**: a6\n- **reversibility**: low\n",
    },
  },
  // Groom: ADR-028 §Decision specs all 3 on cron-tasks-groom; clean +
  // orphaned-task fall back to lifecycle preset because preState cannot
  // delete the cron-tasks-groom preset's 7 .bak files. Over-threshold
  // uses cron-tasks-groom natively (the dirty preset shape IS the
  // scenario). All 3 expected stdout: empty (groom output is entirely
  // via atmux::log to stderr per lib/groom.sh; stderr unchecked).
  {
    verb: "groom",
    args: ["--dry-run"],
    fixturePreset: "lifecycle",
    label:
      "groom --dry-run [lifecycle: clean kanban — nothing to sweep, empty stdout] (ADR-028 row 6a)",
    expect: "exit-zero-stable-stdout",
    bashOnly: true,
    bashBin: "/root/work/src/atmux/bin/atmux",
  },
  {
    verb: "groom",
    args: ["--dry-run"],
    fixturePreset: "lifecycle",
    label:
      "groom --dry-run [lifecycle: orphaned-task kanban — story refs nonexistent epic, empty stdout] (ADR-028 row 6b)",
    expect: "exit-zero-stable-stdout",
    bashOnly: true,
    bashBin: "/root/work/src/atmux/bin/atmux",
    preState: {
      // reason: orphaned-task scenario for groom's zombie-sweep / kanban
      // hygiene path. Story `s-orphan` references epic `e-missing` that
      // doesn't exist in epics[]; lib/groom.sh's zombie-sweep walks
      // story.epicID → epics[*].id and reports orphans. Fixed deterministic
      // ids + epoch literal keep the golden stable.
      ".atmux/kanban.json": {
        tasks: [],
        epics: [],
        stories: [
          {
            id: "s-orphan01",
            title: "orphaned story",
            epicID: "e-missing01",
            status: "ready",
            createdAt: 1700000000,
          },
        ],
      },
    },
  },
  {
    verb: "groom",
    args: ["--dry-run"],
    fixturePreset: "cron-tasks-groom",
    label:
      "groom --dry-run [cron-tasks-groom: archived inbox tail + 7 .baks + old done — flush+summarize+cull paths, empty stdout] (ADR-028 row 6c)",
    expect: "exit-zero-stable-stdout",
    bashOnly: true,
    bashBin: "/root/work/src/atmux/bin/atmux",
  },
];
