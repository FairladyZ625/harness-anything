import { createHash } from "node:crypto";
import { makeDecisionService } from "../decision-service.ts";
import { makeFactService } from "../fact-service.ts";
import {
  actionReceiptGuidance,
  compileEntityUpsert,
  compileEntityDeleted,
  compileAgentRetired,
  compileAgentReactivated,
  compileDecisionWrite,
  compileFactWrite,
  decisionRelationLinkResolver,
  decisionReviewState,
  documentWorkspacePath,
  resolveHarnessLayout,
  getExecutableEntityAction,
  isRelationEvent,
  isSamePerson,
  parseEntityRef,
  requireEntityStoreKindContract,
  readAcceptedCommandOutcome,
  timestamp,
  previewDispatchLifecycleOutcome,
  type AgentDeclarationV1,
  type AuthorizationDecision,
  type LocalAgentStorePort,
  type CanonicalWriteBundle,
  type CanonicalEventStore,
  type CanonicalRelationDirection,
  type RepositorySettingsV1,
  type EntityActionContract,
  type EntityActionDraft,
  type EntityActionExecutionContract,
  type EntityActionUnmetCriterionV1,
  type EntityUpsertBundle,
  type EntityDeletedBundle,
  type AgentRetiredBundle,
  type AgentReactivatedBundle,
  type EventPublicationKillpoint,
  type SessionIdentity,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { docByteLength, type DocumentState } from "@harness-anything/kernel/internal/domain/doc-sync.contract";
import { relationStrengthForType } from "@harness-anything/kernel/internal/domain/entity-relation";
import type { NodeTaskMaterializationPolicy } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import {
  decisionAmendmentConsent,
  decisionApproval,
  entityPreview,
  prepareDecisionAmend,
  validateDecisionPackages,
} from "./decision-surface-actions.ts";
import {
  decisionFilters,
  decisionPreview,
  decisionReceipt,
  decisionSummary,
  factPreview,
  factReceipt,
  preparedEntityReport,
  preparedEntityWarnings,
  readReceipt,
} from "./entity-action-catalog-receipts.ts";
import { supersededFactDocumentSource } from "./fact-supersede-document.ts";
import {
  archiveAllFacts,
  factArchiveBundle,
  factObservationPreload,
  factUnarchiveBundle,
} from "./fact-archive-document.ts";
import type { CommandAction, CommandBinding } from "./command-ports.ts";
import {
  commitRuntimeSessionBundle,
  compileRuntimeSessionDraft,
  isRuntimeSessionBundle,
  type RuntimeSessionBundle,
  type RuntimeSessionNoChanges,
} from "./entity-action-runtime-session.ts";
import { noChanges } from "./entity-action-write-helpers.ts";
import { matchingReplayBundle } from "./entity-action-replay.ts";
import { executeRelationAction, publicationKillpoints, reject } from "./entity-action-relation.ts";
import { assertDecisionReviewerIndependent } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { reconcileDecisionReviewAwaitAfterWrite } from "./decision-review-awaits.ts";
import { retireDecisionAwaitsAfterWrite } from "./terminal-awaits-retirement.ts";
import { executeAgentScopeDelete, runCatalogAgentScopeInstall } from "./agent-scope-service.ts";

type ExecutableAction = EntityActionContract & { readonly execution: EntityActionExecutionContract };
type FactBundle = ReturnType<typeof compileFactWrite>;
type DecisionBundle = ReturnType<typeof compileDecisionWrite>;
type EntityUpsertCatalogBundle = EntityUpsertBundle & { readonly preceding: readonly [AgentReactivatedBundle] };
type EntityCatalogBundle =
  | EntityUpsertBundle
  | EntityUpsertCatalogBundle
  | EntityDeletedBundle
  | AgentRetiredBundle
  | AgentReactivatedBundle;
type AgentRestoreNoChanges = {
  readonly noChanges: true;
  readonly entityId: string;
  readonly priorVersion: number;
};
type CatalogBundle =
  | FactBundle
  | DecisionBundle
  | EntityCatalogBundle
  | RuntimeSessionBundle
  | RuntimeSessionNoChanges
  | AgentRestoreNoChanges;
export type EntityActionCatalogRunner = (
  contract: ExecutableAction,
  action: CommandAction,
  binding: CommandBinding,
  opId: string,
) => WriteReceipt | Promise<WriteReceipt>;
export type EntityActionCatalogPreparer = (
  contract: ExecutableAction,
  action: CommandAction,
  binding: CommandBinding,
  opId: string,
) => CommandAction;
export interface EntityActionCatalogRuntimes {
  readonly entity?: Readonly<Record<string, EntityActionCatalogRunner>>;
  readonly task?: (...args: Parameters<EntityActionCatalogRunner>) => Promise<WriteReceipt>;
  readonly prepare?: Readonly<Record<string, EntityActionCatalogPreparer>>;
  readonly localAgentStore?: LocalAgentStorePort;
  readonly authorizeAgentAction?: (
    action: CommandAction,
    binding: CommandBinding,
    opId: string,
  ) => Promise<AuthorizationDecision>;
  readonly commitRuntimeSession?: (bundle: RuntimeSessionBundle, binding: CommandBinding) => Promise<WriteReceipt>;
}

export function makeEntityActionCatalogExecutor(input: {
  readonly rootDir?: string;
  readonly repositoryId?: string;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly sessionIdentity: (binding: CommandBinding) => SessionIdentity;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly readSettings: () => RepositorySettingsV1;
  readonly nodeTaskMaterializationPolicy?: NodeTaskMaterializationPolicy;
  readonly artifactActions?: {
    readonly importEntity: (input: {
      readonly action: CommandAction;
      readonly binding: CommandBinding;
      readonly authorizationDecision: AuthorizationDecision;
    }) => Promise<{
      readonly contract: EntityActionContract;
      readonly action: CommandAction;
      readonly receipt: WriteReceipt;
    }>;
    readonly mutateEntity: (input: {
      readonly action: CommandAction;
      readonly binding: CommandBinding;
      readonly authorizationDecision: AuthorizationDecision;
    }) => { readonly contract: EntityActionContract; readonly action: CommandAction; readonly receipt: WriteReceipt };
  };
  readonly resolveDecisionReviewAction?: (action: CommandAction) => CommandAction;
  readonly attachDecisionReviewerArtifact?: (
    bundle: DecisionBundle,
    input: { readonly action: CommandAction; readonly binding: CommandBinding },
  ) => DecisionBundle;
  readonly relationDirections?: () => readonly CanonicalRelationDirection[];
  readonly readWorkspaceText?: (requestedValue: unknown, field: string) => string;
}) {
  const decisions = makeDecisionService({ eventStore: input.store, projection: input.projection }),
    facts = makeFactService({ eventStore: input.store, projection: input.projection });

  const runCompiled = (
    action: CommandAction,
    binding: CommandBinding,
    opId: string,
    runtimes: EntityActionCatalogRuntimes,
  ): WriteReceipt | Promise<WriteReceipt> => {
    const contract = getExecutableEntityAction(action.kind);
    executableAction(contract, action.kind);
    if (contract.execution.read) {
      if (action.kind === "fact-type-list") return readReceipt("fact-type-list", facts.listDomainTypes());
      if (action.kind === "fact-show") {
        const read = facts.show(requiredCommandText(action.factId, "factId"));
        return readReceipt("fact-show", {
          ...read,
          fact: withNodeMaterializationState(read.fact, input.nodeTaskMaterializationPolicy),
        });
      }
      if (action.kind === "decision-list") {
        const read = decisions.list(decisionFilters(action), "summary");
        return readReceipt("decision-list", { ...read, decisions: read.decisions.map(decisionSummary) });
      }
      if (action.kind === "decision-show") {
        const read = decisions.show(requiredCommandText(action.decisionId, "decisionId"));
        return readReceipt("decision-show", {
          ...read,
          decision: {
            ...withNodeMaterializationState(read.decision, input.nodeTaskMaterializationPolicy),
            ...decisionReviewState(read.decision, input.readSettings().decisionReviewRequirement),
            body: action.includeBody === true ? read.decision.body : null,
          },
        });
      }
      if (action.kind === "decision-validate") {
        const rootDir = input.rootDir,
          layout = rootDir ? resolveHarnessLayout(rootDir) : null,
          validation = validateDecisionPackages(action, decisions, input.projection);
        return readReceipt("decision-validate", {
          ...validation,
          rows: rootDir
            ? validation.rows.map((row) => ({ ...row, path: documentWorkspacePath(rootDir!, row.path, layout!) }))
            : validation.rows,
        });
      }
      throw Object.assign(new Error(`Action ${action.kind} is declared as a read without a reader.`), {
        code: "invalid_store",
      });
    }
    if (action.kind === "decision-repin" && action.all === true) return repinAll(action, binding, opId);
    if (action.kind === "fact-archive" && (Array.isArray(action.factIds) || action.idsFile !== undefined))
      return archiveAllFacts(
        {
          rootDir: input.rootDir,
          store: input.store,
          projection: input.projection,
          now: input.now,
          killpoint: input.killpoint,
          readWorkspaceText: input.readWorkspaceText,
          authorize: () => decisionAuthorization(action, binding, opId, input),
          compile: (preloaded, memberOpId, occurredAt, allocatedRevision) =>
            compileAction(contract, preloaded, binding, memberOpId, occurredAt, allocatedRevision) as FactBundle,
        },
        action,
        opId,
      );
    const receipt = runWrite(contract, action, binding, opId, runtimes);
    if (receipt instanceof Promise) return receipt;
    reconcileDecisionReviewAwaitAfterWrite(action, binding, opId, input);
    retireDecisionAwaitsAfterWrite({
      action,
      binding,
      opId,
      authorizationDecision: binding.authorizationDecision ?? null,
      context: input,
    });
    return receipt;
  };

  const run = (
    action: CommandAction,
    binding: CommandBinding,
    opId: string,
    runtimes: EntityActionCatalogRuntimes = {},
  ): WriteReceipt | Promise<WriteReceipt> => {
    if (action.kind === "entity-import") {
      if (!input.artifactActions) reject("invalid_store", "Artifact entity runtime is required.");
      const authorizationDecision = decisionAuthorization(action, binding, opId, input);
      return input.artifactActions
        .importEntity({ action, binding, authorizationDecision })
        .then((result) => deriveActionResult(result.contract, result.action, result.receipt));
    }
    if (action.kind === "entity-update" || action.kind === "entity-archive" || action.kind === "entity-delete") {
      if (!input.artifactActions) reject("invalid_store", "Artifact entity runtime is required.");
      const authorizationDecision = decisionAuthorization(action, binding, opId, input),
        result = input.artifactActions.mutateEntity({ action, binding, authorizationDecision });
      return deriveActionResult(result.contract, result.action, result.receipt);
    }
    const contract = getExecutableEntityAction(action.kind);
    executableAction(contract, action.kind);
    if (contract.id === "delete" && contract.target.kind === "agent" && runtimes.localAgentStore) {
      const agentId = typeof action.agentId === "string" ? action.agentId : "";
      if (agentId && input.projection.getEntity("agent", agentId) === null && runtimes.localAgentStore.get(agentId)) {
        const localDeleted = executeAgentScopeDelete(
          {
            localStore: runtimes.localAgentStore,
            hasShared: false,
            appliedCutWatermark: () => input.projection.readCut().watermark,
          },
          {
            agentId,
            reason: typeof action.reason === "string" ? action.reason : "",
            expectedVersion: action.expectedVersion,
            opId,
            authorizationDecision: decisionAuthorization(action, binding, opId, input),
          },
        );
        if (localDeleted !== null) return deriveActionResult(contract, action, localDeleted);
      }
    }
    const prepare = runtimes.prepare?.[contract.target.kind],
      preparedAction = prepare?.(contract, action, binding, opId) ?? action;
    if (contract.id === "install" && contract.target.kind === "agent" && preparedAction.declaration) {
      const declaration = preparedAction.declaration as AgentDeclarationV1,
        scoped = runCatalogAgentScopeInstall({
          localStore: runtimes.localAgentStore,
          preparedAction,
          opId,
          authorizationDecision: decisionAuthorization(preparedAction, binding, opId, input),
          sharedRowValue: input.projection.getEntity("agent", declaration.id)?.value as
            | Readonly<Record<string, unknown>>
            | undefined,
          report: preparedEntityReport(preparedAction),
          warnings: preparedEntityWarnings(preparedAction),
          appliedCutWatermark: () => input.projection.readCut().watermark,
          compileDeclaration: (next) => {
            compileAction(contract, { ...preparedAction, declaration: next }, binding, opId, input.now());
          },
          installSharedAgent: ({ declaration: next, expectedVersion: centerVersion, opId: shareOpId }) =>
            runCompiled(
              { ...preparedAction, declaration: next, expectedVersion: centerVersion },
              binding,
              shareOpId,
              runtimes,
            ),
          ...(runtimes.authorizeAgentAction
            ? {
                authorizeSharedDelete: ({ agentId, reason, expectedVersion: delVersion, opId: delOpId }) =>
                  runtimes.authorizeAgentAction!(
                    { kind: "agent-delete", agentId, reason, expectedVersion: delVersion },
                    binding,
                    delOpId,
                  ),
              }
            : {}),
          prepareSharedDelete: (delAction, delOpId) =>
            runtimes.prepare?.agent?.(
              getExecutableEntityAction("agent-delete") as ExecutableAction,
              delAction,
              binding,
              delOpId,
            ) ?? delAction,
          runSharedDelete: (preparedDelete, delOpId, authorizationDecision) =>
            runCompiled(
              preparedDelete,
              authorizationDecision ? { ...binding, authorizationDecision } : binding,
              delOpId,
              runtimes,
            ),
        });
      if (scoped !== null)
        return scoped.then((receipt) =>
          receipt !== null
            ? deriveActionResult(contract, preparedAction, receipt)
            : runCompiled(preparedAction, binding, opId, runtimes),
        );
    }
    if (contract.execution.implementation === "catalog-runtime") {
      const runtime = contract.target.kind === "task" ? runtimes.task : runtimes.entity?.[contract.target.kind];
      if (!runtime)
        throw Object.assign(new Error(`Action ${action.kind} requires the ${contract.target.kind} catalog runtime.`), {
          code: "unsupported_command",
        });
      const result = runtime(contract, action, binding, opId);
      return result instanceof Promise
        ? result.then((receipt) => deriveActionResult(contract, action, receipt))
        : deriveActionResult(contract, action, result);
    }
    if (
      contract.execution.implementation !== "task-lifecycle" &&
      contract.execution.implementation !== "task-completion"
    )
      return runCompiled(preparedAction, binding, opId, runtimes);
    if (!runtimes.task)
      throw Object.assign(new Error(`Action ${action.kind} requires the Task Action runtime.`), {
        code: "unsupported_command",
      });
    return runtimes
      .task(contract, action, binding, opId)
      .then((receipt) => deriveActionResult(contract, action, receipt));
  };

  const repinAll = (action: CommandAction, binding: CommandBinding, opId: string): WriteReceipt => {
    const ids = decisions.list({}, "summary").decisions.map(({ decisionId }) => decisionId),
      initialRevision = input.store.readHead()?.revision ?? 0,
      existingOutcome = readAcceptedCommandOutcome(input.store, opId),
      authorizationDecision = decisionAuthorization(action, binding, opId, input),
      occurredAt = input.store.readEvent(opId)?.occurredAt ?? input.now(),
      pendingCut = input.projection.readCut(),
      base = {
        opId,
        revision: existingOutcome?.lastRevision ?? initialRevision,
        evidence: JSON.stringify({
          schema: "decision-repin-batch-report/v1",
          decisionIds: ids,
          migrationEvidence: action.migrationEvidence,
        }),
        visibility: "center" as const,
        proof: {
          committedRevision: existingOutcome?.lastRevision ?? initialRevision,
          appliedCut: pendingCut.watermark,
          durable: existingOutcome !== null,
          canonicalVisible:
            existingOutcome?.lastRevision != null && pendingCut.watermark >= existingOutcome.lastRevision,
          worktreeVisible: false,
        },
        authorizationDecision,
      };
    if (existingOutcome !== null) return { outcome: "applied", ...base };
    if (ids.length === 0) return { outcome: "no_changes", ...base };
    if (action.dryRun === true) return { outcome: "pending", ...base };
    const contract = getExecutableEntityAction(action.kind);
    executableAction(contract, action.kind);
    const bundles = ids.map((decisionId, index) => {
        const memberOpId =
          index === ids.length - 1
            ? opId
            : `${opId}-${createHash("sha256").update(decisionId).digest("hex").slice(0, 12)}`;
        return compileAction(
          contract,
          { ...action, all: false, decisionId },
          binding,
          memberOpId,
          occurredAt,
          initialRevision + index + 1,
        ) as DecisionBundle;
      }),
      terminal = bundles.at(-1)!;
    input.store.append({ ...terminal, preceding: bundles.slice(0, -1) });
    for (const bundle of bundles) input.projection.apply(bundle.event, bundle.plan);
    publicationKillpoints(input.killpoint);
    const outcome = readAcceptedCommandOutcome(input.store, opId),
      revision = outcome?.lastRevision ?? terminal.event.workspaceRevision,
      appliedCut = input.projection.readCut().watermark,
      canonicalVisible = appliedCut >= revision;
    return {
      outcome: canonicalVisible ? "applied" : "pending",
      ...base,
      revision,
      proof: {
        committedRevision: revision,
        appliedCut,
        durable: outcome !== null,
        canonicalVisible,
        worktreeVisible: false,
      },
    };
  };

  const runWrite = (
    contract: ExecutableAction,
    rawAction: CommandAction,
    binding: CommandBinding,
    opId: string,
    runtimes: EntityActionCatalogRuntimes,
  ): WriteReceipt | Promise<WriteReceipt> => {
    rawAction = input.resolveDecisionReviewAction ? input.resolveDecisionReviewAction(rawAction) : rawAction;
    const assignment = contract.id === "assign" || contract.id === "unassign";
    if (contract.id === "assign" && typeof rawAction.expiresAt !== "string" && contract.target.kind !== "relation") {
      const ttl = input.readSettings().tasks.assignmentTtlMs;
      rawAction = { ...rawAction, expiresAt: new Date(Date.parse(input.now()) + ttl).toISOString() } as CommandAction;
    }
    const authorizationDecision = decisionAuthorization(rawAction, binding, opId, input),
      action = (
        contract.id === "amend"
          ? (() => {
              const current = decisions.show(requiredCommandText(rawAction.decisionId, "decisionId")).decision,
                consent = decisionAmendmentConsent(rawAction, current, binding);
              return prepareDecisionAmend(
                { ...rawAction, ...(consent === undefined ? {} : { ownerConsent: consent }) },
                current,
              );
            })()
          : contract.id === "reclassify" || rawAction.kind === "fact-archive" || rawAction.kind === "fact-unarchive"
            ? factObservationPreload(input.projection, rawAction, requiredCommandText(rawAction.factId, "factId"))
            : rawAction
      ) as CommandAction,
      dryRun = action.dryRun === true,
      existing = dryRun || contract.target.kind === "runtime-session" ? null : input.store.readEvent(opId),
      requestedTime = typeof action.decidedAt === "string" ? action.decidedAt : undefined,
      occurredAt = existing?.occurredAt ?? requestedTime ?? input.now();
    if (contract.target.kind === "relation" && dryRun)
      reject("invalid_command", `${contract.execution.ingress} does not support --dry-run.`);
    if (assignment && contract.target.kind === "task") {
      const taskId = requiredCommandText(action.taskId, "taskId"),
        lease = input.projection.currentLease(taskId, occurredAt);
      if (lease && ["held", "reserving"].includes(lease.phase))
        reject(
          "lease_conflict",
          `Task ${taskId} cannot be assigned while execution ${lease.executionId} holds its lease.`,
        );
    }
    if (contract.target.kind === "relation" || assignment) {
      const relationReceipt = executeRelationAction({
        rootDir: input.rootDir ?? "",
        repositoryId: input.repositoryId ?? input.rootDir ?? "",
        contract,
        action: rawAction,
        binding,
        opId,
        occurredAt,
        authorizationDecision,
        store: input.store,
        projection: input.projection,
        sessionIdentity: input.sessionIdentity,
        ...(input.relationDirections ? { relationDirections: input.relationDirections } : {}),
        compileSupersededDecision: ({
          decisionId,
          opId: decisionOpId,
          occurredAt: decisionTime,
          workspaceRevision,
          relationBundle,
        }) => {
          const decisionContract = getExecutableEntityAction("decision-transition");
          executableAction(decisionContract, "decision-transition");
          const supersedeAction = {
            kind: "decision-transition",
            decisionId,
            targetState: "superseded",
            reason: `Superseded by ${String(rawAction.sourceRef)} through an active decision supersedes Relation.`,
          };
          return compileAction(
            decisionContract,
            supersedeAction,
            binding,
            decisionOpId,
            decisionTime,
            workspaceRevision,
            () => input.readSettings().decisionReviewRequirement,
            relationBundle ?? undefined,
          ) as DecisionBundle;
        },
        ...(input.killpoint ? { killpoint: input.killpoint } : {}),
      });
      return deriveActionResult(contract, rawAction, relationReceipt);
    }
    if (contract.target.kind === "decision" && !timestamp(occurredAt))
      reject("invalid_command", "decidedAt must be an ISO-8601 UTC timestamp ending in Z.");
    let reviewRequirement: RepositorySettingsV1["decisionReviewRequirement"] | undefined;
    const readReviewRequirement = () => (reviewRequirement ??= input.readSettings().decisionReviewRequirement);
    let bundle =
      matchingReplayBundle(input.store, contract, action, existing) ??
      compileAction(contract, action, binding, opId, occurredAt, undefined, readReviewRequirement);
    if (
      existing === null &&
      action.kind === "decision-review" &&
      isDecisionBundle(bundle) &&
      input.attachDecisionReviewerArtifact
    ) {
      bundle = input.attachDecisionReviewerArtifact(bundle, { action, binding });
    }
    if ("noChanges" in bundle) {
      if ("entityId" in bundle)
        return deriveActionResult(contract, action, {
          ...noChanges({
            opId,
            revision: bundle.priorVersion,
            headRevision: input.projection.readCut().watermark,
            evidence: JSON.stringify({
              schema: "agent-restore-no-changes/v1",
              entityId: bundle.entityId,
              action: contract.id,
              lifecycleState: "active",
            }),
            authorizationDecision,
            origin: `agent/${contract.id}`,
          }),
          effects: [],
        });
      return deriveActionResult(
        contract,
        action,
        noChanges({
          opId,
          revision: input.store.readHead()?.revision ?? 0,
          headRevision: input.projection.readCut().watermark,
          evidence: JSON.stringify({
            schema: "runtime-session-no-changes/v1",
            runtimeSessionId: bundle.runtimeSessionId,
            action: contract.id,
          }),
          authorizationDecision,
          origin: `runtime-session/${contract.id}`,
        }),
      );
    }
    if (isRuntimeSessionBundle(bundle)) {
      if (dryRun) reject("invalid_command", `${contract.execution.ingress} does not support --dry-run.`);
      if (bundle.event.type === "runtime_session_outcome_observed") {
        if (!runtimes.commitRuntimeSession) reject("invalid_store", "Runtime settlement requires the RepoCell writer.");
        return runtimes
          .commitRuntimeSession(bundle, { ...binding, authorizationDecision })
          .then((receipt) => deriveActionResult(contract, action, receipt));
      }
      return deriveActionResult(
        contract,
        action,
        commitRuntimeSessionBundle(input.store, input.projection, bundle, authorizationDecision, () => {
          publicationKillpoints(input.killpoint);
        }),
      );
    }
    if (isEntityBundle(bundle)) {
      if (dryRun) {
        if (isEntityUpsertBundle(bundle))
          return entityPreview(action, bundle, input.store.readHead()?.revision ?? 0, authorizationDecision);
        if (bundle.event.type === "agent_reactivated" && action.kind === "agent-install")
          return {
            outcome: "pending",
            opId: `preview:${createHash("sha256").update(bundle.event.opId).digest("hex")}`,
            revision: input.store.readHead()?.revision ?? 0,
            evidence: JSON.stringify({
              report: preparedEntityReport(action),
              event: bundle.event,
              dryRun: true,
            }),
            effects: [],
            updatedProjection: null,
            authorizationDecision,
          };
        reject("invalid_command", `${contract.execution.ingress} does not support --dry-run.`);
      }
      return deriveActionResult(
        contract,
        action,
        runEntityWrite(bundle, action, existing !== null, authorizationDecision),
      );
    }
    // Fact writes preview like their batch sibling (ha fact archive --ids-file) and like Decision
    // writes: the compiled event is named, nothing is appended, and the receipt stays pending.
    if (isFactBundle(bundle)) {
      if (dryRun) return factPreview(bundle.event, input.store.readHead()?.revision ?? 0, authorizationDecision);
      const result = facts.record(bundle);
      publicationKillpoints(input.killpoint);
      return factReceipt(result, bundle.event);
    }
    if (dryRun) {
      if (bundle.event.schema !== "decision-event/v1")
        reject("invalid_command", `${contract.execution.ingress} does not support --dry-run.`);
      input.projection.admitDecision(bundle.event);
      return { ...decisionPreview(bundle.event, input.store.readHead()?.revision ?? 0), authorizationDecision };
    }
    const result = decisions.record(bundle);
    publicationKillpoints(input.killpoint);
    return deriveActionResult(
      contract,
      action,
      decisionReceipt(
        result,
        bundle.event,
        authorizationDecision,
        Array.isArray(action.defaultedDecisionPacketFields)
          ? action.defaultedDecisionPacketFields.filter((field): field is string => typeof field === "string")
          : [],
        readReviewRequirement(),
      ),
    );
  };

  const runEntityWrite = (
    bundle: EntityCatalogBundle,
    action: CommandAction,
    replay: boolean,
    authorizationDecision: AuthorizationDecision,
  ): WriteReceipt => {
    const appended = input.store.append(bundle);
    if (!replay) {
      for (const preceding of "preceding" in bundle ? (bundle.preceding ?? []) : [])
        input.projection.apply(preceding.event, preceding.plan);
      input.projection.apply(bundle.event, bundle.plan);
    }
    publicationKillpoints(input.killpoint);
    const applied = input.projection.readOperation(bundle.event.opId),
      visible = !!applied && applied.watermark >= bundle.event.workspaceRevision,
      warnings = preparedEntityWarnings(action),
      hasPrecedingReactivation =
        "preceding" in bundle && (bundle.preceding ?? []).some(({ event }) => event.type === "agent_reactivated"),
      path =
        bundle.event.type === "entity_deleted"
          ? bundle.event.payload.ownedContent.retirements[0]!.path
          : bundle.event.type === "agent_retired" || bundle.event.type === "agent_reactivated"
            ? `agents/${bundle.event.payload.entityId}.json`
            : bundle.event.payload.declarationDocumentClaim.path,
      receipt = {
        opId: bundle.event.opId,
        revision: appended.revision,
        ...(hasPrecedingReactivation
          ? { effects: ["entity-event/agent_reactivated", "entity-event/entity_upserted"] }
          : bundle.event.type === "agent_reactivated"
            ? { effects: ["entity-event/agent_reactivated"] }
            : {}),
        evidence: JSON.stringify({
          report: preparedEntityReport(action),
          event: {
            schema: bundle.event.schema,
            eventId: bundle.event.eventId,
            opId: bundle.event.opId,
            path,
          },
          commitSha: appended.commitSha?.sha ?? null,
          cut: appended.cut,
        }),
        visibility: "center" as const,
        proof: {
          committedRevision: appended.revision,
          appliedCut: applied?.watermark ?? 0,
          durable: true,
          canonicalVisible: visible,
          worktreeVisible: true,
        },
        ...(bundle.event.type === "entity_deleted" ||
        bundle.event.type === "agent_retired" ||
        bundle.event.type === "agent_reactivated"
          ? {}
          : {
              detail: {
                kind: "entity_upsert" as const,
                entityKind: bundle.event.payload.entityKind,
                entityId: bundle.event.payload.entityId,
                schemaId: requireEntityStoreKindContract(bundle.event.payload.entityKind).schema.$id,
                path,
              },
            }),
        commitSha: appended.commitSha?.sha ?? null,
        cut: appended.cut,
        authorizationDecision,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    return visible
      ? { outcome: "applied", ...receipt }
      : {
          outcome: "pending",
          ...receipt,
        };
  };

  const compileAction = (
    contract: ExecutableAction,
    action: Readonly<Record<string, unknown>>,
    binding: CommandBinding,
    opId: string,
    occurredAt: string,
    allocatedRevision?: number,
    readDecisionReviewRequirement: () => RepositorySettingsV1["decisionReviewRequirement"] = () =>
      input.readSettings().decisionReviewRequirement,
    relationBundle?: CanonicalWriteBundle,
  ): CatalogBundle => {
    const compile = contract.execution.compile;
    if (!compile) reject("invalid_command", `${contract.execution.ingress} has no write compiler.`);
    const headRevision = input.store.readHead()?.revision ?? 0,
      workspaceRevision = allocatedRevision ?? headRevision + 1,
      coverage = contract.id === "reckon" ? decisionCoverage(action, decisions) : undefined,
      entityRow =
        contract.target.kind === "agent" || contract.target.kind === "squad"
          ? input.projection.getEntity(
              contract.target.kind,
              requiredCommandText(
                action[contract.execution.targetIdField ?? "entityId"],
                contract.execution.targetIdField ?? "entityId",
              ),
            )
          : undefined,
      currentEntity =
        contract.target.kind === "runtime-session"
          ? input.projection.readRuntimeSession(requiredCommandText(action.runtimeSessionId, "runtimeSessionId"))
          : entityRow?.value,
      entityRevision = entityRow
        ? typeof entityRow.currentVersion === "number"
          ? entityRow.currentVersion
          : entityRow.workspaceRevision
        : undefined,
      reactivateRetired =
        contract.target.kind === "agent" &&
        contract.id === "install" &&
        typeof action.reactivateRetired === "object" &&
        action.reactivateRetired !== null
          ? (action.reactivateRetired as { readonly priorVersion: number; readonly reason: string })
          : null;
    if (contract.target.kind === "agent" && contract.id === "install" && action.reactivateOnly === true) {
      const entityId = requiredCommandText(action.entityId ?? action.agentId, "agentId");
      if (reactivateRetired === null) {
        if (entityRevision === undefined) reject("agent_not_found", `${entityId} is not an installed agent.`);
        return { noChanges: true, entityId, priorVersion: entityRevision };
      }
      return compileAgentReactivated({
        eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
        opId,
        workspaceRevision,
        actor: binding.actor,
        source: binding.source,
        occurredAt,
        entityId,
        priorVersion: reactivateRetired.priorVersion,
        reactivatedAt: occurredAt,
        reason: reactivateRetired.reason,
      });
    }
    const targetRevision = reactivateRetired ? workspaceRevision + 1 : workspaceRevision,
      draft = compile({
        action,
        actor: binding.actor,
        source: binding.source,
        session: input.sessionIdentity(binding),
        opId,
        occurredAt,
        workspaceRevision: targetRevision,
        ...(currentEntity === undefined ? {} : { currentEntity }),
        ...(entityRevision === undefined ? {} : { entityRevision }),
        ...(coverage ? { coverage } : {}),
      });
    const compiled = compileDraft(
      input.projection,
      draft,
      {
        eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
        opId,
        workspaceRevision: targetRevision,
        actor: binding.actor,
        source: binding.source,
        occurredAt,
      },
      decisionApproval(action, binding),
      readDecisionReviewRequirement,
      relationBundle,
    );
    if (reactivateRetired && isEntityBundle(compiled) && isEntityUpsertBundle(compiled)) {
      const reactivatedOpId = `op_${createHash("sha256").update(`${opId}:reactivate`).digest("hex")}`,
        reactivatedBundle = compileAgentReactivated({
          eventId: `event-${createHash("sha256").update(reactivatedOpId).digest("hex")}`,
          opId: reactivatedOpId,
          workspaceRevision,
          actor: binding.actor,
          source: binding.source,
          occurredAt,
          entityId: compiled.event.payload.entityId,
          priorVersion: reactivateRetired.priorVersion,
          reactivatedAt: occurredAt,
          reason: reactivateRetired.reason,
        });
      return { ...compiled, preceding: [reactivatedBundle] };
    }
    return compiled;
  };

  return Object.freeze({ run });
}

function withNodeMaterializationState<T extends { readonly materializationState?: string }>(
  row: T,
  policy: NodeTaskMaterializationPolicy | undefined,
): T {
  if (policy !== "none" || row.materializationState === "dematerialized_terminal") return row;
  return { ...row, materializationState: "skipped_by_node_policy" } as T;
}

export function deriveActionResult(
  contract: EntityActionContract,
  action: CommandAction,
  receipt: WriteReceipt,
): WriteReceipt {
  const rejected = receipt.outcome === "op_rejected" || receipt.outcome === "indeterminate",
    targetIdField = contract.execution?.targetIdField ?? contract.execution?.lifecycle?.targetIdField ?? null,
    receiptFields = receipt as WriteReceipt & Readonly<Record<string, unknown>>,
    targetId =
      targetIdField && typeof action[targetIdField] === "string"
        ? action[targetIdField]
        : targetIdField && typeof receiptFields[targetIdField] === "string"
          ? receiptFields[targetIdField]
          : null,
    criterionRefs = receipt.unmetCriteria?.map(({ ref }) => ref) ?? [],
    unmetCriteria: readonly EntityActionUnmetCriterionV1[] =
      receipt.outcome === "op_rejected"
        ? criterionRefs.map((criterionRef) => resolveActionCriterion(contract, criterionRef))
        : [],
    // The guard's own reason names what is wrong; a criterion's explain only states what must hold.
    explanation = rejected
      ? (receipt.rejectionExplanation ??
        unmetCriteria[0]?.explain ??
        `Action ${contract.target.kind}.${contract.id} was rejected.`)
      : null;
  return {
    ...receipt,
    ...(!rejected && contract.returns.guidance.length > 0
      ? { guidance: actionReceiptGuidance(contract, { ...action, ...receiptFields }) }
      : {}),
    unmetCriteria,
    effects: rejected ? [] : (receipt.effects ?? contract.effects.map(({ ref }) => ref)),
    updatedProjection: Object.hasOwn(receipt, "updatedProjection")
      ? receipt.updatedProjection
      : rejected || !targetId
        ? null
        : {
            kind: contract.target.kind,
            ref: contract.target.refTemplate.replace("{id}", targetId),
            revision: receipt.revision ?? null,
          },
    rejectionExplanation: explanation,
    nextActions: Object.freeze([...(receipt.nextActions ?? [])]),
  };
}

function resolveActionCriterion(contract: EntityActionContract, criterionRef: string): EntityActionUnmetCriterionV1 {
  const criterion = contract.criteria.find(({ ref }) => ref === criterionRef);
  if (!criterion)
    throw Object.assign(
      new Error(`Action ${contract.target.kind}.${contract.id} does not declare criterion ${criterionRef}.`),
      { code: "invalid_store" },
    );
  return { ref: criterion.ref, failureCode: criterion.failureCode, explain: criterion.explain };
}

function executableAction(
  action: EntityActionContract | undefined,
  ingress: string,
): asserts action is ExecutableAction {
  if (!action?.execution)
    throw Object.assign(new Error(`Action ${ingress} is not declared in the entity action catalog.`), {
      code: "unsupported_command",
    });
}

function isFactBundle(bundle: CatalogBundle): bundle is FactBundle {
  return "event" in bundle && bundle.event.schema === "fact-event/v1";
}

function isDecisionBundle(bundle: CatalogBundle): bundle is DecisionBundle {
  return "event" in bundle && bundle.event.schema === "decision-event/v1";
}

function isEntityBundle(bundle: CatalogBundle): bundle is EntityCatalogBundle {
  return "event" in bundle && bundle.event.schema === "entity-event/v1";
}

function isEntityUpsertBundle(bundle: EntityCatalogBundle): bundle is EntityUpsertBundle {
  return bundle.event.type === "entity_upserted";
}

function compileDraft(
  projection: TaskProjection,
  draft: EntityActionDraft,
  event: Omit<Parameters<typeof compileEntityUpsert>[0], "entityKind" | "entity">,
  approval: Parameters<typeof compileDecisionWrite>[0]["approval"] | undefined,
  // Only Decision writes consult the review requirement; other entity writes must not depend on Settings.
  readDecisionReviewRequirement: () => RepositorySettingsV1["decisionReviewRequirement"],
  relationBundle?: CanonicalWriteBundle,
): CatalogBundle {
  if (draft.kind === "fact")
    return compileFactWrite({
      event: draft.event,
      supersededFact: supersededFactDocumentSource(projection, draft.event),
    });
  if (draft.kind === "fact-archive") return factArchiveBundle(projection, draft.event);
  if (draft.kind === "fact-unarchive") return factUnarchiveBundle(projection, draft.event);
  if (draft.kind === "entity")
    return compileEntityUpsert({ ...event, entityKind: draft.entityKind, entity: draft.entity });
  if (draft.kind === "entity-delete")
    return compileEntityDeleted({
      ...event,
      entityKind: draft.entityKind,
      entityId: draft.entityId,
      baseBlobSha256: draft.baseBlobSha256,
      reason: draft.reason,
    });
  if (draft.kind === "agent-retire")
    return compileAgentRetired({
      ...event,
      entityId: draft.entityId,
      priorVersion: draft.priorVersion,
      retiredAt: draft.retiredAt,
      reason: draft.reason,
      ...(draft.successor === undefined ? {} : { successor: draft.successor }),
    });
  if (draft.kind === "agent-restore")
    return draft.noChanges === true
      ? { noChanges: true, entityId: draft.entityId, priorVersion: draft.priorVersion }
      : compileAgentReactivated({
          ...event,
          entityId: draft.entityId,
          priorVersion: draft.priorVersion,
          reactivatedAt: draft.reactivatedAt,
          reason: draft.reason,
        });
  if (draft.kind === "runtime-session") {
    if (draft.noChanges && draft.event.type === "runtime_session_outcome_observed") {
      const lifecycle = projection.readDispatchLifecycle({
        by: "session",
        runtimeSessionId: draft.event.payload.runtimeSessionId,
      });
      if (
        lifecycle.status === "ready" &&
        lifecycle.rows[0] &&
        previewDispatchLifecycleOutcome(lifecycle.rows[0], draft.event).kind === "applied"
      )
        draft = { ...draft, noChanges: undefined };
    }
    if (draft.event.type === "runtime_session_exited") {
      const lifecycle = projection.readDispatchLifecycle({
        by: "session",
        runtimeSessionId: draft.event.payload.runtimeSessionId,
      });
      if (lifecycle.status === "ready" && lifecycle.rows.some(({ attempt }) => attempt.stopProof === "proven_stopped"))
        draft = { ...draft, noChanges: true };
    }
    return compileRuntimeSessionDraft(draft);
  }
  if (draft.kind === "schedule") reject("invalid_command", "Schedule drafts require the Schedule Action runtime.");
  if (draft.kind === "settings") reject("invalid_command", "Settings drafts require the Settings Action runtime.");
  if (draft.kind === "person") reject("invalid_command", "Person drafts require the Person Action runtime.");
  if (draft.kind === "relation")
    reject("invalid_command", "Relation drafts are committed directly through the Relation aggregate executor.");
  const read = projection.readDecision(draft.event.decisionId);
  if (read.watermark !== read.sourceRevision)
    reject("content_not_ready", `Decision ${draft.event.decisionId} is pending.`);
  const path = `decisions/decision-${draft.event.decisionId}/decision.md`,
    active = projection.readDocument(path),
    document = active.document ? active : (projection.readDocumentHistory?.(path) ?? active);
  if (document.watermark !== document.sourceRevision)
    reject("content_not_ready", `Decision document ${path} is pending.`);
  if (draft.event.type !== "decision_proposed" && !document.document)
    reject("content_not_ready", `Decision document ${path} is missing.`);
  let incomingRelations = projection
    .readDecisionIncomingRelations(draft.event.decisionId)
    .filter((edge) => {
      const target = parseEntityRef(edge.targetRef);
      return target?.kind === "decision" && target.id === draft.event.decisionId;
    })
    .map((edge) => ({
      relation_id: edge.relationId,
      source: edge.sourceRef,
      target: edge.targetRef,
      type: edge.relationType,
      strength: edge.strength,
      direction: edge.direction,
      origin: edge.origin,
      rationale: edge.rationale,
      state: edge.state,
    }));
  let currentDocument: DocumentState | null = document.document;
  if (relationBundle && isRelationEvent(relationBundle.event)) {
    const path = `decisions/decision-${draft.event.decisionId}/decision.md`,
      claim = relationBundle.event.payload.documentClaims?.find((entry) => entry.path === path),
      bodyBlob = claim ? relationBundle.blobs.find((blob) => blob.sha256 === claim.sha256) : undefined;
    if (claim && bodyBlob && currentDocument) {
      currentDocument = {
        ...currentDocument,
        blobSha256: claim.sha256,
        size: docByteLength(claim.size),
        body: typeof bodyBlob.body === "string" ? bodyBlob.body : Buffer.from(bodyBlob.body).toString("utf8"),
      };
    }
    if (relationBundle.event.type === "relation_created") {
      const relation = relationBundle.event.payload.relation,
        target = parseEntityRef(relation.target);
      if (target?.kind === "decision" && target.id === draft.event.decisionId) {
        incomingRelations = [
          ...incomingRelations.filter(({ relation_id }) => relation_id !== relation.relation_id),
          {
            relation_id: relation.relation_id,
            source: relation.source,
            target: relation.target,
            type: relation.type,
            strength: relationStrengthForType(relation.type),
            direction: relation.direction,
            origin: relation.origin,
            rationale: relation.rationale,
            state: relation.state,
          },
        ];
      }
    }
  }
  return compileDecisionWrite({
    event: draft.event,
    ...(approval ? { approval } : {}),
    currentDecision: read.decision,
    currentRelations: read.decision?.relations ?? [],
    currentIncomingRelations: incomingRelations,
    resolveLink: decisionRelationLinkResolver(projection),
    currentDocument,
    decisionReviewRequirement: readDecisionReviewRequirement(),
  });
}

function decisionCoverage(action: Readonly<Record<string, unknown>>, service: ReturnType<typeof makeDecisionService>) {
  const decisionId = requiredCommandText(action.decisionId, "decisionId"),
    taskId = requiredCommandText(action.taskId, "taskId");
  service.show(decisionId);
  const coverage = service.coverage(decisionId);
  return { decisionId, taskId, basisRevision: coverage.watermark, rows: coverage.coverageRows };
}

function decisionAuthorization(
  action: CommandAction,
  binding: CommandBinding,
  opId: string,
  input: {
    readonly store: CanonicalEventStore;
    readonly projection: TaskProjection;
    readonly now: () => string;
    readonly readSettings: () => RepositorySettingsV1;
  },
): AuthorizationDecision {
  const authorizationDecision = binding.authorizationDecision;
  if (!authorizationDecision || authorizationDecision.outcome !== "allowed")
    reject("actor_unauthorized", "Catalog execution requires the center AuthorizationPort decision.");
  const judgment = ["decision-accept", "decision-reject", "decision-defer"].includes(action.kind);
  if (!judgment && !["decision-review", "decision-respond-review", "decision-override-review"].includes(action.kind))
    return authorizationDecision;
  const decisionId = requiredCommandText(action.decisionId, "decisionId"),
    decision = input.projection.readDecision(decisionId).decision,
    proposalActor = decision?.proposer ?? null;
  if (action.kind === "decision-review") {
    assertDecisionReviewerIndependent(decision, binding.actor, input.readSettings().reviewIndependence);
    return authorizationDecision;
  }
  if (action.kind === "decision-respond-review") {
    if (proposalActor === null || !isSamePerson(proposalActor, binding.actor))
      reject("actor_unauthorized", "Decision review responses must be recorded by the proposal owner principal.");
    return authorizationDecision;
  }
  if (!judgment && action.kind !== "decision-override-review") return authorizationDecision;
  const approval = decisionApproval(action, binding),
    directHuman = binding.actor.executor === null;
  if (action.kind === "decision-reject" || action.kind === "decision-override-review") {
    if (!directHuman && !approval)
      reject(
        "actor_unauthorized",
        action.kind === "decision-reject"
          ? "Decision rejection requires explicit human approval."
          : "Decision review override requires explicit human approval.",
      );
    return authorizationDecision;
  }
  if (proposalActor === null || (!directHuman && !approval))
    reject(
      "actor_unauthorized",
      `Decision ${action.kind === "decision-accept" ? "acceptance" : "deferral"} requires explicit human approval.`,
    );
  return authorizationDecision;
}

function requiredCommandText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  reject("invalid_command", `${field} is required.`);
}
