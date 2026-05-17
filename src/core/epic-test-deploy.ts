// ADR-144 §Deployed mode T4 (t-66a237cd): branch-staging test-runner
// for the epic-team test-gate. Sibling of epic-test-cage.ts — the
// cage runner provisions a fresh tmpdir + runs `bun test` in
// isolation; this runner assumes a branch-staging URL is already
// deployed (per the lifecycle below) and runs e2e against
// `E2E_BASE_URL`.
//
// Lifecycle per ADR-144 §Mode-A-deployed:
//
//   - Deploy fires ONCE at `spawn-epic` (ADR-090). Production deploy
//     hook (separate ADR-090 wiring task) invokes
//     {@link deployBranchStaging} with the resolved URL + the
//     epic-team's worktree on hax (e.g. `/root/work/ifca/deployments/
//     sopx-e-XXXX/`).
//   - Test-gate fires PER merge attempt. The cron tick (or
//     event-driven trigger) routes through
//     `ready_to_merge → tested` and invokes {@link runDeployedTestGate}
//     which runs the configured `testCommand` (default `pnpm e2e`)
//     against `E2E_BASE_URL=https://${composedUrl}` with retryOnFlake.
//     Deploy is NOT re-run per attempt — the long-lived branch-staging
//     URL persists across the epic-team's lifetime.
//   - Teardown fires ONCE at `dissolve-epic` (ADR-091 `dissolved`
//     state). Production teardown hook invokes
//     {@link teardownDeployment}.
//
// URL pattern per ADR-144: `${product}-${dev-suffix}-${epic-name}-
// staging.ifca.app`. Wildcard `*.ifca.app → hax` + wildcard TLS are
// pre-existing per global CLAUDE.md §DNS, so new epic-team URLs work
// without per-host DNS or cert provisioning. The wildcard-DNS probe
// {@link checkWildcardDns} validates this assumption before the deploy
// fires, so a misconfigured DNS surfaces at spawn-epic time rather than
// at the first failed merge attempt.
//
// Caller wiring lives in `src/verbs/epic-merge.ts` (T4 §verb-layer):
// the `defaultTestGate` selector reads `team.epicTeam.testGateMode`
// and binds either the cage runner or this module's
// {@link runDeployedTestGate} into `EpicMergeContext.testGate`.
//
// Why "scripts/deploy.sh" lives in the per-product repo (not atmux):
// per global CLAUDE.md §IFCA, each IFCA product (sopx, aix, etc.)
// ships its own `scripts/deploy.sh branch-staging` that knows how to
// build + push that product. atmux's role is to compose the URL,
// validate DNS, invoke the per-product script with the right env, and
// run the test command. The atmux self-team uses cage mode (no
// deploy) — only IFCA products opt into deployed mode.

import { type SpawnOpts, type SpawnResult, spawn as defaultSpawn } from "../abstractions/spawn.ts";
import type { TestOutcome } from "./branch-merge-state.ts";
import { tokenizeTestCommand } from "./epic-test-cage.ts";

/** Test-injection seam — mirrors {@link CageSpawn} from
 *  epic-test-cage.ts so unit tests share fixture shapes. Production
 *  callers default to {@link defaultSpawn}. */
export type DeploySpawn = (opts: SpawnOpts) => Promise<SpawnResult>;

// ---------- URL composition ----------

/** Required substitutions for {@link composeStagingUrl}. Production
 *  callers resolve `product` from the IFCA product team's `team.name`
 *  prefix (e.g. `sopx` from `sopx-geoyws`), `devSuffix` from the
 *  parent team's `<dev>` segment (e.g. `geoyws`), and `epicName` from
 *  the epic-team's name without the `e-` prefix (e.g. `03919b3b` from
 *  `e-03919b3b`). The trio composes into the wildcard subdomain
 *  pattern `${product}-${devSuffix}-${epicName}-staging.ifca.app`. */
export interface StagingUrlVars {
  product: string;
  devSuffix: string;
  epicName: string;
}

/** Expand `${product}` / `${dev-suffix}` / `${epic-name}` placeholders
 *  in `template`. Pure — no I/O. Matches the ADR-144 §Config shape's
 *  documented template variables; both hyphenated (`${dev-suffix}`)
 *  and camel-cased (`${devSuffix}`) forms are accepted so per-product
 *  templates can match either convention without surprise.
 *
 *  Unrecognized placeholders are LEFT VERBATIM — operators may layer
 *  additional shell-expansion placeholders that the deploy script
 *  expands. The atmux layer only owns the three documented variables.
 *  Throws on empty template or empty substitution value (a missing
 *  product/devSuffix/epicName would compose into a malformed URL like
 *  `--staging.ifca.app` and the wildcard-DNS probe wouldn't catch it). */
export function composeStagingUrl(template: string, vars: StagingUrlVars): string {
  if (template.length === 0) {
    throw new Error("composeStagingUrl: empty template");
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v.length === 0) {
      throw new Error(`composeStagingUrl: empty ${k} (would compose a malformed URL)`);
    }
  }
  return template
    .replaceAll("${product}", vars.product)
    .replaceAll("${dev-suffix}", vars.devSuffix)
    .replaceAll("${devSuffix}", vars.devSuffix)
    .replaceAll("${epic-name}", vars.epicName)
    .replaceAll("${epicName}", vars.epicName);
}

// ---------- Wildcard DNS probe ----------

/** Result of {@link checkWildcardDns}. `resolved` is `true` iff the
 *  hostname produced at least one A/AAAA record; `output` carries the
 *  raw resolver tool stdout for operator surfacing on failure. */
export interface DnsCheckResult {
  resolved: boolean;
  output: string;
}

/** Verify that the composed staging URL resolves via the wildcard DNS
 *  pattern (`*.ifca.app → hax` per global CLAUDE.md §DNS). Uses `dig
 *  +short` for a deterministic exit code + minimal output; missing
 *  `dig` falls back to `getent hosts` (libc resolver) so the probe
 *  works on minimal base images that ship without `dig`.
 *
 *  Returns `{ resolved: true }` if the resolver produced ANY non-empty
 *  output — wildcard DNS guarantees a synthesized A record for any
 *  subdomain of the configured zone, so a non-empty answer is the
 *  positive signal. `resolved: false` on empty output OR resolver
 *  non-zero exit (treated as caller-recoverable, not a throw). */
export async function checkWildcardDns(
  hostname: string,
  spawn: DeploySpawn = defaultSpawn,
): Promise<DnsCheckResult> {
  // Try `dig +short` first — most precise + the standard tool on hax.
  try {
    const r = await spawn({
      cmd: "dig",
      argv: ["+short", hostname],
      timeoutMs: 5_000,
      expectExitCode: "any",
    });
    if (r.exitCode === 0 && r.stdout.trim().length > 0) {
      return { resolved: true, output: r.stdout };
    }
    if (r.exitCode === 0) {
      return { resolved: false, output: r.stdout };
    }
    // dig present but errored — fall through to libc fallback.
  } catch {
    // dig missing on PATH — fall through to libc fallback.
  }
  // Fallback — `getent hosts` consults the libc resolver (nsswitch +
  // /etc/hosts + DNS). Exit code 0 + non-empty output = resolved.
  try {
    const r = await spawn({
      cmd: "getent",
      argv: ["hosts", hostname],
      timeoutMs: 5_000,
      expectExitCode: "any",
    });
    return {
      resolved: r.exitCode === 0 && r.stdout.trim().length > 0,
      output: r.stdout,
    };
  } catch (e) {
    return {
      resolved: false,
      output: `dns probe failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---------- Deploy / teardown ----------

/** Options for {@link deployBranchStaging}. Production caller (the
 *  ADR-090 spawn-epic hook) constructs once at epic spawn time. */
export interface DeployOpts {
  /** Composed staging URL (post-{@link composeStagingUrl}) — surfaced
   *  to the deploy script via `STAGING_URL` env so the script knows
   *  what hostname to bind / advertise. */
  stagingUrl: string;
  /** Worktree the per-product `scripts/deploy.sh` runs against. For
   *  IFCA products this is `/root/work/ifca/deployments/<product>-
   *  <epic>/` per the ADR's lifecycle. The script is invoked from
   *  this cwd so relative paths resolve correctly. */
  worktreeRoot: string;
  /** Shell-tokenised deploy command. Defaults to `scripts/deploy.sh
   *  branch-staging` — the IFCA convention per global CLAUDE.md.
   *  Per-product overrides via `team.epicTeam.deployCommand` (future
   *  schema extension — for v1 the default covers every IFCA
   *  product). */
  deployCommand?: string;
  /** Deploy timeout (default 10 min). Long enough for a clean build
   *  + push on the slowest IFCA product. */
  timeoutMs?: number;
  /** Test injection — override the spawn primitive. */
  spawn?: DeploySpawn;
}

/** Result of {@link deployBranchStaging}. `outcome` is `"ok"` on
 *  success (exit code 0) or `"fail"` on any other path (non-zero exit,
 *  timeout, spawn error). `output` carries combined stdout+stderr for
 *  operator surfacing + Discord [test-gate-bypass] / failure ping. */
export interface DeployResult {
  outcome: "ok" | "fail";
  exitCode: number;
  output: string;
  durationMs: number;
}

/** Invoke the per-product `scripts/deploy.sh branch-staging` (or the
 *  configured `deployCommand`) with `STAGING_URL=<stagingUrl>` in the
 *  env so the script can bind/advertise the right hostname. Production
 *  caller is the spawn-epic verb's deploy hook; this primitive is
 *  pure-of-state-machine + safe to call standalone (e.g. operator
 *  `atmux epic-deploy --redeploy` future verb).
 *
 *  Does NOT mutate the merger_state row — the row mutation lives in
 *  the spawn-epic verb wrapper. This module is a thin orchestrator. */
export async function deployBranchStaging(opts: DeployOpts): Promise<DeployResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const cmd = opts.deployCommand ?? "scripts/deploy.sh branch-staging";
  const tokens = tokenizeTestCommand(cmd);
  const start = Date.now();
  const result = await spawn({
    cmd: tokens[0]!,
    argv: tokens.slice(1),
    cwd: opts.worktreeRoot,
    env: { STAGING_URL: opts.stagingUrl },
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    expectExitCode: "any",
  });
  return {
    outcome: result.exitCode === 0 ? "ok" : "fail",
    exitCode: result.exitCode,
    output: `${result.stdout}${result.stderr}`,
    durationMs: result.durationMs > 0 ? result.durationMs : Date.now() - start,
  };
}

/** Options for {@link teardownDeployment}. */
export interface TeardownOpts {
  /** Composed staging URL — surfaced via env so the teardown script
   *  knows which deployment to remove (idempotent on missing URL). */
  stagingUrl: string;
  /** Worktree the teardown script runs from. */
  worktreeRoot: string;
  /** Shell-tokenised teardown command. Defaults to `scripts/deploy.sh
   *  branch-staging --teardown`. */
  teardownCommand?: string;
  /** Teardown timeout (default 5 min). */
  timeoutMs?: number;
  /** Test injection — override the spawn primitive. */
  spawn?: DeploySpawn;
}

/** Tear down the deployment. Idempotent — the per-product teardown
 *  script is expected to no-op on a missing URL. Used by the
 *  dissolve-epic hook (ADR-091 `dissolved` state) so the long-lived
 *  branch-staging URL is freed when the epic-team dissolves.
 *
 *  Failure does NOT throw — the dissolve sequence should continue
 *  even if the deployment was already torn down externally. The
 *  caller surfaces the result via `epic.note` for operator inspection. */
export async function teardownDeployment(opts: TeardownOpts): Promise<DeployResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const cmd = opts.teardownCommand ?? "scripts/deploy.sh branch-staging --teardown";
  const tokens = tokenizeTestCommand(cmd);
  const start = Date.now();
  const result = await spawn({
    cmd: tokens[0]!,
    argv: tokens.slice(1),
    cwd: opts.worktreeRoot,
    env: { STAGING_URL: opts.stagingUrl },
    timeoutMs: opts.timeoutMs ?? 5 * 60_000,
    expectExitCode: "any",
  });
  return {
    outcome: result.exitCode === 0 ? "ok" : "fail",
    exitCode: result.exitCode,
    output: `${result.stdout}${result.stderr}`,
    durationMs: result.durationMs > 0 ? result.durationMs : Date.now() - start,
  };
}

// ---------- Test execution ----------

/** Per-attempt result from {@link runDeployedTestOnce}. Same shape as
 *  {@link CageAttemptResult} from epic-test-cage.ts so callers
 *  surfacing outcome via Discord templates (T5) share one renderer. */
export interface DeployedAttemptResult {
  outcome: "pass" | "fail";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Composite result from {@link runDeployedTest} after applying
 *  retryOnFlake. Mirrors {@link CageTestResult}. */
export interface DeployedTestResult {
  outcome: TestOutcome & ("pass" | "fail");
  attempts: number;
  last: DeployedAttemptResult;
  totalDurationMs: number;
  /** The URL the test ran against — surfaced via merger_state.note +
   *  Discord templates for operator traceability. */
  baseUrl: string;
}

/** Run the test command ONCE against the deployed URL. Sets
 *  `E2E_BASE_URL` in the child env so the test runner knows which
 *  deployment to walk. Exit code 0 → `"pass"`, non-zero → `"fail"`.
 *  Retry logic lives in {@link runDeployedTest}. */
export async function runDeployedTestOnce(
  testCommand: string,
  baseUrl: string,
  cwd: string,
  timeoutMs: number,
  spawn: DeploySpawn = defaultSpawn,
): Promise<DeployedAttemptResult> {
  const tokens = tokenizeTestCommand(testCommand);
  const start = Date.now();
  const result = await spawn({
    cmd: tokens[0]!,
    argv: tokens.slice(1),
    cwd,
    env: { E2E_BASE_URL: baseUrl },
    timeoutMs,
    expectExitCode: "any",
  });
  return {
    outcome: result.exitCode === 0 ? "pass" : "fail",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs > 0 ? result.durationMs : Date.now() - start,
  };
}

/** Options for {@link runDeployedTest}. Mirror of
 *  {@link RunCageTestOpts} from epic-test-cage.ts with `cagePath`
 *  swapped for `baseUrl`. */
export interface RunDeployedTestOpts {
  /** Composed staging URL — `E2E_BASE_URL` for the test runner. */
  baseUrl: string;
  /** Shell-tokenised test command (default `pnpm e2e` in production). */
  testCommand: string;
  /** Working directory the test command runs in. Production callers
   *  pass the epic-team's worktree root. */
  cwd: string;
  /** Per-attempt timeout in ms. */
  timeoutMs: number;
  /** Per-ADR-144 §retryOnFlake: retry up to N times on a fail. */
  retryOnFlake: number;
  /** Test injection — override the spawn primitive. */
  spawn?: DeploySpawn;
}

/** Run the test command against the deployed URL with retryOnFlake
 *  semantics. Mirrors {@link runCageTest}: any retry passes → return
 *  PASS with `attempts > 1`; all retries fail → return FAIL with
 *  LAST evidence.
 *
 *  Does NOT touch state.db — the caller (epic-merge.ts) records the
 *  outcome via {@link MergerStateRepo.transition} after this returns. */
export async function runDeployedTest(opts: RunDeployedTestOpts): Promise<DeployedTestResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const maxAttempts = 1 + Math.max(0, Math.floor(opts.retryOnFlake));
  let last: DeployedAttemptResult | null = null;
  let totalDurationMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await runDeployedTestOnce(
      opts.testCommand,
      opts.baseUrl,
      opts.cwd,
      opts.timeoutMs,
      spawn,
    );
    totalDurationMs += r.durationMs;
    last = r;
    if (r.outcome === "pass") {
      return {
        outcome: "pass",
        attempts: attempt,
        last: r,
        totalDurationMs,
        baseUrl: opts.baseUrl,
      };
    }
  }
  if (last === null) {
    throw new Error("runDeployedTest: invariant — maxAttempts >= 1 should guarantee last is set");
  }
  return {
    outcome: "fail",
    attempts: maxAttempts,
    last,
    totalDurationMs,
    baseUrl: opts.baseUrl,
  };
}

// ---------- Top-level orchestrator ----------

/** Options for {@link runDeployedTestGate}. The deployed-mode runner
 *  does NOT provision/teardown per call (the deploy is sticky across
 *  the epic-team's lifetime per ADR-144 §Mode-A-deployed lifecycle);
 *  it just runs the test command against the already-deployed URL.
 *
 *  Compare to {@link RunCageTestGateOpts} which wraps provision +
 *  teardown — cage mode is one-shot per merge attempt; deployed mode
 *  reuses the long-lived URL. */
export interface RunDeployedTestGateOpts {
  baseUrl: string;
  testCommand: string;
  cwd: string;
  timeoutMs: number;
  retryOnFlake: number;
  spawn?: DeploySpawn;
}

/**
 * Run the deployed-mode test gate: validates DNS, then runs the test
 * command (with retryOnFlake) against `E2E_BASE_URL=<baseUrl>`. Does
 * NOT deploy or teardown — those lifecycle hooks fire at spawn-epic /
 * dissolve-epic respectively.
 *
 * Returns the {@link DeployedTestResult}. The wildcard-DNS probe runs
 * first as a fast-fail: if `*.ifca.app` doesn't resolve `baseUrl`, the
 * test command would fail with a noisy network error — catching it
 * here surfaces a clear "DNS not configured" reason instead.
 */
export async function runDeployedTestGate(
  opts: RunDeployedTestGateOpts,
): Promise<DeployedTestResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  const url = new URL(opts.baseUrl);
  const dns = await checkWildcardDns(url.hostname, spawn);
  if (!dns.resolved) {
    return {
      outcome: "fail",
      attempts: 0,
      last: {
        outcome: "fail",
        exitCode: -1,
        stdout: "",
        stderr: `wildcard DNS for ${url.hostname} did not resolve — check *.ifca.app A record on hax (probe output: ${dns.output.trim() || "<empty>"})`,
        durationMs: 0,
      },
      totalDurationMs: 0,
      baseUrl: opts.baseUrl,
    };
  }
  return await runDeployedTest({
    baseUrl: opts.baseUrl,
    testCommand: opts.testCommand,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    retryOnFlake: opts.retryOnFlake,
    spawn,
  });
}
