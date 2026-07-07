// @slice-activation PLT-Bedrock W1 exposes local kernel implementation factories
// for application composition roots without making store internals public.
export { makeMarkdownArtifactStore } from "../store/markdown-artifact-store.ts";
export { makeJournaledWriteCoordinator } from "../store/write-journal-coordinator.ts";
export { makeLocalLockRegistry } from "../store/local-lock-registry.ts";
export { makeLocalVersionControlSystem } from "../store/local-version-control-system.ts";
