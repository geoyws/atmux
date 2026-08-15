import { openDatabase, closeDatabase } from "../src/abstractions/sqlite.ts";
import { migrations } from "../src/abstractions/sqlite-migrations.ts";
import { emit } from "../src/abstractions/events.ts";
import { ComplaintsRepo } from "../src/core/repositories/complaints-repo.ts";

const db = openDatabase("/root/work/src/atmux/.atmux/state.db", migrations);
const repo = new ComplaintsRepo(db);
const ids = ["c-8ecc181f", "c-04db5b96", "c-03b6ae69", "c-bcd0a28d"];
for (const id of ids) {
  const c = repo.getById(id);
  if (c === null) { console.log(`skip ${id}: not found`); continue; }
  const severity = typeof c.extra.severity === "string" ? c.extra.severity : null;
  const sourceCount = typeof c.extra.source_count === "number" ? c.extra.source_count : 1;
  const ev = emit(db, {
    topic: "complaint.filed",
    complaintId: c.id,
    targetTeam: c.targetTeam,
    sourceKind: c.sourceKind,
    sourceId: c.sourceId,
    incidentSummary: c.incidentSummary,
    openedBy: c.openedBy,
    severity,
    sourceCount,
    bumped: false,
    filedAtSec: c.openedAt,
  });
  console.log(`emitted ${ev.eventId} for ${id} (filedAt=${c.openedAt})`);
}
closeDatabase(db);
