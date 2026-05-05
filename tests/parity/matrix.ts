// ADR-009: Test strategy — parity matrix.
//
// One row per (verb, args, fixture-preset) combination the harness
// exercises. `index.test.ts` iterates this array and runs runner+compare
// per row. Phase 0 ships an empty matrix; rows are added incrementally
// as verbs land in Phase 2.

/**
 * Fixture preset names. The factory under `tests/parity/fixtures/`
 * publishes these once it lands (Phase 1, after ADR-005 ratifies schemas).
 *   - `minimal`     — 2-member team, empty kanban, no inboxes
 *   - `lifecycle`   — 4-member template mirroring tests/e2e/lifecycle.bats
 *   - `multi-team`  — state shapes for atmux / sopx-mvp / ifca_aux / unum
 */
export type FixturePreset = "minimal" | "lifecycle" | "multi-team";

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
      stderr: /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
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
      stderr: /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
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
      stderr: /(💥 atmux |atmux: \S+: )|(\.bash|\.ts)(?=\/\.atmux\/)|(?: — | \(hint: )run 'atmux init' first\)?/g,
    },
  },
];
