// tests/helpers/sandbox-guard.ts — bun preload (wired via bunfig.toml `[test] preload`).
//
// Refuses to run `bun test` inside an atmux cage tmux server unless the
// operator explicitly opts out via ATMUX_CAGE_TEST_OK=1.
//
// This is the bun-runtime mirror of the zsh interactive-shell guard at
// `~/.zshrc`. The shell guard catches direct interactive invocations but
// is bypassed by:
//   - `pnpm test` / `bun run test` (package-script wrappers)
//   - Claude's Bash tool (non-interactive subshells that don't load
//     `.zshrc`'s interactive functions)
//   - cron / CI
//
// This preload runs INSIDE the test runner regardless of how it was
// invoked, so it catches every invocation path.
//
// Origin: 2026-05-12 atmux team starvation cycle — three rounds of cage
// death within an hour. The third round's `events.jsonl` showed test-
// style `--bogus-flag` invocations consistent with `bun test` against
// live state. Per CLAUDE.md L298 stash-collision class — concurrent ops
// on a shared working tree (or shared tmux server) kill each other.

const tmuxEnv = process.env.TMUX;
const cageOk = process.env.ATMUX_CAGE_TEST_OK;
const insideTmux = typeof tmuxEnv === "string" && tmuxEnv.length > 0;

if (insideTmux && cageOk !== "1") {
  // $TMUX is `<socket-path>,<server-pid>,<session-id>` — extract socket.
  const socket = tmuxEnv.split(",")[0] ?? "";
  // Heuristic: an atmux cage socket either lives under /tmp/atmux-<team>/
  // (ADR-018 default) OR under <repo>/.atmux/tmux/ (per-team tmuxTmpdir,
  // current convention). Either pattern matches.
  const isCageSocket = socket.includes("/atmux-") || socket.includes(".atmux/tmux");
  if (isCageSocket) {
    const msg = [
      "",
      "🛑 ABORTED: `bun test` inside an atmux cage tmux server.",
      `   socket: ${socket}`,
      "",
      "   Running tests inside the cage risks killing the cage server (3 incidents",
      "   on 2026-05-12 demo-prep cycle). The cage's claude TUIs lose all context.",
      "",
      "   Safe forms (ADR-283: `bun run test` / `bun scripts/test.ts`, not a bare",
      "   `bun test` — it builds the runner's environment from an allowlist so no",
      "   credential is present for a failing assertion to print):",
      "     • unset TMUX && bun run test ...      (recommended — runs outside cage)",
      "     • ATMUX_CAGE_TEST_OK=1 bun run test ...  (override — only if you understand the risk)",
      "",
      "   See ADR-081 + ADR-085 + ~/.zshrc's bun-test guard for context.",
      "",
    ].join("\n");
    process.stderr.write(msg);
    process.exit(1);
  }
}
