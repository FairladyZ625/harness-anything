import { Context, Effect, Option } from "effect";
import type { ArtifactStoreError, EngineId, ExternalRef, PackageDisposition, TaskId } from "../domain/index.js";

export type ArtifactDocumentKind = "document" | "attachment";

export interface ArtifactDocument {
  readonly path: string;
  readonly kind: ArtifactDocumentKind;
  readonly body: string;
  readonly sha256?: string;
}

export interface AuthoredDocumentDescriptor {
  readonly path: string;
}

export interface TaskPackageRead {
  readonly taskId: TaskId;
  readonly rootPath: string;
  readonly disposition: PackageDisposition;
  readonly documents: ReadonlyArray<ArtifactDocument>;
}

// Read-side port. All authored writes go through WriteCoordinator; the
// write surface lives in artifact-store-writer.ts as a flusher-only seam.
export interface ArtifactStore {
  readonly readTaskPackage: (taskId: TaskId) => Effect.Effect<TaskPackageRead, ArtifactStoreError>;
  readonly listAuthoredDocuments: () => Effect.Effect<ReadonlyArray<AuthoredDocumentDescriptor>, ArtifactStoreError>;
  readonly readAuthoredDocument: (path: string) => Effect.Effect<ArtifactDocument, ArtifactStoreError>;
  readonly findBindingByExternalRef: (
    engine: EngineId,
    ref: ExternalRef
  ) => Effect.Effect<Option.Option<TaskId>, ArtifactStoreError>;
}

export const ArtifactStore = Context.GenericTag<ArtifactStore>(
  "@harness-anything/kernel/ArtifactStore"
);
