# Task summary rail

A pinned right-hand rail beside the conversation column that shows the
thread's harness-tracked tasks (subagents, background work) with live status —
modeled on Codex's pinned-summary layout. When the rail is open the
conversation column (timeline _and_ composer) yields width and re-centers in
the remaining space, mirroring the left sidebar as a three-column layout.
There is never overlay/occlusion: the rail participates in the chat area's
flex row.

## Data flow

```
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
      payloads are incremental patches (only defined fields merge)
  → useTaskSummaryRail / TaskSummaryRail   apps/web/src/components/chat/TaskSummaryRail.tsx
  → TaskListCard                           apps/web/src/components/chat/TaskListCard.tsx
```

Notes on the wire format:

- `task_updated` is the Claude CLI's incremental patch of a tracked task's
  state (`patch: { status?, description?, error?, is_backgrounded?, … }`,
  statuses `pending/running/completed/failed/killed/paused`). Clients are
  expected to merge it into their local task map, which is exactly what
  `deriveThreadTaskList` does.
- `task.*` activities are excluded from the Work Log
  (`deriveWorkLogEntries` in `apps/web/src/session-logic.ts`) — the rail is
  their surface.

## UI pieces

- `useTaskSummaryRail(activities)` — derives the task list and holds the
  pinned flag (default on). Returns `{ taskList, available, open, toggle }`.
- `TaskSummaryRail` — the `<aside>` column (19.5rem, hidden on `max-sm`).
- `TaskListCard` — the tasks card: status icons, progress bar, `n/m` counter,
  live mid-task summaries, `bg` badge for backgrounded tasks.
- The header's task-summary toggle lives in
  `apps/web/src/components/chat/PanelLayoutControls.tsx` behind optional
  props (`taskSummaryAvailable/taskSummaryOpen/onToggleTaskSummary`); it only
  renders when the thread has tasks.

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
`TaskListCard.tsx`, `lib/taskList.ts(+test)`, this doc). Shared files carry
deliberately minimal diffs:

- `packages/contracts/src/providerRuntime.ts` — `task.updated` event type +
  payload.
- `ClaudeAdapter.ts` — one `case "task_updated"` in the system-message switch.
- `ProviderRuntimeIngestion.ts` — one `case "task.updated"` in
  `runtimeEventToActivities`.
- `session-logic.ts` — one Work Log exclusion line.
- `PanelLayoutControls.tsx` — optional toggle props (inert when unused).
- `ChatView.tsx` — one import, one hook call, three toggle props, one
  conditional `<TaskSummaryRail>` render.

When upstream adds native handling for these subtypes/events, resolve
conflicts by preferring upstream's transport and keeping the derive/UI layer
(`lib/taskList.ts` downward) pointed at whatever activity kinds upstream
emits.
