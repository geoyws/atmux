// ADR-285 phase 6 — static fleet-migration plan validation and rendering.
//
// This module is deliberately pure. It turns a reviewed snapshot into
// JSON patches on stdout; it never reads or writes live cockpit/team
// configuration and never touches tmux.

import { join } from "node:path";
import { z } from "zod";
import {
  CockpitSuperbot,
  type CockpitSuperbot as CockpitSuperbotShape,
} from "../schema/cockpit.ts";
import { TeamBot } from "../schema/team.ts";

const TagName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const SuperbotFleetTeam = z
  .object({
    name: z.string().min(1),
    root: z.string().startsWith("/"),
    teamConfig: z.enum(["present", "missing"]),
    bot: TeamBot,
  })
  .strict()
  .superRefine((team, ctx) => {
    if (team.bot.enabled !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["bot", "enabled"],
        message: "fleet bot must be enabled",
      });
    }
    if (typeof team.bot.tui !== "string" || team.bot.tui.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["bot", "tui"],
        message: "fleet bot harness must be explicit",
      });
    }
    if (typeof team.bot.claudeAccount !== "string" || team.bot.claudeAccount.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["bot", "claudeAccount"],
        message: "fleet bot account must be explicit",
      });
    }
  });

export const SuperbotFleetOwnership = z
  .object({
    board: z.string().min(1),
    tags: z.array(TagName).min(1),
    defaultTeam: z.string().min(1),
    fallbackTeams: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((owner, ctx) => {
    const tags = new Set<string>();
    for (const tag of owner.tags) {
      if (tags.has(tag)) {
        ctx.addIssue({ code: "custom", path: ["tags"], message: `duplicate tag '${tag}'` });
      }
      tags.add(tag);
    }
    const teams = [owner.defaultTeam, ...owner.fallbackTeams];
    if (new Set(teams).size !== teams.length) {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackTeams"],
        message: "ownership teams must be unique",
      });
    }
  });

export const SuperbotFleetPlan = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: z.string().min(1),
    sourceCockpit: z.string().startsWith("/"),
    sourceCockpitSha256: z.string().regex(/^[a-f0-9]{64}$/),
    activation: z.literal("held"),
    intervalMins: z.number().int().positive().default(30),
    fallbackAfterIntervals: z.number().int().positive().default(1),
    maxOffersPerTick: z.number().int().positive().max(100).default(20),
    persistentTeams: z.array(SuperbotFleetTeam).min(1),
    ownership: z.array(SuperbotFleetOwnership),
    activationBlockers: z.array(z.string().min(1)).default([]),
    excludedBoards: z
      .array(
        z
          .object({
            board: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const teams = new Set<string>();
    for (const team of plan.persistentTeams) {
      if (teams.has(team.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["persistentTeams"],
          message: `duplicate persistent team '${team.name}'`,
        });
      }
      teams.add(team.name);
    }

    const routeKeys = new Set<string>();
    for (const owner of plan.ownership) {
      for (const team of [owner.defaultTeam, ...owner.fallbackTeams]) {
        if (!teams.has(team)) {
          ctx.addIssue({
            code: "custom",
            path: ["ownership"],
            message: `ownership names unknown persistent team '${team}'`,
          });
        }
      }
      for (const tag of owner.tags) {
        const key = `${owner.board}\u0000${tag}`;
        if (routeKeys.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: ["ownership"],
            message: `duplicate ownership for board='${owner.board}' tag='${tag}'`,
          });
        }
        routeKeys.add(key);
      }
    }
  });
export type SuperbotFleetPlan = z.infer<typeof SuperbotFleetPlan>;

export interface SuperbotFleetMigration {
  activation: "held";
  cockpitPatch: { superbot: CockpitSuperbotShape };
  teamPatches: Array<{
    team: string;
    path: string;
    teamConfig: "present" | "missing";
    set: { bot: z.infer<typeof TeamBot> };
  }>;
  activationBlockers: string[];
}

/** Expand compact board/tag groups into the exact cockpit route schema. */
export function renderSuperbotFleetMigration(raw: unknown): SuperbotFleetMigration {
  const plan = SuperbotFleetPlan.parse(raw);
  const routes = plan.ownership.flatMap((owner) =>
    owner.tags.map((tag) => ({
      board: owner.board,
      tag,
      defaultTeam: owner.defaultTeam,
      fallbackTeams: owner.fallbackTeams,
    })),
  );
  const superbot = CockpitSuperbot.parse({
    enabled: false,
    shadow: true,
    intervalMins: plan.intervalMins,
    fallbackAfterIntervals: plan.fallbackAfterIntervals,
    maxOffersPerTick: plan.maxOffersPerTick,
    routes,
  });
  return {
    activation: "held",
    cockpitPatch: { superbot },
    teamPatches: plan.persistentTeams.map((team) => ({
      team: team.name,
      path: join(team.root, ".atmux", "team.json"),
      teamConfig: team.teamConfig,
      set: { bot: team.bot },
    })),
    activationBlockers: plan.activationBlockers,
  };
}
