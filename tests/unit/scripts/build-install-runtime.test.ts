import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as nodeChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { vendoredTmuxVersionTag } from "../../../src/core/tmux-bundle.ts";
import { hashFile } from "../../../src/core/vendored-tmux-install.ts";

const childProcessSnapshot = { ...nodeChildProcess };

function encodeString(buffer: Buffer, value: string, start: number, length: number): void {
  buffer.fill(0, start, start + length);
  buffer.write(value, start, Math.min(Buffer.byteLength(value), length), "utf8");
}

function encodeOctal(buffer: Buffer, value: number, start: number, length: number): void {
  const width = length - 1;
  const text = value.toString(8).padStart(width, "0");
  buffer.fill(0, start, start + length);
  buffer.write(text, start + (width - text.length));
}

function buildTar(
  entries: ReadonlyArray<{ path: string; type: "file" | "directory"; content?: string }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    const isDir = entry.type === "directory";
    const path = isDir && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
    encodeString(header, path, 0, 100);
    encodeOctal(header, isDir ? 0o755 : 0o644, 100, 8);
    encodeOctal(header, 0, 108, 8);
    encodeOctal(header, 0, 116, 8);
    const content = entry.type === "file" ? Buffer.from(entry.content ?? "") : Buffer.alloc(0);
    encodeOctal(header, content.length, 124, 12);
    encodeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(isDir ? "5" : "0", 156, 1, "utf8");
    encodeString(header, "ustar", 257, 6);
    encodeString(header, "00", 263, 2);
    encodeString(header, "root", 265, 32);
    encodeString(header, "wheel", 297, 32);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    encodeOctal(header, checksum, 148, 8);
    chunks.push(header);
    if (content.length > 0) {
      chunks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) {
        chunks.push(Buffer.alloc(padding, 0));
      }
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function gzippedTar(
  entries: ReadonlyArray<{ path: string; type: "file" | "directory"; content?: string }>,
): { gz: Buffer; sha256: string } {
  const tar = buildTar(entries);
  const gz = gzipSync(tar);
  const sha256 = createHash("sha256").update(gz).digest("hex");
  return { gz, sha256 };
}

function makeExecutableScript(path: string, body: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return Promise.resolve();
}

afterEach(() => {
  mock.restore();
});

describe("scripts/build-install runtime", () => {
  test("main drives the staged install using mocked process tooling", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-runtime-"));
    const repoRoot = join(import.meta.dir, "../../..");
    const installRoot = join(scratch, "opt", "atmux", "install");
    const currentLink = join(scratch, "opt", "atmux", "current");
    const atmuxBinLink = join(scratch, "usr", "local", "bin", "atmux");
    const cockpitMirrorLink = join(scratch, "usr", "local", "bin", "atmux-cockpit-mirror");
    const sourceTarball = join(scratch, "tmux-3.7c.tar.gz");
    const packageVersion = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"))
      .version as string;
    const tmuxVersion = "tmux 3.7c";
    const { gz } = gzippedTar([
      { path: "tmux-3.7c", type: "directory" },
      { path: "tmux-3.7c/README", type: "file", content: "hello\n" },
    ]);
    await writeFile(sourceTarball, gz);

    const calls: Array<{
      command: string;
      args: string[];
      cwd: string;
      env?: Record<string, string>;
    }> = [];
    const whichSpy = spyOn(Bun, "which").mockImplementation((bin: string) => {
      const map: Record<string, string | undefined> = {
        make: "/usr/bin/make",
        cc: "/usr/bin/cc",
        cargo: "/usr/bin/cargo",
        "pkg-config": "/opt/homebrew/bin/pkg-config",
      };
      return map[bin] ?? null;
    });

    try {
      const buildTmuxStage = mock(async (bundledStageRoot: string, bundledInstallRoot: string) => {
        await makeExecutableScript(
          join(bundledStageRoot, "bin", "tmux"),
          `case "$1" in -V) printf '%s\\n' '${tmuxVersion}' ;; *) exit 0 ;; esac`,
        );
        const tmuxSha256 = await hashFile(join(bundledStageRoot, "bin", "tmux"));
        await mkdir(join(bundledStageRoot, "vendor", "tmux"), { recursive: true });
        await writeFile(
          join(bundledStageRoot, "vendor", "tmux", "install-manifest.json"),
          `${JSON.stringify(
            {
              version: "3.7c",
              sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
              sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
              archiveSha256: "feedface",
              builtBinaryPath: join(bundledStageRoot, "bin", "tmux"),
              builtBinarySha256: tmuxSha256,
              installedBinaryPath: join(bundledInstallRoot, "bin", "tmux"),
              installedRoot: bundledInstallRoot,
              bundledDylibs: [],
            },
            null,
            2,
          )}\n`,
        );
        return {
          version: "3.7c",
          sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
          sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
          archiveSha256: "feedface",
          builtBinaryPath: join(bundledStageRoot, "bin", "tmux"),
          builtBinarySha256: tmuxSha256,
          installedBinaryPath: join(bundledInstallRoot, "bin", "tmux"),
          installedRoot: bundledInstallRoot,
          bundledDylibs: [],
        };
      });
      mock.module("node:child_process", () => ({
        ...childProcessSnapshot,
        spawn: mock(
          (
            command: string,
            args: ReadonlyArray<string>,
            options: { cwd: string; env?: NodeJS.ProcessEnv },
          ) => {
            calls.push({
              command,
              args: [...args],
              cwd: options.cwd,
              ...(options.env === undefined ? {} : { env: options.env as Record<string, string> }),
            });
            const child = {
              stdout: {
                on(event: string, handler: (chunk: Buffer) => void) {
                  if (event === "data") {
                    if (command === "bun") {
                      handler(Buffer.from(""));
                    } else if (
                      command === "make" ||
                      command === "/usr/bin/make" ||
                      command === "/usr/bin/cargo"
                    ) {
                      handler(Buffer.from(""));
                    } else if (command.endsWith("/atmux") && args[0] === "--version") {
                      handler(Buffer.from(`${packageVersion}\n`));
                    } else if (command.endsWith("/tmux") && args[0] === "-V") {
                      handler(Buffer.from(`${tmuxVersion}\n`));
                    } else if (command === "/opt/homebrew/bin/pkg-config") {
                      handler(Buffer.from(""));
                    }
                  }
                  return child;
                },
              },
              stderr: {
                on(event: string, handler: (chunk: Buffer) => void) {
                  if (event === "data" && command === "/usr/bin/cargo") {
                    handler(Buffer.from("cargo warning\n"));
                  }
                  return child;
                },
              },
              on(event: "error" | "close", handler: (code?: number | Error) => void) {
                if (event === "close") {
                  queueMicrotask(() => {
                    if (command === "bun" && args[0] === "build") {
                      const outfile = args[args.indexOf("--outfile") + 1];
                      if (outfile !== undefined) {
                        void makeExecutableScript(
                          outfile,
                          `case "$1" in --version) printf '%s\\n' '${packageVersion}' ;; *) exit 0 ;; esac`,
                        );
                      }
                    } else if (command === "/usr/bin/cargo" || command === "cargo") {
                      const targetDir = options.env?.CARGO_TARGET_DIR;
                      if (targetDir !== undefined) {
                        const binaryName = args.includes("build")
                          ? options.cwd.endsWith("atmux-listener")
                            ? "atmux-listener"
                            : "atmux-cockpit-mirror"
                          : "unknown";
                        void makeExecutableScript(join(targetDir, "release", binaryName), "exit 0");
                      }
                    } else if (command === "make") {
                      void makeExecutableScript(
                        join(options.cwd, "tmux"),
                        `case "$1" in -V) printf '%s\\n' '${tmuxVersion}' ;; *) exit 0 ;; esac`,
                      );
                    }
                    handler(0);
                  });
                }
                return child;
              },
            };
            return child;
          },
        ),
      }));

      const module = await import("../../../scripts/build-install.ts");
      await module.main(
        [
          "--source-tarball",
          sourceTarball,
          "--install-root",
          installRoot,
          "--current-link",
          currentLink,
          "--atmux-bin-link",
          atmuxBinLink,
          "--cockpit-mirror-link",
          cockpitMirrorLink,
        ],
        buildTmuxStage,
      );

      expect(calls.map((call) => call.command)).toContain("bun");
      expect(calls.map((call) => call.command)).toContain("/usr/bin/cargo");
      expect(await readlink(currentLink)).toBe(installRoot);
      expect(await readlink(atmuxBinLink)).toBe(join(currentLink, "bin", "atmux"));
      expect(await readlink(cockpitMirrorLink)).toBe(
        join(currentLink, "bin", "atmux-cockpit-mirror"),
      );
      expect(await readFile(join(installRoot, "install-manifest.json"), "utf8")).toContain(
        installRoot,
      );
    } finally {
      whichSpy.mockRestore();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("build helpers and main surface the remaining failure paths", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-runtime-fail-"));
    const repoRoot = join(import.meta.dir, "../../..");
    const hostOutput = join(scratch, "host-atmux");
    const cargoTarget = join(scratch, "cargo-target");
    const cargoTargetTwo = join(scratch, "cargo-target-two");
    const cargoTargetThree = join(scratch, "cargo-target-three");
    const packageVersion = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"))
      .version as string;
    let phase:
      | "host-compile-fail"
      | "host-missing-output"
      | "host-version-mismatch"
      | "rust-fail"
      | "rust-missing-output"
      | "rust-non-exec" = "host-compile-fail";

    const whichSpy = spyOn(Bun, "which").mockImplementation((bin: string) => {
      const map: Record<string, string | undefined> = {
        make: "/usr/bin/make",
        cc: "/usr/bin/cc",
        cargo: "/usr/bin/cargo",
        "pkg-config": "/opt/homebrew/bin/pkg-config",
      };
      return map[bin] ?? null;
    });

    try {
      mock.module("node:child_process", () => ({
        ...childProcessSnapshot,
        spawn: mock(
          (
            command: string,
            args: ReadonlyArray<string>,
            options: { cwd: string; env?: NodeJS.ProcessEnv },
          ) => {
            const child = {
              stdout: {
                on(event: string, handler: (chunk: Buffer) => void) {
                  if (event === "data") {
                    if (
                      command === "bun" &&
                      args[0] === "build" &&
                      phase === "host-version-mismatch"
                    ) {
                      handler(Buffer.from(""));
                    } else if (
                      command === hostOutput &&
                      args[0] === "--version" &&
                      phase === "host-version-mismatch"
                    ) {
                      handler(Buffer.from("0.0.0\n"));
                    }
                  }
                  return child;
                },
              },
              stderr: {
                on(event: string, handler: (chunk: Buffer) => void) {
                  if (event === "data") {
                    if (phase === "host-compile-fail" && command === "bun" && args[0] === "build") {
                      handler(Buffer.from("compile failed\n"));
                    } else if (phase === "rust-fail" && command === "/usr/bin/cargo") {
                      handler(Buffer.from("cargo failed\n"));
                    }
                  }
                  return child;
                },
              },
              on(event: "error" | "close", handler: (code?: number | Error) => void) {
                if (event === "close") {
                  queueMicrotask(() => {
                    if (command === "bun" && args[0] === "build") {
                      const outfile = args[args.indexOf("--outfile") + 1];
                      if (phase === "host-version-mismatch" && outfile !== undefined) {
                        void makeExecutableScript(
                          outfile,
                          `case "$1" in --version) printf '%s\\n' '0.0.0' ;; *) exit 0 ;; esac`,
                        );
                      } else if (phase === "host-missing-output") {
                        // Leave the outfile absent so buildHostAtmuxBinary exercises the
                        // explicit "did not produce" guard.
                      }
                      handler(phase === "host-compile-fail" ? 1 : 0);
                      return;
                    }
                    if (command === hostOutput && args[0] === "--version") {
                      handler(0);
                      return;
                    }
                    if (command === "/usr/bin/cargo") {
                      const targetDir = options.env?.CARGO_TARGET_DIR;
                      if (targetDir !== undefined) {
                        const binaryName = options.cwd.endsWith("atmux-listener")
                          ? "atmux-listener"
                          : "atmux-cockpit-mirror";
                        const binaryPath = join(targetDir, "release", binaryName);
                        if (phase === "rust-non-exec") {
                          mkdirSync(join(targetDir, "release"), { recursive: true });
                          writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
                          chmodSync(binaryPath, 0o644);
                        } else if (phase === "rust-missing-output") {
                          // Leave the release binary absent so buildRustBinary exercises the
                          // explicit "did not produce" guard.
                        } else {
                          void makeExecutableScript(binaryPath, "exit 0");
                        }
                      }
                      handler(phase === "rust-fail" ? 1 : 0);
                      return;
                    }
                    handler(0);
                  });
                }
                return child;
              },
            };
            return child;
          },
        ),
      }));

      const module = await import("../../../scripts/build-install.ts");
      await expect(module.buildHostAtmuxBinary(repoRoot, hostOutput)).rejects.toThrow(
        /host atmux compile failed/,
      );

      phase = "host-version-mismatch";
      await expect(module.buildHostAtmuxBinary(repoRoot, hostOutput)).rejects.toThrow(
        /host atmux version probe failed/,
      );

      phase = "rust-fail";
      await expect(
        module.buildRustBinary(repoRoot, "rust/atmux-listener", "atmux-listener", cargoTarget),
      ).rejects.toThrow(/build failed/);

      phase = "rust-non-exec";
      await expect(
        module.buildRustBinary(repoRoot, "rust/atmux-listener", "atmux-listener", cargoTargetTwo),
      ).rejects.toThrow(/not executable/);

      phase = "host-missing-output";
      await rm(hostOutput, { force: true });
      await expect(module.buildHostAtmuxBinary(repoRoot, hostOutput)).rejects.toThrow(
        /did not produce/,
      );

      phase = "rust-missing-output";
      await expect(
        module.buildRustBinary(repoRoot, "rust/atmux-listener", "atmux-listener", cargoTargetThree),
      ).rejects.toThrow(/did not produce/);

      phase = "host-compile-fail";
      const installRoot = join(scratch, "opt", "atmux", packageVersion);
      const currentLink = join(scratch, "opt", "atmux", "current");
      const atmuxBinLink = join(scratch, "usr", "local", "bin", "atmux");
      const cockpitMirrorLink = join(scratch, "usr", "local", "bin", "atmux-cockpit-mirror");
      await expect(
        module.main([
          "--install-root",
          installRoot,
          "--current-link",
          currentLink,
          "--atmux-bin-link",
          atmuxBinLink,
          "--cockpit-mirror-link",
          cockpitMirrorLink,
        ]),
      ).rejects.toThrow(/host atmux compile failed/);

      const stagedDirs = (await readdir(join(scratch, "opt"), { withFileTypes: true })).filter(
        (entry) => entry.name.startsWith(".atmux-install-stage-"),
      );
      expect(stagedDirs).toHaveLength(0);
    } finally {
      whichSpy.mockRestore();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("stageCorePayload reports tmux manifest drift and staged atmux version drift", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-build-stage-core-"));
    const repoRoot = join(import.meta.dir, "../../..");
    const packageVersion = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"))
      .version as string;
    const whichSpy = spyOn(Bun, "which").mockImplementation((bin: string) => {
      const map: Record<string, string | undefined> = {
        make: "/usr/bin/make",
        cc: "/usr/bin/cc",
        cargo: "/usr/bin/cargo",
        "pkg-config": "/opt/homebrew/bin/pkg-config",
      };
      return map[bin] ?? null;
    });

    let stageProbeVersion = packageVersion;
    let manifestDrift = true;
    let binaryPathDrift = false;
    let builtAtmuxBinaryPath: string | undefined;

    try {
      const buildTmuxStage = mock(async (bundledStageRoot: string, bundledInstallRoot: string) => {
        await makeExecutableScript(
          join(bundledStageRoot, "bin", "tmux"),
          `case "$1" in -V) printf '%s\\n' '${vendoredTmuxVersionTag()}' ;; *) exit 0 ;; esac`,
        );
        const tmuxSha256 = await hashFile(join(bundledStageRoot, "bin", "tmux"));
        await mkdir(join(bundledStageRoot, "vendor", "tmux"), { recursive: true });
        await writeFile(
          join(bundledStageRoot, "vendor", "tmux", "install-manifest.json"),
          `${JSON.stringify(
            {
              version: "3.7c",
              sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
              sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
              archiveSha256: "feedface",
              archivePath: "/private/tmp/tmux-3.7c.tar.gz",
              sourceExtractionRoot: join(bundledStageRoot, "source"),
              sourceRoot: "tmux-3.7c",
              builtBinaryPath: join(bundledStageRoot, "bin", "tmux"),
              builtBinarySha256: tmuxSha256,
              installedBinaryPath: join(bundledInstallRoot, "bin", "tmux"),
              installedRoot: bundledInstallRoot,
              bundledDylibs: [],
            },
            null,
            2,
          )}\n`,
        );
        const manifest = {
          version: "3.7c",
          sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
          sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
          archiveSha256: "feedface",
          archivePath: "/private/tmp/tmux-3.7c.tar.gz",
          sourceExtractionRoot: join(bundledStageRoot, "source"),
          sourceRoot: "tmux-3.7c",
          builtBinaryPath: join(bundledStageRoot, "bin", "tmux"),
          builtBinarySha256: tmuxSha256,
          installedBinaryPath: binaryPathDrift
            ? join(bundledInstallRoot, "bin", "tmux-drift")
            : join(bundledInstallRoot, "bin", "tmux"),
          installedRoot: manifestDrift ? join(bundledInstallRoot, "mismatch") : bundledInstallRoot,
          bundledDylibs: [],
        };
        await mkdir(join(bundledInstallRoot, "bin"), { recursive: true });
        await makeExecutableScript(
          join(bundledInstallRoot, "bin", "tmux"),
          `case "$1" in -V) printf '%s\\n' '${vendoredTmuxVersionTag()}' ;; *) exit 0 ;; esac`,
        );
        return manifest;
      });
      mock.module("node:child_process", () => ({
        ...childProcessSnapshot,
        spawn: mock(
          (
            command: string,
            args: ReadonlyArray<string>,
            options: { cwd: string; env?: NodeJS.ProcessEnv },
          ) => {
            const child = {
              stdout: {
                on(event: string, handler: (chunk: Buffer) => void) {
                  if (event === "data") {
                    if (command === "bun" && args[0] === "build") {
                      handler(Buffer.from(""));
                    } else if (command.endsWith("/bin/atmux") && args[0] === "--version") {
                      handler(
                        Buffer.from(
                          `${command === builtAtmuxBinaryPath ? packageVersion : stageProbeVersion}\n`,
                        ),
                      );
                    } else if (command.endsWith("/tmux") && args[0] === "-V") {
                      handler(Buffer.from(`${vendoredTmuxVersionTag()}\n`));
                    } else if (command === "/usr/bin/cargo") {
                      handler(Buffer.from(""));
                    }
                  }
                  return child;
                },
              },
              stderr: {
                on() {
                  return child;
                },
              },
              on(event: "error" | "close", handler: (code?: number | Error) => void) {
                if (event === "close") {
                  queueMicrotask(() => {
                    if (command === "bun" && args[0] === "build") {
                      const outfile = args[args.indexOf("--outfile") + 1];
                      if (outfile !== undefined) {
                        builtAtmuxBinaryPath = outfile;
                        void makeExecutableScript(
                          outfile,
                          `case "$1" in --version) printf '%s\\n' '${packageVersion}' ;; *) exit 0 ;; esac`,
                        );
                      }
                    } else if (command === "/usr/bin/cargo") {
                      const targetDir = options.env?.CARGO_TARGET_DIR;
                      if (targetDir !== undefined) {
                        const binaryName = options.cwd.endsWith("atmux-listener")
                          ? "atmux-listener"
                          : "atmux-cockpit-mirror";
                        void makeExecutableScript(join(targetDir, "release", binaryName), "exit 0");
                      }
                    }
                    handler(0);
                  });
                }
                return child;
              },
            };
            return child;
          },
        ),
      }));

      const module = await import("../../../scripts/build-install.ts");
      const stageRootDrift = join(scratch, "drift-stage");
      const installRootDrift = join(scratch, "opt", "atmux", "drift");
      const currentLinkDrift = join(scratch, "opt", "atmux", "current-drift");
      const atmuxBinLinkDrift = join(scratch, "links", "atmux-drift");
      const cockpitMirrorLinkDrift = join(scratch, "links", "atmux-cockpit-mirror-drift");

      await expect(
        module.stageCorePayload(
          repoRoot,
          stageRootDrift,
          installRootDrift,
          currentLinkDrift,
          atmuxBinLinkDrift,
          cockpitMirrorLinkDrift,
          undefined,
          buildTmuxStage,
        ),
      ).rejects.toThrow(/installedRoot drift/);

      manifestDrift = false;
      stageProbeVersion = "0.0.0";
      const stageRootProbe = join(scratch, "probe-stage");
      const installRootProbe = join(scratch, "opt", "atmux", "probe");
      const currentLinkProbe = join(scratch, "opt", "atmux", "current-probe");
      const atmuxBinLinkProbe = join(scratch, "links", "atmux-probe");
      const cockpitMirrorLinkProbe = join(scratch, "links", "atmux-cockpit-mirror-probe");

      await expect(
        module.stageCorePayload(
          repoRoot,
          stageRootProbe,
          installRootProbe,
          currentLinkProbe,
          atmuxBinLinkProbe,
          cockpitMirrorLinkProbe,
          undefined,
          buildTmuxStage,
        ),
      ).rejects.toThrow(/staged atmux version probe failed/);

      manifestDrift = false;
      binaryPathDrift = true;
      stageProbeVersion = packageVersion;
      const stageRootBinaryDrift = join(scratch, "binary-drift-stage");
      const installRootBinaryDrift = join(scratch, "opt", "atmux", "binary-drift");
      const currentLinkBinaryDrift = join(scratch, "opt", "atmux", "current-binary-drift");
      const atmuxBinLinkBinaryDrift = join(scratch, "links", "atmux-binary-drift");
      const cockpitMirrorLinkBinaryDrift = join(
        scratch,
        "links",
        "atmux-cockpit-mirror-binary-drift",
      );

      await expect(
        module.stageCorePayload(
          repoRoot,
          stageRootBinaryDrift,
          installRootBinaryDrift,
          currentLinkBinaryDrift,
          atmuxBinLinkBinaryDrift,
          cockpitMirrorLinkBinaryDrift,
          undefined,
          buildTmuxStage,
        ),
      ).rejects.toThrow(/installedBinaryPath drift/);
    } finally {
      whichSpy.mockRestore();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
