import { useCallback, useEffect, useMemo, useState } from "react";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { deriveThreadTaskList, type ThreadTaskList } from "~/lib/taskList";
import type { ActivePlanState } from "~/session-logic";
import { TaskListCard } from "./TaskListCard";
import { TodoListCard } from "./TodoListCard";

/**
 * Pinned summary rail beside the conversation column (Codex-style three-column
 * layout: sidebar / conversation / rail). The rail participates in the chat
 * area's flex row, so when it is open the conversation column — timeline and
 * composer alike — yields width and re-centers in the remaining space instead
 * of being overlaid.
 *
 * This file owns everything rail-related so the ChatView diff against
 * upstream stays minimal: one hook call, three props on the header toggle,
 * and one conditional render of <TaskSummaryRail>.
 */

export interface TaskSummaryRailState {
  /** Derived background-task list for the rail's cards. */
  readonly taskList: ThreadTaskList;
  /** Latest TodoWrite plan for the rail's todo card (null when none). */
  readonly activePlan: ActivePlanState | null;
  /** Whether the thread has anything to summarize (controls the header toggle). */
  readonly available: boolean;
  /** Whether the rail should currently be rendered. */
  readonly open: boolean;
  /** Header-toggle handler flipping the pinned state. */
  readonly toggle: () => void;
}

/**
 * Rail state for a thread: derives the background-task list from activities,
 * carries the thread's latest TodoWrite plan, and holds the pinned flag behind
 * the header's task-summary toggle. Pinned by default; the rail only renders
 * while the thread actually has todos or tasks. When `rightPanelOpen` flips
 * on, the rail unpins itself so the two side surfaces do not stack — the user
 * can still re-pin it via the header toggle.
 */
export function useTaskSummaryRail(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
  rightPanelOpen: boolean,
  activePlan: ActivePlanState | null,
): TaskSummaryRailState {
  const taskList = useMemo(() => deriveThreadTaskList(activities ?? []), [activities]);
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    if (rightPanelOpen) {
      setPinned(false);
    }
  }, [rightPanelOpen]);
  const toggle = useCallback(() => setPinned((value) => !value), []);
  const available = taskList.totalCount > 0 || (activePlan?.steps.length ?? 0) > 0;
  return {
    taskList,
    activePlan,
    available,
    open: pinned && available,
    toggle,
  };
}

interface TaskSummaryRailProps {
  readonly taskList: ThreadTaskList;
  readonly activePlan: ActivePlanState | null;
}

/**
 * The rail column itself: the todo card (TodoWrite plan steps) first, then the
 * background-task card. New summary cards (outputs, sources, …) extend this by
 * rendering as further siblings — each card derives its own data from thread
 * activities and hides itself when it has nothing to show.
 */
export function TaskSummaryRail({ taskList, activePlan }: TaskSummaryRailProps) {
  return (
    <aside className="min-h-0 w-[19.5rem] shrink-0 space-y-3 overflow-y-auto p-3 max-sm:hidden">
      <TodoListCard plan={activePlan} />
      <TaskListCard taskList={taskList} />
    </aside>
  );
}
