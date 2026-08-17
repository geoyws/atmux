import { basename, dirname, resolve } from "node:path";
import type { Kanban, KanbanEpic, KanbanStory, KanbanTask } from "../schema/kanban.ts";

type JsonObject = Record<string, unknown>;

export interface KanbanCliRunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
}

export type KanbanCliRunner = (
  args: readonly string[],
  options: KanbanCliRunOptions,
) => Promise<unknown>;

export interface ExternalTaskRecord extends JsonObject {
  type?: string;
  parentID: string | null;
  id: string;
  title: string;
  body: string | null;
  status: string;
  assignee: string | null;
  lane: string | null;
  deliverable: string | null;
  staleMinutes: number | null;
  driverOnly: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  metadata: JsonObject;
  dependencies?: string[];
}

function workflowStatus(task: ExternalTaskRecord, fallback: string): string {
  return typeof task.metadata.workflowStatus === "string" ? task.metadata.workflowStatus : fallback;
}

function epicFromExternal(task: ExternalTaskRecord): KanbanEpic {
  const legacyExtra =
    task.metadata.atmuxExtra !== null && typeof task.metadata.atmuxExtra === "object"
      ? (task.metadata.atmuxExtra as Record<string, unknown>)
      : {};
  const extra: Record<string, unknown> = { ...legacyExtra };
  const autoSpawn = task.metadata.autoSpawn;
  if (
    autoSpawn !== null &&
    typeof autoSpawn === "object" &&
    "enabled" in autoSpawn &&
    typeof autoSpawn.enabled === "boolean"
  ) {
    extra.autoSpawn = autoSpawn;
  }
  if (task.metadata.spawnFailed !== undefined) extra.spawnFailed = task.metadata.spawnFailed;
  if (task.metadata.spawnPressureDeferred !== undefined) {
    extra.spawnPressureDeferred = task.metadata.spawnPressureDeferred;
  }
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    status: workflowStatus(task, task.status),
    driverRef: typeof task.metadata.driverRef === "string" ? task.metadata.driverRef : null,
    createdAt: seconds(task.createdAt) ?? 0,
    completedAt: seconds(task.completedAt),
    stories: Array.isArray(task.metadata.legacyStories)
      ? task.metadata.legacyStories.map(String)
      : [],
    dependsOn: task.dependencies ?? [],
    isReady: task.metadata.isReady === true,
    spawnedAt: typeof task.metadata.spawnedAt === "number" ? task.metadata.spawnedAt : null,
    extra: Object.keys(extra).length ? (extra as NonNullable<KanbanEpic["extra"]>) : undefined,
  };
}

function storyFromExternal(task: ExternalTaskRecord): KanbanStory {
  return {
    id: task.id,
    epic: task.parentID === null || task.parentID === undefined ? null : String(task.parentID),
    title: task.title,
    body: task.body,
    acceptanceCriteria:
      typeof task.metadata.acceptanceCriteria === "string"
        ? task.metadata.acceptanceCriteria
        : null,
    status: workflowStatus(task, task.status),
    createdAt: seconds(task.createdAt) ?? 0,
    completedAt: seconds(task.completedAt),
    advancedAt: typeof task.metadata.advancedAt === "number" ? task.metadata.advancedAt : null,
    reviewSignoff: task.metadata.reviewSignoff === true,
    mergeTaskId: typeof task.metadata.mergeTaskID === "string" ? task.metadata.mergeTaskID : null,
    mergeMode: task.metadata.mergeMode === "trunk-direct" ? "trunk-direct" : "feature-branch",
    signoffAudit: Array.isArray(task.metadata.signoffAudit)
      ? (task.metadata.signoffAudit as Record<string, unknown>[])
      : null,
    extra:
      task.metadata.atmuxExtra !== null && typeof task.metadata.atmuxExtra === "object"
        ? (task.metadata.atmuxExtra as Record<string, unknown>)
        : undefined,
  };
}

export interface KanbanCliAdapterOptions {
  binary?: string;
  env?: Record<string, string | undefined>;
  runner?: KanbanCliRunner;
}

export interface ExternalAdvanceStoryResult {
  from: string;
  to: string;
  parentEpicFlipped: boolean;
  dispatchedTaskID: string | null;
  noop: boolean;
}

const TO_EXTERNAL_STATUS: Record<string, string> = {
  backlog: "backlog",
  todo: "todo",
  "in-progress": "in_progress",
  in_progress: "in_progress",
  blocked: "blocked",
  review: "review",
  done: "done",
  cancelled: "cancelled",
  wontfix: "cancelled",
};

const FROM_EXTERNAL_STATUS: Record<string, string> = {
  backlog: "backlog",
  todo: "todo",
  in_progress: "in-progress",
  blocked: "blocked",
  review: "review",
  done: "done",
  cancelled: "cancelled",
};

function externalStatus(status: string): string {
  const mapped = TO_EXTERNAL_STATUS[status];
  if (!mapped) throw new Error(`unsupported atmux status ${JSON.stringify(status)}`);
  return mapped;
}

function atmuxStatus(status: string): string {
  const mapped = FROM_EXTERNAL_STATUS[status];
  if (!mapped) throw new Error(`unsupported Kanban status ${JSON.stringify(status)}`);
  return mapped;
}

function seconds(epochMs: number | null): number | null {
  return epochMs === null ? null : Math.floor(epochMs / 1_000);
}

function legacyValue(value: unknown): string | Record<string, unknown> | null {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function taskFromExternal(
  task: ExternalTaskRecord,
  records: readonly ExternalTaskRecord[] = [],
): KanbanTask {
  const metadata = task.metadata ?? {};
  const byID = new Map(records.map((record) => [record.id, record]));
  const parent = task.parentID ? byID.get(task.parentID) : undefined;
  const story = parent?.type === "story" ? parent.id : null;
  const epicParent = story && parent?.parentID ? byID.get(parent.parentID) : undefined;
  const epic =
    parent?.type === "epic"
      ? parent.id
      : epicParent?.type === "epic"
        ? epicParent.id
        : typeof metadata.legacyEpic === "string"
          ? metadata.legacyEpic
          : null;
  return {
    id: task.id,
    subject: task.title,
    body: task.body ?? "",
    status: atmuxStatus(task.status),
    owner: task.assignee,
    deps: task.dependencies ?? [],
    priority: task.priority,
    lane: task.lane,
    deliverable: task.deliverable,
    staleMin: task.staleMinutes,
    driverOnly: task.driverOnly,
    epic,
    story: story ?? (typeof metadata.legacyStory === "string" ? metadata.legacyStory : null),
    createdAt: seconds(task.createdAt) ?? 0,
    claimedAt: task.status === "in_progress" ? seconds(task.updatedAt) : null,
    completedAt: seconds(task.completedAt),
    claimedFrom: legacyValue(metadata.claimedFrom),
    createdFrom: legacyValue(metadata.createdFrom),
  };
}

async function defaultRunner(
  binary: string,
  args: readonly string[],
  options: KanbanCliRunOptions,
): Promise<unknown> {
  const proc = Bun.spawn([binary, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `kanban exited ${exitCode}`);
  }
  const text = stdout.trim();
  return text ? (JSON.parse(text) as unknown) : null;
}

export class KanbanCliAdapter {
  readonly binary: string;
  private readonly env: Record<string, string | undefined>;
  private readonly runner: KanbanCliRunner;

  constructor(options: KanbanCliAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.KANBAN_BIN ?? "kanban";
    this.env = options.env ?? {};
    this.runner =
      options.runner ?? ((args, runOptions) => defaultRunner(this.binary, args, runOptions));
  }

  private projectRoot(atmuxDir: string): string {
    const absolute = resolve(atmuxDir);
    return basename(absolute) === ".atmux" ? dirname(absolute) : absolute;
  }

  private run(atmuxDir: string, args: readonly string[]): Promise<unknown> {
    return this.runner(args, { cwd: this.projectRoot(atmuxDir), env: this.env });
  }

  private async listRecords(atmuxDir: string): Promise<ExternalTaskRecord[]> {
    return ((await this.run(atmuxDir, ["task", "list", "--with-relations", "--json"])) ??
      []) as ExternalTaskRecord[];
  }

  async initialize(atmuxDir: string, name?: string): Promise<void> {
    const root = this.projectRoot(atmuxDir);
    await this.runner(["init", "--workspace", root, "--name", name ?? basename(root), "--json"], {
      cwd: root,
      env: this.env,
    });
  }

  async importState(
    atmuxDir: string,
    stateDbPath: string,
    actor: string,
    reconcile = false,
  ): Promise<unknown> {
    const args = ["import", "atmux-sqlite", resolve(stateDbPath), "--as", actor, "--json"];
    if (reconcile) args.push("--reconcile");
    return this.run(atmuxDir, args);
  }

  async importJson(
    atmuxDir: string,
    kanbanJsonPath: string,
    actor: string,
    reconcile = false,
  ): Promise<unknown> {
    const args = ["import", "atmux-json", resolve(kanbanJsonPath), "--as", actor, "--json"];
    if (reconcile) args.push("--reconcile");
    return this.run(atmuxDir, args);
  }

  async doctor(atmuxDir: string): Promise<unknown> {
    return this.run(atmuxDir, ["doctor", "--json"]);
  }

  async backup(atmuxDir: string, outputDirectory: string): Promise<unknown> {
    return this.run(atmuxDir, ["backup", "--output", resolve(outputDirectory), "--json"]);
  }

  async listTasks(
    atmuxDir: string,
    filter: { status?: string; assignee?: string; lane?: string } = {},
  ): Promise<KanbanTask[]> {
    const records = await this.listRecords(atmuxDir);
    return records
      .filter((task) => task.type === undefined || task.type === "task")
      .map((task) => taskFromExternal(task, records))
      .filter((task) => (filter.status ? task.status === filter.status : true))
      .filter((task) => (filter.assignee ? task.owner === filter.assignee : true))
      .filter((task) => (filter.lane ? task.lane === filter.lane : true));
  }

  async loadKanban(atmuxDir: string): Promise<Kanban> {
    const records = await this.listRecords(atmuxDir);
    return {
      tasks: records
        .filter((task) => task.type === "task")
        .map((task) => taskFromExternal(task, records)),
      stories: records.filter((task) => task.type === "story").map(storyFromExternal),
      epics: records.filter((task) => task.type === "epic").map(epicFromExternal),
    };
  }

  async showTask(atmuxDir: string, id: string): Promise<KanbanTask | null> {
    try {
      const records = await this.listRecords(atmuxDir);
      const raw = records.find((record) => record.id === id);
      return raw ? taskFromExternal(raw, records) : null;
    } catch (error) {
      if (error instanceof Error && /task .* not found/.test(error.message)) return null;
      throw error;
    }
  }

  async addTask(
    atmuxDir: string,
    options: {
      type?: "epic" | "story" | "task";
      subject: string;
      body?: string;
      assignee?: string;
      deps?: readonly string[];
      priority?: number;
      lane?: string;
      driverOnly?: boolean;
      epic?: string;
      story?: string;
      deliverable?: string;
    },
  ): Promise<string> {
    const args = ["task", "add", options.subject, "--json"];
    if (options.type) args.push("--type", options.type);
    if (options.body) args.push("--body", options.body);
    if (options.assignee) args.push("--assignee", options.assignee);
    for (const dependency of options.deps ?? []) args.push("--depends-on", dependency);
    if (options.priority !== undefined) args.push("--priority", String(options.priority));
    if (options.lane) args.push("--lane", options.lane);
    if (options.deliverable) args.push("--deliverable", options.deliverable);
    if (options.driverOnly) args.push("--driver-only");
    const parent = options.story ?? options.epic;
    if (parent) args.push("--parent", parent);
    const raw = (await this.run(atmuxDir, args)) as { id: string };
    return raw.id;
  }

  async removeTask(atmuxDir: string, id: string, actor = "atmux"): Promise<void> {
    await this.run(atmuxDir, ["task", "remove", id, "--as", actor, "--json"]);
  }

  async moveTask(atmuxDir: string, id: string, status: string, actor: string): Promise<KanbanTask> {
    const raw = (await this.run(atmuxDir, [
      "task",
      "move",
      id,
      externalStatus(status),
      "--as",
      actor,
      "--json",
    ])) as ExternalTaskRecord;
    return taskFromExternal(raw);
  }

  async transitionTask(
    atmuxDir: string,
    id: string,
    status: string,
    actor: string,
    metadataPatch: Record<string, unknown>,
  ): Promise<KanbanTask> {
    const raw = (await this.run(atmuxDir, [
      "task",
      "move",
      id,
      externalStatus(status),
      "--as",
      actor,
      "--metadata-patch-json",
      JSON.stringify(metadataPatch),
      "--json",
    ])) as ExternalTaskRecord;
    return taskFromExternal(raw);
  }

  async patchMetadata(
    atmuxDir: string,
    id: string,
    actor: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await this.run(atmuxDir, [
      "task",
      "metadata",
      id,
      "--as",
      actor,
      "--patch-json",
      JSON.stringify(patch),
      "--json",
    ]);
  }

  async advanceStory(
    atmuxDir: string,
    id: string,
    actor: string,
    options: { target?: string; reviewer?: string; committer?: string } = {},
  ): Promise<ExternalAdvanceStoryResult> {
    const args = ["story", "advance", id, "--as", actor, "--json"];
    if (options.target) args.push("--to", options.target);
    if (options.reviewer) args.push("--reviewer", options.reviewer);
    if (options.committer) args.push("--committer", options.committer);
    return (await this.run(atmuxDir, args)) as ExternalAdvanceStoryResult;
  }

  async setStorySignoff(
    atmuxDir: string,
    id: string,
    actor: string,
    signed: boolean,
    note?: string,
  ): Promise<{ storyID: string; actor: string; at: number; note: string | null }> {
    const args = ["story", signed ? "signoff" : "unsignoff", id, "--as", actor, "--json"];
    if (note) args.push("--note", note);
    return (await this.run(atmuxDir, args)) as {
      storyID: string;
      actor: string;
      at: number;
      note: string | null;
    };
  }

  async updateTask(
    atmuxDir: string,
    id: string,
    actor: string,
    fields: {
      parentID?: string | null;
      body?: string;
      assignee?: string | null;
      dependencies?: readonly string[];
      priority?: number;
      lane?: string | null;
      deliverable?: string | null;
      driverOnly?: boolean;
    },
  ): Promise<KanbanTask> {
    const args = ["task", "update", id, "--as", actor, "--json"];
    if (fields.parentID === null) args.push("--clear-parent");
    else if (fields.parentID !== undefined) args.push("--parent", fields.parentID);
    if (fields.body !== undefined) args.push("--body", fields.body);
    if (fields.assignee === null) args.push("--unassign");
    else if (fields.assignee !== undefined) args.push("--assignee", fields.assignee);
    if (fields.dependencies !== undefined) {
      if (fields.dependencies.length === 0) args.push("--clear-dependencies");
      else for (const dependency of fields.dependencies) args.push("--depends-on", dependency);
    }
    if (fields.priority !== undefined) args.push("--priority", String(fields.priority));
    if (fields.lane === null) args.push("--clear-lane");
    else if (fields.lane !== undefined) args.push("--lane", fields.lane);
    if (fields.deliverable === null) args.push("--clear-deliverable");
    else if (fields.deliverable !== undefined) args.push("--deliverable", fields.deliverable);
    if (fields.driverOnly !== undefined) {
      args.push(fields.driverOnly ? "--driver-only" : "--no-driver-only");
    }
    const raw = (await this.run(atmuxDir, args)) as ExternalTaskRecord;
    return taskFromExternal(raw);
  }

  async claimTask(
    atmuxDir: string,
    id: string | undefined,
    who: string,
    options: {
      callerScope?: "member" | "driver";
      lane?: string;
      role?: string;
      allowReassign?: boolean;
    } = {},
  ): Promise<KanbanTask> {
    const args = ["claim", ...(id ? [id] : ["--next"]), "--as", who, "--json"];
    if (options.callerScope) args.push("--caller-scope", options.callerScope);
    if (options.lane) args.push("--lane", options.lane);
    if (options.role) args.push("--role", options.role);
    if (options.allowReassign) args.push("--allow-reassign");
    const claim = (await this.run(atmuxDir, args)) as { taskID: string };
    const task = await this.showTask(atmuxDir, claim.taskID);
    if (!task) throw new Error(`Kanban claim returned missing task ${claim.taskID}`);
    return task;
  }

  async markTaskDone(
    atmuxDir: string,
    id: string,
    actor: string,
    note?: string,
  ): Promise<KanbanTask> {
    if (note !== undefined) {
      await this.run(atmuxDir, ["note", id, note, "--as", actor, "--kind", "done", "--json"]);
    }
    return this.moveTask(atmuxDir, id, "done", actor);
  }

  async addNote(
    atmuxDir: string,
    id: string,
    actor: string,
    kind: "plan" | "progress" | "blocker" | "decision" | "evidence" | "done",
    body: string,
  ): Promise<void> {
    await this.run(atmuxDir, ["note", id, body, "--as", actor, "--kind", kind, "--json"]);
  }
}
