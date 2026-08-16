import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  externalKanbanEnabled,
  kanbanBackendMarkerPath,
  kanbanWorkStateAvailable,
  readKanbanBackendMarker,
  writeKanbanBackendMarker,
} from "../../../src/core/kanban-backend.ts";

describe("durable Kanban backend marker", () => {
  let scratch = "";

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  test("defaults legacy, persists external privately, and permits explicit override", async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-kanban-backend-"));
    expect(await externalKanbanEnabled(scratch, {})).toBe(false);
    const marker = {
      version: 1 as const,
      backend: "external" as const,
      activatedAt: "2026-08-16T00:00:00.000Z",
      actor: "codex/driver",
      preparationReceipt: "/private/receipt.json",
    };
    await writeKanbanBackendMarker(scratch, marker);
    expect(await readKanbanBackendMarker(scratch)).toEqual(marker);
    expect(await externalKanbanEnabled(scratch, {})).toBe(true);
    expect(await externalKanbanEnabled(scratch, { ATMUX_KANBAN_BACKEND: "legacy" })).toBe(false);
    expect((await stat(kanbanBackendMarkerPath(scratch))).mode & 0o777).toBe(0o600);
  });

  test("discovers external and local authorities without creating a legacy stub", async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-kanban-available-"));
    expect(await kanbanWorkStateAvailable(scratch, {})).toBe(false);
    expect(await Bun.file(join(scratch, "kanban.json")).exists()).toBe(false);

    expect(await kanbanWorkStateAvailable(scratch, { ATMUX_KANBAN_BACKEND: "external" })).toBe(
      true,
    );
    await writeFile(join(scratch, "state.db"), "");
    expect(await kanbanWorkStateAvailable(scratch, {})).toBe(true);
  });
});
