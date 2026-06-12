// IssueTracker — the vendor-agnostic external issue-tracker seam (ADR-261).
//
// An external tracker (GitHub Issues, Azure DevOps work items) is a polled
// REST surface behind this uniform programmatic interface — atmux ingests
// issues as complaints (ADR-261 §D3) and the target team's lead adjudicates
// them per ADR-214, exactly like every other complaint source. Mirrors the
// AgentBackend house pattern (ADR-258 §D2; `src/abstractions/agent-backend.ts`).
//
// This file is types-only — the interface plus the in-process value shapes it
// trades in. Adapters implement it under `src/abstractions/trackers/<id>.ts`:
//   - `github` (ADR-261 Phase 1) wraps the GitHub REST API.
//   - `azure-devops` (Phase 2) wraps the Azure DevOps REST API.
//   - Jira et al are future adapters of the same interface — no interface
//     change anticipated (ADR-261 §Out-of-scope).
//
// Two ADR-261 invariants pinned here:
//   - Consumers see only NORMALIZED values — provider-native frames never
//     leak past the adapter (§D2, same rule as ADR-258's AgentEvent union).
//   - All adapter HTTP goes through `src/abstractions/http.ts` (§D1) — no
//     raw `fetch`, no `gh`/`az` CLI shell-outs.

/**
 * Known adapter ids (ADR-261 §D2). Each concrete adapter carries a stable
 * `readonly id` from this set; the config allowlist (`team.json::issueSync`,
 * §D10) is constrained to it. Future trackers (e.g. "jira") extend the union
 * when their adapter lands — no other interface change.
 */
export type TrackerId = "github" | "azure-devops";

/**
 * The frozen 1:1 sourceId-prefix ↔ adapter-id mapping, pinned in Phase 0 per
 * ADR-261 §D3: the prefix is NOT required to equal the adapter id
 * (`azure-devops` adapter → `ado:` prefix), but no adapter may mint a second
 * prefix and no prefix may map to two adapters. Type-level only — Phase 1
 * adapters derive their canonical `sourceId` strings from this contract:
 *   - `github`       → `github:owner/repo#123`
 *   - `azure-devops` → `ado:org/project/42`
 */
export type SourceIdPrefixByTrackerId = {
  readonly github: "github";
  readonly "azure-devops": "ado";
};

/**
 * Per-adapter scope string — which slice of the tracker to poll:
 * `'owner/repo'` (github) | `'org/project'` (azure-devops). Scopes come from
 * the `team.json::issueSync` allowlist (ADR-261 §D7.2) — there is no
 * "discover everything the token can see" mode.
 */
export type TrackerScope = string;

/** Normalized upstream issue state (ADR-261 §D2). Adapters map their
 *  provider-native state vocabularies (GitHub open/closed, ADO's New /
 *  Active / Resolved / Closed / Removed) onto this binary — the ledger's
 *  sync-state matrix (§D4) keys on it. */
export type IssueState = "open" | "closed";

/**
 * Normalized external issue — adapters map their provider-native payloads
 * (GitHub REST issue objects, ADO work-item JSON) onto this shape. Consumers
 * (the issue_sync ledger reconcile, `fileDedupedComplaint` intake, event
 * payloads) see only normalized issues, so every adapter satisfies one
 * contract (ADR-261 §D2).
 */
export interface NormalizedIssue {
  /** Owning adapter's stable id (for routing + observability). */
  readonly trackerId: string;
  /**
   * Canonical external identity (ADR-261 §D3): `github:owner/repo#123`,
   * `ado:org/project/42` — prefix per {@link SourceIdPrefixByTrackerId}.
   * One string format, used identically as the complaints-row `sourceId`
   * (dedup key), the issue_sync ledger PK (§D4), and in event payloads.
   */
  readonly sourceId: string;
  /** Human-facing issue URL (rides in the complaint's `extra` bag). */
  readonly url: string;
  /** Issue title. UNTRUSTED input (§D7) — truncate + sanitize before any
   *  tell-lead line; never forward verbatim into inbox prose. */
  readonly title: string;
  /** Issue body, or `null` when the tracker has none. UNTRUSTED input
   *  (§D7): attacker-controllable text on a path that terminates in a
   *  lead's inbox — it rides only in the complaint's `extra` bag, read
   *  deliberately via `atmux complaints show`, never injected into the
   *  tell-lead message. */
  readonly body: string | null;
  /** Normalized upstream state — drives the §D4 sync-state matrix
   *  (auto-resolve on close, re-surface on reopen). */
  readonly state: IssueState;
  /** Upstream label names (input to the §D10 label→severity map). */
  readonly labels: readonly string[];
  /** Upstream assignee login/display-name, or `null` when unassigned. */
  readonly assignee: string | null;
  /** Upstream author login/display-name, or `null` when the tracker
   *  doesn't expose one. */
  readonly author: string | null;
  /** Upstream creation time, epoch seconds. */
  readonly createdAtSec: number;
  /** Upstream last-modified time, epoch seconds — the §D4 matrix's
   *  "newer updatedAt ⇒ refresh extra, no new row, no new tell-lead"
   *  comparator. */
  readonly updatedAtSec: number;
  /**
   * Provider-specific passthrough — anything normalized fields don't carry
   * (milestone, work-item type, reactions, …). Forward-compat only:
   * consumers MUST NOT make load-bearing reads of `extra` keys — that
   * would leak provider frames past the adapter, the exact coupling §D2
   * exists to prevent.
   */
  readonly extra: Readonly<Record<string, unknown>>;
}

/**
 * One page of a paginated issue listing. `nextCursor` is an OPAQUE
 * adapter-owned resume token (GitHub page link / ADO continuation token —
 * never parsed by consumers); `null` means the listing is exhausted.
 * Callers checkpoint the cursor per page (ADR-261 §D4): orchd ticks are
 * hard-killed at `ATMUX_ORCHD_TICK_TIMEOUT_SECS`, so a killed paginating
 * sync must RESUME from the last checkpoint, not restart.
 */
export interface IssueTrackerPage {
  readonly issues: readonly NormalizedIssue[];
  readonly nextCursor: string | null;
}

/** Options for one {@link IssueTracker.listIssues} page fetch. */
export interface ListIssuesOptions {
  /** Which repo/project to poll (see {@link TrackerScope}). Always from
   *  the `team.json::issueSync` allowlist (ADR-261 §D7.2). */
  readonly scope: TrackerScope;
  /** Opaque resume token from a prior page's `nextCursor`. Omit (or pass
   *  `null`) to start from the beginning of the listing. */
  readonly cursor?: string | null;
  /** Only issues with upstream `updatedAt` ≥ this epoch-second watermark.
   *  Omit for a full walk (first sync / cursor reset). */
  readonly sinceSec?: number;
  /** Page-size hint. Adapters clamp to their provider's maximum; omit for
   *  the adapter default. */
  readonly pageSize?: number;
}

/**
 * The vendor-agnostic tracker interface (ADR-261 §D2). Every adapter
 * implements it; the sync engine (ledger reconcile → `fileDedupedComplaint`
 * → lead routing) is expressed purely in terms of these verbs plus
 * {@link NormalizedIssue} — provider-native shapes stay inside the adapter.
 */
export interface IssueTracker {
  /** Stable id for this adapter ("github", "azure-devops", ...). */
  readonly id: string;

  /**
   * Fetch one page of issues in `opts.scope`, newest-change-first where the
   * provider allows. Read-only (v1 has no write path — upstream write-back
   * is Phase 3 / deferred, ADR-261 §D11).
   */
  listIssues(opts: ListIssuesOptions): Promise<IssueTrackerPage>;

  /**
   * Fetch a single issue by its canonical external id (the §D3 `sourceId`
   * format, e.g. `github:owner/repo#123`). Resolves `null` when the issue
   * does not exist or the token cannot read it — adapters do not throw on
   * not-found (the §D4 pending-repair path probes ids that may be gone).
   */
  getIssue(externalId: string): Promise<NormalizedIssue | null>;
}

/**
 * Where an adapter's API token comes from — the house 3-tier cascade
 * (ADR-261 §D7.4; pattern: `resolveWebhookUrl`,
 * `src/abstractions/discord.ts`). Resolution order, first hit wins:
 *
 *   1. env var named by `envVar` (e.g. `ATMUX_GITHUB_TOKEN` /
 *      `ATMUX_ADO_TOKEN`);
 *   2. `teamJsonToken` — a token literal carried in `team.json`;
 *   3. the file `${XDG_CONFIG_HOME:-~/.config}/atmux/<configFileBasename>`
 *      (e.g. `github-token`), contents trimmed.
 *
 * Two §D7 rules bind every consumer of this shape:
 *   - tokens are READ-ONLY scoped (GitHub: fine-grained token with
 *     read-only Issues permission — classic tokens discouraged; ADO:
 *     work-items read). v1 has no write path to protect (§D7.3).
 *   - tokens NEVER appear on argv — tmux pane capture records command
 *     lines, and pane-state redaction is observability, not a security
 *     boundary. Env or config file only (§D7.5).
 */
export interface TrackerAuthConfig {
  /** Tier 1 — environment variable name to consult first. */
  readonly envVar: string;
  /** Tier 2 — token literal from `team.json`, when the operator chose to
   *  carry it there. Optional; prefer tiers 1/3 for anything shared. */
  readonly teamJsonToken?: string;
  /** Tier 3 — file basename under `${XDG_CONFIG_HOME:-~/.config}/atmux/`. */
  readonly configFileBasename: string;
}
