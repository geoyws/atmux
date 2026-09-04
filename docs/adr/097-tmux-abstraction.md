# ADR-097: tmux abstraction interface

**Status:** accepted (amended 2026-05-05 — socket injection)
**Date:** 2026-05-04 (original); 2026-05-05 (socket-injection amend)
**Owner:** architect (original); foundation-porter (amend)

## Context

atmux is, fundamentally, a thing that drives `tmux`. Every verb that interacts with the live state of a team (start, stop, attach, send, broadcast, whip, status, dashboard, …) reaches `tmux` somewhere. The abstraction defined here is the second-most-frequently-used module in the codebase (after `spawn.ts`).

PLAN.md §2 cites "45 tmux calls / 11 subcommands" across the bash codebase. Counting at the worktree's frozen `lib/` (HEAD `2aadc3f`), the distinct subcommands actually invoked are 13:

| Subcommand | Invocations | Used by |
|---|---|---|
| `send-keys` | 9 | send, broadcast, tell, dispatch, whip, rotate |
| `paste-buffer` | 6 | send (multi-line), dispatch, rotate |
| `capture-pane` | 4 | status, whip, dashboard |
| `list-windows` | 4 | status, whip, dashboard |
| `load-buffer` | 3 | paired with `paste-buffer` |
| `list-panes` | 3 | status, dashboard |
| `attach-session` | 3 | up, attach |
| `new-window` | 2 | start, add-member |
| `kill-session` | 2 | stop |
| `new-session` | 1 | start |
| `kill-window` | 1 | stop, handoff cleanup |
| `has-session` | 1 | doctor, attach |
| `switch-client` | 1 | rotate-lead |

The bash code reaches these via raw `tmux <verb> <args>` shellouts spread across 27 files, with output parsing inline. Three failure modes are systemic:

1. **Unparsed output.** `tmux list-windows -F '#{window_name}'` returns lines; the bash code splits on newline. tmux's control protocol output sometimes inserts CR chars or trailing whitespace that breaks parsing — manifest as silent empty lists, not errors.
2. **Stderr lost.** `tmux <cmd> 2>/dev/null || true` is the dominant pattern. When the call fails (typo, version skew, no server, missing target) the failure is invisible.
3. **Version skew.** tmux's option/command syntax changes across major versions (3.0 → 3.3 deprecated `target-` flags, 3.4 added `display-message -p` semantic shifts). atmux runs across operator boxes with whatever tmux happens to be installed. Today this is a "trust the user" situation.

The TS port replaces all of this with one typed module: `src/abstractions/tmux.ts`. Every subcommand atmux uses gets a typed method; every method either resolves with a parsed result or rejects with a typed error carrying stderr + exit code.

## Decision

`src/abstractions/tmux.ts` exposes a single namespace export `tmux` with **methods grouped by tmux's official command-group taxonomy**. Each method is a thin typed wrapper over a single tmux subcommand. Buckets:

- `session` — session-level control (new-session, has-session, kill-session, list-sessions, rename-session)
- `window` — window-level control (new-window, kill-window, list-windows, rename-window, select-window)
- `pane` — pane-level control (split-window, kill-pane, list-panes, select-pane, send-keys, capture-pane, display-message)
- `buffer` — buffer manipulation (load-buffer, paste-buffer, set-buffer, save-buffer, delete-buffer)
- `client` — client control (attach-session, switch-client, list-clients, detach-client)
- `option` — option get/set (set-option, set-window-option, show-options, show-window-options)
- `server` — server control (kill-server, has-server) — included for completeness; atmux doesn't currently call

### Method shape

Every method:

1. Takes a typed args object (no positional args; tmux flags map to named fields).
2. Returns a `Promise<T>` where `T` is the parsed structured result, or `void` if the subcommand has no meaningful return.
3. Rejects with `TmuxError` (subclass of `AtmuxError` per ADR-099) carrying:
   - `argv: string[]` — the exact argv that was invoked
   - `exitCode: number`
   - `stderr: string` — captured verbatim
   - `stdout: string` — captured even on failure (for diagnosis)
   - `cause?: unknown` — original spawn error if the failure was at OS level
4. Internally uses `src/abstractions/spawn.ts` (per ADR-100); never touches `Bun.spawn` directly.

### Concrete sketch

```ts
// src/abstractions/tmux.ts
import { spawn } from "./spawn";
import { TmuxError } from "../errors";

export interface PaneId { sessionName: string; windowIndex: number; paneIndex: number }
export interface WindowId { sessionName: string; windowIndex: number }

export const tmux = {
  session: {
    async newSession(opts: {
      name: string;
      detached?: boolean;        // -d
      cwd?: string;              // -c
      windowName?: string;       // -n
      shellCommand?: string;     // last positional
    }): Promise<void> {
      const argv = ["new-session"];
      if (opts.detached ?? true) argv.push("-d");
      argv.push("-s", opts.name);
      if (opts.cwd) argv.push("-c", opts.cwd);
      if (opts.windowName) argv.push("-n", opts.windowName);
      if (opts.shellCommand) argv.push(opts.shellCommand);
      await tmuxRun(argv);
    },

    async hasSession(name: string): Promise<boolean> {
      // tmux has-session -t <name> exits 0 if exists, 1 if not, >1 on error.
      // We expect 0 or 1; only >1 is a real failure.
      const result = await tmuxRunRaw(["has-session", "-t", name], { expect: [0, 1] });
      return result.exitCode === 0;
    },

    async killSession(name: string): Promise<void> {
      await tmuxRun(["kill-session", "-t", name]);
    },

    async listSessions(): Promise<{ name: string; windows: number; created: number }[]> {
      const fmt = "#{session_name}\t#{session_windows}\t#{session_created}";
      const { stdout } = await tmuxRunRaw(["list-sessions", "-F", fmt], { expect: [0, 1] });
      // tmux exits 1 with empty stdout when no sessions exist; treat as []
      return parseTabular(stdout, ["name", "windows", "created"]).map(/* … typed map … */);
    },
  },

  window: {
    async newWindow(opts: { sessionName: string; name?: string; cwd?: string;
      shellCommand?: string; detached?: boolean }): Promise<WindowId> { /* … */ },
    async killWindow(id: WindowId): Promise<void> { /* … */ },
    async listWindows(sessionName: string): Promise<{ index: number; name: string; active: boolean }[]> { /* … */ },
    async renameWindow(id: WindowId, name: string): Promise<void> { /* … */ },
  },

  pane: {
    async sendKeys(opts: {
      target: PaneId | WindowId | string;  // tmux target spec
      keys: string;                         // raw keys (tmux interprets)
      literal?: boolean;                    // -l (no key-name interpretation)
      enter?: boolean;                      // append C-m if true (default true)
    }): Promise<void> { /* … */ },

    async capturePane(opts: {
      target: PaneId | string;
      start?: number;                       // -S (default last visible)
      end?: number;                         // -E
      includeAnsi?: boolean;                // -e
    }): Promise<string> { /* … */ },

    async listPanes(target: WindowId | string): Promise<{ index: number; pid: number;
      title: string; width: number; height: number }[]> { /* … */ },

    async displayMessage(opts: { target: PaneId | string; format: string;
      print?: boolean }): Promise<string> { /* … */ },

    async killPane(target: PaneId): Promise<void> { /* … */ },
    async splitWindow(opts: { target: WindowId; vertical?: boolean;
      cwd?: string; shellCommand?: string }): Promise<PaneId> { /* … */ },
  },

  buffer: {
    async loadBuffer(opts: { name?: string; data: string }): Promise<void> { /* … */ },
    async pasteBuffer(opts: { name?: string; target: PaneId; deleteAfter?: boolean }): Promise<void> { /* … */ },
    async deleteBuffer(name: string): Promise<void> { /* … */ },
  },

  client: {
    async attachSession(name: string): Promise<void> { /* … */ },
    async switchClient(opts: { target: string; clientName?: string }): Promise<void> { /* … */ },
    async listClients(): Promise<{ name: string; session: string; tty: string }[]> { /* … */ },
  },

  option: {
    async setOption(opts: { name: string; value: string;
      target?: string; global?: boolean; window?: boolean }): Promise<void> { /* … */ },
    async showOptions(opts: { target?: string; global?: boolean;
      window?: boolean }): Promise<Record<string, string>> { /* … */ },
  },

  server: {
    async hasServer(): Promise<boolean> { /* … */ },  // wrap `tmux info` exit code
    async killServer(): Promise<void> { /* … */ },
  },
};

async function tmuxRun(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await spawn({ cmd: "tmux", argv, expectExitCode: 0 });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function tmuxRunRaw(argv: string[], opts: { expect: number[] }):
  Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return spawn({ cmd: "tmux", argv, expectExitCode: opts.expect });
}
```

### Output parsing rules

- All `list-*` methods use `-F '<fmt>'` with `\t`-separated fields. The wrapper splits on `\n`, trims trailing CR, splits on `\t`, and constructs typed records. Empty stdout returns `[]`.
- `capture-pane` returns the raw string. The caller decides how to parse pane content (atmux currently grep-matches for prompt patterns; that logic stays in `src/core/common.ts`).
- `display-message -p` returns the formatted line minus trailing newline.
- `has-session` uses exit-code semantics — implementation explicitly accepts `[0, 1]` and maps to `boolean`. Anything else throws.

### Target spec

tmux's "target" syntax (`session:window.pane`) is finicky. The abstraction takes structured `PaneId` / `WindowId` types and serializes them, OR accepts a raw `string` for callers that already have a target string in hand. Inside the abstraction:

```ts
function serializeTarget(t: PaneId | WindowId | string): string {
  if (typeof t === "string") return t;
  if ("paneIndex" in t) return `${t.sessionName}:${t.windowIndex}.${t.paneIndex}`;
  return `${t.sessionName}:${t.windowIndex}`;
}
```

### Version pinning

CI installs a pinned tmux version via mise (`mise.toml` records the version, ADR-104 captures the operator install path). The pinned version is documented in `package.json` `engines` field as a soft hint:

```json
{ "engines": { "tmux": ">=3.3" } }
```

Documented operator minimum: tmux 3.3 (introduced `display-message -p` stable semantics + the target-syntax we depend on). Lower versions emit a doctor-time warning; the abstraction still tries best-effort.

### Control protocol quirks

tmux's control protocol (`-C`) emits framed output that's nondeterministic in line endings and timing. atmux does not use control mode today. **The abstraction explicitly does NOT support `tmux -C`.** If a future verb needs control mode (live event streaming for dashboard), it will be a separate `src/abstractions/tmux-control.ts` module with its own ADR — not a flag on this one. The current abstraction is one-shot-command-and-parse.

### Test mocking

Every method in `tmux.ts` is a thin shell of argv-construction + `spawn()` call + parse. Unit tests for the abstraction itself are about argv shape (snapshot test "given these opts, produces this argv"). Integration with real tmux is covered by the parity harness (PLAN.md §8.2) — bash and TS both call real tmux against the same fixture, output is compared.

For higher-layer tests (verb tests), `tmux.ts` is replaced wholesale via `bun:test` mock injection — every method swapped for a mock. Verb tests do not touch real tmux.

### Socket injection (amend, 2026-05-05)

**Incident.** On 2026-05-05 ~01:44 MYT, the in-flight `tests/unit/abstractions/tmux.test.ts` killed the operator's daily-driver tmux server during teardown. Root cause: the abstraction had no socket parameter, so every `tmux <subcmd>` call resolved to whatever server tmux happened to find — default socket, inherited `$TMUX`, or whatever `$TMUX_TMPDIR` pointed at. The test file had a partial env-only fix (`delete process.env.TMUX` + `process.env.TMUX_TMPDIR = tmpdir`) but env vars are not load-bearing — `tmux` ignores `TMUX_TMPDIR` in some configurations and the test process can still inherit/leak `$TMUX`. When `afterEach` ran `tmux kill-server`, it hit the operator's `/tmp/tmux-0/default`. Memory ref: `feedback_tmux_test_isolation.md`.

User's exact words: *"all tests MUST BE ON A DIFFERENT TMUX SERVER BECAUSE U KEEP KILLING THE DEFAULT TMUX SERVER DURING UR TEARDOWN."*

**Bash precedent.** The bash codebase reaches the same conclusion via `atmux::tmux_cage` (commits `c5f56ef` + `feb8b72`, ADR-111); this TS amend is the strict-typed equivalent — `-L <socket>` is enforced at the abstraction boundary so callers cannot regress to bare `tmux`. Where the bash helper relies on convention ("always call `atmux::tmux_cage tmux …` instead of bare `tmux …`"), the TS factory raises that convention to a compile-time invariant: there's no exported zero-arg surface for a caller to reach.

**Decision.** The abstraction itself takes a socket parameter. Every tmux subprocess prepends `-L <name>` or `-S <abs-path>` to argv, before any subcommand. There is **no zero-arg / default `tmux` singleton** — callers obtain a namespace via:

```ts
import { createTmux } from "src/abstractions/tmux";

// Short-name socket (resolves under $TMUX_TMPDIR or /tmp/tmux-<uid>/):
const tmux = createTmux({ socket: "atmux-team-name" });

// Absolute path (full control, used by tests + ADR-111 cage):
const tmux = createTmux({ socketPath: "/tmp/atmux-cage-team/sock" });
```

The `TmuxConfig` type is a discriminated union with `?: never` on the unused field, so TypeScript rejects passing both / neither at compile time, plus an optional `configFile` for config-pinning:

```ts
type SocketConfig =
  | { readonly socket: string;     readonly socketPath?: never }
  | { readonly socketPath: string; readonly socket?: never };

export type TmuxConfig = SocketConfig & {
  readonly configFile?: string;  // optional -f <path>; live-server tests and selected server-starting paths use getAtmuxTmuxConfPath()
};
```

The factory captures the socket flag (and optional `-f <path>`) in a closure and routes every `tmuxRun` / `tmuxRunRaw` call (and the direct `loadBuffer` stdin path) through `[...socketArgs, ...subcmdArgv]`. By construction, no method on the returned namespace can issue a tmux command that omits the socket flag — including `server.killServer()`, which is the failure point of the original incident.

**Config-pinning, same physical-impossibility argument.** Even on an isolated socket, `tmux` reads `~/.tmux.conf` by default — so an operator config that sets `base-index 1` / `pane-base-index 1` silently reshapes test fixtures that hardcode `:0`. On 2026-09-01, live-server tests / the parity harness and the production server-starting paths already wired for canonical config pass `configFile: getAtmuxTmuxConfPath()`, the same way tests pass `socketPath` to get an isolated socket. The 2026-05-05 stock-default `/dev/null` test rationale is historical only and is superseded for live-server tests. A separate production-call-site audit remains necessary; this amendment does not claim that every production `createTmux` caller is already pinned.

**`hasServer()` probe correction.** The original ADR sketch suggested `tmux info` for `hasServer`. Empirically, `tmux info` exits 1 in non-TTY contexts (e.g. `bun test`) even with a healthy server — its output is terminal-info that requires an attached client. The amended implementation uses `list-sessions` exit code instead: exit 0 means the server is up with ≥1 session, exit 1 means no server (tmux exits its server when the last session closes). For atmux's usage (every team always has at least its lead window), this is the right semantic.

**Consequences of removing the singleton.**

- Every consumer must decide which socket they're driving. There is no "default" path. This is the point — a default would re-introduce the incident's failure mode.
- Verb code (Phase 2) receives the namespace as a constructor argument or via a tiny per-verb factory that reads the team's socket from `team.json` (resolution lives in `src/core/common.ts`, Phase 1).
- Tests instantiate per-test with `socketPath: join(tmpdir, "sock")` so teardown's `tmux.server.killServer()` hits only the per-test socket, by construction.
- Belt-and-braces in tests: `delete process.env.TMUX` is kept with a comment that the load-bearing fix is the `-S` flag. If env-leak ever sneaks past, the `-S` still wins.

**Reviewer enforcement (new check #9).** Reviewer regex blocks any tmux invocation that doesn't carry `-L` or `-S` immediately after `cmd: "tmux"`. The two valid call sites — `tmuxRunRaw` (centralized) and `buffer.loadBuffer` (direct due to stdin) — both prepend `socketArgs` from the closure; nothing else inside `src/abstractions/tmux.ts` calls `spawn({ cmd: "tmux", ... })`.

## Consequences

**Positives:**

- Every tmux call in the codebase is at one place. Reviewer regex `\bspawn\(.*"tmux"` outside `src/abstractions/tmux.ts` is a layer violation and blocks the commit.
- Failure modes 1+2 (silent unparsed / lost stderr) close: every method either returns a parsed value or throws TmuxError with stderr captured.
- Version pinning + minimum-version doc moves "what tmux works" from operator folklore to package.json + doctor.
- New verbs that need a tmux subcommand we haven't wrapped force an ADR-shaped decision (extend `tmux.ts`) rather than sprinkling raw shellouts.
- `tmux.ts` is wholesale-mockable from verb tests — verb tests stay fast and deterministic.

**Negatives:**

- Wrapping every subcommand we use is real work — ~13 methods to write, each with argv-construction and parser. Foundation porter's task.
- New tmux features (3.5+) lag behind the abstraction. We'll need ADR-amend or a follow-up ADR each time we adopt a new subcommand.
- Argv-construction is tedious to test exhaustively. The mitigation is snapshot tests + parity harness coverage; unit tests don't aim to cover every flag combination.
- `target` overloading (`PaneId | WindowId | string`) is convenience that costs reviewer cycles ("which type is this `target`?"). Acceptable trade vs. forcing every call site to construct string targets.

**Follow-up tickets:**

- ADR-100 (spawn pattern) — `tmux.ts` requires `spawn()` to accept `expectExitCode: number | number[]` so `has-session` and `list-sessions` can declare `[0, 1]` as success.
- Foundation porter implements `tmux.ts` as part of Phase 1; reviewer adds the layer-violation regex once committed.
- Doctor verb (Phase 2) reads `tmux -V`, compares to engines hint, emits warning.
- Future ADR (post-v1) — control-protocol abstraction `tmux-control.ts` if dashboard goes live.
- **Phase 2 — `getDefaultSocket()` resolver (post-amend follow-up).** Verb code in Phase 2 needs a single source-of-truth for "which socket does this team use?" The factory accepts a socket explicitly, so each verb's entry point must resolve it before calling `createTmux`. Open questions for lead's Phase 2 spec: `$ATMUX_SOCKET` env var? a `socket` field in `.atmux/config.json` / `team.json`? a `--socket <name>` CLI flag override? cage-topology auto-derived from team name (ADR-111 bash precedent: `/tmp/atmux-cage-${team}/sock`)? Resolver lives in `src/core/common.ts` (Phase 1 placeholder) — wired to actual sources during Phase 2 once the decision lands.

## Alternatives considered

### A. One method per `tmux <subcmd>`, no buckets

```ts
tmux.sendKeys(...);      tmux.newSession(...);   tmux.listWindows(...);
```

Considered. Flatter, easier to grep. Rejected because:
- ~13 subcommands today; v2 may add 5–10 more. Flat namespace at 25 methods is harder to navigate than `tmux.session.*`/`tmux.pane.*`/etc.
- The buckets match tmux's own `man tmux` taxonomy; reviewers reading the code can map directly back to tmux docs.
- Test mock injection is finer-grained when buckets are objects (replace `tmux.pane = mockPane` instead of replacing every `tmux.sendKeys`/`capturePane`/etc. individually).

### B. Pass-through `tmux.exec(argv: string[])` only

Rejected. Defeats the entire point. Returns us to bash's "raw shellout, parse-by-grep" model. Failure modes 1+2 reopen.

### C. Fluent builder `tmux().pane(p).sendKeys(...)`

Considered. Flexible, chainable. Rejected as ceremony; the typed args object on each method achieves the same readability without the builder boilerplate.

### D. Code-generate the whole thing from `tmux man` page

Considered briefly. Compelling for completeness; rejected for v1 because:
- Only ~13 subcommands are actually used. Generating ~150 stubs we'll never call wastes review cycles.
- tmux man page is not machine-parseable; we'd need `tmux info` introspection plus heuristics. Engineering tax >> hand-writing the 13 we need.
- Hand-rolled methods can be opinionated about output parsing in ways generators can't.

Revisit at v3 if subcommand surface grows past ~30.

### E. Use `node-tmux` / `tmux-control` npm package

Surveyed. None of the existing packages cover all our subcommands, and most assume control mode (which we explicitly don't want in v1). Two are abandoned (last commit >2y). Building our own keeps the dep surface small and matches our parsing style.

## References

- PLAN.md §2 (tmux call counts at frozen scope), §10 (no socat / nc / control-protocol — confirms we are not building tmux-control)
- ADR-095 Pressure 2 (silent error swallow culture; `tmux ... 2>/dev/null || true` is one of the canonical instances)
- ADR-096 (module taxonomy — `src/abstractions/tmux.ts` is one of the 8 abstractions)
- ADR-099 (error handling — TmuxError is one of the typed subclasses)
- ADR-100 (spawn pattern — `expectExitCode: number | number[]` requirement comes from this ADR)
- ADR-104 (cutover — pins tmux minimum version into operator install path)
- bash `lib/common.sh`, `lib/send.sh`, `lib/whip.sh`, `lib/start.sh` — primary tmux-shellout sites at worktree HEAD
- `man tmux` command-group taxonomy — source of the bucket structure
- `feedback_tmux_test_isolation.md` (memory) — incident motivation for the 2026-05-05 socket-injection amend

## Amendment 2026-09-01 — live-server tests and session-start paths use the canonical atmux conf

The 2026-05-05 `/dev/null` stock-default test guidance is historical. On 2026-09-01, live-server tests / the parity harness were wired to `configFile: getAtmuxTmuxConfPath()` so they load the canonical atmux conf instead of an empty config file. Selected production server-starting paths already use the same resolver; the remaining production `createTmux` inventory is a separate follow-up and is not represented here as complete.

## Amendment 2026-09-04 — the canonical conf is the DEFAULT, and the production inventory is closed (t-2480d87f)

The follow-up the 2026-09-01 amendment left open is done, and it found the omission was near-total rather than partial: of roughly 40 production `createTmux` call sites across `src/verbs/**` and `src/core/**`, **none** passed `configFile`. Every one of them started tmux under the operator's `~/.tmux.conf`, which is exactly what §253's physical-impossibility argument says silently reshapes behaviour — an operator `base-index 1` would move panes under code that hardcodes `:0`.

The fix is at the seam, not the call sites: `createTmux` now appends `-f` on every invocation, defaulting to `getAtmuxTmuxConfPath()` when `configFile` is absent. `configFile` changes WHICH conf, never WHETHER there is one.

Defaulting rather than annotating ~40 sites is deliberate. The previous wording asked each production caller to be "audited before omission is treated as safe", and the audit's own result is the argument against that design: a rule 40 sites must individually remember is a rule that drifts, and it did.

Read-only intent is not an exemption. A tmux command against a dead socket can START the server — the reason the root AGENTS rule mandates probing with `[ -S <sock> ] && tmux -S <sock> has-session` — so a "just looking" path can create an unconfigured server just as easily as a spawning one. No attempt is made here to classify call sites as server-starting vs not; that classification is what the default makes unnecessary.

`ATMUX_TMUX_CONF` remains the documented operator opt-out, and `ATMUX_TMUX_CONF=/dev/null` still reaches stock tmux, because `getAtmuxTmuxConfPath` reads that env first.

Coverage is behavioural, not argv-shaped: a live server started with no `configFile` is asserted to report `base-index 1` (atmux.conf) rather than tmux's stock `0`, which proves the conf was honoured rather than merely passed. Sibling tests pin that an explicit `configFile` still wins and that the `/dev/null` opt-out still reaches stock. The first fails if the default is removed.
