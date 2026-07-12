import { CheckIcon, CircleIcon, ListChecksIcon, Loader2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { ActivePlanState } from "~/session-logic";

type TodoStepStatus = ActivePlanState["steps"][number]["status"];

interface TodoListCardProps {
  readonly className?: string;
  readonly plan: ActivePlanState | null;
}

function stepStatusIcon(status: TodoStepStatus) {
  switch (status) {
    case "completed":
      return <CheckIcon className="size-3.5 text-success" />;
    case "inProgress":
      return <Loader2Icon className="size-3.5 animate-spin text-primary" />;
    default:
      return <CircleIcon className="size-3.5 text-muted-foreground/60" />;
  }
}

/**
 * Pinned summary card for the assistant's todo list (TodoWrite plan steps),
 * rendered as the rail's primary card. Distinct from <TaskListCard>: Claude's
 * task lifecycle events track background work (commands, subagents), while
 * the todo list arrives separately as `turn.plan.updated` activities.
 */
export function TodoListCard({ className, plan }: TodoListCardProps) {
  const steps = plan?.steps ?? [];
  if (steps.length === 0) {
    return null;
  }

  const completedCount = steps.filter((step) => step.status === "completed").length;
  const allCompleted = completedCount === steps.length;

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-2xl border border-border/60 bg-background/95 shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <ListChecksIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">To-dos</span>
        <span
          className={cn(
            "ml-auto text-xs tabular-nums",
            allCompleted ? "text-success" : "text-muted-foreground",
          )}
        >
          {completedCount}/{steps.length}
        </span>
      </div>
      <div className="mx-3.5 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            allCompleted ? "bg-success" : "bg-primary/70",
          )}
          style={{ width: `${Math.round((completedCount / steps.length) * 100)}%` }}
        />
      </div>
      <ul className="space-y-0.5 px-2 py-2">
        {steps.map((step) => (
          <li
            key={`${step.status}:${step.step}`}
            className="flex items-start gap-2 rounded-lg px-1.5 py-1.5 hover:bg-muted/50"
          >
            <span className="mt-0.5 shrink-0">{stepStatusIcon(step.status)}</span>
            <span
              className={cn(
                "min-w-0 flex-1 text-xs leading-snug",
                step.status === "completed"
                  ? "text-muted-foreground line-through decoration-muted-foreground/30"
                  : step.status === "inProgress"
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              {step.step}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
