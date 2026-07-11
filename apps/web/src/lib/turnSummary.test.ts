import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveLatestTurnSummary } from "./turnSummary";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("turnSummary", () => {
  it("derives the latest final summary when the thread is idle", () => {
    const summary = deriveLatestTurnSummary(
      [
        makeActivity("activity-1", "turn.summary", { statusDetail: "Older summary" }),
        makeActivity("activity-2", "tool.started", {}),
        makeActivity("activity-3", "turn.summary", {
          statusDetail: "Fixed the failing test",
          statusCategory: "completed",
        }),
      ],
      false,
    );

    expect(summary).not.toBeNull();
    expect(summary?.statusDetail).toBe("Fixed the failing test");
    expect(summary?.statusCategory).toBe("completed");
    expect(summary?.live).toBe(false);
    expect(summary?.needsAction).toBeNull();
  });

  it("only surfaces live phrases while a turn is in progress", () => {
    const activities = [
      makeActivity("activity-1", "turn.summary", {
        statusDetail: "Running the test suite",
        live: true,
      }),
    ];

    expect(deriveLatestTurnSummary(activities, true)?.statusDetail).toBe("Running the test suite");
    expect(deriveLatestTurnSummary(activities, false)).toBeNull();
  });

  it("hides a stale final summary while the next turn is running", () => {
    const summary = deriveLatestTurnSummary(
      [
        makeActivity("activity-1", "turn.summary", {
          statusDetail: "Done last turn",
          statusCategory: "completed",
        }),
      ],
      true,
    );

    expect(summary).toBeNull();
  });

  it("carries needsAction for blocked turns", () => {
    const summary = deriveLatestTurnSummary(
      [
        makeActivity("activity-1", "turn.summary", {
          statusDetail: "Waiting on permission: Bash",
          statusCategory: "blocked",
          needsAction: "Approve or deny Bash",
        }),
      ],
      false,
    );

    expect(summary?.needsAction).toBe("Approve or deny Bash");
    expect(summary?.statusCategory).toBe("blocked");
  });

  it("ignores malformed payloads", () => {
    expect(deriveLatestTurnSummary([makeActivity("activity-1", "turn.summary", {})], false)).toBe(
      null,
    );
  });
});
