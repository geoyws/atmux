#!/usr/bin/env bun
// t-af727acd / ADR-302: host-aware `bun build --compile` wrapper.
//
// `package.json::build:compile` runs this with no args: the bun target
// follows the host via `resolveBunCompileTarget()` (darwin-arm64 on
// @@mbp, linux-x64 on the deploy hosts), so `build:install` no longer
// installs a Linux ELF on macOS.
//
// Explicit overrides, highest precedence first:
//   bun scripts/build-compile.ts --target=bun-linux-x64   # argv (CI/release cross-compile)
//   ATMUX_BUN_TARGET=bun-linux-x64 bun scripts/build-compile.ts  # env (build:compile:linux)
// Remaining argv entries pass through to `bun build` verbatim.
import { resolve } from "node:path";
import {
  BUN_COMPILE_TARGET_ENV,
  resolveBunCompileTarget,
  splitTargetArg,
} from "../src/core/build-target.ts";
const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRY = "./bin/atmux-entry.ts";
const OUTFILE = "dist/atmux";

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const { target: argvTarget, rest } = splitTargetArg(argv);
  // Fold an argv --target into the env seam so validation + precedence
  // stay in one place (resolveBunCompileTarget).
  const requested = argvTarget?.trim() ?? "";
  const env =
    requested.length > 0 ? { ...process.env, [BUN_COMPILE_TARGET_ENV]: requested } : process.env;
  let target: string;
  try {
    target = resolveBunCompileTarget(process.platform, process.arch, env);
  } catch (err) {
    process.stderr.write(`build-compile: ${(err as Error).message}\n`);
    return 2;
  }
  let via = "host default";
  if (requested.length > 0) {
    via = "argv --target";
  } else if ((process.env[BUN_COMPILE_TARGET_ENV] ?? "").trim().length > 0) {
    via = BUN_COMPILE_TARGET_ENV;
  }
  process.stderr.write(`build-compile: target=${target} (via ${via})\n`);
  const proc = Bun.spawn(
    ["bun", "build", ENTRY, "--compile", `--target=${target}`, "--outfile", OUTFILE, ...rest],
    { cwd: REPO_ROOT, stdio: ["inherit", "inherit", "inherit"] },
  );
  return await proc.exited;
}

const code = await main(process.argv.slice(2));
process.exit(code);
