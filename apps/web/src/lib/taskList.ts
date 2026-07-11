import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export type ThreadTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "killed"
  | "paused";

export type ThreadTaskEntry = {
  readonly taskId: string;
  readonly description: string;
  readonly taskType: string | null;
  readonly status: ThreadTaskStatus;
  readonly summary: string | null;
  readonly error: string | null;
  readonly isBackgrounded: boolean;
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

function asTaskStatus(value: unknown): ThreadTaskStatus | null {
  return typeof value === "string" && TASK_STATUSES.has(value) ? (value as ThreadTaskStatus) : null;
}

export function isSettledTaskStatus(status: ThreadTaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "stopped" || status === "killed"
  );
}

/**
 * Fold task lifecycle activities (`task.started` / `task.progress` /
 * `task.completed` / `task.updated`) into an ordered task map for the thread.
 * `task.updated` payloads are incremental patches: only defined fields merge
 * into the entry, mirroring how the provider streams them.
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
      status: "running",
      summary: null,
      error: null,
      isBackgrounded: false,
      updatedAt: activity.createdAt,
    };

    switch (activity.kind) {
      case "task.started": {
        tasks.set(taskId, {
          ...base,
          description: asTrimmedString(payload?.detail) ?? base.description,
          taskType: asTrimmedString(payload?.taskType) ?? base.taskType,
          status: "running",
          updatedAt: activity.createdAt,
        });
        break;
      }
      case "task.progress": {
        tasks.set(taskId, {
          ...base,
          summary: asTrimmedString(payload?.summary) ?? base.summary,
          updatedAt: activity.createdAt,
        });
        break;
      }
      case "task.completed": {
        tasks.set(taskId, {
          ...base,
          status: asTaskStatus(payload?.status) ?? "completed",
          summary: asTrimmedString(payload?.detail) ?? base.summary,
          updatedAt: activity.createdAt,
        });
        break;
      }
      case "task.updated": {
        tasks.set(taskId, {
          ...base,
          status: asTaskStatus(payload?.status) ?? base.status,
          description: asTrimmedString(payload?.description) ?? base.description,
          error: asTrimmedString(payload?.error) ?? base.error,
          isBackgrounded:
            typeof payload?.isBackgrounded === "boolean"
              ? payload.isBackgrounded
              : base.isBackgrounded,
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
