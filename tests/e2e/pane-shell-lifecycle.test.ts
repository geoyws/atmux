import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendTarget, Target, TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { launchAgentInPane, resolveOnlyPane } from "../../src/core/agent-pane.ts";
import { shellPaneCommand } from "../../src/core/tui-cmd.ts";
import { createCanonicalAtmuxTmux, setCanonicalAtmuxTmuxHome } from "../helpers/tmux.ts";

setDefaultTimeout(60_000);

let socketDir: string;
let homeDir: string;
let binDir: string;
let workDir: string;
let tmux: TmuxNamespace;
let restoreHome: (() => void) | undefined;
let priorTmux: string | undefined;
let priorPath: string | undefined;
let session = "";

async function waitFor<T>(probe: () => T | Promise<T>, ok: (value: T) => boolean): Promise<T> {
  let last = await probe();
  for (let i = 0; i < 120 && !ok(last); i++) {
    // Live tmux is an external process; fake timers cannot advance its state.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 100);
    await promise;
    last = await probe();
  }
  return last;
}

function sendTarget(target: Target): SendTarget {
  return { kind: "service", team: "pane-shell-lifecycle", target };
}

async function runInPane(target: Target, command: string, output: string): Promise<string> {
  await tmux.pane.sendKeys({
    target: sendTarget(target),
    keys: `${command} > ${output} 2>&1`,
    enter: true,
  });
  return await waitFor(
    async () => await readFile(output, "utf8").catch(() => ""),
    (text) => text.length > 0,
  );
}

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-pane-shell-sock-"));
  homeDir = await mkdtemp(join(tmpdir(), "atmux-pane-shell-home-"));
  binDir = await mkdtemp(join(tmpdir(), "atmux-pane-shell-bin-"));
  workDir = await mkdtemp(join(tmpdir(), "atmux-pane-shell-work-"));
  restoreHome = setCanonicalAtmuxTmuxHome(homeDir);
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  priorPath = process.env.PATH;
  process.env.PATH = `${binDir}:${priorPath ?? ""}`;
  tmux = createCanonicalAtmuxTmux({ socketPath: join(socketDir, "sock") });
  session = `pane_shell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
});

afterEach(async () => {
  await tmux.server.killServer().catch(() => {});
  restoreHome?.();
  restoreHome = undefined;
  if (priorTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = priorTmux;
  if (priorPath === undefined) delete process.env.PATH;
  else process.env.PATH = priorPath;
  await Promise.all(
    [socketDir, homeDir, binDir, workDir].map(
      async (dir) => await rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("two-stage agent pane lifecycle", () => {
  test("waits for the shell, launches the TUI as its child, and returns to zsh on exit", async () => {
    const stub = join(binDir, "stub-tui");
    await writeFile(
      stub,
      "#!/usr/bin/env bun\nconsole.log('STUB_TUI_UP');\nprocess.stdin.resume();\n",
      "utf8",
    );
    await chmod(stub, 0o755);

    await tmux.session.newSession({
      name: session,
      detached: true,
      windowName: "agent",
      cwd: workDir,
      shellCommand: shellPaneCommand(),
    });
    const target = `${session}:agent`;
    const created = (await tmux.window.listWindows(session)).filter(
      (window) => window.name === "agent",
    );
    expect(created.length).toBe(1);
    const window = created[0];
    if (window === undefined) throw new Error("agent window missing");
    const paneId = await resolveOnlyPane(
      tmux,
      { sessionName: session, windowIndex: window.index },
      session,
      window.index,
    );
    expect(
      await waitFor(
        async () =>
          (await tmux.pane.displayMessage({ target, format: "#{pane_current_command}" })).trim(),
        (command) => command === "zsh",
      ),
    ).toBe("zsh");

    expect(
      await launchAgentInPane({
        tmux,
        paneId,
        intent: { kind: "service", team: "pane-shell-lifecycle" },
        command: "stub-tui",
      }),
    ).toBe("launched");
    expect(
      await waitFor(
        async () => await tmux.pane.capturePane({ target }),
        (text) => text.includes("STUB_TUI_UP"),
      ),
    ).toContain("STUB_TUI_UP");

    await tmux.pane.sendKeys({ target: sendTarget(target), keys: "C-c", enter: false });
    expect(
      await waitFor(
        async () =>
          (await tmux.pane.displayMessage({ target, format: "#{pane_current_command}" })).trim(),
        (command) => command === "zsh",
      ),
    ).toBe("zsh");
    expect(await runInPane(target, "echo PANE_ALIVE", join(workDir, "agent.out"))).toContain(
      "PANE_ALIVE",
    );
  });
});

describe("manual panes with no explicit command", () => {
  test("new-session, new-window, and split-window each open a usable login zsh prompt", async () => {
    await tmux.session.newSession({
      name: session,
      detached: true,
      windowName: "initial",
      cwd: workDir,
    });
    const manual = await tmux.window.newWindow({
      sessionName: session,
      name: "manual",
      detached: true,
      cwd: workDir,
    });
    const split = await tmux.pane.splitWindow({
      target: manual,
      detached: true,
      cwd: workDir,
    });

    const targets: Array<[string, Target]> = [
      ["initial", `${session}:initial`],
      ["manual", manual],
      ["split", split],
    ];
    for (const [name, target] of targets) {
      expect(
        await waitFor(
          async () =>
            (await tmux.pane.displayMessage({ target, format: "#{pane_current_command}" })).trim(),
          (command) => command === "zsh",
        ),
      ).toBe("zsh");
      expect(
        await runInPane(target, `echo ${name.toUpperCase()}_ALIVE`, join(workDir, `${name}.out`)),
      ).toContain(`${name.toUpperCase()}_ALIVE`);
    }
  });
});
