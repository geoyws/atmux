// ADR-241: `atmux start` preflight wizard — install vendored deps on
// cold hosts. Row t-ff268634 (e-22 T2). Probes /opt/atmux/current/bin
// artefacts (skipping retired atmux-orchd per ADR-276), prompts once,
// runs `bun run build:install` on accept, halts bringup on failure.
// All IO rides injected seams; the verb wires production defaults.

import { spawnSync as nativeSpawnSync } from "node:child_process";
import { existsSync as fsExistsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { UsageError } from "../errors.ts";
import { parseTmuxVersion, TMUX_TESTED_VERSION } from "../verbs/doctor/tmux.ts";
import { ATMUX_VERSION } from "../verbs/version.ts";

/** Canonical install prefix for vendored artefacts. Mirrors
 *  `resolve-tmux-bin.ts::VENDORED_TMUX_PATH`'s directory. */
export const VENDORED_BIN_PREFIX = "/opt/atmux/current/bin";

/** Artefacts the wizard probes. atmux-orchd deliberately absent —
 *  retired under ADR-276, never provisioned (e-22 T1 rule). */
export const PREFLIGHT_ARTEFACTS = [
  "tmux",
  "atmux",
  "atmux-listener",
  "atmux-cockpit-mirror",
] as const;
export type PreflightArtefact = (typeof PREFLIGHT_ARTEFACTS)[number];

export type DepProbeStatus = "pinned" | "present" | "drifted" | "absent";

export interface DepProbe {
  name: PreflightArtefact;
  path: string;
  status: DepProbeStatus;
  /** Installed version when observed (tmux `-V`; marker record). */
  installed?: string;
  /** Expected version when a pin source exists (tmux only). */
  expected?: string;
}

export interface PreflightFlags {
  skipDeps: boolean;
  nonInteractive: boolean;
  noPreflight: boolean;
}

/** Parse the ADR-241 D3 flags out of already-split argv. Throws on the
 *  --skip-deps + --non-interactive contradiction (flag-parse time). */
export function parsePreflightFlags(argv: ReadonlyArray<string>): PreflightFlags {
  const flags: PreflightFlags = { skipDeps: false, nonInteractive: false, noPreflight: false };
  for (const a of argv) {
    if (a === "--skip-deps") flags.skipDeps = true;
    else if (a === "--non-interactive") flags.nonInteractive = true;
    else if (a === "--no-preflight") flags.noPreflight = true;
  }
  if (flags.skipDeps && flags.nonInteractive) {
    throw new UsageError({
      what: "start: --skip-deps and --non-interactive are mutually exclusive (one says don't install, the other says install without asking)",
      hint: "pick one — --skip-deps to run on system binaries, --non-interactive to install unattended",
    });
  }
  return flags;
}

export interface PreflightDeps {
  existsSync?: (path: string) => boolean;
  /** Run `<bin> -V`, return trimmed stdout or null on any failure. */
  tmuxVersion?: (bin: string) => string | null;
  readPin?: () => string;
  installPrefix?: string;
  homeDir?: string;
  atmuxVersion?: string;
  isTTY?: boolean;
  /** Ask a Y/n question; default readline over stdio. Tests inject. */
  prompt?: (question: string) => Promise<boolean>;
  /** Run the installer; resolve its exit code. Default streams
   *  `bun run build:install` in the caller's cwd. */
  runInstall?: () => Promise<number>;
  log?: (msg: string) => void;
}

function defaultTmuxVersion(bin: string): string | null {
  try {
    const r = nativeSpawnSync(bin, ["-V"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const out = (r.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function defaultPrompt(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const { promise, resolve } = Promise.withResolvers<boolean>();
  rl.question(question, (answer: string) => {
    rl.close();
    const t = answer.trim().toLowerCase();
    resolve(t === "" || t === "y" || t === "yes");
  });
  return promise;
}

function defaultRunInstall(): Promise<number> {
  const r = nativeSpawnSync("bun", ["run", "build:install"], { stdio: "inherit" });
  return Promise.resolve(r.status ?? 1);
}

function markerPath(homeDir: string, version: string): string {
  return join(homeDir, ".atmux", "state", `preflight-${version}.json`);
}

interface MarkerFile {
  atmux_version: string;
  installed_at: string;
  binaries: Record<string, { path: string; version?: string }>;
}

function readMarker(path: string): MarkerFile | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as MarkerFile;
    if (typeof parsed.atmux_version !== "string" || typeof parsed.binaries !== "object")
      return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Probe every artefact. tmux compares `-V` against the tested pin;
 *  other binaries are present/absent only (no runtime pin source). */
export function probeVendoredDeps(deps: PreflightDeps = {}): DepProbe[] {
  const existsSync = deps.existsSync ?? fsExistsSync;
  const tmuxVersion = deps.tmuxVersion ?? defaultTmuxVersion;
  const readPin = deps.readPin ?? (() => TMUX_TESTED_VERSION);
  const prefix = deps.installPrefix ?? VENDORED_BIN_PREFIX;
  const expected = readPin().trim();
  return PREFLIGHT_ARTEFACTS.map((name): DepProbe => {
    const path = join(prefix, name);
    if (!existsSync(path)) return { name, path, status: "absent" };
    if (name !== "tmux") return { name, path, status: "present" };
    const out = tmuxVersion(path);
    const parsed = out === null ? null : parseTmuxVersion(out);
    if (parsed === null) return { name, path, status: "drifted", expected };
    const installed = `${parsed.major}.${parsed.minor}${parsed.suffix ?? ""}`;
    if (installed === expected) return { name, path, status: "pinned", installed, expected };
    return { name, path, status: "drifted", installed, expected };
  });
}

function needsWizard(probes: ReadonlyArray<DepProbe>): boolean {
  return probes.some((p) => p.status === "absent" || p.status === "drifted");
}

function renderTable(probes: ReadonlyArray<DepProbe>): string[] {
  const missing = probes.filter((p) => p.status === "absent").length;
  const drifted = probes.filter((p) => p.status === "drifted").length;
  const lines = [`[atmux start] preflight: ${missing} vendored deps missing, ${drifted} drifted.`];
  for (const p of probes) {
    if (p.status === "absent") {
      lines.push(
        `  Missing : ${p.name} (expected ${p.path}${p.expected !== undefined ? `, pinned ${p.expected}` : ""})`,
      );
    } else if (p.status === "drifted") {
      lines.push(
        `  Drift   : ${p.name} (installed ${p.installed ?? "unknown"}, expected ${p.expected ?? "unknown"})`,
      );
    }
  }
  return lines;
}

/**
 * Run the ADR-241 preflight. Returns `"continue"` (proceed to
 * team-bringup) or `"halt"` (install failed — skip bringup entirely).
 * `--no-preflight` / `ATMUX_START_NO_PREFLIGHT=1` skips everything.
 */
export async function runStartPreflight(
  flags: PreflightFlags,
  env: NodeJS.ProcessEnv = process.env,
  deps: PreflightDeps = {},
): Promise<"continue" | "halt"> {
  const log = deps.log ?? ((s: string) => process.stderr.write(`${s}\n`));
  if (flags.noPreflight || (env.ATMUX_START_NO_PREFLIGHT ?? "") === "1") return "continue";

  const homeDir = deps.homeDir ?? osHomedir();
  const version = deps.atmuxVersion ?? ATMUX_VERSION;
  const existsSync = deps.existsSync ?? fsExistsSync;

  // D4 fast-path: marker for this version + every path still present
  // ⇒ skip the version-pin probe (cheap existsSync sweep only).
  const marker = readMarker(markerPath(homeDir, version));
  if (marker !== null && marker.atmux_version === version) {
    const prefix = deps.installPrefix ?? VENDORED_BIN_PREFIX;
    const allPresent = PREFLIGHT_ARTEFACTS.every((name) => existsSync(join(prefix, name)));
    if (allPresent) return "continue";
    // Else fall through to the full probe + wizard (invalidation).
  }

  let probes = probeVendoredDeps(deps);
  if (!needsWizard(probes)) return "continue";

  for (const line of renderTable(probes)) log(line);
  const isTTY = deps.isTTY ?? process.stdin.isTTY === true;
  const prompt = deps.prompt ?? defaultPrompt;
  let accept: boolean;
  if (flags.skipDeps) {
    accept = false;
  } else if (flags.nonInteractive || !isTTY) {
    accept = true;
  } else {
    accept = await prompt("Install/rebuild via `bun run build:install`? [Y/n] ");
  }

  if (!accept) {
    log("[atmux start] preflight: skipping install — continuing with system/fallback binaries.");
    return "continue";
  }

  const runInstall = deps.runInstall ?? defaultRunInstall;
  const code = await runInstall();
  if (code !== 0) {
    log(
      `[atmux start] preflight: build:install failed (exit ${code}) — skipping team bringup; fix the build output above and re-run.`,
    );
    return "halt";
  }

  // Re-probe once to confirm the install landed, then stamp the marker.
  probes = probeVendoredDeps(deps);
  if (needsWizard(probes)) {
    log(
      "[atmux start] preflight: install reported success but artefacts still missing/drifted — skipping team bringup.",
    );
    return "halt";
  }
  const record: MarkerFile = {
    atmux_version: version,
    installed_at: new Date().toISOString(),
    binaries: Object.fromEntries(
      probes.map((p) => [
        p.name,
        p.installed !== undefined ? { path: p.path, version: p.installed } : { path: p.path },
      ]),
    ),
  };
  try {
    mkdirSync(join(homeDir, ".atmux", "state"), { recursive: true });
    writeFileSync(markerPath(homeDir, version), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // Marker is an optimization; a failed write must not halt bringup.
  }
  return "continue";
}
