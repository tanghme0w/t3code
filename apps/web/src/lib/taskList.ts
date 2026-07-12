import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type ThreadTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "killed"
  | "paused";

/**
 * Coarse classification of a harness task for the status board: `agent` for
 * Task-tool subagents (local or remote), `process` for background shell
 * commands, `workflow` for orchestration scripts, `task` when the wire gave
 * us nothing to classify by (e.g. activities persisted before these fields
 * were forwarded).
 */
export type ThreadTaskKind = "agent" | "process" | "workflow" | "task";

export type ThreadTaskProgressEntry = {
  readonly at: string;
  readonly summary: string;
};

export type ThreadTaskUsage = {
  readonly totalTokens: number | null;
  readonly toolUses: number | null;
  readonly durationMs: number | null;
};

export type ThreadTaskEntry = {
  readonly taskId: string;
  readonly description: string;
  readonly taskType: string | null;
  readonly kind: ThreadTaskKind;
  readonly subagentType: string | null;
  readonly workflowName: string | null;
  readonly prompt: string | null;
  readonly status: ThreadTaskStatus;
  readonly summary: string | null;
  readonly progress: ReadonlyArray<ThreadTaskProgressEntry>;
  readonly lastToolName: string | null;
  readonly usage: ThreadTaskUsage;
  readonly error: string | null;
  readonly isBackgrounded: boolean;
  readonly startedAt: string;
  readonly settledAt: string | null;
  readonly updatedAt: string;
};

export type ThreadTaskList = {
  readonly tasks: ReadonlyArray<ThreadTaskEntry>;
  readonly settledCount: number;
  readonly totalCount: number;
};

const TASK_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "stopped",
  "killed",
  "paused",
]);

/** Progress summaries kept per task; older entries fall off the front. */
const PROGRESS_HISTORY_LIMIT = 30;

function asTaskStatus(value: unknown): ThreadTaskStatus | null {
  return typeof value === "string" && TASK_STATUSES.has(value) ? (value as ThreadTaskStatus) : null;
}

export function isSettledTaskStatus(status: ThreadTaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "stopped" || status === "killed"
  );
}

function classifyTaskKind(entry: {
  readonly taskType: string | null;
  readonly subagentType: string | null;
  readonly workflowName: string | null;
}): ThreadTaskKind {
  if (entry.workflowName !== null || entry.taskType === "local_workflow") {
    return "workflow";
  }
  if (
    entry.subagentType !== null ||
    entry.taskType === "local_agent" ||
    entry.taskType === "remote_agent"
  ) {
    return "agent";
  }
  if (entry.taskType === "local_bash") {
    return "process";
  }
  return "task";
}

function parseTaskUsage(value: unknown, base: ThreadTaskUsage): ThreadTaskUsage {
  const usage = asRecord(value);
  if (!usage) {
    return base;
  }
  return {
    totalTokens: asFiniteNumber(usage.total_tokens) ?? base.totalTokens,
    toolUses: asFiniteNumber(usage.tool_uses) ?? base.toolUses,
    durationMs: asFiniteNumber(usage.duration_ms) ?? base.durationMs,
  };
}

function appendProgress(
  progress: ReadonlyArray<ThreadTaskProgressEntry>,
  at: string,
  summary: string | null,
): ReadonlyArray<ThreadTaskProgressEntry> {
  if (summary === null || progress.at(-1)?.summary === summary) {
    return progress;
  }
  const next = [...progress, { at, summary }];
  return next.length > PROGRESS_HISTORY_LIMIT ? next.slice(-PROGRESS_HISTORY_LIMIT) : next;
}

/**
 * Fold task lifecycle activities (`task.started` / `task.progress` /
 * `task.completed` / `task.updated`) into an ordered task map for the thread.
 * `task.updated` payloads are incremental patches: only defined fields merge
 * into the entry, mirroring how the provider streams them. Progress summaries
 * accumulate into a bounded per-task history so the status board can expand a
 * row into a timeline.
 */
export function deriveThreadTaskList(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadTaskList {
  const tasks = new Map<string, ThreadTaskEntry>();

  for (const activity of activities) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed" &&
      activity.kind !== "task.updated"
    ) {
      continue;
    }

    const payload = asRecord(activity.payload);
    const taskId = asTrimmedString(payload?.taskId);
    if (taskId === null) {
      continue;
    }

    const existing = tasks.get(taskId);
    const base: ThreadTaskEntry = existing ?? {
      taskId,
      description: "Task",
      taskType: null,
      kind: "task",
      subagentType: null,
      workflowName: null,
      prompt: null,
      status: "running",
      summary: null,
      progress: [],
      lastToolName: null,
      usage: { totalTokens: null, toolUses: null, durationMs: null },
      error: null,
      isBackgrounded: false,
      startedAt: activity.createdAt,
      settledAt: null,
      updatedAt: activity.createdAt,
    };

    switch (activity.kind) {
      case "task.started": {
        const withIdentity: ThreadTaskEntry = {
          ...base,
          description: asTrimmedString(payload?.detail) ?? base.description,
          taskType: asTrimmedString(payload?.taskType) ?? base.taskType,
          subagentType: asTrimmedString(payload?.subagentType) ?? base.subagentType,
          workflowName: asTrimmedString(payload?.workflowName) ?? base.workflowName,
          prompt: asTrimmedString(payload?.prompt) ?? base.prompt,
          status: "running",
          startedAt: activity.createdAt,
          updatedAt: activity.createdAt,
        };
        tasks.set(taskId, { ...withIdentity, kind: classifyTaskKind(withIdentity) });
        break;
      }
      case "task.progress": {
        const summary = asTrimmedString(payload?.summary);
        tasks.set(taskId, {
          ...base,
          summary: summary ?? base.summary,
          progress: appendProgress(base.progress, activity.createdAt, summary),
          lastToolName: asTrimmedString(payload?.lastToolName) ?? base.lastToolName,
          usage: parseTaskUsage(payload?.usage, base.usage),
          updatedAt: activity.createdAt,
        });
        break;
      }
      case "task.completed": {
        tasks.set(taskId, {
          ...base,
          status: asTaskStatus(payload?.status) ?? "completed",
          summary: asTrimmedString(payload?.detail) ?? base.summary,
          usage: parseTaskUsage(payload?.usage, base.usage),
          settledAt: base.settledAt ?? activity.createdAt,
          updatedAt: activity.createdAt,
        });
        break;
      }
      case "task.updated": {
        const status = asTaskStatus(payload?.status) ?? base.status;
        tasks.set(taskId, {
          ...base,
          status,
          description: asTrimmedString(payload?.description) ?? base.description,
          error: asTrimmedString(payload?.error) ?? base.error,
          isBackgrounded:
            typeof payload?.isBackgrounded === "boolean"
              ? payload.isBackgrounded
              : base.isBackgrounded,
          settledAt: isSettledTaskStatus(status)
            ? (base.settledAt ?? activity.createdAt)
            : base.settledAt,
          updatedAt: activity.createdAt,
        });
        break;
      }
    }
  }

  const ordered = [...tasks.values()];
  return {
    tasks: ordered,
    settledCount: ordered.filter((task) => isSettledTaskStatus(task.status)).length,
    totalCount: ordered.length,
  };
}
