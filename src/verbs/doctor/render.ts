import type { DoctorReport, DoctorStatus } from "./types.ts";

// ---------- Render ----------

const STATUS_GLYPH: Record<DoctorStatus, string> = {
  green: "✅",
  yellow: "⚠️ ",
  red: "❌",
  info: "ℹ️ ",
};

export function renderHuman(report: DoctorReport): string {
  const lines: string[] = ["", "🩺 atmux doctor — environment check", ""];
  for (const row of report.rows) {
    const label = row.label.padEnd(22);
    const detail = row.detail ?? "";
    lines.push(`  ${STATUS_GLYPH[row.status]} ${label} ${detail}`);
    if (row.status !== "green" && row.hint !== undefined && row.hint !== "") {
      lines.push(`     → ${row.hint}`);
    }
  }
  lines.push("");
  if (report.redCount === 0 && report.yellowCount === 0) {
    lines.push("  ✅ all green");
  } else if (report.redCount === 0) {
    lines.push(`  ⚠️  ${report.yellowCount} warning(s), no blockers`);
  } else {
    lines.push(`  ❌ ${report.redCount} issue(s) — run with --fix to remediate`);
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

export function renderJson(report: DoctorReport): string {
  return `${JSON.stringify(
    {
      red: report.redCount,
      yellow: report.yellowCount,
      checks: report.rows.map((r) => ({
        status: r.status,
        label: r.label,
        detail: r.detail ?? "",
        hint: r.hint ?? "",
      })),
    },
    null,
    2,
  )}\n`;
}
