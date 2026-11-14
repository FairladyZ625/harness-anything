import type { WriteReceipt } from "@harness-anything/kernel";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { withEdgeReadModel } from "./fleet-edge-task-read.ts";
import { locateFleetMirrorView, materializeFleetMirrorView } from "./fleet-edge-mirror.ts";
import { authorizeRepoActionBinding, withAuthorizationDecision } from "./repo-cell-authorization.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";
import {
  requireDocCommandFrame,
  requireOwnTaskDocSelection,
  withWorkspaceDocumentPaths,
} from "./doc-sync-command-actions.ts";
import { runDocMaterialize } from "./doc-sync-materialize-action.ts";
import { settleHostLocalReceipt } from "./write-receipt-settlement.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

function edgeReplica(rootDir: string, repoId: string, binding: RepoCellBinding) {
  const config = readFleetEdgeConfig(rootDir);
  if (!config) return null;
  if (config.repoId !== repoId)
    throw cellCodedError("fleet_edge_config_missing", "The edge repository configuration is unavailable.");
  return { ...config, principalId: binding.actor.principal.personId, includeEntries: false };
}

/** A local preference settles the actual replica mirror after its writer turn, never the runtime ledger. */
export function reconcileFleetNodeMaterialization(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly binding: RepoCellBinding;
  readonly action: RepoTaskAction;
  readonly receipt: WriteReceipt;
}): WriteReceipt {
  const replica = edgeReplica(input.rootDir, input.repoId, input.binding);
  // A preference may precede the first join/backup; every later pull reads the same local setting.
  if (!replica || !locateFleetMirrorView(replica.viewRoot, input.repoId, replica.nodeId, { includeEntries: false }))
    return input.receipt;
  return withEdgeReadModel(replica, (projection, _frame, view, generation) => {
    const result = materializeFleetMirrorView(input.rootDir, view, projection, generation, {
      request: { reconcileNodePolicy: true },
    });
    return result.dirtyPaths.length === 0
      ? input.receipt
      : {
          ...input.receipt,
          outcome: "pending",
          status: "unknown",
          warnings: [
            ...(input.receipt.warnings ?? []),
            `Local materialization conflicts: ${result.dirtyPaths.join(", ")}`,
          ],
          guidance: [
            ...(input.receipt.guidance ?? []),
            {
              kind: "run-command",
              args: {
                command: `ha settings update --task-materialization-policy ${String(input.action.taskMaterializationPolicy)}`,
              },
            },
          ],
        };
  });
}

/** The existing document selection/receipt contract runs against an authorized, pinned replica cut. */
export async function materializeFleetEdgeDocuments(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly binding: RepoCellBinding;
  readonly action: RepoTaskAction;
  readonly now: string;
}): Promise<WriteReceipt> {
  const replica = edgeReplica(input.rootDir, input.repoId, input.binding);
  if (!replica) throw cellCodedError("replica_unavailable", "This edge has no Fleet replica configuration.");
  const cut = withEdgeReadModel(replica, (_projection, frame) => frame.cut),
    binding = await authorizeRepoActionBinding({
      repoId: input.repoId,
      action: input.action,
      binding: input.binding,
      actionId: `materialize:${cut.headDigest}`,
      revision: cut.revision,
      now: input.now,
      readTask: (taskId) => withEdgeReadModel(replica, (projection) => projection.read(taskId).snapshot.task),
    });
  return withEdgeReadModel(replica, (projection, frame, view, generation) => {
    // Authorization may await the identity service. No canonical append fences this host-local
    // write, so a changed replica cut must be reauthorized rather than borrowing the earlier grant.
    if (frame.cut.revision !== cut.revision || frame.cut.headDigest !== cut.headDigest)
      throw cellCodedError("revision_conflict", "The replica advanced during authorization; retry materialization.");
    requireCurrentExecutionScope({ action: input.action, binding, projection, now: input.now });
    const selected = withWorkspaceDocumentPaths({ rootDir: input.rootDir, action: input.action });
    requireDocCommandFrame(selected.action);
    requireOwnTaskDocSelection({ ...selected, binding, projection });
    let visible = true;
    const receipt = runDocMaterialize({
      ...selected,
      binding,
      projection,
      store: {
        materialize: (request) => {
          const result = materializeFleetMirrorView(input.rootDir, view, projection, generation, {
            request: request ?? {},
          });
          visible = result.dirtyPaths.length === 0;
          return {
            status: request?.preview ? "planned" : "visible",
            commitSha: null,
            settlements: result.settlements,
            conflicts: result.dirtyPaths,
          };
        },
        readHead: () => ({ revision: view.revision }),
        currentCut: () => ({ repoId: view.repoId, revision: view.revision, headDigest: view.headDigest }),
        followerStatus: () => ({ worktree: { status: visible ? "verified" : "pending" } }),
      },
    });
    return settleHostLocalReceipt(input.action, withAuthorizationDecision(receipt, binding.authorizationDecision!));
  });
}
