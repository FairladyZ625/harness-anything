import type { ReplicaChangeLog } from "@harness-anything/application";
import {
  createAuthorityReplicationContentStore,
  createContentEnrichedReplicaChangeLog,
  type AuthorityReplicationContentStore
} from "./replication-content-store.ts";

export async function prewarmLatestAuthorityReplicaSnapshot(
  workspaceId: string,
  changeLog: ReplicaChangeLog,
  content: AuthorityReplicationContentStore
): Promise<void> {
  const latest = await changeLog.latest(workspaceId);
  if (latest) content.snapshot(latest.commitSha, latest.revision);
}

export async function createPrewarmedAuthorityReplication(input: {
  readonly gitRoot: string;
  readonly state: Parameters<typeof createAuthorityReplicationContentStore>[0]["state"];
  readonly workspaceId: string;
  readonly epoch: string;
  readonly changeLog: ReplicaChangeLog;
}): Promise<{
  readonly content: AuthorityReplicationContentStore;
  readonly changeLog: ReplicaChangeLog;
}> {
  const content = createAuthorityReplicationContentStore(input);
  await prewarmLatestAuthorityReplicaSnapshot(input.workspaceId, input.changeLog, content);
  return {
    content,
    changeLog: createContentEnrichedReplicaChangeLog(input.changeLog, content)
  };
}
