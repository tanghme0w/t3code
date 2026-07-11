import type { OrchestrationEvent } from "@t3tools/contracts";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-fork-projection-test-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

interface AppendInput {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly occurredAt: string;
  readonly type: string;
  readonly payload: unknown;
}

const appendThreadEvent = (eventStore: OrchestrationEventStoreShape, input: AppendInput) =>
  eventStore.append({
    type: input.type,
    eventId: EventId.make(`evt-${input.id}`),
    aggregateKind: "thread",
    aggregateId: input.threadId,
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`cmd-${input.id}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${input.id}`),
    metadata: {},
    payload: input.payload,
  } as Omit<OrchestrationEvent, "sequence">);

const threadCreatedPayload = (threadId: ThreadId, projectSlug: string, createdAt: string) => ({
  threadId,
  projectId: ProjectId.make(projectSlug),
  title: `Thread ${threadId}`,
  modelSelection: {
    instanceId: ProviderInstanceId.make("claude"),
    model: "claude-opus",
  },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  createdAt,
  updatedAt: createdAt,
});

const messageSentPayload = (input: {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId?: TurnId | null;
  readonly streaming?: boolean;
  readonly createdAt: string;
}) => ({
  threadId: input.threadId,
  messageId: MessageId.make(input.messageId),
  role: input.role,
  text: input.text,
  turnId: input.turnId ?? null,
  streaming: input.streaming ?? false,
  createdAt: input.createdAt,
  updatedAt: input.createdAt,
});

const sessionPayload = (input: {
  readonly threadId: ThreadId;
  readonly status: "running" | "ready";
  readonly activeTurnId: TurnId | null;
  readonly updatedAt: string;
}) => ({
  threadId: input.threadId,
  session: {
    threadId: input.threadId,
    status: input.status,
    providerName: "claude",
    runtimeMode: "full-access",
    activeTurnId: input.activeTurnId,
    lastError: null,
    updatedAt: input.updatedAt,
  },
});

const readForkRows = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const messages = yield* sql<{
      readonly messageId: string;
      readonly role: string;
      readonly text: string;
      readonly isStreaming: number;
    }>`
      SELECT message_id AS "messageId", role, text, is_streaming AS "isStreaming"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, message_id ASC
    `;
    const turns = yield* sql<{
      readonly turnId: string | null;
      readonly state: string;
      readonly pendingMessageId: string | null;
    }>`
      SELECT turn_id AS "turnId", state, pending_message_id AS "pendingMessageId"
      FROM projection_turns
      WHERE thread_id = ${threadId}
      ORDER BY requested_at ASC
    `;
    const threads = yield* sql<{ readonly latestTurnId: string | null }>`
      SELECT latest_turn_id AS "latestTurnId"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `;
    return {
      messages,
      turns,
      latestTurnId: threads[0]?.latestTurnId ?? null,
    };
  });

it.layer(TestLayer)("ThreadForkProjection", (it) => {
  it.effect(
    "excludes an unanswered boundary user message from the fork (atMessageId with no cut turn)",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sourceThreadId = ThreadId.make("fork-src-unanswered");
        const forkThreadId = ThreadId.make("fork-dst-unanswered");
        const turnId = TurnId.make("turn-unanswered-1");

        yield* appendThreadEvent(eventStore, {
          id: "ua-1",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T00:00:00.000Z",
          type: "thread.created",
          payload: threadCreatedPayload(
            sourceThreadId,
            "project-fork-ua",
            "2026-01-01T00:00:00.000Z",
          ),
        });
        yield* appendThreadEvent(eventStore, {
          id: "ua-2",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T00:00:10.000Z",
          type: "thread.message-sent",
          payload: messageSentPayload({
            threadId: sourceThreadId,
            messageId: "msg-ua-1",
            role: "user",
            text: "First question",
            createdAt: "2026-01-01T00:00:10.000Z",
          }),
        });
        yield* appendThreadEvent(eventStore, {
          id: "ua-3",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T00:00:10.000Z",
          type: "thread.turn-start-requested",
          payload: {
            threadId: sourceThreadId,
            messageId: MessageId.make("msg-ua-1"),
            createdAt: "2026-01-01T00:00:10.000Z",
          },
        });
        yield* appendThreadEvent(eventStore, {
          id: "ua-4",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T00:00:11.000Z",
          type: "thread.session-set",
          payload: sessionPayload({
            threadId: sourceThreadId,
            status: "running",
            activeTurnId: turnId,
            updatedAt: "2026-01-01T00:00:11.000Z",
          }),
        });
        yield* appendThreadEvent(eventStore, {
          id: "ua-5",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T00:00:12.000Z",
          type: "thread.message-sent",
          payload: messageSentPayload({
            threadId: sourceThreadId,
            messageId: "asst-ua-1",
            role: "assistant",
            text: "First answer",
            turnId,
            createdAt: "2026-01-01T00:00:12.000Z",
          }),
        });
        yield* appendThreadEvent(eventStore, {
          id: "ua-6",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T00:00:13.000Z",
          type: "thread.session-set",
          payload: sessionPayload({
            threadId: sourceThreadId,
            status: "ready",
            activeTurnId: null,
            updatedAt: "2026-01-01T00:00:13.000Z",
          }),
        });
        // The boundary user message: sent, turn requested, but never answered
        // (no session/turn row materializes for it).
        yield* appendThreadEvent(eventStore, {
          id: "ua-7",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T00:00:20.000Z",
          type: "thread.message-sent",
          payload: messageSentPayload({
            threadId: sourceThreadId,
            messageId: "msg-ua-2",
            role: "user",
            text: "Unanswered follow-up",
            createdAt: "2026-01-01T00:00:20.000Z",
          }),
        });
        yield* appendThreadEvent(eventStore, {
          id: "ua-8",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T00:00:20.000Z",
          type: "thread.turn-start-requested",
          payload: {
            threadId: sourceThreadId,
            messageId: MessageId.make("msg-ua-2"),
            createdAt: "2026-01-01T00:00:20.000Z",
          },
        });

        yield* appendThreadEvent(eventStore, {
          id: "ua-9",
          threadId: forkThreadId,
          occurredAt: "2026-01-01T00:00:30.000Z",
          type: "thread.created",
          payload: threadCreatedPayload(
            forkThreadId,
            "project-fork-ua",
            "2026-01-01T00:00:30.000Z",
          ),
        });
        yield* appendThreadEvent(eventStore, {
          id: "ua-10",
          threadId: forkThreadId,
          occurredAt: "2026-01-01T00:00:30.000Z",
          type: "thread.forked",
          payload: {
            threadId: forkThreadId,
            sourceThreadId,
            atTurnId: null,
            atMessageId: MessageId.make("msg-ua-2"),
            createdAt: "2026-01-01T00:00:30.000Z",
          },
        });

        yield* projectionPipeline.bootstrap;

        const fork = yield* readForkRows(forkThreadId);
        assert.deepEqual(
          fork.messages.map((message) => ({
            messageId: message.messageId,
            role: message.role,
            text: message.text,
          })),
          [
            {
              messageId: `${forkThreadId}::msg-ua-1`,
              role: "user",
              text: "First question",
            },
            {
              messageId: `${forkThreadId}::asst-ua-1`,
              role: "assistant",
              text: "First answer",
            },
          ],
        );
        assert.deepEqual(
          fork.turns.map((turn) => ({
            turnId: turn.turnId,
            state: turn.state,
            pendingMessageId: turn.pendingMessageId,
          })),
          [
            {
              turnId: String(turnId),
              state: "completed",
              pendingMessageId: `${forkThreadId}::msg-ua-1`,
            },
          ],
        );
        assert.equal(fork.latestTurnId, String(turnId));
      }),
  );

  it.effect("forks at the first message into an empty thread", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sourceThreadId = ThreadId.make("fork-src-first");
      const forkThreadId = ThreadId.make("fork-dst-first");
      const turnId = TurnId.make("turn-first-1");

      yield* appendThreadEvent(eventStore, {
        id: "fm-1",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T01:00:00.000Z",
        type: "thread.created",
        payload: threadCreatedPayload(
          sourceThreadId,
          "project-fork-fm",
          "2026-01-01T01:00:00.000Z",
        ),
      });
      yield* appendThreadEvent(eventStore, {
        id: "fm-2",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T01:00:10.000Z",
        type: "thread.message-sent",
        payload: messageSentPayload({
          threadId: sourceThreadId,
          messageId: "msg-fm-1",
          role: "user",
          text: "First question",
          createdAt: "2026-01-01T01:00:10.000Z",
        }),
      });
      yield* appendThreadEvent(eventStore, {
        id: "fm-3",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T01:00:10.000Z",
        type: "thread.turn-start-requested",
        payload: {
          threadId: sourceThreadId,
          messageId: MessageId.make("msg-fm-1"),
          createdAt: "2026-01-01T01:00:10.000Z",
        },
      });
      yield* appendThreadEvent(eventStore, {
        id: "fm-4",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T01:00:11.000Z",
        type: "thread.session-set",
        payload: sessionPayload({
          threadId: sourceThreadId,
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-01-01T01:00:11.000Z",
        }),
      });
      yield* appendThreadEvent(eventStore, {
        id: "fm-5",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T01:00:12.000Z",
        type: "thread.message-sent",
        payload: messageSentPayload({
          threadId: sourceThreadId,
          messageId: "asst-fm-1",
          role: "assistant",
          text: "First answer",
          turnId,
          createdAt: "2026-01-01T01:00:12.000Z",
        }),
      });

      yield* appendThreadEvent(eventStore, {
        id: "fm-6",
        threadId: forkThreadId,
        occurredAt: "2026-01-01T01:00:30.000Z",
        type: "thread.created",
        payload: threadCreatedPayload(forkThreadId, "project-fork-fm", "2026-01-01T01:00:30.000Z"),
      });
      yield* appendThreadEvent(eventStore, {
        id: "fm-7",
        threadId: forkThreadId,
        occurredAt: "2026-01-01T01:00:30.000Z",
        type: "thread.forked",
        payload: {
          threadId: forkThreadId,
          sourceThreadId,
          atTurnId: turnId,
          atMessageId: MessageId.make("msg-fm-1"),
          createdAt: "2026-01-01T01:00:30.000Z",
        },
      });

      yield* projectionPipeline.bootstrap;

      const fork = yield* readForkRows(forkThreadId);
      assert.deepEqual(fork.messages, []);
      assert.deepEqual(fork.turns, []);
      assert.equal(fork.latestTurnId, null);
    }),
  );

  it.effect(
    "cuts by the boundary message when the turn row carries no pending message and a late requestedAt",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sourceThreadId = ThreadId.make("fork-src-degenerate");
        const forkThreadId = ThreadId.make("fork-dst-degenerate");
        const turnId = TurnId.make("turn-degenerate-1");

        yield* appendThreadEvent(eventStore, {
          id: "dg-1",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T02:00:00.000Z",
          type: "thread.created",
          payload: threadCreatedPayload(
            sourceThreadId,
            "project-fork-dg",
            "2026-01-01T02:00:00.000Z",
          ),
        });
        yield* appendThreadEvent(eventStore, {
          id: "dg-2",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T02:00:10.000Z",
          type: "thread.message-sent",
          payload: messageSentPayload({
            threadId: sourceThreadId,
            messageId: "msg-dg-1",
            role: "user",
            text: "Question with a degenerate turn",
            createdAt: "2026-01-01T02:00:10.000Z",
          }),
        });
        // No turn-start-requested: the turn materializes from session-set
        // alone, so pendingMessageId is null and requestedAt (02:00:15) is
        // LATER than the user message createdAt (02:00:10).
        yield* appendThreadEvent(eventStore, {
          id: "dg-3",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T02:00:15.000Z",
          type: "thread.session-set",
          payload: sessionPayload({
            threadId: sourceThreadId,
            status: "running",
            activeTurnId: turnId,
            updatedAt: "2026-01-01T02:00:15.000Z",
          }),
        });
        yield* appendThreadEvent(eventStore, {
          id: "dg-4",
          threadId: sourceThreadId,
          occurredAt: "2026-01-01T02:00:16.000Z",
          type: "thread.message-sent",
          payload: messageSentPayload({
            threadId: sourceThreadId,
            messageId: "asst-dg-1",
            role: "assistant",
            text: "Answer",
            turnId,
            createdAt: "2026-01-01T02:00:16.000Z",
          }),
        });

        yield* appendThreadEvent(eventStore, {
          id: "dg-5",
          threadId: forkThreadId,
          occurredAt: "2026-01-01T02:00:30.000Z",
          type: "thread.created",
          payload: threadCreatedPayload(
            forkThreadId,
            "project-fork-dg",
            "2026-01-01T02:00:30.000Z",
          ),
        });
        yield* appendThreadEvent(eventStore, {
          id: "dg-6",
          threadId: forkThreadId,
          occurredAt: "2026-01-01T02:00:30.000Z",
          type: "thread.forked",
          payload: {
            threadId: forkThreadId,
            sourceThreadId,
            atTurnId: turnId,
            atMessageId: MessageId.make("msg-dg-1"),
            createdAt: "2026-01-01T02:00:30.000Z",
          },
        });

        yield* projectionPipeline.bootstrap;

        // Without atMessageId the cutoff falls back to the turn's late
        // requestedAt and the boundary user message leaks into the fork.
        const fork = yield* readForkRows(forkThreadId);
        assert.deepEqual(fork.messages, []);
        assert.deepEqual(fork.turns, []);
        assert.equal(fork.latestTurnId, null);
      }),
  );

  it.effect("tip fork keeps the whole history and settles in-flight state", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sourceThreadId = ThreadId.make("fork-src-tip");
      const forkThreadId = ThreadId.make("fork-dst-tip");
      const turnId = TurnId.make("turn-tip-1");

      yield* appendThreadEvent(eventStore, {
        id: "tip-1",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T03:00:00.000Z",
        type: "thread.created",
        payload: threadCreatedPayload(
          sourceThreadId,
          "project-fork-tip",
          "2026-01-01T03:00:00.000Z",
        ),
      });
      yield* appendThreadEvent(eventStore, {
        id: "tip-2",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T03:00:10.000Z",
        type: "thread.message-sent",
        payload: messageSentPayload({
          threadId: sourceThreadId,
          messageId: "msg-tip-1",
          role: "user",
          text: "Question",
          createdAt: "2026-01-01T03:00:10.000Z",
        }),
      });
      yield* appendThreadEvent(eventStore, {
        id: "tip-3",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T03:00:10.000Z",
        type: "thread.turn-start-requested",
        payload: {
          threadId: sourceThreadId,
          messageId: MessageId.make("msg-tip-1"),
          createdAt: "2026-01-01T03:00:10.000Z",
        },
      });
      yield* appendThreadEvent(eventStore, {
        id: "tip-4",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T03:00:11.000Z",
        type: "thread.session-set",
        payload: sessionPayload({
          threadId: sourceThreadId,
          status: "running",
          activeTurnId: turnId,
          updatedAt: "2026-01-01T03:00:11.000Z",
        }),
      });
      // Streaming assistant message of a still-running turn: the fork clone
      // must clear the streaming flag and interrupt the cloned turn.
      yield* appendThreadEvent(eventStore, {
        id: "tip-5",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T03:00:12.000Z",
        type: "thread.message-sent",
        payload: messageSentPayload({
          threadId: sourceThreadId,
          messageId: "asst-tip-1",
          role: "assistant",
          text: "Partial answ",
          turnId,
          streaming: true,
          createdAt: "2026-01-01T03:00:12.000Z",
        }),
      });

      yield* appendThreadEvent(eventStore, {
        id: "tip-6",
        threadId: forkThreadId,
        occurredAt: "2026-01-01T03:00:30.000Z",
        type: "thread.created",
        payload: threadCreatedPayload(forkThreadId, "project-fork-tip", "2026-01-01T03:00:30.000Z"),
      });
      yield* appendThreadEvent(eventStore, {
        id: "tip-7",
        threadId: forkThreadId,
        occurredAt: "2026-01-01T03:00:30.000Z",
        type: "thread.forked",
        payload: {
          threadId: forkThreadId,
          sourceThreadId,
          atTurnId: null,
          createdAt: "2026-01-01T03:00:30.000Z",
        },
      });

      yield* projectionPipeline.bootstrap;

      const fork = yield* readForkRows(forkThreadId);
      assert.deepEqual(
        fork.messages.map((message) => ({
          messageId: message.messageId,
          role: message.role,
          isStreaming: Number(message.isStreaming),
        })),
        [
          { messageId: `${forkThreadId}::msg-tip-1`, role: "user", isStreaming: 0 },
          { messageId: `${forkThreadId}::asst-tip-1`, role: "assistant", isStreaming: 0 },
        ],
      );
      assert.deepEqual(
        fork.turns.map((turn) => ({ turnId: turn.turnId, state: turn.state })),
        [{ turnId: String(turnId), state: "interrupted" }],
      );
      assert.equal(fork.latestTurnId, String(turnId));
    }),
  );

  it.effect("legacy thread.forked events without atMessageId still cut at the turn", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sourceThreadId = ThreadId.make("fork-src-legacy");
      const forkThreadId = ThreadId.make("fork-dst-legacy");
      const firstTurnId = TurnId.make("turn-legacy-1");
      const secondTurnId = TurnId.make("turn-legacy-2");

      yield* appendThreadEvent(eventStore, {
        id: "lg-1",
        threadId: sourceThreadId,
        occurredAt: "2026-01-01T04:00:00.000Z",
        type: "thread.created",
        payload: threadCreatedPayload(
          sourceThreadId,
          "project-fork-lg",
          "2026-01-01T04:00:00.000Z",
        ),
      });
      const exchanges = [
        {
          seq: "a",
          turnId: firstTurnId,
          messageId: "msg-lg-1",
          assistantId: "asst-lg-1",
          base: "2026-01-01T04:01:0",
        },
        {
          seq: "b",
          turnId: secondTurnId,
          messageId: "msg-lg-2",
          assistantId: "asst-lg-2",
          base: "2026-01-01T04:02:0",
        },
      ] as const;
      for (const exchange of exchanges) {
        yield* appendThreadEvent(eventStore, {
          id: `lg-${exchange.seq}-msg`,
          threadId: sourceThreadId,
          occurredAt: `${exchange.base}0.000Z`,
          type: "thread.message-sent",
          payload: messageSentPayload({
            threadId: sourceThreadId,
            messageId: exchange.messageId,
            role: "user",
            text: `Question ${exchange.seq}`,
            createdAt: `${exchange.base}0.000Z`,
          }),
        });
        yield* appendThreadEvent(eventStore, {
          id: `lg-${exchange.seq}-turn`,
          threadId: sourceThreadId,
          occurredAt: `${exchange.base}0.000Z`,
          type: "thread.turn-start-requested",
          payload: {
            threadId: sourceThreadId,
            messageId: MessageId.make(exchange.messageId),
            createdAt: `${exchange.base}0.000Z`,
          },
        });
        yield* appendThreadEvent(eventStore, {
          id: `lg-${exchange.seq}-session`,
          threadId: sourceThreadId,
          occurredAt: `${exchange.base}1.000Z`,
          type: "thread.session-set",
          payload: sessionPayload({
            threadId: sourceThreadId,
            status: "running",
            activeTurnId: exchange.turnId,
            updatedAt: `${exchange.base}1.000Z`,
          }),
        });
        yield* appendThreadEvent(eventStore, {
          id: `lg-${exchange.seq}-asst`,
          threadId: sourceThreadId,
          occurredAt: `${exchange.base}2.000Z`,
          type: "thread.message-sent",
          payload: messageSentPayload({
            threadId: sourceThreadId,
            messageId: exchange.assistantId,
            role: "assistant",
            text: `Answer ${exchange.seq}`,
            turnId: exchange.turnId,
            createdAt: `${exchange.base}2.000Z`,
          }),
        });
        yield* appendThreadEvent(eventStore, {
          id: `lg-${exchange.seq}-settle`,
          threadId: sourceThreadId,
          occurredAt: `${exchange.base}3.000Z`,
          type: "thread.session-set",
          payload: sessionPayload({
            threadId: sourceThreadId,
            status: "ready",
            activeTurnId: null,
            updatedAt: `${exchange.base}3.000Z`,
          }),
        });
      }

      yield* appendThreadEvent(eventStore, {
        id: "lg-fork-created",
        threadId: forkThreadId,
        occurredAt: "2026-01-01T04:03:00.000Z",
        type: "thread.created",
        payload: threadCreatedPayload(forkThreadId, "project-fork-lg", "2026-01-01T04:03:00.000Z"),
      });
      yield* appendThreadEvent(eventStore, {
        id: "lg-forked",
        threadId: forkThreadId,
        occurredAt: "2026-01-01T04:03:00.000Z",
        type: "thread.forked",
        payload: {
          threadId: forkThreadId,
          sourceThreadId,
          atTurnId: secondTurnId,
          createdAt: "2026-01-01T04:03:00.000Z",
        },
      });

      yield* projectionPipeline.bootstrap;

      const fork = yield* readForkRows(forkThreadId);
      assert.deepEqual(
        fork.messages.map((message) => ({ messageId: message.messageId, role: message.role })),
        [
          { messageId: `${forkThreadId}::msg-lg-1`, role: "user" },
          { messageId: `${forkThreadId}::asst-lg-1`, role: "assistant" },
        ],
      );
      assert.deepEqual(
        fork.turns.map((turn) => turn.turnId),
        [String(firstTurnId)],
      );
      assert.equal(fork.latestTurnId, String(firstTurnId));
    }),
  );
});
