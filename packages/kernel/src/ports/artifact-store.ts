import { Context, Effect } from "effect";
import type { ArtifactStoreError, PackageDisposition, TaskId } from "../domain/index.js";

export interface ArtifactDocument {
  readonly path: string;
  readonly body: string;
  readonly sha256?: string;
}

export interface TaskPackageRead {
  readonly taskId: TaskId;
  readonly rootPath: string;
  readonly disposition: PackageDisposition;
  readonly documents: ReadonlyArray<ArtifactDocument>;
}

export interface DocumentWrite {
  readonly taskId: TaskId;
  readonly path: string;
  readonly body: string;
}

export interface ArtifactWriteReceipt {
  readonly taskId: TaskId;
  readonly path: string;
  readonly sha256: string;
}

export interface ArtifactStore {
  readonly readTaskPackage: (taskId: TaskId) => Effect.Effect<TaskPackageRead, ArtifactStoreError>;
  readonly writeDocument: (write: DocumentWrite) => Effect.Effect<ArtifactWriteReceipt, ArtifactStoreError>;
  readonly archivePackage: (taskId: TaskId) => Effect.Effect<TaskPackageRead, ArtifactStoreError>;
}

export const ArtifactStore = Context.GenericTag<ArtifactStore>(
  "@harness-anything/kernel/ArtifactStore"
);
