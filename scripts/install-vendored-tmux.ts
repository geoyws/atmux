import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  hashFile,
  installManifestPath,
  prepareSourceTree,
  removePath,
  writeJsonFile,
} from "../src/core/vendored-tmux-install.ts";
import {
  VENDORED_TMUX_SOURCE_SHA256,
  VENDORED_TMUX_SOURCE_URL,
  VENDORED_TMUX_VERSION,
  vendoredTmuxVersionTag,
} from "../src/core/tmux-bundle.ts";
import {
  auditAllowedMachOLoadPaths,
  isRelativeMachODependency,
  isSystemMachODependency,
  parseOtoolDependencies,
  planMachOBundle,
  shouldBundleMachODependency,
  loaderPathForDylib,
  rewriteCommand,
  rewriteIdCommand,
  validateBundleRewrites,
} from "../src/core/macho-dylib-closure.ts";

interface BundleManifest {
  version: string;
  sourceUrl: string;
  sourceSha256: string;
  configureArgs: readonly string[];
  darwinConfigureArgs?: readonly string[];
  buildCommand: string;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface StagedTmuxManifest {
  version: string;
  sourceUrl: string;
  sourceSha256: string;
  archiveSha256: string;
  archivePath: string;
  sourceExtractionRoot: string;
  sourceRoot: string;
  builtBinaryPath: string;
  builtBinarySha256: string;
  installedBinaryPath: string;
  installedRoot: string;
  bundledDylibs: readonly BundledDylibManifest[];
}

interface BundledDylibManifest {
  sourcePath: string;
  bundlePath: string;
  installName: string;
  sha256: string;
}

interface FinalBundledDylibManifest extends Omit<BundledDylibManifest, "bundlePath"> {
  finalPath: string;
}

interface FinalTmuxManifest extends Omit<StagedTmuxManifest, "archivePath" | "sourceExtractionRoot" | "sourceRoot" | "bundledDylibs"> {
  bundledDylibs: readonly FinalBundledDylibManifest[];
}

export interface StageVendoredTmuxOptions {
  sourceTarball?: string;
  installRoot?: string;
}

interface BuildVendoredTmuxStageHooks {
  readBundleManifest?: typeof readBundleManifest;
  resolveSourceTarball?: typeof resolveSourceTarball;
  prepareSourceTree?: typeof prepareSourceTree;
  buildTmuxFromSource?: typeof buildTmuxFromSource;
  writeJsonFile?: typeof writeJsonFile;
  removePath?: typeof removePath;
}

const BUNDLE_MANIFEST_PATH = new URL("./tmux-bundle-manifest.json", import.meta.url);
const REQUIRED_PKG_CONFIG_PACKAGES = ["libevent", "ncurses", "libutf8proc"] as const;
const DARWIN_CODESIGN_BINARY = "/usr/bin/codesign";

export async function readBundleManifest(): Promise<BundleManifest> {
  const raw = await readFile(BUNDLE_MANIFEST_PATH, "utf8");
  const parsed = JSON.parse(raw) as BundleManifest;
  if (parsed.version !== VENDORED_TMUX_VERSION) {
    throw new Error(`tmux bundle manifest version drift: ${parsed.version}`);
  }
  if (parsed.sourceUrl !== VENDORED_TMUX_SOURCE_URL) {
    throw new Error("tmux bundle manifest sourceUrl drift");
  }
  if (parsed.sourceSha256 !== VENDORED_TMUX_SOURCE_SHA256) {
    throw new Error("tmux bundle manifest sourceSha256 drift");
  }
  return parsed;
}

export async function run(cmd: string, argv: ReadonlyArray<string>, cwd: string, env?: Record<string, string>): Promise<RunResult> {
  return await new Promise<RunResult>((resolveRun, rejectRun) => {
    const child = spawn(cmd, argv, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectRun);
    child.on("close", (exitCode) => {
      resolveRun({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

export function whichOrThrow(bin: string): string {
  const path = Bun.which(bin);
  if (!path) {
    throw new Error(`tmux build prerequisites missing: ${bin} not found on PATH`);
  }
  return path;
}

export async function ensurePkgConfigPackage(pkg: string): Promise<void> {
  const pkgConfig = whichOrThrow("pkg-config");
  const result = await run(pkgConfig, ["--exists", pkg], process.cwd());
  if (result.exitCode !== 0) {
    throw new Error(`tmux build prerequisites missing: pkg-config package ${pkg}`);
  }
}

export async function ensureToolchain(): Promise<{ compiler: string; configureArgs: string[] }> {
  whichOrThrow("make");
  let compiler: string | undefined;
  for (const candidate of ["cc", "gcc", "clang"]) {
    const resolved = Bun.which(candidate);
    if (resolved) {
      compiler = resolved;
      break;
    }
  }
  if (!compiler) {
    throw new Error("tmux build prerequisites missing: cc/gcc/clang not found on PATH");
  }

  for (const pkg of REQUIRED_PKG_CONFIG_PACKAGES) {
    await ensurePkgConfigPackage(pkg);
  }
  if (process.platform === "darwin") {
    await ensurePkgConfigPackage("jemalloc");
  }

  const manifest = await readBundleManifest();
  const configureArgs = [...manifest.configureArgs];
  if (process.platform === "darwin" && manifest.darwinConfigureArgs) {
    configureArgs.push(...manifest.darwinConfigureArgs);
  }
  return { compiler, configureArgs };
}

export function resolveDarwinCodesignBinary(): string {
  const resolved = Bun.which("codesign");
  if (resolved === DARWIN_CODESIGN_BINARY) {
    return resolved;
  }
  if (resolved !== null) {
    throw new Error(
      `tmux build prerequisites missing: expected ${DARWIN_CODESIGN_BINARY}, got ${resolved}`,
    );
  }
  return DARWIN_CODESIGN_BINARY;
}

export async function codesignDarwinSubject(subjectPath: string): Promise<void> {
  const codesign = resolveDarwinCodesignBinary();
  try {
    const result = await run(
      codesign,
      ["--force", "--sign", "-", subjectPath],
      dirname(subjectPath),
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `exit ${result.exitCode}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`codesign failed for ${subjectPath}: ${reason}`);
  }
}

export async function fetchSourceTarball(sourceUrl: string, destPath: string): Promise<void> {
  const response = await fetch(sourceUrl);
  if (!response.ok || response.body === null) {
    throw new Error(`failed to fetch tmux source archive from ${sourceUrl}: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, bytes);
}

export async function resolveSourceTarball(
  sourceTarballArg: string | undefined,
  scratchRoot: string,
  bundle: BundleManifest,
): Promise<string> {
  const sourceTarballEnv = Bun.env.ATMUX_TMUX_TARBALL?.trim();
  const explicitPath = sourceTarballArg?.trim() || sourceTarballEnv || "";
  if (explicitPath.length > 0) {
    return resolve(explicitPath);
  }
  const fetched = join(scratchRoot, `tmux-${bundle.version}.tar.gz`);
  await fetchSourceTarball(bundle.sourceUrl, fetched);
  return fetched;
}

export async function buildTmuxFromSource(
  sourceRoot: string,
  stageRoot: string,
  bundle: BundleManifest,
): Promise<{ builtBinaryPath: string; builtBinarySha256: string; bundledDylibs: readonly BundledDylibManifest[] }> {
  const { compiler, configureArgs } = await ensureToolchain();
  const configureEnv: Record<string, string> = {
    CC: compiler,
  };

  const configure = await run("./configure", configureArgs, sourceRoot, configureEnv);
  if (configure.exitCode !== 0) {
    throw new Error(`tmux configure failed: ${configure.stderr || configure.stdout}`);
  }
  const build = await run(bundle.buildCommand, [], sourceRoot, configureEnv);
  if (build.exitCode !== 0) {
    throw new Error(`tmux build failed: ${build.stderr || build.stdout}`);
  }

  const builtBinaryPath = join(sourceRoot, "tmux");
  if (!existsSync(builtBinaryPath)) {
    throw new Error(`tmux build did not produce ${builtBinaryPath}`);
  }

  const versionProbe = await run(builtBinaryPath, ["-V"], sourceRoot);
  if (versionProbe.exitCode !== 0) {
    throw new Error(`tmux -V failed from built binary: ${versionProbe.stderr || versionProbe.stdout}`);
  }
  if (versionProbe.stdout.trim() !== vendoredTmuxVersionTag()) {
    throw new Error(
      `tmux -V mismatch: got ${versionProbe.stdout.trim()}, expected ${vendoredTmuxVersionTag()}`,
    );
  }

  const binDir = join(stageRoot, "bin");
  await mkdir(binDir, { recursive: true });
  await copyFile(builtBinaryPath, join(binDir, "tmux"));
  await chmod(join(binDir, "tmux"), 0o755);

  const bundledDylibs = await bundleDarwinTmuxDependencies(join(binDir, "tmux"), stageRoot);

  const builtBinarySha256 = await hashFile(join(binDir, "tmux"));
  const installedProbe = await run(join(stageRoot, "bin", "tmux"), ["-V"], stageRoot);
  if (installedProbe.exitCode !== 0 || installedProbe.stdout.trim() !== vendoredTmuxVersionTag()) {
    throw new Error(`tmux staged binary validation failed: ${installedProbe.stderr || installedProbe.stdout}`);
  }

  return { builtBinaryPath: join(stageRoot, "bin", "tmux"), builtBinarySha256, bundledDylibs };
}

export async function readMachODependencies(binaryPath: string): Promise<string[]> {
  if (process.platform !== "darwin") {
    return [];
  }
  const result = await run("/usr/bin/otool", ["-L", binaryPath], dirname(binaryPath));
  if (result.exitCode !== 0) {
    throw new Error(`otool failed for ${binaryPath}: ${result.stderr || result.stdout}`);
  }
  return parseOtoolDependencies(result.stdout);
}

export async function bundleDarwinTmuxDependencies(binaryPath: string, stageRoot: string): Promise<readonly BundledDylibManifest[]> {
  if (process.platform !== "darwin") {
    return [];
  }

  const stageLibDir = join(stageRoot, "lib");
  const memo = new Map<string, readonly string[]>();
  const dependencyLookup = (subjectPath: string): readonly string[] => memo.get(subjectPath) ?? [];

  const seededDeps = await readMachODependencies(binaryPath);
  memo.set(binaryPath, seededDeps);

  const queue: string[] = [binaryPath];
  while (queue.length > 0) {
    const subjectPath = queue.shift();
    if (subjectPath === undefined) {
      continue;
    }
    for (const dependency of memo.get(subjectPath) ?? []) {
      if (!dependency.startsWith("/") || isSystemMachODependency(dependency) || isRelativeMachODependency(dependency)) {
        continue;
      }
      if (!memo.has(dependency)) {
        const deps = await readMachODependencies(dependency);
        memo.set(dependency, deps);
        queue.push(dependency);
      }
    }
  }

  const plan = planMachOBundle(binaryPath, dependencyLookup, stageLibDir);
  validateBundleRewrites(plan);
  const manifestEntries: Array<{ sourcePath: string; bundlePath: string; installName: string }> = [];
  const commandSubjects: Array<{ subjectPath: string; deps: readonly string[]; isExecutable: boolean }> = [
    { subjectPath: binaryPath, deps: plan.rootRewrites.map((entry) => entry.sourcePath), isExecutable: true },
  ];

  await mkdir(stageLibDir, { recursive: true });
  for (const entry of plan.bundledDylibs) {
    await copyFile(entry.sourcePath, entry.stagedPath);
    const sourceStat = await lstat(entry.sourcePath);
    await chmod(entry.stagedPath, sourceStat.mode & 0o777);
    manifestEntries.push({
      sourcePath: entry.sourcePath,
      bundlePath: entry.stagedPath,
      installName: entry.rewrittenInstallName,
    });
    commandSubjects.push({
      subjectPath: entry.stagedPath,
      deps: memo.get(entry.sourcePath) ?? [],
      isExecutable: false,
    });
  }

  for (const subject of commandSubjects) {
    const rewrites = subject.isExecutable
      ? plan.rootRewrites
      : subject.deps
          .filter((dependency) => shouldBundleMachODependency(dependency))
          .map((dependency) => ({
            sourcePath: dependency,
            rewrittenPath: loaderPathForDylib(basename(dependency)),
          }));

    for (const rewrite of rewrites) {
      const command = rewriteCommand(subject.subjectPath, rewrite.sourcePath, rewrite.rewrittenPath);
      const [commandPath, ...commandArgs] = command;
      const result = await run(commandPath, commandArgs, dirname(subject.subjectPath));
      if (result.exitCode !== 0) {
        throw new Error(`install_name_tool rewrite failed for ${subject.subjectPath}: ${result.stderr || result.stdout}`);
      }
    }

    if (!subject.isExecutable) {
      const idCommand = rewriteIdCommand(subject.subjectPath, loaderPathForDylib(basename(subject.subjectPath)));
      const [idCommandPath, ...idCommandArgs] = idCommand;
      const idResult = await run(idCommandPath, idCommandArgs, dirname(subject.subjectPath));
      if (idResult.exitCode !== 0) {
        throw new Error(`install_name_tool -id failed for ${subject.subjectPath}: ${idResult.stderr || idResult.stdout}`);
      }
    }
  }

  if (process.platform === "darwin") {
    for (const entry of plan.bundledDylibs) {
      await codesignDarwinSubject(entry.stagedPath);
    }
    await codesignDarwinSubject(binaryPath);
  }

  for (const subjectPath of [binaryPath, ...plan.bundledDylibs.map((entry) => entry.stagedPath)]) {
    const deps = await readMachODependencies(subjectPath);
    auditAllowedMachOLoadPaths(deps);
  }

  const manifests: BundledDylibManifest[] = [];
  for (const entry of manifestEntries) {
    manifests.push({
      sourcePath: entry.sourcePath,
      bundlePath: entry.bundlePath,
      installName: entry.installName,
      sha256: await hashFile(entry.bundlePath),
    });
  }

  return manifests;
}

export async function buildVendoredTmuxStage(
  stageRoot: string,
  installRoot: string,
  options: StageVendoredTmuxOptions = {},
  hooks: BuildVendoredTmuxStageHooks = {},
): Promise<FinalTmuxManifest> {
  const readBundleManifestImpl = hooks.readBundleManifest ?? readBundleManifest;
  const resolveSourceTarballImpl = hooks.resolveSourceTarball ?? resolveSourceTarball;
  const prepareSourceTreeImpl = hooks.prepareSourceTree ?? prepareSourceTree;
  const buildTmuxFromSourceImpl = hooks.buildTmuxFromSource ?? buildTmuxFromSource;
  const writeJsonFileImpl = hooks.writeJsonFile ?? writeJsonFile;
  const removePathImpl = hooks.removePath ?? removePath;
  const bundle = await readBundleManifestImpl();
  const scratchRoot = await mkdtemp(join(dirname(stageRoot), ".atmux-tmux-build-"));
  const sourceRoot = join(scratchRoot, "source");
  const sourceTarball = await resolveSourceTarballImpl(options.sourceTarball, scratchRoot, bundle);

  try {
    const sourcePrep = await prepareSourceTreeImpl(sourceTarball, bundle.sourceSha256, sourceRoot);
    const result = await buildTmuxFromSourceImpl(sourcePrep.extractedRoot, stageRoot, bundle);
    const manifestPath = installManifestPath(stageRoot);
    const manifest: StagedTmuxManifest = {
      version: bundle.version,
      sourceUrl: bundle.sourceUrl,
      sourceSha256: bundle.sourceSha256,
      archiveSha256: sourcePrep.archiveSha256,
      archivePath: sourceTarball,
      sourceExtractionRoot: sourcePrep.extractedRoot,
      sourceRoot: sourcePrep.validation.rootName,
      builtBinaryPath: result.builtBinaryPath,
      builtBinarySha256: result.builtBinarySha256,
      installedBinaryPath: join(installRoot, "bin", "tmux"),
      installedRoot: installRoot,
      bundledDylibs: result.bundledDylibs,
    };
    await writeJsonFileImpl(manifestPath, manifest);
    return {
      version: manifest.version,
      sourceUrl: manifest.sourceUrl,
      sourceSha256: manifest.sourceSha256,
      archiveSha256: manifest.archiveSha256,
      builtBinaryPath: manifest.builtBinaryPath,
      builtBinarySha256: manifest.builtBinarySha256,
      installedBinaryPath: manifest.installedBinaryPath,
      installedRoot: manifest.installedRoot,
      bundledDylibs: manifest.bundledDylibs.map((entry) => ({
        sourcePath: entry.sourcePath,
        finalPath: join(installRoot, "lib", basename(entry.bundlePath)),
        installName: entry.installName,
        sha256: entry.sha256,
      })),
    };
  } finally {
    await removePathImpl(scratchRoot);
  }
}

export function finalManifestFromStage(stageManifest: StagedTmuxManifest, finalRoot: string): FinalTmuxManifest {
  const { archivePath: _, sourceExtractionRoot: __, sourceRoot: ___, ...finalManifest } = stageManifest;
  return {
    version: finalManifest.version,
    sourceUrl: finalManifest.sourceUrl,
    sourceSha256: finalManifest.sourceSha256,
    archiveSha256: finalManifest.archiveSha256,
    builtBinaryPath: join(finalRoot, "bin", "tmux"),
    builtBinarySha256: finalManifest.builtBinarySha256,
    installedBinaryPath: join(finalRoot, "bin", "tmux"),
    installedRoot: finalRoot,
    bundledDylibs: finalManifest.bundledDylibs.map((entry) => ({
      sourcePath: entry.sourcePath,
      finalPath: join(finalRoot, "lib", basename(entry.bundlePath)),
      installName: entry.installName,
      sha256: entry.sha256,
    })),
  };
}
