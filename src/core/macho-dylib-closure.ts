import { basename, join } from "node:path";

export interface MachODependencyRewrite {
  sourcePath: string;
  rewrittenPath: string;
}

export interface MachOBundledDylib {
  sourcePath: string;
  basename: string;
  stagedPath: string;
  rewrittenInstallName: string;
}

export interface MachOBundlePlan {
  rootPath: string;
  rootRewrites: MachODependencyRewrite[];
  bundledDylibs: MachOBundledDylib[];
}

export function parseOtoolDependencies(output: string): string[] {
  const deps: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.endsWith(":")) {
      continue;
    }
    const suffixIndex = trimmed.indexOf(" (");
    deps.push(suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex));
  }
  return deps;
}

export function isSystemMachODependency(pathname: string): boolean {
  return pathname.startsWith("/usr/lib/") || pathname.startsWith("/System/Library/");
}

export function isRelativeMachODependency(pathname: string): boolean {
  return pathname.startsWith("@loader_path/") || pathname.startsWith("@rpath/");
}

export function shouldBundleMachODependency(pathname: string): boolean {
  return pathname.startsWith("/") && !isSystemMachODependency(pathname);
}

export function loaderPathForExecutable(bundledBasename: string): string {
  return `@loader_path/../lib/${bundledBasename}`;
}

export function loaderPathForDylib(bundledBasename: string): string {
  return `@loader_path/${bundledBasename}`;
}

export function planMachOBundle(
  rootPath: string,
  dependencyLookup: (path: string) => readonly string[],
  stageLibDir: string,
): MachOBundlePlan {
  const bundled = new Map<string, MachOBundledDylib>();
  const visited = new Set<string>();
  const queue: string[] = [rootPath];
  const rootRewrites: MachODependencyRewrite[] = [];

  while (queue.length > 0) {
    const subject = queue.shift();
    if (subject === undefined || visited.has(subject)) {
      continue;
    }
    visited.add(subject);

    for (const dependency of dependencyLookup(subject)) {
      if (
        dependency.length === 0 ||
        isRelativeMachODependency(dependency) ||
        isSystemMachODependency(dependency)
      ) {
        continue;
      }
      if (!shouldBundleMachODependency(dependency)) {
        throw new Error(`unresolved non-system dependency: ${dependency}`);
      }

      const dependencyBasename = basename(dependency);
      const stagedPath = join(stageLibDir, dependencyBasename);
      const existing = bundled.get(dependencyBasename);
      if (existing !== undefined && existing.sourcePath !== dependency) {
        throw new Error(`bundle basename collision: ${existing.sourcePath} vs ${dependency}`);
      }
      if (existing === undefined) {
        bundled.set(dependencyBasename, {
          sourcePath: dependency,
          basename: dependencyBasename,
          stagedPath,
          rewrittenInstallName: loaderPathForDylib(dependencyBasename),
        });
        queue.push(dependency);
      }

      const rewrite = {
        sourcePath: dependency,
        rewrittenPath:
          subject === rootPath
            ? loaderPathForExecutable(dependencyBasename)
            : loaderPathForDylib(dependencyBasename),
      };
      if (subject === rootPath) {
        rootRewrites.push(rewrite);
      }
    }
  }

  return { rootPath, rootRewrites, bundledDylibs: [...bundled.values()] };
}

export function rewriteCommand(
  subjectPath: string,
  oldPath: string,
  newPath: string,
): readonly [string, ...string[]] {
  return ["/usr/bin/install_name_tool", "-change", oldPath, newPath, subjectPath];
}

export function rewriteIdCommand(
  subjectPath: string,
  newInstallName: string,
): readonly [string, ...string[]] {
  return ["/usr/bin/install_name_tool", "-id", newInstallName, subjectPath];
}

export function stagedBundleFinalPath(
  finalRoot: string,
  stagedPath: string,
  stageLibDir: string,
): string {
  const relative = stagedPath.slice(stageLibDir.length).replace(/^\//u, "");
  return join(finalRoot, "lib", relative);
}

export function validateBundleRewrites(plan: MachOBundlePlan): void {
  const seen = new Set<string>();
  for (const entry of plan.bundledDylibs) {
    if (seen.has(entry.basename)) {
      throw new Error(`duplicate bundled basename: ${entry.basename}`);
    }
    seen.add(entry.basename);
    if (!entry.rewrittenInstallName.startsWith("@loader_path/")) {
      throw new Error(`unexpected rewritten install name: ${entry.rewrittenInstallName}`);
    }
  }
  for (const rewrite of plan.rootRewrites) {
    if (!rewrite.rewrittenPath.startsWith("@loader_path/")) {
      throw new Error(`unexpected root rewrite path: ${rewrite.rewrittenPath}`);
    }
  }
}

export function auditAllowedMachOLoadPaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (isRelativeMachODependency(path) || isSystemMachODependency(path)) {
      continue;
    }
    throw new Error(`disallowed Mach-O dependency path: ${path}`);
  }
}
