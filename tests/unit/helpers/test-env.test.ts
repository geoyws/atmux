// Unit tests for tests/helpers/test-env.ts (ADR-283).
//
// ADR-283's claim is that the test runner's environment does not contain
// the operator's credentials, so no test can leak them WHATEVER SHAPE it
// uses. That is a strong claim, and these are the legs that make it
// falsifiable rather than aspirational:
//
//   - the allowlist admits everything the repository actually reads
//     (scanned from source, so a new read cannot silently break the
//     suite or silently widen the wall);
//   - it withholds the credential-shaped variables that live inside an
//     allowed prefix;
//   - a child handed the scrubbed environment cannot see a withheld
//     variable — checked through a whole-environment capture, i.e. the
//     shape the ADR-282 source guard cannot recognise;
//   - the premise the whole design rests on (Bun's default child
//     environment is a start-time snapshot) is pinned, because if it ever
//     stops being true the reasoning in ADR-283 §D1 changes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CREDENTIAL_NAME_RE,
  countCredentialShapedNames,
  isAllowedTestEnvName,
  parsePassthrough,
  scrubTestEnv,
  TEST_ENV_ALLOW_EXACT,
  TEST_ENV_ALLOW_PREFIXES,
  TEST_ENV_OK_VAR,
  TEST_ENV_PASSTHROUGH_VAR,
} from "../../helpers/test-env.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Names the repository reads but the runner deliberately does NOT carry,
 * each with the reason it is withheld.
 *
 * This is the escape valve for the source-scan leg below, and it is
 * deliberately a table rather than a bare list: an entry with no reason
 * is how an allowlist quietly becomes a formality.
 */
const DELIBERATELY_WITHHELD: Readonly<Record<string, string>> = {
  ATMUX_DISCORD_WEBHOOK: "a live webhook URL; every test that needs it exports its own mock",
  ATMUX_VOICE_TOKEN: "a shared secret (git-crypt'd dotfiles); tests supply their own",
  ATMUX_VOX_TOKEN: "a shared secret (≥32 chars, ADR-272 §Security); tests supply their own",
  GIT_CONFIG_COUNT: "set by the test that needs it; inheriting an operator override is worse",
  GIT_CONFIG_KEY_0: "set by the test that needs it",
  GIT_CONFIG_VALUE_0: "set by the test that needs it",
};

/** Every `process.env.<NAME>` / `process.env["<NAME>"]` reference in the
 *  tree, excluding comment lines — prose about `process.env.FOO` is not a
 *  read, and counting it would force fictional names into the tables
 *  above. Same comment rule as the ADR-282 guard, for the same reason. */
function envNamesReadInSource(): string[] {
  const names = new Set<string>();
  const re = /process\.env(?:\.([A-Za-z_]\w*)|\[["'`]([A-Za-z_]\w*)["'`]\])/g;
  const comment = /^\s*(\/\/|\/\*|\*|#)/;
  for (const root of ["src", "tests", "scripts", "bin"]) {
    const glob = new Bun.Glob("**/*.{ts,tsx,js,mjs}");
    for (const rel of glob.scanSync({ cwd: join(REPO_ROOT, root), onlyFiles: true, dot: false })) {
      if (rel.includes("node_modules/")) continue;
      for (const line of readFileSync(join(REPO_ROOT, root, rel), "utf8").split("\n")) {
        if (comment.test(line)) continue;
        for (const m of line.matchAll(re)) {
          const name = m[1] ?? m[2];
          if (name !== undefined) names.add(name);
        }
      }
    }
  }
  return [...names].sort();
}

describe("the allowlist covers what the repository actually reads", () => {
  test("every process.env read is either admitted or withheld with a stated reason", () => {
    // The leg that keeps the allowlist honest as the code moves. A new
    // `process.env.FOO` read has to be classified — admitted, or listed
    // in DELIBERATELY_WITHHELD with a reason — before this goes green.
    const unclassified = envNamesReadInSource().filter(
      (n) =>
        !isAllowedTestEnvName(n) &&
        !CREDENTIAL_NAME_RE.test(n) &&
        DELIBERATELY_WITHHELD[n] === undefined,
    );
    expect({ unclassified }).toEqual({ unclassified: [] });
  });

  test("the source scan is not vacuous — it finds the names we know are there", () => {
    // `envNamesReadInSource()` returning [] would make the leg above pass
    // for the wrong reason, exactly the fault ADR-283 §A3 fixes in the
    // ADR-282 guard.
    const found = new Set(envNamesReadInSource());
    for (const known of ["HOME", "PATH", "TMPDIR", "NO_COLOR", "ATMUX_DIR", "TMUX"]) {
      expect({ known, found: found.has(known) }).toEqual({ known, found: true });
    }
    expect(found.size).toBeGreaterThan(30);
  });

  test("the withheld table lists a reason for every entry", () => {
    for (const [name, why] of Object.entries(DELIBERATELY_WITHHELD)) {
      expect({ name, hasReason: why.length > 10 }).toEqual({ name, hasReason: true });
    }
  });
});

describe("scrubTestEnv", () => {
  test("drops a name the allowlist does not know, whatever it holds", () => {
    const { env } = scrubTestEnv({ PATH: "/usr/bin", DATABASE_URL: "postgres://u:p@h/db" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("drops a credential-shaped name that an allowed PREFIX let in", () => {
    // This is the pass the prefixes make necessary: `ATMUX_` is allowed
    // wholesale, and three real credentials live inside it.
    const { env } = scrubTestEnv({
      ATMUX_DIR: "/tmp/.atmux",
      ATMUX_VOX_TOKEN: "must-not-survive",
      ATMUX_DISCORD_WEBHOOK: "must-not-survive",
      ATMUX_VOICE_TOKEN: "must-not-survive",
    });
    expect(env).toEqual({ ATMUX_DIR: "/tmp/.atmux" });
  });

  test("counts what it withheld and never returns the names", () => {
    // The API shape is the assertion: a `removedNames` field would be one
    // `console.log` from a smaller version of the 2026-08-28 disclosure.
    const r = scrubTestEnv({ PATH: "/usr/bin", GITHUB_TOKEN: "x", NPM_CONFIG_FOO: "y" });
    expect(Object.keys(r).sort()).toEqual(["env", "keptCount", "passedThrough", "removedCount"]);
    expect({ keptCount: r.keptCount, removedCount: r.removedCount }).toEqual({
      keptCount: 1,
      removedCount: 2,
    });
  });

  test("skips an undefined value and a name that is not shell-shaped", () => {
    const { env, removedCount } = scrubTestEnv({
      PATH: "/usr/bin",
      HOME: undefined,
      "BASH_FUNC_x%%": "() { :; }",
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(removedCount).toBe(1);
  });

  test("the escape hatch admits a named variable and reports it", () => {
    const { env, passedThrough } = scrubTestEnv({ PATH: "/usr/bin", GH_TOKEN: "deliberate" }, [
      "GH_TOKEN",
    ]);
    expect(env).toEqual({ PATH: "/usr/bin", GH_TOKEN: "deliberate" });
    expect(passedThrough).toEqual(["GH_TOKEN"]);
  });

  test("keeps the whole terminal/tmux quartet the colour suites assert on", () => {
    const source = { NO_COLOR: "1", COLORTERM: "", TERM: "xterm", TMUX: "/tmp/s,1,0" };
    expect(scrubTestEnv(source).env).toEqual(source);
  });
});

describe("the allowlist and the credential filter, as data", () => {
  test("no allowlisted exact name is itself credential-shaped", () => {
    for (const name of TEST_ENV_ALLOW_EXACT) {
      expect({ name, credential: CREDENTIAL_NAME_RE.test(name) }).toEqual({
        name,
        credential: false,
      });
    }
  });

  test("the marker and the escape hatch are inside an allowed prefix", () => {
    // Both are read by the preload / the wrapper from the CHILD's
    // environment, so a scrub that dropped them would break the handshake.
    for (const name of [TEST_ENV_OK_VAR, TEST_ENV_PASSTHROUGH_VAR]) {
      expect({ name, allowed: isAllowedTestEnvName(name) }).toEqual({ name, allowed: true });
    }
  });

  test("every prefix ends with an underscore, so it cannot swallow a sibling", () => {
    for (const p of TEST_ENV_ALLOW_PREFIXES) {
      expect({ p, ok: p.endsWith("_") }).toEqual({ p, ok: true });
    }
  });

  test("countCredentialShapedNames counts names, not values", () => {
    expect(countCredentialShapedNames({ PATH: "TOKEN=leak", GH_TOKEN: "x", HOME: "/h" })).toBe(1);
  });
});

describe("parsePassthrough", () => {
  test("splits, trims, and drops anything that is not a variable name", () => {
    expect(parsePassthrough(" A , B_2 ,,$(id), C-D ")).toEqual(["A", "B_2"]);
  });

  test("an unset or empty value is an empty list", () => {
    expect(parsePassthrough(undefined)).toEqual([]);
    expect(parsePassthrough("")).toEqual([]);
  });
});

describe("the property ADR-283 actually claims", () => {
  test("a child handed the scrubbed environment cannot see a withheld variable", () => {
    // Checked through a WHOLE-ENVIRONMENT capture in the child, because
    // that is precisely the shape the ADR-282 source guard cannot
    // recognise and therefore the shape the claim has to survive. The
    // capture is counted inside the child and only a count crosses back.
    const poisoned = { ...process.env, ATMUX_PROBE_TOKEN: "sentinel-not-a-real-secret" };
    const { env } = scrubTestEnv(poisoned);
    const r = Bun.spawnSync({
      cmd: ["sh", "-c", 'env | grep -c "^ATMUX_PROBE_TOKEN=" || true'],
      env,
      stdout: "pipe",
    });
    expect(r.stdout.toString().trim()).toBe("0");
  });

  test("control — the SAME probe does see it when the environment is unscrubbed", () => {
    // Without this leg the assertion above could be green because the
    // probe never worked. `env -i`-style construction is avoided: this is
    // the same command, the same shape, only the environment differs.
    const poisoned = { ...process.env, ATMUX_PROBE_TOKEN: "sentinel-not-a-real-secret" };
    const r = Bun.spawnSync({
      cmd: ["sh", "-c", 'env | grep -c "^ATMUX_PROBE_TOKEN=" || true'],
      env: poisoned,
      stdout: "pipe",
    });
    expect(r.stdout.toString().trim()).toBe("1");
  });

  test("premise: Bun's default child environment is a start-time snapshot", () => {
    // Not a test of atmux — a test of the FACT ADR-283 §D1 is built on.
    // Measured on bun 1.3.14: a variable set on `process.env` after
    // startup does not reach a child spawned without an explicit `env`.
    // The consequence is that a preload which merely `delete`d secrets
    // from `process.env` would NOT stop `Bun.spawnSync({ cmd: ["env"] })`
    // from dumping them, which is why the wall is the wrapper and the
    // preload is only a tripwire. If this ever goes red, that reasoning
    // needs revisiting rather than the assertion loosening.
    // `printenv NAME || echo` rather than a `${NAME-default}` expansion:
    // the expansion form is a false positive for biome's
    // noTemplateCurlyInString (it reads POSIX parameter expansion as a
    // stray JS template literal), and a suppression comment is a worse
    // answer than a spelling that does not need one.
    const probe = "printenv ATMUX_SNAPSHOT_PROBE || echo ABSENT";
    process.env.ATMUX_SNAPSHOT_PROBE = "set-after-startup";
    try {
      const dflt = Bun.spawnSync({ cmd: ["sh", "-c", probe], stdout: "pipe" })
        .stdout.toString()
        .trim();
      const explicit = Bun.spawnSync({
        cmd: ["sh", "-c", probe],
        env: { ...process.env },
        stdout: "pipe",
      })
        .stdout.toString()
        .trim();
      expect({ dflt, explicit }).toEqual({ dflt: "ABSENT", explicit: "set-after-startup" });
    } finally {
      delete process.env.ATMUX_SNAPSHOT_PROBE;
    }
  });
});
