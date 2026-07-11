import { useState } from "react";

import { CheckIcon, CircleIcon, LayersIcon, Loader2Icon, PauseIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { isSettledTaskStatus, type ThreadTaskEntry, type ThreadTaskList } from "~/lib/taskList";

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

/**
 * Pinned summary panel for the thread's harness-tracked tasks (subagents,
 * background work), rendered in the rail beside the conversation column. The
 * rail's visibility is controlled by the header's task-summary toggle. Rows
 * truncate to one line; clicking a row toggles it to full wrapped text.
 */
export function TaskListCard({ className, taskList }: TaskListCardProps) {
  const [expandedTaskIds, setExpandedTaskIds] = useState<ReadonlySet<string>>(() => new Set());

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
        <span className="text-sm font-medium">Background tasks</span>
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
          return (
            <li key={task.taskId}>
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
                  {task.error ? (
                    <span
                      className={cn(
                        "block text-[11px] text-destructive",
                        expanded ? "break-words whitespace-normal" : "truncate",
                      )}
                      title={expanded ? undefined : task.error}
                    >
                      {task.error}
                    </span>
                  ) : task.status === "running" && task.summary ? (
                    <span
                      className={cn(
                        "block text-[11px] text-muted-foreground",
                        expanded ? "break-words whitespace-normal" : "truncate",
                      )}
                      title={expanded ? undefined : task.summary}
                    >
                      {task.summary}
                    </span>
                  ) : null}
                </span>
                {task.isBackgrounded ? (
                  <span className="mt-0.5 shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    bg
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
