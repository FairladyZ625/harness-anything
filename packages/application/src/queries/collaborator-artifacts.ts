import type { ArtifactTimelineQuery, TaskProjection } from "@harness-anything/kernel";
import { type CollaboratorScope } from "@harness-anything/kernel/internal/domain/collaborator-scope.ts";

export function readCollaboratorArtifacts(
  projection: Pick<TaskProjection, "readArtifactTimelinePage">,
  query: ArtifactTimelineQuery & CollaboratorScope,
) {
  const { scopePersonId, filterPersonId, filterNodeId, ...filters } = query,
    actorPersonId = scopePersonId ?? filterPersonId;
  return projection.readArtifactTimelinePage({
    ...filters,
    ...(actorPersonId === undefined ? {} : { actorPersonId }),
    ...(filterNodeId === undefined ? {} : { nodeId: filterNodeId }),
  });
}
