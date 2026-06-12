export { createTaskIdentity } from "./task.ts";
export type { Task, TaskIdentity, TaskId, EngineId, ExternalRef, IsoTimestamp, Sha256Fingerprint } from "./task.ts";

export {
  domainStatuses,
  openDomainStatuses,
  terminalDomainStatuses,
  reviewArtifactStatuses,
  isDomainStatus,
  isTerminalStatus,
  needsReviewArtifacts,
  statusCoarseClass
} from "./lifecycle-status.ts";
export type { DomainStatus, CanonicalStatus, StatusCoarseClass } from "./lifecycle-status.ts";

export { immutableBindingFields, validateLifecycleBindingInvariant } from "./lifecycle-binding.ts";
export type { LifecycleBinding, BindingInvariantResult, ImmutableBindingField } from "./lifecycle-binding.ts";

export { closeoutReadinesses, isCloseoutReadiness } from "./closeout-readiness.ts";
export type { CloseoutReadiness } from "./closeout-readiness.ts";

export { packageDispositions, isPackageDisposition } from "./package-disposition.ts";
export type { PackageDisposition } from "./package-disposition.ts";

export { findEntityRefs, parseEntityRef } from "./entity-ref.ts";
export type { EntityRefKind, ParsedEntityRef } from "./entity-ref.ts";

export type {
  EngineError,
  BindingInvariantError,
  ArtifactStoreError,
  TemplateLibraryError,
  WriteError
} from "./errors.ts";

export {
  validateExtensionInputShape,
  validateTemplateCatalog,
  validatePresetManifests,
  validateVerticalDefinition,
  planTemplateMaterialization,
  formatTemplateRef
} from "./extension-model.ts";
export type {
  ExtensionValidationIssue,
  ExtensionValidationResult,
  KernelVersionContext,
  MaterializationRequest,
  MaterializedTemplatePlan,
  MaterializationResult,
  ExtensionInputKind
} from "./extension-model.ts";
