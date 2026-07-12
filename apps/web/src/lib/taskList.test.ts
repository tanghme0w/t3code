import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveThreadTaskList } from "./taskList";

let counter = 0;
const BASE_TIME_MS = Date.parse("2026-03-23T00:00:00.000Z");
function makeActivity(kind: string, payload: unknown): OrchestrationThreadActivity {
  counter += 1;
  return {
    id: EventId.make(`activity-${counter}`),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: new Date(BASE_TIME_MS + counter * 1000).toISOString(),
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

  it("classifies tasks into agent/process/workflow kinds", () => {
    const list = deriveThreadTaskList([
      makeActivity("task.started", {
        taskId: "agent-1",
        taskType: "local_agent",
        subagentType: "Explore",
        detail: "Map the pipeline",
        prompt: "Find every consumer of task activities",
      }),
      makeActivity("task.started", {
        taskId: "agent-2",
        taskType: "remote_agent",
        detail: "Cloud review",
      }),
      makeActivity("task.started", {
        taskId: "bash-1",
        taskType: "local_bash",
        detail: "pnpm install",
      }),
      makeActivity("task.started", {
        taskId: "wf-1",
        taskType: "local_workflow",
        workflowName: "spec",
        detail: "Run spec workflow",
      }),
      makeActivity("task.started", { taskId: "bare-1", detail: "Legacy activity" }),
    ]);

    const byId = new Map(list.tasks.map((task) => [task.taskId, task]));
    expect(byId.get("agent-1")?.kind).toBe("agent");
    expect(byId.get("agent-1")?.subagentType).toBe("Explore");
    expect(byId.get("agent-1")?.prompt).toBe("Find every consumer of task activities");
    expect(byId.get("agent-2")?.kind).toBe("agent");
    expect(byId.get("bash-1")?.kind).toBe("process");
    expect(byId.get("wf-1")?.kind).toBe("workflow");
    expect(byId.get("wf-1")?.workflowName).toBe("spec");
    expect(byId.get("bare-1")?.kind).toBe("task");
  });

  it("parses usage stats and keeps the latest defined values", () => {
    const list = deriveThreadTaskList([
      makeActivity("task.started", { taskId: "task-1", detail: "Agent run" }),
      makeActivity("task.progress", {
        taskId: "task-1",
        summary: "Reading files",
        lastToolName: "Read",
        usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 },
      }),
      makeActivity("task.progress", {
        taskId: "task-1",
        summary: "Editing files",
        lastToolName: "Edit",
        usage: "not-a-record",
      }),
      makeActivity("task.completed", {
        taskId: "task-1",
        status: "completed",
        usage: { total_tokens: 5400, tool_uses: 9, duration_ms: 61000 },
      }),
    ]);

    const task = list.tasks[0];
    expect(task?.usage).toEqual({ totalTokens: 5400, toolUses: 9, durationMs: 61000 });
    expect(task?.lastToolName).toBe("Edit");
  });

  it("accumulates a bounded progress history and dedupes consecutive summaries", () => {
    const activities = [
      makeActivity("task.started", { taskId: "task-1", detail: "Long agent run" }),
      makeActivity("task.progress", { taskId: "task-1", summary: "Step one" }),
      makeActivity("task.progress", { taskId: "task-1", summary: "Step one" }),
      makeActivity("task.progress", { taskId: "task-1" }),
      makeActivity("task.progress", { taskId: "task-1", summary: "Step two" }),
    ];
    const list = deriveThreadTaskList(activities);
    expect(list.tasks[0]?.progress.map((entry) => entry.summary)).toEqual(["Step one", "Step two"]);
    expect(list.tasks[0]?.summary).toBe("Step two");

    const many = [makeActivity("task.started", { taskId: "task-2", detail: "Chatty run" })];
    for (let index = 0; index < 35; index += 1) {
      many.push(makeActivity("task.progress", { taskId: "task-2", summary: `Update ${index}` }));
    }
    const capped = deriveThreadTaskList(many);
    expect(capped.tasks[0]?.progress).toHaveLength(30);
    expect(capped.tasks[0]?.progress[0]?.summary).toBe("Update 5");
    expect(capped.tasks[0]?.progress.at(-1)?.summary).toBe("Update 34");
  });

  it("tracks startedAt and settledAt from activity timestamps", () => {
    const started = makeActivity("task.started", { taskId: "task-1", detail: "Agent run" });
    const progress = makeActivity("task.progress", { taskId: "task-1", summary: "Working" });
    const completed = makeActivity("task.completed", { taskId: "task-1", status: "completed" });
    const list = deriveThreadTaskList([started, progress, completed]);

    expect(list.tasks[0]?.startedAt).toBe(started.createdAt);
    expect(list.tasks[0]?.settledAt).toBe(completed.createdAt);

    const killed = makeActivity("task.updated", { taskId: "task-2", status: "killed" });
    const killedList = deriveThreadTaskList([
      makeActivity("task.started", { taskId: "task-2", detail: "Doomed run" }),
      killed,
    ]);
    expect(killedList.tasks[0]?.settledAt).toBe(killed.createdAt);
    expect(killedList.settledCount).toBe(1);
  });
});
