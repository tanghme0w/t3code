# Thread history: revert, edit & resend, fork

Hover any of your own messages in a thread to get the history actions in
its toolbar (this branch adds the last two):

| Action                 | Icon       | What it does                                                                                                                                                             |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Revert to this message | undo arrow | Restores files to the checkpoint before this message and discards the newer turns in this thread.                                                                        |
| Edit & resend          | pencil     | Prefills the composer with the message text, then reverts to just before it — tweak and send to replay history from that point.                                          |
| Fork thread from here  | fork       | Creates a **new** thread carrying the conversation _before_ this message; the composer in the fork is prefilled with the message text. The original thread is untouched. |

## What a fork carries

- The visible history (messages, turns, activity log) up to — but not
  including — the message you forked at. Forking at the first message
  gives an empty thread with just the prefilled composer.
- **The agent's memory.** For Claude threads, the provider session is
  forked at the same point (Claude Code's native session fork), so the
  agent in the new thread remembers everything before the cut. Threads
  from other providers, or Claude threads recorded before this feature,
  fork with the visible history only — the session then resumes from the
  source tip or starts cold (a server log warning notes which).
- The source thread's project, branch, worktree, and model selection.

Not carried, by design: file-revert checkpoints (they are namespaced per
thread; the fork starts accumulating its own) and message attachments.

## Notes

- "Edit & resend" is destructive to the _current_ thread (it reuses the
  checkpoint revert, confirm dialog included). "Fork" is the
  non-destructive alternative when you want to keep both timelines.
- Revert/edit availability depends on the message having a checkpoint
  (worktree/git threads); fork is always offered.
- Forked threads are named "<source title> (fork)" — rename from the
  sidebar as usual.
