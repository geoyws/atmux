# Investigation: `atmux task list --json | jq` parse errors

**Date**: 2026-05-09
**Driver-ref**: ADR-080 §E / sopx-driver bundle 2026-05-09 07:25 MYT
**Outcome**: ✅ **bun-side clean — no fix-commit**. Forward trip-wire fixture shipped under ADR-080§E commit; bug is bash-sopx-side, sopx pulls bun-port main as the close-out path.

## Operator report

> `atmux task list --json | jq` parse-errors on tasks whose body contains backticks/newlines/quotes.

## Method

1. Inspect bun emit site: `src/verbs/task.ts:217` calls
   `process.stdout.write(\`${JSON.stringify(tasks, null, 2)}\\n\`)`.
   `JSON.stringify` is the standard-library escape — properly escapes
   `\`` (no special handling needed; backticks are not JSON-syntactic),
   `\n` (rendered as the two-char escape `\\n`), `\"` (escaped to `\\"`),
   and `$` (no special handling needed; not JSON-syntactic).

2. Trace upstream: `core/kanban.ts::listTasks` returns `KanbanTask[]`
   with `subject: string`, `body?: string`. No string-field is
   pre-serialized; bodies round-trip as plain UTF-8 strings into the
   JSON encoder.

3. Reproduce on bun: `tests/unit/verbs/task.test.ts` got a new
   regression-pin fixture under §D's commit:

   ```ts
   const ADVERSARIAL_BODY =
     "```ts\nconst x = `hello ${world}`;\n" +
     "const y = 'a' + \"b\";\nconst z = $1 + $foo;\n```";
   await addTask(atmuxDir, { subject: "adversarial", body: ADVERSARIAL_BODY });
   const { out } = await captureStdout(() => task(["list", "--json", ...]));
   const parsed = JSON.parse(out);                      // ← passes
   expect(parsed[0].body).toBe(ADVERSARIAL_BODY);       // ← passes
   ```

   Bodies containing backticks, multiple newlines, single + double
   quotes, and `$`-prefixed tokens round-trip cleanly. **No bun-side
   repro.**

## Conclusion

The parse error sopx-driver observed is a **bash-side bug**. The bash
`atmux task list --json` flow at `.archive-bash-atmux-20260507/lib/`
hand-builds JSON via shell-string interpolation (no equivalent of
`JSON.stringify`), so any body containing one of:

- An unescaped `"` inside a backtick-fenced block
- A newline that becomes a literal LF in the emitted JSON instead of
  the two-char `\n` escape
- A `$`-prefixed token expanded by an outer shell layer (rare, but
  surfaces under `bash -c`-style invocations)

trips up `jq`'s strict parser. The bun port — landing on sopx via the
operator-side migration — replaces the hand-rolled shell formatter
with `JSON.stringify`, closing the bug at the source.

## Remediation

| Layer | Action | Owner | Status |
|---|---|---|---|
| atmux bun source | `JSON.stringify(tasks, null, 2)` already in place; **no fix-commit needed**. | parity-read-impl | ✅ no change |
| atmux bun tests | Forward trip-wire fixture: `'list --json' round-trips adversarial body (backticks/newlines/quotes/$)`. Catches a future regression — e.g. someone replacing `JSON.stringify` with a hand-rolled formatter, or `core/kanban.ts::listTasks` returning a string field that's already JSON-encoded-once. | parity-read-impl | ✅ shipped in this commit |
| sopx host | Pull bun-port atmux main (replaces bash `lib/kanban.sh` JSON path). | sopx-team | not in scope |
| .archive bash | Per OQ-4 (no aggressive bash teardown), do NOT patch the bash hand-rolled JSON path. Sopx bun-port migration is the canonical close-out. | (deferred) | not in scope |

## Commit count for §E

**0 fix commits** per the dispatch's outcome (b). The forward trip-wire
fixture + this investigation document ship together as one docs+test
commit — the §E close-out artifact. No bun source code changes.
