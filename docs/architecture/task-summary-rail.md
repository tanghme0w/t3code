# Task summary rail

A pinned right-hand rail beside the conversation column that summarizes the
thread's work — the assistant's todo list (TodoWrite plan steps) first, then
a status board for the harness-tracked tasks (subagents, background commands,
workflows) with live status and click-to-expand detail rows, modeled on
Codex's pinned-summary layout. When the rail is open
the conversation column (timeline _and_ composer) yields width and re-centers
in the remaining space, mirroring the left sidebar as a three-column layout.
There is never overlay/occlusion: the rail participates in the chat area's
flex row.

## Two "task" concepts

Claude Code has two unrelated things that both sound like a task list; the
rail shows both, on separate cards:

- **Todo list** (`TodoWrite` tool, the `todo summary` mental model): the
  assistant's plan checklist for the turn. The adapter parses TodoWrite tool
  input into `turn.plan.updated` runtime events (`plan: [{ step, status }]`).
  Surface: the rail's **To-dos** card (and the right-hand Plan panel).
- **Harness task lifecycle** (`task_started/…/task_updated` system messages):
  the CLI's registry of _execution units_ — subagents (`local_agent` /
  `remote_agent`), background shell commands (`local_bash`), workflows
  (`local_workflow`). Distinct from the model-driven to-do tools
  (`TaskCreate` / `TaskUpdate` / `TaskList`), whose results the adapter folds
  into `turn.plan.updated` ("Claude Tasks") for the Plan panel. Surface: the
  rail's **Agents & processes** card.

## Data flow

```
[todo card]
Claude TodoWrite tool-input deltas
  → ClaudeAdapter (input_json_delta)       apps/server/src/provider/Layers/ClaudeAdapter.ts
      emits turn.plan.updated                payload.plan: [{ step, status }]
  → runtimeEventToActivities               apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
  → OrchestrationThread.activities         (persisted + replayed like any activity)
  → deriveActivePlanState                  apps/web/src/session-logic.ts
      latest plan of the current turn, falling back to the most recent turn
      with a plan (already derived in ChatView for the Plan panel; the rail
      reuses that value)
  → TodoListCard                           apps/web/src/components/chat/TodoListCard.tsx

[background-task card]
Claude CLI system messages                 (task_started / task_progress /
                                            task_notification / task_updated)
  → ClaudeAdapter.handleSystemMessage      apps/server/src/provider/Layers/ClaudeAdapter.ts
      emits ProviderRuntimeEvents            task.started / task.progress /
                                             task.completed / task.updated
  → runtimeEventToActivities               apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
      one OrchestrationThreadActivity per event (kind mirrors the event type)
  → thread.activity-appended               persisted in the orchestration event
                                           store; replayed on thread reopen —
                                           the rail restores for free
  → OrchestrationThread.activities         packages/client-runtime threadReducer
  → deriveThreadTaskList                   apps/web/src/lib/taskList.ts
      folds the four activity kinds into an ordered task map; `task.updated`
      payloads are incremental patches (only defined fields merge); progress
      summaries accumulate into a bounded per-task history (last 30,
      consecutive duplicates collapsed)
  → useTaskSummaryRail / TaskSummaryRail   apps/web/src/components/chat/TaskSummaryRail.tsx
  → TaskListCard                           apps/web/src/components/chat/TaskListCard.tsx
```

Notes on the wire format:

- `task_started` carries the task's identity: `description`, `task_type`
  (`local_agent` / `remote_agent` / `local_bash` / `local_workflow`),
  `subagent_type` (Task-tool subagents, e.g. `Explore`), `workflow_name`, and
  the subagent `prompt`. The adapter forwards all of these; ingestion bounds
  `prompt` at 2000 chars (`description` at the usual 180) before persisting.
  `deriveThreadTaskList` classifies each entry into a coarse `kind`
  (`agent` / `process` / `workflow`, falling back to `task` for activities
  persisted before these fields existed).
- `task_progress` carries `summary`, `last_tool_name`, and `usage`
  (`total_tokens` / `tool_uses` / `duration_ms`); `task_notification`
  (→ `task.completed`) carries the final `summary`, settle `status`, and
  final `usage`.
- `task_updated` is the Claude CLI's incremental patch of a tracked task's
  state (`patch: { status?, description?, error?, is_backgrounded?, … }`,
  statuses `pending/running/completed/failed/killed/paused`). Clients are
  expected to merge it into their local task map, which is exactly what
  `deriveThreadTaskList` does.
- `task.*` activities are excluded from the Work Log
  (`deriveWorkLogEntries` in `apps/web/src/session-logic.ts`) — the rail is
  their surface.
- Not yet surfaced: `task_notification.output_file` (the task's transcript
  path on the server) — a future "open transcript" affordance.

## UI pieces

- `useTaskSummaryRail(activities, rightPanelOpen, activePlan)` — derives the
  background-task list, passes the plan through, and holds the pinned flag
  (default on). Returns `{ taskList, activePlan, available, open, toggle }`;
  `available` is true when the thread has todos _or_ tasks.
- `TaskSummaryRail` — the `<aside>` column (19.5rem, hidden on `max-sm`).
- `TodoListCard` — the To-dos card: TodoWrite plan steps with per-step status
  icons, progress bar, `completed/total` counter.
- `TaskListCard` — the Agents & processes status board: per-row status icon,
  kind chip (subagent type / `bash` / workflow name), live elapsed time and
  latest summary while running, `bg` badge for backgrounded tasks. Clicking a
  row expands a detail panel (a sibling of the row button, so its text stays
  selectable): runtime stat chips (status, duration, tokens, tool uses,
  current tool), the accumulated progress timeline, the subagent prompt, and
  full error text. A 1s ticker drives the elapsed readout only while a task
  is running.
- The header's task-summary toggle lives in
  `apps/web/src/components/chat/PanelLayoutControls.tsx` behind optional
  props (`taskSummaryAvailable/taskSummaryOpen/onToggleTaskSummary`); it only
  renders when the thread has todos or tasks.

## Adding another card to the rail

1. Derive the card's data from `OrchestrationThread.activities` in a small
   pure helper under `apps/web/src/lib/` (pattern: `taskList.ts`,
   `contextWindow.ts`) so it is unit-testable and replay-safe.
2. If the data needs a new provider signal, add a runtime event in
   `packages/contracts/src/providerRuntime.ts`, emit it from the adapter, and
   map it to an activity in `runtimeEventToActivities` — persistence and
   replay then come for free. Keep the activity out of the Work Log if the
   rail is its surface.
3. Render the card as a sibling of `<TaskListCard>` inside `TaskSummaryRail`;
   each card hides itself when it has nothing to show.

## Upstream-merge posture

Everything rail-specific lives in fork-only files (`TaskSummaryRail.tsx`,
`TaskListCard.tsx`, `TodoListCard.tsx`, `lib/taskList.ts(+test)`, this doc).
The todo card deliberately reuses upstream's plan pipeline
(`turn.plan.updated` → `deriveActivePlanState`) rather than adding transport.
Shared files carry deliberately minimal diffs:

- `packages/contracts/src/providerRuntime.ts` — `task.updated` event type +
  payload; optional `subagentType/workflowName/prompt` on
  `TaskStartedPayload`.
- `ClaudeAdapter.ts` — one `case "task_updated"` in the system-message
  switch; three forwarded fields in `case "task_started"`.
- `ProviderRuntimeIngestion.ts` — one `case "task.updated"` in
  `runtimeEventToActivities`; three passthrough fields in
  `case "task.started"`.
- `session-logic.ts` — one Work Log exclusion line.
- `PanelLayoutControls.tsx` — optional toggle props (inert when unused).
- `ChatView.tsx` — one import, one hook call, three toggle props, one
  conditional `<TaskSummaryRail>` render.

When upstream adds native handling for these subtypes/events, resolve
conflicts by preferring upstream's transport and keeping the derive/UI layer
(`lib/taskList.ts` downward) pointed at whatever activity kinds upstream
emits.
