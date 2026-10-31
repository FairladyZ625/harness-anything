// Curated port surface. artifact-store-writer.ts is deliberately absent:
// the write seam is flusher-only and must not be reachable from here.
export { authorizationPort } from "./authorization-port.ts";
export type { AuthorizationContext, AuthorizationPort } from "./authorization-port.ts";

export { ArtifactStore } from "./artifact-store.ts";

export { VcsCommandError } from "./version-control-system.ts";

export * from "./canonical-document-claims.ts";
export * from "./canonical-event-store.ts";
export * from "./canonical-event-validation.ts";
export * from "./decision-projection-model.ts";
export * from "./projection-contracts.ts";
export * from "./projection-reads.ts";
export * from "./projection-types.ts";
export * from "./task-event-store.ts";
export * from "./task-projection.ts";
export * from "./version-control-system.ts";
