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
