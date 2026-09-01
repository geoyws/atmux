// Unit tests for src/core/vox/token-budget.ts — ADR-273 §Supplement
// `token_budget`.
//
// The four properties these tests exist to hold, in the order they cost
// the most if they break:
//
//   1. `usedPercent` is percent CONSUMED and is never inverted. 97 means
//      97 gone. The rendered line carries the word "consumed".
//   2. A `rejected` or `error:*` row is capacity LOSS, so the overall
//      verdict can never be healthy while one exists.
//   3. A cached row is labelled cached WITH its age, and is never
//      described as a live measurement.
//   4. Nothing credential-shaped reaches the rendered output — and the
//      test for that plants a control value first, so the check is known
//      to be capable of detecting one.
//
// Clock is injected everywhere. No subprocess, no network, no filesystem.

import { describe, expect, test } from "bun:test";
import {
  BUDGET_PROVIDERS,
  type BudgetRow,
  type BudgetRowClass,
  classifyBudgetRow,
  isCachedRow,
  parseBudgetRows,
  REDACTED,
  redactSecrets,
  renderBudgetReport,
  rowCacheAgeSec,
  speakDuration,
  speakReset,
  speakRowIdentity,
  speakWindow,
  summarizeBudget,
} from "../../../../src/core/vox/token-budget.ts";

/** Fixed clock. 1700000000 = 2023-11-14T22:13:20Z. */
const NOW = 1_700_000_000;

/** Row builder. Defaults are a healthy LIVE Claude 5h bucket. */
function row(over: Partial<BudgetRow> = {}): BudgetRow {
  return {
    provider: "claude",
    account: "gmail",
    bucket: "5h",
    usedPercent: 12,
    windowMinutes: 300,
    resetsAt: NOW + 3600,
    status: "allowed",
    source: "live",
    observedAt: NOW,
    ...over,
  } as BudgetRow;
}

function ndjson(rows: BudgetRow[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

// ---------- Parsing ----------

describe("parseBudgetRows", () => {
  test("reads the probe's real NDJSON shape, field for field", () => {
    // Verbatim from `probe-budgets.sh --json --cache-only` on hax.
    const line =
      '{"provider":"claude","account":"aix","bucket":"7d","usedPercent":97.00,' +
      '"windowMinutes":10080,"resetsAt":1787068800,"status":"warning","source":"cache",' +
      '"observedAt":1786935601,"cacheAgeSec":493}';
    const { rows, malformed } = parseBudgetRows(line);
    expect(malformed).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("claude");
    expect(rows[0]?.account).toBe("aix");
    expect(rows[0]?.usedPercent).toBe(97);
    expect(rows[0]?.windowMinutes).toBe(10080);
    expect(rows[0]?.resetsAt).toBe(1787068800);
    expect(rows[0]?.status).toBe("warning");
    expect(rows[0]?.cacheAgeSec).toBe(493);
  });

  test("null-valued numeric fields survive as null, not as 0", () => {
    // The Kimi / z.ai shape. Coercing these to 0 would render as "0%
    // consumed" — a number nobody measured, heard as headroom.
    const line =
      '{"provider":"kimi","account":"current","bucket":"account","usedPercent":null,' +
      '"windowMinutes":null,"resetsAt":null,"status":"error:token_expired","source":"live",' +
      '"observedAt":1786935601,"note":"Quota usage API unavailable"}';
    const { rows } = parseBudgetRows(line);
    expect(rows[0]?.usedPercent).toBeNull();
    expect(rows[0]?.resetsAt).toBeNull();
    expect(rows[0]?.note).toBe("Quota usage API unavailable");
  });

  test("blank lines are not malformed; garbage lines are COUNTED", () => {
    const text = `${JSON.stringify(row())}\n\nnot json at all\n{"provider":"x"}\n`;
    const { rows, malformed } = parseBudgetRows(text);
    expect(rows).toHaveLength(1);
    // One unparseable line + one line that parses as JSON but is not a
    // row. Both must be counted, or a half-broken probe reads as a
    // short clean run.
    expect(malformed).toBe(2);
  });

  test("an unknown extra field does not reject the row", () => {
    const { rows, malformed } = parseBudgetRows(JSON.stringify({ ...row(), someFutureField: "x" }));
    expect(malformed).toBe(0);
    expect(rows).toHaveLength(1);
  });

  test("empty input yields no rows and no malformed count", () => {
    expect(parseBudgetRows("")).toEqual({ rows: [], malformed: 0 });
  });
});

// ---------- Classification ----------

describe("classifyBudgetRow", () => {
  test.each([
    ["allowed", "ok"],
    ["warning", "warning"],
    ["rejected", "lost"],
    ["error:token_invalid", "lost"],
    ["error:token_expired", "lost"],
    ["error:http_500", "lost"],
    ["error:network_or_timeout", "lost"],
    ["unavailable", "unmeasured"],
    ["unavailable:no_api_key", "unmeasured"],
    ["unavailable:no_credentials", "unmeasured"],
    ["allowed_no_quota_api", "unmeasured"],
  ])("status %p classifies as %p", (status, expected) => {
    expect(classifyBudgetRow(row({ status }))).toBe(expected as BudgetRowClass);
  });

  test("Kimi's allowed_no_quota_api is UNMEASURED, not ok", () => {
    // It starts with "allowed", so a prefix match would call it healthy
    // headroom. It is not: Kimi exposes credential validity and no
    // quota number at all.
    expect(classifyBudgetRow(row({ provider: "kimi", status: "allowed_no_quota_api" }))).toBe(
      "unmeasured",
    );
  });
});

// ---------- Summary ----------

describe("summarizeBudget", () => {
  test("all allowed → ok", () => {
    const s = summarizeBudget(parseBudgetRows(ndjson([row(), row({ bucket: "7d" })])), NOW);
    expect(s.ok).toBe(true);
    expect(s.okCount).toBe(2);
    expect(s.lost).toBe(0);
    expect(s.cached).toBe(false);
  });

  test("ONE rejected row makes the whole report not-ok", () => {
    const s = summarizeBudget(
      parseBudgetRows(ndjson([row(), row({ status: "rejected", usedPercent: 100 })])),
      NOW,
    );
    expect(s.ok).toBe(false);
    expect(s.lost).toBe(1);
    expect(s.okCount).toBe(1);
  });

  test("ONE error:* row makes the whole report not-ok", () => {
    const s = summarizeBudget(
      parseBudgetRows(ndjson([row(), row({ status: "error:token_invalid", usedPercent: null })])),
      NOW,
    );
    expect(s.ok).toBe(false);
    expect(s.lost).toBe(1);
  });

  test("a warning row is not-ok but is not counted as lost", () => {
    const s = summarizeBudget(parseBudgetRows(ndjson([row({ status: "warning" })])), NOW);
    expect(s.ok).toBe(false);
    expect(s.warning).toBe(1);
    expect(s.lost).toBe(0);
  });

  test("only-unmeasured rows are not ok — nothing measured is not headroom", () => {
    const s = summarizeBudget(
      parseBudgetRows(ndjson([row({ provider: "kimi", status: "allowed_no_quota_api" })])),
      NOW,
    );
    expect(s.ok).toBe(false);
    expect(s.unmeasured).toBe(1);
    expect(s.okCount).toBe(0);
  });

  test("malformed probe lines make the report not-ok", () => {
    // Output we could not read is capacity we cannot vouch for.
    const s = summarizeBudget(parseBudgetRows(`${JSON.stringify(row())}\nbroken\n`), NOW);
    expect(s.ok).toBe(false);
    expect(s.malformed).toBe(1);
  });

  test("cache age reported is the OLDEST cached row's", () => {
    const s = summarizeBudget(
      parseBudgetRows(
        ndjson([
          row({ source: "cache", cacheAgeSec: 120 }),
          row({ source: "cache", cacheAgeSec: 900 }),
        ]),
      ),
      NOW,
    );
    expect(s.cached).toBe(true);
    expect(s.cacheAgeSec).toBe(900);
  });

  test("a live-only report reports no cache age", () => {
    const s = summarizeBudget(parseBudgetRows(ndjson([row()])), NOW);
    expect(s.cached).toBe(false);
    expect(s.cacheAgeSec).toBeNull();
  });
});

describe("isCachedRow / rowCacheAgeSec", () => {
  test("source=cache is cached; source=live is not", () => {
    expect(isCachedRow(row({ source: "cache" }))).toBe(true);
    expect(isCachedRow(row({ source: "live" }))).toBe(false);
  });

  test("the probe's own cacheAgeSec wins over a derived age", () => {
    const r = row({ source: "cache", cacheAgeSec: 493, observedAt: NOW - 99999 });
    expect(rowCacheAgeSec(r, NOW)).toBe(493);
  });

  test("age derives from observedAt when the probe supplied none", () => {
    expect(rowCacheAgeSec(row({ source: "cache", observedAt: NOW - 600 }), NOW)).toBe(600);
  });

  test("a future observedAt clamps to 0 rather than reporting a negative age", () => {
    expect(rowCacheAgeSec(row({ source: "cache", observedAt: NOW + 500 }), NOW)).toBe(0);
  });
});

// ---------- Reset times ----------

describe("speakReset — exact, or admitted absent", () => {
  test("a future reset renders the exact UTC stamp AND the distance", () => {
    expect(speakReset(row({ resetsAt: NOW + 3600 }), NOW)).toBe(
      "resets 2023-11-14 23:13 UTC, in 1h",
    );
  });

  test("a reset 2h15m out renders both parts", () => {
    expect(speakReset(row({ resetsAt: NOW + 8100 }), NOW)).toBe(
      "resets 2023-11-15 00:28 UTC, in 2h15m",
    );
  });

  test("a past reset says so rather than reading as time remaining", () => {
    expect(speakReset(row({ resetsAt: NOW - 3600 }), NOW)).toBe(
      "resets 2023-11-14 21:13 UTC, which was 1h ago",
    );
  });

  test("null resetsAt is ADMITTED, never inferred from the window length", () => {
    // The probe prints `-`. A confidently-wrong "resets in about 5
    // hours", extrapolated from windowMinutes, is worse than silence.
    const r = row({ resetsAt: null, windowMinutes: 300 });
    const out = speakReset(r, NOW);
    expect(out).toBe("reset time not reported");
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(out).not.toContain("in ");
  });

  test("a zero resetsAt is treated as absent, not as 1970", () => {
    expect(speakReset(row({ resetsAt: 0 }), NOW)).toBe("reset time not reported");
  });
});

describe("speakWindow", () => {
  test.each([
    [10080, "7d"],
    [300, "5h"],
    [1440, "1d"],
    [120, "2h"],
    [45, "45m"],
  ])("%p minutes → %p", (minutes, expected) => {
    expect(speakWindow(row({ windowMinutes: minutes }))).toBe(expected);
  });

  test("a null window falls back to the bucket name the probe gave", () => {
    expect(speakWindow(row({ windowMinutes: null, bucket: "codex:primary" }))).toBe(
      "codex:primary",
    );
  });
});

describe("speakRowIdentity — two budgets must never sound identical", () => {
  test("a bucket that IS the window label is not repeated", () => {
    expect(speakRowIdentity(row({ bucket: "5h", windowMinutes: 300 }))).toBe("claude gmail 5h");
  });

  test("Codex's two 7d budgets are distinguishable, not both 'codex pro 7d'", () => {
    // Real probe output: `codex:primary` (rejected) and
    // `GPT-5.3-Codex-Spark:primary` (allowed) share the 7d window. If
    // these collapse to one string, the operator hears the same budget
    // reported both at capacity and fine.
    const a = speakRowIdentity(
      row({ provider: "codex", account: "pro", bucket: "codex:primary", windowMinutes: 10080 }),
    );
    const b = speakRowIdentity(
      row({
        provider: "codex",
        account: "pro",
        bucket: "GPT-5.3-Codex-Spark:primary",
        windowMinutes: 10080,
      }),
    );
    expect(a).toBe("codex pro 7d codex:primary");
    expect(b).toBe("codex pro 7d GPT-5.3-Codex-Spark:primary");
    expect(a).not.toBe(b);
  });

  test("the rendered report keeps the two Codex budgets apart", () => {
    const out = renderBudgetReport(
      parseBudgetRows(
        ndjson([
          row({
            provider: "codex",
            account: "pro",
            bucket: "codex:primary",
            windowMinutes: 10080,
            usedPercent: 100,
            status: "rejected",
          }),
          row({
            provider: "codex",
            account: "pro",
            bucket: "GPT-5.3-Codex-Spark:primary",
            windowMinutes: 10080,
            usedPercent: 0,
            status: "allowed",
          }),
        ]),
      ),
      NOW,
    );
    expect(out).toContain("codex pro 7d codex:primary — AT CAPACITY");
    expect(out).toContain("codex pro 7d GPT-5.3-Codex-Spark:primary — ok");
  });
});

describe("speakDuration", () => {
  test.each([
    [0, "0s"],
    [45, "45s"],
    [90, "2m"],
    [3600, "1h"],
    [8100, "2h15m"],
  ])("%p seconds → %p", (sec, expected) => {
    expect(speakDuration(sec)).toBe(expected);
  });
});

// ---------- Rendering ----------

describe("renderBudgetReport — consumed, never remaining", () => {
  test("a healthy live report says LIVE and renders each figure as CONSUMED", () => {
    const out = renderBudgetReport(parseBudgetRows(ndjson([row({ usedPercent: 12 })])), NOW);
    expect(out.split("\n")[0]).toBe("BUDGET: LIVE. all 1 measured budgets have headroom.");
    expect(out).toContain("claude gmail 5h — ok, 12% consumed");
    // The inversion this guards: 12% consumed must never be spoken as
    // 88, and the word "remaining" must not attach to the number.
    expect(out).not.toContain("88");
    expect(out).not.toMatch(/12% (remaining|left|available)/);
  });

  test("97% consumed renders as 97, not as 3", () => {
    const out = renderBudgetReport(
      parseBudgetRows(ndjson([row({ usedPercent: 97, status: "warning" })])),
      NOW,
    );
    expect(out).toContain("97% consumed");
    expect(out).not.toContain("3% consumed");
  });

  test("a warning row renders WARNING in the headline and on the line", () => {
    const out = renderBudgetReport(
      parseBudgetRows(ndjson([row(), row({ bucket: "7d", usedPercent: 94, status: "warning" })])),
      NOW,
    );
    expect(out).toContain("BUDGET: LIVE. 1 of 2 in the warning band.");
    expect(out).toContain("— WARNING, 94% consumed");
  });

  test("a rejected row makes the headline say NOT HEALTHY and names the count", () => {
    const out = renderBudgetReport(
      parseBudgetRows(
        ndjson([
          row(),
          row({
            provider: "codex",
            account: "pro",
            bucket: "codex:primary",
            windowMinutes: 10080,
            usedPercent: 100,
            status: "rejected",
            note: "rate_limit_reached",
          }),
        ]),
      ),
      NOW,
    );
    expect(out.split("\n")[0]).toBe("BUDGET: LIVE. 1 of 2 at capacity or unusable — not healthy.");
    expect(out).toContain("codex pro 7d codex:primary — AT CAPACITY, 100% consumed");
    expect(out).toContain("(rate_limit_reached)");
    // The whole point: it must not read as an all-clear.
    expect(out).not.toContain("have headroom");
  });

  test("an error:* row is capacity loss, and its status is named", () => {
    const out = renderBudgetReport(
      parseBudgetRows(
        ndjson([
          row({
            account: "icloud",
            bucket: "account",
            usedPercent: null,
            windowMinutes: null,
            resetsAt: null,
            status: "error:token_invalid",
          }),
        ]),
      ),
      NOW,
    );
    expect(out).toContain("at capacity or unusable — not healthy");
    expect(out).toContain("claude icloud account — AT CAPACITY");
    expect(out).toContain("[error:token_invalid]");
    // No usage figure existed, so none may be invented.
    expect(out).toContain("usage not reported");
    expect(out).toContain("reset time not reported");
  });

  test("worst-first ordering: the broken row is spoken before the fine one", () => {
    const out = renderBudgetReport(
      parseBudgetRows(
        ndjson([
          row({ account: "fine" }),
          row({ account: "broken", status: "rejected", usedPercent: 100 }),
        ]),
      ),
      NOW,
    );
    const lines = out.split("\n");
    const brokenAt = lines.findIndex((l) => l.includes("broken"));
    const fineAt = lines.findIndex((l) => l.includes("fine"));
    expect(brokenAt).toBeGreaterThan(0);
    expect(brokenAt).toBeLessThan(fineAt);
  });
});

describe("renderBudgetReport — cached is never described as live", () => {
  test("headline states CACHED with the age BEFORE any number", () => {
    const out = renderBudgetReport(
      parseBudgetRows(ndjson([row({ source: "cache", cacheAgeSec: 493 })])),
      NOW,
    );
    const head = out.split("\n")[0] ?? "";
    expect(head).toContain("CACHED snapshot 8m old — not a live reading.");
    expect(head).not.toContain("LIVE");
    // Freshness precedes the verdict in the sentence, so an operator
    // cannot form a belief before hearing the caveat.
    expect(head.indexOf("CACHED")).toBeLessThan(head.indexOf("headroom"));
  });

  test("EVERY cached row carries its own age marker", () => {
    const out = renderBudgetReport(
      parseBudgetRows(
        ndjson([
          row({ source: "cache", cacheAgeSec: 60 }),
          row({ bucket: "7d", source: "cache", cacheAgeSec: 60 }),
        ]),
      ),
      NOW,
    );
    const rows = out.split("\n").slice(1);
    expect(rows).toHaveLength(2);
    for (const line of rows) {
      expect(line).toContain("[CACHED 1m ago — not a live reading]");
    }
  });

  test("a live row carries NO cached marker", () => {
    const out = renderBudgetReport(parseBudgetRows(ndjson([row({ source: "live" })])), NOW);
    expect(out).not.toContain("CACHED");
  });
});

describe("renderBudgetReport — unmeasured is never zero", () => {
  test("Kimi renders UNAVAILABLE with its note, and never a 0% figure", () => {
    const out = renderBudgetReport(
      parseBudgetRows(
        ndjson([
          row({
            provider: "kimi",
            account: "current",
            bucket: "quota",
            usedPercent: null,
            windowMinutes: null,
            resetsAt: null,
            status: "allowed_no_quota_api",
            note: "Credential valid; Vivace; quota reset unavailable",
          }),
        ]),
      ),
      NOW,
    );
    expect(out).toContain("kimi current quota — UNAVAILABLE, no usage figure");
    expect(out).toContain("Credential valid; Vivace; quota reset unavailable");
    // The failure this pins: reporting an unmeasured quota as 0%
    // consumed, which an operator hears as "plenty left".
    expect(out).not.toContain("0% consumed");
    expect(out).not.toContain("100% consumed");
  });

  test("the headline counts unmeasured rows as unknown, in words", () => {
    const out = renderBudgetReport(
      parseBudgetRows(ndjson([row(), row({ provider: "zai", status: "unavailable:no_api_key" })])),
      NOW,
    );
    expect(out).toContain("1 unmeasured (counted as unknown, not as free)");
  });
});

describe("renderBudgetReport — nothing readable", () => {
  test("zero rows and malformed lines render UNKNOWN, never an all-clear", () => {
    const out = renderBudgetReport(parseBudgetRows("garbage\nmore garbage\n"), NOW);
    expect(out).toBe(
      "BUDGET: UNKNOWN — the probe emitted 2 unreadable line(s). Treat headroom as unverified.",
    );
  });

  test("zero rows with no garbage still renders UNKNOWN", () => {
    const out = renderBudgetReport(parseBudgetRows(""), NOW);
    expect(out).toContain("BUDGET: UNKNOWN");
    expect(out).toContain("the probe returned no rows");
  });

  test("some good rows plus a malformed line reports BOTH", () => {
    const out = renderBudgetReport(parseBudgetRows(`${JSON.stringify(row())}\nbroken\n`), NOW);
    expect(out).toContain("1 unreadable probe line(s)");
    expect(out).toContain("claude gmail 5h — ok");
  });
});

// ---------- Secrets ----------

describe("redactSecrets", () => {
  // Every case is asserted POSITIVELY — the planted value must be gone
  // AND the marker present — so a regex that silently stopped matching
  // could not pass by leaving the input untouched.
  test.each([
    ["sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "an sk- API key"],
    [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      "a JWT",
    ],
    ["Bearer abcdefghijklmnopqrstuvwxyz0123456789", "a Bearer header"],
    ["ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "a GitHub token"],
    ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "a bare 44-char opaque run"],
  ])("masks %p (%s)", (secret) => {
    const out = redactSecrets(`note: ${secret} end`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  test("ordinary probe prose passes through UNCHANGED", () => {
    // The control that proves redaction is not just blanking everything.
    // If this ever starts failing, the masking is too aggressive and the
    // "no secret present" assertions below would be passing vacuously.
    const prose = "Credential valid; Vivace; quota reset unavailable";
    expect(redactSecrets(prose)).toBe(prose);
    expect(redactSecrets("rate_limit_reached")).toBe("rate_limit_reached");
    expect(redactSecrets("error:http_429")).toBe("error:http_429");
    expect(redactSecrets("claude ifca-sauching 7d")).toBe("claude ifca-sauching 7d");
  });
});

describe("renderBudgetReport — no credential reaches the spoken output", () => {
  const PLANTED = "sk-ant-oat01-DEADBEEFDEADBEEFDEADBEEFDEADBEEF";

  test("CONTROL: a benign note IS rendered verbatim", () => {
    // This runs first and must pass, or the leak assertions below prove
    // nothing: if `note` were simply never printed, "the secret is
    // absent" would be true for the wrong reason.
    const out = renderBudgetReport(
      parseBudgetRows(ndjson([row({ note: "canary-note-visible" })])),
      NOW,
    );
    expect(out).toContain("canary-note-visible");
  });

  test("a token planted in `note` is masked in the rendered output", () => {
    const out = renderBudgetReport(
      parseBudgetRows(ndjson([row({ note: `refresh failed for ${PLANTED}` })])),
      NOW,
    );
    expect(out).not.toContain(PLANTED);
    expect(out).not.toContain("DEADBEEF");
    expect(out).toContain(REDACTED);
    // The surrounding prose survives, so we know the note was rendered
    // and the token specifically was removed.
    expect(out).toContain("refresh failed for");
  });

  test("a token planted in `status` is masked too", () => {
    const out = renderBudgetReport(
      parseBudgetRows(ndjson([row({ status: `error:${PLANTED}` })])),
      NOW,
    );
    expect(out).not.toContain(PLANTED);
    expect(out).toContain(REDACTED);
  });

  test("a token planted in `account` is masked in the identity prefix", () => {
    const out = renderBudgetReport(parseBudgetRows(ndjson([row({ account: PLANTED })])), NOW);
    expect(out).not.toContain(PLANTED);
    expect(out).toContain(REDACTED);
  });
});

// ---------- Provider list ----------

describe("BUDGET_PROVIDERS", () => {
  test("matches the probe script's own accepted set", () => {
    expect([...BUDGET_PROVIDERS]).toEqual(["all", "codex", "claude", "zai", "kimi"]);
  });
});
