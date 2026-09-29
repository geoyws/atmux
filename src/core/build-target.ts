// t-af727acd / ADR-302: resolve the `bun build --compile --target=…`
// target for the atmux standalone binary.
// `package.json::build:compile` used to hardcode `--target=bun-linux-x64`,
// so `build:install` on a macOS host installed a Linux ELF. The target
// now follows the host by default (darwin-arm64, darwin-x64, linux-x64,
// linux-arm64, windows-x64), with `ATMUX_BUN_TARGET` as the explicit
// override for cross-compiling Linux release artefacts
// (`build:compile:linux` sets it).
//
// Pure + injectable seams (platform / arch / env) per the
// `resolveTmuxBin` shape in `src/core/resolve-tmux-bin.ts`, so unit
// tests pin every platform/arch row without spawning anything.

/** Bun `--compile` targets atmux knows how to produce. */
export const KNOWN_BUN_COMPILE_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
] as const;

export type BunCompileTarget = (typeof KNOWN_BUN_COMPILE_TARGETS)[number];

/** Env var that forces a compile target (cross-compile escape hatch). */
export const BUN_COMPILE_TARGET_ENV = "ATMUX_BUN_TARGET";

/** Type guard for the known-target set (also validates explicit overrides). */
export function isBunCompileTarget(value: string): value is BunCompileTarget {
  return (KNOWN_BUN_COMPILE_TARGETS as readonly string[]).includes(value);
}

/**
 * Split `--target[=]<t>` out of a `build-compile.ts` argv; everything
 * else passes through to `bun build` verbatim. Last `--target` wins.
 */
export function splitTargetArg(argv: ReadonlyArray<string>): {
  target: string | null;
  rest: string[];
} {
  let target: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--target" && i + 1 < argv.length) {
      target = argv[++i] as string;
      continue;
    }
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
      continue;
    }
    rest.push(arg);
  }
  return { target, rest };
}

/**
 * Resolve the `bun build --compile --target=…` value.
 *
 * Precedence: explicit `ATMUX_BUN_TARGET` (blank/whitespace falls
 * through) > host `platform`+`arch` mapping.
 *
 * @param platform — override `process.platform` (test seam).
 * @param arch — override `process.arch` (test seam).
 * @param env — override `process.env` (test seam).
 * @throws when the override names an unknown target, or when the
 *   host platform/arch has no known bun target.
 */
export function resolveBunCompileTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): BunCompileTarget {
  const override = env[BUN_COMPILE_TARGET_ENV]?.trim();
  if (override && override.length > 0) {
    if (!isBunCompileTarget(override)) {
      throw new Error(
        `[atmux] ${BUN_COMPILE_TARGET_ENV}=${override} is not a known bun compile target ` +
          `(try: ${KNOWN_BUN_COMPILE_TARGETS.join(" | ")}). ` +
          `Unset it to follow the host (ADR-302).`,
      );
    }
    return override;
  }
  const host = `${platform}-${arch}`;
  switch (host) {
    case "darwin-arm64":
      return "bun-darwin-arm64";
    case "darwin-x64":
      return "bun-darwin-x64";
    case "linux-x64":
      return "bun-linux-x64";
    case "linux-arm64":
      return "bun-linux-arm64";
    case "win32-x64":
      return "bun-windows-x64";
    default:
      throw new Error(
        `[atmux] no known bun compile target for host ${host} — ` +
          `set ${BUN_COMPILE_TARGET_ENV} explicitly ` +
          `(try: ${KNOWN_BUN_COMPILE_TARGETS.join(" | ")}) (ADR-302).`,
      );
  }
}
