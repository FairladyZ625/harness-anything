import type { Effect } from "effect";
import type { ArtifactStoreError, TaskId } from "../domain/index.js";
import type { TaskPackageRead } from "./artifact-store.ts";

export interface DocumentWrite {
  readonly taskId: TaskId;
  readonly path: string;
  readonly body: string;
  readonly packageSlug?: string;
}

export interface ArtifactWriteReceipt {
  readonly taskId: TaskId;
  readonly path: string;
  readonly sha256: string;
}

// Flusher-only seam: no Context tag on purpose. Authored writes reach the
// store exclusively through WriteCoordinator (journal -> lock -> flush);
// exposing an injectable write surface here would reopen the WAL bypass.
export interface ArtifactStoreWriter {
  readonly writeDocument: (write: DocumentWrite) => Effect.Effect<ArtifactWriteReceipt, ArtifactStoreError>;
  readonly archivePackage: (taskId: TaskId) => Effect.Effect<TaskPackageRead, ArtifactStoreError>;
}
