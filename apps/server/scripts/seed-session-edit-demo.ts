/**
 * seed-session-edit-demo — preloads a demo home + git workspace with threads
 * covering the session-editing edge cases addressed on the session-edit-ops
 * branch (deferred edit, per-response retry, message-authoritative fork cuts,
 * session-less checkpoint revert).
 *
 * Usage (run BEFORE starting the dev server against the same home):
 *   node apps/server/scripts/seed-session-edit-demo.ts \
 *     --home /path/to/demo-home --workspace /path/to/demo-workspace
 *
 * Seeds `<home>/dev/state.sqlite` (the dev-mode state dir) with journal
 * events; the server projects them on bootstrap. The workspace is created as
 * a real git repo whose per-thread checkpoint refs point at commits for each
 * turn, so checkpoint reverts genuinely rewrite files. Threads deliberately
 * have NO provider session bindings: every revert exercises the
 * no-active-session workspace-cwd fallback.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment, OrchestrationEvent } from "@t3tools/contracts";
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../src/persistence/Services/OrchestrationEventStore.ts";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function readArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    console.error(
      "Usage: node apps/server/scripts/seed-session-edit-demo.ts --home <dir> --workspace <dir>",
    );
    process.exit(1);
  }
  return NodePath.resolve(value);
}

const homeDir = readArg("home");
const workspaceDir = readArg("workspace");
const stateDir = NodePath.join(homeDir, "dev");
const dbPath = NodePath.join(stateDir, "state.sqlite");
const seededMarkerPath = NodePath.join(stateDir, ".session-edit-demo-seeded");
const workspaceMarkerPath = NodePath.join(workspaceDir, ".session-edit-demo");

if (NodeFS.existsSync(seededMarkerPath)) {
  console.log(`Already seeded (${seededMarkerPath} exists) — nothing to do.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Ids and copy
// ---------------------------------------------------------------------------

const PROJECT_ID = ProjectId.make("demo-session-edit");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5",
};

const THREADS = {
  normal: ThreadId.make("demo-normal"),
  unanswered: ThreadId.make("demo-unanswered"),
  interrupted: ThreadId.make("demo-interrupted"),
  attachment: ThreadId.make("demo-attachment"),
  noCheckpoint: ThreadId.make("demo-no-checkpoint"),
} as const;

// ---------------------------------------------------------------------------
// Demo git workspace: commits per turn state + per-thread checkpoint refs
// ---------------------------------------------------------------------------

function runGit(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd: workspaceDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeWorkspaceFile(relativePath: string, content: string): void {
  NodeFS.writeFileSync(NodePath.join(workspaceDir, relativePath), content, "utf8");
}

function commitAll(message: string): string {
  runGit(["add", "-A"]);
  runGit(["commit", "-m", message]);
  return runGit(["rev-parse", "HEAD"]);
}

if (NodeFS.existsSync(workspaceDir)) {
  if (!NodeFS.existsSync(workspaceMarkerPath)) {
    console.error(
      `Refusing to reuse ${workspaceDir}: it exists but was not created by this seeder.`,
    );
    process.exit(1);
  }
  NodeFS.rmSync(workspaceDir, { recursive: true, force: true });
}
NodeFS.mkdirSync(workspaceDir, { recursive: true });

const README = `# 会话编辑 Demo 工作区

这个仓库由 seed-session-edit-demo 生成，配合五个预置线程演示
session-edit-ops 分支上的编辑/重试/分叉改动：

1. ① 正常多轮 — plan-a.md 有三轮修改，Edit / Retry / Fork 全部可用。
2. ② 未回复的最后一条 — 在悬空的 user 消息上 Fork，新线程不得包含它。
3. ③ 响应被中断 — 半成品文件留在工作区，Retry 会回卷并重发。
4. ④ 带附件消息 — 该回复的 Retry 置灰（附件无法忠实重传）。
5. ⑤ 无 checkpoint — Edit / Retry 按钮整体隐藏的保护路径。

所有线程都没有存活的 provider 会话：每一次回卷都在验证
“无活跃会话时按线程/项目 cwd 回退”的修复。
`;

writeWorkspaceFile(".session-edit-demo", "seeded workspace marker\n");
runGit(["init", "--initial-branch=main"]);
runGit(["config", "user.email", "demo@session-edit.local"]);
runGit(["config", "user.name", "Session Edit Demo"]);

writeWorkspaceFile("README.md", README);
writeWorkspaceFile("plan-a.md", "# 计划 A：狼堡主体工程\n\n（尚未开始）\n");
writeWorkspaceFile("plan-b.md", "# 计划 B：巡逻路线\n\n（尚未开始）\n");
writeWorkspaceFile("plan-c.md", "# 计划 C：猎物储备\n\n（尚未开始）\n");
writeWorkspaceFile("plan-d.md", "# 计划 D：配色方案\n\n（尚未开始）\n");
const commitInit = commitAll("初始状态");

writeWorkspaceFile("plan-a.md", "# 计划 A：狼堡主体工程\n\n## 第 1 期：侦察地形\n- 勘测北坡岩壁\n");
const commitA1 = commitAll("A: 第 1 期 侦察地形");

writeWorkspaceFile(
  "plan-a.md",
  "# 计划 A：狼堡主体工程\n\n## 第 1 期：侦察地形\n- 勘测北坡岩壁\n\n## 第 2 期：修建瞭望塔\n- 选址：东侧高地\n",
);
const commitA2 = commitAll("A: 第 2 期 修建瞭望塔");

writeWorkspaceFile(
  "plan-a.md",
  "# 计划 A：狼堡主体工程\n\n## 第 1 期：侦察地形\n- 勘测北坡岩壁\n\n## 第 2 期：修建瞭望塔\n- 选址：东侧高地\n\n## 第 3 期：训练幼狼巡逻队\n- 每日清晨集训\n",
);
const commitA3 = commitAll("A: 第 3 期 训练幼狼巡逻队");

writeWorkspaceFile("plan-b.md", "# 计划 B：巡逻路线\n\n## 东线\n- 河谷 → 桦树林\n");
const commitB1 = commitAll("B: 东线巡逻路线");

writeWorkspaceFile("plan-c.md", "# 计划 C：猎物储备\n\n## 干肉窖\n- 已备 3 成\n");
const commitC1 = commitAll("C: 建立储备清单");

writeWorkspaceFile("plan-d.md", "# 计划 D：配色方案\n\n## 主色\n- 月光银\n");
const commitD1 = commitAll("D: 依据草图定配色");

// Checkpoint refs: refs/t3/checkpoints/<base64url(threadId)>/turn/<n>.
const refTargets: ReadonlyArray<readonly [ThreadId, number, string]> = [
  [THREADS.normal, 0, commitInit],
  [THREADS.normal, 1, commitA1],
  [THREADS.normal, 2, commitA2],
  [THREADS.normal, 3, commitA3],
  [THREADS.unanswered, 0, commitInit],
  [THREADS.unanswered, 1, commitB1],
  [THREADS.interrupted, 0, commitInit],
  [THREADS.interrupted, 1, commitC1],
  [THREADS.attachment, 0, commitInit],
  [THREADS.attachment, 1, commitD1],
];
for (const [threadId, turnCount, sha] of refTargets) {
  runGit(["update-ref", checkpointRefForThreadTurn(threadId, turnCount), sha]);
}

// Thread ③'s interrupted turn left half-done edits behind: a modified
// plan-c.md plus an untracked scratch file. Retrying that response reverts
// both away.
writeWorkspaceFile(
  "plan-c.md",
  "# 计划 C：猎物储备\n\n## 干肉窖\n- 已备 3 成\n\n## （升级到一半被打断…\n- 这一行是中断残留的半成品\n",
);
writeWorkspaceFile("中断残留的草稿.tmp", "被打断时留下的临时文件——retry 后应当消失\n");

// ---------------------------------------------------------------------------
// Journal events
// ---------------------------------------------------------------------------

let clockMs = Date.parse("2026-07-12T01:00:00.000Z");
function stamp(): string {
  const iso = new Date(clockMs).toISOString();
  clockMs += 30_000;
  return iso;
}

let eventCounter = 0;
const events: Array<Omit<OrchestrationEvent, "sequence">> = [];

function appendEvent(input: {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}): void {
  eventCounter += 1;
  events.push({
    type: input.type,
    eventId: EventId.make(`demo-evt-${eventCounter}`),
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`demo-cmd-${eventCounter}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`demo-cmd-${eventCounter}`),
    metadata: {},
    payload: input.payload,
  } as Omit<OrchestrationEvent, "sequence">);
}

function createThread(threadId: ThreadId, title: string): void {
  const createdAt = stamp();
  appendEvent({
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: createdAt,
    payload: {
      threadId,
      projectId: PROJECT_ID,
      title,
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

function sendUserMessage(
  threadId: ThreadId,
  messageId: string,
  text: string,
  options: {
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly requestTurnStart?: boolean;
  } = {},
): void {
  const createdAt = stamp();
  appendEvent({
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.message-sent",
    occurredAt: createdAt,
    payload: {
      threadId,
      messageId: MessageId.make(messageId),
      role: "user",
      text,
      ...(options.attachments ? { attachments: options.attachments } : {}),
      turnId: null,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    },
  });
  if (options.requestTurnStart !== false) {
    appendEvent({
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.turn-start-requested",
      occurredAt: createdAt,
      payload: {
        threadId,
        messageId: MessageId.make(messageId),
        createdAt,
      },
    });
  }
}

function setSession(
  threadId: ThreadId,
  status: "running" | "ready" | "interrupted",
  activeTurnId: TurnId | null,
): void {
  const updatedAt = stamp();
  appendEvent({
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.session-set",
    occurredAt: updatedAt,
    payload: {
      threadId,
      session: {
        threadId,
        status,
        providerName: "claudeAgent",
        runtimeMode: "full-access",
        activeTurnId,
        lastError: null,
        updatedAt,
      },
    },
  });
}

function sendAssistantMessage(
  threadId: ThreadId,
  messageId: string,
  turnId: TurnId,
  text: string,
): void {
  const createdAt = stamp();
  appendEvent({
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.message-sent",
    occurredAt: createdAt,
    payload: {
      threadId,
      messageId: MessageId.make(messageId),
      role: "assistant",
      text,
      turnId,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

function completeTurnDiff(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly checkpointTurnCount: number;
  readonly assistantMessageId: string;
  readonly filePath: string;
  readonly additions: number;
  readonly deletions: number;
}): void {
  const completedAt = stamp();
  appendEvent({
    aggregateKind: "thread",
    aggregateId: input.threadId,
    type: "thread.turn-diff-completed",
    occurredAt: completedAt,
    payload: {
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.checkpointTurnCount,
      checkpointRef: checkpointRefForThreadTurn(input.threadId, input.checkpointTurnCount),
      status: "ready",
      files: [
        {
          path: input.filePath,
          kind: "modified",
          additions: input.additions,
          deletions: input.deletions,
        },
      ],
      assistantMessageId: MessageId.make(input.assistantMessageId),
      completedAt,
    },
  });
}

function completedExchange(input: {
  readonly threadId: ThreadId;
  readonly slug: string;
  readonly turnNumber: number;
  readonly userText: string;
  readonly assistantText: string;
  readonly filePath: string;
  readonly additions: number;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}): void {
  const turnId = TurnId.make(`${input.slug}-turn-${input.turnNumber}`);
  sendUserMessage(input.threadId, `${input.slug}-user-${input.turnNumber}`, input.userText, {
    ...(input.attachments ? { attachments: input.attachments } : {}),
  });
  setSession(input.threadId, "running", turnId);
  sendAssistantMessage(
    input.threadId,
    `${input.slug}-asst-${input.turnNumber}`,
    turnId,
    input.assistantText,
  );
  setSession(input.threadId, "ready", null);
  completeTurnDiff({
    threadId: input.threadId,
    turnId,
    checkpointTurnCount: input.turnNumber,
    assistantMessageId: `${input.slug}-asst-${input.turnNumber}`,
    filePath: input.filePath,
    additions: input.additions,
    deletions: 0,
  });
}

// Project.
{
  const createdAt = stamp();
  appendEvent({
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    type: "project.created",
    occurredAt: createdAt,
    payload: {
      projectId: PROJECT_ID,
      title: "会话编辑 Demo",
      workspaceRoot: workspaceDir,
      defaultModelSelection: MODEL_SELECTION,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  });
}

// ⑤ No checkpoint coverage: edit/retry affordances must stay hidden.
createThread(THREADS.noCheckpoint, "⑤ 无 checkpoint · 按钮隐藏保护");
{
  const turnId = TurnId.make("demo-e-turn-1");
  sendUserMessage(
    THREADS.noCheckpoint,
    "demo-e-user-1",
    "这个线程没有任何 checkpoint（对应非 git 工作区之类的场景），确认一下编辑和重试按钮都不出现？",
  );
  setSession(THREADS.noCheckpoint, "running", turnId);
  sendAssistantMessage(
    THREADS.noCheckpoint,
    "demo-e-asst-1",
    turnId,
    "收到——本线程刻意不带任何 checkpoint，所以悬停消息时只有 Fork 和复制按钮：没有可回卷的目标时，Edit / Retry 会整体隐藏，避免把注定失败的操作摆出来。",
  );
  setSession(THREADS.noCheckpoint, "ready", null);
}

// ④ Attachment message: retry must be disabled for that response.
createThread(THREADS.attachment, "④ 带附件消息 · Retry 置灰");
completedExchange({
  threadId: THREADS.attachment,
  slug: "demo-d",
  turnNumber: 1,
  userText: "参考这张设计草图，更新 plan-d.md 的配色段落。",
  assistantText:
    "已按草图更新 plan-d.md：主色定为「月光银」。（这条回复的 Retry 按钮是置灰的——原始消息带附件，无法忠实重传。）",
  filePath: "plan-d.md",
  additions: 3,
  attachments: [
    {
      type: "image",
      id: "demo-d-attachment-1",
      name: "设计草图.png",
      mimeType: "image/png",
      sizeBytes: 48_213,
    },
  ],
});

// ③ Interrupted response: retry re-runs from the broken message.
createThread(THREADS.interrupted, "③ 响应被中断 · Retry 续跑");
completedExchange({
  threadId: THREADS.interrupted,
  slug: "demo-c",
  turnNumber: 1,
  userText: "在 plan-c.md 里建立猎物储备清单。",
  assistantText: "已写入 plan-c.md：干肉窖已备 3 成。",
  filePath: "plan-c.md",
  additions: 3,
});
{
  const turnId = TurnId.make("demo-c-turn-2");
  sendUserMessage(
    THREADS.interrupted,
    "demo-c-user-2",
    "把储备清单升级到 v2，加入冬季配额。（这一轮在中途被打断了）",
  );
  setSession(THREADS.interrupted, "running", turnId);
  sendAssistantMessage(
    THREADS.interrupted,
    "demo-c-asst-2",
    turnId,
    "正在升级储备清单——刚写到一半…（此回合随后被中断；工作区里留有半成品：plan-c.md 的残段和一个 .tmp 草稿。悬停本条点 Retry：会回卷掉半成品并重发同样的问题。）",
  );
  // The explicit interrupt marks the turn interrupted even under bootstrap
  // replay, where the turns projector can observe the session's FINAL
  // (already-interrupted) status while processing the assistant message and
  // mis-settle the turn as completed.
  {
    const interruptedAt = stamp();
    appendEvent({
      aggregateKind: "thread",
      aggregateId: THREADS.interrupted,
      type: "thread.turn-interrupt-requested",
      occurredAt: interruptedAt,
      payload: {
        threadId: THREADS.interrupted,
        turnId,
        createdAt: interruptedAt,
      },
    });
  }
  setSession(THREADS.interrupted, "interrupted", null);
}

// ② Unanswered trailing user message: fork must not leak it into the fork.
createThread(THREADS.unanswered, "② 未回复的最后一条 · Fork 边界");
completedExchange({
  threadId: THREADS.unanswered,
  slug: "demo-b",
  turnNumber: 1,
  userText: "规划一条巡逻路线写进 plan-b.md。",
  assistantText: "已写入 plan-b.md：东线，河谷 → 桦树林。",
  filePath: "plan-b.md",
  additions: 3,
});
sendUserMessage(
  THREADS.unanswered,
  "demo-b-user-2",
  "这条消息没有得到任何回复——在它上面点 Fork：分叉出的新线程不应包含这条消息（修复前它会残留）。也可以点 Edit 直接改写后发送。",
);

// ① The everyday thread: three complete exchanges.
createThread(THREADS.normal, "① 正常多轮 · Edit / Retry / Fork");
completedExchange({
  threadId: THREADS.normal,
  slug: "demo-a",
  turnNumber: 1,
  userText: "创建 plan-a.md，写入第 1 期工程：侦察地形。",
  assistantText: "已创建 plan-a.md 并写入第 1 期：侦察地形（勘测北坡岩壁）。",
  filePath: "plan-a.md",
  additions: 3,
});
completedExchange({
  threadId: THREADS.normal,
  slug: "demo-a",
  turnNumber: 2,
  userText: "追加第 2 期工程：修建瞭望塔。",
  assistantText:
    "plan-a.md 已更新：第 2 期 修建瞭望塔（选址东侧高地）。试试悬停上面那条用户消息点「编辑」——不会弹确认框，后续消息只是变暗，发送时才真正回卷。",
  filePath: "plan-a.md",
  additions: 3,
});
completedExchange({
  threadId: THREADS.normal,
  slug: "demo-a",
  turnNumber: 3,
  userText: "追加第 3 期工程：训练幼狼巡逻队。",
  assistantText:
    "plan-a.md 已更新：第 3 期 训练幼狼巡逻队（每日清晨集训）。悬停本条可以看到 Retry 按钮；编辑第 2 条用户消息再发送，plan-a.md 会回到第 1 期的状态。",
  filePath: "plan-a.md",
  additions: 3,
});

// ---------------------------------------------------------------------------
// Write events through the server's own event store (runs migrations too)
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const eventStore = yield* OrchestrationEventStore;
  for (const event of events) {
    yield* eventStore.append(event);
  }
});

const MainLayer = OrchestrationEventStoreLive.pipe(
  Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
  Layer.provideMerge(NodeServices.layer),
);

await Effect.runPromise(program.pipe(Effect.provide(MainLayer), Effect.scoped));

NodeFS.mkdirSync(NodePath.dirname(seededMarkerPath), { recursive: true });
NodeFS.writeFileSync(seededMarkerPath, `${new Date().toISOString()}\n`, "utf8");

console.log(`Seeded ${events.length} events into ${dbPath}`);
console.log(`Demo workspace ready at ${workspaceDir}`);
console.log(`Threads: ${Object.values(THREADS).join(", ")}`);
