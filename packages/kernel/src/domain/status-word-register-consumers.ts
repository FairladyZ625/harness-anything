import type { StatusEntity, StatusVocabulary, StatusWordRegistration } from "./status-vocabulary.ts";
import * as catalog0 from "./operational-status.ts";
import * as catalog1 from "./client-view-status.ts";
import * as catalog2 from "./access-status.ts";
import * as catalog3 from "./code-doc-retirement.ts";
import * as catalog4 from "./entity-freshness.ts";

// Meanings are scoped by entity and field. Equal words in different axes remain distinct.
interface Catalog {
  readonly module: string;
  readonly words: Readonly<Record<string, readonly string[]>>;
  readonly meanings: Partial<Readonly<Record<StatusEntity, Readonly<Record<string, string>>>>>;
}
const catalogs: readonly Catalog[] = [
  {
    module: "packages/kernel/src/domain/operational-status.ts",
    words: catalog0,
    meanings: {
      Host: {
        cliTimingPhaseWords:
          "The measured CLI stage: process spawn, argument parse, dispatch, daemon round trip, or rendering.",
        daemonStopOutcomeWords: "Daemon shutdown either stopped, is draining active work, or exceeded its deadline.",
        jsStackStatusWords:
          "A stack probe captured a sample, lacked an advertised endpoint, could not connect, or failed capture.",
        probeStateWords: "Probe endpoint availability is responsive, over the latency budget, or unreachable.",
        repoRegistrationStateWords:
          "Repository registration admits attachment when enabled and refuses it when disabled.",
        runtimeReadinessStatusWords:
          "The runtime is a macOS local v1 release candidate, with no broader release claim.",
        supplyChainReadinessStatusWords: "Supply chain gates exist but release artifacts have not been published.",
        doctorCheckStatusWords: "Doctor check passes, warns, fails, or cannot determine health.",
        observationStatusWords: "An operational measurement has an observation or lacks sufficient samples.",
        repoCellStateWords: "A repository cell is warming, attached, unavailable, or has not been loaded.",
        repoLockStateWords: "Repository process lock is held, does not apply to this target, or cannot be observed.",
        daemonControlPhaseWords: "Daemon control is queued, draining, starting a successor, settled, or failed.",
        daemonOperationOutcomeWords: "A daemon operation completes successfully or with an error.",
        repoBootstrapOutcomeWords:
          "Repository bootstrap applies changes, needs none, completes partially, or cannot confirm settlement.",
        repoCellAttachmentStateWords:
          "Repository cell attachment warms, serves requests, is unavailable, or has closed.",
        repoRecoveryStatusWords: "Repository recovery has no uncertainty or cannot determine settlement.",
        homeRepoStatusWords:
          "Home repository roll-up reports an attached cell as online, warming, unavailable, or offline when unloaded.",
        repoAttachPhaseWords:
          "Repository cell startup opens storage, recovers durable state, catches up projections, or restores runtime sessions.",
      },
      Migration: {
        migrationPhaseWords:
          "Storage migration freezes writes, prepares, seals the source, fails activation, activates the target, abandons, or resumes the source.",
        generationConversionDispositionWords:
          "A historical generation is converted, retained for read only use, or unsupported.",
        writerEpochMigrationStateWords:
          "Writer epoch conversion is unnecessary, previously completed, newly completed, or incomplete.",
        authoredDispositionWords: "Authored import is migrated, intentionally excluded, or still required.",
        migrationDispositionWords: "Historical input is archived or retired after reconciliation.",
        taskRestatementDispositionWords:
          "Imported task contract retires a preset, renames it, or aligns its task class.",
        legacyWorktreeStatusWords: "Legacy worktree rename is planned or has completed.",
        agentDeclarationMigrationOutcomeWords:
          "An authored agent declaration is converted to the current shape, already current, or rejected with schema issues.",
      },
      Projection: {
        projectionFreshnesses: "A projection is current, usable from a stale cache, or unavailable without any cache.",
      },
      RuntimeSession: {
        runtimeBatchStatusWords:
          "A runtime batch command succeeds, fails, is refused, lacks a confirmed result, or stops.",
        runtimeIsolationStateWords:
          "Runtime provider isolation is enforced or deliberately uses the operator environment.",
        runtimeAuthStateWords:
          "Runtime instance authentication is configured, verified authenticated, unauthenticated, or unobserved.",
        runtimeAuthReadinessStatusWords: "Runtime instance authentication probe is ready to launch or not ready.",
        runtimeEndpointAvailabilities:
          "A runtime provider allows no custom endpoint, an optional endpoint, or requires one.",
        runtimeRecoveryOutcomeWords:
          "Runtime session recovery reattaches a live session, settles a finished one, fails, or skips a foreign owner.",
        runtimeSteerLivenessWords: "A steer target process is running, still starting, or already stopped.",
        providerGroupSweepVerdictWords:
          "Detached process group sweep observes a running group, proves it stopped, or cannot reach the host table.",
        relayCostStatusWords:
          "Cloud dispatch relay settles token spend from provider-reported usage or from the request estimate.",
      },
      Decision: {
        decisionDriftStateWords:
          "Decision evidence is current, has drifted from its accepted cut, or cannot be observed.",
        decisionConflictStateWords: "Decision consistency is clear, conflicting, or cannot be observed.",
        decisionActionStatusWords: "A claimed decision action is applied or fails.",
        decisionAnnotationStatusWords: "Decision annotation settlement awaits execution, succeeds, or fails.",
        incidentHeadStatusWords:
          "Incident evidence compares the current head to a prior run or reports unavailable evidence.",
      },
      Materialization: {
        materializationReceiptStatusWords:
          "Materialization has made the document visible or only planned its settlement.",
      },
      Package: {
        scaffoldDocumentDispositionWords:
          "Scaffold output was created, preserved unchanged, or differs from its generated content.",
        bootstrapDocumentDispositionWords: "Bootstrap creates, preserves, or updates a generated document.",
      },
      Review: {
        reviewPromptPhaseWords: "Reviewer prompt is for the first review or a returned cut.",
        reviewDispatchStepOutcomeWords:
          "Automatic review dispatch spawns a reviewer, reuses an active dispatch or existing review, waits on projection readiness, or fails.",
      },
      Artifact: {
        skillPublicationStatusWords: "An evaluated skill is a draft or published.",
        deliveryFileStatusWords: "A delivery file is added, modified, deleted, renamed, copied, or changes type.",
      },
      Task: {
        workTopologyStateWords:
          "Work topology shows completion, cancellation, execution, ruling wait, blocking, readiness, unknown evidence, or an external boundary.",
        taskWorkspaceStateWords:
          "Task worktree is bound without a local checkout, materialized on disk, reclaimed after closeout, or retained on disk.",
      },
      Schedule: {
        scheduleExecutionAvailabilities:
          "Schedule execution runs on this node, is claimed by another node, or is not bound to this node.",
        scheduleMissedSettlementOutcomeWords:
          "Missed schedule interval recording settles, is rejected by receipt, or waits on human authentication.",
      },
      SquadRun: {
        squadControlOutcomeWords: "A squad control command completes or is rejected at admission.",
      },
      Dispatch: {
        dispatchFallbackStateWords:
          "Provider fallback retry is scheduled, has dispatched a replacement attempt, or has exhausted fallback candidates.",
        dispatchEvidenceStateWords:
          "Dispatch forensic evidence is pending durable storage, stored, or not required for a normal turn.",
        dispatchExitNotificationPhaseWords:
          "An on-exit notification hook records when its child command has started or finished.",
      },
    },
  },
  {
    module: "packages/kernel/src/domain/client-view-status.ts",
    words: catalog1,
    meanings: {
      GuiAdapter: {
        agentPlanStepStatusWords: "A displayed agent plan step awaits work, runs, finishes, fails, or is skipped.",
        approvalVerdictWords: "The displayed tool approval grants or denies the requested execution.",
        promptCacheTtlStateWords: "Prompt cache lifetime is within budget, near expiry, or expired.",
        daemonStartupPhaseWords: "The client is awaiting startup, polling for readiness, timed out, or attached.",
        daemonHealthStateWords:
          "Observed daemon health is responsive, missed its response budget, or has no observation.",
        toolCallStatusWords: "A transcript tool call is executing, completed successfully, or failed.",
        transcriptPlanStepStatusWords: "Transcript plan progress is pending, in progress, or completed.",
        steeringEntryStatusWords: "A steering entry awaits injection, has been injected, or was rejected.",
        updateCheckStateWords: "Updater is idle, checking, or has found no available update.",
        updateArtifactStateWords: "An update artifact is available to fetch or has been downloaded.",
        answerFeedbackStateWords:
          "Answer submission awaits settlement, succeeded, failed, or encountered a revision conflict.",
        cadenceFeedStatusWords: "Cadence feed is loading, receiving live data, unavailable, or failed.",
        degradedEntityStateWords: "An entity cannot be used because its document is invalid or missing.",
        agentPlanPhaseWords: "The displayed agent plan is being edited or executing.",
        steerNoteStateWords: "A displayed steering note is queued or acknowledged as absorbed.",
        attentionStateWords: "Attention chip denotes a question, an awaited response, or active work.",
        connectionVisualStateWords: "Connection indicator displays live, idle, or failed activity.",
        bindingCoverageStateWords: "Binding indicator shows all, some, or no required bindings.",
        observeTailStatusWords: "Observation tail is idle, live, unavailable, contains a sequence gap, or failed.",
        catalogReadStateWords: "A catalog query has a ready cut, a pending cut, or failed.",
        transcriptTurnStatusWords: "Transcript turn is running, completed, failed, or lacks a known termination.",
        startWorkPreconditionStateWords: "Start work precondition is satisfied, blocked, or cannot be observed.",
        terminalAttachStatusWords: "Terminal attachment starts at the current tail or reports a replay gap.",
        terminalTabStateWords: "Terminal process is running, exited, or has no liveness observation.",
        terminalRestartStateWords: "Terminal restart requires confirmation or has been requested.",
      },
      Artifact: {
        entityWriteStateWords:
          "Entity write settlement is applied, pending, conflicting with a newer revision, or rejected.",
        entityContentReadOutcomes:
          "Content read resolves to text, a directory, absence, oversized content, or binary bytes.",
        entityLocatorReadOutcomeWords:
          "Locator read resolves to text, a directory, absence, an unsupported locator, oversized content, or binary bytes.",
      },
      Schedule: {
        scheduleVerdictWords: "Schedule display reports failure, degraded evidence, success, or no previous run.",
      },
      RuntimeSession: {
        sessionVerdictWords:
          "Session display reports success, failure, cancellation, stop, unknown evidence, indeterminate settlement, or current execution.",
        dispatchActivityStatusWords:
          "Dispatch activity is thinking, using a tool, waiting, silent, stalled, or unobserved.",
        agentRuntimeSessionGroupStatusWords:
          "Session group filter and badge report a semantic session state, unknown evidence, a blocked wait, or a lost process.",
        tokenUsageOutcomeWords:
          "Token usage analytics group dispatches by succeeded, failed, cancelled, stopped, running, or unknown settlement.",
      },
    },
  },
  {
    module: "packages/kernel/src/domain/access-status.ts",
    words: catalog2,
    meanings: {
      AuthorizationDecision: {
        permissionRequestStateWords: "An access request awaits judgment, is approved, is rejected, or is withdrawn.",
        accessReceiptPhaseWords: "An access audit operation records an intent before its settled receipt.",
        accessReceiptOutcomeWords:
          "Access administration applied the operation, failed it, or refused a stale version.",
        edgeJoinStateWords: "An invitation awaits use, has been consumed, expired, or explicitly revoked.",
        edgeJoinTunnelStateWords: "An edge join reverse tunnel is connecting, connected, reconnecting, or stopped.",
        authorizationNodeStateWords: "An authorized device is active, administratively paused, or removed.",
        edgeJoinSyncStateWords: "Joined repositories are fully synced or only partially synced.",
        edgeJoinRepositoryPhaseWords:
          "Repository join prepares a workspace, registers, syncs, completes sync, or fails.",
        legacyRoleGrantOutcomeWords:
          "Legacy role grant was written, already present, or skipped because no grant was needed.",
      },
      Host: {
        replicaSyncPhaseWords:
          "Replica transfer prepares, authorizes, queues or transfers its backup and commits, then waits for durable acknowledgement or new work.",
        fleetConflictStateWords: "A fleet mirror conflict is staged or resolved.",
        fleetMirrorApplyOutcomeWords:
          "Mirror application succeeds, is blocked by local changes, or has no attached view.",
        fleetLinkStateWords: "A fleet link is current, lagging behind the center, or has no synchronized cut.",
      },
    },
  },
  {
    module: "packages/kernel/src/domain/code-doc-retirement.ts",
    words: { retiredCodeDocDispositions: catalog3.retiredCodeDocDispositions },
    meanings: {
      Task: {
        retiredCodeDocDispositions:
          "Accepted historical repoint records either replaced an anchor or marked it known invalid; current admission rejects both.",
      },
    },
  },
  {
    module: "packages/kernel/src/domain/entity-freshness.ts",
    words: { entityFreshnesses: catalog4.entityFreshnesses, relationFreshnesses: catalog4.relationFreshnesses },
    meanings: {
      Artifact: { entityFreshnesses: "An entity witness is current, has lost its source, or cannot be observed." },
      Relation: {
        relationFreshnesses:
          "A relation cut is current, suspect after a version change, or orphaned after losing an endpoint.",
      },
    },
  },
];
export const consumerStatusVocabularies: readonly StatusVocabulary[] = catalogs.flatMap((catalog) =>
  Object.entries(catalog.meanings).flatMap(([entity, meanings]) =>
    Object.entries(meanings).map(([anchor, note]) => ({
      id: "consumer." + anchor,
      module: catalog.module,
      anchor,
      entity: entity as StatusEntity,
      field: anchor,
      words: catalog.words[anchor]!,
      note,
    })),
  ),
);
export const consumerStatusWordRegister: readonly StatusWordRegistration[] = consumerStatusVocabularies.flatMap(
  ({ entity, field, words, note }) =>
    words.map((word) => ({ word, entity, field, meaning: word + ": " + note, divergence: "entity-scoped" as const })),
);
