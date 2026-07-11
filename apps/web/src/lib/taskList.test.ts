import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveThreadTaskList } from "./taskList";

let counter = 0;
function makeActivity(kind: string, payload: unknown): OrchestrationThreadActivity {
  counter += 1;
  return {
    id: EventId.make(`activity-${counter}`),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("taskList", () => {
  it("folds task lifecycle activities into an ordered task map", () => {
    const list = deriveThreadTaskList([
      makeActivity("task.started", {
        taskId: "task-1",
        taskType: "subagent",
        detail: "Explore: map the event pipeline",
      }),
      makeActivity("task.started", { taskId: "task-2", detail: "Run the migration" }),
      makeActivity("task.progress", { taskId: "task-1", summary: "Reading threadReducer" }),
      makeActivity("task.completed", {
        taskId: "task-1",
        status: "completed",
        detail: "Pipeline mapped end-to-end",
      }),
    ]);

    expect(list.totalCount).toBe(2);
    expect(list.settledCount).toBe(1);
    expect(list.tasks[0]?.taskId).toBe("task-1");
    expect(list.tasks[0]?.status).toBe("completed");
    expect(list.tasks[0]?.description).toBe("Explore: map the event pipeline");
    expect(list.tasks[0]?.summary).toBe("Pipeline mapped end-to-end");
    expect(list.tasks[1]?.status).toBe("running");
  });

  it("merges task.updated patches without clobbering unset fields", () => {
    const list = deriveThreadTaskList([
      makeActivity("task.started", { taskId: "task-1", detail: "Background build" }),
      makeActivity("task.updated", { taskId: "task-1", isBackgrounded: true }),
      makeActivity("task.updated", { taskId: "task-1", status: "paused" }),
    ]);

    const task = list.tasks[0];
    expect(task?.description).toBe("Background build");
    expect(task?.status).toBe("paused");
    expect(task?.isBackgrounded).toBe(true);
    expect(list.settledCount).toBe(0);
  });

  it("creates an entry from a bare task.updated and records errors", () => {
    const list = deriveThreadTaskList([
      makeActivity("task.updated", {
        taskId: "task-9",
        status: "failed",
        description: "Flaky deploy",
        error: "exit code 1",
      }),
    ]);

    expect(list.totalCount).toBe(1);
    expect(list.tasks[0]?.status).toBe("failed");
    expect(list.tasks[0]?.error).toBe("exit code 1");
    expect(list.settledCount).toBe(1);
  });

  it("ignores unrelated activities and malformed payloads", () => {
    const list = deriveThreadTaskList([
      makeActivity("tool.started", { taskId: "task-1" }),
      makeActivity("task.updated", {}),
    ]);

    expect(list.totalCount).toBe(0);
  });
});
