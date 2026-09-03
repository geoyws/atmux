import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as nodeChildProcess from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashFile } from "../../../src/core/vendored-tmux-install.ts";

const childProcessSnapshot = { ...nodeChildProcess };

function makeExecutableScript(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

afterEach(() => {
  mock.restore();
});

describe("scripts/install-vendored-tmux runtime", () => {
  test("main stages vendored tmux using mocked toolchain and source archive", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-tmux-runtime-"));
    const stageRoot = join(scratch, "stage");
    const sourceRoot = join(scratch, "source", "tmux-3.7c");
    const tmuxVersion = "tmux 3.7c";
    mkdirSync(sourceRoot, { recursive: true });

    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
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

    try {
      mock.module("node:child_process", () => ({
        ...childProcessSnapshot,
        spawn: mock((command: string, args: ReadonlyArray<string>, options: { cwd: string }) => {
          calls.push({ command, args: [...args], cwd: options.cwd });
          const child = {
            stdout: {
              on(event: string, handler: (chunk: Buffer) => void) {
                if (event === "data") {
                  if (command.endsWith("/tmux") && args[0] === "-V") {
                    handler(Buffer.from(`${tmuxVersion}\n`));
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
                  if (command === "./configure") {
                    handler(0);
                    return;
                  }
                  if (command === "make") {
                    makeExecutableScript(
                      join(options.cwd, "tmux"),
                      `case "$1" in -V) printf '%s\\n' '${tmuxVersion}' ;; *) exit 0 ;; esac`,
                    );
                    handler(0);
                    return;
                  }
                  if (command.endsWith("/tmux") && args[0] === "-V") {
                    handler(0);
                    return;
                  }
                  handler(0);
                });
              }
              return child;
            },
          };
          return child;
        }),
      }));

      const module = await import("../../../scripts/install-vendored-tmux.ts");
      await module.buildTmuxFromSource(sourceRoot, stageRoot, {
        version: "3.7c",
        sourceUrl: "https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz",
        sourceSha256: "7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf",
        configureArgs: ["--disable-utempter", "--enable-sixel", "--enable-utf8proc"],
        darwinConfigureArgs: ["--enable-jemalloc"],
        buildCommand: "make",
      });

      expect(calls.map((call) => call.command)).toContain("make");
      expect(await hashFile(join(stageRoot, "bin", "tmux"))).toBeTypeOf("string");
    } finally {
      whichSpy.mockRestore();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
