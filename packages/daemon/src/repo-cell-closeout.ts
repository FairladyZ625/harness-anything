import { runTaskCloseoutAction } from "../../application/src/task-closeout-action.ts";
import { closeoutReadiness, type WriteReceiptDraft } from "../../kernel/src/index.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";

export async function closeoutTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceiptDraft> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    initial = await cell.service.read(taskId),
    opId = cell.operationId(action, binding, cell.input.repoId, initial.snapshot.revision);
  return runTaskCloseoutAction({
    rootDir: cell.rootDir,
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
    readWorkspaceText: cell.workspaceText,
    read: async () =>
      (await cell.service.read(taskId)).snapshot as Parameters<typeof closeoutReadiness>[0] & {
        readonly revision: number;
        readonly task: NonNullable<Snapshot["task"]>;
        readonly lease: Snapshot["lease"];
      },
    invoke: async (stage, leaf, actor) => {
      const leafAction = leaf as RepoTaskAction,
        revision = cell.store.readHead()?.revision ?? 0,
        unqualifiedBinding = { ...binding, actor, authorizationDecision: undefined },
        actionId = cell.operationId(leafAction, unqualifiedBinding, cell.input.repoId, revision),
        authorizationDecision = authorizeRepoCellAction({
          action: leafAction,
          binding: unqualifiedBinding,
          actionId,
          revision,
          now: cell.now(),
        }),
        leafBinding = { ...binding, actor, authorizationDecision };
      if (authorizationDecision.outcome === "denied")
        return {
          ...cell.rejected(
            actionId,
            "authorization_denied",
            authorizationDecision.nextActions.join(" ") || `Retry ${leafAction.kind} with an authorized RoleBinding.`,
          ),
          authorizationDecision,
        };
      if (stage === "task-show") return cell.showTask(taskId);
      if (stage === "complete") return cell.completeTask(leafAction, leafBinding);
      return cell.lifecycleAction(leafAction, leafBinding);
    },
  });
}
