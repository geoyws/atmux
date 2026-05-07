# ADR-001: Why TypeScript on Bun (vs Go, Zig, staying in bash)

**Status:** accepted
**Date:** 2026-05-04
**Owner:** architect

## Context

atmux is a multi-agent tmux orchestration tool, today implemented as 51 bash files (~16,300 LOC at HEAD `2aadc3f`) plus a 326-LOC dispatcher in `bin/atmux`. It coordinates teams of long-running Claude Code agents, posts Discord webhooks, manages a JSON kanban + per-member inboxes, and runs cron-fired automation (whip, report, decisions-digest) on a 5-minute cadence across four production teams (atmux, sopx-mvp, ifca_aux, unum). It has been the daily-driver of the project for v0.x.

The bash codebase has carried us this far, but four pressures are now pushing past what bash makes easy.

### Pressure 1 — Godfile drift

PLAN.md §2 claims "no file >355 LOC, no godfiles." Verified counts at `2aadc3f` disagree:

| File | LOC | Notes |
|---|---|---|
| `lib/doctor.sh` | 1467 | Preflight orchestrator; grew with each new dependency check |
| `lib/whip.sh` | 1305 | Cron-fired supervisor tick; 96% of cron firings hit this |
| `lib/audit.sh` | 923 | WIP — superdriver-audit |
| `lib/kanban.sh` | 797 | Task board state machine |
| `lib/common.sh` | 762 | Catch-all helpers |
| `lib/flags.sh` | 555 | Decision flags |

`doctor.sh` and `whip.sh` are the two most-edited files in the repo and the two largest. Bash makes incremental growth painless (just append a new `case` branch) and refactoring expensive (no module system, no static analyser, sourced functions share a global namespace). Every godfile-shaped audit finding has been deferred because there is no cheap way to split `whip.sh` without breaking sourced state across `lib/common.sh`, `lib/discord.sh`, `lib/kanban.sh`. A typed module system makes the split mechanical instead of brave.

### Pressure 2 — Silent error-swallow culture

```
$ git grep -cE '2>/dev/null \|\| true' lib/*.sh   # at 2aadc3f
110

$ git grep -cE '2>/dev/null'              lib/*.sh
414
```

Bash has no exception type. The shop-default for "I'm not sure if this command can fail" is `... 2>/dev/null || true` — silent both on the wire and at the audit level. We have actively burned hours hunting bugs that turned out to be a `jq` invocation eating an unexpected JSON shape and continuing as if nothing happened. CLAUDE.md "verify green from the right path" was written about exactly this kind of false-green. The pattern is too entrenched to rip out under bash without also moving language; there is no static check that catches it, and reviewer fatigue allows new ones in.

### Pressure 3 — No static typing across the JSON boundary

atmux passes structured state through 12+ JSON files (`team.json`, `kanban.json`, `inboxes/<member>.json`, `cost.json`, `decisions.md` frontmatter, …). Bash + jq has no schema. A field rename or a shape evolution propagates through the codebase by grep and prayer. Three of the last six bugs we shipped to operators were schema-drift bugs (a field renamed in one file, missed in another). Zod schemas at the I/O boundary catch this at the type-check, not at 03:00 when a teammate's whip tick crashes silently.

### Pressure 4 — Testability cliff

PLAN.md cites 24 `.bats` specs at HEAD; the actual repo at `2aadc3f` has 112. Bats covers integration paths well but does not give us unit coverage on library functions — bash functions are tested by spawning subshells, which is slow and order-dependent. PLAN.md notes 5 zero-coverage libs. Coverage at the function level is not absent because the team is lazy; it is absent because bash makes it expensive. A native test runner with built-in coverage instrumentation makes 100% narrowed coverage a CI gate, not an aspiration.

### What we are NOT solving

- We are not chasing performance. Bash's ~5ms cold start is fine; ~55 cron firings/hour at ~30ms each adds ~1.5s/day total — noise.
- We are not chasing portability. atmux runs on macOS + Linux only, both have bash, both can install Bun.
- We are not chasing distribution. Bash is pre-installed; that is genuinely lost when we move (see §"What we lose").

The motivation is **maintainability under continued growth**, not raw capability.

## Decision

Port atmux to **TypeScript on Bun** (`bun ≥1.3.13`, mise-managed, the version installed across the personal account today). Strict TS (`strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); biome for lint+format; `bun:test` with built-in coverage; zod at I/O boundaries; Bun's native `fetch` for Discord; `Bun.spawn` for tmux/jq-replacement subprocess work.

The decision is *language + runtime*, not language alone. Bun specifically:

1. **Native test runner with coverage** (`bun test --coverage`) — no Vitest, no Jest, no nyc. One tool, lcov export, `bun:test` API matches Vitest closely if we ever migrate.
2. **Native `fetch`** — Discord webhooks need no `axios`/`undici`/`node-fetch` dep. Reduces supply-chain surface and `package.json` size.
3. **`Bun.spawn`** — typed stdio/stderr capture, structured `stderr` stream, kill/timeout primitives. We replace 45 `tmux` shell-outs and 157 `jq` shell-outs with a single typed wrapper (per ADR-007). Most `jq` calls disappear entirely once we hold parsed objects in TS.
4. **`bun build --compile`** — a single-file binary for distribution. We ship `atmux-bun` as one file alongside the bash binary during cutover (PLAN.md §4.1), then rename to `atmux` after burn-in.
5. **Cold start.** Bun cold-start is ~20–40ms vs. bash ~5ms. Higher than bash, but faster than Node (~80–150ms cold). Cron impact is noise.
6. **MYT/Discord/Zod ergonomics** — `Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', … })` is one expression for the timezone discipline (CLAUDE.md global conventions). `zod` validates the JSON I/O surface that bash+jq has been getting wrong. The whip Discord-template format (CLAUDE.md §"Discord message format") is straightforward template-literal code in TS, painful in bash.
7. **Team skill match.** Every code path in atmux's surrounding ecosystem (Unum, sopx, ifca_aux) is TypeScript. Operators are already strict-TS-fluent. Go/Zig would be net-new language adoption *for atmux specifically* with no transferable benefit.

## Consequences

**Positives:**

- Static types across the JSON boundary close the schema-drift bug class. Pressure 3 disappears.
- `2>/dev/null || true` has no equivalent in TS. Throw vs. return-null becomes a typed decision per ADR-006.
- `whip.sh` (1305 LOC) and `doctor.sh` (1467 LOC) split into 5–8 typed modules each at port time. Pressure 1 disappears.
- `bun test --coverage` gates 100% narrowed coverage in CI (PLAN.md §8.1). Pressure 4 disappears.
- Single-file binary distribution via `bun build --compile` keeps the operator UX of bash (one file in `/usr/local/bin/`).
- Test runner, formatter, linter, build tool, package manager, runtime — all from two binaries (`bun` + `biome`). Operational footprint smaller than Node-toolchain.

**Negatives:**

- Cold start ~6× bash. Real number is small (~25ms vs ~5ms), but on a 100-firing/day cron load it accumulates ~2s/day extra CPU. We accept this; mitigation is "don't spawn the binary in tight loops" (which we already don't).
- Runtime dependency on Bun ≥1.3.13 (mise-managed). Operators on hosts without mise need a one-line install. Documented in cutover ADR-011.
- TS port carries a learning-curve tax for *non-TS-fluent* operators. Mitigated by team skill match (everyone in this account ecosystem already lives in strict TS).
- Bun's lock-primitive ecosystem is less mature than Node's `proper-lockfile` or libc `flock(2)`. ADR-005 chooses between hand-roll vs npm package and runs a 1000-iteration concurrent-write smoke before accepting.

**Follow-up tickets:**

- ADR-002 (project layout) — lock down `src/`, `tests/`, `schema/` shape.
- ADR-005 (JSON + locking) — pick lock primitive after bake-off.
- ADR-007 (subprocess spawn) — wrap `Bun.spawn` with timeout + stderr capture so we never silently drop subprocess errors (closes Pressure 2 at the spawn boundary).
- ADR-011 (cutover protocol) — pin Bun version in operator install path; document mise install.

## Alternatives considered

### A. Stay in bash; refactor the godfiles in place

Rejected. The four pressures above are *bash-shaped*, not *atmux-shaped* — they don't go away by splitting `whip.sh` into `whip-{tick,budget,heartbeat}.sh`. Pressure 2 (silent swallows) and Pressure 3 (no schema typing) are properties of the shell language. The refactor would deliver smaller files but leave the false-green and schema-drift bug classes intact. Pressure 4 (unit-test cliff) is bats-shaped, fundamentally — bats is an integration framework. CLAUDE.md "structural honesty over demo narrative" says don't do half-fixes that look like fixes; staying in bash and shuffling files is a half-fix.

### B. Port to Go

Considered seriously. Wins:

- True single binary, no runtime dep on the host.
- Mature stdlib for HTTP, JSON, file locking (`flock`).
- Strong typing.

Loses:

- Net-new language for the surrounding ecosystem (Unum, sopx, ifca_aux are all TS). Every helper utility, every pattern (Discord template, MYT formatter, Zod-equivalent schema validation) would need a Go port without transferable value.
- JSON ergonomics in Go are verbose vs. zod (`json.Unmarshal` into struct tags, no runtime validation of unknown fields by default).
- `tmux` subprocess wrapping is fine in Go but the resulting `os/exec` boilerplate is ~3× the `Bun.spawn` equivalent (we surveyed both).
- We would gain ~25ms cold-start back vs. Bun. Not worth the language switch.

### C. Port to Zig

Rejected with regret. Zig is the speed-and-correctness heaven, but for a tool whose hot path is "shell out to tmux, write JSON, post Discord", we'd be bringing a manual-allocator and a comptime story to a problem that is bottlenecked on `tmux send-keys` latency. Zig's HTTP and JSON ecosystem is also immature compared to Bun's batteries-included runtime. Possibly revisit in v3 if we hit a real perf floor.

### D. Port to Node + TS

Considered. Same language, same zod, same biome, more mature ecosystem.

Loses to Bun:

- No native test runner — need Vitest or Jest, +1 dep, +1 config surface.
- No native `fetch` until Node 21 stable — adds `undici`/`node-fetch`.
- Cold start ~80–150ms vs. Bun's ~25ms. On 100 cron firings/day this is a noticeable (10s+) CPU bump.
- `bun build --compile` has no clean Node equivalent; `pkg`/`nexe`/`ncc` exist but are flakier and produce larger binaries.

The migration path stays open: every API we use (`bun:test`, `Bun.spawn`, `Bun.write`) has a thin shim to Node-equivalent, so a future port to Node is a 1–2 day swap, not a rewrite. We are not painting ourselves into a corner.

### E. Port to Deno

Considered briefly. Similar shape to Bun (built-in test, native fetch, single binary). Lost on:

- `npm:zod` works but the import-map / permissions story adds friction with no offsetting win.
- Smaller community + ecosystem than Bun in 2026.
- Deno's `Deno.Command` is fine but `Bun.spawn`'s API matches our subprocess shape (stdio routing, `kill()`, timeout) more naturally.

Deno was not bad; Bun was strictly better for *this* tool's I/O profile.

### F. Hybrid — keep bash for cron-fired verbs, TS for interactive

Rejected. Doubles the surface area of the parity harness, doubles the maintenance burden, and the cron-fired verbs (whip, report, decisions-digest) are **exactly** the ones that need the schema discipline + typed-error gains. They are not the simple verbs.

## References

- PLAN.md §1 (mission), §3 (constraints), §10 (tooling table)
- CLAUDE.md global conventions — runtime management (`mise`), language (TypeScript strict), Discord format, MYT timezone, hooks discipline
- `lib/doctor.sh`, `lib/whip.sh` at `2aadc3f` — godfile evidence
- `git grep '2>/dev/null'` audit at `2aadc3f` — silent-swallow culture evidence
- ADR-002 (project layout, follows from this), ADR-003 (module taxonomy), ADR-005 (JSON + locking), ADR-007 (Bun.spawn pattern)
