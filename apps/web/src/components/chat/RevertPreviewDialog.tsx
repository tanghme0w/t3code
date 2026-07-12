import type { CheckpointRevertMode } from "@t3tools/contracts";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";

import { summarizeUnifiedDiff } from "../ChatView.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const MAX_INLINE_PATCH_CHARS = 200_000;

export interface RevertPreviewDialogProps {
  readonly variant: "rewind" | "edit-send";
  readonly discardedMessageCount: number;
  readonly previewPending: boolean;
  readonly previewError: string | null;
  readonly previewDiff: string | null;
  readonly confirmBusy: boolean;
  readonly onConfirm: (mode: CheckpointRevertMode) => void;
  readonly onCancel: () => void;
}

// [thread-rewind] Confirmation surface for destructive rewinds: states what
// will be discarded, previews the exact workspace diff a code rollback would
// undo, and lets the user keep or rewind the code independently of the
// conversation. Used by the standalone rewind button and by sending an edit.
export function RevertPreviewDialog({
  variant,
  discardedMessageCount,
  previewPending,
  previewError,
  previewDiff,
  confirmBusy,
  onConfirm,
  onCancel,
}: RevertPreviewDialogProps) {
  const summary = previewDiff === null ? null : summarizeUnifiedDiff(previewDiff);
  const messageNoun = discardedMessageCount === 1 ? "message" : "messages";
  const title = variant === "rewind" ? "Rewind thread to here" : "Send edited message";
  const description =
    variant === "rewind"
      ? `This discards the ${discardedMessageCount} ${messageNoun} from this point on and rolls the agent's memory back with them.`
      : `Sending discards the ${discardedMessageCount} ${messageNoun} from the edited message on and rolls the agent's memory back with them.`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description} Workspace files can be rolled back to the checkpoint or kept as they are.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2">
          {previewPending ? (
            <p className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
              Computing workspace diff…
            </p>
          ) : previewError !== null ? (
            <p className="flex items-start gap-2 text-destructive text-sm">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Diff preview unavailable: {previewError}
            </p>
          ) : summary === null || summary.files.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No workspace file changes since this checkpoint — only the conversation is affected.
            </p>
          ) : (
            <>
              <p className="text-sm">
                Rolling back code undoes changes in {summary.files.length}{" "}
                {summary.files.length === 1 ? "file" : "files"}{" "}
                <span className="text-muted-foreground tabular-nums">
                  (+{summary.additions} −{summary.deletions})
                </span>
              </p>
              <ul className="flex max-h-32 flex-col gap-0.5 overflow-auto font-mono text-xs">
                {summary.files.map((file) => (
                  <li key={file.path} className="flex items-center justify-between gap-3">
                    <span className="truncate">{file.path}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      +{file.additions} −{file.deletions}
                    </span>
                  </li>
                ))}
              </ul>
              {previewDiff !== null && previewDiff.length <= MAX_INLINE_PATCH_CHARS ? (
                <pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed">
                  {previewDiff}
                </pre>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Diff too large to display inline ({Math.round((previewDiff?.length ?? 0) / 1024)}{" "}
                  KB).
                </p>
              )}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={confirmBusy}
            onClick={() => onConfirm("conversation-only")}
          >
            {variant === "rewind" ? "Keep code changes" : "Keep code + send"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={confirmBusy}
            onClick={() => onConfirm("workspace-and-conversation")}
          >
            {variant === "rewind" ? "Rewind code + conversation" : "Rewind code + send"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
