import { type DoctorRow, defaultWhich } from "./types.ts";

// ---------- Check 1: deps ----------

export interface CheckDepsOpts {
  /** PATH lookup; defaults to `Bun.which`. Returns the resolved path or
   *  `null` when not found. Test injection point. */
  which?: (cmd: string) => string | null;
  /** OS family for install hints; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

const REQUIRED_DEPS = ["tmux", "jq", "git"] as const;

const OPTIONAL_DEPS = [
  ["curl", "needed for discord webhook + update check"],
  ["bats", "needed for bash test suite"],
  ["shellcheck", "needed for lint pass in CI"],
] as const;

export function installHint(name: string, platform: NodeJS.Platform = process.platform): string {
  switch (name) {
    case "claude":
      return "https://docs.anthropic.com/en/docs/claude-code";
    case "opencode":
      return "https://opencode.ai";
    case "kimi":
      return "https://platform.moonshot.ai";
    case "cursor-agent":
      return "https://cursor.com/cli";
  }
  if (platform === "darwin") return `brew install ${name}`;
  if (platform === "linux") return `apt install ${name}  (or your distro's equivalent)`;
  return "see the project's install docs";
}

export function checkDeps(opts: CheckDepsOpts = {}): DoctorRow[] {
  const which = opts.which ?? defaultWhich;
  const platform = opts.platform ?? process.platform;
  const rows: DoctorRow[] = [];
  for (const dep of REQUIRED_DEPS) {
    const path = which(dep);
    if (path !== null) {
      rows.push({ status: "green", label: `dep:${dep}`, detail: path });
    } else {
      rows.push({
        status: "red",
        label: `dep:${dep}`,
        detail: "NOT on PATH",
        hint: `install: ${installHint(dep, platform)}`,
      });
    }
  }
  for (const [dep, why] of OPTIONAL_DEPS) {
    const path = which(dep);
    if (path !== null) {
      rows.push({ status: "green", label: `dep:${dep}`, detail: `${path} (optional)` });
    } else {
      rows.push({
        status: "yellow",
        label: `dep:${dep}`,
        detail: "not installed (optional)",
        hint: `${why} — ${installHint(dep, platform)}`,
      });
    }
  }
  return rows;
}
