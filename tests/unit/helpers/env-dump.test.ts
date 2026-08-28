// Unit tests for tests/helpers/env-dump.ts (ADR-282).
//
// This helper is the repo's only sanctioned way to read a subprocess's
// environment. If it silently stopped filtering, it would be advertising
// the leak it exists to prevent — so the filtering, the redaction and the
// input validation are each pinned here.

import { describe, expect, test } from "bun:test";
import {
  dumpEnvCommand,
  ENV_DUMP_ALLOWLIST,
  ENV_DUMP_MAX_VALUE_LEN,
  ENV_DUMP_MAX_VARS,
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

  test("accepts the shape every real call site produces — a mkdtemp path", () => {
    // macOS `mkdtemp` under $TMPDIR, which is where every probe writes.
    // Pinned so the tightened validation cannot start refusing the
    // legitimate input while still admitting metacharacters.
    expect(() =>
      dumpEnvCommand("/var/folders/b0/z0c26pnn19b651fr12h0sbf00000gn/T/atmux-nc-abc123/s.env"),
    ).not.toThrow();
  });

  test("refuses every shell metacharacter in outPath, not just a quote", () => {
    // The path is spliced into `… > <path> || true` inside a
    // single-quoted `sh -c '…'`. Refusing only quotes left `;`, `&`,
    // backtick, `$(` and a newline as live injection routes.
    for (const bad of [
      "/tmp/a'b",
      '/tmp/a"b',
      "/tmp/a;rm -rf x",
      "/tmp/a&b",
      "/tmp/a|b",
      "/tmp/a`id`",
      "/tmp/a$(id)",
      "/tmp/a b",
      "/tmp/a\nb",
      "/tmp/a>b",
      "/tmp/a*b",
      "/tmp/a{b}",
      "",
    ]) {
      expect(() => dumpEnvCommand(bad)).toThrow(/outPath must be a plain path/);
    }
  });

  test("refuses a name that is not a plain identifier — it is spliced into an ERE", () => {
    expect(() => dumpEnvCommand("/tmp/o", ["TERM|.*"])).toThrow(/not a plain variable name/);
    expect(() => dumpEnvCommand("/tmp/o", [".*"])).toThrow(/not a plain variable name/);
  });

  test("refuses an empty allowlist — that would dump everything", () => {
    expect(() => dumpEnvCommand("/tmp/o", [])).toThrow(/empty allowlist/);
  });

  test("refuses an allowlist wide enough to be a dump in disguise", () => {
    // Without a cap the sanctioned helper builds the very thing
    // it exists to prevent, at a call site the ADR-282 source guard reads
    // as an ordinary helper call.
    const wide = Array.from({ length: ENV_DUMP_MAX_VARS + 1 }, (_, i) => `VAR_${i}`);
    expect(() => dumpEnvCommand("/tmp/o", wide)).toThrow(/refusing to collect/);
    const atCap = wide.slice(0, ENV_DUMP_MAX_VARS);
    expect(() => dumpEnvCommand("/tmp/o", atCap)).not.toThrow();
  });

  test("refuses to collect a credential-shaped name at all", () => {
    for (const name of ["GITHUB_TOKEN", "DB_PASSWORD", "SLACK_WEBHOOK", "AWS_SECRET_ACCESS_KEY"]) {
      expect(() => dumpEnvCommand("/tmp/o", ["TERM", name])).toThrow(/credential-shaped name/);
    }
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

  test("the pattern is anchored — it does not redact PATH, MONKEY or GIT_AUTHOR_NAME", () => {
    // The unanchored version matched `PAT` inside `PATH`
    // and `KEY` inside `MONKEY`. A filter that mangles `PATH` is a filter
    // someone switches off.
    for (const name of ["PATH", "MONKEY", "COMPATIBILITY", "GIT_AUTHOR_NAME", "KEYCHAIN"]) {
      expect({ name, sensitive: SENSITIVE_NAME_RE.test(name) }).toEqual({ name, sensitive: false });
    }
  });

  test("a repeated name redacts EVERY sighting, in either order", () => {
    // The line-oriented filter's hole: a secret whose value contains
    // "\nTERM=" produces a line that looks exactly like a legitimate TERM
    // assignment, and that line is part of the secret. A real environment
    // cannot hold a name twice, so the repeat is the tell.
    //
    // The first repair kept the FIRST sighting and redacted the rest,
    // which is order-dependent — and the order is chosen by the secret,
    // not by us. Measured 2026-08-29 against that version: with the
    // fragment SECOND it redacted the fragment; with the fragment FIRST it
    // printed the fragment VERBATIM and redacted the legitimate value.
    // Both orders are asserted here so that regression cannot come back.
    //
    // The payload is a placeholder string. Never put a real credential,
    // or a real fragment of one, in a test fixture.
    const FRAGMENT = "PLACEHOLDER-FRAGMENT-NOT-A-REAL-SECRET";
    const both = `TERM=${REDACTED}\nTERM=${REDACTED}`;
    expect({
      fragmentSecond: parseEnvDump(`TERM=tmux-256color\nTERM=${FRAGMENT}`),
      fragmentFirst: parseEnvDump(`TERM=${FRAGMENT}\nTERM=tmux-256color`),
    }).toEqual({ fragmentSecond: both, fragmentFirst: both });
  });

  test("an implausibly long value is redacted even under an allowlisted name", () => {
    const long = "x".repeat(ENV_DUMP_MAX_VALUE_LEN + 1);
    expect(parseEnvDump(`TERM=${long}`)).toBe(`TERM=${REDACTED}`);
    const atCap = "x".repeat(ENV_DUMP_MAX_VALUE_LEN);
    expect(parseEnvDump(`TERM=${atCap}`)).toBe(`TERM=${atCap}`);
  });
});
