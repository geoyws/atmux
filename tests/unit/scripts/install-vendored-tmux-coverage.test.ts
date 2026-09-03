import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as nodeChildProcess from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vendoredTmuxVersionTag } from "../../../src/core/tmux-bundle.ts";
import { installManifestPath } from "../../../src/core/vendored-tmux-install.ts";

const childProcessSnapshot = { ...nodeChildProcess };
const originalFetch = globalThis.fetch;
const originalReadFile = nodeFsPromises.readFile.bind(nodeFsPromises);
const bundleManifestPathSuffix = "/scripts/tmux-bundle-manifest.json";

type SpawnOutcome = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  onClose?: () => void | Promise<void>;
};

let bundleManifestFixture: string | undefined;
let spawnBehavior: (
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => SpawnOutcome = () => ({ exitCode: 0 });

function makeExecutableScript(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function createSpawnChild(
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) {
  const outcome = spawnBehavior(command, args, options);
  const child = {
    stdout: {
      on(event: string, handler: (chunk: Buffer) => void) {
        if (event === "data" && outcome.stdout !== undefined) {
          handler(Buffer.from(outcome.stdout));
        }
        return child;
      },
    },
    stderr: {
      on(event: string, handler: (chunk: Buffer) => void) {
        if (event === "data" && outcome.stderr !== undefined) {
          handler(Buffer.from(outcome.stderr));
        }
        return child;
      },
    },
    on(event: "close" | "error", handler: (code?: number | Error) => void) {
      if (event === "close") {
        queueMicrotask(async () => {
          await outcome.onClose?.();
          handler(outcome.exitCode);
        });
      }
      return child;
    },
  };
  return child;
}

mock.module("node:child_process", () => ({
  ...childProcessSnapshot,
  spawn: mock(createSpawnChild),
}));

mock.module("node:fs/promises", () => ({
  ...nodeFsPromises,
  readFile: mock(async (path: string | URL, ...rest: [] | [BufferEncoding]) => {
    const pathText = typeof path === "string" ? path : path.href;
    if (bundleManifestFixture !== undefined && pathText.endsWith(bundleManifestPathSuffix)) {
      return bundleManifestFixture;
    }
    return await originalReadFile(
      path as Parameters<typeof nodeFsPromises.readFile>[0],
      ...(rest as [] | [BufferEncoding]),
    );
  }),
}));

afterEach(() => {
  bundleManifestFixture = undefined;
  spawnBehavior = () => ({ exitCode: 0 });
  globalThis.fetch = originalFetch;
  mock.restore();
});

const modulePromise = import("../../../scripts/install-vendored-tmux.ts");

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) {
    throw new Error("process.platform descriptor missing");
  }
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

async function makeTemporaries(
  prefix: string,
): Promise<{ scratch: string; stageRoot: string; installRoot: string }> {
  const scratch = await mkdtemp(join(tmpdir(), prefix));
  return {
    scratch,
    stageRoot: join(scratch, "stage"),
    installRoot: join(scratch, "opt", "atmux", "3.7c"),
  };
}

describe("scripts/install-vendored-tmux coverage", () => {
  test("bundle manifest drift and tarball helpers", async () => {
    const module = await modulePromise;
    const bundleFixture = {
      version: "3.7c",
      sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
      sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
      configureArgs: ["--disable-utempter"],
      buildCommand: "make",
    };

    bundleManifestFixture = JSON.stringify({ ...bundleFixture, version: "3.7d" });
    await expect(module.readBundleManifest()).rejects.toThrow(/version drift/);
    bundleManifestFixture = JSON.stringify({
      ...bundleFixture,
      sourceUrl: "https://example.invalid/tmux.tar.gz",
    });
    await expect(module.readBundleManifest()).rejects.toThrow(/sourceUrl drift/);
    bundleManifestFixture = JSON.stringify({ ...bundleFixture, sourceSha256: "deadbeef" });
    await expect(module.readBundleManifest()).rejects.toThrow(/sourceSha256 drift/);
    bundleManifestFixture = JSON.stringify(bundleFixture);
    expect(await module.readBundleManifest()).toEqual(bundleFixture);

    const { scratch } = await makeTemporaries("atmux-install-helpers-");
    const sourceTarball = join(scratch, "tmux-3.7c.tar.gz");
    const originalEnv = Bun.env.ATMUX_TMUX_TARBALL;
    try {
      Bun.env.ATMUX_TMUX_TARBALL = "";
      expect(
        await module.resolveSourceTarball("/tmp/explicit.tar.gz", scratch, bundleFixture),
      ).toBe("/tmp/explicit.tar.gz");

      Bun.env.ATMUX_TMUX_TARBALL = "/tmp/from-env.tar.gz";
      expect(await module.resolveSourceTarball(undefined, scratch, bundleFixture)).toBe(
        "/tmp/from-env.tar.gz",
      );

      Bun.env.ATMUX_TMUX_TARBALL = "";
      const fetchOk = async (): Promise<Response> =>
        ({
          ok: true,
          status: 200,
          body: new Uint8Array([1, 2, 3]) as unknown as ReadableStream<Uint8Array>,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }) as Response;
      globalThis.fetch = mock(fetchOk) as unknown as typeof fetch;
      const resolved = await module.resolveSourceTarball(undefined, scratch, bundleFixture);
      expect(resolved).toBe(sourceTarball);
      expect(await readFile(sourceTarball)).toEqual(Buffer.from([1, 2, 3]));

      const fetchFail = async (): Promise<Response> =>
        ({
          ok: false,
          status: 503,
          body: null,
          arrayBuffer: async () => new ArrayBuffer(0),
        }) as Response;
      globalThis.fetch = mock(fetchFail) as unknown as typeof fetch;
      await expect(
        module.fetchSourceTarball(
          "https://example.invalid/tmux.tar.gz",
          join(scratch, "missing.tar.gz"),
        ),
      ).rejects.toThrow(/HTTP 503/);
    } finally {
      Bun.env.ATMUX_TMUX_TARBALL = originalEnv;
      globalThis.fetch = originalFetch;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("toolchain detection and Linux fallbacks", async () => {
    const module = await modulePromise;
    const whichSpy = spyOn(Bun, "which").mockImplementation((bin: string) => {
      const map: Record<string, string | null> = {
        make: null,
        cc: null,
        gcc: null,
        clang: null,
        "pkg-config": "/opt/homebrew/bin/pkg-config",
      };
      return map[bin] ?? null;
    });

    try {
      expect(() => module.whichOrThrow("make")).toThrow(/make not found on PATH/);

      whichSpy.mockImplementation((bin: string) => {
        const map: Record<string, string | null> = {
          make: "/usr/bin/make",
          cc: null,
          gcc: null,
          clang: null,
          "pkg-config": "/opt/homebrew/bin/pkg-config",
        };
        return map[bin] ?? null;
      });
      await expect(module.ensureToolchain()).rejects.toThrow(/cc\/gcc\/clang not found/);

      whichSpy.mockImplementation((bin: string) => {
        const map: Record<string, string | null> = {
          make: "/usr/bin/make",
          cc: "/usr/bin/cc",
          gcc: null,
          clang: null,
          "pkg-config": "/opt/homebrew/bin/pkg-config",
        };
        return map[bin] ?? null;
      });
      spawnBehavior = (command, args) => {
        if (command === "/opt/homebrew/bin/pkg-config" && args[0] === "--exists") {
          return { exitCode: 1, stderr: "missing pkg-config package\n" };
        }
        return { exitCode: 0 };
      };
      await expect(module.ensurePkgConfigPackage("libevent")).rejects.toThrow(
        /pkg-config package libevent/,
      );

      await withPlatform("linux", async () => {
        expect(await module.readMachODependencies("/tmp/any/binary")).toEqual([]);
        expect(await module.bundleDarwinTmuxDependencies("/tmp/any/binary", "/tmp/stage")).toEqual(
          [],
        );
      });
    } finally {
      whichSpy.mockRestore();
    }
  });

  test("readMachODependencies surfaces otool failures", async () => {
    const module = await modulePromise;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (originalPlatform === undefined) {
      throw new Error("process.platform descriptor missing");
    }
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      spawnBehavior = (command) => {
        if (command === "/usr/bin/otool") {
          return { exitCode: 1, stderr: "otool failed\n" };
        }
        return { exitCode: 0 };
      };
      await expect(module.readMachODependencies("/tmp/any/binary")).rejects.toThrow(
        /otool failed for \/tmp\/any\/binary/,
      );
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  test("bundleDarwinTmuxDependencies surfaces install_name_tool rewrite failures", async () => {
    const module = await modulePromise;
    const { scratch } = await makeTemporaries("atmux-bundle-rewrite-fail-");
    const binaryPath = join(scratch, "bin", "tmux");
    const libFoo = join(scratch, "deps", "libfoo.dylib");
    mkdirSync(dirname(binaryPath), { recursive: true });
    mkdirSync(dirname(libFoo), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    writeFileSync(libFoo, "foo\n");
    chmodSync(binaryPath, 0o755);
    chmodSync(libFoo, 0o644);

    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (originalPlatform === undefined) {
      throw new Error("process.platform descriptor missing");
    }
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      spawnBehavior = (command, args) => {
        if (command === "/usr/bin/otool" && args[0] === "-L") {
          const subject = String(args[1] ?? "");
          if (subject === binaryPath) {
            return {
              exitCode: 0,
              stdout: `${binaryPath}:\n\t${libFoo} (compatibility version 1.0.0, current version 1.0.0)\n`,
            };
          }
          if (subject === libFoo) {
            return {
              exitCode: 0,
              stdout: `${libFoo}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`,
            };
          }
          return { exitCode: 0, stdout: `${subject}:\n` };
        }
        if (command === "/usr/bin/install_name_tool") {
          return {
            exitCode:
              args[0] === "-change" && String(args[args.length - 1] ?? "") === binaryPath ? 1 : 0,
            stderr: "rewrite failed\n",
          };
        }
        return { exitCode: 0 };
      };

      await expect(
        module.bundleDarwinTmuxDependencies(binaryPath, join(scratch, "stage")),
      ).rejects.toThrow(/install_name_tool rewrite failed for .*tmux/);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("bundleDarwinTmuxDependencies surfaces install_name_tool -id failures", async () => {
    const module = await modulePromise;
    const { scratch } = await makeTemporaries("atmux-bundle-id-fail-");
    const binaryPath = join(scratch, "bin", "tmux");
    const libFoo = join(scratch, "deps", "libfoo.dylib");
    const stageRoot = join(scratch, "stage");
    mkdirSync(dirname(binaryPath), { recursive: true });
    mkdirSync(dirname(libFoo), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    writeFileSync(libFoo, "foo\n");
    chmodSync(binaryPath, 0o755);
    chmodSync(libFoo, 0o644);

    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (originalPlatform === undefined) {
      throw new Error("process.platform descriptor missing");
    }
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      spawnBehavior = (command, args) => {
        if (command === "/usr/bin/otool" && args[0] === "-L") {
          const subject = String(args[1] ?? "");
          if (subject === binaryPath) {
            return {
              exitCode: 0,
              stdout: `${binaryPath}:\n\t${libFoo} (compatibility version 1.0.0, current version 1.0.0)\n`,
            };
          }
          if (subject === libFoo) {
            return {
              exitCode: 0,
              stdout: `${libFoo}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`,
            };
          }
          if (subject === join(stageRoot, "lib", "libfoo.dylib")) {
            return {
              exitCode: 0,
              stdout: `${subject}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`,
            };
          }
          return { exitCode: 0, stdout: `${subject}:\n` };
        }
        if (command === "/usr/bin/install_name_tool") {
          const subjectPath = String(args[args.length - 1] ?? "");
          if (subjectPath === binaryPath) {
            return { exitCode: 0 };
          }
          if (subjectPath === join(stageRoot, "lib", "libfoo.dylib")) {
            return { exitCode: args[0] === "-id" ? 1 : 0, stderr: "id rewrite failed\n" };
          }
        }
        return { exitCode: 0 };
      };

      await expect(module.bundleDarwinTmuxDependencies(binaryPath, stageRoot)).rejects.toThrow(
        /install_name_tool -id failed for .*libfoo\.dylib/,
      );
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("resolveDarwinCodesignBinary prefers the trusted path and rejects unexpected resolution", async () => {
    const module = await modulePromise;
    const whichSpy = spyOn(Bun, "which").mockImplementation((bin: string) => {
      if (bin === "codesign") {
        return "/usr/bin/codesign";
      }
      return null;
    });

    expect(module.resolveDarwinCodesignBinary()).toBe("/usr/bin/codesign");

    whichSpy.mockImplementation((bin: string) => {
      if (bin === "codesign") {
        return null;
      }
      return null;
    });
    expect(module.resolveDarwinCodesignBinary()).toBe("/usr/bin/codesign");

    whichSpy.mockImplementation((bin: string) => {
      if (bin === "codesign") {
        return "/opt/homebrew/bin/codesign";
      }
      return null;
    });
    expect(() => module.resolveDarwinCodesignBinary()).toThrow(
      /expected \/usr\/bin\/codesign, got \/opt\/homebrew\/bin\/codesign/,
    );
  });

  test("bundleDarwinTmuxDependencies signs dylibs before the executable", async () => {
    const module = await modulePromise;
    const { scratch } = await makeTemporaries("atmux-bundle-codesign-order-");
    const stageRoot = join(scratch, "stage");
    const binaryPath = join(scratch, "bin", "tmux");
    const libFoo = join(scratch, "deps", "libfoo.dylib");
    const libBar = join(scratch, "deps", "libbar.dylib");
    mkdirSync(dirname(binaryPath), { recursive: true });
    mkdirSync(dirname(libFoo), { recursive: true });
    mkdirSync(dirname(libBar), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    writeFileSync(libFoo, "foo\n");
    writeFileSync(libBar, "bar\n");
    chmodSync(binaryPath, 0o755);
    chmodSync(libFoo, 0o644);
    chmodSync(libBar, 0o644);

    const rewrittenDependencies = new Map<string, readonly string[]>([
      [binaryPath, [libFoo, "/usr/lib/libSystem.B.dylib"]],
      [libFoo, [libBar, "/usr/lib/libSystem.B.dylib"]],
      [libBar, ["/usr/lib/libSystem.B.dylib"]],
    ]);
    const calls: string[] = [];

    const dependencyText = (subject: string, deps: ReadonlyArray<string>): string =>
      `${subject}:\n${deps
        .map((dep) => `\t${dep} (compatibility version 1.0.0, current version 1.0.0)`)
        .join("\n")}\n`;

    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (originalPlatform === undefined) {
      throw new Error("process.platform descriptor missing");
    }
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      spawnBehavior = (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "/usr/bin/otool" && args[0] === "-L") {
          const subject = String(args[1] ?? "");
          const deps = rewrittenDependencies.get(subject);
          if (deps !== undefined) {
            return { exitCode: 0, stdout: dependencyText(subject, deps) };
          }
          return { exitCode: 0, stdout: dependencyText(subject, []) };
        }
        if (command === "/usr/bin/install_name_tool") {
          const subjectPath = String(args[args.length - 1] ?? "");
          if (subjectPath === binaryPath) {
            rewrittenDependencies.set(subjectPath, [
              "@loader_path/../lib/libfoo.dylib",
              "/usr/lib/libSystem.B.dylib",
            ]);
          }
          if (subjectPath === join(stageRoot, "lib", "libfoo.dylib")) {
            rewrittenDependencies.set(subjectPath, [
              "@loader_path/libbar.dylib",
              "/usr/lib/libSystem.B.dylib",
            ]);
          }
          if (subjectPath === join(stageRoot, "lib", "libbar.dylib")) {
            rewrittenDependencies.set(subjectPath, ["/usr/lib/libSystem.B.dylib"]);
          }
          return { exitCode: 0 };
        }
        if (command === "/usr/bin/codesign") {
          return { exitCode: 0 };
        }
        return { exitCode: 0 };
      };

      const result = await module.bundleDarwinTmuxDependencies(binaryPath, stageRoot);
      expect(result).toHaveLength(2);
      expect(result.map((entry) => entry.bundlePath)).toEqual([
        join(stageRoot, "lib", "libfoo.dylib"),
        join(stageRoot, "lib", "libbar.dylib"),
      ]);
      expect(calls).toEqual([
        `/usr/bin/otool -L ${binaryPath}`,
        `/usr/bin/otool -L ${libFoo}`,
        `/usr/bin/otool -L ${libBar}`,
        `/usr/bin/install_name_tool -change ${libFoo} @loader_path/../lib/libfoo.dylib ${binaryPath}`,
        `/usr/bin/install_name_tool -change ${libBar} @loader_path/libbar.dylib ${join(stageRoot, "lib", "libfoo.dylib")}`,
        `/usr/bin/install_name_tool -id @loader_path/libfoo.dylib ${join(stageRoot, "lib", "libfoo.dylib")}`,
        `/usr/bin/install_name_tool -id @loader_path/libbar.dylib ${join(stageRoot, "lib", "libbar.dylib")}`,
        `/usr/bin/codesign --force --sign - ${join(stageRoot, "lib", "libfoo.dylib")}`,
        `/usr/bin/codesign --force --sign - ${join(stageRoot, "lib", "libbar.dylib")}`,
        `/usr/bin/codesign --force --sign - ${binaryPath}`,
        `/usr/bin/otool -L ${binaryPath}`,
        `/usr/bin/otool -L ${join(stageRoot, "lib", "libfoo.dylib")}`,
        `/usr/bin/otool -L ${join(stageRoot, "lib", "libbar.dylib")}`,
      ]);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("bundleDarwinTmuxDependencies surfaces codesign failures", async () => {
    const module = await modulePromise;
    const { scratch } = await makeTemporaries("atmux-bundle-codesign-fail-");
    const binaryPath = join(scratch, "bin", "tmux");
    const libFoo = join(scratch, "deps", "libfoo.dylib");
    const stageRoot = join(scratch, "stage");
    mkdirSync(dirname(binaryPath), { recursive: true });
    mkdirSync(dirname(libFoo), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    writeFileSync(libFoo, "foo\n");
    chmodSync(binaryPath, 0o755);
    chmodSync(libFoo, 0o644);

    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (originalPlatform === undefined) {
      throw new Error("process.platform descriptor missing");
    }
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      spawnBehavior = (command, args) => {
        if (command === "/usr/bin/otool" && args[0] === "-L") {
          const subject = String(args[1] ?? "");
          if (subject === binaryPath) {
            return {
              exitCode: 0,
              stdout: `${binaryPath}:\n\t${libFoo} (compatibility version 1.0.0, current version 1.0.0)\n`,
            };
          }
          if (subject === libFoo) {
            return {
              exitCode: 0,
              stdout: `${libFoo}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`,
            };
          }
          return { exitCode: 0, stdout: `${subject}:\n` };
        }
        if (command === "/usr/bin/install_name_tool") {
          return { exitCode: 0 };
        }
        if (command === "/usr/bin/codesign") {
          return {
            exitCode:
              String(args[args.length - 1] ?? "") === join(stageRoot, "lib", "libfoo.dylib")
                ? 1
                : 0,
            stderr: "codesign rejected\n",
          };
        }
        return { exitCode: 0 };
      };

      await expect(module.bundleDarwinTmuxDependencies(binaryPath, stageRoot)).rejects.toThrow(
        /codesign failed for .*libfoo\.dylib: codesign rejected/,
      );
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("bundleDarwinTmuxDependencies rewrites a two-level dependency tree and audits rewritten paths", async () => {
    const module = await modulePromise;
    const { scratch } = await makeTemporaries("atmux-bundle-darwin-");
    const stageRoot = join(scratch, "stage");
    const sourceRoot = join(scratch, "source");
    const binaryPath = join(sourceRoot, "tmux");
    const libFoo = join(scratch, "deps", "libfoo.dylib");
    const libBar = join(scratch, "deps", "libbar.dylib");
    const rewritten = new Set<string>();
    const rewrittenDependencies = new Map<string, string[]>();
    mkdirSync(dirname(binaryPath), { recursive: true });
    mkdirSync(dirname(libFoo), { recursive: true });
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    writeFileSync(libFoo, "foo\n");
    writeFileSync(libBar, "bar\n");
    chmodSync(binaryPath, 0o755);
    chmodSync(libFoo, 0o644);
    chmodSync(libBar, 0o644);

    const dependencyText = (subject: string, deps: ReadonlyArray<string>): string =>
      `${subject}:\n${deps.map((dep) => `\t${dep} (compatibility version 1.0.0, current version 1.0.0)`).join("\n")}\n`;

    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    if (originalPlatform === undefined) {
      throw new Error("process.platform descriptor missing");
    }
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      spawnBehavior = (command, args) => {
        if (command === "/usr/bin/otool" && args[0] === "-L") {
          const subjectText = String(args[1] ?? "");
          const stagedDependencies = rewrittenDependencies.get(subjectText);
          if (stagedDependencies !== undefined) {
            return { exitCode: 0, stdout: dependencyText(subjectText, stagedDependencies) };
          }
          if (subjectText === join(stageRoot, "lib", "libfoo.dylib")) {
            return {
              exitCode: 0,
              stdout: dependencyText(subjectText, [libBar, "/usr/lib/libSystem.B.dylib"]),
            };
          }
          if (subjectText === join(stageRoot, "bin", "tmux")) {
            return rewritten.has(join(stageRoot, "bin", "tmux"))
              ? {
                  exitCode: 0,
                  stdout: dependencyText(subjectText, [
                    "@loader_path/libfoo.dylib",
                    "/usr/lib/libSystem.B.dylib",
                  ]),
                }
              : {
                  exitCode: 0,
                  stdout: dependencyText(subjectText, [libFoo, "/usr/lib/libSystem.B.dylib"]),
                };
          }
          if (subjectText === binaryPath) {
            return rewritten.has(binaryPath)
              ? {
                  exitCode: 0,
                  stdout: dependencyText(subjectText, [
                    "@loader_path/libfoo.dylib",
                    "/usr/lib/libSystem.B.dylib",
                  ]),
                }
              : {
                  exitCode: 0,
                  stdout: dependencyText(subjectText, [libFoo, "/usr/lib/libSystem.B.dylib"]),
                };
          }
          if (subjectText === libFoo) {
            return rewritten.has(join(stageRoot, "bin", "tmux"))
              ? {
                  exitCode: 0,
                  stdout: dependencyText(subjectText, [
                    "@loader_path/libbar.dylib",
                    "/usr/lib/libSystem.B.dylib",
                  ]),
                }
              : {
                  exitCode: 0,
                  stdout: dependencyText(subjectText, [libBar, "/usr/lib/libSystem.B.dylib"]),
                };
          }
          if (subjectText === join(stageRoot, "lib", "libbar.dylib")) {
            return {
              exitCode: 0,
              stdout: dependencyText(subjectText, ["/usr/lib/libSystem.B.dylib"]),
            };
          }
          return { exitCode: 0, stdout: dependencyText(subjectText, []) };
        }
        if (command === "/usr/bin/install_name_tool") {
          const subjectPath = String(args[args.length - 1] ?? "");
          rewritten.add(subjectPath);
          if (subjectPath === join(stageRoot, "bin", "tmux")) {
            rewrittenDependencies.set(subjectPath, [
              "@loader_path/libfoo.dylib",
              "/usr/lib/libSystem.B.dylib",
            ]);
          } else if (subjectPath === join(stageRoot, "lib", "libfoo.dylib")) {
            rewrittenDependencies.set(subjectPath, ["@loader_path/libbar.dylib"]);
          } else if (subjectPath === join(stageRoot, "lib", "libbar.dylib")) {
            rewrittenDependencies.set(subjectPath, ["/usr/lib/libSystem.B.dylib"]);
          }
          return { exitCode: 0, onClose: async () => void 0 };
        }
        return { exitCode: 0 };
      };

      const result = await module.bundleDarwinTmuxDependencies(binaryPath, stageRoot);
      expect(result).toHaveLength(2);
      expect(result.map((entry) => entry.bundlePath)).toEqual([
        join(stageRoot, "lib", "libfoo.dylib"),
        join(stageRoot, "lib", "libbar.dylib"),
      ]);
      expect(rewritten.has(binaryPath)).toBe(true);
      expect(rewritten.has(join(stageRoot, "lib", "libfoo.dylib"))).toBe(true);
      expect(rewritten.has(join(stageRoot, "lib", "libbar.dylib"))).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("buildTmuxFromSource covers configure, build, probe, and staged validation failures", async () => {
    const module = await modulePromise;
    const whichSpy = spyOn(Bun, "which").mockImplementation((bin: string) => {
      const map: Record<string, string | null> = {
        make: "/usr/bin/make",
        cc: "/usr/bin/cc",
        gcc: null,
        clang: null,
        "pkg-config": "/opt/homebrew/bin/pkg-config",
      };
      return map[bin] ?? null;
    });
    const bundle = {
      version: "3.7c",
      sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
      sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
      configureArgs: ["--disable-utempter", "--enable-sixel"],
      buildCommand: "make",
    };
    type FailureCase = {
      phase: string;
      expected: RegExp;
      exitCode: number;
      skipBinary?: boolean;
      tmuxVersion?: string;
      stagedVersion?: string;
    };
    const failureCases: readonly FailureCase[] = [
      { phase: "configure-fail", expected: /tmux configure failed/, exitCode: 1 },
      { phase: "build-fail", expected: /tmux build failed/, exitCode: 1 },
      {
        phase: "missing-binary",
        expected: /tmux build did not produce/,
        exitCode: 0,
        skipBinary: true,
      },
      {
        phase: "version-fail",
        expected: /tmux -V failed from built binary/,
        exitCode: 0,
        tmuxVersion: "tmux 3.7c",
      },
      {
        phase: "version-mismatch",
        expected: /tmux -V mismatch/,
        exitCode: 0,
        tmuxVersion: "tmux 0.0.0",
      },
      {
        phase: "staged-validation-fail",
        expected: /tmux staged binary validation failed/,
        exitCode: 0,
        tmuxVersion: "tmux 3.7c",
        stagedVersion: "tmux 0.0.0",
      },
    ] as const;

    try {
      for (const failureCase of failureCases) {
        const { scratch } = await makeTemporaries(`atmux-build-${failureCase.phase}-`);
        const sourceRoot = join(scratch, "source");
        const stageRoot = join(scratch, "stage");
        const builtBinary = join(sourceRoot, "tmux");
        mkdirSync(sourceRoot, { recursive: true });
        const stagedVersion =
          failureCase.stagedVersion ?? failureCase.tmuxVersion ?? vendoredTmuxVersionTag();
        const tmuxVersion = failureCase.tmuxVersion ?? vendoredTmuxVersionTag();
        spawnBehavior = (command, args) => {
          if (command === "./configure") {
            return failureCase.phase === "configure-fail"
              ? { exitCode: 1, stderr: "configure failed\n" }
              : { exitCode: 0 };
          }
          if (command === "make") {
            if (failureCase.phase !== "missing-binary") {
              makeExecutableScript(
                builtBinary,
                `case "$1" in -V) printf '%s\\n' '${tmuxVersion}' ;; *) exit 0 ;; esac`,
              );
            }
            return failureCase.phase === "build-fail"
              ? { exitCode: 1, stderr: "build failed\n" }
              : { exitCode: 0 };
          }
          if (command === builtBinary && args[0] === "-V") {
            return failureCase.phase === "version-fail"
              ? { exitCode: 1, stderr: "version probe failed\n" }
              : { exitCode: 0, stdout: `${tmuxVersion}\n` };
          }
          if (command === join(stageRoot, "bin", "tmux") && args[0] === "-V") {
            return { exitCode: 0, stdout: `${stagedVersion}\n` };
          }
          if (command === "/opt/homebrew/bin/pkg-config") {
            return { exitCode: 0 };
          }
          return { exitCode: 0 };
        };
        await expect(module.buildTmuxFromSource(sourceRoot, stageRoot, bundle)).rejects.toThrow(
          failureCase.expected,
        );
        await rm(scratch, { recursive: true, force: true });
      }
    } finally {
      whichSpy.mockRestore();
    }
  });

  test("buildVendoredTmuxStage and final manifest mapping", async () => {
    const module = await modulePromise;
    const { scratch } = await makeTemporaries("atmux-stage-hooks-");
    const stageRoot = join(scratch, "stage");
    const installRoot = join(scratch, "opt", "atmux", "3.7c");
    const sourceTarball = join(scratch, "source.tar.gz");
    await writeFile(sourceTarball, Buffer.from("tarball"));

    const writeCalls: Array<{ path: string; json: unknown }> = [];
    const removedPaths: string[] = [];
    const result = await module.buildVendoredTmuxStage(
      stageRoot,
      installRoot,
      { sourceTarball },
      {
        readBundleManifest: async () => ({
          version: "3.7c",
          sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
          sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
          configureArgs: ["--disable-utempter"],
          buildCommand: "make",
        }),
        resolveSourceTarball: async () => sourceTarball,
        prepareSourceTree: async () => ({
          archiveSha256: "archive-sha",
          archivePath: sourceTarball,
          extractedRoot: join(scratch, "source", "tmux-3.7c"),
          validation: { rootName: "tmux-3.7c", entries: [] },
        }),
        buildTmuxFromSource: async () => ({
          builtBinaryPath: join(stageRoot, "bin", "tmux"),
          builtBinarySha256: "built-sha",
          bundledDylibs: [
            {
              sourcePath: "/tmp/libfoo.dylib",
              bundlePath: join(stageRoot, "lib", "libfoo.dylib"),
              installName: "@loader_path/libfoo.dylib",
              sha256: "libfoo-sha",
            },
          ],
        }),
        writeJsonFile: async (path: string, json: unknown) => {
          writeCalls.push({ path, json });
          await nodeFsPromises.mkdir(dirname(path), { recursive: true });
          await nodeFsPromises.writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
        },
        removePath: async (path: string) => {
          removedPaths.push(path);
        },
      },
    );
    expect(result.installedRoot).toBe(installRoot);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.path).toBe(installManifestPath(stageRoot));
    const stagedManifest = writeCalls[0]?.json as {
      bundledDylibs: Array<{
        sourcePath: string;
        bundlePath: string;
        installName: string;
        sha256: string;
      }>;
    };
    expect(stagedManifest.bundledDylibs).toHaveLength(1);
    expect(stagedManifest.bundledDylibs).toEqual([
      {
        sourcePath: "/tmp/libfoo.dylib",
        bundlePath: join(stageRoot, "lib", "libfoo.dylib"),
        installName: "@loader_path/libfoo.dylib",
        sha256: "libfoo-sha",
      },
    ]);
    expect(removedPaths).toHaveLength(1);
    expect(removedPaths[0]).toContain(".atmux-tmux-build-");

    const stageManifest = {
      version: "3.7c",
      sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
      sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
      archiveSha256: "archive-sha",
      archivePath: sourceTarball,
      sourceExtractionRoot: join(scratch, "source", "tmux-3.7c"),
      sourceRoot: "tmux-3.7c",
      builtBinaryPath: join(stageRoot, "bin", "tmux"),
      builtBinarySha256: "built-sha",
      installedBinaryPath: join(installRoot, "bin", "tmux"),
      installedRoot: installRoot,
      bundledDylibs: [
        {
          sourcePath: "/tmp/libfoo.dylib",
          bundlePath: join(stageRoot, "lib", "libfoo.dylib"),
          installName: "@loader_path/libfoo.dylib",
          sha256: "libfoo-sha",
        },
      ],
    } as const;
    expect(module.finalManifestFromStage(stageManifest, installRoot)).toEqual({
      version: "3.7c",
      sourceUrl: stageManifest.sourceUrl,
      sourceSha256: stageManifest.sourceSha256,
      archiveSha256: stageManifest.archiveSha256,
      builtBinaryPath: join(installRoot, "bin", "tmux"),
      builtBinarySha256: "built-sha",
      installedBinaryPath: join(installRoot, "bin", "tmux"),
      installedRoot: installRoot,
      bundledDylibs: [
        {
          sourcePath: "/tmp/libfoo.dylib",
          finalPath: join(installRoot, "lib", "libfoo.dylib"),
          installName: "@loader_path/libfoo.dylib",
          sha256: "libfoo-sha",
        },
      ],
    });
  });
});
