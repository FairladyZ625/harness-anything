import {
  assertWriterEpochFenceDescriptor,
  openFleetStorage,
  type DaemonStorageConfig,
} from "@harness-anything/storage";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCell } from "./repo-cell-types.ts";
import { chainRepoCellWrite } from "./repo-cell.ts";

/** The snapshot owns a write turn only until both read views are pinned, never through archiving. */
export function makeRepoCellFleetBackup(
  cell: Pick<
    RepoCellApiContext,
    "rootDir" | "input" | "tail" | "writeQueue" | "state" | "latched" | "cellCodedError" | "projection"
  >,
  storage?: DaemonStorageConfig,
): NonNullable<RepoCell["fleetBackup"]> {
  return (request, signal, observation) => {
    const pinned = chainRepoCellWrite(
      cell.tail,
      async () => {
        signal?.throwIfAborted();
        if (cell.state !== "attached") throw cell.cellCodedError("repo_unavailable", cell.latched());
        assertWriterEpochFenceDescriptor(request.writerEpochFence);
        const source = openFleetStorage({ rootDir: cell.rootDir, repoId: cell.input.repoId, storage });
        try {
          return await source.startBackup(request.directory, cell.projection.path, signal);
        } finally {
          source.close();
        }
      },
      {
        queue: cell.writeQueue,
        label: observation?.label ?? { command: "replication-snapshot", requestId: null },
        ...(observation ? { observation } : {}),
      },
    );
    cell.tail = pinned.then(
      () => undefined,
      () => undefined,
    );
    // The IPC receipt contains a completed, cloneable archive. Its pending request does not own tail.
    return pinned.then(({ complete }) => complete);
  };
}
