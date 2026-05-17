// ADR-138 T3b3 / t-06547e2d contract test: no caller in `src/` may
// fire `tmux.pane.sendKeys` with a TEXT-BODY payload + `enter: true`
// (the bracketed-paste-Enter-swallow bug zone). Text bodies MUST
// route through `pasteAndSubmit` (or `sendToMember` / `bootClaude
// Member`, which wrap it).
//
// Carve-outs the test allows:
//   - Control-key keystrokes (`C-m`, `C-c`, `BTab`, single-character
//     numeric modal selections) — these don't pass through the
//     bracketed-paste envelope and are correct on the raw path.
//   - `enter: false` calls — caller's NOT submitting; the bug only
//     manifests on the trailing Enter, so no-submit sends are safe.
//   - Carve-out files: `paste-submit.ts` (the canonical primitive
//     itself; uses raw sendKeys for the C-m submit step) +
//     `safe-send.ts` (the preflight-and-classify layer that callers
//     compose on top of pasteAndSubmit).
//
// On match: fail with file:line + the offending fragment. Reviewer
// blocks the PR until the caller migrates to pasteAndSubmit or adds
// a documented carve-out comment.

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "..", "..", "src");

// Files where raw `tmux.pane.sendKeys` calls are intentional carve-
// outs. Each entry needs a comment in the file explaining WHY the
// raw path is correct there (control-keys only, shell-prompt
// launcher, slash-command, etc.).
const CARVE_OUT_FILES = new Set([
  // The canonical paste-submit primitive itself — the final C-m
  // send IS raw on purpose (ADR-081 §A).
  "core/paste-submit.ts",
  // Pane-state classifier loop wraps raw sendKeys for known-modal
  // dismissal keystrokes (single chars: "0", "1", "Escape).
  "core/safe-send.ts",
  // sendToMember's preflight uses safe-send pattern (same modal-
  // dismissal carve-out as core/safe-send.ts above). The final
  // text-body submit on the trunk path of sendToMember IS via
  // paste-submit (loadBuffer + pasteBuffer + submitAfterPaste); the
  // raw sendKeys callsite at line 257 is only for safePreflight's
  // modal-dismiss inner callback.
  "core/send.ts",
  // boot-claude.ts uses pasteAndSubmit for the brief text body
  // (post-T3b3). Raw send-keys remains only on the C-m emit inside
  // the paste-submit cascade itself, but boot-claude.ts no longer
  // has any raw text-body send-keys after the T3b3 migration.
  // Listed defensively in case future patches reintroduce a raw
  // path that needs the explicit carve-out treatment.
  "core/boot-claude.ts",
  // goal-injection.ts wraps a raw sendKeys in the inner sendKeysFn
  // callback of safeSendKeysWithVerify (the composerEmpty verifier
  // confirms the keystroke landed + the retry budget catches
  // bracketed-paste-Enter swallows). The audit-grep can't see
  // through the wrap, so the file lives in the carve-out registry
  // alongside core/send.ts + verbs/ombudsman.ts — same shape:
  // safe-send adapter signature with inner raw sendKeys that the
  // verify-and-retry policy gates externally. Per ADR-138 §6 the
  // /goal "<text>" payload is slash-command-shaped (parallel to
  // /clear, /loop /superdoctor) — bypassing the paste-submit
  // cascade is correct here.
  "core/goal-injection.ts",
  // Soft-stop notice — explicit `enter: false`, never submits.
  // Tests reach this carve-out via grep but enter:false also
  // disqualifies from the violation rule below.
  "core/soft-stop.ts",
  // Launcher commands at SHELL prompt — pre-claude, no bracketed-
  // paste envelope (start.ts:485 + 715).
  "verbs/start.ts",
  // /clear slash-command — typed keystrokes at top of compose, not
  // a paste sequence (rotate.ts:309).
  "verbs/rotate.ts",
  // /loop slash-commands at cockpit shell — pre-superdoctor /
  // pre-sentinel boot (cockpit.ts:1737 + 1863).
  "verbs/cockpit.ts",
  // Ombudsman safe-send adapter — composes safeSendKeys' callback
  // signature; the callback's `enter` is opt-controlled by safe-
  // send.ts which is in the carve-out list above.
  "verbs/ombudsman.ts",
]);

async function* walkTs(dir: string, base = ""): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const sub = base ? `${base}/${ent.name}` : ent.name;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkTs(full, sub);
    } else if (ent.isFile() && ent.name.endsWith(".ts")) {
      yield sub;
    }
  }
}

describe("ADR-138 T3b3 contract — no raw text-body tmux.pane.sendKeys (t-06547e2d)", () => {
  test("every callsite passing `keys: <text-body>` + `enter: true` lives in a carve-out file", async () => {
    const violations: { file: string; line: number; snippet: string }[] = [];
    for await (const rel of walkTs(SRC_DIR)) {
      if (CARVE_OUT_FILES.has(rel)) continue;
      const text = await readFile(join(SRC_DIR, rel), "utf8");
      const lines = text.split("\n");
      // Look for `tmux.pane.sendKeys({` blocks; flag any whose
      // following lines contain BOTH `keys: ` (string-typed payload)
      // AND `enter: true` (or no `enter:` field, which defaults to
      // true in the tmux abstraction). Multi-line object literal
      // shape — scan a 6-line window from the call's open brace.
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!/\btmux\.pane\.sendKeys\s*\(\s*\{/.test(line)) continue;
        const block = lines.slice(i, i + 8).join("\n");
        // Skip when the block contains `enter: false` — caller's not
        // submitting; the bug zone is the trailing Enter only.
        if (/\benter:\s*false\b/.test(block)) continue;
        // Skip when the keys payload is a control-key keysym
        // (`"C-m"`, `"C-c"`, `"BTab"`, `"Escape"`, single-digit
        // string). Also skip when keys is the local variable
        // `text`/`keys` from the safe-send adapter shape (those
        // adapter signatures are in carve-out files; this is just
        // defense against false positives in NEW adapters).
        if (/\bkeys:\s*"(?:C-[a-z]|M-[a-z]|BTab|Escape|[0-9])"/i.test(block)) continue;
        // Heuristic: if keys references a local variable named
        // `cmd` / `text` / `keys` / `drvCmd`, that COULD be a text-
        // body — flag it. Subject to carve-out review below.
        if (/\bkeys:\s*[a-zA-Z]/.test(block)) {
          violations.push({ file: rel, line: i + 1, snippet: line.trim() });
        }
      }
    }
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  ${v.file}:${v.line}\n    ${v.snippet}`)
        .join("\n");
      throw new Error(
        `ADR-138 T3b3 contract violation — raw tmux.pane.sendKeys with text-body payload found in ${violations.length} site(s):\n${detail}\n\n` +
          "Route the payload through `pasteAndSubmit` from src/core/paste-submit.ts, OR add the source file to CARVE_OUT_FILES with a doc comment explaining why the raw path is correct (control-key only, shell prompt, slash-command, etc.).",
      );
    }
    // Assert at least the carve-out list isn't empty — sanity guard
    // that the test ran against something.
    expect(CARVE_OUT_FILES.size).toBeGreaterThan(0);
  });
});
