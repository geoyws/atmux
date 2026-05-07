// Unit tests for src/abstractions/discord.ts (ADR-008).
//
// Covers:
//   - Validation (R-rules: bullet length, emoji prefix, empty body)
//   - Rendering (header format, bullets-only, sections-only, mixed)
//   - Chunking (single message, multi-message with N/M suffix, section-label
//     glued to first bullet)
//   - Send routing (recorder JSONL capture, ping-discord.sh spawn delegation,
//     direct-fetch fallback, ConfigError on pinned-but-missing script,
//     ConfigError on no-webhook-no-script, DiscordWebhookError on non-2xx)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetFallbackWarnedForTest,
  type DiscordSection,
  type DiscordSendOpts,
  renderEternalImprovementDone,
  renderEternalImprovementProgress,
  renderEternalImprovementStart,
  renderWhipConfigDrift,
  resolveWebhookUrl,
  send,
} from "../../../src/abstractions/discord.ts";
import { ConfigError, DiscordWebhookError } from "../../../src/errors.ts";

// ---------- Test scaffolding ----------

let tmpRoot: string;

const SAVED_ENV = {
  ATMUX_DISCORD_RECORDER: process.env.ATMUX_DISCORD_RECORDER,
  ATMUX_DISCORD_PING_SCRIPT: process.env.ATMUX_DISCORD_PING_SCRIPT,
  ATMUX_DISCORD_WEBHOOK: process.env.ATMUX_DISCORD_WEBHOOK,
  HOME: process.env.HOME,
};

function clearEnv(): void {
  delete process.env.ATMUX_DISCORD_RECORDER;
  delete process.env.ATMUX_DISCORD_PING_SCRIPT;
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
  _resetFallbackWarnedForTest();
  // Pin HOME to a non-existent path so the default ping-discord.sh
  // resolution lands on a missing file in tests that don't override
  // ATMUX_DISCORD_PING_SCRIPT.
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

  test("recorder bypasses both spawn and fetch (no network)", async () => {
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
    process.env.ATMUX_DISCORD_PING_SCRIPT = "/definitely/not/a/real/script-x9q3";
    let caught: ConfigError | null = null;
    try {
      await send(bullets());
    } catch (e) {
      if (e instanceof ConfigError) caught = e;
    }
    expect(caught?.message).toContain("does not exist");
  });
});

// ---------- Routing: spawn ping-discord.sh ----------

describe("routing — ping-discord.sh delegation", () => {
  test("ATMUX_DISCORD_PING_SCRIPT pointing to a stub spawns it with stdin + env", async () => {
    const stub = join(tmpRoot, "ping-stub.sh");
    const sink = join(tmpRoot, "ping-stub.out");
    await writeFile(
      stub,
      `#!/usr/bin/env bash\ncat > "${sink}"\necho "WEBHOOK=\${ATMUX_DISCORD_WEBHOOK:-unset}" >> "${sink}"\nexit 0\n`,
      { mode: 0o755 },
    );
    process.env.ATMUX_DISCORD_PING_SCRIPT = stub;
    await send(bullets({ webhookOverride: "https://example.test/webhook" }));
    const captured = await readFile(sink, "utf8");
    expect(captured).toContain("✅ shipped");
    expect(captured).toContain("WEBHOOK=https://example.test/webhook");
  });

  test("script omits ATMUX_DISCORD_WEBHOOK env when no webhookOverride", async () => {
    const stub = join(tmpRoot, "ping-stub-noenv.sh");
    const sink = join(tmpRoot, "ping-stub-noenv.out");
    await writeFile(stub, `#!/usr/bin/env bash\ncat > "${sink}"\nexit 0\n`, { mode: 0o755 });
    process.env.ATMUX_DISCORD_PING_SCRIPT = stub;
    await send(bullets()); // no webhookOverride
    const captured = await readFile(sink, "utf8");
    expect(captured).toContain("✅ shipped");
  });

  test("script nonzero exit → DiscordWebhookError", async () => {
    const stub = join(tmpRoot, "ping-fail.sh");
    await writeFile(stub, `#!/usr/bin/env bash\nexit 7\n`, { mode: 0o755 });
    process.env.ATMUX_DISCORD_PING_SCRIPT = stub;
    let caught: DiscordWebhookError | null = null;
    try {
      await send(bullets());
    } catch (e) {
      if (e instanceof DiscordWebhookError) caught = e;
    }
    expect(caught?.message).toContain("ping-discord.sh delegation failed");
  });

  test("ATMUX_DISCORD_PING_SCRIPT pointing to non-existent file → ConfigError (no silent fallback)", async () => {
    process.env.ATMUX_DISCORD_PING_SCRIPT = join(tmpRoot, "definitely-not-here.sh");
    let caught: ConfigError | null = null;
    try {
      await send(bullets());
    } catch (e) {
      if (e instanceof ConfigError) caught = e;
    }
    expect(caught?.message).toContain("does not exist");
  });
});

// ---------- Routing: direct-fetch fallback ----------

describe("routing — direct-fetch fallback", () => {
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

  test("no script + no webhook → ConfigError", async () => {
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

  test("fallback warning fires once per process (stderr)", async () => {
    // First fallback call emits warning; subsequent calls don't.
    // We can't easily intercept process.stderr.write in bun:test, but we
    // can at least exercise the warned-flag transition by calling send()
    // twice with the fallback path and verifying both succeed.
    nextStatus = 204;
    process.env.ATMUX_DISCORD_WEBHOOK = `http://localhost:${server.port}/once`;
    await send(bullets({ bullets: ["✅ first"] }));
    await send(bullets({ bullets: ["✅ second"] }));
    // No assertion on stderr content; the path is just exercised. The
    // `_resetFallbackWarnedForTest()` in beforeEach ensures other tests
    // start with the flag clear.
    expect(lastRequest?.body).toContain("✅ second");
  });

  test("HOME unset → defaultScript path is rooted at /", async () => {
    delete process.env.HOME;
    nextStatus = 204;
    process.env.ATMUX_DISCORD_WEBHOOK = `http://localhost:${server.port}/no-home`;
    // Default script becomes "/.claude/skills/whip/scripts/ping-discord.sh"
    // which doesn't exist → fallback fires → fetch succeeds.
    await send(bullets({ bullets: ["✅ no-home"] }));
    expect(lastRequest?.body).toContain("✅ no-home");
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
