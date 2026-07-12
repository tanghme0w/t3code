/**
 * ThreadForkProjection — projection handler for `thread.forked`.
 *
 * Copies the source thread's projected history (messages, turns, activities)
 * into the freshly created fork thread, up to an optional exclusive cut
 * point, and repoints the fork's head. Runs inside the projection pipeline's
 * transaction like any other projector case; the provider-side fork (resume
 * cursor seeding) is handled separately by ThreadForkReactor.
 *
 * Replay safety: projection bootstrap replays events after a crash, so every
 * minted id must be deterministic. Cloned message/activity ids are derived
 * as `<newThreadId>::<sourceId>`; turn ids are unique per thread and copied
 * verbatim.
 *
 * Deliberate v1 limits:
 * - attachments are dropped from cloned messages (the files live under the
 *   source thread's attachment directory);
 * - checkpoint columns are cleared (git checkpoint refs are namespaced by
 *   thread id, so the fork starts without file-revert history);
 * - in-flight source turns are cloned as `interrupted`.
 */
import type { MessageId, OrchestrationEvent, ThreadId, TurnId } from "@t3tools/contracts";
import { EventId, MessageId as MessageIdSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type {
  ProjectionThreadActivity,
  ProjectionThreadActivityRepositoryShape,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
import type {
  ProjectionThreadMessage,
  ProjectionThreadMessageRepositoryShape,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import type {
  ProjectionThread,
  ProjectionThreadRepositoryShape,
} from "../../persistence/Services/ProjectionThreads.ts";
import type {
  ProjectionTurn,
  ProjectionTurnRepositoryShape,
} from "../../persistence/Services/ProjectionTurns.ts";

export interface ThreadForkProjectionDeps {
  readonly threads: Pick<ProjectionThreadRepositoryShape, "getById" | "upsert">;
  readonly messages: Pick<ProjectionThreadMessageRepositoryShape, "listByThreadId" | "upsert">;
  readonly turns: Pick<ProjectionTurnRepositoryShape, "listByThreadId" | "upsertByTurnId">;
  readonly activities: Pick<ProjectionThreadActivityRepositoryShape, "listByThreadId" | "upsert">;
  readonly refreshThreadShellSummary: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

type ThreadForkedEvent = Extract<OrchestrationEvent, { type: "thread.forked" }>;

function forkedMessageId(forkThreadId: ThreadId, sourceId: MessageId): MessageId {
  return MessageIdSchema.make(`${forkThreadId}::${sourceId}`);
}

function forkedActivityId(forkThreadId: ThreadId, sourceId: string): EventId {
  return EventId.make(`${forkThreadId}::${sourceId}`);
}

function turnSortKey(turn: ProjectionTurn): string {
  return turn.requestedAt;
}

/**
 * Resolves the exclusive fork cut over the source turns.
 *
 * `atMessageId` is the authoritative boundary when present: the message
 * itself, any turn it started, and every turn requested at or after it are
 * excluded. `atTurnId` additionally cuts strictly before that turn; both
 * constraints intersect, so a mis-derived later turn id can never widen the
 * copy past the boundary message. With neither, the whole history is kept
 * (tip fork).
 *
 * Returns the kept turns plus the createdAt cutoff used for turnless rows
 * (user messages and activities carry no turnId, so they are cut by time).
 */
function selectKeptTurns(
  turns: ReadonlyArray<ProjectionTurn>,
  messages: ReadonlyArray<ProjectionThreadMessage>,
  cut: { readonly atTurnId: TurnId | null; readonly atMessageId: MessageId | null },
): { kept: ReadonlyArray<ProjectionTurn>; cutoffCreatedAt: string | undefined } {
  const ordered = [...turns].sort(
    (a, b) =>
      turnSortKey(a).localeCompare(turnSortKey(b)) ||
      String(a.turnId ?? "").localeCompare(String(b.turnId ?? "")),
  );

  const cutMessage =
    cut.atMessageId === null
      ? undefined
      : messages.find((message) => message.messageId === cut.atMessageId);
  const cutTurn =
    cut.atTurnId === null ? undefined : ordered.find((turn) => turn.turnId === cut.atTurnId);
  const cutTurnIndex = cutTurn === undefined ? undefined : ordered.indexOf(cutTurn);

  // Turnless rows are cut by time. The cut message's own createdAt is
  // authoritative; the cut turn's user message comes next; the turn's
  // requestedAt is the weakest fallback — turns materialized without a
  // pending message carry a requestedAt LATER than their user message,
  // which would otherwise leak the boundary message into the fork.
  const cutPendingMessage =
    cutTurn?.pendingMessageId != null
      ? messages.find((message) => message.messageId === cutTurn.pendingMessageId)
      : undefined;
  const cutoffCreatedAt =
    cutMessage?.createdAt ?? cutPendingMessage?.createdAt ?? cutTurn?.requestedAt;

  const kept = ordered.filter((turn, index) => {
    if (cutTurnIndex !== undefined && index >= cutTurnIndex) {
      return false;
    }
    if (cut.atMessageId !== null && turn.pendingMessageId === cut.atMessageId) {
      return false;
    }
    if (cutMessage !== undefined && turn.requestedAt >= cutMessage.createdAt) {
      return false;
    }
    return true;
  });

  return { kept, cutoffCreatedAt };
}

const CLONED_TURN_STATES: Record<ProjectionTurn["state"], ProjectionTurn["state"]> = {
  pending: "interrupted",
  running: "interrupted",
  interrupted: "interrupted",
  completed: "completed",
  error: "error",
};

export const applyThreadForkProjection = (deps: ThreadForkProjectionDeps) =>
  Effect.fn("applyThreadForkProjection")(function* (event: ThreadForkedEvent) {
    const forkThreadId = event.payload.threadId;
    const sourceThreadId = event.payload.sourceThreadId;

    const sourceTurns = yield* deps.turns.listByThreadId({ threadId: sourceThreadId });
    const sourceMessages = yield* deps.messages.listByThreadId({ threadId: sourceThreadId });
    const sourceActivities = yield* deps.activities.listByThreadId({ threadId: sourceThreadId });

    const atMessageId = event.payload.atMessageId ?? null;
    const { kept: keptTurns, cutoffCreatedAt } = selectKeptTurns(sourceTurns, sourceMessages, {
      atTurnId: event.payload.atTurnId,
      atMessageId,
    });
    const keptTurnIds = new Set<TurnId>();
    for (const turn of keptTurns) {
      if (turn.turnId !== null) keptTurnIds.add(turn.turnId);
    }

    // User messages carry no turnId in projections (the turn references them
    // via pendingMessageId), so turnless rows are cut by time; the boundary
    // message itself is always excluded, even when no cutoff resolves.
    const keepsUnturned = (createdAt: string): boolean =>
      cutoffCreatedAt === undefined || createdAt < cutoffCreatedAt;

    const remapMessageId = (id: MessageId | null): MessageId | null =>
      id === null ? null : forkedMessageId(forkThreadId, id);

    const keptMessages = sourceMessages.filter((message) => {
      if (atMessageId !== null && message.messageId === atMessageId) {
        return false;
      }
      return message.turnId === null
        ? keepsUnturned(message.createdAt)
        : keptTurnIds.has(message.turnId);
    });

    for (const message of keptMessages) {
      const cloned: ProjectionThreadMessage = {
        messageId: forkedMessageId(forkThreadId, message.messageId),
        threadId: forkThreadId,
        turnId: message.turnId,
        role: message.role,
        text: message.text,
        isStreaming: false,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      };
      yield* deps.messages.upsert(cloned);
    }

    for (const turn of keptTurns) {
      if (turn.turnId === null) continue;
      yield* deps.turns.upsertByTurnId({
        threadId: forkThreadId,
        turnId: turn.turnId,
        pendingMessageId: remapMessageId(turn.pendingMessageId),
        sourceProposedPlanThreadId: turn.sourceProposedPlanThreadId,
        sourceProposedPlanId: turn.sourceProposedPlanId,
        assistantMessageId: remapMessageId(turn.assistantMessageId),
        state: CLONED_TURN_STATES[turn.state],
        requestedAt: turn.requestedAt,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      });
    }

    const keptActivities = sourceActivities.filter((activity) =>
      activity.turnId === null
        ? keepsUnturned(activity.createdAt)
        : keptTurnIds.has(activity.turnId),
    );
    for (const activity of keptActivities) {
      const cloned: ProjectionThreadActivity = {
        ...activity,
        activityId: forkedActivityId(forkThreadId, activity.activityId),
        threadId: forkThreadId,
      };
      yield* deps.activities.upsert(cloned);
    }

    let latestTurnId: ProjectionThread["latestTurnId"] = null;
    for (const turn of keptTurns) {
      if (turn.turnId !== null) latestTurnId = turn.turnId;
    }

    const forkRow = yield* deps.threads.getById({ threadId: forkThreadId });
    if (Option.isSome(forkRow)) {
      yield* deps.threads.upsert({
        ...forkRow.value,
        latestTurnId,
        updatedAt: event.occurredAt,
      });
    }
    yield* deps.refreshThreadShellSummary(forkThreadId);
  });
