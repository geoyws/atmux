import { describe, expect, test } from "bun:test";
import {
  assessBotReadiness,
  botComposerEmpty,
  chooseSuperbotTarget,
  completeSuperbotOffer,
  formatSuperbotOffer,
  reserveSuperbotOffer,
  SUPERBOT_METADATA_KEY,
  type SuperbotCandidate,
} from "../../../src/core/superbot.ts";
import type { CockpitSuperbotRoute } from "../../../src/schema/cockpit.ts";

const route: CockpitSuperbotRoute = {
  board: "atmux",
  tag: "dispatch",
  defaultTeam: "atmux",
  fallbackTeams: ["geoyws", "hax"],
};

function candidate(metadata: Record<string, unknown> = {}): SuperbotCandidate {
  return {
    id: "t-1234",
    type: "task",
    status: "todo",
    tags: ["dispatch", "cockpit"],
    metadata,
  };
}

describe("superbot route/cooldown policy", () => {
  test("offers default first, then one ordered fallback after each interval", () => {
    const first = chooseSuperbotTarget({
      route,
      candidate: candidate(),
      nowMs: 1_000,
      intervalMs: 1_800_000,
      fallbackAfterIntervals: 1,
    });
    expect(first).toEqual({ team: "atmux", reason: "default", attempt: 1 });

    const reserved = reserveSuperbotOffer({
      previous: null,
      route,
      team: "atmux",
      attempt: 1,
      nowMs: 1_000,
    });
    const delivered = completeSuperbotOffer(reserved);
    const withState = candidate({ [SUPERBOT_METADATA_KEY]: delivered });
    expect(
      chooseSuperbotTarget({
        route,
        candidate: withState,
        nowMs: 1_000 + 1_799_999,
        intervalMs: 1_800_000,
        fallbackAfterIntervals: 1,
      }),
    ).toBeNull();
    expect(
      chooseSuperbotTarget({
        route,
        candidate: withState,
        nowMs: 1_000 + 1_800_000,
        intervalMs: 1_800_000,
        fallbackAfterIntervals: 1,
      }),
    ).toEqual({ team: "geoyws", reason: "fallback", attempt: 1 });
  });

  test("crash reservation retries the same owner once, then advances", () => {
    const pending = reserveSuperbotOffer({
      previous: null,
      route,
      team: "atmux",
      attempt: 1,
      nowMs: 1_000,
    });
    const retry = chooseSuperbotTarget({
      route,
      candidate: candidate({ [SUPERBOT_METADATA_KEY]: pending }),
      nowMs: 2_000,
      intervalMs: 1_000,
      fallbackAfterIntervals: 1,
    });
    expect(retry).toEqual({ team: "atmux", reason: "pending-retry", attempt: 2 });

    const twice = reserveSuperbotOffer({
      previous: pending,
      route,
      team: "atmux",
      attempt: 2,
      nowMs: 2_000,
    });
    expect(
      chooseSuperbotTarget({
        route,
        candidate: candidate({ [SUPERBOT_METADATA_KEY]: twice }),
        nowMs: 3_000,
        intervalMs: 1_000,
        fallbackAfterIntervals: 1,
      }),
    ).toEqual({ team: "geoyws", reason: "fallback", attempt: 1 });
  });
});

describe("superbot offer and readiness", () => {
  test("offer exposes only routing identity and exact claim/context commands", () => {
    const message = formatSuperbotOffer({
      board: "atmux",
      taskId: "t-1234",
      tags: ["dispatch", "cockpit"],
      team: "atmux",
    });
    expect(message).toContain("kb claim t-1234 --project atmux --as bot@atmux --json");
    expect(message).toContain("kb ctx t-1234 --project atmux --json");
    expect(message).toContain("If the claim is refused, stop immediately");
    expect(message).not.toContain("title:");
    expect(message).not.toContain("body:");
  });

  test("stable empty Claude composer is ready", () => {
    const capture = "work complete\n❯ \n⏵⏵ auto mode on";
    expect(
      assessBotReadiness({
        tui: "claude",
        held: false,
        hasLiveLease: false,
        paneDead: false,
        paneCurrentCommand: "claude",
        firstCapture: capture,
        secondCapture: capture,
      }),
    ).toBe("ready");
  });

  test("bottom-most Claude composer governs manual-input precedence", () => {
    expect(botComposerEmpty("claude", "❯ old command\n● done\n❯ \nfooter")).toBe(true);
    expect(botComposerEmpty("claude", "❯ \n● done\n❯ operator draft\nfooter")).toBe(false);
    expect(botComposerEmpty("claude", '❯ Try "fix lint errors"\nfooter')).toBe(true);
    expect(botComposerEmpty("codex", "❯ \nfooter")).toBe(false);
    expect(
      assessBotReadiness({
        tui: "claude",
        held: false,
        hasLiveLease: false,
        paneDead: false,
        paneCurrentCommand: "sh",
        firstCapture: "❯ \n● done\n❯ operator draft\n⏵⏵ auto mode on",
        secondCapture: "❯ \n● done\n❯ operator draft\n⏵⏵ auto mode on",
      }),
    ).toBe("composer-not-empty");
  });

  test("stable Claude chrome is ready even when tmux reports sh", () => {
    const capture = "work complete\n❯ \n⏵⏵ auto mode on";
    expect(
      assessBotReadiness({
        tui: "claude",
        held: false,
        hasLiveLease: false,
        paneDead: false,
        paneCurrentCommand: "sh",
        firstCapture: capture,
        secondCapture: capture,
      }),
    ).toBe("ready");
  });

  test("manual typing, hold, live lease, instability, shell and unsupported TUI all defer", () => {
    const base = {
      tui: "claude",
      held: false,
      hasLiveLease: false,
      paneDead: false,
      paneCurrentCommand: "claude",
      firstCapture: "❯ hello\n⏵⏵ auto mode on",
      secondCapture: "❯ hello\n⏵⏵ auto mode on",
    };
    expect(assessBotReadiness(base)).toBe("composer-not-empty");
    expect(assessBotReadiness({ ...base, held: true })).toBe("held");
    expect(assessBotReadiness({ ...base, hasLiveLease: true })).toBe("live-lease");
    expect(assessBotReadiness({ ...base, secondCapture: `${base.secondCapture}.` })).toBe(
      "unstable",
    );
    expect(
      assessBotReadiness({
        ...base,
        paneCurrentCommand: "zsh",
        firstCapture: "geo@hax:~/work$ ",
        secondCapture: "geo@hax:~/work$ ",
      }),
    ).toBe("shell");
    expect(assessBotReadiness({ ...base, tui: "codex" })).toBe("unsupported-verifier");
  });
});
