// Drift fixtures for the external `kanban` CLI — ADR-275 D2.
//
// **Captured against runtime commit `414bfdd`** ("feat!: replace Bun runtime
// with Rust ledger"), binary `/root/.local/bin/kanban`, source checkout
// `/root/work/src/kanban`. Every `stdout` / `stderr` below is verbatim process
// output, byte for byte including the trailing newline. Nothing is prettified
// or hand-edited: a fixture written from the adapter's own expectations would
// agree with the adapter forever and so guard nothing.
//
// Why a fixture guard at all: the runtime moved three times in one week,
// including a breaking Bun→Rust rewrite, and a CLI is a contract with no type
// checker across it. These captures are that type checker. When the runtime
// changes shape, `tests/unit/adapters/kanban-cli.test.ts` fails by name
// against a known commit instead of the change surfacing as a wrong answer
// inside a verb.
//
// **Scope** — only argv `src/adapters/kanban-cli.ts` actually issues, and only
// fields it actually reads. Captures for verbs the adapter never invokes
// (`task list` without `--with-relations`, `task show`, unknown-verb help)
// were dropped: a fixture nothing parses is a fixture nothing can drift.
//
// **Re-capture recipe** — run each `argv` below against the new binary and
// replace the strings; the resulting diff IS the drift report. Then update
// `KANBAN_FIXTURE_COMMIT`. Capture from an isolated board, never from a cwd
// under `/root/work`: the runtime selects its board from the current working
// directory and real operator boards are registered there.
//
//   scratch=$(mktemp -d /tmp/kanban-capture-XXXXXX)
//   export KANBAN_DATA_DIR="$scratch/data"      # throwaway registry
//   mkdir -p "$scratch/proj" && cd "$scratch/proj"
//   kanban init --name capture --json
//   kanban task add "epic one" --type epic --json
//   kanban task add "task alpha" --as tester --body "some body" --lane fe \
//     --priority 2 --assignee be-1 --deliverable "a thing" --parent <epic> \
//     --stale-minutes 45 --driver-only > cap/task-add.json 2> cap/task-add.err
//   ...
//
// Structural check performed at capture-verification time (2026-08-17): the
// runtime emits `task add` / `task move` / `task update` in Rust struct field
// order but `task list` in alphabetical key order, because list responses are
// rebuilt through a `serde_json::Map`. Both orders are reproduced below
// exactly as the binary emitted them.

/** The runtime commit every fixture below was captured against. */
export const KANBAN_FIXTURE_COMMIT = "414bfdd";

export interface KanbanCliFixture {
  /** argv passed after the binary name, verbatim, as captured. */
  argv: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Verbatim captures, keyed by the adapter behaviour each one pins. */
export const KANBAN_CLI_FIXTURES = {
  /** `KanbanCliAdapter.addTask` — reads `id` off the created record. */
  taskAdd: {
    argv: [
      "task",
      "add",
      "task alpha",
      "--as",
      "tester",
      "--body",
      "some body",
      "--lane",
      "fe",
      "--priority",
      "2",
      "--assignee",
      "be-1",
      "--deliverable",
      "a thing",
      "--parent",
      "e-4d17bce8",
      "--stale-minutes",
      "45",
      "--driver-only",
    ],
    exitCode: 0,
    stdout:
      '{\n  "id": "t-02f3afe1",\n  "type": "task",\n  "parentID": "e-4d17bce8",\n  "title": "task alpha",\n  "body": "some body",\n  "assignee": "be-1",\n  "lane": "fe",\n  "deliverable": "a thing",\n  "staleMinutes": 45,\n  "driverOnly": true,\n  "status": "todo",\n  "priority": 2,\n  "createdAt": 1786932660853,\n  "updatedAt": 1786932660853,\n  "completedAt": null,\n  "metadata": {}\n}\n',
    stderr: "",
  },
  /** `listRecords` — the single read every list/show/load path is built on.
   *  Pins `type`, `parentID`, `dependencies` and the epoch-millisecond
   *  timestamps the adapter divides down to seconds. */
  taskListWithRelations: {
    argv: ["task", "list", "--with-relations", "--json"],
    exitCode: 0,
    stdout:
      '[\n  {\n    "assignee": "be-1",\n    "body": "some body",\n    "completedAt": null,\n    "createdAt": 1786932660853,\n    "deliverable": "a thing",\n    "dependencies": [],\n    "driverOnly": true,\n    "id": "t-02f3afe1",\n    "lane": "fe",\n    "metadata": {},\n    "parentID": "e-4d17bce8",\n    "priority": 2,\n    "staleMinutes": 45,\n    "status": "todo",\n    "title": "task alpha",\n    "type": "task",\n    "updatedAt": 1786932660853\n  },\n  {\n    "assignee": null,\n    "body": null,\n    "completedAt": null,\n    "createdAt": 1786932660795,\n    "deliverable": null,\n    "dependencies": [],\n    "driverOnly": false,\n    "id": "e-4d17bce8",\n    "lane": null,\n    "metadata": {},\n    "parentID": null,\n    "priority": 3,\n    "staleMinutes": null,\n    "status": "todo",\n    "title": "epic one",\n    "type": "epic",\n    "updatedAt": 1786932660795\n  },\n  {\n    "assignee": null,\n    "body": null,\n    "completedAt": null,\n    "createdAt": 1786932660923,\n    "deliverable": null,\n    "dependencies": [\n      "t-02f3afe1"\n    ],\n    "driverOnly": false,\n    "id": "t-b2b57495",\n    "lane": null,\n    "metadata": {},\n    "parentID": null,\n    "priority": 3,\n    "staleMinutes": null,\n    "status": "todo",\n    "title": "task beta",\n    "type": "task",\n    "updatedAt": 1786932660923\n  }\n]\n',
    stderr: "",
  },
  /** Pins the message `KanbanCliAdapter.showTask` matches with
   *  `/task .* not found/` to turn a miss into `null`. */
  taskShowMissing: {
    argv: ["task", "show", "t-deadbeef", "--json"],
    exitCode: 1,
    stdout: "",
    stderr: "Error: task t-deadbeef not found\n",
  },
  /** Pins why `TO_EXTERNAL_STATUS` exists: the runtime rejects atmux's
   *  hyphenated `in-progress` outright. */
  taskMoveInvalidStatus: {
    argv: ["task", "move", "t-b2b57495", "in-progress", "--as", "tester"],
    exitCode: 1,
    stdout: "",
    stderr: "Error: invalid task status in-progress\n",
  },
  /** `moveTask` / `markTaskDone` — pins that `completedAt` is populated on the
   *  returned record rather than requiring a re-read. */
  taskMoveDone: {
    argv: ["task", "move", "t-02f3afe1", "done", "--as", "tester"],
    exitCode: 0,
    stdout:
      '{\n  "id": "t-02f3afe1",\n  "type": "task",\n  "parentID": "e-4d17bce8",\n  "title": "task alpha",\n  "body": "new body",\n  "assignee": null,\n  "lane": null,\n  "deliverable": "deliv2",\n  "staleMinutes": 45,\n  "driverOnly": true,\n  "status": "done",\n  "priority": 7,\n  "createdAt": 1786932660853,\n  "updatedAt": 1786932661501,\n  "completedAt": 1786932661501,\n  "metadata": {}\n}\n',
    stderr: "",
  },
  /** `updateTask` — pins that the mutated record comes back whole. */
  taskUpdateAssign: {
    argv: ["task", "update", "t-02f3afe1", "--as", "tester", "--assignee", "fe-2"],
    exitCode: 0,
    stdout:
      '{\n  "id": "t-02f3afe1",\n  "type": "task",\n  "parentID": "e-4d17bce8",\n  "title": "task alpha",\n  "body": "some body",\n  "assignee": "fe-2",\n  "lane": "fe",\n  "deliverable": "a thing",\n  "staleMinutes": 45,\n  "driverOnly": true,\n  "status": "todo",\n  "priority": 2,\n  "createdAt": 1786932660853,\n  "updatedAt": 1786932661040,\n  "completedAt": null,\n  "metadata": {}\n}\n',
    stderr: "",
  },
  /** `updateTask` clear-flags — pins that cleared fields come back as JSON
   *  `null`, which the adapter passes straight through to `KanbanTask`. */
  taskUpdateClearLane: {
    argv: ["task", "update", "t-02f3afe1", "--as", "tester", "--clear-lane"],
    exitCode: 0,
    stdout:
      '{\n  "id": "t-02f3afe1",\n  "type": "task",\n  "parentID": "e-4d17bce8",\n  "title": "task alpha",\n  "body": "some body",\n  "assignee": null,\n  "lane": null,\n  "deliverable": "a thing",\n  "staleMinutes": 45,\n  "driverOnly": true,\n  "status": "todo",\n  "priority": 2,\n  "createdAt": 1786932660853,\n  "updatedAt": 1786932661198,\n  "completedAt": null,\n  "metadata": {}\n}\n',
    stderr: "",
  },
  /** `removeTask` — pins that removal answers with a receipt object, not the
   *  removed record, so the adapter is right to discard it. */
  taskRemove: {
    argv: ["task", "remove", "t-b2b57495", "--as", "tester"],
    exitCode: 0,
    stdout: '{\n  "removed": "t-b2b57495"\n}\n',
    stderr: "",
  },
  /** `claimTask` — pins that a claim answers with a lease, not a task, which
   *  is why the adapter follows every claim with a read. */
  claim: {
    argv: ["claim", "t-9e692daf", "--as", "be-1", "--caller-scope", "member", "--json"],
    exitCode: 0,
    stdout:
      '{\n  "taskID": "t-9e692daf",\n  "agentID": "be-1",\n  "sessionID": null,\n  "leaseToken": "521635ee-0a29-4b76-b161-3de60ac23204",\n  "claimedAt": 1786933318421,\n  "heartbeatAt": 1786933318421,\n  "expiresAt": 1786934218421\n}\n',
    stderr: "",
  },
  claimAlreadyClaimed: {
    argv: ["claim", "t-9e692daf", "--as", "be-2", "--caller-scope", "member", "--json"],
    exitCode: 1,
    stdout: "",
    stderr: "Error: task t-9e692daf is already claimed\n",
  },
  /** Pins a live hazard: `claim --next` will hand back an EPIC id. Anything
   *  that treats a claim result as a task must cope with that. */
  claimNextPickedAnEpic: {
    argv: ["claim", "--next", "--as", "be-1", "--json"],
    exitCode: 0,
    stdout:
      '{\n  "taskID": "e-4d17bce8",\n  "agentID": "be-1",\n  "sessionID": null,\n  "leaseToken": "63116723-2a53-4dc0-96c1-86d1b039d332",\n  "claimedAt": 1786932661392,\n  "heartbeatAt": 1786932661392,\n  "expiresAt": 1786933561392\n}\n',
    stderr: "",
  },
  claimNextEmpty: {
    argv: ["claim", "--next", "--as", "be-9", "--json"],
    exitCode: 1,
    stdout: "",
    stderr: "Error: no claimable task\n",
  },
  /** `addNote` / the note leg of `markTaskDone`. */
  noteDone: {
    argv: ["note", "t-9e692daf", "closing note", "--as", "be-1", "--kind", "done", "--json"],
    exitCode: 0,
    stdout:
      '{\n  "seq": 1,\n  "taskID": "t-9e692daf",\n  "author": "be-1",\n  "kind": "done",\n  "body": "closing note",\n  "createdAt": 1786933318479\n}\n',
    stderr: "",
  },
} as const satisfies Record<string, KanbanCliFixture>;

export type KanbanCliFixtureName = keyof typeof KANBAN_CLI_FIXTURES;
