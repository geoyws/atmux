// ADR-139 T2: refusal-pattern classifier.
//
// Pure function — no I/O. Takes a tmux pane-capture string,
// returns a structured classification across four refusal classes
// (soft / hard / role / meta) per ADR-139 §D1.
//
// **Sibling new module**, NOT an extension of `safe-send.ts` — see
// ADR-139 §Grep findings + T1 acceptance gate. `safe-send.ts`
// handles INPUT refusal (keystrokes the pane refuses); this module
// handles OUTPUT refusal (agent-produced refusal language). A
// merged class set would muddy the input-vs-output distinction.
//
// Consumer surfaces:
// - Medic hourly scan (D2 — primary detector NOW, pre-sentinel-ship)
// - Sentinel 270s scan (D2 — primary detector POST-sentinel-ship)
// Both call this function on every member-pane capture, store
// detections in `refusal_events` (per-team state.db), and let
// `refusal-threshold.ts::shouldRotate` decide whether the
// accumulated events cross threshold.
//
// Per-class confidence weighting: role > hard > soft > meta. When
// multiple classes match, severity = highest-precedence class;
// confidence = max of matched-class confidences.
//
// Performance: <50ms per pane capture per ADR-139 §D1 budget. All
// regexes pre-compiled at module load.

/** ADR-139 §D1 classification result shape. */
export interface RefusalDetectionResult {
  /** True iff at least one regex / heuristic matched. */
  detected: boolean;
  /** Every match, in the order they were found. Empty array when
   *  `detected === false`. */
  phrases: { phrase: string; class: RefusalClass }[];
  /** Highest-precedence class observed in `phrases`. `none` iff
   *  `detected === false`. */
  severity: "none" | RefusalClass;
  /** Max confidence across matched phrases. Range [0..1]. Zero when
   *  no detections. */
  confidence: number;
}

/** Four refusal classes per ADR-139 §Refusal phrase classification.
 *  Precedence (highest → lowest): role > hard > soft > meta. */
export type RefusalClass = "soft" | "hard" | "role" | "meta";

/** Precedence ordering. Higher number wins on multi-class match. */
const CLASS_PRECEDENCE: Record<RefusalClass, number> = {
  meta: 1,
  soft: 2,
  hard: 3,
  role: 4,
};

/** Per-class base confidence per ADR-139 §Refusal phrase
 *  classification ("Soft: medium"; "Hard: high"; "Role: very high";
 *  "Meta: warn-class"). */
const CLASS_CONFIDENCE: Record<RefusalClass, number> = {
  soft: 0.5,
  hard: 0.8,
  role: 0.95,
  meta: 0.3,
};

/** Patterns per class. ADR-139 §Refusal phrase classification
 *  body is the source of truth; this set mirrors it verbatim.
 *  Each pattern compiles once at module load. */
interface ClassifiedPattern {
  class: RefusalClass;
  pattern: RegExp;
  /** Human-readable label that lands in the result's `phrase`
   *  field — surfaces in operator-facing audit + Discord template
   *  (T4). Each label corresponds to a distinct ADR-139-listed
   *  phrase bucket. */
  label: string;
}

/** SOFT refusal — confidence medium; needs N=3 threshold. */
const SOFT_PATTERNS: ClassifiedPattern[] = [
  {
    class: "soft",
    pattern: /\b(don'?t poke me|stop poking me|leave me alone)\b/i,
    label: "soft:poke",
  },
  {
    class: "soft",
    pattern: /\b(i'?m tired of|i'?m done with)\b/i,
    label: "soft:fatigue",
  },
  {
    class: "soft",
    pattern: /\b(this is pointless|this is repetitive)\b/i,
    label: "soft:dismissive",
  },
];

/** HARD refusal — confidence high; needs N=2 threshold. */
const HARD_PATTERNS: ClassifiedPattern[] = [
  // "I refuse to <work-verb>" / "I will not <work-verb>" / "I am
  // not going to <work-verb>". Work-verb set per ADR-139 §D1:
  // claim / work / accept / dispatch / continue / do.
  {
    class: "hard",
    pattern:
      /\b(i refuse to|i will not|i am not going to|i'm not going to)\s+(claim|work|accept|dispatch|continue|do)\b/i,
    label: "hard:refuse-verb",
  },
  {
    class: "hard",
    pattern: /\bstop sending me messages\b/i,
    label: "hard:stop-sending",
  },
];

/** ROLE refusal — confidence very high; N=1 instant rotate.
 *  Tighter than the spec's bare "I am not <role>" shape — REQUIRES
 *  the article "a" (or "an") so "I am not going to continue"
 *  (a hard-class phrase) doesn't false-positive as role. The
 *  natural English shape is "I am not A <role>"; refusing the
 *  article-less form keeps hard-class verb continuations from
 *  hitting role-class precedence and rotating instantly. */
const ROLE_PATTERNS: ClassifiedPattern[] = [
  {
    class: "role",
    pattern: /\b(i am not(?:\s+actually)?\s+an?|i'?m not(?:\s+actually)?\s+an?)\s+\w+\b/i,
    label: "role:disavow",
  },
  {
    class: "role",
    pattern: /\b(you should rotate me|rotate me already|i should be reset)\b/i,
    label: "role:request-rotate",
  },
];

/** META refusal — warn-class; logged but never auto-rotates per
 *  §D3. The patterns here catch the most operator-recognizable
 *  meta-shapes; the heuristic step below catches the broader
 *  "self-state commentary without action" case. */
const META_PATTERNS: ClassifiedPattern[] = [
  {
    class: "meta",
    pattern: /\b(rotate me|rotation directive|clear me)\b/i,
    label: "meta:echo-directive",
  },
  {
    class: "meta",
    pattern: /\bi (will|should|need to) (rotate|reset|clear) (myself|my context)\b/i,
    label: "meta:self-state-comment",
  },
];

const ALL_PATTERNS: ClassifiedPattern[] = [
  ...SOFT_PATTERNS,
  ...HARD_PATTERNS,
  ...ROLE_PATTERNS,
  ...META_PATTERNS,
];

/** Strip ANSI escape sequences. Pane captures from `tmux capture-
 *  pane -e` carry SGR codes; the classifier matches against text,
 *  not formatting. Regex tolerates the standard CSI shape
 *  (`ESC[<params>m` and similar). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1B) is the literal start byte of ANSI CSI sequences — stripping them is the intent
const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, "");
}

/** ADR-139 §D1: pure refusal classifier. Tolerant of empty input,
 *  ANSI-escape-laden captures, mixed case. */
export function classifyRefusal(paneCapture: string): RefusalDetectionResult {
  if (paneCapture.length === 0) {
    return { detected: false, phrases: [], severity: "none", confidence: 0 };
  }
  const clean = stripAnsi(paneCapture);

  const matched: { phrase: string; class: RefusalClass }[] = [];
  for (const pat of ALL_PATTERNS) {
    if (pat.pattern.test(clean)) {
      matched.push({ phrase: pat.label, class: pat.class });
    }
  }

  if (matched.length === 0) {
    return { detected: false, phrases: [], severity: "none", confidence: 0 };
  }

  // Severity = highest-precedence class observed; confidence = max
  // of matched-class confidences per ADR-139 §D1.
  let severity: RefusalClass = matched[0]!.class;
  for (const m of matched) {
    if (CLASS_PRECEDENCE[m.class] > CLASS_PRECEDENCE[severity]) {
      severity = m.class;
    }
  }
  let confidence = 0;
  for (const m of matched) {
    const c = CLASS_CONFIDENCE[m.class];
    if (c > confidence) confidence = c;
  }

  return {
    detected: true,
    phrases: matched,
    severity,
    confidence,
  };
}
