import {
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage, Thread, TurnDiffSummary } from "../types";
import type { TimelineEntry } from "../session-logic";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  buildThreadTurnInterruptInput,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  deriveRewindTargets,
  getStartedThreadModelChangeBlockReason,
  hasServerAcknowledgedLocalDispatch,
  reconcileMountedTerminalThreadIds,
  reconcileRetainedMountedThreadIds,
  resolveSendEnvMode,
  shouldWriteThreadErrorToCurrentServerThread,
} from "./ChatView.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("getStartedThreadModelChangeBlockReason", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
    },
    {
      instanceId: ProviderInstanceId.make("grok"),
      requiresNewThreadForModelChange: true,
    },
  ];

  it("allows model changes before a provider session has started", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: false,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-other",
        },
      }),
    ).toBeNull();
  });

  it("allows unchanged model selections for restricted providers", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toBeNull();
  });

  it("blocks started-session model changes when either provider requires a new thread", () => {
    expect(
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession: true,
        currentModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        nextModelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
      }),
    ).toEqual({
      title: "Start a new chat to change models",
      description:
        "This provider does not allow switching models after a conversation has started.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(ids.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("requires the environment, route thread, and target thread to match", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});

describe("deriveRewindTargets", () => {
  function userMessage(
    id: string,
    createdAt: string,
    extra: Partial<ChatMessage> = {},
  ): ChatMessage {
    return {
      id: MessageId.make(id),
      role: "user",
      text: `text of ${id}`,
      turnId: null,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
      ...extra,
    };
  }

  function assistantMessage(id: string, turnId: string, createdAt: string): ChatMessage {
    return {
      id: MessageId.make(id),
      role: "assistant",
      text: `answer ${id}`,
      turnId: TurnId.make(turnId),
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    };
  }

  function messageEntry(message: ChatMessage): TimelineEntry {
    return { id: `entry-${message.id}`, kind: "message", createdAt: message.createdAt, message };
  }

  function summary(
    turnId: string,
    checkpointTurnCount: number,
    assistantId: string,
  ): TurnDiffSummary {
    return {
      turnId: TurnId.make(turnId),
      checkpointTurnCount,
      checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${turnId}`),
      status: "ready",
      files: [],
      assistantMessageId: MessageId.make(assistantId),
      completedAt: `2026-03-29T00:0${checkpointTurnCount}:00.000Z`,
    };
  }

  const user1 = userMessage("msg-user-1", "2026-03-29T00:00:00.000Z");
  const asst1 = assistantMessage("msg-asst-1", "turn-1", "2026-03-29T00:00:30.000Z");
  const user2 = userMessage("msg-user-2", "2026-03-29T00:02:00.000Z");
  const asst2 = assistantMessage("msg-asst-2", "turn-2", "2026-03-29T00:02:30.000Z");

  it("targets the checkpoint state just before each user message", () => {
    const targets = deriveRewindTargets({
      timelineEntries: [user1, asst1, user2, asst2].map(messageEntry),
      turnDiffSummaryByAssistantMessageId: new Map([
        [asst1.id, summary("turn-1", 1, "msg-asst-1")],
        [asst2.id, summary("turn-2", 2, "msg-asst-2")],
      ]),
      inferredCheckpointTurnCountByTurnId: {},
      checkpointCount: 2,
    });

    expect(targets.revertTurnCountByUserMessageId.get(user1.id)).toBe(0);
    expect(targets.revertTurnCountByUserMessageId.get(user2.id)).toBe(1);
    expect(targets.retryContextByAssistantMessageId.get(asst1.id)).toEqual({
      userMessageId: user1.id,
      text: user1.text,
      hasAttachments: false,
      targetTurnCount: 0,
    });
    expect(targets.retryContextByAssistantMessageId.get(asst2.id)).toEqual({
      userMessageId: user2.id,
      text: user2.text,
      hasAttachments: false,
      targetTurnCount: 1,
    });
  });

  it("keeps targets available when the latest turn broke before its checkpoint", () => {
    // asst2's turn was interrupted: no diff summary ever landed for it.
    const targets = deriveRewindTargets({
      timelineEntries: [user1, asst1, user2, asst2].map(messageEntry),
      turnDiffSummaryByAssistantMessageId: new Map([
        [asst1.id, summary("turn-1", 1, "msg-asst-1")],
      ]),
      inferredCheckpointTurnCountByTurnId: {},
      checkpointCount: 1,
    });

    expect(targets.revertTurnCountByUserMessageId.get(user2.id)).toBe(1);
    expect(targets.retryContextByAssistantMessageId.get(asst2.id)).toEqual({
      userMessageId: user2.id,
      text: user2.text,
      hasAttachments: false,
      targetTurnCount: 1,
    });
  });

  it("marks retries for user messages that carried attachments", () => {
    const userWithImage = userMessage("msg-user-img", "2026-03-29T00:04:00.000Z", {
      attachments: [
        {
          type: "image",
          id: "att-1",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 10,
        },
      ],
    });
    const asst3 = assistantMessage("msg-asst-3", "turn-3", "2026-03-29T00:04:30.000Z");

    const targets = deriveRewindTargets({
      timelineEntries: [user1, asst1, userWithImage, asst3].map(messageEntry),
      turnDiffSummaryByAssistantMessageId: new Map([
        [asst1.id, summary("turn-1", 1, "msg-asst-1")],
      ]),
      inferredCheckpointTurnCountByTurnId: {},
      checkpointCount: 1,
    });

    expect(targets.retryContextByAssistantMessageId.get(asst3.id)?.hasAttachments).toBe(true);
  });

  it("attaches every commentary message of a turn to the same retry context", () => {
    const commentary = assistantMessage(
      "msg-asst-commentary",
      "turn-1",
      "2026-03-29T00:00:20.000Z",
    );

    const targets = deriveRewindTargets({
      timelineEntries: [user1, commentary, asst1].map(messageEntry),
      turnDiffSummaryByAssistantMessageId: new Map([
        [asst1.id, summary("turn-1", 1, "msg-asst-1")],
      ]),
      inferredCheckpointTurnCountByTurnId: {},
      checkpointCount: 1,
    });

    expect(targets.retryContextByAssistantMessageId.get(commentary.id)?.userMessageId).toBe(
      user1.id,
    );
    expect(targets.retryContextByAssistantMessageId.get(asst1.id)?.userMessageId).toBe(user1.id);
  });

  it("exposes no targets for threads without checkpoint coverage", () => {
    const targets = deriveRewindTargets({
      timelineEntries: [user1, asst1].map(messageEntry),
      turnDiffSummaryByAssistantMessageId: new Map(),
      inferredCheckpointTurnCountByTurnId: {},
      checkpointCount: 0,
    });

    expect(targets.revertTurnCountByUserMessageId.size).toBe(0);
    expect(targets.retryContextByAssistantMessageId.size).toBe(0);
  });
});
