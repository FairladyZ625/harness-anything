// Curated port surface. artifact-store-writer.ts is deliberately absent:
// the write seam is flusher-only and must not be reachable from here.
export { authorizationPort } from "./authorization-port.ts";
export type { AuthorizationContext, AuthorizationPort } from "./authorization-port.ts";

export { ArtifactStore } from "./artifact-store.ts";
export type { ArtifactDocument, TaskPackageRead } from "./artifact-store.ts";

export { TemplateLibrary } from "./template-library.ts";
export type { Locale, TemplateRef, TemplateDocument } from "./template-library.ts";

export { VersionControlSystem, VcsCommandError } from "./version-control-system.ts";
export type { VcsCommitAuthor, VersionControlSystem as VersionControlSystemPort } from "./version-control-system.ts";
