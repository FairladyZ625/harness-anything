import type {
  DaemonGuiActionResult,
  DaemonGuiReadPayloadMap,
  DaemonGuiReadResultMap,
  GuiSubmissionV1,
} from "@harness-anything/daemon/protocol";
export type {
  ContractVersion,
  DecisionProjectionRow,
  ProjectionWarning,
  RelationType,
  RelationDirection,
  RelationState,
  FactProjectionRow,
  FactAnchorRow,
  RelationFactRow,
  RelationGraphEdgeRow,
  FreshnessReason,
} from "@harness-anything/kernel/browser";
/**
 * The coverage row the daemon read actually serves: the kernel projection row plus
 * the optional uncovered-cause classification (kernel `freshnessReasonOf`) attached
 * by the read surface. Typed from the served shape, not the kernel shape, so the
 * renderer consumes the judgment instead of re-deriving it.
 */
export type RelationCoverageRow = DaemonGuiReadResultMap["repo.triadic.relationGraph"]["coverageRows"][number];
/** 关系图读面真正送达的边行:kernel 行 + daemon 逐行转发的 `current` 判定。 */
export type ServedRelationEdgeRow = DaemonGuiReadResultMap["repo.triadic.relationGraph"]["edges"][number];
/**
 * `repo.decisions.list` full row: the kernel row plus the review cut the read surface computes
 * (`currentReviewContentDigest`, `acceptReviewReadiness`) and the Decision's review dispatches.
 */
export type DecisionFullRow = Extract<
  DaemonGuiReadResultMap["repo.decisions.list"],
  { readonly projection?: "full" }
>["decisions"][number];
export type TaskSnapshotProjectionRow = DaemonGuiReadResultMap["repo.tasks.list"]["rows"][number];
export type TaskSnapshotInvalidRow = DaemonGuiReadResultMap["repo.tasks.list"]["invalidRows"][number];
export type TaskWipRead = DaemonGuiReadResultMap["repo.tasks.wip"];
export type WorkIndexRead = DaemonGuiReadResultMap["repo.works.index"];
export type TaskCompletionRead = DaemonGuiReadResultMap["repo.tasks.completion.read"];
/** `repo.agenda.read`: the same supervisory agenda projection the CEO CLI tick reads. */
export type AgendaRead = DaemonGuiReadResultMap["repo.agenda.read"];
export type AgendaAttentionItem = AgendaRead["attentionItems"][number];
export type AgendaRegionWeights = AgendaRead["regionWeights"];
/** `repo.ci.observatory.read`: main-branch CI run window for the overview's CI region. */
export type CiObservatoryRead = DaemonGuiReadResultMap["repo.ci.observatory.read"];
export type AgendaTaskRow = AgendaRead["inFlight"][number];
export type AgendaExecutionRow = AgendaRead["awaitingAdjudication"][number];
export type AgendaDecisionRow = AgendaRead["awaitingDecision"][number];
export type AgendaDecisionReviewRow = AgendaRead["decisionReviewInProgress"][number];
export type AgendaAwaitsRow = AgendaRead["awaitingYou"][number];
export type AgendaAnsweredRow = AgendaRead["answeredForYou"][number];
export type SettingsRead = DaemonGuiReadResultMap["repo.settings.read"];
export type WorkspaceSummaryRead = DaemonGuiReadResultMap["repo.workspace.summary.read"];
export type WorkspaceScopeRead = DaemonGuiReadResultMap["repo.workspace.scope.read"];
export type TaskDocumentProjectionRead = DaemonGuiReadResultMap["repo.tasks.document.read"];
export type TaskDocumentListProjectionRead = DaemonGuiReadResultMap["repo.tasks.documents.list"];
export type TaskDispatchesRead = DaemonGuiReadResultMap["repo.task.dispatches"];
export type TaskDispatchProjectionRow = DaemonGuiReadResultMap["repo.task.dispatches"]["dispatches"][number];
export type ObserveTailPayload = DaemonGuiReadPayloadMap["observe.tail"];
export type ObserveTailRead = DaemonGuiReadResultMap["observe.tail"];
/** `repo.fleet.overview.read`: the Collaboration page's fleet topology in one typed read. */
export type FleetOverviewRead = DaemonGuiReadResultMap["repo.fleet.overview.read"];
export type FleetOverviewNode = FleetOverviewRead["nodes"][number];
export type FleetOverviewLink = FleetOverviewRead["links"][number];
export type FleetOverviewEvent = FleetOverviewRead["events"][number];
export type FleetFieldState = FleetOverviewNode["owner"];
export type AgentRuntimeOverviewPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.overview"];
export type AgentRuntimeSessionPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.sessions.read"];
export type AgentRuntimeEventsPayload = DaemonGuiReadPayloadMap["repo.agentRuntime.events.read"];
export type GuiActionResult = DaemonGuiActionResult;
export type GuiBridgeMethod =
  | (typeof import("@harness-anything/daemon/protocol").daemonGuiInvokeFacets)[number]["guiBridgeMethod"]
  | (typeof import("@harness-anything/daemon/protocol").daemonGuiStreamFacets)[number]["guiBridgeMethod"];
export type { GuiSubmissionV1 };
