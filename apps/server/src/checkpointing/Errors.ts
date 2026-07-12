import { NonNegativeInt, ThreadId, type VcsError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export const CheckpointDiffOperation = Schema.Literals([
  "CheckpointDiffQuery.getTurnDiff",
  "CheckpointDiffQuery.getFullThreadDiff",
  "CheckpointDiffQuery.previewRevertDiff",
]);
export type CheckpointDiffOperation = typeof CheckpointDiffOperation.Type;

const CHECKPOINT_DIFF_RESULT_LABEL: Record<CheckpointDiffOperation, string> = {
  "CheckpointDiffQuery.getTurnDiff": "turn diff",
  "CheckpointDiffQuery.getFullThreadDiff": "full thread diff",
  "CheckpointDiffQuery.previewRevertDiff": "revert preview diff",
};

/** The computed result does not satisfy the checkpoint RPC contract. */
export class CheckpointDiffResultInvalidError extends Schema.TaggedErrorClass<CheckpointDiffResultInvalidError>()(
  "CheckpointDiffResultInvalidError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const result = CHECKPOINT_DIFF_RESULT_LABEL[this.operation];
    return `Checkpoint invariant violation in ${this.operation}: Computed ${result} result does not satisfy contract schema.`;
  }
}

/** Projection state no longer contains the requested checkpoint thread. */
export class CheckpointThreadNotFoundError extends Schema.TaggedErrorClass<CheckpointThreadNotFoundError>()(
  "CheckpointThreadNotFoundError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: Thread '${this.threadId}' not found.`;
  }
}

/** The checkpoint thread has no workspace path from which to compute a diff. */
export class CheckpointWorkspacePathMissingError extends Schema.TaggedErrorClass<CheckpointWorkspacePathMissingError>()(
  "CheckpointWorkspacePathMissingError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const diff = CHECKPOINT_DIFF_RESULT_LABEL[this.operation];
    return `Checkpoint invariant violation in ${this.operation}: Workspace path missing for thread '${this.threadId}' when computing ${diff}.`;
  }
}

/** The requested turn lies beyond the latest available checkpoint. */
export class CheckpointTurnRangeUnavailableError extends Schema.TaggedErrorClass<CheckpointTurnRangeUnavailableError>()(
  "CheckpointTurnRangeUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    requestedTurnCount: NonNegativeInt,
    availableTurnCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.requestedTurnCount}: Turn diff range exceeds current turn count: requested ${this.requestedTurnCount}, current ${this.availableTurnCount}.`;
  }
}

/** Expected checkpoint metadata does not contain the requested Git ref. */
export class CheckpointRefUnavailableError extends Schema.TaggedErrorClass<CheckpointRefUnavailableError>()(
  "CheckpointRefUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    turnCount: NonNegativeInt,
    checkpoint: Schema.Literals(["from", "to"]),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: Checkpoint ref is unavailable for turn ${this.turnCount}.`;
  }
}

export type CheckpointStoreError = VcsError;

export type CheckpointServiceError =
  | CheckpointStoreError
  | ProjectionRepositoryError
  | CheckpointDiffResultInvalidError
  | CheckpointThreadNotFoundError
  | CheckpointWorkspacePathMissingError
  | CheckpointTurnRangeUnavailableError
  | CheckpointRefUnavailableError;
