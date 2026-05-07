// Unit tests for src/core/tz-lint.ts (ADR-057 §D5d).

import { describe, expect, test } from "bun:test";
import { lintFileContent } from "../../../src/core/tz-lint.ts";

describe("lintFileContent", () => {
  test("clean file → no findings", () => {
    const code = `
import { formatMyt } from "./time";
const ts = formatMyt(now());
`;
    expect(lintFileContent("x.ts", code)).toEqual([]);
  });

  test("bare HH:MM in double-quoted string → finding", () => {
    const code = `const msg = "scheduled at 03:44";`;
    const findings = lintFileContent("x.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.match).toBe("03:44");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.context).toContain("03:44");
  });

  test("HH:MM with MYT suffix → no finding", () => {
    const code = `const msg = "scheduled at 03:44 MYT";`;
    expect(lintFileContent("x.ts", code)).toEqual([]);
  });

  test("HH:MM with +08:00 suffix → no finding", () => {
    const code = `const msg = "ts 14:00+08:00 today";`;
    expect(lintFileContent("x.ts", code)).toEqual([]);
  });

  test("HH:MM:SS bare → finding", () => {
    const code = `const msg = "fires at 03:44:00";`;
    const findings = lintFileContent("x.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.match).toBe("03:44:00");
  });

  test("ISO 8601 datetime → no finding", () => {
    const code = `const ts = "2026-05-04T03:44:00Z";`;
    expect(lintFileContent("x.ts", code)).toEqual([]);
  });

  test("ISO 8601 with bare T prefix → no finding", () => {
    const code = `const a = "T03:44";`;
    expect(lintFileContent("x.ts", code)).toEqual([]);
  });

  test("inside line comment → no finding", () => {
    const code = `// example: at 03:44 something\nconst x = 1;`;
    expect(lintFileContent("x.ts", code)).toEqual([]);
  });

  test("inside block comment (single line) → no finding", () => {
    const code = `/* example "at 03:44" */ const x = 1;`;
    expect(lintFileContent("x.ts", code)).toEqual([]);
  });

  test("inside multi-line block comment → no finding", () => {
    const code = `/*\n * example: "at 03:44 today"\n */\nconst x = 1;`;
    expect(lintFileContent("x.ts", code)).toEqual([]);
  });

  test("after block comment ends, code is scanned again", () => {
    const code = `/* tz example */\nconst msg = "at 09:00";`;
    const findings = lintFileContent("x.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });

  test("template literal with bare HH:MM → finding", () => {
    const code = "const msg = `today at 14:30`;";
    const findings = lintFileContent("x.ts", code);
    expect(findings).toHaveLength(1);
  });

  test("template literal with MYT suffix → no finding", () => {
    const code = "const msg = `today at 14:30 MYT`;";
    expect(lintFileContent("x.ts", code)).toEqual([]);
  });

  test("single-quoted string with bare time → finding", () => {
    const code = `const msg = 'fires 09:00';`;
    expect(lintFileContent("x.ts", code)).toHaveLength(1);
  });

  test("escaped quote inside string is handled", () => {
    // The escaped \" doesn't terminate the string; "01:23" inside is the
    // outer-string content and SHOULD be flagged.
    const code = `const msg = "before \\"quoted\\" at 01:23 raw";`;
    expect(lintFileContent("x.ts", code)).toHaveLength(1);
  });

  test("multiple findings on different lines", () => {
    const code = [
      `const a = "at 09:00";`,
      `const b = "at 10:30";`,
      `const c = "at 11:00 MYT";`,
    ].join("\n");
    const findings = lintFileContent("x.ts", code);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line)).toEqual([1, 2]);
  });

  test("TZ offset like +05:30 (negative-prefix exempt)", () => {
    // This is a TZ offset literal — prefix `+` exempts.
    const code = `const tz = "offset+05:30";`;
    expect(lintFileContent("x.ts", code)).toEqual([]);
  });

  test("file path used in finding output", () => {
    const code = `const msg = "at 09:00";`;
    const findings = lintFileContent("src/verbs/whatever.ts", code);
    expect(findings[0]?.file).toBe("src/verbs/whatever.ts");
  });
});
