/**
 * ThreadForkReactor — provider-side effects for `thread.forked`.
 *
 * The projection side (ThreadForkProjection) copies the visible history;
 * this reactor makes the provider conversation follow: it clones the source
 * thread's `provider_session_runtime` row for the fork and rewrites the
 * resume cursor so the next session start resumes the SOURCE provider
 * session as a fork (`forkSession: true`, consumed once by the adapter).
 *
 * Cursor shapes are provider-owned and opaque; only cursors that look
 * Claude-shaped (`resume: string`) are rewritten. When the fork cuts at an
 * earlier turn, the per-turn anchor recorded by ClaudeAdapter
 * (`turnAnchors`) picks the provider-side resume point; without an anchor
 * (threads recorded before anchors existed) the forked session resumes from
 * the source tip and only the visible history is truncated — logged as a
 * warning.
 */
import type { OrchestrationEvent, ThreadId, TurnId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadForkReactor, type ThreadForkReactorShape } from "../Services/ThreadForkReactor.ts";

type ThreadForkedEvent = Extract<OrchestrationEvent, { type: "thread.forked" }>;

interface ForkableCursorAnchor {
  readonly turnId: string;
  readonly uuid: string;
}

interface ForkableCursor {
  readonly resume: string;
  readonly turnAnchors: ReadonlyArray<ForkableCursorAnchor>;
  readonly resumeSessionAt: string | undefined;
}

/** Loose read of a Claude-shaped resume cursor; undefined for anything else. */
function readForkableCursor(cursor: unknown): ForkableCursor | undefined {
  if (!cursor || typeof cursor !== "object") return undefined;
  const record = cursor as Record<string, unknown>;
  if (typeof record.resume !== "string" || record.resume.length === 0) return undefined;
  const anchors: ForkableCursorAnchor[] = [];
  if (Array.isArray(record.turnAnchors)) {
    for (const entry of record.turnAnchors) {
      if (!entry || typeof entry !== "object") continue;
      const anchor = entry as Record<string, unknown>;
      if (typeof anchor.turnId === "string" && typeof anchor.uuid === "string") {
        anchors.push({ turnId: anchor.turnId, uuid: anchor.uuid });
      }
    }
  }
  return {
    resume: record.resume,
    turnAnchors: anchors,
    resumeSessionAt:
      typeof record.resumeSessionAt === "string" ? record.resumeSessionAt : undefined,
  };
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerSessionRuntimeRepository = yield* ProviderSessionRuntimeRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

  const processThreadForked = Effect.fn("processThreadForked")(function* (
    event: ThreadForkedEvent,
  ) {
    const forkThreadId = event.payload.threadId;
    const sourceThreadId = event.payload.sourceThreadId;

    const sourceRuntime = yield* providerSessionRuntimeRepository.getByThreadId({
      threadId: sourceThreadId,
    });
    if (Option.isNone(sourceRuntime)) {
      yield* Effect.logDebug("thread fork: source has no provider runtime; fork starts cold", {
        forkThreadId,
        sourceThreadId,
      });
      return;
    }

    const cursor = readForkableCursor(sourceRuntime.value.resumeCursor);
    if (!cursor) {
      yield* Effect.logDebug("thread fork: source cursor is not forkable; fork starts cold", {
        forkThreadId,
        sourceThreadId,
        provider: sourceRuntime.value.providerName,
      });
      return;
    }

    // The projection ran synchronously in the command transaction, so the
    // fork's cloned turns are already queryable: the last one is the cut.
    const forkTurns = yield* projectionTurnRepository.listByThreadId({ threadId: forkThreadId });
    const orderedTurnIds: TurnId[] = [];
    for (const turn of [...forkTurns].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))) {
      if (turn.turnId !== null) orderedTurnIds.push(turn.turnId);
    }
    const lastKeptTurnId = orderedTurnIds.at(-1);
    const keptAnchorIds = new Set<string>(orderedTurnIds);
    const keptAnchors = cursor.turnAnchors.filter((anchor) => keptAnchorIds.has(anchor.turnId));

    const isTipFork =
      event.payload.atTurnId === null && (event.payload.atMessageId ?? null) === null;

    // A cut fork that kept no turns must start cold: seeding the source
    // cursor would resume the FULL source conversation behind an
    // empty-looking thread.
    if (!isTipFork && orderedTurnIds.length === 0) {
      yield* Effect.logInfo("thread fork: cut before the first turn; fork starts cold", {
        forkThreadId,
        sourceThreadId,
      });
      return;
    }

    const anchorUuid = isTipFork
      ? undefined
      : keptAnchors.find((anchor) => anchor.turnId === lastKeptTurnId)?.uuid;
    if (!isTipFork && anchorUuid === undefined) {
      yield* Effect.logWarning(
        "thread fork: no provider anchor for the cut turn; forked session resumes from the source tip",
        { forkThreadId, sourceThreadId, lastKeptTurnId },
      );
    }

    const forkCursor = {
      threadId: forkThreadId,
      resume: cursor.resume,
      ...(anchorUuid !== undefined ? { resumeSessionAt: anchorUuid } : {}),
      turnCount: orderedTurnIds.length,
      ...(keptAnchors.length > 0 ? { turnAnchors: keptAnchors } : {}),
      forkSession: true,
    };

    yield* providerSessionRuntimeRepository.upsert({
      ...sourceRuntime.value,
      threadId: forkThreadId,
      status: "stopped",
      lastSeenAt: yield* nowIso,
      resumeCursor: forkCursor,
      runtimePayload: null,
    });
    yield* Effect.logInfo("thread fork: provider resume cursor seeded", {
      forkThreadId,
      sourceThreadId,
      resume: cursor.resume,
      resumeSessionAt: anchorUuid ?? null,
      turnCount: orderedTurnIds.length,
    });
  });

  const processThreadForkedSafely = (event: ThreadForkedEvent) =>
    processThreadForked(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread fork reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId as ThreadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadForkedSafely);

  const start: ThreadForkReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.forked") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadForkReactorShape;
});

export const ThreadForkReactorLive = Layer.effect(ThreadForkReactor, make);
