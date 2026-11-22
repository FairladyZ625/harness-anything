export * from "./preset.contract.ts";
export {
  assertRepositoryScaffoldPlanCurrent,
  compileRepositoryScaffold,
  createCanonicalPresetResolver,
  installPresetPackage,
  seedPresetPackages,
  uninstallPresetPackage,
  validatePresetPackage,
} from "./preset-resolver.ts";
export type { RepositoryScaffoldDocument, RepositoryScaffoldPlan } from "./preset-resolver.ts";
export { compilePresetSnapshotUpgrade, compileTaskBootstrap, compileTaskPackage } from "./preset-bootstrap.ts";
export type {
  CompilePresetSnapshotUpgradeInput,
  CompileTaskBootstrapInput,
  CompileTaskPackageInput,
  CompiledPresetSnapshotUpgrade,
  CompiledTaskBootstrap,
  CompiledTaskPackage,
} from "./preset-bootstrap.ts";
export {
  compileRepoPresetSnapshotUpgrade,
  compileRepoRepositoryScaffold,
  compileRepoTaskBootstrap,
  compileRepoTaskPackage,
  presetUserRoot,
  resolveRepoBootstrapDefaults,
  runPresetAction,
} from "./preset-system.ts";
export { createPresetProcessService, recoverPresetRunStatus } from "./preset-process-service.ts";
export type {
  PresetProcessService,
  PresetProcessServiceOptions,
  PresetRunStartInput,
} from "./preset-process-service.ts";
export { acceptBuiltinVerticalScriptPlan, prepareBuiltinVerticalScriptExecution } from "./vertical-script.ts";
export type { PreparedBuiltinVerticalScript } from "./vertical-script.ts";
export { listGovernanceScaffoldOverlays } from "./scaffold-overlay.ts";
export type { GovernanceScaffoldOverlays } from "./scaffold-overlay.ts";
export {
  listBundledAgentDeclarationIds,
  readAnyBundledAgentDeclaration,
  readBundledAgentDeclaration,
} from "./bundled-agent-declarations.ts";
export {
  planPresetScaffold,
  planVerticalScaffold,
  scaffoldPresetPackage,
  scaffoldVerticalPackage,
} from "./vertical-scaffold.ts";
export type {
  PresetScaffoldPlan,
  PresetScaffoldReport,
  ScaffoldPresetInput,
  ScaffoldVerticalInput,
  VerticalScaffoldPlan,
  VerticalScaffoldReport,
} from "./vertical-scaffold.ts";
export { createSimulationSandbox, writeScaffoldFiles } from "./vertical-scaffold-io.ts";
export type { PlannedScaffoldFile, ScaffoldWriteResult } from "./vertical-scaffold-io.ts";
export { simulateVerticalPackage } from "./vertical-simulate.ts";
export type {
  SimulateVerticalInput,
  SimulatedDiagnostic,
  SimulatedDocumentPreview,
  SimulatedGateProbeResult,
  SimulatedGateReport,
  SimulationSamplePair,
  VerticalSimulateReport,
} from "./vertical-simulate.ts";
export {
  createDefaultFdeDraft,
  DEFAULT_GOVERNED_RELATION_PIN,
  DEFAULT_GOVERNED_RELATION_REF,
  FDE_LOCATOR_KINDS,
  FDE_RELATION_KINDS,
  renameEntityInDraft,
  renameGateInDraft,
  renamePresetInDraft,
  renameProfileInDraft,
  updateEntityInDraft,
  updateGateInDraft,
  updatePresetInDraft,
  updateProfileInDraft,
  updateVerticalIdInDraft,
} from "./fde-studio-draft.ts";
export type {
  FdeAgentDraft,
  FdeAttributeType,
  FdeDomainDraft,
  FdeDossierSlotDraft,
  FdeEntityAttributeDraft,
  FdeEntityKindDraft,
  FdeEntityRelationDraft,
  FdeGateDraft,
  FdeGateFieldDraft,
  FdeLocale,
  FdeLocatorKind,
  FdePresetDraft,
  FdePresetProfileDraft,
  FdeRelationKind,
  FdeTemplateSlotDraft,
} from "./fde-studio-draft.ts";
export {
  buildFdeGateCheckerScript,
  buildFdeGateResultSchema,
  buildFdeLivingDossier,
  compileFdeStudioDraft,
  validateFdeLivingDossier,
} from "./fde-studio-compiler.ts";
export type { CompiledFdeStudioPlan, FdeDossierValidation, FdeMaterializedFile } from "./fde-studio-compiler.ts";
