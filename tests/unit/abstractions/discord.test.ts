// Unit tests for src/abstractions/discord.ts (ADR-008).
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
  renderWhipBudgetPause,
  renderWhipBudgetRefreshSoon,
  renderWhipBudgetResume,
  renderWhipBudgetWarning,
  renderWhipConfigDrift,
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
// dropped in favour of bun-native fetch — see ADR-008 §"Routing".)

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
    const bullets = out.bullets ?? [];
    // First bullet — headline.
    expect(bullets[0]).toContain("validation failed");
    expect(bullets[0]).toContain("safe defaults");
    // Issues count + by-code summary.
    expect(bullets[1]).toContain("issues: 2");
    expect(bullets[1]).toContain("invalid_type");
    expect(bullets[1]).toContain("unrecognized_keys");
    // First-issue surfacing.
    expect(bullets.some((b) => b.includes("whip.budgetPauseTreshold"))).toBe(true);
    // Fix hint.
    expect(bullets.some((b) => b.includes("edit team.json"))).toBe(true);
    // Drift hash truncated to 8 chars in display.
    expect(bullets.some((b) => b.includes("a3f2c814"))).toBe(true);
  });

  test("catastrophic flag flips the headline to malformed-JSON variant", () => {
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
    expect(out.bullets?.[0]).toContain("malformed");
    expect(out.bullets?.[0]).toContain("full safe defaults");
  });

  test("zero-issues input still renders headline + fix bullet", () => {
    const out = renderWhipConfigDrift({
      team: "atmux",
      driftHash: "00000000",
      issues: [],
      catastrophic: false,
    });
    const bullets = out.bullets ?? [];
    expect(bullets[1]).toContain("issues: 0");
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
    expect(out.bullets).toEqual([
      "🪫 team paused — 2 at-risk member(s)",
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
    await send(renderWhipBudgetPause({
      team: "atmux",
      atRisk: [{ member: "alpha", h5: 95, wk: 80 }],
      resumeThresholdPct: 20,
      whenMs: FIXED_TS,
    }));
    const calls = await readJsonl<{ payload: { content: string } }>(recorder);
    expect(calls.length).toBe(1);
    const c = calls[0]?.payload.content ?? "";
    expect(c.startsWith("🛑 **[whip-budget-pause]** · `atmux` · 11:44 MYT")).toBe(true);
  });
});

describe("renderWhipBudgetResume", () => {
  test("builds the brief 2-bullet body with category 🚀", () => {
    const out = renderWhipBudgetResume({
      team: "atmux", resumeThresholdPct: 20, whenMs: FIXED_TS,
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
      team: "atmux", account: "icloud", window: "wk",
      remainingPct: 12, band: 0.15, resetIn: "3d4h",
      affectedMembers: 2,
    });
    expect(out.bullets?.[0]).toContain("remaining wk: 12%");
  });
});

describe("renderWhipBudgetRefreshSoon", () => {
  test("builds 3-bullet body with paused-now hint when active", () => {
    const out = renderWhipBudgetRefreshSoon({
      team: "atmux", account: "icloud", window: "5h",
      resetsIn: "28min", remainingPct: 8, pausedNow: true,
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
      team: "atmux", account: "icloud", window: "wk",
      resetsIn: "1h", remainingPct: 18, pausedNow: false,
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
    expect(out.bullets?.[2]).toBe(
      "📍 fallback: keeping `up-impl` on `icloud` (will hit pause)",
    );
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
    expect(out.bullets?.[2]).toBe(
      "💰 budget on icloud post-pass: 76% used (no longer pinned)",
    );
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
    const bullets = out.bullets ?? [];
    expect(bullets[0]).toContain("2 member(s) stalled");
    expect(bullets[0]).toContain("5min"); // formatDuration(300_000)
    expect(bullets.some((b) => b.includes("alice:") && b.includes("10min"))).toBe(true);
    expect(bullets.some((b) => b.includes("bob: never stale"))).toBe(true);
    expect(bullets.some((b) => b.includes("fix:"))).toBe(true);
  });

  test("zero stale → headline says 0 member(s) (degenerate but rendered)", async () => {
    const { renderWhipWatchdog } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipWatchdog({
      team: "atmux",
      stale: [],
      staleSec: 300,
    });
    expect(out.bullets?.[0]).toContain("0 member(s) stalled");
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
    const { renderWhipSelfHealAttempt } = await import(
      "../../../src/abstractions/discord.ts"
    );
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
    const { renderWhipSelfHealAttempt } = await import(
      "../../../src/abstractions/discord.ts"
    );
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
    const { renderWhipSelfHealAttempt } = await import(
      "../../../src/abstractions/discord.ts"
    );
    const out = renderWhipSelfHealAttempt({
      team: "atmux",
      recipeId: "fix:cron-pollution",
      reason: "stale block detected",
      tokenCap: 5000,
      whenMs: 1_700_000_000_000,
    });
    expect(out.whenMs).toBe(1_700_000_000_000);
  });

  test("renderer output passes send-time validation (bullets non-empty + emoji prefix)",
    async () => {
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
  test("success variant — patch staged + tokens + summary + log",
    async () => {
    const { renderWhipSelfHealResult } = await import(
      "../../../src/abstractions/discord.ts"
    );
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

  test("failure variant — first reason + tail count + log + flag",
    async () => {
    const { renderWhipSelfHealResult } = await import(
      "../../../src/abstractions/discord.ts"
    );
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

  test("failure variant with multiple reasons appends '(N more)' suffix",
    async () => {
    const { renderWhipSelfHealResult } = await import(
      "../../../src/abstractions/discord.ts"
    );
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

  test("failure variant falls back to patchSummary when reasons empty",
    async () => {
    const { renderWhipSelfHealResult } = await import(
      "../../../src/abstractions/discord.ts"
    );
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

  test("failure variant defaults severity to p2 when flagSeverity omitted",
    async () => {
    const { renderWhipSelfHealResult } = await import(
      "../../../src/abstractions/discord.ts"
    );
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

  test("tokensUsed -1 (parse failure) renders as '?'",
    async () => {
    const { renderWhipSelfHealResult } = await import(
      "../../../src/abstractions/discord.ts"
    );
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

  test("whenMs override propagates",
    async () => {
    const { renderWhipSelfHealResult } = await import(
      "../../../src/abstractions/discord.ts"
    );
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

  test("success-variant output passes send-time validation",
    async () => {
    const { renderWhipSelfHealResult, send } = await import(
      "../../../src/abstractions/discord.ts"
    );
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

  test("failure-variant output passes send-time validation",
    async () => {
    const { renderWhipSelfHealResult, send } = await import(
      "../../../src/abstractions/discord.ts"
    );
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
  test("single drifted member produces 3 bullets in canonical order", async () => {
    const { renderWhipPermModeDrift } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipPermModeDrift({
      team: "atmux",
      drifted: [{ member: "alpha", mode: "dont-ask" }],
    });
    expect(out.template).toBe("whip-perm-mode-drift");
    expect(out.category).toBe("📋");
    expect(out.team).toBe("atmux");
    expect(out.bullets).toEqual([
      "📍 1 member(s) drifted off auto mode",
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
    expect(out.bullets).toHaveLength(4);
    expect((out.bullets ?? [])[0]).toBe("📍 2 member(s) drifted off auto mode");
    expect((out.bullets ?? [])[1]).toContain("alpha");
    expect((out.bullets ?? [])[2]).toContain("bravo");
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
  test("single defunct member produces 3 bullets in canonical order", async () => {
    const { renderWhipDefunctCwd } = await import("../../../src/abstractions/discord.ts");
    const out = renderWhipDefunctCwd({
      team: "atmux",
      defunct: [{ member: "alpha", cwd: "/tmp/dead-worktree" }],
    });
    expect(out.template).toBe("whip-defunct-cwd");
    expect(out.category).toBe("🛑");
    expect(out.team).toBe("atmux");
    expect(out.bullets).toEqual([
      "🛑 1 member(s) on defunct cwd — pane_current_path missing on disk",
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
    expect(out.bullets).toHaveLength(4);
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
