#!/usr/bin/env bun

// ADR-285 phase 6: render reviewed, held JSON patches to stdout only.
// This script never mutates cockpit.json, team.json, git, or tmux.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderSuperbotFleetMigration } from "../src/core/superbot-fleet.ts";

const planPath = resolve(process.argv[2] ?? "docs/migrations/285-superbot-fleet-plan.json");
const raw = JSON.parse(await readFile(planPath, "utf8")) as unknown;
process.stdout.write(`${JSON.stringify(renderSuperbotFleetMigration(raw), null, 2)}\n`);
