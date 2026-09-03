#!/usr/bin/env bun
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  createAtomicSymlink,
  ensureAbsent,
  hashFile,
  installManifestPath,
  removePath,
  writeJsonFile,
} from "../src/core/vendored-tmux-install.ts";
import {
  VENDORED_TMUX_CURRENT_LINK,
  VENDORED_TMUX_INSTALL_ROOT,
  vendoredTmuxVersionTag,
} from "../src/core/tmux-bundle.ts";
import { buildVendoredTmuxStage } from "./install-vendored-tmux.ts";

export type BuildVendoredTmuxStageFn = typeof buildVendoredTmuxStage;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PackageManifest {
  version: string;
}

interface StageInstallManifest {
  version: string;
  buildTarget: string;
  hostPlatform: string;
  hostArch: string;
  stageRoot: string;
  installRoot: string;
  currentLink: string;
  atmuxBinLink: string;
  cockpitMirrorLink: string;
  atmuxBinaryPath: string;
  atmuxBinarySha256: string;
  atmuxListenerPath: string;
  atmuxListenerSha256: string;
  atmuxCockpitMirrorPath: string;
  atmuxCockpitMirrorSha256: string;
  tmuxInstallManifestPath: string;
  tmuxBinaryPath: string;
  tmuxBinarySha256: string;
  tmuxVersion: string;
  templatesPath: string;
  pluginsPath: string;
}

interface FinalInstallManifest extends Omit<StageInstallManifest, "stageRoot"> {}

interface BundledDylibManifest {
  sourcePath: string;
  bundlePath: string;
  installName: string;
  sha256: string;
}

interface FinalBundledDylibManifest {
  sourcePath: string;
  finalPath: string;
  installName: string;
  sha256: string;
}

interface FinalTmuxManifest {
  version: string;
  sourceUrl: string;
  sourceSha256: string;
  archiveSha256: string;
  builtBinaryPath: string;
  builtBinarySha256: string;
  installedBinaryPath: string;
  installedRoot: string;
  bundledDylibs: readonly FinalBundledDylibManifest[];
}

interface StagedTmuxManifest extends Omit<FinalTmuxManifest, "bundledDylibs"> {
  archivePath: string;
  sourceExtractionRoot: string;
  sourceRoot: string;
  bundledDylibs: readonly BundledDylibManifest[];
}

interface ActivationHooks {
  ensureAbsent?: typeof ensureAbsent;
  rename?: typeof rename;
  createAtomicSymlink?: typeof createAtomicSymlink;
  restoreLinkState?: typeof restoreLinkState;
  writeFile?: typeof writeFile;
  validateFinalInstall?: typeof validateFinalInstall;
}

export interface StageInstallOptions {
  sourceTarball?: string;
  installRoot?: string;
  currentLink?: string;
  atmuxBinLink?: string;
  cockpitMirrorLink?: string;
}

function readFlagValue(argv: ReadonlyArray<string>, index: number, flagName: string): { value: string; nextIndex: number } {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

export function parseArgs(argv: ReadonlyArray<string>): StageInstallOptions {
  const result: StageInstallOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-tarball") {
      const { value, nextIndex } = readFlagValue(argv, i, "--source-tarball");
      result.sourceTarball = value;
      i = nextIndex;
    } else if (arg === "--install-root") {
      const { value, nextIndex } = readFlagValue(argv, i, "--install-root");
      result.installRoot = value;
      i = nextIndex;
    } else if (arg === "--current-link") {
      const { value, nextIndex } = readFlagValue(argv, i, "--current-link");
      result.currentLink = value;
      i = nextIndex;
    } else if (arg === "--atmux-bin-link") {
      const { value, nextIndex } = readFlagValue(argv, i, "--atmux-bin-link");
      result.atmuxBinLink = value;
      i = nextIndex;
    } else if (arg === "--cockpit-mirror-link") {
      const { value, nextIndex } = readFlagValue(argv, i, "--cockpit-mirror-link");
      result.cockpitMirrorLink = value;
      i = nextIndex;
    } else {
      throw new Error(`unknown build-install arg: ${arg}`);
    }
  }
  return result;
}

function assertExactMatch(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`${label} drift: ${actual} !== ${expected}`);
  }
}

function assertPopulated(label: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must be populated`);
  }
}

export async function readPackageManifest(repoRoot: string): Promise<PackageManifest> {
  const raw = await readFile(join(repoRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as PackageManifest;
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json version missing or invalid");
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
  const resolved = Bun.which(bin);
  if (!resolved) {
    throw new Error(`${bin} not found on PATH`);
  }
  return resolved;
}

export function hostCompileTarget(): string {
  return `bun-${process.platform}-${process.arch}`;
}

export async function buildHostAtmuxBinary(repoRoot: string, outputPath: string): Promise<void> {
  const target = hostCompileTarget();
  const result = await run(
    "bun",
    ["build", "./bin/atmux-entry.ts", "--compile", "--target", target, "--outfile", outputPath],
    repoRoot,
  );
  if (result.exitCode !== 0) {
    throw new Error(`host atmux compile failed: ${result.stderr || result.stdout}`);
  }
  if (!existsSync(outputPath)) {
    throw new Error(`host atmux compile did not produce ${outputPath}`);
  }
  const probe = await run(outputPath, ["--version"], repoRoot);
  const packageVersion = (await readPackageManifest(repoRoot)).version;
  if (probe.exitCode !== 0 || probe.stdout.trim() !== packageVersion) {
    throw new Error(`host atmux version probe failed: ${probe.stderr || probe.stdout}`);
  }
}

export async function buildRustBinary(repoRoot: string, crateDir: string, binaryName: string, targetDir: string): Promise<string> {
  const cargo = whichOrThrow("cargo");
  const result = await run(cargo, ["build", "--release"], join(repoRoot, crateDir), { CARGO_TARGET_DIR: targetDir });
  if (result.exitCode !== 0) {
    throw new Error(`${binaryName} build failed: ${result.stderr || result.stdout}`);
  }
  const binaryPath = join(targetDir, "release", binaryName);
  if (!existsSync(binaryPath)) {
    throw new Error(`${binaryName} build did not produce ${binaryPath}`);
  }
  const mode = (await lstat(binaryPath)).mode & 0o777;
  if ((mode & 0o111) === 0) {
    throw new Error(`${binaryName} build output is not executable: ${binaryPath}`);
  }
  return binaryPath;
}

export async function copyFilePreservingMode(source: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(source, dest);
  const mode = (await lstat(source)).mode & 0o777;
  await chmod(dest, mode);
}

export async function copyTree(source: string, dest: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    await mkdir(dirname(dest), { recursive: true });
    await symlink(await readlink(source), dest);
    return;
  }
  if (sourceStat.isFile()) {
    await copyFilePreservingMode(source, dest);
    return;
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`unsupported payload entry: ${source}`);
  }
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const nextSource = join(source, entry.name);
    const nextDest = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(nextSource, nextDest);
    } else if (entry.isSymbolicLink()) {
      await mkdir(dirname(nextDest), { recursive: true });
      await symlink(await readlink(nextSource), nextDest);
    } else if (entry.isFile()) {
      await copyFilePreservingMode(nextSource, nextDest);
    } else {
      throw new Error(`unsupported payload entry: ${nextSource}`);
    }
  }
}

interface LinkSnapshot {
  path: string;
  existed: boolean;
  target?: string;
}

export async function snapshotLinkState(path: string, label: string): Promise<LinkSnapshot> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return { path, existed: false };
    }
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(`unsafe existing destination for ${label}: ${path}`);
  }
  return { path, existed: true, target: await readlink(path) };
}

export async function restoreLinkState(snapshot: LinkSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await rm(snapshot.path, { force: true });
    return;
  }
  if (snapshot.target === undefined) {
    throw new Error(`cannot restore missing target for ${snapshot.path}`);
  }
  await createAtomicSymlink(snapshot.target, snapshot.path);
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function aggregateRollbackError(primary: unknown, rollbackFailures: ReadonlyArray<unknown>): Error {
  const errors = [asError(primary), ...rollbackFailures.map(asError)];
  if (typeof AggregateError === "function") {
    return new AggregateError(errors, "install activation failed and rollback encountered errors");
  }
  const message = ["install activation failed and rollback encountered errors", ...errors.map((error) => error.message)].join(": ");
  return new Error(message);
}

async function snapshotCurrentLink(path: string): Promise<LinkSnapshot> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return { path, existed: false };
    }
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    throw new Error(`unsafe existing destination: ${path}`);
  }
  return { path, existed: true, target: await readlink(path) };
}

export async function writeFinalInstallManifest(finalRoot: string): Promise<void> {
  const stageManifest = JSON.parse(await readFile(join(finalRoot, "install-manifest.json"), "utf8")) as StageInstallManifest;
  const { stageRoot: _, ...stageWithoutStageRoot } = stageManifest;
  const finalManifest: FinalInstallManifest = {
    ...stageWithoutStageRoot,
    installRoot: finalRoot,
    tmuxInstallManifestPath: installManifestPath(finalRoot),
    atmuxBinaryPath: join(finalRoot, "bin", "atmux"),
    atmuxListenerPath: join(finalRoot, "bin", "atmux-listener"),
    atmuxCockpitMirrorPath: join(finalRoot, "bin", "atmux-cockpit-mirror"),
    tmuxBinaryPath: join(finalRoot, "bin", "tmux"),
    templatesPath: join(finalRoot, "templates"),
    pluginsPath: join(finalRoot, "plugins"),
  };
  await writeJsonFile(join(finalRoot, "install-manifest.json"), finalManifest);
}

export async function writeFinalTmuxManifest(finalRoot: string): Promise<void> {
  const stageManifest = JSON.parse(await readFile(installManifestPath(finalRoot), "utf8")) as StagedTmuxManifest;
  const finalManifest: FinalTmuxManifest = {
    version: stageManifest.version,
    sourceUrl: stageManifest.sourceUrl,
    sourceSha256: stageManifest.sourceSha256,
    archiveSha256: stageManifest.archiveSha256,
    builtBinaryPath: join(finalRoot, "bin", "tmux"),
    builtBinarySha256: stageManifest.builtBinarySha256,
    installedBinaryPath: join(finalRoot, "bin", "tmux"),
    installedRoot: finalRoot,
    bundledDylibs: stageManifest.bundledDylibs.map((entry) => ({
      sourcePath: entry.sourcePath,
      finalPath: join(finalRoot, "lib", basename(entry.bundlePath)),
      installName: entry.installName,
      sha256: entry.sha256,
    })),
  };
  await writeJsonFile(installManifestPath(finalRoot), finalManifest);
}

export async function validateFinalInstall(
  finalRoot: string,
  currentLink: string,
  atmuxBinLink: string,
  cockpitMirrorLink: string,
): Promise<void> {
  const finalManifest = JSON.parse(await readFile(join(finalRoot, "install-manifest.json"), "utf8")) as FinalInstallManifest;
  if ("stageRoot" in finalManifest) {
    throw new Error("final install manifest must not retain stageRoot");
  }
  assertExactMatch("final manifest installRoot", finalManifest.installRoot, finalRoot);
  assertExactMatch("final manifest tmuxInstallManifestPath", finalManifest.tmuxInstallManifestPath, installManifestPath(finalRoot));
  assertExactMatch("final manifest atmuxBinaryPath", finalManifest.atmuxBinaryPath, join(finalRoot, "bin", "atmux"));
  assertExactMatch("final manifest atmuxListenerPath", finalManifest.atmuxListenerPath, join(finalRoot, "bin", "atmux-listener"));
  assertExactMatch(
    "final manifest atmuxCockpitMirrorPath",
    finalManifest.atmuxCockpitMirrorPath,
    join(finalRoot, "bin", "atmux-cockpit-mirror"),
  );
  assertExactMatch("final manifest tmuxBinaryPath", finalManifest.tmuxBinaryPath, join(finalRoot, "bin", "tmux"));
  assertExactMatch("final manifest templatesPath", finalManifest.templatesPath, join(finalRoot, "templates"));
  assertExactMatch("final manifest pluginsPath", finalManifest.pluginsPath, join(finalRoot, "plugins"));
  assertExactMatch("final manifest currentLink", finalManifest.currentLink, currentLink);
  assertExactMatch("final manifest atmuxBinLink", finalManifest.atmuxBinLink, atmuxBinLink);
  assertExactMatch("final manifest cockpitMirrorLink", finalManifest.cockpitMirrorLink, cockpitMirrorLink);

  const tmuxFinalManifest = JSON.parse(await readFile(installManifestPath(finalRoot), "utf8")) as FinalTmuxManifest;
  assertExactMatch("final tmux manifest builtBinaryPath", tmuxFinalManifest.builtBinaryPath, join(finalRoot, "bin", "tmux"));
  assertExactMatch(
    "final tmux manifest builtBinarySha256",
    tmuxFinalManifest.builtBinarySha256,
    await hashFile(join(finalRoot, "bin", "tmux")),
  );
  assertExactMatch(
    "final tmux manifest installedBinaryPath",
    tmuxFinalManifest.installedBinaryPath,
    join(finalRoot, "bin", "tmux"),
  );
  assertExactMatch("final tmux manifest installedRoot", tmuxFinalManifest.installedRoot, finalRoot);
  for (const bundled of tmuxFinalManifest.bundledDylibs) {
    assertExactMatch(
      "final tmux manifest bundled dylib finalPath",
      bundled.finalPath,
      join(finalRoot, "lib", bundled.finalPath.split("/").pop() ?? bundled.finalPath),
    );
    assertPopulated("final tmux manifest bundled dylib sourcePath", bundled.sourcePath);
    assertPopulated("final tmux manifest bundled dylib installName", bundled.installName);
    assertPopulated("final tmux manifest bundled dylib sha256", bundled.sha256);
    assertExactMatch(
      "final tmux manifest bundled dylib sha256",
      bundled.sha256,
      await hashFile(join(finalRoot, "lib", basename(bundled.finalPath))),
    );
  }
}

export async function stageCorePayload(
  repoRoot: string,
  stageRoot: string,
  installRoot: string,
  currentLink: string,
  atmuxBinLink: string,
  cockpitMirrorLink: string,
  sourceTarball?: string,
  buildTmuxStage: BuildVendoredTmuxStageFn = buildVendoredTmuxStage,
): Promise<StageInstallManifest> {
  const packageManifest = await readPackageManifest(repoRoot);
  const scratchRoot = await mkdtemp(join(dirname(stageRoot), ".atmux-build-"));
  const hostBinaryPath = join(scratchRoot, "bin", "atmux");
  const listenerTargetDir = join(scratchRoot, "cargo-listener");
  const cockpitTargetDir = join(scratchRoot, "cargo-cockpit-mirror");
  const buildTarget = hostCompileTarget();

  await mkdir(stageRoot, { recursive: true });
  await mkdir(dirname(hostBinaryPath), { recursive: true });
  try {
    await buildHostAtmuxBinary(repoRoot, hostBinaryPath);
    const listenerBinaryPath = await buildRustBinary(
      repoRoot,
      "rust/atmux-listener",
      "atmux-listener",
      listenerTargetDir,
    );
    const cockpitBinaryPath = await buildRustBinary(
      repoRoot,
      "rust/atmux-cockpit-mirror",
      "atmux-cockpit-mirror",
      cockpitTargetDir,
    );

    await mkdir(join(stageRoot, "bin"), { recursive: true });
    await copyFilePreservingMode(hostBinaryPath, join(stageRoot, "bin", "atmux"));
    await copyFilePreservingMode(listenerBinaryPath, join(stageRoot, "bin", "atmux-listener"));
    await copyFilePreservingMode(cockpitBinaryPath, join(stageRoot, "bin", "atmux-cockpit-mirror"));

    await copyTree(join(repoRoot, "templates"), join(stageRoot, "templates"));
    await copyTree(join(repoRoot, "plugins"), join(stageRoot, "plugins"));

    const tmuxOptions: { sourceTarball?: string } = {};
    if (sourceTarball !== undefined) {
      tmuxOptions.sourceTarball = sourceTarball;
    }
    const tmuxStageManifest = await buildTmuxStage(stageRoot, installRoot, tmuxOptions);
    if (tmuxStageManifest.installedRoot !== installRoot) {
      throw new Error(`tmux install manifest installedRoot drift: ${tmuxStageManifest.installedRoot} !== ${installRoot}`);
    }
    if (tmuxStageManifest.installedBinaryPath !== join(installRoot, "bin", "tmux")) {
      throw new Error(`tmux install manifest installedBinaryPath drift: ${tmuxStageManifest.installedBinaryPath}`);
    }

    const stageManifest: StageInstallManifest = {
      version: packageManifest.version,
      buildTarget,
      hostPlatform: process.platform,
      hostArch: process.arch,
      stageRoot,
      installRoot,
      currentLink,
      atmuxBinLink,
      cockpitMirrorLink,
      atmuxBinaryPath: join(installRoot, "bin", "atmux"),
      atmuxBinarySha256: await hashFile(join(stageRoot, "bin", "atmux")),
      atmuxListenerPath: join(installRoot, "bin", "atmux-listener"),
      atmuxListenerSha256: await hashFile(join(stageRoot, "bin", "atmux-listener")),
      atmuxCockpitMirrorPath: join(installRoot, "bin", "atmux-cockpit-mirror"),
      atmuxCockpitMirrorSha256: await hashFile(join(stageRoot, "bin", "atmux-cockpit-mirror")),
      tmuxInstallManifestPath: installManifestPath(stageRoot),
      tmuxBinaryPath: tmuxStageManifest.installedBinaryPath,
      tmuxBinarySha256: await hashFile(join(stageRoot, "bin", "tmux")),
      tmuxVersion: vendoredTmuxVersionTag(),
      templatesPath: join(installRoot, "templates"),
      pluginsPath: join(installRoot, "plugins"),
    };
    await writeJsonFile(join(stageRoot, "install-manifest.json"), stageManifest);

    const probe = await run(join(stageRoot, "bin", "atmux"), ["--version"], repoRoot);
    if (probe.exitCode !== 0 || probe.stdout.trim() !== packageManifest.version) {
      throw new Error(`staged atmux version probe failed: ${probe.stderr || probe.stdout}`);
    }

    return stageManifest;
  } finally {
    await removePath(scratchRoot);
  }
}

export async function validateStageRoot(
  stageRoot: string,
  installRoot: string,
  packageVersion: string,
  currentLink: string,
  atmuxBinLink: string,
  cockpitMirrorLink: string,
): Promise<void> {
  const requiredPaths = [
    join(stageRoot, "bin", "atmux"),
    join(stageRoot, "bin", "atmux-listener"),
    join(stageRoot, "bin", "atmux-cockpit-mirror"),
    join(stageRoot, "bin", "tmux"),
    join(stageRoot, "templates"),
    join(stageRoot, "plugins"),
    join(stageRoot, "install-manifest.json"),
    installManifestPath(stageRoot),
  ];
  for (const path of requiredPaths) {
    if (!existsSync(path)) {
      throw new Error(`staged install missing required path: ${path}`);
    }
  }

  for (const binaryPath of [
    join(stageRoot, "bin", "atmux"),
    join(stageRoot, "bin", "atmux-listener"),
    join(stageRoot, "bin", "atmux-cockpit-mirror"),
    join(stageRoot, "bin", "tmux"),
  ]) {
    const stat = await lstat(binaryPath);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) {
      throw new Error(`staged install binary is not executable: ${binaryPath}`);
    }
  }

  const atmuxProbe = await run(join(stageRoot, "bin", "atmux"), ["--version"], stageRoot);
  if (atmuxProbe.exitCode !== 0 || atmuxProbe.stdout.trim() !== packageVersion) {
    throw new Error(`staged atmux version probe failed: ${atmuxProbe.stderr || atmuxProbe.stdout}`);
  }

  const tmuxProbe = await run(join(stageRoot, "bin", "tmux"), ["-V"], stageRoot);
  if (tmuxProbe.exitCode !== 0 || tmuxProbe.stdout.trim() !== vendoredTmuxVersionTag()) {
    throw new Error(`staged tmux version probe failed: ${tmuxProbe.stderr || tmuxProbe.stdout}`);
  }

  const rootManifest = JSON.parse(await readFile(join(stageRoot, "install-manifest.json"), "utf8")) as StageInstallManifest;
  assertExactMatch("root manifest installRoot", rootManifest.installRoot, installRoot);
  assertExactMatch("root manifest version", rootManifest.version, packageVersion);
  assertExactMatch("root manifest stageRoot", rootManifest.stageRoot, stageRoot);
  assertExactMatch("root manifest currentLink", rootManifest.currentLink, currentLink);
  assertExactMatch("root manifest atmuxBinLink", rootManifest.atmuxBinLink, atmuxBinLink);
  assertExactMatch("root manifest cockpitMirrorLink", rootManifest.cockpitMirrorLink, cockpitMirrorLink);
  assertExactMatch("root manifest buildTarget", rootManifest.buildTarget, hostCompileTarget());
  assertExactMatch("root manifest hostPlatform", rootManifest.hostPlatform, process.platform);
  assertExactMatch("root manifest hostArch", rootManifest.hostArch, process.arch);
  assertExactMatch("root manifest atmuxBinaryPath", rootManifest.atmuxBinaryPath, join(installRoot, "bin", "atmux"));
  assertExactMatch("root manifest atmuxBinarySha256", rootManifest.atmuxBinarySha256, await hashFile(join(stageRoot, "bin", "atmux")));
  assertExactMatch("root manifest atmuxListenerPath", rootManifest.atmuxListenerPath, join(installRoot, "bin", "atmux-listener"));
  assertExactMatch(
    "root manifest atmuxListenerSha256",
    rootManifest.atmuxListenerSha256,
    await hashFile(join(stageRoot, "bin", "atmux-listener")),
  );
  assertExactMatch(
    "root manifest atmuxCockpitMirrorPath",
    rootManifest.atmuxCockpitMirrorPath,
    join(installRoot, "bin", "atmux-cockpit-mirror"),
  );
  assertExactMatch(
    "root manifest atmuxCockpitMirrorSha256",
    rootManifest.atmuxCockpitMirrorSha256,
    await hashFile(join(stageRoot, "bin", "atmux-cockpit-mirror")),
  );
  assertExactMatch("root manifest templatesPath", rootManifest.templatesPath, join(installRoot, "templates"));
  assertExactMatch("root manifest pluginsPath", rootManifest.pluginsPath, join(installRoot, "plugins"));
  assertExactMatch("root manifest tmuxInstallManifestPath", rootManifest.tmuxInstallManifestPath, installManifestPath(stageRoot));
  assertExactMatch("root manifest tmuxBinaryPath", rootManifest.tmuxBinaryPath, join(installRoot, "bin", "tmux"));
  assertExactMatch("root manifest tmuxBinarySha256", rootManifest.tmuxBinarySha256, await hashFile(join(stageRoot, "bin", "tmux")));
  assertExactMatch("root manifest tmuxVersion", rootManifest.tmuxVersion, vendoredTmuxVersionTag());

  const tmuxInstallManifest = JSON.parse(await readFile(installManifestPath(stageRoot), "utf8")) as StagedTmuxManifest;
  assertPopulated("tmux install manifest archiveSha256", tmuxInstallManifest.archiveSha256);
  assertPopulated("tmux install manifest builtBinarySha256", tmuxInstallManifest.builtBinarySha256);
  assertExactMatch("tmux install manifest installedRoot", tmuxInstallManifest.installedRoot, installRoot);
  assertExactMatch("tmux install manifest installedBinaryPath", tmuxInstallManifest.installedBinaryPath, join(installRoot, "bin", "tmux"));
  assertExactMatch(
    "tmux install manifest builtBinarySha256",
    tmuxInstallManifest.builtBinarySha256,
    await hashFile(join(stageRoot, "bin", "tmux")),
  );
  for (const bundled of tmuxInstallManifest.bundledDylibs) {
    assertExactMatch(
      "tmux install manifest bundled dylib sha256",
      bundled.sha256,
      await hashFile(bundled.bundlePath),
    );
  }
}

export async function activateInstallCandidate(
  stageRoot: string,
  finalRoot: string,
  currentLink: string,
  atmuxBinLink: string,
  cockpitMirrorLink: string,
  hooks: ActivationHooks = {},
): Promise<void> {
  const ensureAbsentImpl = hooks.ensureAbsent ?? ensureAbsent;
  const renameImpl = hooks.rename ?? rename;
  const createAtomicSymlinkImpl = hooks.createAtomicSymlink ?? createAtomicSymlink;
  const restoreLinkStateImpl = hooks.restoreLinkState ?? restoreLinkState;
  const writeFileImpl = hooks.writeFile ?? writeFile;
  const validateFinalInstallImpl = hooks.validateFinalInstall ?? validateFinalInstall;
  const currentSnapshot = await snapshotCurrentLink(currentLink);
  const atmuxBinSnapshot = await snapshotLinkState(atmuxBinLink, "atmux binary link");
  const cockpitMirrorSnapshot = await snapshotLinkState(cockpitMirrorLink, "cockpit mirror link");
  const stagedInstallManifest = await readFile(join(stageRoot, "install-manifest.json"), "utf8");
  const stagedTmuxManifest = await readFile(installManifestPath(stageRoot), "utf8");

  let promoted = false;
  try {
    await ensureAbsentImpl(finalRoot);
    await mkdir(dirname(finalRoot), { recursive: true });
    await renameImpl(stageRoot, finalRoot);
    promoted = true;

    await createAtomicSymlinkImpl(finalRoot, currentLink);
    await createAtomicSymlinkImpl(join(currentLink, "bin", "atmux"), atmuxBinLink);
    await createAtomicSymlinkImpl(join(currentLink, "bin", "atmux-cockpit-mirror"), cockpitMirrorLink);

    await writeFinalInstallManifest(finalRoot);
    await writeFinalTmuxManifest(finalRoot);
    await validateFinalInstallImpl(finalRoot, currentLink, atmuxBinLink, cockpitMirrorLink);
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const snapshot of [cockpitMirrorSnapshot, atmuxBinSnapshot, currentSnapshot]) {
      try {
        await restoreLinkStateImpl(snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (promoted) {
      try {
        await renameImpl(finalRoot, stageRoot);
        const manifestRestores: Array<{ path: string; content: string }> = [
          { path: join(stageRoot, "install-manifest.json"), content: stagedInstallManifest },
          { path: installManifestPath(stageRoot), content: stagedTmuxManifest },
        ];
        for (const manifestRestore of manifestRestores) {
          try {
            await writeFileImpl(manifestRestore.path, manifestRestore.content);
          } catch (rollbackError) {
            rollbackFailures.push(rollbackError);
          }
        }
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw aggregateRollbackError(error, rollbackFailures);
    }
    throw error;
  }
}

export async function main(
  argv: ReadonlyArray<string> = process.argv.slice(2),
  buildTmuxStage: BuildVendoredTmuxStageFn = buildVendoredTmuxStage,
): Promise<void> {
  const { join, dirname, resolve } = await import("node:path");
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const { VENDORED_TMUX_CURRENT_LINK, VENDORED_TMUX_INSTALL_ROOT } = await import("../src/core/tmux-bundle.ts");

  const repoRoot = process.cwd();
  const packageManifest = await readPackageManifest(repoRoot);
  const stageOptions = parseArgs(argv);
  const installRoot = resolve(stageOptions.installRoot ?? join(VENDORED_TMUX_INSTALL_ROOT, packageManifest.version));
  const currentLink = resolve(stageOptions.currentLink ?? VENDORED_TMUX_CURRENT_LINK);
  const atmuxBinLink = resolve(stageOptions.atmuxBinLink ?? "/usr/local/bin/atmux");
  const cockpitMirrorLink = resolve(stageOptions.cockpitMirrorLink ?? "/usr/local/bin/atmux-cockpit-mirror");

  await mkdir(dirname(installRoot), { recursive: true });
  const stageRoot = await mkdtemp(join(dirname(installRoot), ".atmux-install-stage-"));
  try {
    await stageCorePayload(
      repoRoot,
      stageRoot,
      installRoot,
      currentLink,
      atmuxBinLink,
      cockpitMirrorLink,
      stageOptions.sourceTarball,
      buildTmuxStage,
    );
    await validateStageRoot(stageRoot, installRoot, packageManifest.version, currentLink, atmuxBinLink, cockpitMirrorLink);
    await activateInstallCandidate(stageRoot, installRoot, currentLink, atmuxBinLink, cockpitMirrorLink);
  } catch (error) {
    await Promise.allSettled([rm(stageRoot, { recursive: true, force: true })]);
    throw error;
  }
}

export async function runCli(
  isMain: boolean,
  argv: ReadonlyArray<string> = process.argv.slice(2),
  invoke: typeof main = main,
): Promise<void> {
  if (!isMain) {
    return;
  }
  await invoke(argv);
}

await runCli(import.meta.main);
