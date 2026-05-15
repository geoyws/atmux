// Unit tests for src/abstractions/discord.ts (ADR-101).
//
// Covers:
//   - Validation (R-rules: bullet length, emoji prefix, empty body)
//   - Rendering (header format, bullets-only, sections-only, mixed)
//   - Chunking (single message, multi-message with N/M suffix, section-label
//     glued to first bullet)
//   - Send routing (recorder JSONL capture, direct-fetch via bun-native
//     `fetch`, ConfigError on no-webhook, DiscordWebhookError on non-2xx)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiscordSection,
  type DiscordSendOpts,
  renderAccountSwapFail,
  renderAccountSwapPassComplete,
  renderAccountSwapStart,
  renderAccountSwapSuccess,
  renderEternalImprovementDone,
  renderEternalImprovementProgress,
  renderEternalImprovementStart,
  renderMemberRefusalRotate,
  renderWhipBudgetPause,
  renderWhipBudgetRefreshSoon,
  renderWhipBudgetResume,
  renderWhipBudgetWarning,
  renderWhipConfigDrift,
  renderHygieneBlocker,
  renderWhipNeedsApproval,
  resolveWebhookUrl,
  send,
} from "../../../src/abstractions/discord.ts";
import { ConfigError, DiscordWebhookError } from "../../../src/errors.ts";

// ---------- Test scaffolding ----------

let tmpRoot: string;

const SAVED_ENV = {
  ATMUX_DISCORD_RECORDER: process.env.ATMUX_DISCORD_RECORDER,
  ATMUX_DISCORD_WEBHOOK: process.env.ATMUX_DISCORD_WEBHOOK,
  HOME: process.env.HOME,
};

function clearEnv(): void {
  delete process.env.ATMUX_DISCORD_RECORDER;
  delete process.env.ATMUX_DISCORD_WEBHOOK;
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "atmux-discord-test-"));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  restoreEnv();
});

beforeEach(() => {
  clearEnv();
  // HOME is irrelevant to the bun-native fetch path but we pin it for
  // determinism (some environment-resolution helpers consult it).
  process.env.HOME = "/nonexistent-test-home-atmux-bun-discord-spec";
});

afterEach(() => {
  restoreEnv();
});

// ---------- Helpers ----------

const FIXED_TS = Date.UTC(2026, 4, 4, 3, 44); // 2026-05-04 03:44 UTC = 11:44 MYT

function bullets(opts: Partial<DiscordSendOpts> = {}): DiscordSendOpts {
  return {
    template: "whip-progress",
    team: "atmux",
    category: "📊",
    bullets: ["✅ shipped", "🧪 tests green"],
    whenMs: FIXED_TS,
    ...opts,
  };
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const txt = await readFile(path, "utf8");
  return txt
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

// ---------- Validation ----------

describe("validation — empty body", () => {
  test("no bullets and no sections throws DiscordWebhookError", async () => {
    let caught: DiscordWebhookError | null = null;
    try {
      await send(bullets({ bullets: [] }));
    } catch (e) {
      if (e instanceof DiscordWebhookError) caught = e;
    }
    expect(caught?.message).toContain("empty body");
  });

  test("sections-only with empty bullets-array throws", async () => {
    let caught: DiscordWebhookError | null = null;
    try {
      await send({
        template: "whip-progress",
        team: "atmux",
        category: "📊",
        sections: [{ label: "Shipped", bullets: [] }],
        whenMs: FIXED_TS,
      });
    } catch (e) {
      if (e instanceof DiscordWebhookError) caught = e;
    }
    expect(caught?.message).toContain("empty body");
  });
});

describe("validation — bullet shape", () => {
  test("bullet over 80 graphemes throws", async () => {
    const long = `✅ ${"x".repeat(100)}`;
    let caught: DiscordWebhookError | null = null;
    try {
      await send(bullets({ bullets: [long] }));
    } catch (e) {
      if (e instanceof DiscordWebhookError) caught = e;
    }
    expect(caught?.message).toContain("too long");
    expect(caught?.message).toContain("max 80");
  });

  test("bullet missing emoji prefix throws", async () => {
    let caught: DiscordWebhookError | null = null;
    try {
      await send(bullets({ bullets: ["plain text bullet, no emoji"] }));
    } catch (e) {
      if (e instanceof DiscordWebhookError) caught = e;
    }
    expect(caught?.message).toContain("missing allowed emoji prefix");
  });

  test("bullet with disallowed emoji throws", async () => {
    let caught: DiscordWebhookError | null = null;
    try {
      await send(bullets({ bullets: ["🌎 not on the allowlist"] }));
    } catch (e) {
      if (e instanceof DiscordWebhookError) caught = e;
    }
    expect(caught?.message).toContain("missing allowed emoji prefix");
    expect(caught?.message).toContain("🌎");
  });

  test("empty-string bullet throws", async () => {
    let caught: DiscordWebhookError | null = null;
    try {
      await send(bullets({ bullets: ["✅ ok", ""] }));
    } catch (e) {
      if (e instanceof DiscordWebhookError) caught = e;
    }
    expect(caught?.message).toContain("is empty");
  });

  test("bullet validation also runs on section bullets", async () => {
    const sections: DiscordSection[] = [{ label: "🏗️ Shipped", bullets: ["bad-no-emoji-prefix"] }];
    let caught: DiscordWebhookError | null = null;
    try {
      await send({
        template: "whip-progress",
        team: "atmux",
        category: "📊",
        sections,
        whenMs: FIXED_TS,
      });
    } catch (e) {
      if (e instanceof DiscordWebhookError) caught = e;
    }
    expect(caught?.message).toContain("sections[0].bullets[0]");
  });

  test("multi-codepoint emoji (🛠️) is accepted as one grapheme", async () => {
    process.env.ATMUX_DISCORD_RECORDER = join(tmpRoot, "mc.jsonl");
    await send(bullets({ bullets: ["🛠️ rebuilt the migrator"] }));
    const calls = await readJsonl<{ payload: { content: string } }>(
      process.env.ATMUX_DISCORD_RECORDER,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.payload.content).toContain("🛠️ rebuilt the migrator");
  });

  test("80-grapheme bullet (boundary) is accepted", async () => {
    process.env.ATMUX_DISCORD_RECORDER = join(tmpRoot, "boundary.jsonl");
    const bullet = `✅ ${"a".repeat(78)}`; // 1 emoji + space + 78 = 80 graphemes
    await send(bullets({ bullets: [bullet] }));
    const calls = await readJsonl<{ payload: { content: string } }>(
      process.env.ATMUX_DISCORD_RECORDER,
    );
    expect(calls[0]?.payload.content).toContain(bullet);
  });
});

// ---------- Rendering ----------

describe("rendering — header + body", () => {
  test("header format matches CLAUDE.md spec", async () => {
    const recorder = join(tmpRoot, "header.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(bullets());
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    const content = calls[0]?.payload.content ?? "";
    expect(content.startsWith("📊 **[whip-progress]** · `atmux` · 11:44 MYT")).toBe(true);
  });

  test("bullets-only body has bullets after blank line", async () => {
    const recorder = join(tmpRoot, "bullets.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(bullets({ bullets: ["✅ first", "🧪 second"] }));
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    const lines = calls[0]?.payload.content.split("\n") ?? [];
    expect(lines[0]).toContain("**[whip-progress]**");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("✅ first");
    expect(lines[3]).toBe("🧪 second");
  });

  test("sections-only body has bold labels and bullets", async () => {
    const recorder = join(tmpRoot, "sections.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send({
      template: "whip-progress",
      team: "atmux",
      category: "📊",
      sections: [
        { label: "🏗️ Shipped", bullets: ["✅ a"] },
        { label: "📨 Dispatched", bullets: ["➡️ b"] },
      ],
      whenMs: FIXED_TS,
    });
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    const content = calls[0]?.payload.content ?? "";
    expect(content).toContain("**🏗️ Shipped**");
    expect(content).toContain("✅ a");
    expect(content).toContain("**📨 Dispatched**");
    expect(content).toContain("➡️ b");
  });

  test("mixed body has flat bullets, then sections separated by blank", async () => {
    const recorder = join(tmpRoot, "mixed.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      bullets({
        bullets: ["✅ flat-1"],
        sections: [{ label: "🏗️ Shipped", bullets: ["🧪 sec-1"] }],
      }),
    );
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    const lines = calls[0]?.payload.content.split("\n") ?? [];
    // header, blank, flat bullet, blank-between, label, sec-bullet
    expect(lines).toEqual([
      "📊 **[whip-progress]** · `atmux` · 11:44 MYT",
      "",
      "✅ flat-1",
      "",
      "**🏗️ Shipped**",
      "🧪 sec-1",
    ]);
  });

  test("default whenMs uses time.now (no whenMs passed)", async () => {
    const recorder = join(tmpRoot, "now.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send({
      template: "whip-progress",
      team: "atmux",
      category: "📊",
      bullets: ["✅ no-whenMs"],
    });
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    // We don't check the time value, just that it rendered as "HH:MM MYT".
    expect(calls[0]?.payload.content).toMatch(/\d{2}:\d{2} MYT/);
  });
});

// ---------- Chunking ----------

describe("chunking", () => {
  test("body that fits in 2000 bytes → single chunk, no (N/M) suffix", async () => {
    const recorder = join(tmpRoot, "single.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(bullets({ bullets: ["✅ short"] }));
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls.length).toBe(1);
    expect(calls[0]?.payload.content).not.toContain("(1/");
  });

  test("body >2000 bytes splits into multiple chunks with (N/M) suffix", async () => {
    const recorder = join(tmpRoot, "multi.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    // Build many ~78-char bullets — 30 of them ≈ 2400 bytes raw, forcing split.
    const big = Array.from({ length: 40 }, (_, i) => `✅ ${"x".repeat(70)}-${i}`);
    await send(bullets({ bullets: big }));
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls.length).toBeGreaterThan(1);
    const total = calls.length;
    for (let i = 0; i < total; i++) {
      const content = calls[i]?.payload.content ?? "";
      expect(content).toContain(`(${i + 1}/${total})`);
      expect(content.length).toBeLessThanOrEqual(2000);
    }
  });

  test("section label stays glued to first bullet across chunks", async () => {
    const recorder = join(tmpRoot, "glue.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    // First section fills almost a chunk; second section's label would
    // otherwise land at the tail of chunk 1 — ensure it migrates to chunk 2
    // with its first bullet.
    // 30 bullets × ~78 bytes = ~2340 bytes — guaranteed split with header overhead.
    const filler = Array.from({ length: 30 }, (_, i) => `✅ ${"x".repeat(70)}-${i}`);
    await send({
      template: "whip-progress",
      team: "atmux",
      category: "📊",
      sections: [
        { label: "🏗️ First", bullets: filler },
        { label: "📨 Second", bullets: ["➡️ second-section-first-bullet"] },
      ],
      whenMs: FIXED_TS,
    });
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls.length).toBeGreaterThan(1);
    // No chunk's content ends on a `**Label**` line.
    for (const c of calls) {
      const lines = c.payload.content.split("\n");
      const last = lines.at(-1) ?? "";
      const isLonelyLabel = last.startsWith("**") && last.endsWith("**");
      expect(isLonelyLabel).toBe(false);
    }
    // The chunk that contains "**📨 Second**" also contains the first bullet.
    const secondChunk = calls.find((c) => c.payload.content.includes("**📨 Second**"));
    expect(secondChunk?.payload.content).toContain("➡️ second-section-first-bullet");
  });
});

// ---------- Routing: recorder ----------

describe("routing — recorder", () => {
  test("ATMUX_DISCORD_RECORDER captures JSONL with ts + payload", async () => {
    const recorder = join(tmpRoot, "rec.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(bullets({ bullets: ["✅ recorded"] }));
    const calls = await readJsonl<{ ts: string; payload: { content: string } }>(recorder);
    expect(calls.length).toBe(1);
    expect(calls[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(calls[0]?.payload.content).toContain("✅ recorded");
  });

  test("recorder bypasses fetch (no network)", async () => {
    // Prove no fetch happened by setting a webhookOverride to a port that
    // would refuse — recorder path should never touch it.
    const recorder = join(tmpRoot, "nofetch.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(bullets({ webhookOverride: "http://127.0.0.1:1/never" }));
    const calls = await readJsonl<unknown>(recorder);
    expect(calls.length).toBe(1);
  });

  test("empty-string ATMUX_DISCORD_RECORDER falls through (treated as unset)", async () => {
    process.env.ATMUX_DISCORD_RECORDER = ""; // explicit empty
    delete process.env.ATMUX_DISCORD_WEBHOOK;
    let caught: ConfigError | null = null;
    try {
      await send(bullets());
    } catch (e) {
      if (e instanceof ConfigError) caught = e;
    }
    expect(caught?.message).toContain("no Discord webhook resolved");
  });
});

// (Removed: spawn ping-discord.sh delegation tests. The spawn route was
// dropped in favour of bun-native fetch — see ADR-101 §"Routing".)

// ---------- Routing: direct-fetch ----------

describe("routing — direct-fetch", () => {
  let server: ReturnType<typeof Bun.serve>;
  let lastRequest: { method: string; body: string } | null = null;
  let nextStatus = 204;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = await req.text();
        lastRequest = { method: req.method, body };
        return new Response(body, { status: nextStatus });
      },
    });
  });

  afterAll(async () => {
    await server.stop(true);
  });

  beforeEach(() => {
    lastRequest = null;
    nextStatus = 204;
  });

  test("default script absent + ATMUX_DISCORD_WEBHOOK set → POSTs via fetch", async () => {
    nextStatus = 204;
    process.env.ATMUX_DISCORD_WEBHOOK = `http://localhost:${server.port}/wh`;
    await send(bullets({ bullets: ["✅ via fetch"] }));
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.body).toContain("✅ via fetch");
    const parsed = JSON.parse(lastRequest?.body ?? "{}") as { content: string };
    expect(parsed.content).toContain("✅ via fetch");
  });

  test("webhookOverride takes precedence over env", async () => {
    nextStatus = 200;
    process.env.ATMUX_DISCORD_WEBHOOK = "http://127.0.0.1:1/wrong"; // would refuse
    await send(
      bullets({
        bullets: ["✅ override"],
        webhookOverride: `http://localhost:${server.port}/override`,
      }),
    );
    expect(lastRequest?.body).toContain("✅ override");
  });

  test("non-2xx response → DiscordWebhookError with statusCode + body", async () => {
    nextStatus = 429;
    process.env.ATMUX_DISCORD_WEBHOOK = `http://localhost:${server.port}/rl`;
    let caught: DiscordWebhookError | null = null;
    try {
      await send(bullets());
    } catch (e) {
      if (e instanceof DiscordWebhookError) caught = e;
    }
    expect(caught?.message).toContain("(HTTP 429)");
    expect(caught?.message).toContain("non-2xx");
  });

  test("network failure (refused connection) → DiscordWebhookError with cause", async () => {
    process.env.ATMUX_DISCORD_WEBHOOK = "http://127.0.0.1:1/refused";
    let caught: DiscordWebhookError | null = null;
    try {
      await send(bullets());
    } catch (e) {
      if (e instanceof DiscordWebhookError) caught = e;
    }
    expect(caught?.message).toContain("network failure");
    expect(caught?.cause).toBeDefined();
  });

  test("no webhook resolvable → ConfigError", async () => {
    delete process.env.ATMUX_DISCORD_WEBHOOK;
    let caught: ConfigError | null = null;
    try {
      await send(bullets());
    } catch (e) {
      if (e instanceof ConfigError) caught = e;
    }
    expect(caught?.message).toContain("no Discord webhook resolved");
  });

  test("empty-string webhookOverride falls through to env", async () => {
    nextStatus = 200;
    process.env.ATMUX_DISCORD_WEBHOOK = `http://localhost:${server.port}/from-env`;
    await send(bullets({ webhookOverride: "" }));
    expect(lastRequest).not.toBeNull();
  });

  test("repeat sends succeed (no per-process warning state)", async () => {
    nextStatus = 204;
    process.env.ATMUX_DISCORD_WEBHOOK = `http://localhost:${server.port}/repeat`;
    await send(bullets({ bullets: ["✅ first"] }));
    await send(bullets({ bullets: ["✅ second"] }));
    expect(lastRequest?.body).toContain("✅ second");
  });
});

describe("resolveWebhookUrl", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atmux-resolve-webhook-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("env var wins over team.json + xdg file", async () => {
    await mkdir(join(dir, ".config", "atmux"), { recursive: true });
    await writeFile(join(dir, ".config", "atmux", "discord-webhook"), "from-file\n");
    const got = await resolveWebhookUrl({
      env: { ATMUX_DISCORD_WEBHOOK: "from-env", HOME: dir },
      team: { discord: { webhook: "from-team" } },
    });
    expect(got).toBe("from-env");
  });

  test("team.json discord.webhook wins over xdg file when env empty", async () => {
    await mkdir(join(dir, ".config", "atmux"), { recursive: true });
    await writeFile(join(dir, ".config", "atmux", "discord-webhook"), "from-file\n");
    const got = await resolveWebhookUrl({
      env: { HOME: dir },
      team: { discord: { webhook: "from-team" } },
    });
    expect(got).toBe("from-team");
  });

  test("xdg file when env + team are empty", async () => {
    await mkdir(join(dir, ".config", "atmux"), { recursive: true });
    await writeFile(join(dir, ".config", "atmux", "discord-webhook"), "  from-file  \n");
    const got = await resolveWebhookUrl({ env: { HOME: dir } });
    expect(got).toBe("from-file");
  });

  test("XDG_CONFIG_HOME respected over $HOME/.config", async () => {
    const xdg = join(dir, "custom-xdg");
    await mkdir(join(xdg, "atmux"), { recursive: true });
    await writeFile(join(xdg, "atmux", "discord-webhook"), "from-xdg\n");
    const got = await resolveWebhookUrl({
      env: { XDG_CONFIG_HOME: xdg, HOME: dir },
    });
    expect(got).toBe("from-xdg");
  });

  test("returns null when env unset, no team, no xdg file", async () => {
    expect(await resolveWebhookUrl({ env: { HOME: dir } })).toBeNull();
  });

  test("empty env value treated as unset", async () => {
    await mkdir(join(dir, ".config", "atmux"), { recursive: true });
    await writeFile(join(dir, ".config", "atmux", "discord-webhook"), "from-file\n");
    expect(
      await resolveWebhookUrl({
        env: { ATMUX_DISCORD_WEBHOOK: "", HOME: dir },
      }),
    ).toBe("from-file");
  });

  test("team.discord absent / null / non-object skipped silently", async () => {
    await mkdir(join(dir, ".config", "atmux"), { recursive: true });
    await writeFile(join(dir, ".config", "atmux", "discord-webhook"), "from-file\n");
    expect(await resolveWebhookUrl({ env: { HOME: dir }, team: {} })).toBe("from-file");
    expect(await resolveWebhookUrl({ env: { HOME: dir }, team: { discord: null } })).toBe(
      "from-file",
    );
    expect(await resolveWebhookUrl({ env: { HOME: dir }, team: { discord: "string" } })).toBe(
      "from-file",
    );
  });

  test("team.discord.webhook empty/non-string skipped", async () => {
    await mkdir(join(dir, ".config", "atmux"), { recursive: true });
    await writeFile(join(dir, ".config", "atmux", "discord-webhook"), "from-file\n");
    expect(
      await resolveWebhookUrl({
        env: { HOME: dir },
        team: { discord: { webhook: "" } },
      }),
    ).toBe("from-file");
    expect(
      await resolveWebhookUrl({
        env: { HOME: dir },
        team: { discord: { webhook: 42 } },
      }),
    ).toBe("from-file");
  });

  test("HOME unset + no XDG → falls back to /.config/atmux/discord-webhook (returns null)", async () => {
    expect(await resolveWebhookUrl({ env: {} })).toBeNull();
  });

  test("xdg file present but empty after trim → returns null", async () => {
    await mkdir(join(dir, ".config", "atmux"), { recursive: true });
    await writeFile(join(dir, ".config", "atmux", "discord-webhook"), "   \n");
    expect(await resolveWebhookUrl({ env: { HOME: dir } })).toBeNull();
  });

  test("uses process.env when opts.env omitted", async () => {
    const prior = process.env.ATMUX_DISCORD_WEBHOOK;
    process.env.ATMUX_DISCORD_WEBHOOK = "from-process-env";
    try {
      expect(await resolveWebhookUrl()).toBe("from-process-env");
    } finally {
      if (prior !== undefined) process.env.ATMUX_DISCORD_WEBHOOK = prior;
      else delete process.env.ATMUX_DISCORD_WEBHOOK;
    }
  });
});

// ---------- ADR-052 eternal-improvement template renderers ----------

describe("renderEternalImprovementStart", () => {
  test("builds the 3-bullet [eternal-improvement-start] body per ADR-052", () => {
    const out = renderEternalImprovementStart({
      team: "atmux",
      budgetSpec: "30%-wk",
      budgetTotal: 1_500_000,
      mode: "user-invoked",
      runId: "ei-a3f2c814",
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("eternal-improvement-start");
    expect(out.team).toBe("atmux");
    expect(out.category).toBe("🌱");
    expect(out.bullets).toEqual([
      "🌱 budget: 30%-wk = 1.5M tokens",
      "🎯 mode: user-invoked",
      "📍 runId: ei-a3f2c814",
    ]);
    expect(out.whenMs).toBe(FIXED_TS);
  });

  test("idle-fallback mode renders verbatim", () => {
    const out = renderEternalImprovementStart({
      team: "atmux",
      budgetSpec: "30%-wk",
      budgetTotal: 1_500_000,
      mode: "idle-fallback",
      runId: "ei-deadbeef",
    });
    expect(out.bullets?.[1]).toBe("🎯 mode: idle-fallback");
  });

  test("whenMs omitted → not present in opts (caller's send() falls through to time.now)", () => {
    const out = renderEternalImprovementStart({
      team: "atmux",
      budgetSpec: "30%-wk",
      budgetTotal: 1_500_000,
      mode: "user-invoked",
      runId: "ei-a3f2c814",
    });
    expect(out.whenMs).toBeUndefined();
  });

  test("end-to-end: round-trips through send() recorder with a single chunk (no overflow)", async () => {
    const recorder = join(tmpRoot, "ei-start-e2e.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderEternalImprovementStart({
        team: "atmux",
        budgetSpec: "30%-wk",
        budgetTotal: 1_500_000,
        mode: "user-invoked",
        runId: "ei-a3f2c814",
        whenMs: FIXED_TS,
      }),
    );
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls.length).toBe(1);
    const content = calls[0]?.payload.content ?? "";
    expect(content).toBe(
      [
        "🌱 **[eternal-improvement-start]** · `atmux` · 11:44 MYT",
        "",
        // Verdict-first shape (CLAUDE.md §Discord, 2026-05-13).
        "🟢 **Shipping** — eternal-improvement run starting on 1.5M tokens (user-invoked)",
        "",
        "🌱 budget: 30%-wk = 1.5M tokens",
        "🎯 mode: user-invoked",
        "📍 runId: ei-a3f2c814",
      ].join("\n"),
    );
    // Single-chunk: no (N/M) suffix.
    expect(content).not.toContain("(1/");
    expect(content.length).toBeLessThanOrEqual(2000);
  });

  test("token formatter: 200k mid-range, 2M whole", async () => {
    const recorder = join(tmpRoot, "ei-start-tokens.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderEternalImprovementStart({
        team: "atmux",
        budgetSpec: "13%-wk",
        budgetTotal: 200_000,
        mode: "user-invoked",
        runId: "ei-2k",
        whenMs: FIXED_TS,
      }),
    );
    await send(
      renderEternalImprovementStart({
        team: "atmux",
        budgetSpec: "40%-wk",
        budgetTotal: 2_000_000,
        mode: "user-invoked",
        runId: "ei-2m",
        whenMs: FIXED_TS,
      }),
    );
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls[0]?.payload.content).toContain("200k tokens");
    expect(calls[1]?.payload.content).toContain("2M tokens");
  });
});

describe("renderEternalImprovementProgress", () => {
  test("builds the 4-bullet [eternal-improvement-progress] body per ADR-052", () => {
    const out = renderEternalImprovementProgress({
      team: "atmux",
      cycleN: 3,
      tasksShipped: 2,
      tokensSpent: 200_000,
      budgetTotal: 1_500_000,
      budgetRemaining: 1_300_000,
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("eternal-improvement-progress");
    expect(out.category).toBe("🌱");
    expect(out.bullets).toEqual([
      "✅ cycle 3 closed — 2 tasks shipped",
      "💰 tokens spent: 200k of 1.5M",
      "📊 budget remaining: 1.3M",
      "🔜 cycle 4 starting",
    ]);
  });

  test("end-to-end: chunker fits whole body in one chunk", async () => {
    const recorder = join(tmpRoot, "ei-progress-e2e.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderEternalImprovementProgress({
        team: "atmux",
        cycleN: 3,
        tasksShipped: 2,
        tokensSpent: 200_000,
        budgetTotal: 1_500_000,
        budgetRemaining: 1_300_000,
        whenMs: FIXED_TS,
      }),
    );
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls.length).toBe(1);
    const content = calls[0]?.payload.content ?? "";
    expect(content.startsWith("🌱 **[eternal-improvement-progress]** · `atmux` ·")).toBe(true);
    expect(content).toContain("🔜 cycle 4 starting");
    expect(content).not.toContain("(1/");
  });

  test("cycle increment N→N+1 reflects in next-cycle bullet", () => {
    const out = renderEternalImprovementProgress({
      team: "atmux",
      cycleN: 9,
      tasksShipped: 1,
      tokensSpent: 50_000,
      budgetTotal: 1_500_000,
      budgetRemaining: 1_450_000,
    });
    expect(out.bullets?.[3]).toBe("🔜 cycle 10 starting");
  });
});

describe("renderEternalImprovementDone", () => {
  test("Mode A run (no overage, no Mode B bullet)", () => {
    const out = renderEternalImprovementDone({
      team: "atmux",
      cycleCount: 4,
      totalTasksShipped: 12,
      tokensConsumed: 1_400_000,
      budgetTotal: 1_500_000,
      durationMs: 6 * 60 * 60 * 1000 + 45 * 60 * 1000, // 6h45m
      modeB: false,
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("eternal-improvement-done");
    expect(out.category).toBe("🌱");
    expect(out.bullets).toEqual([
      "✅ run complete — 4 cycles, 12 tasks shipped",
      "💰 tokens consumed: 1.4M of 1.5M",
      "⏱️ duration: 6h45m",
    ]);
  });

  test("Mode B run with mid-task overage matches ADR example shape", () => {
    const out = renderEternalImprovementDone({
      team: "atmux",
      cycleCount: 4,
      totalTasksShipped: 12,
      tokensConsumed: 1_520_000, // 1.3% over 1.5M
      budgetTotal: 1_500_000,
      durationMs: 6 * 60 * 60 * 1000 + 45 * 60 * 1000,
      modeB: true,
      whenMs: FIXED_TS,
    });
    expect(out.bullets).toEqual([
      "✅ run complete — 4 cycles, 12 tasks shipped",
      "💰 tokens consumed: 1.52M of 1.5M (1.3% overage, mid-task)",
      "⏱️ duration: 6h45m",
      "🛑 (Mode B) team will now `atmux stop`",
    ]);
  });

  test("end-to-end: Mode B body round-trips through send() in one chunk", async () => {
    const recorder = join(tmpRoot, "ei-done-e2e.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderEternalImprovementDone({
        team: "atmux",
        cycleCount: 4,
        totalTasksShipped: 12,
        tokensConsumed: 1_520_000,
        budgetTotal: 1_500_000,
        durationMs: 6 * 60 * 60 * 1000 + 45 * 60 * 1000,
        modeB: true,
        whenMs: FIXED_TS,
      }),
    );
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls.length).toBe(1);
    const content = calls[0]?.payload.content ?? "";
    expect(content.startsWith("🌱 **[eternal-improvement-done]** · `atmux` ·")).toBe(true);
    expect(content).toContain("🛑 (Mode B) team will now `atmux stop`");
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).not.toContain("(1/");
  });

  test("zero-budget edge case: no overage rendered (avoids divide-by-zero)", () => {
    const out = renderEternalImprovementDone({
      team: "atmux",
      cycleCount: 0,
      totalTasksShipped: 0,
      tokensConsumed: 100,
      budgetTotal: 0,
      durationMs: 30_000,
      modeB: false,
    });
    expect(out.bullets?.[1]).toBe("💰 tokens consumed: 100 of 0");
  });

  test("sub-minute duration formats as 1min", () => {
    const out = renderEternalImprovementDone({
      team: "atmux",
      cycleCount: 1,
      totalTasksShipped: 1,
      tokensConsumed: 5_000,
      budgetTotal: 1_500_000,
      durationMs: 30_000,
      modeB: false,
    });
    expect(out.bullets?.[2]).toBe("⏱️ duration: 1min");
  });
});

// ---------- ADR-054 §D3 — renderWhipConfigDrift ----------

describe("renderWhipConfigDrift", () => {
  test("renders schema-drift template with header + issues + fix + hash", () => {
    const out = renderWhipConfigDrift({
      team: "atmux",
      driftHash: "a3f2c814deadbeefcafebabe1234567890abcdef1234567890",
      issues: [
        {
          path: ["whip", "budgetPauseTreshold"], // typo
          code: "unrecognized_keys",
          message: "Unrecognized key: 'budgetPauseTreshold'",
        },
        {
          path: ["whip", "leadMaxMin"],
          code: "invalid_type",
          message: "Expected number, received string",
        },
      ],
      catastrophic: false,
    });
    expect(out.template).toBe("whip-config-drift");
    expect(out.team).toBe("atmux");
    expect(out.category).toBe("🛠️");
    // Verdict-first shape: headline lives in `verdict`, body has issues/fix/hash.
    expect(out.verdict).toContain("validation failed");
    expect(out.verdict).toContain("safe defaults");
    const bullets = out.bullets ?? [];
    // Issues count + by-code summary — now bullets[0].
    expect(bullets[0]).toContain("issues: 2");
    expect(bullets[0]).toContain("invalid_type");
    expect(bullets[0]).toContain("unrecognized_keys");
    // First-issue surfacing.
    expect(bullets.some((b) => b.includes("whip.budgetPauseTreshold"))).toBe(true);
    // Fix hint.
    expect(bullets.some((b) => b.includes("edit team.json"))).toBe(true);
    // Drift hash truncated to 8 chars in display.
    expect(bullets.some((b) => b.includes("a3f2c814"))).toBe(true);
  });

  test("catastrophic flag flips the verdict to malformed-JSON variant", () => {
    const out = renderWhipConfigDrift({
      team: "atmux",
      driftHash: "deadbeef00000000",
      issues: [
        {
          path: [],
          code: "invalid_json",
          message: "Unexpected token at position 5",
        },
      ],
      catastrophic: true,
    });
    expect(out.verdict).toContain("malformed");
    expect(out.verdict).toContain("full safe defaults");
  });

  test("zero-issues input still renders verdict + fix bullet", () => {
    const out = renderWhipConfigDrift({
      team: "atmux",
      driftHash: "00000000",
      issues: [],
      catastrophic: false,
    });
    const bullets = out.bullets ?? [];
    // Verdict carries the headline.
    expect(out.verdict).toContain("validation failed");
    // Body opens with the issues count.
    expect(bullets[0]).toContain("issues: 0");
    // No "first:" bullet when issues empty.
    expect(bullets.some((b) => b.startsWith("🔍 first:"))).toBe(false);
  });

  test("first issue with empty path renders <root> placeholder", () => {
    const out = renderWhipConfigDrift({
      team: "atmux",
      driftHash: "11111111",
      issues: [{ path: [], code: "invalid_json", message: "bad" }],
      catastrophic: true,
    });
    expect(out.bullets?.some((b) => b.includes("<root>"))).toBe(true);
  });

  test("whenMs override propagates to DiscordSendOpts", () => {
    const out = renderWhipConfigDrift({
      team: "atmux",
      driftHash: "222",
      issues: [],
      catastrophic: false,
      whenMs: 1_700_000_000_000,
    });
    expect(out.whenMs).toBe(1_700_000_000_000);
  });
});

// ---------- ADR-053 §D3 budget observability renderers ----------

describe("renderWhipBudgetPause", () => {
  test("builds template with at-risk roster + resume-gate hint", () => {
    const out = renderWhipBudgetPause({
      team: "atmux",
      atRisk: [
        { member: "alpha", h5: 95, wk: 80 },
        { member: "beta", h5: 88, wk: 92 },
      ],
      resumeThresholdPct: 20,
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("whip-budget-pause");
    expect(out.team).toBe("atmux");
    expect(out.category).toBe("🛑");
    // Verdict-first shape per CLAUDE.md §Discord (2026-05-13 rewrite) —
    // headline lives in `verdict`, body lists per-member detail + ops bullets.
    expect(out.verdict).toBe("🔴 **Stalled** — team paused on rate-limit, 2 at-risk members");
    expect(out.bullets).toEqual([
      "🪫 alpha — 5h 95% / wk 80%",
      "🪫 beta — 5h 88% / wk 92%",
      "🛑 no new dispatches until refresh",
      "🔁 resume gate: all members > 20% remaining on 5h AND wk",
    ]);
    expect(out.whenMs).toBe(FIXED_TS);
  });

  test("end-to-end through send recorder fits one chunk", async () => {
    const recorder = join(tmpRoot, "wb-pause.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderWhipBudgetPause({
        team: "atmux",
        atRisk: [{ member: "alpha", h5: 95, wk: 80 }],
        resumeThresholdPct: 20,
        whenMs: FIXED_TS,
      }),
    );
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls.length).toBe(1);
    const c = calls[0]?.payload.content ?? "";
    expect(c.startsWith("🛑 **[whip-budget-pause]** · `atmux` · 11:44 MYT")).toBe(true);
  });
});

describe("renderWhipBudgetResume", () => {
  test("builds the brief 2-bullet body with category 🚀", () => {
    const out = renderWhipBudgetResume({
      team: "atmux",
      resumeThresholdPct: 20,
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("whip-budget-resume");
    expect(out.category).toBe("🚀");
    expect(out.bullets).toEqual([
      "🟢 team resumed — all members > 20% remaining on 5h AND wk",
      "▶️ dispatches re-enabled",
    ]);
  });
});

describe("renderWhipBudgetWarning", () => {
  test("builds 4-bullet body with band + reset + affected + nextBand", () => {
    const out = renderWhipBudgetWarning({
      team: "atmux",
      account: "icloud",
      window: "5h",
      remainingPct: 22,
      band: 0.25,
      resetIn: "4h53m",
      affectedMembers: 3,
      nextBandPct: 15,
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("whip-budget-warning");
    expect(out.category).toBe("⚠️");
    expect(out.bullets).toEqual([
      "💰 account: `icloud` — remaining 5h: 22% (band: 25%)",
      "⏱️ resets in: 4h53m",
      "👥 affected members: 3",
      "🔁 next band: 15%",
    ]);
  });

  test("nextBandPct omitted → no next-band hint bullet", () => {
    const out = renderWhipBudgetWarning({
      team: "atmux",
      account: "icloud",
      window: "wk",
      remainingPct: 8,
      band: 0.15,
      resetIn: "2d",
      affectedMembers: 1,
    });
    expect(out.bullets?.length).toBe(3);
    expect(out.bullets?.[0]).toContain("(band: 15%)");
  });

  test("wk window renders verbatim in body", () => {
    const out = renderWhipBudgetWarning({
      team: "atmux",
      account: "icloud",
      window: "wk",
      remainingPct: 12,
      band: 0.15,
      resetIn: "3d4h",
      affectedMembers: 2,
    });
    expect(out.bullets?.[0]).toContain("remaining wk: 12%");
  });
});

describe("renderWhipBudgetRefreshSoon", () => {
  test("builds 3-bullet body with paused-now hint when active", () => {
    const out = renderWhipBudgetRefreshSoon({
      team: "atmux",
      account: "icloud",
      window: "5h",
      resetsIn: "28min",
      remainingPct: 8,
      pausedNow: true,
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("whip-budget-refresh-soon");
    expect(out.category).toBe("🌅");
    expect(out.bullets).toEqual([
      "⏱️ window resets in: 28min (5h)",
      "💰 account: `icloud` — remaining: 8%",
      "🔁 will auto-resume on refresh",
    ]);
  });

  test("pausedNow=false omits the auto-resume hint bullet", () => {
    const out = renderWhipBudgetRefreshSoon({
      team: "atmux",
      account: "icloud",
      window: "wk",
      resetsIn: "1h",
      remainingPct: 18,
      pausedNow: false,
    });
    expect(out.bullets?.length).toBe(2);
    expect(out.bullets?.find((b) => b.includes("auto-resume"))).toBeUndefined();
  });
});

// ---------- ADR-056 account-swap template renderers ----------

describe("renderAccountSwapStart", () => {
  test("builds the 4-bullet [whip-account-swap-start] body per ADR-056 §D5", () => {
    const out = renderAccountSwapStart({
      team: "atmux",
      triggerAccount: "icloud",
      triggerPct: 76,
      triggerWindow: "5h",
      candidates: 6,
      excluded: 3,
      excludedRoles: "lead/planner/reviewer",
      fallbackAccount: "ifca",
      fallbackH5: 8,
      fallbackWk: 12,
      passId: "swap-a3f2c814",
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("whip-account-swap-start");
    expect(out.team).toBe("atmux");
    expect(out.category).toBe("🔄");
    expect(out.bullets).toEqual([
      "🚨 trigger: account `icloud` at 76% (5h)",
      "👥 candidates: 6 members (3 excluded: lead/planner/reviewer)",
      "🎯 target fallback: `ifca` (8%/12%)",
      "🆔 passId: swap-a3f2c814",
    ]);
    expect(out.whenMs).toBe(FIXED_TS);
  });

  test("wk-window trigger renders verbatim", () => {
    const out = renderAccountSwapStart({
      team: "atmux",
      triggerAccount: "icloud",
      triggerPct: 76,
      triggerWindow: "wk",
      candidates: 1,
      excluded: 0,
      excludedRoles: "",
      fallbackAccount: "ifca",
      fallbackH5: 8,
      fallbackWk: 12,
      passId: "swap-deadbeef",
    });
    expect(out.bullets?.[0]).toBe("🚨 trigger: account `icloud` at 76% (wk)");
  });

  test("end-to-end through send() recorder produces canonical chunk", async () => {
    const recorder = join(tmpRoot, "swap-start-e2e.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderAccountSwapStart({
        team: "atmux",
        triggerAccount: "icloud",
        triggerPct: 76,
        triggerWindow: "5h",
        candidates: 6,
        excluded: 3,
        excludedRoles: "lead/planner/reviewer",
        fallbackAccount: "ifca",
        fallbackH5: 8,
        fallbackWk: 12,
        passId: "swap-a3f2c814",
        whenMs: FIXED_TS,
      }),
    );
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls.length).toBe(1);
    const content = calls[0]?.payload.content ?? "";
    expect(content).toContain("🔄 **[whip-account-swap-start]** · `atmux` · 11:44 MYT");
    expect(content).toContain("🆔 passId: swap-a3f2c814");
  });
});

describe("renderAccountSwapSuccess", () => {
  test("with in-flight task → handed-off bullet present", () => {
    const out = renderAccountSwapSuccess({
      team: "atmux",
      fromMember: "parity-state-impl",
      toMember: "parity-state-impl-swap",
      toAccount: "ifca",
      taskId: "t-abc1234",
      durationMs: 222_000, // 3min42s
      progressDone: 3,
      progressTotal: 6,
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("whip-account-swap-success");
    expect(out.bullets?.[0]).toBe(
      "✅ swapped: `parity-state-impl` → `parity-state-impl-swap` on `ifca`",
    );
    expect(out.bullets?.[1]).toBe("💼 in-flight task: t-abc1234 (handed off cleanly)");
    expect(out.bullets?.[2]).toContain("⏱️ duration:");
    expect(out.bullets?.[3]).toBe("📊 progress: 3/6");
  });

  test("no in-flight task → clean-handoff bullet", () => {
    const out = renderAccountSwapSuccess({
      team: "atmux",
      fromMember: "alpha",
      toMember: "alpha-swap",
      toAccount: "ifca",
      taskId: null,
      durationMs: 60_000,
      progressDone: 1,
      progressTotal: 1,
    });
    expect(out.bullets?.[1]).toBe("💼 in-flight task: (none — clean handoff)");
  });
});

describe("renderAccountSwapFail", () => {
  test("with flagId → flag bullet includes id", () => {
    const out = renderAccountSwapFail({
      team: "atmux",
      member: "up-impl",
      failureBrief: "target probe 401",
      reason: "refresh failed for `ifca` — re-login needed",
      fallbackAccount: "icloud",
      flagId: "flag-c0ffee00",
      flagSeverity: "p2",
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("whip-account-swap-fail");
    expect(out.bullets?.[0]).toBe("❌ swap aborted: `up-impl` (target probe 401)");
    expect(out.bullets?.[1]).toBe("🚩 reason: refresh failed for `ifca` — re-login needed");
    expect(out.bullets?.[2]).toBe("📍 fallback: keeping `up-impl` on `icloud` (will hit pause)");
    expect(out.bullets?.[3]).toBe("🚩 flag: p2 raised (flag-c0ffee00)");
  });

  test("no flagId → severity-only flag bullet", () => {
    const out = renderAccountSwapFail({
      team: "atmux",
      member: "alpha",
      failureBrief: "spawn timeout",
      reason: "shadow pane never reached prompt",
      fallbackAccount: "icloud",
      flagId: null,
      flagSeverity: "p1",
    });
    expect(out.bullets?.[3]).toBe("🚩 flag: p1 raised");
  });
});

describe("renderAccountSwapPassComplete", () => {
  test("builds the 4-bullet [whip-account-swap-pass-complete] body", () => {
    const out = renderAccountSwapPassComplete({
      team: "atmux",
      passId: "swap-a3f2c814",
      swapped: 5,
      aborted: 1,
      excluded: 3,
      triggerAccount: "icloud",
      triggerPctPostPass: 76,
      durationMs: 18 * 60 * 1000, // 18min
      whenMs: FIXED_TS,
    });
    expect(out.template).toBe("whip-account-swap-pass-complete");
    expect(out.bullets?.[0]).toBe("✅ pass `swap-a3f2c814` complete");
    expect(out.bullets?.[1]).toBe("📊 swapped: 5 / aborted: 1 / excluded: 3");
    expect(out.bullets?.[2]).toBe("💰 budget on icloud post-pass: 76% used (no longer pinned)");
    expect(out.bullets?.[3]).toContain("⏱️ pass duration:");
  });

  test("end-to-end through send() recorder", async () => {
    const recorder = join(tmpRoot, "swap-complete-e2e.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderAccountSwapPassComplete({
        team: "atmux",
        passId: "swap-c0ffee00",
        swapped: 5,
        aborted: 0,
        excluded: 3,
        triggerAccount: "icloud",
        triggerPctPostPass: 76,
        durationMs: 600_000,
        whenMs: FIXED_TS,
      }),
    );
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls.length).toBe(1);
    const content = calls[0]?.payload.content ?? "";
    expect(content).toContain("🔄 **[whip-account-swap-pass-complete]**");
    expect(content).toContain("swap-c0ffee00");
  });
});

// ---------- ADR-057 §D6 — renderWhipWatchdog ----------

describe("renderWhipWatchdog", () => {
  test("renders watchdog template with stalled-member bullets", async () => {
    const { renderWhipWatchdog } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipWatchdog({
      team: "atmux",
      stale: [
        { member: "alice", ageSec: 600 },
        { member: "bob", ageSec: null },
      ],
      staleSec: 300,
    });
    expect(out.template).toBe("whip-watchdog");
    expect(out.team).toBe("atmux");
    expect(out.category).toBe("🛑");
    // Verdict-first shape: headline lives in `verdict`, per-member bullets remain.
    expect(out.verdict).toContain("🔴 **Stalled**");
    expect(out.verdict).toContain("2 members silent");
    expect(out.verdict).toContain("5min"); // formatDuration(300_000)
    const bullets = out.bullets ?? [];
    expect(bullets.some((b) => b.includes("alice:") && b.includes("10min"))).toBe(true);
    expect(bullets.some((b) => b.includes("bob: never stale"))).toBe(true);
    expect(bullets.some((b) => b.includes("fix:"))).toBe(true);
  });

  test("zero stale → verdict says 0 members (degenerate but rendered)", async () => {
    const { renderWhipWatchdog } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipWatchdog({
      team: "atmux",
      stale: [],
      staleSec: 300,
    });
    expect(out.verdict).toContain("0 members silent");
  });

  test("whenMs override propagates", async () => {
    const { renderWhipWatchdog } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipWatchdog({
      team: "atmux",
      stale: [{ member: "x", ageSec: 1000 }],
      staleSec: 300,
      whenMs: 1_700_000_000_000,
    });
    expect(out.whenMs).toBe(1_700_000_000_000);
  });
});

// ---------- ADR-055 §D5 — renderWhipSelfHealAttempt ----------

describe("renderWhipSelfHealAttempt", () => {
  test("renders attempt template per ADR-055 §D5 worked example", async () => {
    const { renderWhipSelfHealAttempt } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipSelfHealAttempt({
      team: "atmux",
      recipeId: "fix:team-json-schema-drift",
      reason: "3 invalid keys detected",
      tokenCap: 5000,
    });
    expect(out.template).toBe("whip-self-heal-attempt");
    expect(out.team).toBe("atmux");
    expect(out.category).toBe("🔧");
    const bullets = out.bullets ?? [];
    expect(bullets).toEqual([
      "🛠️ recipe: fix:team-json-schema-drift",
      "📍 reason: 3 invalid keys detected",
      "💰 token cap: 5k",
    ]);
  });

  test("formats sub-1k token cap as integer", async () => {
    const { renderWhipSelfHealAttempt } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipSelfHealAttempt({
      team: "atmux",
      recipeId: "fix:supervisor-missing",
      reason: "supervisor window absent",
      tokenCap: 500,
    });
    const bullets = out.bullets ?? [];
    expect(bullets[2]).toBe("💰 token cap: 500");
  });

  test("whenMs override propagates", async () => {
    const { renderWhipSelfHealAttempt } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipSelfHealAttempt({
      team: "atmux",
      recipeId: "fix:cron-pollution",
      reason: "stale block detected",
      tokenCap: 5000,
      whenMs: 1_700_000_000_000,
    });
    expect(out.whenMs).toBe(1_700_000_000_000);
  });

  test("renderer output passes send-time validation (bullets non-empty + emoji prefix)", async () => {
    const { renderWhipSelfHealAttempt, send } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const recorder = join(tmpRoot, "self-heal-attempt-record.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    const out = renderWhipSelfHealAttempt({
      team: "atmux",
      recipeId: "fix:team-json-schema-drift",
      reason: "3 invalid keys detected",
      tokenCap: 5000,
    });
    await send(out); // would throw on validation failure
    const written = await readFile(recorder, "utf8");
    expect(written).toContain("[whip-self-heal-attempt]");
    expect(written).toContain("fix:team-json-schema-drift");
  });
});

// ---------- ADR-055 §D5 — renderWhipSelfHealResult ----------

describe("renderWhipSelfHealResult", () => {
  test("success variant — patch staged + tokens + summary + log", async () => {
    const { renderWhipSelfHealResult } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipSelfHealResult({
      team: "atmux",
      recipeId: "fix:team-json-schema-drift",
      ok: true,
      tokensUsed: 1200,
      tokenCap: 5000,
      patchSummary: "3 keys updated; pending reviewer",
      logPath: ".atmux/logs/cursor-self-heal-fix-team-json-schema-drift-1778120000.log",
    });
    expect(out.template).toBe("whip-self-heal-result");
    expect(out.team).toBe("atmux");
    expect(out.category).toBe("🔧");
    const bullets = out.bullets ?? [];
    expect(bullets).toEqual([
      "✅ recipe: fix:team-json-schema-drift — patch staged",
      "💰 tokens used: 1k of 5k cap",
      "📜 patch: 3 keys updated; pending reviewer",
      "📍 see: .atmux/logs/cursor-self-heal-fix-team-json-schema-drift-1778120000.log",
    ]);
  });

  test("failure variant — first reason + tail count + log + flag", async () => {
    const { renderWhipSelfHealResult } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipSelfHealResult({
      team: "atmux",
      recipeId: "fix:supervisor-missing",
      ok: false,
      tokensUsed: 200,
      tokenCap: 1000,
      patchSummary: "supervisor still absent",
      logPath: ".atmux/logs/cursor-self-heal-fix-supervisor-missing-1778120000.log",
      reasons: ["tmux list-windows still shows supervisor absent"],
      flagSeverity: "p2",
    });
    const bullets = out.bullets ?? [];
    expect(bullets).toEqual([
      "❌ recipe: fix:supervisor-missing — verify failed",
      "🛑 reasons: tmux list-windows still shows supervisor absent",
      "📍 see: .atmux/logs/cursor-self-heal-fix-supervisor-missing-1778120000.log",
      "🚩 flag: p2 raised — operator triage needed",
    ]);
  });

  test("failure variant with multiple reasons appends '(N more)' suffix", async () => {
    const { renderWhipSelfHealResult } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipSelfHealResult({
      team: "atmux",
      recipeId: "fix:cron-pollution",
      ok: false,
      tokensUsed: 0,
      tokenCap: 5000,
      patchSummary: "verify failed",
      logPath: ".atmux/logs/x.log",
      reasons: ["block markers mismatched", "duplicate entries", "external lines"],
      flagSeverity: "p2",
    });
    const bullets = out.bullets ?? [];
    expect(bullets[1]).toBe("🛑 reasons: block markers mismatched (2 more)");
  });

  test("failure variant falls back to patchSummary when reasons empty", async () => {
    const { renderWhipSelfHealResult } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipSelfHealResult({
      team: "atmux",
      recipeId: "fix:team-json-schema-drift",
      ok: false,
      tokensUsed: 0,
      tokenCap: 5000,
      patchSummary: "team.json missing post-cursor",
      logPath: ".atmux/logs/x.log",
      reasons: [],
      flagSeverity: "p2",
    });
    const bullets = out.bullets ?? [];
    expect(bullets[1]).toBe("🛑 reasons: team.json missing post-cursor");
  });

  test("failure variant defaults severity to p2 when flagSeverity omitted", async () => {
    const { renderWhipSelfHealResult } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipSelfHealResult({
      team: "atmux",
      recipeId: "fix:cron-pollution",
      ok: false,
      tokensUsed: 0,
      tokenCap: 5000,
      patchSummary: "fail",
      logPath: ".atmux/logs/x.log",
      reasons: ["x"],
    });
    const bullets = out.bullets ?? [];
    expect(bullets[3]).toBe("🚩 flag: p2 raised — operator triage needed");
  });

  test("tokensUsed -1 (parse failure) renders as '?'", async () => {
    const { renderWhipSelfHealResult } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipSelfHealResult({
      team: "atmux",
      recipeId: "fix:team-json-schema-drift",
      ok: true,
      tokensUsed: -1,
      tokenCap: 5000,
      patchSummary: "1 key updated",
      logPath: ".atmux/logs/x.log",
    });
    const bullets = out.bullets ?? [];
    expect(bullets[1]).toBe("💰 tokens used: ? of 5k cap");
  });

  test("whenMs override propagates", async () => {
    const { renderWhipSelfHealResult } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipSelfHealResult({
      team: "atmux",
      recipeId: "fix:cron-pollution",
      ok: true,
      tokensUsed: 100,
      tokenCap: 5000,
      patchSummary: "ok",
      logPath: ".atmux/logs/x.log",
      whenMs: 1_700_000_000_000,
    });
    expect(out.whenMs).toBe(1_700_000_000_000);
  });

  test("success-variant output passes send-time validation", async () => {
    const { renderWhipSelfHealResult, send } = await import("../../../src/abstractions/discord.ts");
    const recorder = join(tmpRoot, "self-heal-result-success-record.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    const out = renderWhipSelfHealResult({
      team: "atmux",
      recipeId: "fix:team-json-schema-drift",
      ok: true,
      tokensUsed: 1200,
      tokenCap: 5000,
      patchSummary: "3 keys updated; pending reviewer",
      logPath: ".atmux/logs/x.log",
    });
    await send(out);
    const written = await readFile(recorder, "utf8");
    expect(written).toContain("[whip-self-heal-result]");
    expect(written).toContain("patch staged");
  });

  test("failure-variant output passes send-time validation", async () => {
    const { renderWhipSelfHealResult, send } = await import("../../../src/abstractions/discord.ts");
    const recorder = join(tmpRoot, "self-heal-result-fail-record.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    const out = renderWhipSelfHealResult({
      team: "atmux",
      recipeId: "fix:supervisor-missing",
      ok: false,
      tokensUsed: 0,
      tokenCap: 1000,
      patchSummary: "supervisor still absent",
      logPath: ".atmux/logs/x.log",
      reasons: ["tmux list-windows still shows supervisor absent"],
      flagSeverity: "p2",
    });
    await send(out);
    const written = await readFile(recorder, "utf8");
    expect(written).toContain("[whip-self-heal-result]");
    expect(written).toContain("verify failed");
  });
});

// ---------- ADR-057 §D4 — perm-mode-drift + defunct-cwd renderers ----------

describe("renderWhipPermModeDrift", () => {
  test("single drifted member produces verdict + 2 bullets", async () => {
    const { renderWhipPermModeDrift } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipPermModeDrift({
      team: "atmux",
      drifted: [{ member: "alpha", mode: "dont-ask" }],
    });
    expect(out.template).toBe("whip-perm-mode-drift");
    expect(out.category).toBe("📋");
    expect(out.team).toBe("atmux");
    // Verdict-first shape: headline lives in `verdict`, per-member + fix bullets remain.
    expect(out.verdict).toBe("🟡 **Cool** — 1 member drifted off auto-mode, fixable via BTab");
    expect(out.bullets).toEqual([
      "🟡 alpha: pane in 'dont-ask' mode (expected 'auto')",
      "🛠️ fix: BTab cycle to auto on each drifted pane",
    ]);
  });

  test("multiple drifted members all surfaced as separate bullets", async () => {
    const { renderWhipPermModeDrift } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipPermModeDrift({
      team: "atmux",
      drifted: [
        { member: "alpha", mode: "dont-ask" },
        { member: "bravo", mode: "accept-edits" },
      ],
    });
    expect(out.verdict).toContain("2 members drifted off auto-mode");
    expect(out.bullets).toHaveLength(3); // 2 per-member + 1 fix
    expect((out.bullets ?? [])[0]).toContain("alpha");
    expect((out.bullets ?? [])[1]).toContain("bravo");
  });

  test("whenMs override is propagated", async () => {
    const { renderWhipPermModeDrift } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipPermModeDrift({
      team: "atmux",
      drifted: [{ member: "alpha", mode: "plan" }],
      whenMs: 1_700_000_000_000,
    });
    expect(out.whenMs).toBe(1_700_000_000_000);
  });

  test("send-time validation passes", async () => {
    const { renderWhipPermModeDrift, send } = await import("../../../src/abstractions/discord.ts");
    const recorder = join(tmpRoot, "perm-mode-drift-record.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderWhipPermModeDrift({
        team: "atmux",
        drifted: [{ member: "alpha", mode: "dont-ask" }],
      }),
    );
    const written = await readFile(recorder, "utf8");
    expect(written).toContain("[whip-perm-mode-drift]");
    expect(written).toContain("dont-ask");
  });
});

describe("renderWhipDefunctCwd", () => {
  test("single defunct member produces verdict + 2 bullets", async () => {
    const { renderWhipDefunctCwd } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipDefunctCwd({
      team: "atmux",
      defunct: [{ member: "alpha", cwd: "/tmp/dead-worktree" }],
    });
    expect(out.template).toBe("whip-defunct-cwd");
    expect(out.category).toBe("🛑");
    expect(out.team).toBe("atmux");
    // Verdict-first shape: headline lives in `verdict`, per-member + fix bullets remain.
    expect(out.verdict).toBe("🚨 **Need you** — 1 member on defunct cwd, dispatch broken");
    expect(out.bullets).toEqual([
      "📍 alpha: cwd /tmp/dead-worktree does not exist",
      "🛠️ fix: re-spawn member or restore worktree path",
    ]);
  });

  test("multiple defunct members surfaced as separate bullets", async () => {
    const { renderWhipDefunctCwd } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipDefunctCwd({
      team: "atmux",
      defunct: [
        { member: "alpha", cwd: "/tmp/a" },
        { member: "bravo", cwd: "/tmp/b" },
      ],
    });
    expect(out.verdict).toContain("2 members on defunct cwd");
    expect(out.bullets).toHaveLength(3); // 2 per-member + 1 fix
  });

  test("whenMs override is propagated", async () => {
    const { renderWhipDefunctCwd } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipDefunctCwd({
      team: "atmux",
      defunct: [{ member: "alpha", cwd: "/x" }],
      whenMs: 9999,
    });
    expect(out.whenMs).toBe(9999);
  });

  test("send-time validation passes", async () => {
    const { renderWhipDefunctCwd, send } = await import("../../../src/abstractions/discord.ts");
    const recorder = join(tmpRoot, "defunct-cwd-record.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderWhipDefunctCwd({
        team: "atmux",
        defunct: [{ member: "alpha", cwd: "/tmp/x" }],
      }),
    );
    const written = await readFile(recorder, "utf8");
    expect(written).toContain("[whip-defunct-cwd]");
    expect(written).toContain("/tmp/x");
  });
});

// ---------- ADR-137 — renderMemberForcePushWarning ----------

describe("renderMemberForcePushWarning", () => {
  test("single member force-push produces verdict + 2 bullets (member + fix)", async () => {
    const { renderMemberForcePushWarning } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const out = renderMemberForcePushWarning({
      team: "atmux",
      events: [
        {
          member: "alice",
          branch: "geoyws-alice",
          reflogMsg: "update by push (forced)",
        },
      ],
    });
    expect(out.template).toBe("member-forcepush-warning");
    expect(out.category).toBe("📋");
    expect(out.team).toBe("atmux");
    // Verdict is warn-class (🟡 Cool) per ADR-137 §D3 — not Need-you.
    expect(out.verdict).toBe(
      "🟡 **Cool** — 1 member force-pushed within the last hour",
    );
    expect(out.bullets).toHaveLength(2);
    expect(out.bullets?.[0]).toBe(
      "🟡 alice: geoyws-alice reflog: update by push (forced)",
    );
    expect(out.bullets?.[1]).toContain("git merge origin/<base>");
    expect(out.bullets?.[1]).toContain("ADR-137");
  });

  test("multiple members surfaced as separate bullets + plural verdict", async () => {
    const { renderMemberForcePushWarning } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const out = renderMemberForcePushWarning({
      team: "atmux",
      events: [
        { member: "alice", branch: "geoyws-alice", reflogMsg: "forced-update" },
        { member: "bob", branch: "geoyws-bob", reflogMsg: "update by push (forced)" },
      ],
    });
    expect(out.verdict).toContain("2 members force-pushed");
    expect(out.bullets).toHaveLength(3); // 2 per-member + 1 fix
  });

  test("long reflog message truncated with ellipsis at 40 chars", async () => {
    const { renderMemberForcePushWarning } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const longMsg =
      "update by push (forced) — bumped past trunk after rebase against geoyws";
    const out = renderMemberForcePushWarning({
      team: "atmux",
      events: [{ member: "alice", branch: "geoyws-alice", reflogMsg: longMsg }],
    });
    const bullet = out.bullets?.[0] ?? "";
    expect(bullet).toContain("…");
    // Bullet format: "🟡 alice: geoyws-alice reflog: <truncated>…"
    // Truncation is on the message body alone (40 chars + ellipsis).
    const reflogPart = bullet.split("reflog: ")[1] ?? "";
    // 40 chars of message + 1 ellipsis = 41 total.
    expect(reflogPart.length).toBe(41);
  });

  test("whenMs override is propagated", async () => {
    const { renderMemberForcePushWarning } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const out = renderMemberForcePushWarning({
      team: "atmux",
      events: [{ member: "alice", branch: "geoyws-alice", reflogMsg: "forced-update" }],
      whenMs: 7777,
    });
    expect(out.whenMs).toBe(7777);
  });

  test("send-time validation passes (full template wiring works end-to-end)", async () => {
    const { renderMemberForcePushWarning, send } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const recorder = join(tmpRoot, "member-forcepush-record.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderMemberForcePushWarning({
        team: "atmux",
        events: [
          { member: "alice", branch: "geoyws-alice", reflogMsg: "update by push (forced)" },
        ],
      }),
    );
    const written = await readFile(recorder, "utf8");
    expect(written).toContain("[member-forcepush-warning]");
    expect(written).toContain("geoyws-alice");
    expect(written).toContain("ADR-137");
  });
});

// ---------- ADR-138 — renderSendKeysFailureWarning ----------

describe("renderSendKeysFailureWarning", () => {
  test("single failure: verdict singular + target bullet + fix bullet", async () => {
    const { renderSendKeysFailureWarning } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const out = renderSendKeysFailureWarning({
      team: "atmux",
      failureCount: 1,
      mostRecentTarget: "atmux-demo:🛠️worker1",
      mostRecentAgeMin: 7,
    });
    expect(out.template).toBe("send-keys-failure");
    expect(out.category).toBe("📋");
    expect(out.team).toBe("atmux");
    expect(out.verdict).toBe(
      "🟡 **Cool** — 1 send-keys failure within the last hour",
    );
    expect(out.bullets).toHaveLength(2);
    expect(out.bullets?.[0]).toBe("🟡 last: atmux-demo:🛠️worker1 (7min ago)");
    expect(out.bullets?.[1]).toContain("ADR-138");
    expect(out.bullets?.[1]).toContain("send-keys-failures.log");
  });

  test("plural verdict when failureCount > 1", async () => {
    const { renderSendKeysFailureWarning } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const out = renderSendKeysFailureWarning({
      team: "atmux",
      failureCount: 4,
      mostRecentTarget: "atmux-demo:lead",
      mostRecentAgeMin: 15,
    });
    expect(out.verdict).toContain("4 send-keys failures");
  });

  test("omitted target → bullet shape collapses (no target row, fix bullet only)", async () => {
    const { renderSendKeysFailureWarning } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const out = renderSendKeysFailureWarning({
      team: "atmux",
      failureCount: 2,
    });
    expect(out.bullets).toHaveLength(1);
    expect(out.bullets?.[0]).toContain("send-keys-failures.log");
  });

  test("target without age suffix → bullet omits the (Nmin ago) tail", async () => {
    const { renderSendKeysFailureWarning } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const out = renderSendKeysFailureWarning({
      team: "atmux",
      failureCount: 1,
      mostRecentTarget: "atmux-demo:lead",
    });
    expect(out.bullets?.[0]).toBe("🟡 last: atmux-demo:lead");
  });

  test("whenMs override is propagated", async () => {
    const { renderSendKeysFailureWarning } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const out = renderSendKeysFailureWarning({
      team: "atmux",
      failureCount: 1,
      whenMs: 8888,
    });
    expect(out.whenMs).toBe(8888);
  });

  test("send-time validation passes (full template wiring works end-to-end)", async () => {
    const { renderSendKeysFailureWarning, send } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const recorder = join(tmpRoot, "send-keys-failure-record.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderSendKeysFailureWarning({
        team: "atmux",
        failureCount: 2,
        mostRecentTarget: "atmux-demo:worker1",
        mostRecentAgeMin: 10,
      }),
    );
    const written = await readFile(recorder, "utf8");
    expect(written).toContain("[send-keys-failure]");
    expect(written).toContain("ADR-138");
  });
});

// ---------- ADR-086 — renderPulseVerdict ----------

describe("renderPulseVerdict", () => {
  test("🟢 Shipping → 💓 category, body verbatim, footer includes commits + window", async () => {
    const { renderPulseVerdict } = await import("../../../src/abstractions/discord.ts");
    const out = renderPulseVerdict({
      team: "atmux",
      verdict: "🟢 Shipping",
      body: "🟢 **Shipping** — 3 commits in 30min, doctor green",
      commitCount: 3,
      inProgressCount: 2,
      driverInboxOpen: 0,
      fireReason: "transition",
      windowMin: 30,
    });
    expect(out.template).toBe("pulse-verdict");
    expect(out.team).toBe("atmux");
    expect(out.category).toBe("💓");
    expect(out.verdict).toContain("🟢 **Shipping**");
    expect(out.footer).toContain("3 commits in 30min");
    expect(out.footer).toContain("2 inProgress");
    expect(out.footer).toContain("fire: transition");
    // No driver-inbox surfacing when count is 0.
    expect(out.footer ?? "").not.toContain("inbox");
  });

  test("🟡 Cool → 📊 category", async () => {
    const { renderPulseVerdict } = await import("../../../src/abstractions/discord.ts");
    const out = renderPulseVerdict({
      team: "atmux",
      verdict: "🟡 Cool",
      body: "🟡 **Cool** — quiet on purpose",
      commitCount: 0,
      inProgressCount: 0,
      driverInboxOpen: 0,
      fireReason: "first-observation",
      windowMin: 30,
    });
    expect(out.category).toBe("📊");
    expect(out.footer).toContain("0 commits in 30min");
  });

  test("🟡 Idle → 📊 category (shared with Cool)", async () => {
    const { renderPulseVerdict } = await import("../../../src/abstractions/discord.ts");
    const out = renderPulseVerdict({
      team: "atmux",
      verdict: "🟡 Idle",
      body: "🟡 **Idle** — 4 task(s) queued, 0 commits in 30min",
      commitCount: 0,
      inProgressCount: 1,
      driverInboxOpen: 0,
      fireReason: "transition",
      windowMin: 30,
    });
    expect(out.category).toBe("📊");
  });

  test("🔴 Stalled → 🛑 category", async () => {
    const { renderPulseVerdict } = await import("../../../src/abstractions/discord.ts");
    const out = renderPulseVerdict({
      team: "atmux",
      verdict: "🔴 Stalled",
      body: "🔴 **Stalled** — 2 in-progress, 0 commits in 30min",
      commitCount: 0,
      inProgressCount: 2,
      driverInboxOpen: 0,
      fireReason: "sustained-urgency",
      windowMin: 30,
    });
    expect(out.category).toBe("🛑");
    expect(out.footer).toContain("fire: sustained-urgency");
  });

  test("🚨 Need you → 🚨 category, inbox count surfaced", async () => {
    const { renderPulseVerdict } = await import("../../../src/abstractions/discord.ts");
    const out = renderPulseVerdict({
      team: "atmux",
      verdict: "🚨 Need you",
      body: "🚨 **Need you** — 2 stale driver-ask(s)",
      commitCount: 0,
      inProgressCount: 0,
      driverInboxOpen: 3,
      fireReason: "transition",
      windowMin: 30,
    });
    expect(out.category).toBe("🚨");
    expect(out.footer).toContain("3 inbox");
  });

  test("whenMs override propagates", async () => {
    const { renderPulseVerdict } = await import("../../../src/abstractions/discord.ts");
    const out = renderPulseVerdict({
      team: "atmux",
      verdict: "🟢 Shipping",
      body: "🟢 **Shipping** — 1 commit in 30min, doctor green",
      commitCount: 1,
      inProgressCount: 0,
      driverInboxOpen: 0,
      fireReason: "first-observation",
      windowMin: 30,
      whenMs: 1_700_000_000_000,
    });
    expect(out.whenMs).toBe(1_700_000_000_000);
  });

  test("send-time validation passes", async () => {
    const { renderPulseVerdict, send } = await import("../../../src/abstractions/discord.ts");
    const recorder = join(tmpRoot, "pulse-record.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderPulseVerdict({
        team: "atmux",
        verdict: "🟢 Shipping",
        body: "🟢 **Shipping** — 3 commits in 30min, doctor green",
        commitCount: 3,
        inProgressCount: 1,
        driverInboxOpen: 0,
        fireReason: "transition",
        windowMin: 30,
      }),
    );
    const written = await readFile(recorder, "utf8");
    expect(written).toContain("[pulse-verdict]");
    expect(written).toContain("3 commits in 30min");
  });
});

// ---------- ADR-085 §Three surfaces #2 — renderWhipNeedsApproval ----------

describe("renderWhipNeedsApproval", () => {
  function adrEntry(
    id: string,
    subject: string,
    ageMin = 60,
  ): {
    id: string;
    subject: string;
    ageMin: number;
  } {
    return { id, subject, ageMin };
  }

  test("renders all three bucket sections when each has entries", () => {
    const out = renderWhipNeedsApproval({
      team: "atmux",
      adr: [adrEntry("085-foo", "ADR-085 needs-approval", 120)],
      inbox: [adrEntry("planner-question", "planner needs answer", 45)],
      kanban: [adrEntry("t-aaaa1111", "long-blocked task", 240)],
    });
    expect(out.template).toBe("whip-needs-approval");
    expect(out.team).toBe("atmux");
    expect(out.category).toBe("📋");
    expect(out.verdict).toContain("3 items awaiting triage");
    const labels = (out.sections ?? []).map((s) => s.label);
    expect(labels).toEqual([
      "📋 **Proposed ADRs (1)**",
      "⏳ **Untriaged asks (1)**",
      "🛑 **Blocked tasks (1)**",
    ]);
  });

  test("singular `1 item` verdict copy when total=1", () => {
    const out = renderWhipNeedsApproval({
      team: "atmux",
      adr: [adrEntry("a", "x", 1)],
      inbox: [],
      kanban: [],
    });
    expect(out.verdict).toContain("1 item awaiting triage");
    expect(out.verdict).not.toContain("1 items");
  });

  test("empty buckets are dropped entirely (no `(0)` waste)", () => {
    const out = renderWhipNeedsApproval({
      team: "atmux",
      adr: [adrEntry("a", "x", 1)],
      inbox: [],
      kanban: [],
    });
    const labels = (out.sections ?? []).map((s) => s.label);
    expect(labels).toEqual(["📋 **Proposed ADRs (1)**"]);
  });

  test("OQ2 hard-cap: 5 per bucket + `+N more` tail", () => {
    const six = Array.from({ length: 6 }, (_, i) => adrEntry(`adr-${i}`, `subject ${i}`, 10 + i));
    const out = renderWhipNeedsApproval({
      team: "atmux",
      adr: six,
      inbox: [],
      kanban: [],
    });
    const bullets = out.sections?.[0]?.bullets ?? [];
    expect(bullets.length).toBe(6); // 5 visible + 1 overflow
    expect(bullets[5]).toBe("📍 +1 more");
  });

  test("exactly 5 entries → no `+0 more` tail", () => {
    const five = Array.from({ length: 5 }, (_, i) => adrEntry(`adr-${i}`, `subject ${i}`, 10));
    const out = renderWhipNeedsApproval({
      team: "atmux",
      adr: five,
      inbox: [],
      kanban: [],
    });
    const bullets = out.sections?.[0]?.bullets ?? [];
    expect(bullets.length).toBe(5);
    for (const b of bullets) {
      expect(b).not.toContain("+0 more");
    }
  });

  test("ageMin compact-duration grammar: <60min → Nmin; ≥60 → HhMm", () => {
    const out = renderWhipNeedsApproval({
      team: "atmux",
      adr: [
        adrEntry("a", "fresh", 47),
        adrEntry("b", "two-hour", 120),
        adrEntry("c", "mixed", 125),
      ],
      inbox: [],
      kanban: [],
    });
    const bullets = out.sections?.[0]?.bullets ?? [];
    expect(bullets[0]).toContain("47min");
    expect(bullets[1]).toContain("2h ");
    expect(bullets[2]).toContain("2h5m");
  });

  test("zero total still produces a valid payload (caller gates emission)", () => {
    const out = renderWhipNeedsApproval({
      team: "atmux",
      adr: [],
      inbox: [],
      kanban: [],
    });
    expect(out.template).toBe("whip-needs-approval");
    expect(out.verdict).toContain("0 items");
    expect(out.sections).toEqual([]);
  });

  test("whenMs threaded through for test injection", () => {
    const out = renderWhipNeedsApproval({
      team: "atmux",
      adr: [adrEntry("a", "x", 1)],
      inbox: [],
      kanban: [],
      whenMs: 1_700_000_000_000,
    });
    expect(out.whenMs).toBe(1_700_000_000_000);
  });
});

// ---------- ADR-077 §F6 — renderSelfHealFailed ----------

describe("renderSelfHealFailed", () => {
  test("renders self-heal-failed template with ABC menu + default deadline", async () => {
    const { renderSelfHealFailed } = await import("../../../src/abstractions/discord.ts");
    // Mon 2026-05-04 03:44 UTC → 11:44 MYT. Default at +30min → 12:14 MYT.
    const whenMs = Date.UTC(2026, 4, 4, 3, 44, 0);
    const out = renderSelfHealFailed({
      team: "atmux",
      symptom: "rotate-lead swallowed under auto-mode",
      attempts: 3,
      members: 12,
      fromAccount: "personal",
      toAccount: "icloud",
      complaintsOpen: 7,
      whipStrikes: 4,
      whenMs,
    });
    expect(out.template).toBe("self-heal-failed");
    expect(out.team).toBe("atmux");
    expect(out.category).toBe("🚨");
    expect(out.whenMs).toBe(whenMs);
    const bullets = out.bullets ?? [];
    expect(bullets).toHaveLength(7);
    expect(bullets[0]).toContain("rotate-lead swallowed under auto-mode");
    expect(bullets[0]).toContain("N=3 attempts");
    expect(bullets[1]).toContain("reply A/B/C");
    expect(bullets[2]).toContain("A) /team stop + start atmux");
    expect(bullets[2]).toContain("12 member(s)");
    expect(bullets[3]).toBe("🔁 B) swap account personal → icloud — wk budget reset");
    expect(bullets[4]).toContain("C) park atmux for the night");
    expect(bullets[5]).toContain("default at 12:14 MYT: A");
    expect(bullets[6]).toBe("📍 7 open · 4 strikes");
  });

  test("nullable account labels collapse to a generic swap line", async () => {
    const { renderSelfHealFailed } = await import("../../../src/abstractions/discord.ts");
    const out = renderSelfHealFailed({
      team: "atmux",
      symptom: "members idle 3h after rebuild",
      attempts: 3,
      members: 8,
      fromAccount: null,
      toAccount: null,
      complaintsOpen: 2,
      whipStrikes: 1,
      whenMs: Date.UTC(2026, 4, 4, 3, 44, 0),
    });
    const bullets = out.bullets ?? [];
    expect(bullets[3]).toBe("🔁 B) swap account — wk budget reset");
  });

  test("whenMs defaults to now() when omitted", async () => {
    const { renderSelfHealFailed } = await import("../../../src/abstractions/discord.ts");
    const before = Date.now();
    const out = renderSelfHealFailed({
      team: "atmux",
      symptom: "test",
      attempts: 4,
      members: 1,
      fromAccount: "a",
      toAccount: "b",
      complaintsOpen: 0,
      whipStrikes: 0,
    });
    const after = Date.now();
    expect(out.whenMs).toBeGreaterThanOrEqual(before);
    expect(out.whenMs as number).toBeLessThanOrEqual(after);
  });

  test("send-time validation passes — bullets carry allowed prefixes", async () => {
    const { renderSelfHealFailed, send } = await import("../../../src/abstractions/discord.ts");
    const recorder = join(tmpRoot, "self-heal-failed-record.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderSelfHealFailed({
        team: "atmux",
        symptom: "kill+respawn welcome-screen-gates",
        attempts: 3,
        members: 5,
        fromAccount: "personal",
        toAccount: "icloud",
        complaintsOpen: 1,
        whipStrikes: 2,
      }),
    );
    const written = await readFile(recorder, "utf8");
    expect(written).toContain("[self-heal-failed]");
    expect(written).toContain("kill+respawn welcome-screen-gates");
  });
});

// ---------- t-351318dc — renderMetaWatchdog ----------

describe("renderMetaWatchdog", () => {
  test("renders meta-watchdog template with A/B menu + dormancy summary", async () => {
    const { renderMetaWatchdog } = await import("../../../src/abstractions/discord.ts");
    // 2026-05-04 03:44 UTC → 11:44 MYT. Default at +30min → 12:14 MYT.
    const whenMs = Date.UTC(2026, 4, 4, 3, 44, 0);
    const out = renderMetaWatchdog({
      cockpit: "atmux_teams",
      openComplaints: 4,
      dormantSec: 3 * 60 * 60, // 3h
      oldestComplaintSummary: "cage cycled itself",
      oldestComplaintTeam: "sopx",
      oldestComplaintAgeSec: 5 * 60 * 60, // 5h
      whenMs,
    });
    expect(out.template).toBe("meta-watchdog");
    expect(out.team).toBe("atmux_teams");
    expect(out.category).toBe("🚨");
    expect(out.whenMs).toBe(whenMs);
    const bullets = out.bullets ?? [];
    expect(bullets).toHaveLength(6);
    expect(bullets[0]).toContain("superdoctor dormant");
    expect(bullets[0]).toContain("4 open complaints");
    expect(bullets[0]).toContain("3h");
    expect(bullets[1]).toContain("reply A/B");
    expect(bullets[2]).toContain("A) check superdoctor pane");
    expect(bullets[3]).toContain("B) restart superdoctor");
    expect(bullets[4]).toContain("default at 12:14 MYT: A");
    expect(bullets[5]).toContain("oldest: sopx");
    expect(bullets[5]).toContain("cage cycled itself");
    expect(bullets[5]).toContain("5h");
  });

  test("cold cockpit (dormantSec=null) reads as 'no attempts on record'", async () => {
    const { renderMetaWatchdog } = await import("../../../src/abstractions/discord.ts");
    const out = renderMetaWatchdog({
      cockpit: "atmux_teams",
      openComplaints: 1,
      dormantSec: null,
      oldestComplaintSummary: "initial complaint",
      oldestComplaintTeam: "atmux",
      oldestComplaintAgeSec: 60 * 60,
      whenMs: Date.UTC(2026, 4, 4, 3, 44, 0),
    });
    const bullets = out.bullets ?? [];
    expect(bullets[0]).toContain("no attempts on record");
  });

  test("whenMs defaults to now() when omitted", async () => {
    const { renderMetaWatchdog } = await import("../../../src/abstractions/discord.ts");
    const before = Date.now();
    const out = renderMetaWatchdog({
      cockpit: "atmux_teams",
      openComplaints: 1,
      dormantSec: 7200,
      oldestComplaintSummary: "test",
      oldestComplaintTeam: "test-team",
      oldestComplaintAgeSec: 7200,
    });
    const after = Date.now();
    expect(out.whenMs).toBeGreaterThanOrEqual(before);
    expect(out.whenMs as number).toBeLessThanOrEqual(after);
  });

  test("send-time validation passes — every bullet carries an allowed prefix", async () => {
    const { renderMetaWatchdog, send } = await import("../../../src/abstractions/discord.ts");
    const recorder = join(tmpRoot, "meta-watchdog-record.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorder;
    await send(
      renderMetaWatchdog({
        cockpit: "atmux_teams",
        openComplaints: 2,
        dormantSec: 4 * 60 * 60,
        oldestComplaintSummary: "stale cage",
        oldestComplaintTeam: "sopx",
        oldestComplaintAgeSec: 6 * 60 * 60,
      }),
    );
    const written = await readFile(recorder, "utf8");
    expect(written).toContain("[meta-watchdog]");
    expect(written).toContain("superdoctor dormant");
  });
});

// ---------- ADR-131 §D5 T5 — renderHygieneBlocker ----------

describe("renderHygieneBlocker — base shape", () => {
  test("emits header (🔧 category) + template literal", () => {
    const out = renderHygieneBlocker({
      team: "sopx",
      taskId: "t-aaaa1111",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "Reassign t-aaaa1111 to fe-1 (lowest-load fe member)",
      superdoctorTick: 42,
      fixesThisTick: 3,
      complaintsFiled: 1,
    });
    expect(out.template).toBe("hygiene-blocker");
    expect(out.team).toBe("sopx");
    expect(out.category).toBe("🔧");
  });

  test("verdict line carries 🔴 Stalled + taskId + duration + class label", () => {
    const out = renderHygieneBlocker({
      team: "sopx",
      taskId: "t-aaaa1111",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "Reassign",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
    });
    expect(out.verdict).toContain("🔴 **Stalled**");
    expect(out.verdict).toContain("`t-aaaa1111`");
    // 240min = 4h exactly per formatDuration.
    expect(out.verdict).toContain("4h");
    expect(out.verdict).toContain("owner not in roster");
  });

  test("whatsNew carries the proposedFix as a single prose-grade bullet", () => {
    const out = renderHygieneBlocker({
      team: "sopx",
      taskId: "t-aaaa1111",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "Reassign t-aaaa1111 to fe-1 (lowest-load fe member)",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
    });
    expect(out.whatsNew).toEqual([
      "Reassign t-aaaa1111 to fe-1 (lowest-load fe member)",
    ]);
  });

  test("footer carries tick number + fixes + complaints counters", () => {
    const out = renderHygieneBlocker({
      team: "sopx",
      taskId: "t-aaaa1111",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "x",
      superdoctorTick: 42,
      fixesThisTick: 3,
      complaintsFiled: 1,
    });
    expect(out.footer).toBe("superdoctor tick #42 · 3 fixes applied · 1 complaints");
  });

  test("no needFromGeorge → no sections (pure-blocker shape)", () => {
    const out = renderHygieneBlocker({
      team: "sopx",
      taskId: "t-aaaa1111",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "x",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
    });
    expect(out.sections).toBeUndefined();
  });

  test("whenMs threaded through for test injection", () => {
    const out = renderHygieneBlocker({
      team: "sopx",
      taskId: "t-aaaa1111",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "x",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
      whenMs: 1_700_000_000_000,
    });
    expect(out.whenMs).toBe(1_700_000_000_000);
  });
});

describe("renderHygieneBlocker — fingerprint-class labels", () => {
  test("every fingerprint class has a distinct human-readable label", () => {
    const labels = new Map<string, string>();
    const classes = [
      "ghost-owner",
      "lane-mismatch",
      "role-mismatch",
      "lane-null-orphan",
      "prio-null",
    ] as const;
    for (const fc of classes) {
      const out = renderHygieneBlocker({
        team: "atmux",
        taskId: "t-x",
        fingerprintClass: fc,
        wedgedMin: 240,
        proposedFix: "x",
        superdoctorTick: 1,
        fixesThisTick: 0,
        complaintsFiled: 0,
      });
      // Strip the leading verdict + duration to get just the label.
      const m = out.verdict?.match(/wedged \S+, (.+)$/);
      expect(m).not.toBeNull();
      const label = m?.[1] ?? "";
      labels.set(fc, label);
    }
    expect(labels.size).toBe(5);
    expect(new Set(labels.values()).size).toBe(5); // all distinct
  });
});

describe("renderHygieneBlocker — wedge-duration formatting", () => {
  test("240min → 4h exact", () => {
    const out = renderHygieneBlocker({
      team: "atmux",
      taskId: "t-x",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "x",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
    });
    expect(out.verdict).toContain("wedged 4h,");
  });

  test("47min → `47min` shape", () => {
    const out = renderHygieneBlocker({
      team: "atmux",
      taskId: "t-x",
      fingerprintClass: "ghost-owner",
      wedgedMin: 47,
      proposedFix: "x",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
    });
    expect(out.verdict).toContain("wedged 47min,");
  });

  test("125min → `2h5m` shape", () => {
    const out = renderHygieneBlocker({
      team: "atmux",
      taskId: "t-x",
      fingerprintClass: "ghost-owner",
      wedgedMin: 125,
      proposedFix: "x",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
    });
    expect(out.verdict).toContain("wedged 2h5m,");
  });
});

describe("renderHygieneBlocker — Need-from-George section", () => {
  test("present needFromGeorge → 🙏 section with question + default-line", () => {
    const out = renderHygieneBlocker({
      team: "atmux",
      taskId: "t-x",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "Reassign",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
      needFromGeorge: {
        question: "no exec-class members on the lane — pick one",
        default: "A) reassign to fe-1 anyway",
        deadline: "16:42 MYT",
      },
    });
    expect(out.sections).toHaveLength(1);
    const sec = out.sections?.[0];
    expect(sec?.label).toBe(
      "🙏 **Need from George** (zero deterministic candidates)",
    );
    expect(sec?.bullets[0]).toBe(
      "🙏 no exec-class members on the lane — pick one",
    );
    expect(sec?.bullets[sec.bullets.length - 1]).toContain(
      "**Default at 16:42 MYT if silent:** A) reassign to fe-1 anyway",
    );
  });

  test("lettered options render as 📍-prefixed bullets between question + default", () => {
    const out = renderHygieneBlocker({
      team: "atmux",
      taskId: "t-x",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "x",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
      needFromGeorge: {
        question: "pick one",
        options: ["A) reassign to fe-1", "B) leave wedged"],
        default: "A) reassign to fe-1",
        deadline: "16:42 MYT",
      },
    });
    const bullets = out.sections?.[0]?.bullets ?? [];
    expect(bullets).toHaveLength(4); // question + 2 options + default-line
    expect(bullets[1]).toBe("📍 A) reassign to fe-1");
    expect(bullets[2]).toBe("📍 B) leave wedged");
  });

  test("no options → only question + default-line render (2 bullets total)", () => {
    const out = renderHygieneBlocker({
      team: "atmux",
      taskId: "t-x",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "x",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
      needFromGeorge: {
        question: "no exec-class members on the lane",
        default: "leave wedged for now",
        deadline: "16:42 MYT",
      },
    });
    const bullets = out.sections?.[0]?.bullets ?? [];
    expect(bullets).toHaveLength(2);
  });
});

// ---------- R10 named-template enforcement ----------
//
// Per CLAUDE.md §Discord: every Discord send is a named template; the
// renderer is the single source of truth for the template literal +
// emoji-prefix vocabulary. These tests assert the contract end-to-end
// against the `validateOpts` validator at send() entry — proving a
// caller can route the renderer's output through send() without a
// validation rejection (mock-recorded, no real webhook).

describe("renderHygieneBlocker — R10 send() round-trip (recorder path)", () => {
  let recorderPath: string;
  let recorderDir: string;

  beforeEach(async () => {
    recorderDir = await mkdtemp(join(tmpdir(), "atmux-hygiene-recorder-"));
    recorderPath = join(recorderDir, "discord.jsonl");
    process.env.ATMUX_DISCORD_RECORDER = recorderPath;
    // Webhook URL is required by send() even on the recorder path.
    process.env.ATMUX_DISCORD_WEBHOOK = "https://recorder.invalid/x";
  });

  afterEach(async () => {
    delete process.env.ATMUX_DISCORD_RECORDER;
    delete process.env.ATMUX_DISCORD_WEBHOOK;
    await rm(recorderDir, { recursive: true, force: true });
  });

  test("renderer output passes validateOpts via send() → recorder receives JSONL", async () => {
    const opts = renderHygieneBlocker({
      team: "sopx",
      taskId: "t-aaaa1111",
      fingerprintClass: "ghost-owner",
      wedgedMin: 240,
      proposedFix: "Reassign t-aaaa1111 to fe-1 (lowest-load)",
      superdoctorTick: 42,
      fixesThisTick: 3,
      complaintsFiled: 1,
      needFromGeorge: {
        question: "no exec-class members on lane — pick one",
        options: ["A) reassign to fe-1", "B) leave wedged"],
        default: "A) reassign to fe-1",
        deadline: "16:42 MYT",
      },
      whenMs: 1_700_000_000_000,
    });
    await send(opts);
    const log = await readFile(recorderPath, "utf8");
    // Recorder captures the rendered chunk content (header + body),
    // not the structured template metadata — assert against the
    // header's `[hygiene-blocker]` literal + team + verdict-line
    // root-cause label.
    expect(log).toContain("[hygiene-blocker]");
    expect(log).toContain("sopx");
    expect(log).toContain("owner not in roster");
  });

  test("renderer output without needFromGeorge passes validateOpts (whatsNew satisfies non-empty body)", async () => {
    const opts = renderHygieneBlocker({
      team: "sopx",
      taskId: "t-x",
      fingerprintClass: "lane-mismatch",
      wedgedMin: 300,
      proposedFix: "set task lane = test (owner's natural lane)",
      superdoctorTick: 1,
      fixesThisTick: 0,
      complaintsFiled: 0,
    });
    await send(opts);
    const log = await readFile(recorderPath, "utf8");
    // Recorder captures rendered content — assert against label
    // surface ("owner lane ≠ task lane") which is the lane-mismatch
    // class's verdict-line root-cause clause.
    expect(log).toContain("owner lane");
  });
});

// ---------- renderMemberRefusalRotate — ADR-139 T4 ----------

describe("renderMemberRefusalRotate (ADR-139 T4)", () => {
  test("escalation='rotate' renders 🟡 verdict + 🔄 category", () => {
    const opts = renderMemberRefusalRotate({
      team: "demo",
      member: "alice",
      severity: "soft",
      eventCount: 3,
      windowMin: 30,
      rotationsToday: 1,
      maxRotationsPerDay: 3,
      escalation: "rotate",
      topPhrases: ["fatigue", "tired-of"],
      whenMs: 1_700_000_000_000,
    });
    expect(opts.template).toBe("member-refusal-rotate");
    expect(opts.category).toBe("🔄");
    expect(opts.verdict).toContain("🟡");
    expect(opts.verdict).toContain("alice");
    expect(opts.verdict).toContain("soft");
    expect(opts.verdict).toContain("3 events");
    const bullets = (opts.bullets ?? []) as string[];
    // Trigger phrases surface as 📋 bullets — assert presence.
    expect(bullets.some((b) => b.includes("fatigue"))).toBe(true);
    // Footer carries rotation counter.
    expect(bullets[bullets.length - 1]).toContain("1/3");
  });

  test("escalation='cap-hit' renders 🚨 verdict + 🚨 category", () => {
    const opts = renderMemberRefusalRotate({
      team: "demo",
      member: "bob",
      severity: "hard",
      eventCount: 4,
      windowMin: 30,
      rotationsToday: 3,
      maxRotationsPerDay: 3,
      escalation: "cap-hit",
      topPhrases: [],
    });
    expect(opts.category).toBe("🚨");
    expect(opts.verdict).toContain("🚨");
    expect(opts.verdict).toContain("cap-hit");
    expect(opts.verdict).toContain("3/3");
    const bullets = (opts.bullets ?? []) as string[];
    // HARD path includes a 'Need from George' bullet.
    expect(bullets.some((b) => b.includes("Need from George"))).toBe(true);
  });

  test("escalation='spawn-failed' renders 🚨 + verdict naming the failure", () => {
    const opts = renderMemberRefusalRotate({
      team: "demo",
      member: "carol",
      severity: "role",
      eventCount: 1,
      windowMin: 30,
      rotationsToday: 1,
      maxRotationsPerDay: 3,
      escalation: "spawn-failed",
      topPhrases: [],
    });
    expect(opts.category).toBe("🚨");
    expect(opts.verdict).toContain("spawn FAILED");
    expect(opts.verdict).toContain("role-class");
  });

  test("single-event verbiage drops the plural 's' on event count", () => {
    const opts = renderMemberRefusalRotate({
      team: "demo",
      member: "dave",
      severity: "role",
      eventCount: 1,
      windowMin: 30,
      rotationsToday: 1,
      maxRotationsPerDay: 3,
      escalation: "rotate",
      topPhrases: [],
    });
    expect(opts.verdict).toContain("1 event in");
    expect(opts.verdict).not.toContain("1 events");
  });

  test("empty topPhrases skips the 📋 trigger bullets but keeps footer", () => {
    const opts = renderMemberRefusalRotate({
      team: "demo",
      member: "eve",
      severity: "soft",
      eventCount: 3,
      windowMin: 30,
      rotationsToday: 1,
      maxRotationsPerDay: 3,
      escalation: "rotate",
      topPhrases: [],
    });
    const bullets = (opts.bullets ?? []) as string[];
    expect(bullets.some((b) => b.startsWith("📋"))).toBe(false);
    expect(bullets[bullets.length - 1]).toContain("rotations today");
  });
});
