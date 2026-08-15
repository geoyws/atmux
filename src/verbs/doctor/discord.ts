import { join } from "node:path";
import { resolveWebhookUrl } from "../../abstractions/discord.ts";
import { announceHonkerState } from "../../abstractions/events.ts";
import { exists } from "../../abstractions/fs.ts";
import {
  bootHonker,
  type HonkerHooks,
  type HonkerRuntimeState,
} from "../../abstractions/honker.ts";
import { probeStatus } from "../../abstractions/http.ts";
import { closeDatabase, openDatabase } from "../../abstractions/sqlite.ts";
import { migrations } from "../../abstractions/sqlite-migrations.ts";
import type { Team } from "../../schema/team.ts";
import type { DoctorRow } from "./types.ts";

// ---------- Check 5: webhook ----------

export interface CheckWebhookOpts {
  env?: NodeJS.ProcessEnv;
  /** Override probe (test injection). Returns the HTTP status code or 0
   *  on network/timeout failure. */
  probe?: (url: string) => Promise<number>;
}

export async function checkWebhook(
  team: Team | null,
  opts: CheckWebhookOpts = {},
): Promise<DoctorRow[]> {
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? ((u: string) => probeStatus(u, { timeoutMs: 5_000 }));
  const teamArg = team !== null ? team : undefined;
  const resolveOpts: { env: NodeJS.ProcessEnv; team?: Team } = { env };
  if (teamArg !== undefined) resolveOpts.team = teamArg;
  const url = await resolveWebhookUrl(resolveOpts);
  if (url === null) {
    // The hint embeds literal shell syntax (`${VAR:-default}`) so the
    // operator can copy-paste the resolution chain. biome-ignore the
    // template-string lint — these `$` are documentation, not interpolation.
    const hint = [
      "resolution chain (in order): $ATMUX_DISCORD_WEBHOOK env,",
      "team.json .discord.webhook,",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax in user-facing hint
      "${XDG_CONFIG_HOME:-$HOME/.config}/atmux/discord-webhook",
    ].join(" ");
    return [
      {
        status: "yellow",
        label: "discord",
        detail: "no webhook configured",
        hint,
      },
    ];
  }
  const code = await probe(url);
  if (code === 0) {
    return [
      {
        status: "red",
        label: "discord",
        detail: "webhook unreachable (DNS or connection failure)",
        hint: "check network + verify webhook URL",
      },
    ];
  }
  // Discord returns 405 on GET → that proves we reached it.
  if ((code >= 200 && code <= 299) || code === 405) {
    return [{ status: "green", label: "discord", detail: `reachable (HTTP ${code})` }];
  }
  if (code === 401 || code === 403 || code === 404) {
    return [
      {
        status: "red",
        label: "discord",
        detail: `webhook rejected (HTTP ${code}) — likely revoked or wrong URL`,
        hint: "regenerate the webhook in Discord and update the config",
      },
    ];
  }
  return [
    {
      status: "yellow",
      label: "discord",
      detail: `unexpected response HTTP ${code} — reachable but odd`,
    },
  ];
}

// ---------- Honker substrate probe (ADR-202 §D11) ----------

/** Pure: map a HonkerRuntimeState into a doctor row. Exported for unit
 *  tests; the verb-side wrapper `checkHonker(atmuxDir)` boots + delegates. */
export function honkerStateRows(state: HonkerRuntimeState | null): DoctorRow[] {
  if (state === null) {
    return [
      {
        status: "info",
        label: "honker",
        detail: "boot not invoked (no state.db opened on this run)",
      },
    ];
  }
  if (state.loaded) {
    return [
      {
        status: "green",
        label: "honker",
        detail: `substrate loaded — extension at ${state.extensionPath ?? "<unknown>"}`,
      },
    ];
  }
  // loaded === false branches: kill-switch off vs explicit fallback
  if (state.fallbackReason === null) {
    return [
      {
        status: "info",
        label: "honker",
        detail: "kill-switch off (ATMUX_HONKER unset or off); poll-mode in effect",
      },
    ];
  }
  return [
    {
      status: "yellow",
      label: "honker",
      detail: `fallback mode — ${state.fallbackReason}`,
      hint:
        "extension binary not yet provisioned (install wizard ADR-200 §D6 ships this); " +
        "consumers fall through to poll-mode + cron-backstop sweep",
    },
  ];
}

/** Boot the Honker substrate against the team's state.db, announce
 *  via the events bus, and surface the runtime state as a doctor row.
 *  Tolerant of missing state.db (returns info row) — first-run hosts
 *  don't fail this probe. */
export async function checkHonker(atmuxDir: string, hooks: HonkerHooks = {}): Promise<DoctorRow[]> {
  const stateDb = join(atmuxDir, "state.db");
  if (!(await exists(stateDb))) {
    return [
      {
        status: "info",
        label: "honker",
        detail: "state.db absent (first-run or atmux init not invoked)",
      },
    ];
  }
  const db = openDatabase(stateDb, migrations);
  try {
    const state = bootHonker(db, hooks, announceHonkerState());
    return honkerStateRows(state);
  } finally {
    closeDatabase(db);
  }
}
