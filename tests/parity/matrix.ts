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
        tasks: [
          { id: "t-seed1", subject: "seeded", status: "todo", createdAt: 1700000000 },
        ],
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
        tasks: [
          { id: "t-seed2", subject: "seeded-2", status: "todo", createdAt: 1700000000 },
        ],
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
];
