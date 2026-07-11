import { useCallback, useEffect, useMemo, useState } from "react";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { deriveThreadTaskList, type ThreadTaskList } from "~/lib/taskList";
import { TaskListCard } from "./TaskListCard";

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
  /** Derived task list for the rail's cards. */
  readonly taskList: ThreadTaskList;
  /** Whether the thread has anything to summarize (controls the header toggle). */
  readonly available: boolean;
  /** Whether the rail should currently be rendered. */
  readonly open: boolean;
  /** Header-toggle handler flipping the pinned state. */
  readonly toggle: () => void;
}

/**
 * Rail state for a thread: derives the task list from activities and holds
 * the pinned flag behind the header's task-summary toggle. Pinned by default;
 * the rail only renders while the thread actually has tasks. When
 * `rightPanelOpen` flips on, the rail unpins itself so the two side surfaces
 * do not stack — the user can still re-pin it via the header toggle.
 */
export function useTaskSummaryRail(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
  rightPanelOpen: boolean,
): TaskSummaryRailState {
  const taskList = useMemo(() => deriveThreadTaskList(activities ?? []), [activities]);
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    if (rightPanelOpen) {
      setPinned(false);
    }
  }, [rightPanelOpen]);
  const toggle = useCallback(() => setPinned((value) => !value), []);
  const available = taskList.totalCount > 0;
  return {
    taskList,
    available,
    open: pinned && available,
    toggle,
  };
}

interface TaskSummaryRailProps {
  readonly taskList: ThreadTaskList;
}

/**
 * The rail column itself. New summary cards (outputs, sources, …) extend this
 * by rendering as siblings of <TaskListCard> — each card derives its own data
 * from thread activities and hides itself when it has nothing to show.
 */
export function TaskSummaryRail({ taskList }: TaskSummaryRailProps) {
  return (
    <aside className="min-h-0 w-[19.5rem] shrink-0 overflow-y-auto py-3 pr-3 max-sm:hidden">
      <TaskListCard taskList={taskList} />
    </aside>
  );
}
