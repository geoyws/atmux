// ADR-005: JSON read / write / update with Zod validation + flock-protected mutation.
//
// The ONE module allowed to call `JSON.parse`. R3 (per ADR-006 + ADR-009 §3.5)
// is a reviewer-enforced regex against `\bJSON\.parse\s*\(` outside this file.
//
// All reads validate via `schema.safeParse()`; all writes serialize a value
// that has already been validated. `updateJson()` is the mutation path verbs
// use — read + validate + mutate + validate + atomic write, all under a
// `lock.withLock(path, ...)` per ADR-005.

import { type ZodType, z } from "zod";
import { SchemaError } from "../errors.ts";
import { atomicWrite, readText, readTextOrNull } from "./fs.ts";
import { type AcquireOpts, withLock } from "./lock.ts";

const SERIALIZE_INDENT = 2;

// ---------- Read ----------

/**
 * Read JSON from `path` and validate via `schema`.
 * @throws FsError on miss or read failure.
 * @throws SchemaError on JSON parse / Zod validation failure.
 */
export async function readJson<T>(path: string, schema: ZodType<T>): Promise<T> {
  const text = await readText(path);
  return parseAndValidate(path, schema, text);
}

/**
 * Read JSON; return `null` on ENOENT (expected absence — first-run case).
 * Existing-but-invalid files still throw `SchemaError` — silent fallback would
 * mask state corruption (ADR-005 "never silent fallback to defaults" rule).
 */
export async function tryReadJson<T>(path: string, schema: ZodType<T>): Promise<T | null> {
  const text = await readTextOrNull(path);
  if (text === null) return null; // expected: caller treats first-run absence as no-op
  return parseAndValidate(path, schema, text);
}

/**
 * Read JSON; return `fallback` on ENOENT. Existing-but-invalid still throws.
 * Fallback path replaces bash's `if [[ -s "$file" ]]; then ... else jq -n ...`
 * branch documented in ADR-005.
 */
export async function readJsonOr<T>(path: string, schema: ZodType<T>, fallback: T): Promise<T> {
  const got = await tryReadJson(path, schema);
  return got === null ? fallback : got;
}

// ---------- Write ----------

/**
 * Validate `value` then atomically write it to `path` (mktemp + fsync + rename
 * via `fs.atomicWrite`). Caller wraps in `lock.withLock(path, ...)` if
 * concurrent writers exist; `updateJson` does that automatically.
 */
export async function writeJson<T>(path: string, schema: ZodType<T>, value: T): Promise<void> {
  const validated = validate(path, schema, value);
  const body = `${JSON.stringify(validated, null, SERIALIZE_INDENT)}\n`;
  await atomicWrite(path, body);
}

// ---------- Mutate ----------

export interface UpdateOpts {
  /** Read fallback if `path` doesn't exist yet. Defaults to `undefined`
   *  (in which case a missing file throws `FsError`). Pass a fresh value
   *  (e.g. an empty kanban shape) for first-run safety. */
  initial?: unknown;
  /** Override flock timeout / retry — see `lock.ts::AcquireOpts`. */
  lock?: AcquireOpts;
}

/**
 * Atomic read → mutate → validate → atomic write under a lock. The ONLY
 * mutation path verbs should use (per ADR-005 "the only mutation path verbs
 * should use" rule). Returns the post-mutation, post-validate value.
 *
 * The mutator MAY return a different shape than it received; the schema
 * re-validates on output, catching mutator bugs that would otherwise persist
 * malformed state to disk.
 */
export async function updateJson<T>(
  path: string,
  schema: ZodType<T>,
  mutator: (current: T) => T | Promise<T>,
  opts?: UpdateOpts,
): Promise<T> {
  const lockOpts = opts?.lock;
  const initial = opts?.initial;
  return await withLock(
    path,
    async (): Promise<T> => {
      let current: T;
      if (initial !== undefined) {
        const text = await readTextOrNull(path);
        current =
          text === null ? validate(path, schema, initial) : parseAndValidate(path, schema, text);
      } else {
        current = await readJson(path, schema);
      }
      const next = await mutator(current);
      const validated = validate(path, schema, next);
      const body = `${JSON.stringify(validated, null, SERIALIZE_INDENT)}\n`;
      await atomicWrite(path, body);
      return validated;
    },
    lockOpts,
  );
}

// ---------- Parse-from-string (JSONL line-readers) ----------

/**
 * Parse a JSON string + validate via `schema`. Returns the validated
 * value on success, `null` on parse OR validation failure. The error-
 * swallowing posture is intentional — the primary caller is the JSONL
 * line reader (`src/verbs/cost.ts`), where heterogeneous line types
 * (assistant / tool-result / sidechain / permission-mode / …) make
 * "skip what doesn't match" the only sensible behaviour. Strict reads
 * use `readJson` (file path) which still throws via `parseAndValidate`.
 *
 * Provided here (NOT in cost.ts) to honour the R3 invariant: this file
 * is the only module allowed to call `JSON.parse` (per the file header
 * + ADR-006). Other modules reach JSON-parsing via this helper or
 * `readJson` / `tryReadJson`.
 */
export function tryParseJsonString<T>(text: string, schema: ZodType<T>): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null; // expected: line not JSON (truncated tail, prose, etc.)
  }
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

// ---------- Internals ----------

function parseAndValidate<T>(path: string, schema: ZodType<T>, text: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    // JSON-parse failure is operationally a schema mismatch — the file shape
    // is wrong from the operator's perspective. Wrap as `SchemaError` so all
    // boundary failures are catch-by-tag uniform (ADR-005 "parse failures
    // throw SchemaError").
    const message = e instanceof Error ? e.message : String(e);
    const synthetic = new z.ZodError([
      {
        code: "custom",
        path: [],
        message: `invalid JSON: ${message}`,
        input: text,
      },
    ]);
    throw new SchemaError({
      file: path,
      issues: synthetic.issues,
      cause: synthetic,
    });
  }
  return validate(path, schema, raw);
}

function validate<T>(path: string, schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new SchemaError({
    file: path,
    issues: result.error.issues,
    cause: result.error,
  });
}
