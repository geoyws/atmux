#!/usr/bin/env bun
// The repository's test entrypoint (ADR-283).
//
// Runs `bun test` with an environment built from an allowlist, so the
// live API tokens, database passwords and webhook URLs the operator's
// `.zshrc` sources into every shell are NOT PRESENT in the runner process
// at all. A test cannot leak a variable that is not there, whatever shape
// it uses to look — which is why this, and not a pattern that recognises
// "unfiltered env capture" in source code, is the defence.
//
// Everything decision-shaped lives in `tests/helpers/test-env.ts`, which
// is inside biome's `files.includes` and has its own unit tests. This file
// is deliberately thin, because `scripts/` is NOT linted (a pre-existing
// gap; ADR-283 §Out of scope). It IS scanned by
// `tests/regression/no-unfiltered-env-dump.test.ts`.
//
// Arguments pass straight through:  bun scripts/test.ts ./tests/unit/x.test.ts
// CI uses the same door:            bun scripts/test.ts --coverage …

import {
  countCredentialShapedNames,
  parsePassthrough,
  scrubTestEnv,
  TEST_ENV_OK_VAR,
  TEST_ENV_PASSTHROUGH_VAR,
} from "../tests/helpers/test-env.ts";

const passthrough = parsePassthrough(process.env[TEST_ENV_PASSTHROUGH_VAR]);
const { env, keptCount, removedCount, passedThrough } = scrubTestEnv(process.env, passthrough);

// The runner must not refuse itself — the tripwire preload fires on an
// unvetted environment, and this IS the vetting.
//
// Conditional, deliberately. Vouching unconditionally would make the two
// layers one: a `scrubTestEnv` that regressed into a pass-through would
// still be waved past by its own marker. Asking the same question the
// preload asks, and staying silent when the answer is wrong, is what
// keeps them independent — so a regression here surfaces as the preload's
// refusal rather than as a silent hole. It also means a passthrough that
// admits a credential-shaped name still has to be accepted a second time,
// by hand, which is the right price for deliberately putting one back.
const stillCredentialShaped = countCredentialShapedNames(env);
if (stillCredentialShaped === 0) {
  env[TEST_ENV_OK_VAR] = "1";
}

// A receipt, so a green run is evidence the filter ran. COUNTS ONLY —
// printing the removed names would re-create a smaller version of the
// disclosure this exists to prevent. The escape hatch is the one thing
// named out loud, because an unlogged widening is a hole.
process.stderr.write(
  `test-env: ${keptCount} variables passed to the runner, ${removedCount} withheld (ADR-283)\n`,
);
if (passedThrough.length > 0) {
  process.stderr.write(
    `test-env: ${TEST_ENV_PASSTHROUGH_VAR} admitted: ${passedThrough.join(", ")}\n`,
  );
}
if (stillCredentialShaped > 0) {
  process.stderr.write(
    `test-env: ${stillCredentialShaped} credential-shaped name(s) remain — not vouching for this ` +
      `environment; the preload will refuse unless ${TEST_ENV_OK_VAR}=1 is set by hand\n`,
  );
}

const child = Bun.spawn({
  cmd: [process.execPath, "test", ...process.argv.slice(2)],
  cwd: process.cwd(),
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    child.kill(sig);
  });
}

await child.exited;
process.exit(child.exitCode ?? 1);
