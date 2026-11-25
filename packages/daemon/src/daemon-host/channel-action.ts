import type { WriteReceiptDraft } from "@harness-anything/kernel";
import { runChannelWriteAction } from "@harness-anything/application/internal/commands/channel-action.ts";
import { readChannelListAction } from "@harness-anything/application/internal/queries/channel-read.ts";
import { resolveChannelOutboundAdapter } from "./channel-outbox.ts";
import type { RepoCellBinding, RepoCellOperationalContext, RepoTaskAction } from "./repo-cell-types.ts";

function runChannelAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  opId: string,
): WriteReceiptDraft {
  if (action.kind === "channel-list")
    return readChannelListAction(cell, action, binding.actor.principal.personId, opId);
  return runChannelWriteAction(cell, action, binding, opId, {
    resolveOutboundAdapter: (message) =>
      resolveChannelOutboundAdapter(cell.input.repoId, message, cell.input.channelOutboundBridge),
  });
}

export function dispatchChannelAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  sourceRevision: number,
): WriteReceiptDraft | Promise<WriteReceiptDraft> {
  return cell.entityActionExecutor.run(
    action,
    binding,
    cell.operationId(action, binding, cell.input.repoId, sourceRevision),
    {
      entity: {
        channel: (_contract, intent, actor, opId) => runChannelAction(cell, intent, actor, opId),
      },
    },
  );
}
