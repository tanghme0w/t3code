import { useEffect, useState, type ReactNode } from "react";

import {
  BotIcon,
  CheckIcon,
  CircleIcon,
  LayersIcon,
  Loader2Icon,
  PauseIcon,
  TerminalIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import {
  isSettledTaskStatus,
  type ThreadTaskEntry,
  type ThreadTaskKind,
  type ThreadTaskList,
} from "~/lib/taskList";

interface TaskListCardProps {
  readonly className?: string;
  readonly taskList: ThreadTaskList;
}

function statusIcon(task: ThreadTaskEntry) {
  switch (task.status) {
    case "completed":
      return <CheckIcon className="size-3.5 text-success" />;
    case "failed":
    case "killed":
      return <XIcon className="size-3.5 text-destructive" />;
    case "stopped":
      return <XIcon className="size-3.5 text-muted-foreground" />;
    case "paused":
      return <PauseIcon className="size-3.5 text-warning" />;
    case "running":
      return <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />;
    default:
      return <CircleIcon className="size-3.5 text-muted-foreground/60" />;
  }
}

const KIND_ICONS: Record<ThreadTaskKind, typeof BotIcon> = {
  agent: BotIcon,
  process: TerminalIcon,
  workflow: WorkflowIcon,
  task: LayersIcon,
};

function kindChipLabel(task: ThreadTaskEntry): string | null {
  switch (task.kind) {
    case "agent":
      return task.subagentType ?? "agent";
    case "process":
      return "bash";
    case "workflow":
      return task.workflowName ? `workflow · ${task.workflowName}` : "workflow";
    default:
      return task.taskType;
  }
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

const compactNumber = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Wall-clock runtime for the row's elapsed readout: authoritative CLI-side
 * duration when usage carried one, otherwise the activity-timestamp delta
 * (against `now` while the task is still running).
 */
function taskElapsedMs(task: ThreadTaskEntry, now: number): number | null {
  if (task.usage.durationMs !== null && task.status !== "running") {
    return task.usage.durationMs;
  }
  const startedAt = parseTimestamp(task.startedAt);
  if (startedAt === null) {
    return task.usage.durationMs;
  }
  const endedAt = task.status === "running" ? now : parseTimestamp(task.settledAt);
  if (endedAt === null) {
    return task.usage.durationMs;
  }
  return Math.max(0, endedAt - startedAt);
}

function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-muted px-1 py-px text-[10px] whitespace-nowrap text-muted-foreground">
      {children}
    </span>
  );
}

function TaskDetail({ task, elapsedMs }: { task: ThreadTaskEntry; elapsedMs: number | null }) {
  return (
    <div className="space-y-2 px-1.5 pt-0.5 pb-2 pl-7">
      <div className="flex flex-wrap items-center gap-1">
        <MetaChip>{task.status}</MetaChip>
        {elapsedMs !== null ? <MetaChip>{formatDuration(elapsedMs)}</MetaChip> : null}
        {task.usage.totalTokens !== null ? (
          <MetaChip>{compactNumber.format(task.usage.totalTokens)} tok</MetaChip>
        ) : null}
        {task.usage.toolUses !== null ? (
          <MetaChip>
            {task.usage.toolUses} {task.usage.toolUses === 1 ? "tool" : "tools"}
          </MetaChip>
        ) : null}
        {task.lastToolName && !isSettledTaskStatus(task.status) ? (
          <MetaChip>using {task.lastToolName}</MetaChip>
        ) : null}
      </div>
      {task.error ? (
        <p className="text-[11px] leading-relaxed break-words whitespace-pre-wrap text-destructive">
          {task.error}
        </p>
      ) : null}
      {task.progress.length > 0 ? (
        <div>
          <p className="mb-1 text-[10px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
            Progress
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {task.progress.map((entry, index) => (
              <li
                key={`${entry.at}:${index}`}
                className={cn(
                  "flex gap-1.5 text-[11px] leading-relaxed break-words",
                  index === task.progress.length - 1
                    ? "text-foreground/80"
                    : "text-muted-foreground",
                )}
              >
                <span className="mt-[5px] size-1 shrink-0 rounded-full bg-muted-foreground/40" />
                <span className="min-w-0">{entry.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : task.summary ? (
        <p className="text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {task.summary}
        </p>
      ) : null}
      {task.prompt ? (
        <div>
          <p className="mb-1 text-[10px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
            Prompt
          </p>
          <p className="max-h-40 overflow-y-auto rounded-lg bg-muted/40 p-2 text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {task.prompt}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Status board for the thread's harness-tracked tasks — subagents, background
 * commands, workflows — rendered in the rail beside the conversation column.
 * Collapsed rows show live status (spinner, latest summary, elapsed time for
 * running tasks); clicking a row expands it into a detail panel with runtime
 * stats, the progress timeline, the subagent prompt, and full error text. The
 * detail panel is a sibling of the row button so its text stays selectable
 * and scrolling it never toggles the row.
 */
export function TaskListCard({ className, taskList }: TaskListCardProps) {
  const [expandedTaskIds, setExpandedTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const hasRunningTask = taskList.tasks.some((task) => task.status === "running");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunningTask) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningTask]);

  if (taskList.totalCount === 0) {
    return null;
  }

  const toggleExpanded = (taskId: string) => {
    setExpandedTaskIds((previous) => {
      const next = new Set(previous);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const allSettled = taskList.settledCount === taskList.totalCount;

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-2xl border border-border/60 bg-background/95 shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <LayersIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">Agents & processes</span>
        <span
          className={cn(
            "ml-auto text-xs tabular-nums",
            allSettled ? "text-success" : "text-muted-foreground",
          )}
        >
          {taskList.settledCount}/{taskList.totalCount}
        </span>
      </div>
      <div className="mx-3.5 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            allSettled ? "bg-success" : "bg-primary/70",
          )}
          style={{
            width: `${Math.round((taskList.settledCount / taskList.totalCount) * 100)}%`,
          }}
        />
      </div>
      <ul className="space-y-0.5 px-2 py-2">
        {taskList.tasks.map((task) => {
          const expanded = expandedTaskIds.has(task.taskId);
          const KindIcon = KIND_ICONS[task.kind];
          const chipLabel = kindChipLabel(task);
          const elapsedMs = taskElapsedMs(task, now);
          return (
            <li key={task.taskId} className={cn(expanded && "rounded-lg bg-muted/30")}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => toggleExpanded(task.taskId)}
                className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-muted/50"
              >
                <span className="mt-0.5 shrink-0">{statusIcon(task)}</span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-xs",
                      expanded ? "break-words whitespace-normal" : "truncate",
                      isSettledTaskStatus(task.status)
                        ? "text-muted-foreground"
                        : "text-foreground",
                    )}
                    title={expanded ? undefined : task.description}
                  >
                    {task.description}
                  </span>
                  {!expanded && task.error ? (
                    <span
                      className="block truncate text-[11px] text-destructive"
                      title={task.error}
                    >
                      {task.error}
                    </span>
                  ) : !expanded && task.status === "running" && task.summary ? (
                    <span
                      className="block truncate text-[11px] text-muted-foreground"
                      title={task.summary}
                    >
                      {task.summary}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 flex shrink-0 flex-col items-end gap-0.5">
                  {chipLabel ? (
                    <span className="flex items-center gap-1 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
                      <KindIcon className="size-2.5" />
                      {chipLabel}
                    </span>
                  ) : null}
                  {!expanded && task.status === "running" && elapsedMs !== null ? (
                    <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                      {formatDuration(elapsedMs)}
                    </span>
                  ) : null}
                  {task.isBackgrounded ? (
                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      bg
                    </span>
                  ) : null}
                </span>
              </button>
              {expanded ? <TaskDetail task={task} elapsedMs={elapsedMs} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
