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
];
