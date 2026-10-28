---
name: codex-unattended-turn
description: Codex ends its turn on the first assistant message with no tool call, and an unattended dispatch never sends another user message. Use when a Codex Agent must carry progress and checkpoints through to a settlement action instead of ending on a chat summary.
---

# Codex unattended turn

Applies when this Agent runs on a `codex` runtime in an unattended dispatch. The model-neutral rule —
progress goes to files, not messages — is already in the dispatch prompt; this skill is the turn
mechanism behind it.

## Mechanism

`codex exec` runs one turn. The turn ends when the model emits an assistant message with no tool
call. An unattended dispatch has no next user message, so that ending is where the session stops:
with no settlement action in the stream, the runtime settles it as `worker_stop`
(`packages/daemon/src/runtime-provider-fault.ts`).

## Procedure

1. Write the progress or checkpoint conclusion into the task report or `ha task progress append`,
   then make the next tool call. Never end a turn on a status message.
2. Keep working until one settlement action has actually run: `ha task submit <task-id>` for a
   delivery, `ha task review-execution <task-id>` for a review, or the ruling artifact
   `artifacts/rulings/<dispatch-id>.md` for a stop.
3. Run that action before the closing message. The closing message is evidence for the owner, not
   the delivery.
