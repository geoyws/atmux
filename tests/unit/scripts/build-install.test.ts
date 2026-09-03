import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activateInstallCandidate,
  aggregateRollbackError,
  copyTree,
  hostCompileTarget,
  parseArgs,
  readPackageManifest,
  restoreLinkState,
  runCli,
  snapshotLinkState,
  validateFinalInstall,
  validateStageRoot,
  whichOrThrow,
} from "../../../scripts/build-install.ts";
import { vendoredTmuxVersionTag } from "../../../src/core/tmux-bundle.ts";
import {
  hashFile,
  installManifestPath,
  writeJsonFile,
} from "../../../src/core/vendored-tmux-install.ts";

async function readPackageVersion(repoRoot: string): Promise<string> {
  const parsed = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  };
  return parsed.version;
}

async function makeExecutableScript(path: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

async function prepareFakeCandidate(options: {
  stageRoot: string;
  installRoot: string;
  currentLink: string;
  atmuxBinLink: string;
  cockpitMirrorLink: string;
  packageVersion: string;
  tmuxOutput: string;
  rootHashOverride?: string;
  bundledDylibs?: Array<{
    sourcePath: string;
    bundlePath: string;
    installName: string;
    content: string;
  }>;
}): Promise<void> {
  const {
    stageRoot,
    installRoot,
    currentLink,
    atmuxBinLink,
    cockpitMirrorLink,
    packageVersion,
    tmuxOutput,
    rootHashOverride,
    bundledDylibs = [],
  } = options;
  await mkdir(join(stageRoot, "bin"), { recursive: true });
  await mkdir(join(stageRoot, "templates"), { recursive: true });
  await mkdir(join(stageRoot, "plugins"), { recursive: true });
  await mkdir(join(stageRoot, "vendor", "tmux"), { recursive: true });

  await makeExecutableScript(
    join(stageRoot, "bin", "atmux"),
    `case "$1" in --version) printf '%s\\n' '${packageVersion}' ;; *) exit 0 ;; esac`,
  );
  await makeExecutableScript(join(stageRoot, "bin", "atmux-listener"), "exit 0");
  await makeExecutableScript(join(stageRoot, "bin", "atmux-cockpit-mirror"), "exit 0");
  await makeExecutableScript(
    join(stageRoot, "bin", "tmux"),
    `case "$1" in -V) printf '%s\\n' '${tmuxOutput}' ;; *) exit 0 ;; esac`,
  );

  await writeFile(join(stageRoot, "templates", "stub.txt"), "template\n");
  await writeFile(join(stageRoot, "plugins", "stub.txt"), "plugin\n");
  for (const bundled of bundledDylibs) {
    await mkdir(dirname(bundled.bundlePath), { recursive: true });
    await writeFile(bundled.bundlePath, bundled.content);
  }

  const tmuxManifestPath = installManifestPath(stageRoot);
  await writeJsonFile(tmuxManifestPath, {
    version: "3.7c",
    sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
    sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
    archiveSha256: "feedface",
    archivePath: "/private/tmp/tmux-3.7c.tar.gz",
    sourceExtractionRoot: join(stageRoot, "source"),
    sourceRoot: "tmux-3.7c",
    builtBinaryPath: join(stageRoot, "bin", "tmux"),
    builtBinarySha256: await hashFile(join(stageRoot, "bin", "tmux")),
    installedBinaryPath: join(installRoot, "bin", "tmux"),
    installedRoot: installRoot,
    bundledDylibs: await Promise.all(
      bundledDylibs.map(async (bundled) => ({
        sourcePath: bundled.sourcePath,
        bundlePath: bundled.bundlePath,
        installName: bundled.installName,
        sha256: await hashFile(bundled.bundlePath),
      })),
    ),
  });

  const rootManifest = {
    version: packageVersion,
    buildTarget: hostCompileTarget(),
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
    tmuxInstallManifestPath: tmuxManifestPath,
    tmuxBinaryPath: join(installRoot, "bin", "tmux"),
    tmuxBinarySha256: rootHashOverride ?? (await hashFile(join(stageRoot, "bin", "tmux"))),
    tmuxVersion: vendoredTmuxVersionTag(),
    templatesPath: join(installRoot, "templates"),
    pluginsPath: join(installRoot, "plugins"),
  };
  await writeJsonFile(join(stageRoot, "install-manifest.json"), rootManifest);
}

describe("build-install staged candidate safety", () => {
  test("runCli skips invoke when the module is not the entrypoint", async () => {
    let invokeCount = 0;

    await runCli(false, ["--install-root", "/tmp/ignored"], async () => {
      invokeCount += 1;
    });

    expect(invokeCount).toBe(0);
  });

  test("runCli forwards argv to main when the module is the entrypoint", async () => {
    const argv = ["--install-root", "/tmp/atmux"];
    let receivedArgv: ReadonlyArray<string> | undefined;

    await runCli(true, argv, async (passedArgv) => {
      receivedArgv = passedArgv;
    });

    expect(receivedArgv).toBe(argv);
  });

  test("validateStageRoot rejects version drift without touching the final root", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "bin", "atmux");
      const cockpitMirrorLink = join(scratch, "bin", "atmux-cockpit-mirror");

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: "tmux 3.6a",
      });

      await expect(
        validateStageRoot(
          stageRoot,
          installRoot,
          packageVersion,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
        ),
      ).rejects.toThrow(/tmux version probe failed/);
      expect(existsSync(installRoot)).toBe(false);
      expect(existsSync(currentLink)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("validateStageRoot rejects checksum drift without touching the final root", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "bin", "atmux");
      const cockpitMirrorLink = join(scratch, "bin", "atmux-cockpit-mirror");

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
        rootHashOverride: "deadbeef",
      });

      await expect(
        validateStageRoot(
          stageRoot,
          installRoot,
          packageVersion,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
        ),
      ).rejects.toThrow(/tmuxBinarySha256 drift/);
      expect(existsSync(installRoot)).toBe(false);
      expect(existsSync(currentLink)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("validateStageRoot rejects missing required paths without touching the final root", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "bin", "atmux");
      const cockpitMirrorLink = join(scratch, "bin", "atmux-cockpit-mirror");

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });
      await rm(join(stageRoot, "plugins"), { recursive: true, force: true });

      await expect(
        validateStageRoot(
          stageRoot,
          installRoot,
          packageVersion,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
        ),
      ).rejects.toThrow(/staged install missing required path/);
      expect(existsSync(installRoot)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("validateStageRoot rejects non-executable staged binaries", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "bin", "atmux");
      const cockpitMirrorLink = join(scratch, "bin", "atmux-cockpit-mirror");

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });
      await chmod(join(stageRoot, "bin", "atmux"), 0o644);

      await expect(
        validateStageRoot(
          stageRoot,
          installRoot,
          packageVersion,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
        ),
      ).rejects.toThrow(/staged install binary is not executable/);
      expect(existsSync(installRoot)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("validateStageRoot rejects staged atmux version drift", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "bin", "atmux");
      const cockpitMirrorLink = join(scratch, "bin", "atmux-cockpit-mirror");

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });
      await makeExecutableScript(
        join(stageRoot, "bin", "atmux"),
        `case "$1" in --version) printf '%s\\n' '0.0.0' ;; *) exit 0 ;; esac`,
      );

      await expect(
        validateStageRoot(
          stageRoot,
          installRoot,
          packageVersion,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
        ),
      ).rejects.toThrow(/staged atmux version probe failed/);
      expect(existsSync(installRoot)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("activateInstallCandidate publishes the candidate and retargets the current link atomically", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "links", "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");
      const previousRoot = join(scratch, "opt", "atmux", "previous");
      const bundledDylibBundlePath = join(stageRoot, "lib", "libtmux-helper.dylib");

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
        bundledDylibs: [
          {
            sourcePath: "/usr/local/lib/libtmux-helper.dylib",
            bundlePath: bundledDylibBundlePath,
            installName: "@rpath/libtmux-helper.dylib",
            content: "helper\n",
          },
        ],
      });

      await mkdir(dirname(currentLink), { recursive: true });
      await mkdir(dirname(atmuxBinLink), { recursive: true });
      await mkdir(dirname(cockpitMirrorLink), { recursive: true });
      await mkdir(previousRoot, { recursive: true });
      await symlink(previousRoot, currentLink);
      await symlink(join(currentLink, "bin", "atmux"), atmuxBinLink);
      await symlink(join(currentLink, "bin", "atmux-cockpit-mirror"), cockpitMirrorLink);

      await validateStageRoot(
        stageRoot,
        installRoot,
        packageVersion,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
      );
      await activateInstallCandidate(
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
      );

      expect(existsSync(installRoot)).toBe(true);
      expect(existsSync(stageRoot)).toBe(false);
      expect(await readlink(currentLink)).toBe(installRoot);
      expect(await readlink(atmuxBinLink)).toBe(join(currentLink, "bin", "atmux"));
      expect(await readlink(cockpitMirrorLink)).toBe(
        join(currentLink, "bin", "atmux-cockpit-mirror"),
      );

      const rootManifest = JSON.parse(
        await readFile(join(installRoot, "install-manifest.json"), "utf8"),
      ) as {
        stageRoot?: string;
        installRoot: string;
        tmuxInstallManifestPath: string;
      };
      const tmuxManifest = JSON.parse(
        await readFile(join(installRoot, "vendor", "tmux", "install-manifest.json"), "utf8"),
      ) as {
        archivePath?: string;
        sourceExtractionRoot?: string;
        sourceRoot?: string;
        builtBinaryPath: string;
        installedRoot: string;
        installedBinaryPath: string;
        bundledDylibs: Array<{
          finalPath: string;
          sourcePath: string;
          installName: string;
          sha256: string;
        }>;
      };
      expect(rootManifest.stageRoot).toBeUndefined();
      expect(rootManifest.installRoot).toBe(installRoot);
      expect(rootManifest.tmuxInstallManifestPath).toBe(
        join(installRoot, "vendor", "tmux", "install-manifest.json"),
      );
      expect(tmuxManifest.archivePath).toBeUndefined();
      expect(tmuxManifest.sourceExtractionRoot).toBeUndefined();
      expect(tmuxManifest.sourceRoot).toBeUndefined();
      expect(tmuxManifest.builtBinaryPath).toBe(join(installRoot, "bin", "tmux"));
      expect(tmuxManifest.installedRoot).toBe(installRoot);
      expect(tmuxManifest.installedBinaryPath).toBe(join(installRoot, "bin", "tmux"));
      expect(tmuxManifest.bundledDylibs).toHaveLength(1);
      expect(tmuxManifest.bundledDylibs[0]).toEqual({
        finalPath: join(installRoot, "lib", "libtmux-helper.dylib"),
        sourcePath: "/usr/local/lib/libtmux-helper.dylib",
        installName: "@rpath/libtmux-helper.dylib",
        sha256: await hashFile(join(installRoot, "lib", "libtmux-helper.dylib")),
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("activateInstallCandidate rolls back the current link when post-publish symlink creation fails", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLinkDir = join(scratch, "links", "blocked");
      const atmuxBinLink = join(atmuxBinLinkDir, "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");
      const previousRoot = join(scratch, "opt", "atmux", "previous");

      await mkdir(join(scratch, "links"), { recursive: true });
      await mkdir(previousRoot, { recursive: true });
      await writeFile(atmuxBinLinkDir, "blocked\n");
      await symlink(previousRoot, currentLink);

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });

      await expect(
        activateInstallCandidate(
          stageRoot,
          installRoot,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
        ),
      ).rejects.toThrow();

      expect(existsSync(stageRoot)).toBe(true);
      expect(existsSync(installRoot)).toBe(false);
      expect(await readlink(currentLink)).toBe(previousRoot);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("activateInstallCandidate rejects unsafe existing file destinations before publish", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "links", "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });

      await mkdir(dirname(currentLink), { recursive: true });
      await writeFile(currentLink, "occupied\n");

      await expect(
        activateInstallCandidate(
          stageRoot,
          installRoot,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
        ),
      ).rejects.toThrow(/unsafe existing destination/);
      expect(existsSync(installRoot)).toBe(false);
      expect(existsSync(stageRoot)).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("activateInstallCandidate aggregates rollback failures and attempts every restore", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "links", "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");
      const previousRoot = join(scratch, "opt", "atmux", "previous");
      const restoreAttempts: string[] = [];

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });

      await mkdir(dirname(currentLink), { recursive: true });
      await mkdir(dirname(atmuxBinLink), { recursive: true });
      await mkdir(dirname(cockpitMirrorLink), { recursive: true });
      await mkdir(previousRoot, { recursive: true });
      await symlink(previousRoot, currentLink);

      await expect(
        activateInstallCandidate(
          stageRoot,
          installRoot,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
          {
            createAtomicSymlink: async (target: string, linkPath: string) => {
              if (linkPath === atmuxBinLink) {
                throw new Error("injected publish failure");
              }
              await symlink(target, linkPath);
            },
            restoreLinkState: async (snapshot: {
              path: string;
              existed: boolean;
              target?: string;
            }) => {
              restoreAttempts.push(snapshot.path);
              throw new Error(`injected rollback failure for ${snapshot.path}`);
            },
          },
        ),
      ).rejects.toThrow(/rollback encountered errors|injected publish failure/);

      expect(restoreAttempts).toEqual([cockpitMirrorLink, atmuxBinLink, currentLink]);
      expect(await readlink(currentLink)).toBe(previousRoot);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("activateInstallCandidate restores staged manifests after a post-manifest failure and retries cleanly", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "links", "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");
      const previousRoot = join(scratch, "opt", "atmux", "previous");

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });

      await mkdir(dirname(currentLink), { recursive: true });
      await mkdir(dirname(atmuxBinLink), { recursive: true });
      await mkdir(dirname(cockpitMirrorLink), { recursive: true });
      await mkdir(previousRoot, { recursive: true });
      await symlink(previousRoot, currentLink);
      await symlink(join(currentLink, "bin", "atmux"), atmuxBinLink);
      await symlink(join(currentLink, "bin", "atmux-cockpit-mirror"), cockpitMirrorLink);

      await expect(
        activateInstallCandidate(
          stageRoot,
          installRoot,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
          {
            validateFinalInstall: async () => {
              throw new Error("injected post-manifest failure");
            },
          },
        ),
      ).rejects.toThrow(/injected post-manifest failure/);

      expect(existsSync(stageRoot)).toBe(true);
      expect(existsSync(installRoot)).toBe(false);
      expect(await readlink(currentLink)).toBe(previousRoot);

      const restoredRootManifest = JSON.parse(
        await readFile(join(stageRoot, "install-manifest.json"), "utf8"),
      ) as {
        stageRoot: string;
        installRoot: string;
        tmuxInstallManifestPath: string;
      };
      const restoredTmuxManifest = JSON.parse(
        await readFile(join(stageRoot, "vendor", "tmux", "install-manifest.json"), "utf8"),
      ) as {
        archivePath: string;
        sourceExtractionRoot: string;
        sourceRoot: string;
        installedRoot: string;
        installedBinaryPath: string;
      };
      expect(restoredRootManifest.stageRoot).toBe(stageRoot);
      expect(restoredRootManifest.installRoot).toBe(installRoot);
      expect(restoredRootManifest.tmuxInstallManifestPath).toBe(
        join(stageRoot, "vendor", "tmux", "install-manifest.json"),
      );
      expect(restoredTmuxManifest.archivePath).toBe("/private/tmp/tmux-3.7c.tar.gz");
      expect(restoredTmuxManifest.sourceExtractionRoot).toBe(join(stageRoot, "source"));
      expect(restoredTmuxManifest.sourceRoot).toBe("tmux-3.7c");
      expect(restoredTmuxManifest.installedRoot).toBe(installRoot);
      expect(restoredTmuxManifest.installedBinaryPath).toBe(join(installRoot, "bin", "tmux"));

      await activateInstallCandidate(
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
      );
      expect(await readlink(currentLink)).toBe(installRoot);
      expect(existsSync(stageRoot)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("activateInstallCandidate succeeds when the current and destination links are absent", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "links", "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });

      await activateInstallCandidate(
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
      );

      expect(await readlink(currentLink)).toBe(installRoot);
      expect(await readlink(atmuxBinLink)).toBe(join(currentLink, "bin", "atmux"));
      expect(await readlink(cockpitMirrorLink)).toBe(
        join(currentLink, "bin", "atmux-cockpit-mirror"),
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("activateInstallCandidate reports rollback rename failures after promotion", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "links", "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");
      const previousRoot = join(scratch, "opt", "atmux", "previous");
      let renameCalls = 0;

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });

      await mkdir(dirname(currentLink), { recursive: true });
      await mkdir(dirname(atmuxBinLink), { recursive: true });
      await mkdir(dirname(cockpitMirrorLink), { recursive: true });
      await mkdir(previousRoot, { recursive: true });
      await symlink(previousRoot, currentLink);
      await symlink(join(currentLink, "bin", "atmux"), atmuxBinLink);
      await symlink(join(currentLink, "bin", "atmux-cockpit-mirror"), cockpitMirrorLink);

      await expect(
        activateInstallCandidate(
          stageRoot,
          installRoot,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
          {
            validateFinalInstall: async () => {
              throw new Error("injected post-manifest failure");
            },
            rename: async (
              from: Parameters<typeof rename>[0],
              to: Parameters<typeof rename>[1],
            ) => {
              renameCalls += 1;
              if (renameCalls === 2) {
                throw new Error("injected rollback rename failure");
              }
              await rename(from, to);
            },
          },
        ),
      ).rejects.toThrow(/rollback encountered errors/);

      expect(renameCalls).toBe(2);
      expect(await readlink(currentLink)).toBe(previousRoot);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("activateInstallCandidate attempts both manifest restores when the first restore write fails", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "links", "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");
      const previousRoot = join(scratch, "opt", "atmux", "previous");
      const restoreWrites: string[] = [];

      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });

      await mkdir(dirname(currentLink), { recursive: true });
      await mkdir(dirname(atmuxBinLink), { recursive: true });
      await mkdir(dirname(cockpitMirrorLink), { recursive: true });
      await mkdir(previousRoot, { recursive: true });
      await symlink(previousRoot, currentLink);
      await symlink(join(currentLink, "bin", "atmux"), atmuxBinLink);
      await symlink(join(currentLink, "bin", "atmux-cockpit-mirror"), cockpitMirrorLink);

      await expect(
        activateInstallCandidate(
          stageRoot,
          installRoot,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
          {
            validateFinalInstall: async () => {
              throw new Error("injected post-manifest failure");
            },
            writeFile: async (
              path: Parameters<typeof writeFile>[0],
              data: Parameters<typeof writeFile>[1],
            ) => {
              if (typeof path !== "string") {
                throw new Error("unexpected non-string restore path");
              }
              restoreWrites.push(path);
              if (path === join(stageRoot, "install-manifest.json")) {
                throw new Error("injected root manifest restore failure");
              }
              await writeFile(path, data);
            },
          },
        ),
      ).rejects.toThrow(/rollback encountered errors/);

      expect(restoreWrites).toEqual([
        join(stageRoot, "install-manifest.json"),
        join(stageRoot, "vendor", "tmux", "install-manifest.json"),
      ]);
      expect(await readlink(currentLink)).toBe(previousRoot);
      expect(existsSync(stageRoot)).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("build-install helper coverage", () => {
  test("parseArgs accepts all supported flags", () => {
    expect(
      parseArgs([
        "--source-tarball",
        "/tmp/source.tar.gz",
        "--install-root",
        "/tmp/install",
        "--current-link",
        "/tmp/current",
        "--atmux-bin-link",
        "/tmp/bin/atmux",
        "--cockpit-mirror-link",
        "/tmp/bin/atmux-cockpit-mirror",
      ]),
    ).toEqual({
      sourceTarball: "/tmp/source.tar.gz",
      installRoot: "/tmp/install",
      currentLink: "/tmp/current",
      atmuxBinLink: "/tmp/bin/atmux",
      cockpitMirrorLink: "/tmp/bin/atmux-cockpit-mirror",
    });
  });

  test("parseArgs rejects unknown flags and missing values", () => {
    expect(() => parseArgs(["--ignored"])).toThrow(/unknown build-install arg/);
    expect(() => parseArgs(["--source-tarball"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--install-root", "--current-link", "/tmp/current"])).toThrow(
      /requires a value/,
    );
  });

  test("readPackageManifest rejects missing version", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-manifest-"));
    try {
      await writeFile(join(scratch, "package.json"), JSON.stringify({ name: "atmux" }));
      await expect(readPackageManifest(scratch)).rejects.toThrow(/version missing or invalid/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("copyTree handles files, symlinks, and unsupported entries", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-copy-"));
    try {
      const sourceDir = join(scratch, "source");
      const destDir = join(scratch, "dest");
      const topLevelFile = join(scratch, "payload.txt");
      const unsupportedDir = join(scratch, "unsupported");
      const unsupported = join(unsupportedDir, "fifo");
      const fileSource = join(sourceDir, "file.txt");
      const linkSource = join(sourceDir, "link");
      const topLevelLink = join(scratch, "payload-link");
      const nestedDir = join(sourceDir, "nested");
      const nestedFile = join(nestedDir, "payload.txt");
      const nestedUnsupportedDir = join(scratch, "nested-unsupported");
      const nestedUnsupported = join(nestedUnsupportedDir, "pipe");
      await mkdir(nestedDir, { recursive: true });
      await mkdir(nestedUnsupportedDir, { recursive: true });
      await mkdir(unsupportedDir, { recursive: true });
      await writeFile(topLevelFile, "top-level\n");
      await writeFile(fileSource, "payload\n");
      await writeFile(nestedFile, "nested\n");
      await symlink("payload.txt", topLevelLink);
      await symlink("file.txt", linkSource);
      const topLevelFifo = spawnSync("mkfifo", [unsupported]);
      expect(topLevelFifo.status).toBe(0);
      const nestedFifo = spawnSync("mkfifo", [nestedUnsupported]);
      expect(nestedFifo.status).toBe(0);

      await copyTree(topLevelFile, join(scratch, "top-level-copy.txt"));
      await copyTree(topLevelLink, join(scratch, "top-level-link-copy"));
      await copyTree(sourceDir, destDir);
      expect(await readFile(join(scratch, "top-level-copy.txt"), "utf8")).toBe("top-level\n");
      expect(await readlink(join(scratch, "top-level-link-copy"))).toBe("payload.txt");
      expect(await readFile(join(destDir, "file.txt"), "utf8")).toBe("payload\n");
      expect(await readFile(join(destDir, "nested", "payload.txt"), "utf8")).toBe("nested\n");
      expect(await readlink(join(destDir, "link"))).toBe("file.txt");
      await expect(copyTree(unsupported, join(scratch, "fifo-copy"))).rejects.toThrow(
        /unsupported payload entry/,
      );
      await expect(copyTree(nestedUnsupportedDir, join(scratch, "nested-copy"))).rejects.toThrow(
        /unsupported payload entry/,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("snapshot and restore link state cover missing, symlink, and unsafe destinations", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-links-"));
    try {
      const missing = join(scratch, "missing");
      const target = join(scratch, "target");
      const link = join(scratch, "link");
      const file = join(scratch, "file");
      await mkdir(target, { recursive: true });
      await symlink(target, link);
      await writeFile(file, "occupied\n");

      expect(await snapshotLinkState(missing, "missing")).toEqual({
        path: missing,
        existed: false,
      });
      expect(await snapshotLinkState(link, "link")).toEqual({ path: link, existed: true, target });
      await expect(snapshotLinkState(file, "file")).rejects.toThrow(/unsafe existing destination/);
      await expect(
        restoreLinkState({ path: join(scratch, "orphan"), existed: true }),
      ).rejects.toThrow(/missing target/);
      await restoreLinkState({ path: join(scratch, "absent"), existed: false });
      expect(existsSync(join(scratch, "absent"))).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("activateInstallCandidate surfaces non-ENOENT current-link snapshot failures", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-snapshot-error-"));
    try {
      const repoRoot = join(import.meta.dir, "../../..");
      const packageVersion = await readPackageVersion(repoRoot);
      const blockedParent = join(scratch, "blocked");
      const stageRoot = join(scratch, "stage");
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(blockedParent, "current");
      const atmuxBinLink = join(scratch, "links", "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");

      await mkdir(blockedParent, { recursive: true });
      await chmod(blockedParent, 0o000);
      await prepareFakeCandidate({
        stageRoot,
        installRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        packageVersion,
        tmuxOutput: vendoredTmuxVersionTag(),
      });

      await expect(
        activateInstallCandidate(
          stageRoot,
          installRoot,
          currentLink,
          atmuxBinLink,
          cockpitMirrorLink,
        ),
      ).rejects.toThrow();
    } finally {
      await chmod(join(scratch, "blocked"), 0o755);
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("validateFinalInstall rejects manifests that retain stageRoot", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-final-stage-"));
    try {
      const finalRoot = join(scratch, "opt", "atmux", "final");
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "links", "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");

      await mkdir(join(finalRoot, "bin"), { recursive: true });
      await writeFile(join(finalRoot, "bin", "tmux"), "#!/bin/sh\nexit 0\n");
      await chmod(join(finalRoot, "bin", "tmux"), 0o755);
      await writeJsonFile(join(finalRoot, "install-manifest.json"), {
        version: "3.0.0",
        buildTarget: hostCompileTarget(),
        hostPlatform: process.platform,
        hostArch: process.arch,
        stageRoot: join(scratch, "stage"),
        installRoot: finalRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        atmuxBinaryPath: join(finalRoot, "bin", "atmux"),
        atmuxBinarySha256: "deadbeef",
        atmuxListenerPath: join(finalRoot, "bin", "atmux-listener"),
        atmuxListenerSha256: "deadbeef",
        atmuxCockpitMirrorPath: join(finalRoot, "bin", "atmux-cockpit-mirror"),
        atmuxCockpitMirrorSha256: "deadbeef",
        tmuxInstallManifestPath: installManifestPath(finalRoot),
        tmuxBinaryPath: join(finalRoot, "bin", "tmux"),
        tmuxBinarySha256: await hashFile(join(finalRoot, "bin", "tmux")),
        tmuxVersion: vendoredTmuxVersionTag(),
        templatesPath: join(finalRoot, "templates"),
        pluginsPath: join(finalRoot, "plugins"),
      });
      await writeJsonFile(installManifestPath(finalRoot), {
        version: "3.7c",
        sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
        sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
        archiveSha256: "feedface",
        builtBinaryPath: join(finalRoot, "bin", "tmux"),
        builtBinarySha256: await hashFile(join(finalRoot, "bin", "tmux")),
        installedBinaryPath: join(finalRoot, "bin", "tmux"),
        installedRoot: finalRoot,
        bundledDylibs: [],
      });

      await expect(
        validateFinalInstall(finalRoot, currentLink, atmuxBinLink, cockpitMirrorLink),
      ).rejects.toThrow(/must not retain stageRoot/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("validateFinalInstall rejects empty bundled dylib fields", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-final-empty-"));
    try {
      const finalRoot = join(scratch, "opt", "atmux", "final");
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "links", "atmux");
      const cockpitMirrorLink = join(scratch, "links", "atmux-cockpit-mirror");

      await mkdir(join(finalRoot, "bin"), { recursive: true });
      await mkdir(join(finalRoot, "lib"), { recursive: true });
      await writeFile(join(finalRoot, "bin", "tmux"), "#!/bin/sh\nexit 0\n");
      await chmod(join(finalRoot, "bin", "tmux"), 0o755);
      await writeFile(join(finalRoot, "lib", "libexample.dylib"), "payload\n");
      await writeJsonFile(join(finalRoot, "install-manifest.json"), {
        version: "3.0.0",
        buildTarget: hostCompileTarget(),
        hostPlatform: process.platform,
        hostArch: process.arch,
        installRoot: finalRoot,
        currentLink,
        atmuxBinLink,
        cockpitMirrorLink,
        atmuxBinaryPath: join(finalRoot, "bin", "atmux"),
        atmuxBinarySha256: "deadbeef",
        atmuxListenerPath: join(finalRoot, "bin", "atmux-listener"),
        atmuxListenerSha256: "deadbeef",
        atmuxCockpitMirrorPath: join(finalRoot, "bin", "atmux-cockpit-mirror"),
        atmuxCockpitMirrorSha256: "deadbeef",
        tmuxInstallManifestPath: installManifestPath(finalRoot),
        tmuxBinaryPath: join(finalRoot, "bin", "tmux"),
        tmuxBinarySha256: await hashFile(join(finalRoot, "bin", "tmux")),
        tmuxVersion: vendoredTmuxVersionTag(),
        templatesPath: join(finalRoot, "templates"),
        pluginsPath: join(finalRoot, "plugins"),
      });
      await writeJsonFile(installManifestPath(finalRoot), {
        version: "3.7c",
        sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
        sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
        archiveSha256: "feedface",
        builtBinaryPath: join(finalRoot, "bin", "tmux"),
        builtBinarySha256: await hashFile(join(finalRoot, "bin", "tmux")),
        installedBinaryPath: join(finalRoot, "bin", "tmux"),
        installedRoot: finalRoot,
        bundledDylibs: [
          {
            sourcePath: "",
            finalPath: join(finalRoot, "lib", "libexample.dylib"),
            installName: "@rpath/libexample.dylib",
            sha256: await hashFile(join(finalRoot, "lib", "libexample.dylib")),
          },
        ],
      });

      await expect(
        validateFinalInstall(finalRoot, currentLink, atmuxBinLink, cockpitMirrorLink),
      ).rejects.toThrow(/must be populated/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("whichOrThrow rejects missing binaries", () => {
    expect(() => whichOrThrow("definitely-not-on-path")).toThrow(/not found on PATH/);
  });

  test("aggregateRollbackError falls back when AggregateError is unavailable", () => {
    const originalAggregateError = globalThis.AggregateError;
    try {
      // Force the non-native fallback so the manual message assembly stays covered.
      // @ts-expect-error - the test intentionally simulates an older runtime.
      globalThis.AggregateError = undefined;
      const error = aggregateRollbackError(new Error("primary"), [new Error("secondary")]);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("install activation failed and rollback encountered errors");
      expect(error.message).toContain("primary");
      expect(error.message).toContain("secondary");
    } finally {
      globalThis.AggregateError = originalAggregateError;
    }
  });
});
