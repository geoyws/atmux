// Integration test — pin plugins/atmux/.claude-plugin/plugin.json
// against a frozen Claude Code plugin-manifest schema.
//
// Per ADR-217 §D8 + the EPIC's "feedback_reload_plugins_before_assuming_skill_missing"
// memory: Claude Code 2.1.143 broke plugins via userConfig schema bump.
// This test catches drift in EITHER direction:
//
//   (a) Our plugin.json regresses (someone removes `name`, breaks
//       skills[].path shape) — fails immediately.
//   (b) Claude Code's schema changes and our plugin.json stops
//       conforming — operator first hits red /doctor; rotation
//       discipline is to refresh both the schema fixture and
//       plugin.json together in an ADR-217 amendment commit.
//
// The frozen schema lives at tests/integration/fixtures/claude-code-plugin-schema.json
// with a `_pinNote` documenting CC version, observation source, and
// the rotation discipline.
//
// Why a hand-rolled validator: project deps do not include ajv/json-schema
// libs. The subset we use (type / required / properties / additional-
// Properties / items / enum / anyOf / minLength) covers everything
// claude-code's manifest schema appears to enforce per observation of
// working plugins. A future ajv adoption can replace runValidator with
// no semantic change.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_JSON_PATH = join(
  import.meta.dir,
  "../../plugins/atmux/.claude-plugin/plugin.json",
);
const SCHEMA_PATH = join(
  import.meta.dir,
  "fixtures/claude-code-plugin-schema.json",
);

// ---------- Minimal JSON Schema (draft-07 subset) validator ----------

interface Schema {
  type?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
  minLength?: number;
}

interface ValidationError {
  path: string;
  message: string;
}

function validate(data: unknown, schema: Schema, path: string = "$"): ValidationError[] {
  const errors: ValidationError[] = [];

  if (schema.anyOf !== undefined) {
    const subErrors = schema.anyOf.map((sub) => validate(data, sub, path));
    if (!subErrors.some((es) => es.length === 0)) {
      errors.push({
        path,
        message: `no anyOf branch matched (${subErrors.map((es) => es[0]?.message ?? "<empty>").join(" | ")})`,
      });
    }
    return errors;
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.includes(data)) {
      errors.push({
        path,
        message: `value ${JSON.stringify(data)} not in enum [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}]`,
      });
    }
    return errors;
  }

  if (schema.type !== undefined) {
    const actual = jsonType(data);
    if (actual !== schema.type) {
      errors.push({ path, message: `expected type ${schema.type}, got ${actual}` });
      return errors;
    }
  }

  if (schema.type === "string" && schema.minLength !== undefined) {
    if (typeof data === "string" && data.length < schema.minLength) {
      errors.push({ path, message: `string length ${data.length} < minLength ${schema.minLength}` });
    }
  }

  if (schema.type === "object" && typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push({ path, message: `missing required key '${key}'` });
      }
    }
    const props = schema.properties ?? {};
    for (const [key, value] of Object.entries(obj)) {
      if (key in props) {
        errors.push(...validate(value, props[key] as Schema, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push({ path, message: `unknown property '${key}'` });
      } else if (typeof schema.additionalProperties === "object") {
        errors.push(...validate(value, schema.additionalProperties, `${path}.${key}`));
      }
    }
  }

  if (schema.type === "array" && Array.isArray(data) && schema.items !== undefined) {
    data.forEach((item, i) => {
      errors.push(...validate(item, schema.items as Schema, `${path}[${i}]`));
    });
  }

  return errors;
}

function jsonType(data: unknown): string {
  if (data === null) return "null";
  if (Array.isArray(data)) return "array";
  return typeof data;
}

function loadSchema(): Schema {
  const raw = readFileSync(SCHEMA_PATH, "utf8");
  const parsed = JSON.parse(raw) as Schema & { _pinNote?: unknown; $schema?: unknown };
  return parsed;
}

function loadPluginJson(): unknown {
  const raw = readFileSync(PLUGIN_JSON_PATH, "utf8");
  return JSON.parse(raw);
}

// ---------- Tests ----------

describe("plugins/atmux/.claude-plugin/plugin.json (ADR-217 §D8)", () => {
  test("conforms to frozen Claude Code 2.1.146 plugin-manifest schema", () => {
    const schema = loadSchema();
    const plugin = loadPluginJson();
    const errors = validate(plugin, schema);
    expect(errors).toEqual([]);
  });

  test("declares name=atmux + version=string + non-empty description", () => {
    const plugin = loadPluginJson() as Record<string, unknown>;
    expect(plugin["name"]).toBe("atmux");
    expect(typeof plugin["version"]).toBe("string");
    expect(typeof plugin["description"]).toBe("string");
    expect((plugin["description"] as string).length).toBeGreaterThan(0);
  });

  test("skills array enumerates 12 entries per ADR-217 §D2 carve set", () => {
    const plugin = loadPluginJson() as { skills: Array<{ name: string; path: string }> };
    expect(plugin.skills).toBeInstanceOf(Array);
    expect(plugin.skills).toHaveLength(12);
    const expected = [
      "team",
      "session",
      "tell-lead",
      "heads-up",
      "bruh",
      "bruhloop",
      "whip",
      "bau",
      "ghostbuster",
      "budget",
      "sweep",
      "cockpit-rebuild",
    ];
    for (const name of expected) {
      const entry = plugin.skills.find((s) => s.name === name);
      expect(entry, `skill '${name}' present`).toBeDefined();
      expect(entry!.path).toMatch(new RegExp(`^skills/${name}/SKILL\\.md$`));
    }
  });

  test("atmuxCompat declared as a semver range (>=0.8.10 minimum per ADR-217 §D8)", () => {
    const plugin = loadPluginJson() as { atmuxCompat?: string };
    expect(plugin.atmuxCompat).toBeDefined();
    expect(plugin.atmuxCompat).toMatch(/^>=\d+\.\d+\.\d+/);
  });
});

describe("frozen schema fixture (tests/integration/fixtures/claude-code-plugin-schema.json)", () => {
  test("carries _pinNote with CC version + rotation discipline", () => {
    const schema = loadSchema() as Record<string, unknown>;
    const pin = schema["_pinNote"] as Record<string, unknown>;
    expect(pin).toBeDefined();
    expect(pin["pinnedFor"]).toMatch(/Claude Code \d+\.\d+/);
    expect(pin["rotationDiscipline"]).toContain("ADR-217");
  });

  test("rejects a userConfig entry missing required title (regression for CC 2.1.143 bump)", () => {
    const schema = loadSchema();
    const badPlugin = {
      name: "x",
      version: "0.0.1",
      description: "bad fixture for regression test",
      userConfig: {
        FOO: { type: "string", description: "missing title field" },
      },
    };
    const errors = validate(badPlugin, schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("'title'"))).toBe(true);
  });

  test("rejects a userConfig entry with unknown type (e.g. legacy 'password')", () => {
    const schema = loadSchema();
    const badPlugin = {
      name: "x",
      version: "0.0.1",
      description: "bad fixture for regression test",
      userConfig: {
        PASS: { type: "password", title: "Password" },
      },
    };
    const errors = validate(badPlugin, schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("not in enum"))).toBe(true);
  });

  test("rejects plugin missing required name", () => {
    const schema = loadSchema();
    const badPlugin = { version: "0.0.1", description: "missing name" };
    const errors = validate(badPlugin, schema);
    expect(errors.some((e) => e.message.includes("'name'"))).toBe(true);
  });

  test("rejects skills entry missing path", () => {
    const schema = loadSchema();
    const badPlugin = {
      name: "x",
      version: "0.0.1",
      description: "skill missing path",
      skills: [{ name: "broken" }],
    };
    const errors = validate(badPlugin, schema);
    expect(errors.some((e) => e.message.includes("'path'"))).toBe(true);
  });
});
