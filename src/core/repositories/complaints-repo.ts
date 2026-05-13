// ADR-077 §F2: complaints repository.
//
// SQL is owned here; verbs see a typed CRUD surface. Pattern mirrors
// `kanban-repo.ts` — row interface, row↔domain bridges, methods on the
// repo class.
//
// Field naming convention: SQL columns are snake_case; domain objects
// (TS types) are camelCase. `complaintFromRow` / `complaintToRow` own
// the conversion. `extra` is a JSON-string column on disk; `Record<
// string, unknown>` in the domain.

import type { Database } from "bun:sqlite";
import {
  type Complaint,
  Complaint as ComplaintSchema,
  type ComplaintSourceKind,
  type ComplaintStatus,
} from "../../schema/complaints.ts";

// ---------- Row shape (SQL columns; raw bun:sqlite output) ----------

interface ComplaintRow {
  id: string;
  opened_at: number;
  opened_by: string | null;
  incident_summary: string;
  root_cause: string | null;
  preventive_ask: string | null;
  status: string;
  resolved_at: number | null;
  resolved_by: string | null;
  related_task_id: string | null;
  source_kind: string | null;
  source_id: string | null;
  target_team: string | null;
  extra: string | null;
}

// ---------- Row ↔ domain bridges ----------

export function complaintFromRow(row: ComplaintRow): Complaint {
  const extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  return ComplaintSchema.parse({
    id: row.id,
    openedAt: row.opened_at,
    openedBy: row.opened_by,
    incidentSummary: row.incident_summary,
    rootCause: row.root_cause,
    preventiveAsk: row.preventive_ask,
    status: row.status,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    relatedTaskId: row.related_task_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    targetTeam: row.target_team,
    extra,
  });
}

export function complaintToRow(c: Complaint): ComplaintRow {
  return {
    id: c.id,
    opened_at: c.openedAt,
    opened_by: c.openedBy ?? null,
    incident_summary: c.incidentSummary,
    root_cause: c.rootCause ?? null,
    preventive_ask: c.preventiveAsk ?? null,
    status: c.status,
    resolved_at: c.resolvedAt ?? null,
    resolved_by: c.resolvedBy ?? null,
    related_task_id: c.relatedTaskId ?? null,
    source_kind: c.sourceKind ?? null,
    source_id: c.sourceId ?? null,
    target_team: c.targetTeam ?? null,
    extra: c.extra && Object.keys(c.extra).length > 0 ? JSON.stringify(c.extra) : null,
  };
}

// ---------- Repository ----------

export interface ListComplaintsOpts {
  /** Filter by status. Omit for all statuses. */
  status?: ComplaintStatus;
  /** Filter by source_kind (v3 / t-e5e5d576). Allowlist-enforced at
   *  the verb; schema is free-form so unknown values reach here. */
  sourceKind?: ComplaintSourceKind | string;
  /** Filter by target_team (v3). Exact match. */
  targetTeam?: string;
  /** Cap result set. Default `1000`. */
  limit?: number;
}

export class ComplaintsRepo {
  constructor(private readonly db: Database) {}

  insert(c: Complaint): void {
    const row = complaintToRow(c);
    this.db
      .prepare(
        `INSERT INTO complaints (
            id, opened_at, opened_by, incident_summary, root_cause,
            preventive_ask, status, resolved_at, resolved_by,
            related_task_id, source_kind, source_id, target_team, extra
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.opened_at,
        row.opened_by,
        row.incident_summary,
        row.root_cause,
        row.preventive_ask,
        row.status,
        row.resolved_at,
        row.resolved_by,
        row.related_task_id,
        row.source_kind,
        row.source_id,
        row.target_team,
        row.extra,
      );
  }

  getById(id: string): Complaint | null {
    const row = this.db
      .query("SELECT * FROM complaints WHERE id = ?")
      .get(id) as ComplaintRow | null;
    if (row === null) return null;
    return complaintFromRow(row);
  }

  list(opts: ListComplaintsOpts = {}): Complaint[] {
    const limit = opts.limit ?? 1000;
    // Compose WHERE clauses dynamically so any combination of
    // status / source_kind / target_team filters works without an
    // SQL explosion. The base case (no filters) drops the WHERE
    // entirely. Parameter order tracks the `where[]` push order.
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.status !== undefined) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.sourceKind !== undefined) {
      where.push("source_kind = ?");
      params.push(opts.sourceKind);
    }
    if (opts.targetTeam !== undefined) {
      where.push("target_team = ?");
      params.push(opts.targetTeam);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")} ` : "";
    params.push(limit);
    const rows = this.db
      .query(`SELECT * FROM complaints ${whereSql}ORDER BY opened_at DESC LIMIT ?`)
      .all(...params) as ComplaintRow[];
    return rows.map(complaintFromRow);
  }

  /** Resolve / wontfix a complaint. Returns true on update, false when
   *  no row matched the id. */
  resolve(opts: {
    id: string;
    status: "resolved" | "wontfix";
    resolvedAt: number;
    resolvedBy?: string | null;
    note?: string | null;
    relatedTaskId?: string | null;
  }): boolean {
    const cur = this.getById(opts.id);
    if (cur === null) return false;
    const newExtra: Record<string, unknown> = { ...cur.extra };
    if (opts.note !== undefined && opts.note !== null && opts.note.length > 0) {
      newExtra.resolution_note = opts.note;
    }
    const extraStr = Object.keys(newExtra).length > 0 ? JSON.stringify(newExtra) : null;
    this.db
      .prepare(
        `UPDATE complaints
         SET status = ?, resolved_at = ?, resolved_by = ?, related_task_id = ?, extra = ?
         WHERE id = ?`,
      )
      .run(
        opts.status,
        opts.resolvedAt,
        opts.resolvedBy ?? null,
        opts.relatedTaskId ?? cur.relatedTaskId ?? null,
        extraStr,
        opts.id,
      );
    return true;
  }

  /** Number of rows with a given status — quick gauge for status verb. */
  countByStatus(status: ComplaintStatus): number {
    const r = this.db
      .query("SELECT COUNT(*) AS n FROM complaints WHERE status = ?")
      .get(status) as { n: number } | null;
    return r?.n ?? 0;
  }
}
