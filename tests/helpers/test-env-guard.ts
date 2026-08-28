// tests/helpers/test-env-guard.ts — bun preload (bunfig.toml `[test] preload`).
//
// The tripwire half of ADR-283. `scripts/test.ts` is the wall: it builds
// the runner's environment from an allowlist, so credentials are not in
// the process at all. This runs INSIDE the runner, however it was
// started, and refuses when that wall was walked around.
//
// It REFUSES rather than scrubs, and that is not squeamishness — it
// cannot scrub. Measured on bun 1.3.14: `Bun.spawn`/`Bun.spawnSync`
// called without an explicit `env` use the environment as it stood at
// process start, not the live `process.env`. A `delete process.env.X`
// here would therefore leave `Bun.spawnSync({ cmd: ["env"] })` — the very
// shape that walks through ADR-282's source matcher — still dumping X.
// Half a defence advertised as a whole one is what ADR-283 exists to
// stop repeating.
//
// Same shape as sandbox-guard.ts, its neighbour in this directory: a hard
// refusal with one documented, deliberate override.

import { countCredentialShapedNames, TEST_ENV_OK_VAR } from "./test-env.ts";

if (process.env[TEST_ENV_OK_VAR] !== "1") {
  const n = countCredentialShapedNames(process.env);
  if (n > 0) {
    // A COUNT, never the names. The names alone tell an attacker which
    // services this box holds credentials for, and the whole point of
    // this file is to stop the environment describing itself in a log.
    process.stderr.write(
      [
        "",
        "🛑 ABORTED: `bun test` against an environment carrying credentials.",
        `   ${n} variable name(s) here match the credential pattern (ADR-283).`,
        "",
        "   A failing assertion prints its received value in full. On 2026-08-28",
        "   that turned one red test into ~180 live tokens, passwords and webhook",
        "   URLs in a test log and an agent transcript.",
        "",
        "   Safe form — builds the runner's environment from an allowlist:",
        "     • bun run test                      (or: bun scripts/test.ts)",
        "     • bun scripts/test.ts ./tests/unit/foo.test.ts   (args pass through)",
        "",
        `   Override — only if you understand the risk:  ${TEST_ENV_OK_VAR}=1 bun test …`,
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
}
