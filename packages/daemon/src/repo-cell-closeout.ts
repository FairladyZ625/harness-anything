import { submitTask } from "./repo-cell-submit.ts";
import { runTaskCloseoutAction } from "../../application/src/task-closeout-action.ts";
import { closeoutReadiness, type WriteReceiptDraft } from "../../kernel/src/index.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import { isPresetSnapshotCurrent } from "./repo-cell-task-progress.ts";
import { readPacketSource } from "./repo-cell-packets.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";

export function authorizeCloseoutLeaf(input: {
  readonly stage: string;
  readonly binding: RepoCellBinding;
  readonly actor: RepoCellBinding["actor"];
  readonly action: RepoTaskAction;
  readonly actionId: string;
  readonly revision: number;
  readonly now: string;
}) {
  const unqualifiedBinding = { ...input.binding, actor: input.actor, authorizationDecision: undefined };
  return input.stage === "complete" && input.binding.authorizationDecision?.outcome === "allowed"
    ? input.binding.authorizationDecision
    : authorizeRepoCellAction({
        action: input.action,
        binding: unqualifiedBinding,
        actionId: input.actionId,
        revision: input.revision,
        now: input.now,
      });
}

export async function closeoutTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceiptDraft> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    initial = await cell.service.read(taskId),
    opId = cell.operationId(action, binding, cell.input.repoId, initial.snapshot.revision);
  return runTaskCloseoutAction({
    action,
    caller: binding.actor,
    authorizationDecision:
      binding.authorizationDecision ??
      (() => {
        throw cell.cellCodedError(
          "authorization_missing",
          "Task closeout requires the center AuthorizationPort decision.",
        );
      })(),
    opId,
    readPacket: () => readPacketSource(cell.rootDir, action),
    read: async () =>
      (await cell.service.read(taskId)).snapshot as Parameters<typeof closeoutReadiness>[0] & {
        readonly revision: number;
        readonly task: NonNullable<Snapshot["task"]>;
        readonly lease: Snapshot["lease"];
      },
    presetSnapshotCurrent: () => {
      const projected = cell.projection.read(taskId);
      return isPresetSnapshotCurrent(
        cell,
        taskId,
        projected.snapshot,
        projected.packagePath,
        `ha task closeout ${taskId} ${
          typeof action.fromFile === "string" ? `--from-file ${action.fromFile}` : "--json-input '<json>'"
        }`,
      );
    },
    invoke: async (stage, leaf, actor) => {
      const leafAction = leaf as RepoTaskAction,
        revision = cell.store.readHead()?.revision ?? 0,
        unqualifiedBinding = { ...binding, actor, authorizationDecision: undefined },
        actionId = cell.operationId(leafAction, unqualifiedBinding, cell.input.repoId, revision),
        authorizationDecision = authorizeCloseoutLeaf({
          stage,
          binding,
          actor,
          action: leafAction,
          actionId,
          revision,
          now: cell.now(),
        }),
        leafBinding = { ...binding, actor, authorizationDecision };
      if (authorizationDecision.outcome === "denied")
        return {
          ...cell.rejected(actionId, "authorization_denied"),
          authorizationDecision,
        };
      if (stage === "task-show") return cell.showTask(taskId);
      if (stage === "preset-upgrade") return cell.upgradePresetSnapshot(leafAction, leafBinding);
      if (stage === "submit") return submitTask(cell, leafAction, leafBinding);
      if (stage === "complete") return cell.completeTask(leafAction, leafBinding);
      return cell.lifecycleAction(leafAction, leafBinding);
    },
  });
}
