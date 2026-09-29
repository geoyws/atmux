// ADR-200 steps 1-2 — pure prerequisite probing and cockpit scaffolding.

import { basename, dirname, normalize } from "node:path";

export const REQUIRED_PREREQUISITES = ["bun", "tmux", "git", "jq", "sqlite3"] as const;

export type PrerequisiteBinary = (typeof REQUIRED_PREREQUISITES)[number];
export type PrerequisitePlatform = "darwin" | "linux";

export interface MissingPrerequisite {
  bin: PrerequisiteBinary;
  hint: string;
}

export interface PrerequisiteProbeResult {
  missing: MissingPrerequisite[];
}

export type PrerequisiteCheck = (bin: PrerequisiteBinary) => boolean;

const DARWIN_PACKAGES: Record<PrerequisiteBinary, string> = {
  bun: "oven-sh/bun/bun",
  tmux: "tmux",
  git: "git",
  jq: "jq",
  sqlite3: "sqlite",
};

const LINUX_PACKAGES: Record<PrerequisiteBinary, string> = {
  bun: "bun",
  tmux: "tmux",
  git: "git",
  jq: "jq",
  sqlite3: "sqlite3",
};

/** Probe the required ADR-200 binaries without performing process IO. */
export function probePrereqs(
  check: PrerequisiteCheck,
  platform: PrerequisitePlatform,
): PrerequisiteProbeResult {
  const packages = platform === "darwin" ? DARWIN_PACKAGES : LINUX_PACKAGES;
  const command = platform === "darwin" ? "brew install" : "sudo apt install";
  const missing: MissingPrerequisite[] = [];

  for (const bin of REQUIRED_PREREQUISITES) {
    if (!check(bin)) {
      missing.push({ bin, hint: `${command} ${packages[bin]}` });
    }
  }

  return { missing };
}

export interface CockpitScaffoldFs {
  /** Absolute path of the cockpit.json managed by the caller. */
  cockpitPath: string;
  /** Return null when the file does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Create a directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface CockpitProjectSession {
  type: "team";
  name: string;
  enabled: true;
  root: string;
  sessions: [];
}

export interface ScaffoldCockpitResult {
  changed: boolean;
  cockpitPath: string;
}

function projectSession(projectRoot: string): CockpitProjectSession {
  return {
    type: "team",
    name: basename(projectRoot),
    enabled: true,
    root: projectRoot,
    sessions: [],
  };
}

function canonicalProjectRoot(projectRoot: string): string {
  const normalized = normalize(projectRoot);
  return normalized.replace(/[\\/]+$/, "") || normalized;
}

function parseCockpit(contents: string): Record<string, unknown> & { sessions: unknown[] } {
  const parsed: unknown = JSON.parse(contents);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("cockpit.json must contain a JSON object");
  }

  const cockpit = parsed as Record<string, unknown>;
  if (!Array.isArray(cockpit.sessions)) {
    throw new TypeError("cockpit.json sessions must be an array");
  }

  return cockpit as Record<string, unknown> & { sessions: unknown[] };
}

function isProjectSession(value: unknown, projectRoot: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type === "team" &&
    typeof candidate.root === "string" &&
    canonicalProjectRoot(candidate.root) === projectRoot
  ) {
    return true;
  }
  return (
    Array.isArray(candidate.sessions) &&
    candidate.sessions.some((session) => isProjectSession(session, projectRoot))
  );
}

/** Create the minimal cockpit config or append one project session exactly once. */
export async function scaffoldCockpit(
  fs: CockpitScaffoldFs,
  projectRoot: string,
): Promise<ScaffoldCockpitResult> {
  const root = canonicalProjectRoot(projectRoot);
  const existing = await fs.readFile(fs.cockpitPath);

  if (existing === null) {
    const cockpit = {
      schemaVersion: 1,
      cockpitSession: "atx",
      sessions: [projectSession(root)],
    };
    await fs.mkdir(dirname(fs.cockpitPath));
    await fs.writeFile(fs.cockpitPath, `${JSON.stringify(cockpit, null, 2)}\n`);
    return { changed: true, cockpitPath: fs.cockpitPath };
  }

  const cockpit = parseCockpit(existing);
  if (cockpit.sessions.some((session) => isProjectSession(session, root))) {
    return { changed: false, cockpitPath: fs.cockpitPath };
  }

  cockpit.sessions.push(projectSession(root));
  await fs.writeFile(fs.cockpitPath, `${JSON.stringify(cockpit, null, 2)}\n`);
  return { changed: true, cockpitPath: fs.cockpitPath };
}
