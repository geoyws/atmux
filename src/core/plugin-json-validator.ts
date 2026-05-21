// Strict validator for `plugins/atmux/.claude-plugin/plugin.json` against
// the manifest shape declared in ADR-217 §D8.
//
// Why this lives separate from the doctor probe (src/verbs/doctor.ts ::
// checkSkillsPlugin) — that probe is intentionally LAX so a Claude Code
// schema bump doesn't flip every operator's `atmux-skills-plugin` row
// yellow. The strict validator here is what tooling that CARES about
// schema-conformance reaches for (install-wizard pre-write, CI checks,
// future bundle-publish scripts). Two distinct contracts:
//
//   - Lax (doctor.ts inline): "is this object-shaped + has name + has
//     skills array" — enough to know the symlink installed something
//     parseable.
//   - Strict (here): covers ADR-217 §D8 fields + skills[] entry shape +
//     empty-skills warning (opt-out edge case).
//
// Cross-link: the schema-pin integration test (tests/integration/
// skills-plugin-schema.test.ts, t-e57fe51e) validates plugin.json
// against a frozen JSON-Schema fixture; this validator is the
// runtime-callable equivalent.

export type ValidatePluginJsonResult =
  | { ok: true; skillCount: number }
  | { ok: true; warning: string; skillCount: number }
  | { ok: false; error: string };

interface PluginJsonShape {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  skills?: unknown;
  atmuxCompat?: unknown;
}

/** Pure: validate a parsed plugin.json against the ADR-217 §D8 shape.
 *  Returns a discriminated result — `ok: true` for valid / valid-with-
 *  warning, `ok: false` for any schema failure with a field-naming
 *  error string. Never throws.
 *
 *  Per ADR-217 §D8 the required top-level fields are name, version,
 *  description, skills. atmuxCompat is documented but optional. The
 *  warning channel surfaces `empty skills array` (opt-out edge case
 *  per t-dcf4f970 #5 — valid manifest but the plugin won't expose any
 *  invocations until skills are added). */
export function validatePluginJson(data: unknown): ValidatePluginJsonResult {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "manifest is not an object" };
  }
  const d = data as PluginJsonShape;

  if (typeof d.name !== "string" || d.name.length === 0) {
    return { ok: false, error: "missing required field: name" };
  }
  if (typeof d.version !== "string" || d.version.length === 0) {
    return { ok: false, error: "missing required field: version" };
  }
  if (typeof d.description !== "string" || d.description.length === 0) {
    return { ok: false, error: "missing required field: description" };
  }
  if (!Array.isArray(d.skills)) {
    return { ok: false, error: "field 'skills' is not an array" };
  }

  for (let i = 0; i < d.skills.length; i++) {
    const s = d.skills[i] as { name?: unknown; path?: unknown } | null;
    if (s === null || typeof s !== "object") {
      return { ok: false, error: `skills[${i}]: not an object` };
    }
    if (typeof s.name !== "string" || s.name.length === 0) {
      return { ok: false, error: `skills[${i}]: missing name` };
    }
    if (typeof s.path !== "string" || s.path.length === 0) {
      return { ok: false, error: `skills[${i}]: missing path` };
    }
  }

  if (d.skills.length === 0) {
    return {
      ok: true,
      warning: "empty skills array — plugin manifest is valid but exposes no invocations",
      skillCount: 0,
    };
  }
  return { ok: true, skillCount: d.skills.length };
}
