import type { DaemonStorageConfig, ReplicationPosition } from "@harness-anything/storage";
import { readFleetRepointLineage } from "./repoint-lineage.ts";

export async function readCenterRepointLineage(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly storage?: DaemonStorageConfig;
  readonly position?: ReplicationPosition;
  readonly retentionWindowCommits: number;
  readonly ownedEpoch: { readonly epoch: number; readonly holderId: string };
  readonly assertWriterEpoch: (repoId: string, epoch: number, holderId: string) => void;
}): Promise<Awaited<ReturnType<typeof readFleetRepointLineage>> | undefined> {
  if (!input.position) return undefined;

  const lineage = await readFleetRepointLineage({
    rootDir: input.rootDir,
    repoId: input.repoId,
    storage: input.storage,
    position: input.position,
    retentionWindowCommits: input.retentionWindowCommits,
  });
  input.assertWriterEpoch(input.repoId, input.ownedEpoch.epoch, input.ownedEpoch.holderId);
  return lineage;
}
