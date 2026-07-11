import { useMemo } from "react";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { deriveLatestTurnSummary } from "~/lib/turnSummary";

interface TurnSummaryStripProps {
  readonly className?: string;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity> | undefined;
  readonly turnInProgress: boolean;
}

function categoryDotClass(statusCategory: string | null, live: boolean): string {
  if (live) {
    return "bg-muted-foreground/60 animate-pulse";
  }
  switch (statusCategory) {
    case "failed":
      return "bg-destructive";
    case "blocked":
    case "need_input":
      return "bg-warning";
    default:
      return "bg-success/80";
  }
}

/**
 * One-line turn status above the composer, fed by the provider's background
 * classifier (`turn.summary` activities): a live phrase while the turn runs,
 * the post-turn summary once it settles.
 */
export function TurnSummaryStrip({ className, activities, turnInProgress }: TurnSummaryStripProps) {
  const summary = useMemo(
    () => deriveLatestTurnSummary(activities ?? [], turnInProgress),
    [activities, turnInProgress],
  );

  if (!summary) {
    return null;
  }

  return (
    <div className={cn("mx-auto mb-1.5 w-full max-w-3xl px-1", className)}>
      <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/90">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            categoryDotClass(summary.statusCategory, summary.live),
          )}
        />
        <span className="truncate">{summary.statusDetail}</span>
        {summary.needsAction ? (
          <span className="shrink-0 truncate font-medium text-foreground/80">
            · {summary.needsAction}
          </span>
        ) : null}
      </p>
    </div>
  );
}
