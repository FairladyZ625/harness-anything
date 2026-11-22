export { createDefaultFdeDraft, FDE_LOCATOR_KINDS, FDE_RELATION_KINDS } from "./studio/domain-draft.ts";
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
} from "./studio/domain-draft.ts";
export { compileStudioDraft } from "./studio/compiler.ts";
export { buildHtmlPreviews, renderDomainExplainerHtml, renderProjectAtlasHtml } from "./studio/html-preview.ts";
export {
  applyPresetScaffold,
  persistStudioDraft,
  previewPresetScaffold,
  simulateStudioDraft,
  type PersistStudioDraftInput,
  type SimulateStudioDraftInput,
} from "./studio/simulator.ts";
export { startFdeStudioServer, type FdeStudioServer, type StartFdeStudioServerOptions } from "./server/fde-server.ts";
export type {
  FdeBootstrapPayload,
  FdeCompiledPackage,
  FdeDossierValidation,
  FdeHtmlPreviews,
  FdeMaterializedFile,
  FdePersistResult,
  FdeSimulateReportDto,
  FdeSimulatedDiagnostic,
  FdeSimulatedDocument,
  FdeSimulatedGate,
  FdeSimulatedGateProbe,
  FdeSimulationResult,
} from "./studio/studio-api.ts";
