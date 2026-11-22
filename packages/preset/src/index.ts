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
