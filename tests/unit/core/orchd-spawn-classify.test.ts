// ADR-231 §D5 — failure recovery classifier unit coverage.
//
// Pins per t-13-2f8b0d92 AC:
//   - Each class matches its ADR-231 §D5 regex signature.
//   - Boundary cases: empty stderr → hard; partial-match → hard.
//   - Both transient signatures present → host-pressure wins
//     (encoded precedence per the module's docblock).

import { describe, expect, test } from "bun:test";
import {
  classifySpawnFailure,
  type SpawnFailureClass,
} from "../../../src/core/orchd-spawn-classify.ts";

describe("classifySpawnFailure — host-pressure (ADR-184 refusal signature)", () => {
  test("exact ADR-184 refusal text classifies as host-pressure", () => {
    const stderr = "spawn-epic: host-wide cap (8) reached — try again later";
    expect(classifySpawnFailure(stderr)).toBe("host-pressure");
  });

  test("digit count > 1 still matches (cap (12) reached)", () => {
    expect(classifySpawnFailure("foo host-wide cap (12) reached bar")).toBe("host-pressure");
  });

  test("whitespace-tolerant between cap, parens, reached", () => {
    expect(classifySpawnFailure("host-wide cap  (8)  reached")).toBe("host-pressure");
  });

  test("partial-match (no `(N) reached` suffix) → hard", () => {
    expect(classifySpawnFailure("the host-wide cap is configured")).toBe("hard");
  });

  test("partial-match (`(N) reached` without `host-wide cap` prefix) → hard", () => {
    expect(classifySpawnFailure("limit (8) reached")).toBe("hard");
  });
});

describe("classifySpawnFailure — eligibility-race (ADR-225 refusal signature)", () => {
  test("standard `eligible=false: <reason>` text", () => {
    expect(classifySpawnFailure("eligible=false: dep e-deadbeef not done")).toBe(
      "eligibility-race",
    );
  });

  test("multiple blockers — first matches", () => {
    const stderr = "eligible=false: dep eX not done; eligible=false: dep eY not done";
    expect(classifySpawnFailure(stderr)).toBe("eligibility-race");
  });

  test("partial-match (`eligible=false` without colon-space) → hard", () => {
    expect(classifySpawnFailure("eligible=false")).toBe("hard");
    expect(classifySpawnFailure("eligible=false:nodigit")).toBe("hard"); // missing space after colon
  });

  test("eligible=true prose does NOT false-positive", () => {
    expect(classifySpawnFailure("eligible=true; ready to spawn")).toBe("hard");
  });
});

describe("classifySpawnFailure — hard (default)", () => {
  test("empty stderr → hard", () => {
    expect(classifySpawnFailure("")).toBe("hard");
  });

  test("unrelated error (invalid roster) → hard", () => {
    expect(classifySpawnFailure("spawn-epic: unknown roster preset 'lol'")).toBe("hard");
  });

  test("git error → hard", () => {
    expect(classifySpawnFailure("fatal: not a git repository")).toBe("hard");
  });

  test("multiline blob with only unrelated content → hard", () => {
    const stderr = [
      "spawn-epic: failed to write team.json",
      "EACCES: permission denied",
      "exit 1",
    ].join("\n");
    expect(classifySpawnFailure(stderr)).toBe("hard");
  });
});

describe("classifySpawnFailure — precedence: host-pressure wins over eligibility-race", () => {
  test("both signatures present → host-pressure (ADR-231 §D5 module-doc precedence)", () => {
    // Synthetic stderr that name-checks both substrates. Real spawn-
    // epic would not emit both in one breath, but encoding the
    // precedence here prevents future drift if a wrapper accidentally
    // concatenates probes from both layers.
    const stderr =
      "spawn-epic refused: host-wide cap (8) reached; also eligible=false: predicate held";
    expect(classifySpawnFailure(stderr)).toBe("host-pressure");
  });

  test("both signatures present in opposite order → host-pressure still wins", () => {
    const stderr =
      "eligible=false: dep eX not done — and also host-wide cap (8) reached upstream";
    expect(classifySpawnFailure(stderr)).toBe("host-pressure");
  });
});

describe("classifySpawnFailure — return type is the documented union", () => {
  test("each branch returns the literal union members", () => {
    const samples: Array<{ stderr: string; expected: SpawnFailureClass }> = [
      { stderr: "host-wide cap (8) reached", expected: "host-pressure" },
      { stderr: "eligible=false: blocker", expected: "eligibility-race" },
      { stderr: "random error", expected: "hard" },
      { stderr: "", expected: "hard" },
    ];
    for (const s of samples) {
      const result: SpawnFailureClass = classifySpawnFailure(s.stderr);
      expect(result).toBe(s.expected);
    }
  });
});
