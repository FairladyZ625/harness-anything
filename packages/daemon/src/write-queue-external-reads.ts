import type { AuthorizationDecision, WriteReceiptDraft } from "../../kernel/src/index.ts";
import { artifactImportSourceResolution, prepareArtifactEntityImportSource } from "./artifact-entity-action.ts";
import { fetchCiObservations, ingestCiObservations } from "./ci-observation-actions.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

type QueuedPublication = (
  authorizationDecision?: AuthorizationDecision,
) => WriteReceiptDraft | Promise<WriteReceiptDraft>;

// A URL artifact source or GitHub can stall without bound, and every other write to the repository
// would wait behind it in the write queue. These reads finish first; only the returned publication
// of what they read runs inside the queue.
export function readBeforeWriteQueue(
  context: RepoCellApiContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<QueuedPublication> | null {
  if (action.kind === "entity-import")
    return prepareArtifactEntityImportSource({
      rootDir: context.rootDir,
      repositoryId: context.input.repoId,
      action,
      projection: context.projection,
    }).then(
      (sourceResolution) => (authorizationDecision) =>
        context.executeAction(
          { ...action, [artifactImportSourceResolution]: sourceResolution },
          authorizationDecision ? { ...binding, authorizationDecision } : binding,
        ),
    );
  if (action.kind === "ci-observe-pull")
    return fetchCiObservations(context.extracted, action).then(
      (fetched) => () => ingestCiObservations(context.extracted, binding, fetched),
    );
  return null;
}
