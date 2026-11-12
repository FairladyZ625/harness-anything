// dec_499E4E98A3D4754132B3BCA1E6: shared vocabulary authority; no transitions or persistence.
export const agentPlanStepStatusWords = ["pending", "running", "done", "failed", "skipped"] as const;
export type AgentPlanStepStatus = (typeof agentPlanStepStatusWords)[number];

export const approvalVerdictWords = ["approved", "denied"] as const;
export type ApprovalVerdict = (typeof approvalVerdictWords)[number];

export const promptCacheTtlStateWords = ["normal", "warning", "expired"] as const;
export type PromptCacheTtlState = (typeof promptCacheTtlStateWords)[number];

export const daemonStartupPhaseWords = ["pending", "waiting", "timeout", "ready"] as const;
export type DaemonStartupPhase = (typeof daemonStartupPhaseWords)[number];

export type EntityContentOutcome = Exclude<EntityLocatorReadOutcome, "unsupported">;

export const entityWriteStateWords = ["applied", "pending", "conflict", "rejected"] as const;
export type EntityWriteState = (typeof entityWriteStateWords)[number];

export const entityLocatorReadOutcomeWords = [
  "file",
  "directory",
  "missing",
  "unsupported",
  "too-large",
  "binary",
] as const;
export type EntityLocatorReadOutcome = (typeof entityLocatorReadOutcomeWords)[number];

export const daemonHealthStateWords = ["responsive", "unresponsive", "unknown"] as const;
export type DaemonHealthState = (typeof daemonHealthStateWords)[number];

export const scheduleVerdictWords = ["failed", "degraded", "ok", "never"] as const;
export type ScheduleVerdict = (typeof scheduleVerdictWords)[number];

export const sessionVerdictWords = [
  "succeeded",
  "failed",
  "cancelled",
  "stopped",
  "unknown",
  "indeterminate",
  "running",
] as const;
export type SessionVerdict = (typeof sessionVerdictWords)[number];

export const toolCallStatusWords = ["running", "succeeded", "failed"] as const;
export type ToolCallStatus = (typeof toolCallStatusWords)[number];

export const transcriptPlanStepStatusWords = ["pending", "in_progress", "completed"] as const;
export type TranscriptPlanStepStatus = (typeof transcriptPlanStepStatusWords)[number];

export const steeringEntryStatusWords = ["pending", "injected", "rejected"] as const;
export type SteeringEntryStatus = (typeof steeringEntryStatusWords)[number];

export const updateCheckStateWords = ["idle", "checking", "not-available"] as const;
export type UpdateCheckState = (typeof updateCheckStateWords)[number];

export const updateArtifactStateWords = ["available", "downloaded"] as const;
export type UpdateArtifactState = (typeof updateArtifactStateWords)[number];

export const answerFeedbackStateWords = ["pending", "success", "error", "conflict"] as const;
export type AnswerFeedbackState = (typeof answerFeedbackStateWords)[number];

export const cadenceFeedStatusWords = ["loading", "live", "unavailable", "error"] as const;
export type CadenceFeedStatus = (typeof cadenceFeedStatusWords)[number];

export const degradedEntityStateWords = ["invalid", "missing"] as const;
export type DegradedEntityState = (typeof degradedEntityStateWords)[number];

export const agentPlanPhaseWords = ["editing", "running"] as const;
export type AgentPlanPhase = (typeof agentPlanPhaseWords)[number];

export const steerNoteStateWords = ["queued", "absorbed"] as const;
export type SteerNoteState = (typeof steerNoteStateWords)[number];

export const attentionStateWords = ["question", "awaits", "working"] as const;
export type AttentionState = (typeof attentionStateWords)[number];

export const connectionVisualStateWords = ["live", "idle", "failed"] as const;
export type ConnectionVisualState = (typeof connectionVisualStateWords)[number];

export const bindingCoverageStateWords = ["full", "part", "none"] as const;
export type BindingCoverageState = (typeof bindingCoverageStateWords)[number];

export const observeTailStatusWords = ["idle", "live", "unavailable", "gap", "error"] as const;
export type ObserveTailStatus = (typeof observeTailStatusWords)[number];

export type MutationFeedbackState = Exclude<AnswerFeedbackState, "conflict">;

export const catalogReadStateWords = ["ready", "pending", "error"] as const;
export type CatalogReadState = (typeof catalogReadStateWords)[number];

export const transcriptTurnStatusWords = ["running", "completed", "failed", "unknown"] as const;
export type TranscriptTurnStatus = (typeof transcriptTurnStatusWords)[number];

export const startWorkPreconditionStateWords = ["ok", "blocked", "unknown"] as const;
export type StartWorkPreconditionState = (typeof startWorkPreconditionStateWords)[number];

export const terminalAttachStatusWords = ["attached", "gap"] as const;
export type TerminalAttachStatus = (typeof terminalAttachStatusWords)[number];

export const terminalTabStateWords = ["running", "exited", "unknown"] as const;
export type TerminalTabState = (typeof terminalTabStateWords)[number];

export const terminalRestartStateWords = ["confirmation_required", "requested"] as const;
export type TerminalRestartState = (typeof terminalRestartStateWords)[number];

export const dispatchActivityStatusWords = ["thinking", "tool", "waiting", "silent", "stalled", "unknown"] as const;
export type DispatchActivityStatus = (typeof dispatchActivityStatusWords)[number];

export const entityContentReadOutcomes = ["file", "directory", "missing", "too-large", "binary"] as const;
