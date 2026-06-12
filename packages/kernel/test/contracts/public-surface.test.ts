import assert from "node:assert/strict";
import test from "node:test";
import * as kernel from "../../src/index.ts";

// Golden snapshot of the kernel's public runtime surface. A diff here is a
// deliberate interface change: update this list in the same commit and say
// why in the commit message. Types are checked by the curated index files.
const publicRuntimeSurface = [
  "ActorKindSchema",
  "ActorRefSchema",
  "ArtifactStore",
  "DocsReleasePromotionBundleSchema",
  "DomainStatusSchema",
  "FreshnessSchema",
  "HarnessCheckReportSchema",
  "HarnessConfigSchema",
  "LifecycleBindingSchema",
  "LifecycleEngine",
  "LinkKindSchema",
  "PresetManifestSchema",
  "PresetProfileSchema",
  "ProjectionWarningCodeSchema",
  "ProjectionWarningSourceSchema",
  "PublishableProjectionSchema",
  "RedactionFindingSchema",
  "Sha256FingerprintSchema",
  "SnapshotStatusSchema",
  "SqliteTaskRowSchema",
  "TaskFrontmatterSchema",
  "TaskSnapshotSchema",
  "TemplateCatalogSchema",
  "TemplateLibrary",
  "TemplateSelectionSchema",
  "VerticalDefinitionSchema",
  "WriteCoordinator",
  "WriteJournalOpSchema",
  "buildPublishableProjection",
  "checkTaskProjection",
  "closeoutReadinesses",
  "createInMemoryPublishIdempotencyLedger",
  "createTaskIdentity",
  "defaultTaskProjectionPath",
  "domainStatuses",
  "findEntityRefs",
  "formatTemplateRef",
  "hashTaskProjectionRows",
  "immutableBindingFields",
  "isCloseoutReadiness",
  "isDomainStatus",
  "isPackageDisposition",
  "isTerminalStatus",
  "needsReviewArtifacts",
  "openDomainStatuses",
  "packageDispositions",
  "parseEntityRef",
  "planTemplateMaterialization",
  "readTaskProjection",
  "rebuildTaskProjection",
  "requiredSchemaIds",
  "reservePublishIdempotencyKey",
  "reviewArtifactStatuses",
  "schemaRegistry",
  "statusCoarseClass",
  "terminalDomainStatuses",
  "validateExtensionInputShape",
  "validateLifecycleBindingInvariant",
  "validatePresetManifests",
  "validateTemplateCatalog",
  "validateVerticalDefinition"
];

test("kernel public runtime surface matches the golden snapshot", () => {
  assert.deepEqual(Object.keys(kernel).sort(), publicRuntimeSurface);
});
