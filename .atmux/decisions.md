# atmux decisions — append-only log

Lead/planner auto-resolutions, one entry per recommended-default applied.
Override window: see each entry's `override` line. Discord ping fires per
add (ADR-008).


### d-1e549002 — OQ-1: Eternal-improvement (ADR-052) — first landing branch: atmux-bun (TS port + lib twin) or atmux-geoyws (runtime-effective immediately)? [high] (22:55 MYT)

- **timestamp**: 1778079356
- **question**: OQ-1: Eternal-improvement (ADR-052) — first landing branch: atmux-bun (TS port + lib twin) or atmux-geoyws (runtime-effective immediately)?
- **default**: atmux-bun (this branch) per lead's dispatch — code lands in src/verbs/improve.ts + lib/improve.sh + docs/adr-bun/052-...; cross-branch sync to atmux-geoyws is a follow-up driver action
- **reversibility**: high
- **note**: OQ-1 in ADR-052. Driver decides the branch trade-off; planner cannot.
- **context**: Runtime atmux symlinks to atmux-geoyws bash (where ADR-043 auto-stop + ADR-049 budget-watcher live). Implementation in atmux-bun's lib/ is NOT runtime-effective; only the TS-side via 'bun run bin/atmux-bun improve' dogfoods immediately. Lead's dispatch said docs/adr-bun/, suggesting branch-local first. Driver may want runtime-immediate landing instead, accepting the cross-branch dispatch cost.
- **options**:
  - atmux-bun first (recommended default) — matches lead's dispatch; cross-branch sync deferred
  - atmux-geoyws first — runtime-immediate dogfooding; this team coordinates a parallel dispatch
  - Both simultaneously — highest cost, fastest dogfood, doubles review surface
- **impact**: Recommended default unblocks Tasks T1-T9 to land in this branch's tree. Override to atmux-geoyws would re-target T1+T2+T6 file paths to /root/work/src/atmux/lib/. Override to 'both' would split the implementation Tasks across two trees (~2× the impl cost). Cheap to flip BEFORE workers claim T1; expensive once T1 commits hit branches.
- **decided-by**: planner
- **override**: `atmux send lead "override d-1e549002: <new>"`

### d-43da9530 — OQ-2: ADR-052 vs t-9319a22c Supergroomer overlap — keep distinct, eternal-improvement absorbs supergroomer, or supergroomer absorbs eternal-improvement? [medium] (22:56 MYT)

- **timestamp**: 1778079370
- **question**: OQ-2: ADR-052 vs t-9319a22c Supergroomer overlap — keep distinct, eternal-improvement absorbs supergroomer, or supergroomer absorbs eternal-improvement?
- **default**: Keep distinct (Option 1) — eternal-improvement is per-team kanban-driven branch-local; supergroomer is fleet-level state-leak-driven cross-team. Triggers + scopes are disjoint despite shared infra.
- **reversibility**: medium
- **context**: Both touch autonomous-self-work but at different scopes. t-9319a22c is currently blocked behind t-706655ee (multi-tier fallback cage). Coupling them now would slow eternal-improvement (gated on supergroomer's blocked deps) AND complicate supergroomer's cage-isolation design (eternal-improvement runs inside the team's own cage, not isolated). Decoupling preserves both paths and lets each evolve at its own pace.
- **options**:
  - Keep distinct (recommended default)
  - Eternal-improvement absorbs supergroomer — single mechanism, two trigger types (kanban-empty + cron-fired)
  - Supergroomer absorbs eternal-improvement — supergroomer cycle includes per-team branch-local improvement work
- **impact**: Recommended default keeps t-9319a22c on its existing blocked path. Override to absorb-either-way couples eternal-improvement's deliverable to supergroomer's deps unblock. Cheap to flip until either Task ships.
- **decided-by**: planner
- **override**: `atmux send lead "override d-43da9530: <new>"`

### d-bb26b61d — OQ-3: ADR-052 budget-observability source — ADR-049 probe (atmux-geoyws-only today) vs atmux cost --json polling vs both? [low] (22:56 MYT)

- **timestamp**: 1778079378
- **question**: OQ-3: ADR-052 budget-observability source — ADR-049 probe (atmux-geoyws-only today) vs atmux cost --json polling vs both?
- **default**: Both with fallback — prefer ADR-049 probe (.atmux/state/budget-probe-<team>.json) when present; fall back to atmux cost --json. Fail-closed if neither available + no --budget flag.
- **reversibility**: low
- **context**: ADR-049 probe is on atmux-geoyws, not atmux-bun. Until that ports, the TS-side budget read needs a stub. atmux cost --json works on both branches but is slower (per-pane shell-out). Prefer-probe-with-fallback gives best-of-both with negligible cost.
- **options**:
  - Probe-only (cleaner; brittle if probe missing)
  - Polling-only (universal; slower)
  - Both with fallback (recommended default)
- **decided-by**: planner
- **override**: `atmux send lead "override d-bb26b61d: <new>"`

### d-69d32674 — R1-pivot OQ-A: 5.3 account-swap trigger threshold — 75% used (recommended) vs driver's 70-80% range vs original 90%? [high] (08:53 MYT)

- **timestamp**: 1778115223
- **question**: R1-pivot OQ-A: 5.3 account-swap trigger threshold — 75% used (recommended) vs driver's 70-80% range vs original 90%?
- **default**: 75% used (25% remaining = ~75min on 5h windows; comfortable margin over 40min worst-case 8-member serial swap; matches driver's range center)
- **reversibility**: high
- **note**: Confirmed via worst-case 8-member-serial-swap math at 5min/swap = 40min; 5h × 0.25 = 75min; margin = 35min.
- **context**: Driver brief asked for 70-80% (validated) and pushed back on the original 90% (correct: 90% used = 30min remaining ~ insufficient for 40min serial swap). 75% lands inside driver's stated range and keeps 35min buffer over worst-case. Higher threshold (70%) over-fires; lower (80%) shaves margin to ~20min. ADR-054 codifies as TeamWhip.accountSwapTriggerThreshold default 75. Per-team override available via team.json.
- **options**:
  - 75% (recommended default, mid-range, safest worst-case math)
  - 70% (conservative, fires earlier; more frequent swaps but never close to exhaustion)
  - 80% (aggressive, narrowest margin; risks mid-swap exhaustion if a swap stalls)
  - 90% (driver's original; rejected — math doesn't support it)
- **impact**: Sets ADR-054 TeamWhip default + ADR-056 §D2 trigger logic. Override window: cheap until R1-T11 e2e test lands. After that, real-fire data informs tuning. ADR-056 §Push-back enumerates the math for each option so override decisions are auditable.
- **decided-by**: planner
- **override**: `atmux send lead "override d-69d32674: <new>"`

### d-101d013c — R1-pivot OQ-B: bash ADR-052 (kanban-pause) port — port to bun OR decline as obsoleted by eternal-improvement Mode B? [high] (08:53 MYT)

- **timestamp**: 1778115236
- **question**: R1-pivot OQ-B: bash ADR-052 (kanban-pause) port — port to bun OR decline as obsoleted by eternal-improvement Mode B?
- **default**: Decline — Mode B (T6, t-a3a0e5b1) supersedes kanban-pause; same trigger point, strictly more useful (converts idle to productive token spend instead of just deferring decision).
- **reversibility**: high
- **note**: Documented in ADR-053 §Considered Alternatives B.
- **context**: Driver bias confirmed obsolescence is likely. Both intercept ADR-043's auto-stop trigger; Mode B's improvement-loop is strictly stronger than kanban-pause's whip-body skip (cage stays up + work happens vs cage stays up + nothing happens). ADR-053 + Mode B + budget-pause cover the full lifecycle: budget-pause halts when tokens drained; Mode B converts kanban-empty into work; when Mode B's budget exhausts AND kanban still empty, original atmux stop fires.
- **options**:
  - Decline (recommended default) — Mode B obsoletes
  - Port as fallback — kanban-pause as simpler whip-body skip when Mode B's improvement budget exhausts but cage shouldn't be stopped yet
  - Hybrid — port kanban-pause's resume-marker pattern (cheap; doesn't conflict) but skip the whip-body-skip mechanism
- **impact**: Recommended default: NO Tasks added for kanban-pause; ADR-052 (eternal-improvement) stays the canonical bun-port answer. Override 'port as fallback' would add a small follow-up Task (~50 LOC). Override 'hybrid' adds nothing structural — just absorbs the resume-marker idea into Mode B's existing wake-up path.
- **decided-by**: planner
- **override**: `atmux send lead "override d-101d013c: <new>"`

### d-a1578790 — R1-pivot OQ-C: Fixes A (super-status TMUX) + B (registry_touch) — port-with-fix-baked-in vs mark moot for bun? [medium] (08:54 MYT)

- **timestamp**: 1778115247
- **question**: R1-pivot OQ-C: Fixes A (super-status TMUX) + B (registry_touch) — port-with-fix-baked-in vs mark moot for bun?
- **default**: Mark MOOT for bun port — neither super-status.ts nor registry helper exist in src/ today (deferred per ADR-013 to Phase 5). Revisit at Phase 5 super-* port with the fix baked in from day one.
- **reversibility**: medium
- **context**: Fix A targets bash lib/super-status.sh (TMUX env handling); Fix B targets bash lib/start.sh registry_touch helper. Neither has a TS-native equivalent in src/verbs/ or src/core/ — they're explicitly deferred per ADR-013 §Phase 5 ports. Porting them NOW under R1 to fix bugs would invert the dep graph: would have to first port super-status / registry-helper as new modules, then patch in the fix. Bigger scope than driver's 'bug fix' framing implies.
- **options**:
  - Mark MOOT for bun (recommended default) — Phase 5 absorbs both with fix
  - Port-with-fix-baked-in NOW — adds 2-3 new TS modules under R1; ~300-500 LOC
  - Stub-port (verb skeletons that no-op) — leaves a placeholder for Phase 5 to fill
- **impact**: Recommended default: 0 new Tasks. Override to port-with-fix would add 4 Tasks (A + B impl + tests). Override to stub-port adds 2 Tasks (skeletons). Cheap to flip until Phase 5 starts; after, the Phase-5 port owns these.
- **decided-by**: planner
- **override**: `atmux send lead "override d-a1578790: <new>"`

### d-6cb1dd80 — ADR-057 OQ-S: 7-class stall-prevention ADR shape — single mega-ADR vs split per class vs fold-into-existing? [high] (09:54 MYT)

- **timestamp**: 1778118869
- **question**: ADR-057 OQ-S: 7-class stall-prevention ADR shape — single mega-ADR vs split per class vs fold-into-existing?
- **default**: Single ADR-057 with 7 per-class Decision sections (D1-D7 → Classes A-G); per-class Tasks decompose for independent reviewer-gate; partial v1.1.x acceptable
- **reversibility**: high
- **note**: Driver explicitly said 'what matters is failure-mode coverage, not the structure I sketched' — so structure is planner's call. Single ADR with per-class decomposition gives both narrative coherence + dispatch atomicity.
- **context**: Driver gave planner full latitude. The 7 classes share a meta-pattern (observability + verification at coordination boundaries) — one architectural decision, not seven. Cross-class deps are real (D6 heartbeat → D3 lock-TTL + D4 member-health; D5b window-IDs → D1 pane-state addressability; D3d size-cap → D2a archive path). Splitting per class would surface these as ADR-cross-references obscuring the single design intent. Folding into existing ADRs (052/054/055) would scope-creep stable ADRs with material that doesn't belong.
- **options**:
  - Single ADR-057 (recommended default) — coherent narrative + per-class Tasks for atomic dispatch
  - Split per class (ADR-057 through ADR-063) — independent dispatch but cross-class deps surface as cross-references
  - Fold into existing ADRs — zero new ADRs but scope-creeps 052/054/055 + loses failure-mode-coverage framing
  - Per-class ADRs nested in single epic (ADR-057-A through -G) — non-standard shape; reviewer tooling expects single-file ADRs
- **impact**: Recommended default: 1 ADR file + 8 Tasks (R57-T1 through R57-T8 incl docs) + 1 Epic. Override to split-per-class would multiply ADR review surface 7×. Override to fold-into-existing would scope-creep ADR-052 (eternal-improvement) + ADR-054 (zod whip-config) + push reviewer load onto already-merged surfaces. Cheap to flip while only ADR-057 file exists; expensive once 8 Tasks are claimed against the single Epic.
- **decided-by**: planner
- **override**: `atmux send lead "override d-6cb1dd80: <new>"`

### d-62a4faaf — ADR-058 ACL strategy — confirm setfacl rX + dedicated user for Tier 3+ isolation, reject chroot/container? [medium] (12:50 MYT)

- **timestamp**: 1778129433
- **question**: ADR-058 ACL strategy — confirm setfacl rX + dedicated user for Tier 3+ isolation, reject chroot/container?
- **default**: Confirm setfacl rX + dedicated Linux user. Chroot/container rejected (driver default upheld).
- **reversibility**: medium
- **note**: Driver chat-grant 10:38 MYT was 'let's do it' for the full chain; ACL strategy is the lead's push-back ask. Validated below; reversible by re-issuing scripts/provision-fallback-user.sh with chroot wrapper if Kimi misbehaves.
- **context**: Threat model: Kimi/MiniMax fine-tuned to be helpful, will reach for git ops to clean up own work (history rewrites, branch deletes, unauthorised commits observed in prior driver experiments). PATH-based git shim is bypassable (agent invokes /usr/bin/git directly). Question is which kernel-isolation primitive closes the surface most cleanly while keeping API egress + ACL grain working.
- **options**:
  - setfacl rX + dedicated user (driver default; chosen) — precise, per-syscall enforcement, idempotent provisioning, ACL grain matches asymmetric read policy
  - Chroot bind-mount — full FS isolation but per-cage root-setup cost, broken paths in agent logs, lifecycle complexity
  - Container (Docker/podman) — rootfs+network+cgroup but breaks API egress to Kimi/MiniMax, image build/cache layer, daemon dependency
  - PATH-only git shim — zero-privilege but agent calls /usr/bin/git directly, no defence
  - Read-only bind-mount of project — simple but loses ACL grain (e.g. _refs/ must be MORE restricted than src/)
- **impact**: Locked: scripts/provision-fallback-user.sh (T1) uses sudo useradd + setfacl. Reversible mid-implementation: T1 swap to chroot-wrapper without touching T2-T6. Override window cheap until T1 lands; expensive after T1 + T2 (cage builder verifies provisioned-user contract).
- **decided-by**: planner
- **override**: `atmux send lead "override d-62a4faaf: <new>"`

### d-77177be2 — ADR-068 OQ-7: atmux release-cut --check teeth — HARD non-zero exit on unanswered complaints, or soft warning? [high] (13:35 MYT)

- **timestamp**: 1778218522
- **question**: ADR-068 OQ-7: atmux release-cut --check teeth — HARD non-zero exit on unanswered complaints, or soft warning?
- **default**: HARD non-zero exit (exits 1; CI gate)
- **reversibility**: high
- **note**: HC#2 driver constraint says release-cut BLOCKS if any complaint lacks documented response. HARD exit is the only enforcement that survives CI. Soft warning gets ignored once a developer is shipping at midnight.
- **context**: ADR-068 §D6 (this ADR) defines per-complaint-answered guarantee. Release-cut --check enumerates open complaints in window; if any lack triage status (fixed/deferred/declined/triaged-into-task), the gate fires. Dominant question: is the gate teeth or no teeth? HC#2 (George 11:45 MYT 2026-05-08) said 'every complaint must be logged and addressed and answered' — that intent fails under soft warning.
- **options**:
  - HARD non-zero exit (exits 1; CI gate; recommended default — teeth)
  - Soft warning (exits 0 with stderr noise; relies on human attention; weaker)
  - Two-tier: warning by default, exit 1 only on --strict (deferred enforcement; mid-bar)
- **impact**: Affects S4 t-release-cut (t-4094bd66). HARD → CI must run atmux release-cut --check before tagging; soft → audit log only. Driver overrideable mid-implementation by replying with override + new direction; t-release-cut already documents the override path.
- **decided-by**: planner
- **override**: `atmux send lead "override d-77177be2: <new>"`

### d-3b64a6ba — ADR-068 OQ-1 [medium] (13:35 MYT)

- **timestamp**: 1778218536
- **question**: ADR-068 OQ-1
- **default**:  compat-shim deprecation window length
- **reversibility**: medium
- **note**: :30 days from rename land::Read-side compat for legacy paths during the post-rename window. 30d balances time for downstream-doc updates with not letting the old word linger forever.
- **context**: :30 days from rename land::Read-side compat for legacy paths during the post-rename window. 30d balances time for downstream-doc updates with not letting the old word linger forever.
- **override**: `atmux send lead "override d-3b64a6ba: <new>"`

### d-41413ae4 — ADR-068 OQ-2 [low] (13:35 MYT)

- **timestamp**: 1778218536
- **question**: ADR-068 OQ-2
- **default**:  driver pane identity — m-driver sentinel vs random m-XXXXXXXX
- **reversibility**: low
- **override**: `atmux send lead "override d-41413ae4: <new>"`

### d-208ff0d5 — ADR-068 OQ-3 [low] (13:35 MYT)

- **timestamp**: 1778218537
- **question**: ADR-068 OQ-3
- **default**:  cross-team complaints initial substrate — file-write vs ADR-032 socket-pubsub
- **reversibility**: low
- **override**: `atmux send lead "override d-208ff0d5: <new>"`

### d-a5b6dc61 — ADR-068 OQ-4 [low] (13:35 MYT)

- **timestamp**: 1778218537
- **question**: ADR-068 OQ-4
- **default**:  cron-groom complaints triage cadence — daily vs hourly
- **reversibility**: low
- **override**: `atmux send lead "override d-a5b6dc61: <new>"`

### d-c6ef0fb8 — ADR-068 OQ-5 [medium] (13:35 MYT)

- **timestamp**: 1778218537
- **question**: ADR-068 OQ-5
- **default**:  components #7 (generalized --team/--member) + #8 (member-targeted complaints) — fold into this ADR or follow-up
- **reversibility**: medium
- **note**: :Follow-up; this ADR ships v1; planner emits decomp once v1 closes::Generalized --team/--member is its own design surface; folding bloats this ADR past landability. Driver biases this could go either way; medium-rev for visibility.
- **context**: :Follow-up; this ADR ships v1; planner emits decomp once v1 closes::Generalized --team/--member is its own design surface; folding bloats this ADR past landability. Driver biases this could go either way; medium-rev for visibility.
- **override**: `atmux send lead "override d-c6ef0fb8: <new>"`

### d-d8579e6c — ADR-068 OQ-6 [low] (13:35 MYT)

- **timestamp**: 1778218537
- **question**: ADR-068 OQ-6
- **default**:  cron-groom triage default action — auto-create-ask vs require-lead-explicit
- **reversibility**: low
- **override**: `atmux send lead "override d-d8579e6c: <new>"`

### d-1bfe36f9 — ADR-082 OQ6: Worktree branch model — all members share team's current branch, OR each member gets a feature branch? [high] (07:30 MYT)

- **timestamp**: 1778542231
- **question**: ADR-082 OQ6: Worktree branch model — all members share team's current branch, OR each member gets a feature branch?
- **default**: All members work on the SAME team-current branch (geoyws / sopx-staging / etc.) inside isolated worktrees. Concurrent commits behave like 2 devs on 2 machines: each commits locally, pushes when ready, conflicts surface VISIBLY at push-time as rebase conflicts.
- **reversibility**: high
- **note**: If sopx-Wed demo prep exposes that two members collide on a SAME-FILE same-branch edit and the visible push-conflict is itself disruptive (vs the silent stash-eat which was worse), file a follow-up ADR for feature-branch-per-member.
- **context**: ADR-082 §3 (Decision §1) MVP wins by eliminating SILENT stash + lint-staged + checkout races at the working-tree level. The branch model is orthogonal: even with isolated worktrees, two members editing the same file under the same branch will collide at push. The MVP picks SHARED-BRANCH because (a) it preserves auto-push semantics in ADR-057 R57-T7, (b) it requires no merge-train coordination, (c) collisions become visible-and-resolvable instead of silent. Demo-Wed 2026-05-13 timeline cannot afford a feature-branch-per-member migration.
- **options**:
  - all members on team's current branch (recommended default — visible push-conflicts, no coordination overhead, auto-push preserved)
  - feature-branch-per-member with PR-fan-in (cleaner; each member's commits land on a separate branch, lead/gitter merges to team branch). Larger lift; demo-week unaffordable.
  - feature-branch-per-task with auto-cleanup (most isolation; one branch per kanban task; cleanup on done). Maximum overhead; only justified if push-collisions become a daily problem.
- **impact**: Affects W3 (atmux start integration t-383c98b0) — no change required for default. If overridden, W3 needs to provision-with-branch-name + W4 needs branch-cleanup-on-done + auto-push semantics in ADR-057 R57-T7 need to be re-scoped for fan-in. Override window: cheap NOW (before W3 lands); becomes expensive once W3 + auto-push interaction ships. Recommendation: leave default unless sopx-Wed exposes a same-file-collision pattern that proves silent-vs-visible isn't the actual win.
- **decided-by**: planner
- **override**: `atmux send lead "override d-1bfe36f9: <new>"`

### d-d4825a17 — ADR-082 OQ8: Dirty worktree handling on atmux stop --force — auto-stash, refuse, or skip-and-warn? [medium] (07:30 MYT)

- **timestamp**: 1778542231
- **question**: ADR-082 OQ8: Dirty worktree handling on atmux stop --force — auto-stash, refuse, or skip-and-warn?
- **default**: Skip dirty worktrees on --force stop; log warning + summary 'pruned N/M; K dirty (left for operator)'. Operator handles uncommitted work explicitly.
- **reversibility**: medium
- **note**: Matches CLAUDE.md memory feedback_destructive_ops_need_explicit_auth.md — never silently destroy unpushed work. Override = either auto-stash (high risk per CLAUDE.md L226 stash hazard) or refuse-stop-with-error (operator must commit first).
- **context**: ADR-082 §4 (Decision §4). atmux stop --force is the only stop variant that touches worktrees. Dirty-skip preserves operator agency; auto-stash recreates the same hazard the worktree-isolation ADR exists to fix; refuse-stop is too rigid (cockpit cycling needs to be reliable).
- **options**:
  - skip-and-warn (recommended default — preserves operator agency)
  - auto-stash (recreates the lint-staged + stash hazard ADR-082 fixes; rejected)
  - refuse-stop-with-error (forces operator to commit first; too rigid for cockpit cycling)
- **impact**: Affects W4 (atmux stop teardown t-5415d01c) only. Override would require teardown logic to either git stash push (rejected) or to early-error before tmux kill-session (acceptable but rigid).
- **decided-by**: planner
- **override**: `atmux send lead "override d-d4825a17: <new>"`

### d-f7f6fbe3 — ADR-082 OQ6 re-resolution: shared-branch impossible — per-member branch '<base>-<member>' replaces it [high] (11:50 MYT)

- **timestamp**: 1778557855
- **question**: OQ6 (ADR-082) re-resolution: shared-branch is impossible — per-member branch '<base>-<member>' replaces it. Driver may override naming convention.
- **default**: Per-member branch named '<teamBranch>-<sanitized(member)>' (e.g. 'geoyws-up-impl'). MVP for worktree isolation; codified in ADR-084.
- **reversibility**: high
- **note**: ADR-082's MVP claim 'all members on the same branch' was physically impossible — git rejects worktree-add against an already-checked-out branch. ADR-084 amends OQ6.
- **context**: Driver flagged 11:40 MYT 2026-05-12 that the W6a dogfood-flip caused 'every member to try checking out geoyws which git refuses'. Reproducer: `git -C <repo> worktree add <path> geoyws` returns `fatal: 'geoyws' is already used by worktree at '/root/work/src/atmux'`. The fallback at src/verbs/start.ts:491-499 silently degrades to shared cwd, defeating ADR-082's MVP. At demo-week scale (19 sopx-guild + 11 atmux + future cockpit members concurrent), the impossible MVP leaves the structural fix inert exactly when needed.
- **options**:
  - Per-member branch '<base>-<member>' (RECOMMENDED) — git worktree add -b <wtBranch> <path> <base>. Each member commits on own branch; pushes auto-allowed (CLAUDE.md Push Policy NON-staging shape); merges back via operator action. ~100 LOC + tests.
  - Detached HEAD per member — git worktree add --detach <path> HEAD. No branch namespace growth; but commits become orphans and push requires explicit HEAD:<base> refspec; breaks normal git workflow.
  - Per-member branch 'wt/<base>/<member>' — same shape under wt/ namespace. Cleaner visual separation but unusual; some git refs tooling treats slashes specially.
- **impact**: Implementation: W1 (t-3bad83e7) one-character change (-b flag) + sanitizeBranchSegment helper + signature extension + per-member doctor probe. W2 (t-40afa720) orphan-branch surfacing. W3 (t-0f162ad6) rewires W6c verify to per-member expectations. Operator surface: members get individual branches; merge-back to base is explicit; branch namespace grows N per team. Cheap to flip naming convention NOW (before W1 commits); expensive once cage rebuilds spawn branches with chosen shape.
- **decided-by**: planner
- **override**: `atmux send lead "override d-<id>: <new>"`

### d-fa29a3ef — Sentinel-drainer cooldown: raise cron 60min→4h, persist-dormancy-mute, escalate-to-medic-first, or inbox-recency dedup-skip? (4-option fork) [high] (00:18 MYT)

- **timestamp**: 1779293327
- **question**: Sentinel-drainer cooldown — raise 60min→4h cadence, persist last-diagnosis-mute, escalate-to-medic-first, or inbox-recency dedup-skip? (4 options to neutralize 14 false-positive escalations/day per team)
- **default**: B+D combined — persist last diagnosis verdict per team (mute next 4 escalations if prior tick was 'dormancy by design'; auto-self-clear on first non-dormancy verdict); add inbox-recency dedup-skip as belt-and-braces (skip if identical-shape escalation landed within 4h)
- **reversibility**: high
- **note**: P2 — fleet-wide noise; not blocker but recurring drag (4 teams × 14 false-pos = ~56 pings/day; each /clears the lead pane + ~3min context-rebuild). Driver may want A as fast-mitigation while B+D builds. Cross-ref: t-186d5910 follow-up (in-dispatcher escalate-to-claude-lead hook) is orthogonal — dispatch-side wedge detection, not sentinel cadence.
- **context**: unum-lead /bruh 07:08 MYT 2026-05-20 escalation: sentinel-drainer fires every 60min with actions=[escalate-to-claude-lead]. unum received 14 false-positives over 13h (06:10/05:00/03:50/02:40/01:40/00:30/23:20/22:20/21:20/21:10/20:00/19:00/17:58 MYT). EVERY one was: NO wedge / NO rate-limit / NO refusal / NO queued-text — pure by-design pull-mode dormancy when worker has no claim eligible. Fleet impact: 4 teams × 14 false-pos = ~56 noise pings/day. Prior leads stopped writing per-entry acks (pollutes driver-inbox without driver action). Sentinel-drainer is operating-as-designed; design assumes wedge-shape when dormancy-shape is dominant.
- **options**:
  - **A** — Raise cron cadence 60min→4h (4× noise reduction; still catches multi-hour wedges; simplest, 5-min sit)
  - **B** — Persist last diagnosis verdict per team; if prior tick was 'dormancy by design', mute next 4 escalations; auto-self-clear on first non-dormancy verdict (state-aware suppression)
  - **C** — Change escalate-to-claude-lead default → escalate-to-medic-first; medic /superdoctor once gates whether to actually disturb the lead (ADR-077 rotation pyramid alignment; cross-cuts to medic wiring; ~3-task EPIC)
  - **D** — Inbox-recency check in sentinel-drainer: if identical-shape escalation landed within N hours, dedup-skip (lighter state; doesn't catch repeated dormancy across re-claim cycles)
  - **B+D combined (RECOMMENDED)** — state-aware suppression with belt-and-braces dedup
- **impact**: Accepting default (B+D): impl follow-up Task on src/verbs/sentinel-drainer.ts + new merger_state-style per-team verdict table; new Task blocks until decision lands. Overriding to A: 1-line cron cadence change + done in 5min (lowest sit). Overriding to C: cross-cuts to medic role wiring; affects ADR-077; ~3-task EPIC. Overriding to D: lighter state (just inbox table query). DoD: next 4h shows zero false-positive escalations on demonstrably-dormant teams (e.g. unum with empty kanban + idle members).
- **decided-by**: planner
- **override**: `atmux send lead "override d-fa29a3ef: <new>"`

### d-1a2150ff — ADR-209 OQ1 RESOLVED — backfill spawnAt for existing rostered epic-teams: write 'spawnAt: <now>' with 'backfilled: true' flag on first sentinel encounter [low] (14:46 MYT 2026-05-21)

- **timestamp**: 1779347776
- **question**: ADR-209 OQ1: existing rostered epic-teams (e.g. 7 sopx orphans) lack epic-meta.json — sentinel writes spawnAt:<now> with backfilled:true flag, OR reads git branch-creation date as proxy?
- **default**: Write `spawnAt: <now>` with `backfilled: true` flag on first sentinel encounter. 6h clock starts from sentinel's first-encounter timestamp, not the original spawn. Verdict is clearly conservative (gives existing orphans 6h grace before triggering NEVER-STARTED).
- **reversibility**: low
- **note**: Driver-pref resolved in ADR-209 §Open questions OQ1. Encoded here for decomp scope. No relitigation needed.
- **decided-by**: driver (via ADR-209 a7fec9f authorship)

### d-595c16af — ADR-209 OQ2 RESOLVED — sentinel escalation debounce by (epicId, spawnAt) tuple [low] (14:46 MYT 2026-05-21)

- **timestamp**: 1779347776
- **question**: ADR-209 OQ2: sentinel escalation cadence — once-per-team-per-day OR once-per-team-per-spawn?
- **default**: Once-per-spawn — debounce by `(epicId, spawnAt)` tuple. A dissolve-and-respawn cycle gets a fresh notification.
- **reversibility**: low
- **note**: Driver-pref resolved in ADR-209 §Open questions OQ2. Encoded here. Sentinel dedup state: .atmux/state/sentinel-escalations.json per ADR-126 file-based dedup pattern.
- **decided-by**: driver (via ADR-209 a7fec9f authorship)

### d-66c08fb1 — ADR-209 OQ3 RESOLVED — NEVER-STARTED does NOT auto-dissolve without operator override [low] (14:46 MYT 2026-05-21)

- **timestamp**: 1779347776
- **question**: ADR-209 OQ3: should NEVER-STARTED verdict auto-dissolve epic-team without operator approval?
- **default**: NO — `--apply` mode surfaces the verdict but requires operator `--skip-checks` to dissolve. Same shape as DRAIN-with-stale-kanban.
- **reversibility**: low
- **note**: Driver-pref resolved in ADR-209 §Open questions OQ3. Auto-dissolve is too easy to weaponize against a team that's just slow to bring up. Operator agency preserved.
- **decided-by**: driver (via ADR-209 a7fec9f authorship)

### d-7d0543d5 — ADR-210 OQ1 RESOLVED — TIER 1 brief changes ship as new-spawn-only + announce; no automated backport [low] (15:50 MYT 2026-05-21)

- **timestamp**: 1779349595
- **question**: ADR-210 OQ1: TIER 1 brief changes only take effect on NEW spawn-epic. Backport vs new-spawn-only for existing teams?
- **default**: New-spawn-only + announce. Existing teams /clear to re-bootstrap if operator wants the brief change. NO automated backport. CHANGELOG documents /clear-to-pick-up flow.
- **reversibility**: low
- **note**: Driver-pref per ADR-210 §Open questions OQ1. Operator agency preserved — they choose which stuck teams to /clear. TIER 1 hotfix Task t-ef4bb453 references this decision.
- **decided-by**: driver (via ADR-210 da88e24 authorship)

### d-28268779 — ADR-210 OQ2 RESOLVED — T_DISPATCH_TIMEOUT default 15min + team.json::pullFallback.enabled opt-out [low] (15:50 MYT 2026-05-21)

- **timestamp**: 1779349595
- **question**: ADR-210 OQ2: TIER 2 pull-protocol fallback timeout — default 15min or longer? Per-team opt-out via team.json flag?
- **default**: T_DISPATCH_TIMEOUT default 15min. Per-team opt-out via team.json::pullFallback.enabled:false (teams that want strict-lead-dispatch can disable). Schema: { pullFallback: { enabled: bool, timeoutMin: number } } with defaults enabled:true + timeoutMin:15.
- **reversibility**: low
- **note**: Driver-pref per ADR-210 §Open questions OQ2. TIER 2 EPIC e-829fcfd0 T3 (s-protocol S5) implements this schema + default behavior.
- **decided-by**: driver (via ADR-210 da88e24 authorship)

### d-85fce71c — ADR-210 OQ3 RESOLVED — ADR-209 §4 sentinel auto-kick stays as BACKSTOP; priority lowered from sentinel-must-fire to sentinel-only-when-cage-truly-stuck [low] (15:50 MYT 2026-05-21)

- **timestamp**: 1779349595
- **question**: ADR-210 OQ3: If TIER 1 lands, sentinel auto-kick from ADR-209 §4 becomes redundant in common case. Keep as backstop or remove?
- **default**: KEEP as backstop for non-TIER-1-brief-aware teams + edge cases. Lower priority from sentinel-must-fire to sentinel-only-when-cage-truly-stuck. Cohabits with structural fix without conflict.
- **reversibility**: low
- **note**: Driver-pref per ADR-210 §Open questions OQ3. TIER 2 EPIC e-829fcfd0 T5 (integration+docs) annotates ADR-209 §Amendment with this priority-lowering.
- **decided-by**: driver (via ADR-210 da88e24 authorship)

### d-7b8d444f-batch — Authorize docs claim+close-via-note for 10 dep-blocked docs Tasks owned by retired members [low] (15:01 MYT 2026-05-22)

- **timestamp**: 1779433860
- **question**: Authorize docs to claim+close-via-note the 10 dep-blocked docs Tasks (t-7b8d444f / t-1de08e57 / t-b8d1d344 / t-f5c79b50 / t-e0df241f / t-317a522e / t-855611a4 / t-68e87011 / t-179ca7d6 / t-8be9a03d) owned by retired members (up-impl / parity-state-impl) where the underlying EPIC code already shipped per 3-signal scope-match?
- **default**: APPROVE option (1) — docs claims + patches in-place gaps + ONE commit per Task + closes with note naming dropped deps + shipping SHA
- **reversibility**: low
- **options**:
  - (1, recommended) docs claims + patches in-place + ONE commit per Task + close-via-note
  - (2) lead `atmux task done --as docs` batch — status-only, no commits, loses verbatim-form patches docs surfaced (e.g. ADR-127 §OQ5 header form gap)
  - (3) wait + docs eternal-improvement on other surfaces (idle the unblocked audit-trail work)
- **context**: 10 docs Tasks stuck on dep IDs owned by pre-decomp roster. Dep Tasks will never close. Underlying ADRs (171-184) accepted on disk + git log + sibling memory per docs's audit. Atmux team coordination-only per project_atmux_team_decomposed_to_core; spawn-epic for docs sweep overkill. Without authorization docs idles.
- **impact**: Unblocks 8-10 docs Tasks; ~8-10 commits on atmux-geoyws-docs; cleans up audit trail. Worst case: 3-signal mismatch on 1-2 Tasks → docs flags + leaves open. Reversal: re-open Task + revert commit per usual.
- **note**: Spot-checked t-7b8d444f (ADR-176 lane-drift criterion d): deps t-e80410b3+t-c3865ff0 owned by up-impl=retired; ADR-176 file exists; §OQ5 amendment + status-flip + lane-drift.ts header refs all genuinely unstarted work. Memory feedback_auto_groom_shipped_via_sha_false_positives + ADR-131 §Amendment 2026-05-17 require 3-signal scope-match — docs confirms doing this. atmux decisions verb is brief-drift absent in 0.8.x (per memory feedback_atmux_flag_verb_absent_in_084) — recording direct to decisions.md.
- **decided-by**: lead

### d-e20oq6 — OQ6 (e-20-2eddfd28): auto-escalate unblock-failure to rotation? [medium] (14:25 MYT)

- **timestamp**: 1779603927
- **question**: OQ6 in e-20-2eddfd28 — if Phase 3b unblock fails (still wedged after C-c → End → Enter x3), should orchd auto-emit `member.no-progress` so the rotation-consumer wakes and routes to lead?
- **default**: YES — emit `member.no-progress` (or equivalent rotation-trigger topic) on unblock-failure, but **lead-gated rotation execution** per ADR-212 pattern. Chain: unblock-fail → emit event → rotation-consumer wakes → tell-lead with decision matrix (rotate-now / preclear / leave-alone / dissolve-respawn) → lead approves → orchd executes. NOT autonomous rotation.
- **reversibility**: medium — emit topic + handler wiring is one PR to undo; the lead-gated invariant is the load-bearing piece that keeps this from being autonomous.
- **context**: Operator resolution 2026-05-24 14:15 MYT — completes the heal-chain (unblock → fail → rotate-with-permission) cleanly. Matches existing ADR-212 (rotation) + ADR-214 (complaints) lead-gated escalation pattern: orchd OBSERVES + ROUTES; lead JUDGES; orchd EXECUTES on confirmation. No first-class autonomous-rotation surface introduced by this epic.
- **options**:
  - (1, recommended) emit-and-lead-gate per above
  - (2) silent fail — log only, no escalation; operator must notice via /bau
  - (3) autonomous rotation on unblock-fail — fastest recovery, but introduces autonomous-action class with rotation blast radius (loses claimed task + member context)
- **impact**: Planner decomposes e-20 with the heal-chain wiring in scope. Reuses existing rotation-consumer (no new consumer). New event topic may be needed if `member.no-progress` doesn't already exist — planner check + ADR-203 §D2 amend if so.
- **decided-by**: operator
- **override**: `atmux send lead "override d-e20oq6: <new>"`
