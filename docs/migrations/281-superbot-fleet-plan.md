# ADR-281 fleet migration plan (held)

This is the source-side preparation for cooperative `_bot` seats and `_superbot`. It is intentionally **not** an activation receipt. The renderer did not apply any `bot` or `superbot` block. Separate filesystem-only preparation normalized nullable driver fields, aligned two account selectors, and linked the existing canonical RX team config into its real project root; it did not change `cockpit.json`, invoke tmux, install atmux, rebuild/reconcile a cage, or deploy anything.

The machine-readable plan is [`281-superbot-fleet-plan.json`](281-superbot-fleet-plan.json). It snapshots `/root/.atmux/cockpit.json` at SHA-256 `aafc163d3e7086806e61bdaf204b253da4dcf7892e9a6e5bcd0c59e63406741f` on 2026-08-28 and names all 18 enabled persistent parent teams. Every team has an explicit target `_bot` block with:

- window identity `_bot` through the ADR-281 lifecycle;
- an explicit `claude` harness because only Claude has a verified automated-offer readiness classifier in this phase;
- an explicit account selector (never a credential); and
- the pinned `.atmux/worktrees/bot` worktree.

The ownership snapshot expands to 95 exact `(board, tag)` routes. Route order is intentional: `px/aix` and `px/aix-chat` precede PX's general tags so shared Aix work reaches the `aix` bot. The mixed `fmx` board keeps product tags (`ai-chat`, `deploy`, `finance`, `reporting`) with the `fmx` team, while shared Harness tags (`security`, `tooling`) route to the `aix` team whose root is the board's registered root. HAX and medic `infra` work routes to the personal `geoyws` team. Other registered boards with no tags remain explicitly excluded rather than receiving a guessed title/path route. Fallback lists are initially empty because a different team generally means a different repository; cross-repo fallback should be added only where both teams can safely own the same checkout.

## Read-only rendering

Run from a checkout containing ADR-281:

```bash
bun run superbot:render-plan
```

The renderer validates the plan and prints two held patch sets to stdout:

1. one `bot` block for each persistent parent team's `.atmux/team.json`; and
2. a cockpit `superbot` block that is still `enabled: false` and `shadow: true`.

It never writes those files and never invokes tmux. A plan with a missing/nullable harness, missing/nullable account, duplicate team, duplicate `(board, tag)`, unknown owner, duplicate fallback, or non-canonical bot cwd is refused.

## Current blockers before phase 7

- Five enabled cockpit roots—`ix`, `mx`, `hx`, `hrx`, and `fmx`—do not exist on this machine. Their complete canonical team configs already exist in dotfiles, but the real repositories must be restored or checked out before linking those configs or applying a `bot` block. Creating empty directories merely to satisfy the plan would hide the missing checkout and is forbidden.
- The updated atmux source is not installed and no runtime `bot`/`superbot` block has been applied. Activation remains separately held, so the running cockpit and cages must not be used to test this snapshot.
- Cockpit/team files and Kanban tags are live data. Re-inventory immediately before applying; refuse if the cockpit digest, persistent-team set, config existence, account mapping, or tag vocabulary drifted.

The two resolvable discrepancies were closed without touching tmux: RX's existing canonical config is now linked from its present repository root, and the `gitea`/`rx` canonical Claude commands and driver account labels now agree with the cockpit (`unum` and `ifca2`). The `fmx` board/root mismatch is represented as explicit tag ownership instead of rewriting a mixed board's registered root.

These remaining blockers are also carried in the rendered JSON so they cannot disappear in a chat handoff.

## Activation remains a separate change

After the blockers are resolved, the safe order is:

1. render and review the held patches;
2. apply only the per-team `bot` blocks, validate all team schemas, and keep cages untouched;
3. apply the cockpit `superbot` block with `enabled: false`, `shadow: true`, and validate it;
4. install the reviewed atmux source in a separately authorized phase;
5. reconcile one pilot team's cage and the cockpit, run shadow ticks, and inspect receipts;
6. enable one live route for one isolated pilot; then expand one team at a time only after manual-input and lease receipts remain clean.

Steps 2–6 are not authorized by this preparation. In particular, do not use `atmux start`, `atmux cockpit rebuild`, or the rebuild skill to test this plan against the live servers.
