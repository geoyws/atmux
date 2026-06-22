// IssueTracker — the vendor-agnostic external issue-tracker seam.
//
// Re-pointed by ADR-263 §D3: this seam (originally ADR-261) survives the
// great simplification; its DOWNSTREAM changed. The old contract was
// `poll → complaint → lead adjudication`; the new contract is
// `poll → upsert Task` (feed-only — no complaints, no Honker, no lead,
// no auto-dispatch). The ingestion shapes below are unchanged: an
// external tracker (GitHub Issues today; Azure DevOps work items later)
// is a polled REST surface behind this uniform programmatic interface.
//
// This file is types-only — the interface plus the in-process value shapes
// it trades in. Adapters implement it under `src/abstractions/trackers/<id>.ts`:
//   - `github` (Phase 1 / ADR-263 P3) wraps the GitHub REST API.
//   - `azure-devops` (later) wraps the Azure DevOps REST API.
//   - Jira et al are future adapters of the same interface — no interface
//     change anticipated.
//
// Two invariants pinned here:
//   - Consumers see only NORMALIZED values — provider-native frames never
//     leak past the adapter (§D2).
//   - All adapter HTTP goes through `src/abstractions/http.ts` (§D1) — no
//     raw `fetch`, no `gh`/`az` CLI shell-outs.

/**
 * Known adapter ids. Each concrete adapter carries a stable `readonly id`
 * from this set; the `team.json::taskSources` config (ADR-263 §D3) is
 * constrained to it. Future trackers (e.g. "jira") extend the union when
 * their adapter lands — no other interface change.
 */
export type TrackerId = "github" | "azure-devops";

/**
 * The frozen 1:1 sourceId-prefix ↔ adapter-id mapping: the prefix is NOT
 * required to equal the adapter id (`azure-devops` adapter → `ado:`
 * prefix), but no adapter may mint a second prefix and no prefix may map
 * to two adapters. Type-level only — adapters derive their canonical
 * `sourceId` strings from this contract:
 *   - `github`       → `github:owner/repo#123`
 *   - `azure-devops` → `ado:org/project/42`
 */
export type SourceIdPrefixByTrackerId = {
  readonly github: "github";
  readonly "azure-devops": "ado";
};

/**
 * Per-adapter scope string — which slice of the tracker to poll:
 * `'owner/repo'` (github) | `'org/project'` (azure-devops). Scopes come
 * from the `team.json::taskSources` config (ADR-263 §D3) — there is no
 * "discover everything the token can see" mode.
 */
export type TrackerScope = string;

/** Normalized upstream issue state. Adapters map their provider-native
 *  state vocabularies (GitHub open/closed; ADO's New / Active / Resolved /
 *  Closed / Removed) onto this binary. */
export type IssueState = "open" | "closed";

/**
 * Normalized external issue — adapters map their provider-native payloads
 * (GitHub REST issue objects, ADO work-item JSON) onto this shape.
 * Consumers (the sync engine that upserts tasks) see only normalized
 * issues, so every adapter satisfies one contract (§D2).
 */
export interface NormalizedIssue {
  /** Owning adapter's stable id (for routing + observability). */
  readonly trackerId: string;
  /**
   * Canonical external identity (§D3): `github:owner/repo#123`,
   * `ado:org/project/42` — prefix per {@link SourceIdPrefixByTrackerId}.
   * Used as the Task row's `sourceId` (the dedup key — re-polls update,
   * never duplicate).
   */
  readonly sourceId: string;
  /** Human-facing issue URL (carried into the Task body). */
  readonly url: string;
  /** Issue title → Task subject. UNTRUSTED input (§D3 prompt-injection
   *  note) — a Claude pane will read it; treat as data, not instructions. */
  readonly title: string;
  /** Issue body, or `null` when the tracker has none. UNTRUSTED input
   *  (§D3): attacker-controllable text on a path that terminates in a
   *  task body a Claude pane reads. Fenced + labelled as untrusted by the
   *  sync engine before it lands in the Task body; never executed. */
  readonly body: string | null;
  /** Normalized upstream state — drives the close-reconciliation path
   *  (onClose: "done" when upstream closes; ADR-263 §D3). */
  readonly state: IssueState;
  /** Upstream label names (the `team.json::taskSources` label filter
   *  matches against these). */
  readonly labels: readonly string[];
  /** Upstream assignee login/display-name, or `null` when unassigned. */
  readonly assignee: string | null;
  /** Upstream author login/display-name, or `null` when the tracker
   *  doesn't expose one. */
  readonly author: string | null;
  /** Upstream creation time, epoch seconds. */
  readonly createdAtSec: number;
  /** Upstream last-modified time, epoch seconds — the sync watermark
   *  comparator (only re-fetch issues with `updatedAt` ≥ watermark). */
  readonly updatedAtSec: number;
  /**
   * Provider-specific passthrough — anything normalized fields don't carry
   * (GitHub `pull_request` marker, milestone, work-item type, …).
   * Forward-compat only: consumers MUST NOT make load-bearing reads of
   * `extra` keys — that would leak provider frames past the adapter, the
   * exact coupling §D2 exists to prevent. (The `github` adapter records
   * `{ isPullRequest: boolean }` here purely for the human-readable Task
   * body annotation.)
   */
  readonly extra: Readonly<Record<string, unknown>>;
}

/**
 * One page of a paginated issue listing. `nextCursor` is an OPAQUE
 * adapter-owned resume token (GitHub page link / ADO continuation token —
 * never parsed by consumers); `null` means the listing is exhausted.
 */
export interface IssueTrackerPage {
  readonly issues: readonly NormalizedIssue[];
  readonly nextCursor: string | null;
}

/** Options for one {@link IssueTracker.listIssues} page fetch. */
export interface ListIssuesOptions {
  /** Which repo/project to poll (see {@link TrackerScope}). Always from
   *  the `team.json::taskSources` config (ADR-263 §D3). */
  readonly scope: TrackerScope;
  /** Which upstream states to list: `"open"` (default), `"closed"`, or
   *  `"all"`. Maps to the provider's state filter. */
  readonly state?: "open" | "closed" | "all";
  /** Label allowlist — only issues carrying ≥1 of these labels. Omit /
   *  empty for no label filter. */
  readonly labels?: readonly string[];
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
 * The vendor-agnostic tracker interface (§D2). Every adapter implements
 * it; the sync engine (`src/core/issue-sync.ts`) is expressed purely in
 * terms of these verbs plus {@link NormalizedIssue} — provider-native
 * shapes stay inside the adapter.
 */
export interface IssueTracker {
  /** Stable id for this adapter ("github", "azure-devops", ...). */
  readonly id: string;

  /**
   * Fetch one page of issues in `opts.scope`. Read-only (v1 has no write
   * path — upstream write-back is deferred, ADR-261 §Out-of-scope, carried
   * forward unchanged by ADR-263 §D3).
   */
  listIssues(opts: ListIssuesOptions): Promise<IssueTrackerPage>;

  /**
   * Fetch a single issue by its canonical external id (the §D3 `sourceId`
   * format, e.g. `github:owner/repo#123`). Resolves `null` when the issue
   * does not exist or the token cannot read it — adapters do not throw on
   * not-found.
   */
  getIssue(externalId: string): Promise<NormalizedIssue | null>;
}

/**
 * Where an adapter's API token comes from — the house 3-tier cascade.
 * Resolution order, first hit wins (see {@link resolveTrackerToken} in
 * `src/abstractions/trackers/github.ts`):
 *
 *   1. env var named by `envVar` (e.g. `ATMUX_GITHUB_TOKEN`);
 *   2. `teamJsonToken` — a token literal carried in `team.json`;
 *   3. the file `${XDG_CONFIG_HOME:-~/.config}/atmux/<configFileBasename>`
 *      (e.g. `github-token`), contents trimmed.
 *
 * Two rules bind every consumer of this shape:
 *   - tokens are READ-ONLY scoped (GitHub: fine-grained token with
 *     read-only Issues permission). v1 has no write path to protect.
 *   - tokens NEVER appear on argv — tmux pane capture records command
 *     lines. Env or config file only.
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
