// Unit tests for tests/helpers/env-dump.ts (ADR-282).
//
// This helper is the repo's only sanctioned way to read a subprocess's
// environment, and `tests/regression/no-unfiltered-env-dump.test.ts` points
// every future author at it. If it silently stopped filtering, the guard
// would be advertising the leak it exists to prevent — so the filtering,
// the redaction and the input validation are each pinned here.

import { describe, expect, test } from "bun:test";
import {
  dumpEnvCommand,
  ENV_DUMP_ALLOWLIST,
  parseEnvDump,
  REDACTED,
  SENSITIVE_NAME_RE,
} from "../../helpers/env-dump.ts";

describe("ENV_DUMP_ALLOWLIST", () => {
  test("carries exactly the four colour/terminal names, and nothing secret-shaped", () => {
    expect([...ENV_DUMP_ALLOWLIST]).toEqual(["NO_COLOR", "COLORTERM", "TERM", "TMUX"]);
    for (const name of ENV_DUMP_ALLOWLIST) {
      expect({ name, sensitive: SENSITIVE_NAME_RE.test(name) }).toEqual({ name, sensitive: false });
    }
  });
});

describe("dumpEnvCommand", () => {
  test("filters inside the probe — the allowlist is in the command, not applied later", () => {
    const cmd = dumpEnvCommand("/tmp/probe.out");
    expect(cmd).toBe(
      `sh -c 'env | grep -E "^(NO_COLOR|COLORTERM|TERM|TMUX)=" > /tmp/probe.out || true; sleep 3'`,
    );
  });

  test("honours a caller-supplied variable set and keep-alive", () => {
    expect(dumpEnvCommand("/tmp/o", ["TERM"], 9)).toBe(
      `sh -c 'env | grep -E "^(TERM)=" > /tmp/o || true; sleep 9'`,
    );
  });

  test("carries `|| true`, because 'no match' is a legitimate result", () => {
    // The leg that asserts NO_COLOR is ABSENT gets an empty grep, which
    // exits 1. Without `|| true` the pane dies non-zero, writes nothing,
    // and the test times out on a missing file instead of asserting.
    expect(dumpEnvCommand("/tmp/o")).toContain("|| true");
  });

  test("refuses a quoted outPath — it is spliced into a shell word", () => {
    expect(() => dumpEnvCommand("/tmp/a'b")).toThrow(/must not contain quotes/);
    expect(() => dumpEnvCommand('/tmp/a"b')).toThrow(/must not contain quotes/);
  });

  test("refuses a name that is not a plain identifier — it is spliced into an ERE", () => {
    expect(() => dumpEnvCommand("/tmp/o", ["TERM|.*"])).toThrow(/not a plain variable name/);
    expect(() => dumpEnvCommand("/tmp/o", [".*"])).toThrow(/not a plain variable name/);
  });

  test("refuses an empty allowlist — that would dump everything", () => {
    expect(() => dumpEnvCommand("/tmp/o", [])).toThrow(/empty allowlist/);
  });
});

describe("parseEnvDump", () => {
  test("keeps allowlisted names and drops everything else", () => {
    const dump = [
      "TERM=tmux-256color",
      "ANTHROPIC_API_TOKEN=sk-should-never-appear",
      "NO_COLOR=1",
      "PATH=/usr/bin",
      "COLORTERM=truecolor",
      "",
    ].join("\n");
    expect(parseEnvDump(dump)).toBe("TERM=tmux-256color\nNO_COLOR=1\nCOLORTERM=truecolor");
  });

  test("a value containing '=' survives intact", () => {
    expect(parseEnvDump("TMUX=/tmp/s,123,0=x")).toBe("TMUX=/tmp/s,123,0=x");
  });

  test("ignores malformed lines rather than emitting a bare name", () => {
    expect(parseEnvDump("TERM\n=orphan\nTERM=ok")).toBe("TERM=ok");
  });

  test("redacts a credential-shaped name a caller widened `vars` to include", () => {
    const dump = ["TERM=xterm", "DISCORD_WEBHOOK=https://example.invalid/hook"].join("\n");
    expect(parseEnvDump(dump, ["TERM", "DISCORD_WEBHOOK"])).toBe(
      `TERM=xterm\nDISCORD_WEBHOOK=${REDACTED}`,
    );
  });

  test("redaction covers every name class SENSITIVE_NAME_RE claims", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "CLIENT_SECRET",
      "SSH_KEY",
      "DB_PASSWORD",
      "PGPASSWD",
      "AZURE_DEVOPS_PAT",
      "SLACK_WEBHOOK",
      "GCP_CREDENTIAL",
      "AUTHORIZATION",
      "lowercase_token",
    ]) {
      expect(parseEnvDump(`${name}=must-not-appear`, [name])).toBe(`${name}=${REDACTED}`);
    }
  });
});
