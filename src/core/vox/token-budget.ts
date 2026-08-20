// ADR-273 §Supplement: `token_budget` — provider/account quota headroom,
// rendered to be HEARD.
//
// ---------------------------------------------------------------------
// It reuses the maintained probe; it does not reimplement four providers
// ---------------------------------------------------------------------
//
// The budget skill's `probe-budgets.sh` already knows every provider's
// quirks: Codex's rate-limit JSON, Claude's five OAuth response headers
// (and the refresh dance behind them), Z.ai's quota windows, and Kimi's
// lack of a quota API at all. Re-deriving that here would give atmux a
// second, worse copy that drifts the first time a provider changes a
// header. This module SPEAKS the probe's NDJSON; the probe stays the
// authority on how to get it.
//
// ---------------------------------------------------------------------
// Four rules that keep the spoken answer honest
// ---------------------------------------------------------------------
//
// 1. `usedPercent` is percent CONSUMED. It is never inverted, and every
//    rendered number carries the word "consumed" so the operator cannot
//    mishear it as headroom. 97 means 97 gone, 3 left.
//
// 2. A reset time is reported EXACTLY or not at all. When the probe says
//    `resetsAt: null` the line says the reset time is not reported —
//    it never guesses one from the window length, because a confidently
//    wrong "resets in about an hour" is worse than an honest silence.
//
// 3. A `rejected` or `error:*` row is CAPACITY LOSS. The overall verdict
//    can never be healthy while one exists — see {@link summarizeBudget}.
//    An account whose token is invalid is an account you do not have.
//
// 4. Cached is not live. `--cache-only` rows carry `source: "cache"` and
//    a `cacheAgeSec`; both the headline and the row say so, with the age.
//    A stale snapshot described as a measurement is the same lie as an
//    unreachable host described as healthy.
//
// Kimi is the standing case for rule 3's softer half: it exposes
// credential validity but no quota-usage API, so it reports as
// UNAVAILABLE (unmeasured), never as 0% consumed. Zero would read as
// "plenty left" about a number nobody measured.
//
// ---------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------
//
// The probe is careful never to emit a token; {@link redactSecrets} is
// the belt to that braces, applied to every free-text field before it
// reaches the rendered output. It exists because `note` and `status` are
// pass-through strings — if a future probe branch ever interpolates a
// URL or an auth header into one, the leak would be silent otherwise.

import { z } from "zod";

// ---------- Providers ----------

/** Providers `probe-budgets.sh` accepts. Declared HERE, in core, because
 *  the voice catalog derives its `provider` enum from it and core must
 *  never import from `src/verbs/**` (ADR-272 D2). */
export const BUDGET_PROVIDERS = Object.freeze([
  "all",
  "codex",
  "claude",
  "zai",
  "kimi",
] as const);

export type BudgetProvider = (typeof BUDGET_PROVIDERS)[number];

// ---------- Probe row schema ----------

/** One NDJSON row from `probe-budgets.sh --json`.
 *
 *  `.passthrough()` is deliberate: the probe may grow fields, and a
 *  strict schema would turn a harmless addition into a parse failure
 *  that reads to the operator as "budget unknown". */
export const BudgetRowSchema = z
  .object({
    provider: z.string().min(1),
    account: z.string().min(1),
    bucket: z.string().min(1),
    usedPercent: z.number().nullable(),
    windowMinutes: z.number().nullable(),
    resetsAt: z.number().nullable(),
    status: z.string().min(1),
    source: z.string().min(1),
    observedAt: z.number(),
    note: z.string().optional(),
    cacheAgeSec: z.number().optional(),
  })
  .passthrough();

export type BudgetRow = z.infer<typeof BudgetRowSchema>;

/** Outcome of reading the probe's NDJSON. */
export interface BudgetParse {
  rows: BudgetRow[];
  /** Lines that were not a valid row. COUNTED, never silently dropped —
   *  a probe half-emitting garbage must not read as a short clean run. */
  malformed: number;
}

/** Parse NDJSON. Blank lines are not malformed; anything else that fails
 *  the schema is. */
export function parseBudgetRows(ndjson: string): BudgetParse {
  const rows: BudgetRow[] = [];
  let malformed = 0;
  for (const line of ndjson.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const parsed = BudgetRowSchema.safeParse(raw);
    if (parsed.success) rows.push(parsed.data);
    else malformed += 1;
  }
  return { rows, malformed };
}

// ---------- Secret redaction ----------

/** Replacement for anything that looks like a credential. */
export const REDACTED = "[redacted]";

/**
 * Mask credential-shaped substrings.
 *
 * Ordered most-specific first so a `Bearer <jwt>` masks as one unit
 * rather than leaving the scheme word orphaned. The final rule — any
 * opaque run of 40+ token characters — is the backstop that catches a
 * shape nobody enumerated; provider names, account labels, bucket names
 * and the probe's own prose are all far shorter than that, so it costs
 * the legitimate output nothing.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/\b(?:Bearer|Basic|token|api[_-]?key)\s+\S{12,}/gi, REDACTED)
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abps])[-_][A-Za-z0-9_-]{12,}/g, REDACTED)
    .replace(/[A-Za-z0-9_-]{40,}/g, REDACTED);
}

// ---------- Classification ----------

/** What a row means for available capacity. */
export type BudgetRowClass =
  /** Under the warning band. */
  | "ok"
  /** In the warning band (probe's own 80% line). */
  | "warning"
  /** Capacity is GONE — quota exhausted or the credential does not work. */
  | "lost"
  /** Nothing was measured. Never counted as headroom. */
  | "unmeasured";

/** Classify one row by its probe status. See rule 3 in the file header. */
export function classifyBudgetRow(row: BudgetRow): BudgetRowClass {
  const s = row.status;
  if (s === "rejected") return "lost";
  if (s.startsWith("error:")) return "lost";
  if (s === "warning") return "warning";
  if (s === "allowed") return "ok";
  // `allowed_no_quota_api` (Kimi) and every `unavailable*` variant: the
  // credential may be fine, but no usage number exists. Unmeasured.
  return "unmeasured";
}

/** Fold rows into one verdict. */
export interface BudgetSummary {
  /** True ONLY when nothing is lost, nothing is in warning, and at least
   *  one row was actually measured. */
  ok: boolean;
  lost: number;
  warning: number;
  unmeasured: number;
  okCount: number;
  /** Any row served from the cache rather than measured live. */
  cached: boolean;
  /** Age of the oldest cached row, seconds. `null` when nothing cached. */
  cacheAgeSec: number | null;
  /** Lines the parser could not read. */
  malformed: number;
}

/** Is this row a cached snapshot rather than a live measurement? */
export function isCachedRow(row: BudgetRow): boolean {
  return row.source === "cache" || typeof row.cacheAgeSec === "number";
}

/** Cache age for a row: the probe's own `cacheAgeSec` when present,
 *  else derived from `observedAt`. */
export function rowCacheAgeSec(row: BudgetRow, nowSec: number): number {
  if (typeof row.cacheAgeSec === "number") return Math.max(0, Math.round(row.cacheAgeSec));
  return Math.max(0, Math.round(nowSec - row.observedAt));
}

/** Fold rows + parse residue into the overall verdict. */
export function summarizeBudget(parse: BudgetParse, nowSec: number): BudgetSummary {
  let lost = 0;
  let warning = 0;
  let unmeasured = 0;
  let okCount = 0;
  let cacheAgeSec: number | null = null;
  let cached = false;
  for (const row of parse.rows) {
    switch (classifyBudgetRow(row)) {
      case "lost":
        lost += 1;
        break;
      case "warning":
        warning += 1;
        break;
      case "unmeasured":
        unmeasured += 1;
        break;
      default:
        okCount += 1;
    }
    if (isCachedRow(row)) {
      cached = true;
      const age = rowCacheAgeSec(row, nowSec);
      if (cacheAgeSec === null || age > cacheAgeSec) cacheAgeSec = age;
    }
  }
  return {
    // `malformed` counts against health too: output we could not read is
    // capacity we cannot vouch for.
    ok: lost === 0 && warning === 0 && parse.malformed === 0 && okCount > 0,
    lost,
    warning,
    unmeasured,
    okCount,
    cached,
    cacheAgeSec,
    malformed: parse.malformed,
  };
}

// ---------- Rendering ----------

/** Seconds → a spoken duration. */
export function speakDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
}

/** Window minutes → the label the probe's own table uses. */
export function speakWindow(row: BudgetRow): string {
  const m = row.windowMinutes;
  if (m === null || !Number.isFinite(m) || m <= 0) return row.bucket;
  if (m === 10080) return "7d";
  if (m === 300) return "5h";
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

/**
 * Reset time, EXACTLY or not at all (rule 2).
 *
 * Renders the absolute UTC stamp — the exact value the probe reported —
 * plus how far away it is, because "resets in 2h14m" is the half an
 * operator can act on without doing timezone arithmetic aloud.
 */
export function speakReset(row: BudgetRow, nowSec: number): string {
  const at = row.resetsAt;
  if (at === null || !Number.isFinite(at) || at <= 0) return "reset time not reported";
  const iso = new Date(at * 1000).toISOString();
  const stamp = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  const delta = at - nowSec;
  if (delta >= 0) return `resets ${stamp}, in ${speakDuration(delta)}`;
  return `resets ${stamp}, which was ${speakDuration(-delta)} ago`;
}

/**
 * How a row identifies itself aloud.
 *
 * The window label alone is NOT enough: Codex reports two distinct
 * budgets (`codex:primary` and `GPT-5.3-Codex-Spark:primary`) that share
 * the same 7d window, so `provider account window` rendered both as
 * "codex pro 7d" — one AT CAPACITY and one fine, spoken back to back and
 * indistinguishable. Observed on the real probe output, not imagined.
 * The bucket is appended whenever it is not already the window label.
 */
export function speakRowIdentity(row: BudgetRow): string {
  const window = speakWindow(row);
  const base = `${row.provider} ${row.account} ${window}`;
  return row.bucket === window ? base : `${base} ${row.bucket}`;
}

/** One row's line. */
function renderRow(row: BudgetRow, nowSec: number): string {
  const who = redactSecrets(speakRowIdentity(row));
  const cls = classifyBudgetRow(row);
  const cachedSuffix = isCachedRow(row)
    ? ` [CACHED ${speakDuration(rowCacheAgeSec(row, nowSec))} ago — not a live reading]`
    : "";
  const note = typeof row.note === "string" && row.note !== "" ? ` (${redactSecrets(row.note)})` : "";
  const status = redactSecrets(row.status);

  if (cls === "unmeasured") {
    // Never "0% consumed" — nothing was measured, and a zero would be
    // heard as headroom. This is the Kimi case.
    return `${who} — UNAVAILABLE, no usage figure: ${status}${note}${cachedSuffix}`;
  }
  const used = row.usedPercent;
  const consumed =
    used === null || !Number.isFinite(used)
      ? "usage not reported"
      : `${Math.round(used)}% consumed`;
  const verdict = cls === "lost" ? "AT CAPACITY" : cls === "warning" ? "WARNING" : "ok";
  const reset = speakReset(row, nowSec);
  return `${who} — ${verdict}, ${consumed}, ${reset} [${status}]${note}${cachedSuffix}`;
}

/**
 * Render the whole budget report as speakable lines.
 *
 * The headline leads with capacity LOSS when there is any, and states
 * the cached-ness before any number — an operator who hears the numbers
 * first has already formed a belief by the time the caveat arrives.
 */
export function renderBudgetReport(parse: BudgetParse, nowSec: number): string {
  const s = summarizeBudget(parse, nowSec);
  if (parse.rows.length === 0) {
    const why =
      s.malformed > 0
        ? `the probe emitted ${s.malformed} unreadable line(s)`
        : "the probe returned no rows";
    return `BUDGET: UNKNOWN — ${why}. Treat headroom as unverified.`;
  }
  const freshness = s.cached
    ? `CACHED snapshot ${speakDuration(s.cacheAgeSec ?? 0)} old — not a live reading. `
    : "LIVE. ";
  const head =
    s.lost > 0
      ? `BUDGET: ${freshness}${s.lost} of ${parse.rows.length} at capacity or unusable — not healthy.`
      : s.warning > 0
        ? `BUDGET: ${freshness}${s.warning} of ${parse.rows.length} in the warning band.`
        : s.okCount > 0
          ? `BUDGET: ${freshness}all ${s.okCount} measured budgets have headroom.`
          : `BUDGET: ${freshness}nothing measurable.`;
  const tail: string[] = [];
  if (s.unmeasured > 0) tail.push(`${s.unmeasured} unmeasured (counted as unknown, not as free)`);
  if (s.malformed > 0) tail.push(`${s.malformed} unreadable probe line(s)`);
  const headline = tail.length > 0 ? `${head} Also: ${tail.join("; ")}.` : head;

  // Worst first — the operator hears what is broken before what is fine.
  const rank: Record<BudgetRowClass, number> = { lost: 0, warning: 1, unmeasured: 2, ok: 3 };
  const ordered = [...parse.rows].sort(
    (a, b) => rank[classifyBudgetRow(a)] - rank[classifyBudgetRow(b)],
  );
  return [headline, ...ordered.map((r) => renderRow(r, nowSec))].join("\n");
}
