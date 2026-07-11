import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export type TurnSummarySnapshot = {
  readonly statusDetail: string;
  readonly statusCategory: string | null;
  readonly needsAction: string | null;
  readonly live: boolean;
  readonly updatedAt: string;
};

/**
 * Latest `turn.summary` activity, filtered so the composer strip never shows
 * stale text: while a turn is running only the mid-turn live phrase qualifies,
 * and once the thread is idle only the final post-turn summary does.
 */
export function deriveLatestTurnSummary(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnInProgress: boolean,
): TurnSummarySnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "turn.summary") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const statusDetail = asTrimmedString(payload?.statusDetail);
    if (statusDetail === null) {
      continue;
    }

    const live = payload?.live === true;
    if (live !== turnInProgress) {
      return null;
    }

    return {
      statusDetail,
      statusCategory: asTrimmedString(payload?.statusCategory),
      needsAction: asTrimmedString(payload?.needsAction),
      live,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}
