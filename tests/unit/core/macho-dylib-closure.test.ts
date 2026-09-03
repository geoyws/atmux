import { describe, expect, test } from "bun:test";
import {
  auditAllowedMachOLoadPaths,
  isRelativeMachODependency,
  isSystemMachODependency,
  parseOtoolDependencies,
  planMachOBundle,
  rewriteCommand,
  rewriteIdCommand,
  shouldBundleMachODependency,
  stagedBundleFinalPath,
  validateBundleRewrites,
} from "../../../src/core/macho-dylib-closure.ts";

describe("Mach-O dylib closure planner", () => {
  test("parses otool output and classifies dependency paths", () => {
    const deps = parseOtoolDependencies(`
/tmp/bin/tmux:
\t/opt/homebrew/Cellar/libevent/2.1.13/lib/libevent-2.1.13.dylib (compatibility version 1.0.0, current version 1.0.0)
\t/opt/homebrew/Cellar/lib with spaces/libfoo.dylib (compatibility version 1.0.0, current version 1.0.0)
\t@rpath/libutf8proc.2.dylib (compatibility version 0.0.0, current version 0.0.0)
\t/System/Library/Frameworks/Foundation.framework/Foundation (compatibility version 0.0.0, current version 0.0.0)
\t/opt/homebrew/Cellar/lib with spaces/libbar.dylib
\t/opt/homebrew/Cellar/libcrypto/1.1/lib/libcrypto.1.1.dylib
`);

    expect(deps).toEqual([
      "/opt/homebrew/Cellar/libevent/2.1.13/lib/libevent-2.1.13.dylib",
      "/opt/homebrew/Cellar/lib with spaces/libfoo.dylib",
      "@rpath/libutf8proc.2.dylib",
      "/System/Library/Frameworks/Foundation.framework/Foundation",
      "/opt/homebrew/Cellar/lib with spaces/libbar.dylib",
      "/opt/homebrew/Cellar/libcrypto/1.1/lib/libcrypto.1.1.dylib",
    ]);
    expect(isSystemMachODependency("/usr/lib/libSystem.B.dylib")).toBe(true);
    expect(isSystemMachODependency("/opt/homebrew/opt/libevent/lib/libevent-2.1.13.dylib")).toBe(
      false,
    );
    expect(isRelativeMachODependency("@loader_path/../lib/libevent.dylib")).toBe(true);
    expect(
      shouldBundleMachODependency("/opt/homebrew/opt/libevent/lib/libevent-2.1.13.dylib"),
    ).toBe(true);
  });

  test("plans recursive bundling with loader-path rewrites", () => {
    const graph = new Map<string, readonly string[]>([
      [
        "/stage/bin/tmux",
        ["/opt/homebrew/opt/libevent/lib/libevent-2.1.13.dylib", "/usr/lib/libSystem.B.dylib"],
      ],
      [
        "/opt/homebrew/opt/libevent/lib/libevent-2.1.13.dylib",
        ["/opt/homebrew/Cellar/utf8proc/lib/libutf8proc.2.dylib"],
      ],
      ["/opt/homebrew/Cellar/utf8proc/lib/libutf8proc.2.dylib", ["/usr/lib/libSystem.B.dylib"]],
    ]);
    const plan = planMachOBundle(
      "/stage/bin/tmux",
      (subject) => graph.get(subject) ?? [],
      "/stage/lib",
    );
    validateBundleRewrites(plan);

    expect(plan.rootRewrites).toEqual([
      {
        sourcePath: "/opt/homebrew/opt/libevent/lib/libevent-2.1.13.dylib",
        rewrittenPath: "@loader_path/../lib/libevent-2.1.13.dylib",
      },
    ]);
    expect(plan.bundledDylibs).toEqual([
      {
        sourcePath: "/opt/homebrew/opt/libevent/lib/libevent-2.1.13.dylib",
        basename: "libevent-2.1.13.dylib",
        stagedPath: "/stage/lib/libevent-2.1.13.dylib",
        rewrittenInstallName: "@loader_path/libevent-2.1.13.dylib",
      },
      {
        sourcePath: "/opt/homebrew/Cellar/utf8proc/lib/libutf8proc.2.dylib",
        basename: "libutf8proc.2.dylib",
        stagedPath: "/stage/lib/libutf8proc.2.dylib",
        rewrittenInstallName: "@loader_path/libutf8proc.2.dylib",
      },
    ]);
    expect(rewriteCommand("/stage/bin/tmux", "/a", "/b")).toEqual([
      "/usr/bin/install_name_tool",
      "-change",
      "/a",
      "/b",
      "/stage/bin/tmux",
    ]);
    expect(rewriteIdCommand("/stage/lib/libevent.dylib", "@loader_path/libevent.dylib")).toEqual([
      "/usr/bin/install_name_tool",
      "-id",
      "@loader_path/libevent.dylib",
      "/stage/lib/libevent.dylib",
    ]);
    expect(stagedBundleFinalPath("/final", "/stage/lib/libevent.dylib", "/stage/lib")).toBe(
      "/final/lib/libevent.dylib",
    );
  });

  test("skips empty, relative, and system dependencies while planning bundles", () => {
    const graph = new Map<string, readonly string[]>([
      [
        "/stage/bin/tmux",
        [
          "",
          "@rpath/libutf8proc.dylib",
          "/usr/lib/libSystem.B.dylib",
          "/opt/homebrew/opt/libevent/lib/libevent-2.1.13.dylib",
        ],
      ],
      [
        "/opt/homebrew/opt/libevent/lib/libevent-2.1.13.dylib",
        ["/System/Library/Frameworks/Foundation.framework/Foundation"],
      ],
    ]);

    const plan = planMachOBundle(
      "/stage/bin/tmux",
      (subject) => graph.get(subject) ?? [],
      "/stage/lib",
    );
    expect(plan.rootRewrites).toEqual([
      {
        sourcePath: "/opt/homebrew/opt/libevent/lib/libevent-2.1.13.dylib",
        rewrittenPath: "@loader_path/../lib/libevent-2.1.13.dylib",
      },
    ]);
    expect(plan.bundledDylibs).toEqual([
      {
        sourcePath: "/opt/homebrew/opt/libevent/lib/libevent-2.1.13.dylib",
        basename: "libevent-2.1.13.dylib",
        stagedPath: "/stage/lib/libevent-2.1.13.dylib",
        rewrittenInstallName: "@loader_path/libevent-2.1.13.dylib",
      },
    ]);
  });

  test("deduplicates shared dylibs with the same source path", () => {
    const graph = new Map<string, readonly string[]>([
      [
        "/stage/bin/tmux",
        [
          "/opt/homebrew/opt/libfoo/lib/libfoo.dylib",
          "/opt/homebrew/opt/libbar/lib/libbar.dylib",
          "/usr/lib/libSystem.B.dylib",
        ],
      ],
      [
        "/opt/homebrew/opt/libfoo/lib/libfoo.dylib",
        ["/opt/homebrew/opt/libshared/lib/libshared.dylib"],
      ],
      [
        "/opt/homebrew/opt/libbar/lib/libbar.dylib",
        ["/opt/homebrew/opt/libshared/lib/libshared.dylib"],
      ],
      ["/opt/homebrew/opt/libshared/lib/libshared.dylib", ["/usr/lib/libSystem.B.dylib"]],
    ]);

    const plan = planMachOBundle(
      "/stage/bin/tmux",
      (subject) => graph.get(subject) ?? [],
      "/stage/lib",
    );
    expect(plan.bundledDylibs).toEqual([
      {
        sourcePath: "/opt/homebrew/opt/libfoo/lib/libfoo.dylib",
        basename: "libfoo.dylib",
        stagedPath: "/stage/lib/libfoo.dylib",
        rewrittenInstallName: "@loader_path/libfoo.dylib",
      },
      {
        sourcePath: "/opt/homebrew/opt/libbar/lib/libbar.dylib",
        basename: "libbar.dylib",
        stagedPath: "/stage/lib/libbar.dylib",
        rewrittenInstallName: "@loader_path/libbar.dylib",
      },
      {
        sourcePath: "/opt/homebrew/opt/libshared/lib/libshared.dylib",
        basename: "libshared.dylib",
        stagedPath: "/stage/lib/libshared.dylib",
        rewrittenInstallName: "@loader_path/libshared.dylib",
      },
    ]);
  });

  test("rejects basename collisions and disallowed absolute dependencies", () => {
    expect(() =>
      planMachOBundle(
        "/stage/bin/tmux",
        (subject) => {
          if (subject === "/stage/bin/tmux") {
            return ["/opt/homebrew/opt/libevent/lib/libevent.dylib", "/usr/lib/libSystem.B.dylib"];
          }
          return [
            "/usr/lib/libSystem.B.dylib",
            "/opt/homebrew/Cellar/libevent-alt/lib/libevent.dylib",
          ];
        },
        "/stage/lib",
      ),
    ).toThrow(/basename collision/);

    expect(() => planMachOBundle("/stage/bin/tmux", () => ["foo/bar"], "/stage/lib")).toThrow(
      /unresolved non-system dependency/,
    );

    expect(() =>
      auditAllowedMachOLoadPaths([
        "@loader_path/libfoo.dylib",
        "@rpath/libbar.dylib",
        "/usr/lib/libSystem.B.dylib",
        "/System/Library/Frameworks/Foundation.framework/Foundation",
      ]),
    ).not.toThrow();

    expect(() => auditAllowedMachOLoadPaths(["/opt/custom/lib/libfoo.dylib"])).toThrow(
      /disallowed/,
    );

    expect(() =>
      validateBundleRewrites({
        rootPath: "/stage/bin/tmux",
        rootRewrites: [
          {
            sourcePath: "/opt/homebrew/lib/libfoo.dylib",
            rewrittenPath: "/opt/homebrew/lib/libfoo.dylib",
          },
        ],
        bundledDylibs: [
          {
            sourcePath: "/opt/homebrew/lib/libfoo.dylib",
            basename: "libfoo.dylib",
            stagedPath: "/stage/lib/libfoo.dylib",
            rewrittenInstallName: "libfoo.dylib",
          },
        ],
      }),
    ).toThrow(/unexpected rewritten install name/);

    expect(() =>
      validateBundleRewrites({
        rootPath: "/stage/bin/tmux",
        rootRewrites: [
          { sourcePath: "/opt/homebrew/lib/libfoo.dylib", rewrittenPath: "libfoo.dylib" },
        ],
        bundledDylibs: [
          {
            sourcePath: "/opt/homebrew/lib/libfoo.dylib",
            basename: "libfoo.dylib",
            stagedPath: "/stage/lib/libfoo.dylib",
            rewrittenInstallName: "@loader_path/libfoo.dylib",
          },
        ],
      }),
    ).toThrow(/unexpected root rewrite path/);

    expect(() =>
      validateBundleRewrites({
        rootPath: "/stage/bin/tmux",
        rootRewrites: [],
        bundledDylibs: [
          {
            sourcePath: "/opt/homebrew/lib/libfoo.dylib",
            basename: "libfoo.dylib",
            stagedPath: "/stage/lib/libfoo.dylib",
            rewrittenInstallName: "@loader_path/libfoo.dylib",
          },
          {
            sourcePath: "/opt/homebrew/lib/libfoo-alt.dylib",
            basename: "libfoo.dylib",
            stagedPath: "/stage/lib/libfoo.dylib",
            rewrittenInstallName: "@loader_path/libfoo.dylib",
          },
        ],
      }),
    ).toThrow(/duplicate bundled basename/);
  });
});
