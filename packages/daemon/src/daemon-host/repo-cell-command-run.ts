import { enqueueRuntimePublication } from "./runtime-publication-queue.ts";
import { continueSubmittedTask } from "./repo-cell-submit.ts";
import { continueReviewRework } from "./task-return-dispatch.ts";
import { runCompletionSources } from "./task-witness-runner.ts";
import { requireSquadBusinessAction } from "./squad-runtime-ingress.ts";
import { executionDelegationPath, readExecutionDelegations } from "./execution-delegation-store.ts";
import {
  assertCurrentWriter,
  stableStringify,
  durableActionKinds,
  getExecutableEntityAction,
  isArtifactActionIngressKind,
  parseEntityRef,
  normalizeCommandEnvelope,
  type AuthorizationDecision,
  type EntityActionUnmetCriterionV1,
  type WriteReceipt,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { RepoCellApiContext } from "./repo-cell-types.ts";
import {
  evaluateRepoCellAction,
  bindVerifiedExecutorClaim,
  withAuthorizationDecision,
} from "./repo-cell-authorization.ts";
import { cellErrorCode, cellErrorMessage } from "./repo-cell-errors.ts";
import { explainEdgeTaskConsentScopeMismatch } from "./repo-cell-task-consent-errors.ts";
import type {
  RepoCellBinding,
  RepoCellContinuationWrite,
  RepoCellQueueObservation,
  RepoTaskAction,
} from "./repo-cell-types.ts";
import { chainRepoCellWrite } from "./repo-cell.ts";
import { compiledArtifactKinds, findArtifactKindContract } from "./artifact-entity-action.ts";
import { admitRepoMode, builtinOccurrenceCommandTopology, entityActionCommandTopology } from "./repo-mode.ts";
import { commandDescriptorForAction } from "./protocol/daemon-protocol.contract.ts";
import { recoveryCommandPolicy } from "./recovery-state.ts";
import {
  executeSquadControl,
  isSquadControlCommand,
  squadControlRejected,
  type SquadControlResult,
} from "./squad-control-result.ts";
import { deriveActionResult } from "@harness-anything/application/internal/commands/entity-action-catalog-executor.ts";
import { executeVerticalScriptAction, publishExecutedVerticalScript } from "./vertical-script-actions.ts";
import { readBeforeWriteQueue, readsAuthoredWorktree } from "./write-queue-external-reads.ts";
import { discoverDocCandidateGitPaths } from "./doc-sync-candidate-scanner.ts";
import { inspectScheduleProjection } from "@harness-anything/application/internal/queries/schedule-projection.ts";
import { resolveDecisionReviewAction } from "./repo-cell-action-parse.ts";
import { candidateSample, resolveUniquePrefix } from "./unique-id-prefix.ts";
import { canRecoverEdgeReviewerDispatch } from "./dispatch-read.ts";
import {
  executionCredentialRejected,
  readRuntimeExecutionPrincipal,
  runtimeExecutionActor,
} from "./runtime-execution-credential.ts";
import { requireCurrentExecutionScope } from "./runtime-execution-scope.ts";
import { dispatchTaskReview, prepareTaskReviewDispatch } from "./task-review-dispatch.ts";
import { settleAuthoredMaterialization } from "./repo-cell-materialization.ts";

const taskWritesWithProjectionSpecificNotFound = new Set(["task-annotate", "task-attest", "task-declare-executor"]);

function targetsBuiltinSchedule(context: RepoCellApiContext, action: RepoTaskAction): boolean {
  if (context.state !== "attached" || getExecutableEntityAction(action.kind)?.target.kind !== "schedule") return false;
  const row =
      typeof action.scheduleId === "string" ? context.projection.getEntity("schedule", action.scheduleId) : null,
    inspected = row ? inspectScheduleProjection(row) : null;
  return inspected?.valid === true && inspected.schedule.spec.target.kind === "builtin";
}

function failAction(
  context: RepoCellApiContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  error: unknown,
  authorizationDecision?: AuthorizationDecision,
): WriteReceipt {
  if (context.fatalCellError(error)) context.latchWith(error);
  const contract = getExecutableEntityAction(action.kind),
    receipt = context.failed(
      context.errorOperationId(error) ?? context.operationId(action, binding, context.input.repoId, 0),
      error,
      contract,
      contract ? action : undefined,
    );
  const result = contract ? deriveActionResult(contract, action, receipt) : receipt,
    explained = explainEdgeTaskConsentScopeMismatch(result, action, binding.source, cellErrorMessage(error));
  if (!authorizationDecision) return explained as WriteReceipt;
  return withAuthorizationDecision(
    explained,
    authorizationDecision,
    explained.unmetCriteria ?? [],
    explained.rejectionExplanation ?? (error instanceof Error ? error.message : String(error)),
  );
}

// Task write actions address an existing task, so a unique prefix gets the read faces' git-style
// resolution at runner ingress — before executor-claim binding and opId derivation. Missing and
// ambiguous ids stay unresolved until authorization succeeds, so rejected callers cannot use
// lookup errors to learn whether a task id exists. `task-create` is excluded: its taskId names
// the task to create. Shared EntityRef pin ingress is excluded because its canonical catalog
// representative is Task, while its reference may address any registered entity kind.
// A lagging cut stays the action's own pending case.
function resolveTaskWriteTarget(
  context: RepoCellApiContext,
  action: RepoTaskAction,
  options: { deferInvalidTarget?: boolean } = {},
): { action: RepoTaskAction; resolved: boolean } {
  const contract = getExecutableEntityAction(action.kind);
  if (
    action.kind === "task-create" ||
    action.kind === "entity-pin" ||
    action.kind === "entity-unpin" ||
    contract?.target.kind !== "task" ||
    !contract.execution
  )
    return { action, resolved: true };
  const field = contract.execution.targetIdField ?? "taskId",
    requested = action[field];
  if (typeof requested !== "string" || requested === "") return { action, resolved: true };
  const read =
    action.kind === "task-contract-migrate"
      ? context.projection.readForTaskContractMigration(requested)
      : context.projection.read(requested);
  if (read.snapshot.task) return { action, resolved: true };
  if (read.watermark < read.sourceRevision) return { action, resolved: false };
  const prefixed = resolveUniquePrefix(
    requested,
    action.kind === "task-contract-migrate"
      ? context.projection.readTaskIdsForTaskContractMigration()
      : context.projection.readTaskIndex().rows.map(({ taskId }) => taskId),
  );
  if (prefixed.matched) return { action: { ...action, [field]: prefixed.id } as RepoTaskAction, resolved: true };
  if (options.deferInvalidTarget) return { action, resolved: false };
  if (prefixed.candidates.length > 1)
    throw context.cellCodedError(
      "task_ambiguous_id",
      `Task id ${requested} is a prefix of ${String(prefixed.candidates.length)} task ids ` +
        `(${candidateSample(prefixed.candidates)}). Use a longer prefix or the full id.`,
    );
  if (taskWritesWithProjectionSpecificNotFound.has(action.kind)) return { action, resolved: false };
  throw context.cellCodedError("entity_not_found", `Task ${requested} does not exist.`);
}

/** The RepoCell command pipeline: recovery admission, the executor claim, and the queued
 * publication interval that authorizes, executes, and settles one command at the writer cut. */
export function makeRepoCellCommandRunner(
  context: RepoCellApiContext,
): (
  action: RepoTaskAction,
  binding: RepoCellBinding,
  signal?: AbortSignal,
  onExecutionStart?: () => void,
  queueObservation?: RepoCellQueueObservation,
) => Promise<WriteReceipt | SquadControlResult> {
  let settlingRecovery: string | null = null;
  const run = async (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    signal?: AbortSignal,
    resolveTargetAfterAuthorization = false,
    executionStarted?: () => void,
    queueObservation?: RepoCellQueueObservation,
    continueReturn = true,
  ): Promise<WriteReceipt | SquadControlResult> => {
    if (context.state !== "attached")
      await context.attemptRecovery(recoveryCommandPolicy(action.kind, context.causeClass)?.settlesLatch === true);
    if (action.kind === "task-review-execution")
      binding = await bindCurrentPersonIdentityWitnesses(
        action,
        binding,
        context.projection,
        context.rootDir,
        context.input.repoId,
        context.now(),
      );
    const artifactKindResolver = (kind: string): string | null =>
      findArtifactKindContract(kind, compiledArtifactKinds(context.projection, context.input.repoId))?.typeIdentity ??
      null;
    if (isArtifactActionIngressKind(action.kind)) binding = { ...binding, artifactKindResolver };
    const requested = { action, binding },
      durable = (durableActionKinds as readonly string[]).includes(action.kind),
      // A durable executor claim is verified in the publication turn that authorizes and executes it.
      claimAtPublication = durable && (action.executor != null || binding.executionPrincipal !== undefined),
      bindExecutorClaim = async (): Promise<WriteReceipt | null> => {
        try {
          ({ action, binding } = bindVerifiedExecutorClaim({
            ...requested,
            executionDelegations: context.input.runtimeDaemonRoute
              ? readExecutionDelegations(
                  executionDelegationPath(context.input.runtimeDaemonRoute, context.input.repoId),
                  context.input.repoId,
                ).records.filter((record) => {
                  const issue = context.store.readEvent(record.issuedByOperationId);
                  return (
                    issue?.schema === "execution-delegation-event/v1" &&
                    issue.payload.operation === "issue" &&
                    issue.payload.tokenId === record.token.tokenId &&
                    issue.actor.principal.personId === record.token.issuer.personId &&
                    stableStringify(issue.source) === stableStringify(record.source)
                  );
                })
              : [],
            projection: context.projection,
            now: context.now(),
          }));
          return null;
        } catch (error) {
          const revision = context.store.readHead()?.revision ?? 0,
            actionId = context.operationId(requested.action, requested.binding, context.input.repoId, revision),
            decision = await evaluateRepoCellAction({
              ...requested,
              actionId,
              repoId: context.input.repoId,
              revision,
              now: context.now(),
              readTask: (taskId) => context.projection.read(taskId).snapshot.task,
              binding: { ...requested.binding, artifactKindResolver },
            });
          const failure = context.failed(actionId, error);
          return withAuthorizationDecision(
            failure,
            decision,
            [],
            failure.rejectionExplanation ?? (error instanceof Error ? error.message : String(error)),
          );
        }
      };
    if (claimAtPublication) {
      const { executor: _claim, ...unclaimed } = action;
      action = unclaimed as RepoTaskAction;
    } else if (action.executor != null || binding.executionPrincipal !== undefined) {
      const claimRejected = await bindExecutorClaim();
      if (claimRejected) return claimRejected;
    }
    const command = builtinOccurrenceCommandTopology(
        entityActionCommandTopology(commandDescriptorForAction(action.kind), action),
        targetsBuiltinSchedule(context, action),
      ),
      authorizeAtCurrentCut = (): Promise<AuthorizationDecision> | null => {
        const revision = context.store.readHead()?.revision ?? 0,
          actionId = context.operationId(action, binding, context.input.repoId, revision);
        return evaluateRepoCellAction({
          action,
          binding,
          actionId,
          repoId: context.input.repoId,
          revision,
          now: context.now(),
          readTask: (taskId) => context.projection.read(taskId).snapshot.task,
        }).then(async (decision) => {
          if (decision.outcome === "allowed" && action.kind !== "task-review-execution")
            binding = await bindCurrentPersonIdentityWitnesses(
              action,
              binding,
              context.projection,
              context.rootDir,
              context.input.repoId,
              context.now(),
            );
          return decision;
        });
      },
      frameCurrent = async (
        receipt: WriteReceiptDraft,
        criteria: readonly EntityActionUnmetCriterionV1[] = [],
        explanation?: string,
      ): Promise<WriteReceipt> =>
        durable
          ? withAuthorizationDecision(receipt, await authorizeAtCurrentCut()!, criteria, explanation)
          : (receipt as WriteReceipt);
    const recoveryCommand =
        context.state === "attached" ? null : recoveryCommandPolicy(action.kind, context.causeClass),
      recoveryCommandAllowed =
        recoveryCommand !== null && (recoveryCommand.settlesLatch || action.kind === "receipt-show");
    if (context.state !== "attached" && !recoveryCommandAllowed)
      return Promise.resolve(
        frameCurrent(
          context.rejected(context.operationId(action, binding, context.input.repoId, 0), "repo_unavailable"),
          [],
          context.latched(),
        ),
      );
    const claimsRecovery = context.state !== "attached" && recoveryCommand?.settlesLatch === true;
    if (claimsRecovery && settlingRecovery !== null) {
      return Promise.resolve(
        frameCurrent(
          context.rejected(context.operationId(action, binding, context.input.repoId, 0), "recovery_conflict"),
        ),
      );
    }
    if (claimsRecovery) settlingRecovery = action.kind;
    if (command.commandClass === "repo-read")
      return Promise.resolve()
        .then(async () => {
          executionStarted?.();
          const admission = admitRepoMode(context.mode, command, binding.source);
          if (!admission.ok) throw context.cellCodedError(admission.code, admission.nextAction);
          if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
          return context.withHumanSummary(await context.executeAction(action, binding));
        })
        .then((receipt) => receipt as WriteReceipt)
        .catch((error) => failAction(context, action, binding, error));
    const appendCompletionWarnings = async <T extends WriteReceiptDraft | WriteReceipt | SquadControlResult>(
      receipt: T,
      authorizedBinding: RepoCellBinding,
    ): Promise<T> => {
      if (
        (action.kind === "task-submit" || action.kind === "task-settle" || action.kind === "task-witness-rerun") &&
        typeof action.taskId === "string" &&
        !isSquadControlCommand(action.kind) &&
        "opId" in receipt &&
        (receipt.outcome === "applied" ||
          (receipt.outcome === "pending" && (receipt as WriteReceipt).status === "accepted_durable"))
      ) {
        const warnings = await runCompletionSources(
          context,
          action.taskId as string,
          authorizedBinding,
          action.kind === "task-witness-rerun" ? `gate-${receipt.opId}` : undefined,
        );
        if (warnings.length)
          return {
            ...receipt,
            warnings: [...((receipt as WriteReceipt).warnings ?? []), ...warnings],
          };
      }
      return receipt;
    };
    const enqueuePublication = (
      execute: (authorizationDecision?: AuthorizationDecision) => WriteReceiptDraft | Promise<WriteReceiptDraft>,
      ingest?: (authorizationDecision?: AuthorizationDecision) => void,
      continueOnApplied = continueReturn,
    ): Promise<WriteReceipt | SquadControlResult> => {
      context.queueDepth += 1;
      let queuedDecision: AuthorizationDecision | undefined,
        replaceAfterPublication = false;
      const recordRejection = (receipt: WriteReceipt): WriteReceipt => {
        if (receipt.outcome !== "op_rejected") return receipt;
        const rejectionCode = receipt.code ?? "operation_rejected",
          envelope = normalizeCommandEnvelope({
            workspaceId: context.input.repoId,
            actor: binding.actor,
            source: binding.source,
            expectedRevision: context.store.readHead()?.revision ?? 0,
            command: { type: "CommandRejection", action, rejectionCode },
          });
        if (!context.store.appendRejection) throw new Error("canonical event store cannot persist rejected commands");
        // A contextual rejection is its own outcome, not the id of a future accepted execution.
        context.store.appendRejection({
          opId: envelope.opId,
          intentDigest: envelope.commandDigest,
          summary: action.kind,
          rejectionCode,
        });
        return { ...receipt, opId: envelope.opId };
      };
      const pending = chainRepoCellWrite(
        context.tail,
        async () => {
          executionStarted?.();
          const claimRejected = claimAtPublication ? await bindExecutorClaim() : null;
          if (claimRejected) return claimRejected;
          if (durable) {
            queuedDecision = await authorizeAtCurrentCut()!;
            if (queuedDecision.outcome === "denied")
              return withAuthorizationDecision(
                context.rejected(
                  context.operationId(action, binding, context.input.repoId, context.store.readHead()?.revision ?? 0),
                  queuedDecision.reasonCodes.includes("entity_kind_not_found")
                    ? "entity_kind_not_found"
                    : "authorization_denied",
                ),
                queuedDecision,
                [],
                `Policy ${queuedDecision.policyRef} denied ${action.kind}: ${queuedDecision.reasonCodes.join(", ")}.`,
              );
          }
          const queuedAdmission = admitRepoMode(context.mode, command, binding.source);
          if (!queuedAdmission.ok) throw context.cellCodedError(queuedAdmission.code, queuedAdmission.nextAction);
          if (context.state === "closed" || (context.state !== "attached" && !recoveryCommandAllowed))
            throw context.cellCodedError(
              "repo_unavailable",
              "RepoCell closed or changed state before this queued command could execute.",
            );
          assertCurrentWriter(context.activeWriter, context.writerToken, context.input.repoId);
          context.activeWriterEpochFence = binding.withWriterEpochFence ?? null;
          context.activeWriterEpochFenceDescriptor = binding.writerEpochFence ?? null;
          if (resolveTargetAfterAuthorization) {
            try {
              action = resolveTaskWriteTarget(context, action).action;
            } catch (error) {
              // A target lookup rejection is still a durable queued outcome: record it and wake
              // replicas through the same path as action-level no-event rejections.
              const receipt = recordRejection(failAction(context, action, binding, error, queuedDecision));
              context.replica.kick();
              return receipt;
            }
          }
          requireSquadBusinessAction(context.projection, action, binding);
          // Ingested reads are their own accepted commands, recorded before the execution interval
          // opens: a failed execution must never adopt one of them as its accepted outcome.
          ingest?.(queuedDecision);
          try {
            if (isSquadControlCommand(action.kind)) {
              const controlled = await executeSquadControl(
                context.extracted,
                action,
                queuedDecision ? { ...binding, authorizationDecision: queuedDecision } : binding,
              );
              context.replica.kick();
              return controlled;
            }
            const executed = context.withHumanSummary(await execute(queuedDecision)),
              explained = explainEdgeTaskConsentScopeMismatch(executed, action, binding.source),
              receipt = recordRejection(
                queuedDecision ? withAuthorizationDecision(explained, queuedDecision) : (explained as WriteReceipt),
              );
            if (recoveryCommand?.settlesLatch && receipt.outcome === "applied") {
              if (action.kind === "migrate-import" && action.dryRun !== true) {
                context.recoveryProbe.clear();
                replaceAfterPublication = true;
              } else {
                context.state = "attached";
                context.lastError = null;
                context.causeClass = null;
                context.recoveryUncertain = false;
                context.recoveryProbe.clear();
              }
            }
            context.replica.kick();
            return receipt;
          } catch (error) {
            if (isSquadControlCommand(action.kind))
              return squadControlRejected(action.kind, failAction(context, action, binding, error, queuedDecision));
            // A coded rejection is this command's own determinate verdict, even after an earlier step
            // (one of several ingested runs, a facade's witness) was accepted as its own command.
            const code = cellErrorCode(error);
            if (code === "publication_indeterminate" || (code !== "service_rejected" && context.fatalCellError(error)))
              throw error;
            if (
              code === "service_rejected" &&
              !(typeof error === "object" && error !== null && "code" in error && typeof error.code === "string")
            )
              throw error;
            return recordRejection(failAction(context, action, binding, error, queuedDecision));
          } finally {
            context.activeWriterEpochFence = null;
            context.activeWriterEpochFenceDescriptor = null;
          }
        },
        {
          queue: context.writeQueue,
          onDequeued: () => {
            context.queueDepth -= 1;
          },
          label: queueObservation?.label ?? { command: action.kind, requestId: null },
          ...(queueObservation ? { observation: queueObservation } : {}),
        },
      );
      context.tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending
        .catch((error) => failAction(context, action, binding, error, queuedDecision))
        .then(async (receipt) => {
          const continueWrite: RepoCellContinuationWrite = async (nextAction, nextBinding, work) =>
            (work
              ? await enqueueRuntimePublication(
                  context,
                  "runtime-run",
                  nextAction,
                  nextBinding,
                  work as unknown as (
                    authorized: RepoCellBinding,
                  ) => Promise<import("./protocol/json-rpc-types.ts").JsonObject>,
                )
              : await enqueueCommand(
                  nextAction,
                  nextBinding,
                  undefined,
                  false,
                  undefined,
                  undefined,
                  false,
                )) as WriteReceiptDraft;
          if (
            continueOnApplied &&
            "outcome" in receipt &&
            receipt.outcome === "applied" &&
            ["task-review-execution", "task-rework"].includes(action.kind)
          ) {
            const event = context.store.readTaskEvent(receipt.opId);
            if (event)
              return (await continueReviewRework(
                context.extracted,
                event,
                binding,
                receipt,
                continueWrite,
                action.kind === "task-rework"
                  ? {
                      ...(typeof action.agentId === "string" ? { agentId: action.agentId } : {}),
                      ...(typeof action.runtimeInstanceId === "string"
                        ? { runtimeInstanceId: action.runtimeInstanceId }
                        : {}),
                      ...(typeof action.model === "string" ? { model: action.model } : {}),
                    }
                  : undefined,
              )) as WriteReceipt;
          }
          if (continueOnApplied && (action.kind === "task-submit" || action.kind === "task-settle")) {
            const submitted =
              "outcome" in receipt && receipt.outcome === "applied"
                ? ((await continueSubmittedTask(
                    context.extracted,
                    action,
                    binding,
                    receipt,
                    continueWrite,
                  )) as WriteReceipt)
                : receipt;
            return await appendCompletionWarnings(
              submitted,
              queuedDecision ? { ...binding, authorizationDecision: queuedDecision } : binding,
            );
          }
          if (!replaceAfterPublication) return receipt;
          await context.attemptRecovery(true);
          return context.state === "attached"
            ? receipt
            : ({
                ...receipt,
                outcome: "pending",
                code: "repo_unavailable",
              } as WriteReceipt);
        })
        .finally(() => {
          if (claimsRecovery) settlingRecovery = null;
        });
    };
    if (action.kind === "script-run")
      // The script reads the published commit, so it waits for every accepted write to be published first.
      return Promise.resolve(settleAuthoredMaterialization(context.store, "run vertical script"))
        .then(() =>
          executeVerticalScriptAction({
            action,
            rootDir: context.rootDir,
            verticalId: context.settings.readRepository().defaultVertical,
            commitSha: requiredPublishedGitCommit(context.store.currentCommit()),
            signal,
          }),
        )
        .then(
          (execution) =>
            enqueuePublication((authorizationDecision) =>
              publishExecutedVerticalScript(
                {
                  binding: authorizationDecision ? { ...binding, authorizationDecision } : binding,
                  workspaceId: context.input.repoId,
                  rootDir: context.rootDir,
                  store: context.store,
                  projection: context.projection,
                  now: context.now,
                  killpoint: context.input.killpoint,
                },
                execution,
              ),
            ),
          async (error) =>
            failAction(context, action, binding, error, durable ? await authorizeAtCurrentCut()! : undefined),
        );
    if (action.kind === "task-dispatch-review") {
      const admission = admitRepoMode(context.mode, command, binding.source);
      if (!admission.ok)
        return frameCurrent(
          context.rejected(context.operationId(action, binding, context.input.repoId, 0), admission.code),
          [],
          admission.nextAction,
        );
      const claimRejected = claimAtPublication ? await bindExecutorClaim() : null;
      if (claimRejected) return claimRejected;
      const decision = await authorizeAtCurrentCut()!;
      if (decision.outcome === "denied")
        return withAuthorizationDecision(
          context.rejected(context.operationId(action, binding, context.input.repoId, 0), "authorization_denied"),
          decision,
        );
      return prepareTaskReviewDispatch(context.extracted, action, binding).then(
        (prepared) =>
          enqueuePublication((authorizationDecision) =>
            dispatchTaskReview(context.extracted, action, { ...binding, authorizationDecision }, prepared),
          ),
        (error: unknown) => failAction(context, action, binding, error, decision),
      );
    }
    // Submission preparation reads with the verified actor too; publication rechecks the claim.
    if ((action.kind === "task-submit" || action.kind === "task-settle") && claimAtPublication) {
      const claimRejected = await bindExecutorClaim();
      if (claimRejected)
        return enqueuePublication((authorizationDecision) =>
          context.executeAction(action, { ...binding, authorizationDecision }),
        );
    }
    if (
      (action.kind === "task-submit" || action.kind === "task-settle") &&
      (await authorizeAtCurrentCut()!).outcome !== "allowed"
    )
      return enqueuePublication((authorizationDecision) =>
        context.executeAction(action, { ...binding, authorizationDecision }),
      );
    const externalRead: ReturnType<typeof readBeforeWriteQueue> =
      (action.kind === "task-complete" || action.kind === "task-witness-run") && typeof action.taskId === "string"
        ? authorizeAtCurrentCut()!.then(async (authorization) => {
            if (action.kind === "task-witness-run" && authorization.outcome === "allowed")
              requireCurrentExecutionScope({ action, binding, projection: context.projection, now: context.now() });
            const warnings =
              authorization.outcome === "allowed" && context.projection.read(action.taskId as string).snapshot.task
                ? await runCompletionSources(
                    context,
                    action.taskId as string,
                    binding,
                    undefined,
                    action.kind === "task-witness-run"
                      ? {
                          taskId: action.taskId as string,
                          executionId: String(action.executionId),
                          gateId: String(action.gateId),
                        }
                      : undefined,
                  )
                : [];
            return async (nextAction, nextBinding) => {
              const receipt = await context.executeAction(nextAction, nextBinding);
              return warnings.length ? { ...receipt, warnings: [...(receipt.warnings ?? []), ...warnings] } : receipt;
            };
          })
        : action.kind === "task-submit" || action.kind === "task-settle"
          ? readBeforeWriteQueue(
              context,
              action,
              binding,
              async (execute) => (await enqueuePublication(execute, undefined, false)) as WriteReceiptDraft,
            )
          : readBeforeWriteQueue(context, action, binding);
    if (externalRead)
      return externalRead
        .then((publish) =>
          enqueuePublication(
            (authorizationDecision) =>
              publish(action, authorizationDecision ? { ...binding, authorizationDecision } : binding),
            publish.ingest &&
              ((authorizationDecision) =>
                publish.ingest!(authorizationDecision ? { ...binding, authorizationDecision } : binding)),
          ),
        )
        .catch(async (error) =>
          failAction(context, action, binding, error, durable ? await authorizeAtCurrentCut()! : undefined),
        );
    if (action.kind === "task-witness-rerun" && typeof action.taskId === "string") {
      const receipt = await enqueuePublication((authorizationDecision) =>
        context.executeAction(action, authorizationDecision ? { ...binding, authorizationDecision } : binding),
      );
      const rerunDecision = await authorizeAtCurrentCut()!;
      if (rerunDecision.outcome !== "allowed") return receipt;
      return await appendCompletionWarnings(receipt, { ...binding, authorizationDecision: rerunDecision });
    }
    const needsWorktree = readsAuthoredWorktree(action, binding.source, context.projection);
    const runAfterWorktreeReady = async () => {
      const pending = needsWorktree ? settleAuthoredMaterialization(context.store, action.kind) : null,
        failedSettlement = pending
          ? await pending.then(
              () => null,
              (error: unknown) => ({ error }),
            )
          : null;
      const preparation =
        failedSettlement ??
        (() => {
          if (
            action.kind !== "doc-submit" ||
            binding.source !== "local" ||
            (Array.isArray(action.paths) && action.paths.length > 0)
          )
            return {};
          try {
            return {
              observedDocGitPaths: discoverDocCandidateGitPaths({
                rootDir: context.rootDir,
                projection: context.projection,
                store: context.store,
                ...(typeof action.taskId === "string" ? { taskId: action.taskId } : {}),
              }),
            };
          } catch (error) {
            return { error };
          }
        })();
      return enqueuePublication((authorizationDecision) => {
        // Admission owns the error response even when an earlier disk preparation failed.
        if ("error" in preparation) throw preparation.error;
        return context.executeAction(action, {
          ...binding,
          ...(authorizationDecision ? { authorizationDecision } : {}),
          ...(preparation.observedDocGitPaths === undefined
            ? {}
            : { observedDocGitPaths: preparation.observedDocGitPaths }),
        });
      });
    };
    const receipt = await runAfterWorktreeReady();
    // Rematerialization can reach the queue behind a write that changed its documents. A pending
    // result for that cut contains no write, so settle it off queue and re-enter through admission.
    return needsWorktree &&
      receipt.outcome === "pending" &&
      "code" in receipt &&
      receipt.code === "materialization_failed"
      ? runAfterWorktreeReady()
      : receipt;
  };
  const enqueueCommand = run;
  return async (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    signal?: AbortSignal,
    onExecutionStart?: () => void,
    queueObservation?: RepoCellQueueObservation,
  ) => {
    let resolution: ReturnType<typeof resolveTaskWriteTarget>;
    try {
      resolution = resolveTaskWriteTarget(context, action, { deferInvalidTarget: true });
    } catch (error) {
      const rejected = failAction(context, action, binding, error);
      return rejected;
    }
    action = resolution.action;
    const receipt = await run(action, binding, signal, !resolution.resolved, onExecutionStart, queueObservation);
    return receipt;
  };
}

async function bindCurrentPersonIdentityWitnesses(
  action: RepoTaskAction,
  binding: RepoCellBinding,
  projection: RepoCellApiContext["projection"],
  rootDir: string,
  repoId: string,
  now: string,
): Promise<RepoCellBinding> {
  const ids = new Set<string>();
  if (
    (action.kind === "relation-relate" && typeof action.targetRef === "string") ||
    (action.kind.endsWith("-assign") && typeof action.personId === "string")
  ) {
    const target = parseEntityRef(
      action.kind === "relation-relate" ? (action.targetRef as string) : `person/${action.personId}`,
    );
    if (target?.kind === "person") ids.add(target.id);
  }
  if (typeof action.decisionId === "string" && ["decision-review", "decision-respond-review"].includes(action.kind)) {
    // The review-await reconcile after these writes relates decision/<id> awaits person/<proposer>.
    // Person entities left the projection with the Keycloak migration, so that target resolves only
    // through this binding's witness; the proposer must be collected before the write. CLI packets
    // are resolved at execute time, so the same packet is resolved here to read its verdict.
    const decision = projection.readDecision(action.decisionId).decision;
    if (decision?.state === "proposed") {
      const changesRequested =
        action.kind === "decision-review"
          ? resolveDecisionReviewAction(rootDir, action).verdict === "changes_requested"
          : decision.reviews.some(({ verdict }) => verdict === "changes_requested");
      if (changesRequested) ids.add(decision.proposer.principal.personId);
    }
  }
  const assignmentAction = action.kind.endsWith("-assign") || action.kind.endsWith("-unassign");
  if (assignmentAction && action.kind.endsWith("-assign")) {
    const targetIds = [
      typeof action.personId === "string" ? ["person", action.personId] : null,
      typeof action.nodeId === "string" ? ["node", action.nodeId] : null,
      typeof action.teamId === "string" ? ["team", action.teamId] : null,
    ].filter((value): value is [string, string] => value !== null);
    if (targetIds.length !== 1)
      throw Object.assign(new Error("Assignment requires exactly one person, node or team target."), {
        code: "invalid_field",
      });
    const credential = binding.keycloakAuthorization;
    if (!credential?.center)
      throw Object.assign(new Error("Assignment targets require the center directory."), {
        code: "authentication_required",
      });
    const center = await credential.center(),
      adapter = center.provider,
      [kind, id] = targetIds[0]!;
    if (kind === "person" && !(await adapter.findUserId(center.accessToken, id)))
      throw Object.assign(new Error(`Person ${id} was not found in the current Keycloak realm.`), {
        code: "entity_not_found",
      });
    if (kind === "node" && (await adapter.readNode(center.accessToken, id))?.state !== "active")
      throw Object.assign(new Error(`Node ${id} is not registered and active.`), { code: "entity_not_found" });
    if (kind === "team") await adapter.readTeam(center.accessToken, id);
  }
  const recoveryDispatchId = edgeReviewerRecoveryDispatchId(action, binding);
  if (ids.size === 0 && recoveryDispatchId === null) return binding;
  const credential = binding.keycloakAuthorization;
  if (!credential && ids.size === 0) return binding;
  if (!credential)
    throw Object.assign(new Error("Person identity references require Keycloak."), { code: "authentication_required" });
  const center = credential.center ? await credential.center() : undefined,
    adapter = center ? center.provider : null,
    witnesses = new Map(binding.personIdentityWitnesses ?? []);
  if (recoveryDispatchId !== null && center)
    binding = await recoverEdgeReviewerExecutionBinding({
      dispatchId: recoveryDispatchId,
      action,
      binding,
      projection,
      repoId,
      now,
      center,
    });
  if (ids.size === 0) return binding;
  for (const personId of ids) {
    if (witnesses.has(personId)) continue;
    const userId =
      credential.session?.personId === personId
        ? `session-${personId}`
        : center && adapter
          ? await adapter.findUserId(center.accessToken, personId)
          : undefined;
    if (!userId)
      throw Object.assign(new Error(`Person ${personId} was not found in the current Keycloak realm.`), {
        code: "entity_not_found",
      });
    witnesses.set(personId, userId);
  }
  return { ...binding, personIdentityWitnesses: witnesses };
}

function edgeReviewerRecoveryDispatchId(action: RepoTaskAction, binding: RepoCellBinding): string | null {
  if (
    action.kind !== "task-review-execution" ||
    binding.executionPrincipal ||
    typeof binding.source !== "object" ||
    binding.source.kind !== "node" ||
    typeof action.reviewId !== "string" ||
    !action.reviewId.startsWith("review-")
  )
    return null;
  return action.reviewId.slice("review-".length);
}

async function recoverEdgeReviewerExecutionBinding(input: {
  readonly dispatchId: string;
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly projection: RepoCellApiContext["projection"];
  readonly repoId: string;
  readonly now: string;
  readonly center: Parameters<typeof readRuntimeExecutionPrincipal>[0];
}): Promise<RepoCellBinding> {
  const taskId = typeof input.action.taskId === "string" ? input.action.taskId : "";
  if (
    !taskId ||
    !canRecoverEdgeReviewerDispatch({
      projection: input.projection,
      dispatchId: input.dispatchId,
      taskId,
      executionId: typeof input.action.executionId === "string" ? input.action.executionId : null,
      source: input.binding.source,
      personId: input.binding.actor.principal.personId,
    })
  )
    return input.binding;
  const principal = await readRuntimeExecutionPrincipal(input.center, input.dispatchId);
  if (
    principal.repoId !== input.repoId ||
    principal.role !== "reviewer" ||
    principal.personId !== input.binding.actor.principal.personId
  )
    throw executionCredentialRejected("scope", {
      dispatchId: input.dispatchId,
      role: "reviewer",
      detail: "Edge review recovery credential does not match this repository reviewer dispatch.",
    });
  const recoveredBinding: RepoCellBinding = {
    ...input.binding,
    actor: runtimeExecutionActor(principal),
    executionPrincipal: principal,
  };
  requireCurrentExecutionScope({
    action: input.action,
    binding: recoveredBinding,
    projection: input.projection,
    now: input.now,
  });
  return recoveredBinding;
}

function requiredPublishedGitCommit(commit: { readonly sha: string } | null): string {
  if (!commit)
    throw Object.assign(new Error("This script requires a configured Git follower"), {
      code: "git_follower_unconfigured",
    });
  return commit.sha;
}
