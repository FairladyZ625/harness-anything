import { executionDelegationPath, readExecutionDelegations } from "./execution-delegation-store.ts";
import {
  assertCurrentWriter,
  stableStringify,
  durablePolicyActions,
  getExecutableEntityAction,
  parseEntityRef,
  readAcceptedCommandOutcome,
  VcsCommandError,
  type AuthorizationDecision,
  type EntityActionUnmetCriterionV1,
  type WriteReceipt,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import {
  evaluateRepoCellAction,
  bindVerifiedExecutorClaim,
  withAuthorizationDecision,
} from "./repo-cell-authorization.ts";
import { cellErrorCode } from "./repo-cell-errors.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { chainRepoCellWrite } from "./repo-cell.ts";
import { admitRepoMode, builtinOccurrenceCommandTopology, entityActionCommandTopology } from "./repo-mode.ts";
import { commandDescriptorForAction } from "./protocol/daemon-protocol.contract.ts";
import { recoveryCommandPolicy } from "./recovery-state.ts";
import {
  executeSquadControl,
  isSquadControlCommand,
  squadControlRejected,
  type SquadControlResult,
} from "./squad-control-result.ts";
import { deriveActionResult } from "./entity-action-catalog-executor.ts";
import { executeVerticalScriptAction, publishExecutedVerticalScript } from "./vertical-script-actions.ts";
import { readBeforeWriteQueue } from "./write-queue-external-reads.ts";
import { inspectScheduleProjection } from "./schedule-projection.ts";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";

function targetsBuiltinSchedule(context: RepoCellApiContext, action: RepoTaskAction): boolean {
  if (context.state !== "attached" || getExecutableEntityAction(action.kind)?.target.kind !== "schedule") return false;
  const row =
      typeof action.scheduleId === "string" ? context.projection.getEntity("schedule", action.scheduleId) : null,
    inspected = row ? inspectScheduleProjection(row) : null;
  return inspected?.valid === true && inspected.schedule.spec.target.kind === "builtin";
}

/** The RepoCell command pipeline: recovery admission, the executor claim, and the queued
 * publication interval that authorizes, executes, and settles one command at the writer cut. */
export function makeRepoCellCommandRunner(context: RepoCellApiContext) {
  let settlingRecovery: string | null = null;
  const run = async (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    signal?: AbortSignal,
  ): Promise<WriteReceipt | SquadControlResult> => {
    if (context.state !== "attached")
      await context.attemptRecovery(recoveryCommandPolicy(action.kind, context.causeClass)?.settlesLatch === true);
    const requested = { action, binding },
      durable = (durablePolicyActions as readonly string[]).includes(action.kind),
      // A durable executor claim is verified in the publication turn that authorizes and executes it.
      claimAtPublication = durable && action.executor != null,
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
            });
          return withAuthorizationDecision(
            context.failed(actionId, error),
            decision,
            [],
            error instanceof Error ? error.message : String(error),
          );
        }
      };
    if (claimAtPublication) {
      const { executor: _claim, ...unclaimed } = action;
      action = unclaimed as RepoTaskAction;
    } else if (action.executor != null) {
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
        }).then(async (decision) => {
          if (decision.outcome === "allowed")
            binding = await bindCurrentPersonIdentityWitnesses(action, binding, context.projection);
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
    const failAction = (error: unknown, authorizationDecision?: AuthorizationDecision): WriteReceipt => {
      if (context.fatalCellError(error)) context.latchWith(error);
      const contract = getExecutableEntityAction(action.kind),
        receipt = context.failed(
          context.errorOperationId(error) ?? context.operationId(action, binding, context.input.repoId, 0),
          error,
          contract,
          contract ? action : undefined,
        );
      const result = contract ? deriveActionResult(contract, action, receipt) : receipt;
      return authorizationDecision
        ? withAuthorizationDecision(
            result,
            authorizationDecision,
            result.unmetCriteria ?? [],
            result.rejectionExplanation ?? (error instanceof Error ? error.message : String(error)),
          )
        : (result as WriteReceipt);
    };
    if (command.commandClass === "repo-read")
      return Promise.resolve()
        .then(async () => {
          const admission = admitRepoMode(context.mode, command, binding.source);
          if (!admission.ok) throw context.cellCodedError(admission.code, admission.nextAction);
          if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
          return context.withHumanSummary(await context.executeAction(action, binding));
        })
        .then((receipt) => receipt as WriteReceipt)
        .catch((error) => failAction(error));
    const enqueuePublication = (
      execute: (authorizationDecision?: AuthorizationDecision) => WriteReceiptDraft | Promise<WriteReceiptDraft>,
      ingest?: (authorizationDecision?: AuthorizationDecision) => void,
    ): Promise<WriteReceipt | SquadControlResult> => {
      context.queueDepth += 1;
      let queuedDecision: AuthorizationDecision | undefined,
        replaceAfterPublication = false;
      const pending = chainRepoCellWrite(context.tail, async () => {
        context.queueDepth -= 1;
        const claimRejected = claimAtPublication ? await bindExecutorClaim() : null;
        if (claimRejected) return claimRejected;
        if (durable) {
          queuedDecision = await authorizeAtCurrentCut()!;
          if (queuedDecision.outcome === "denied")
            return withAuthorizationDecision(
              context.rejected(
                context.operationId(action, binding, context.input.repoId, context.store.readHead()?.revision ?? 0),
                "authorization_denied",
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
        // Ingested reads are their own accepted commands, recorded before the execution interval
        // opens: a failed execution must never adopt one of them as its accepted outcome.
        ingest?.(queuedDecision);
        const revisionBeforeExecution = context.store.readHead()?.revision ?? 0;
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
            receipt = queuedDecision ? withAuthorizationDecision(executed, queuedDecision) : (executed as WriteReceipt);
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
            return squadControlRejected(action.kind, failAction(error, queuedDecision));
          // A coded rejection is this command's own determinate verdict, even after an earlier step
          // (one of several ingested runs, a facade's witness) was accepted as its own command.
          const code = cellErrorCode(error);
          if (
            !(error instanceof VcsCommandError) &&
            code !== "service_rejected" &&
            code !== "publication_indeterminate"
          )
            throw error;
          // This queue owns the interval. A downstream failure cannot undo its committed acceptance.
          const head = context.store.readHead(),
            accepted = head ? readAcceptedCommandOutcome(context.store, head.opId) : null;
          if (accepted !== null && accepted.firstRevision > revisionBeforeExecution)
            throw Object.assign(
              context.cellCodedError(
                "publication_indeterminate",
                error instanceof Error ? error.message : String(error),
              ),
              { opId: accepted.opId, cause: error },
            );
          throw error;
        } finally {
          context.activeWriterEpochFence = null;
          context.activeWriterEpochFenceDescriptor = null;
        }
      });
      context.tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending
        .catch((error) => failAction(error, queuedDecision))
        .then(async (receipt) => {
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
      return Promise.resolve(context.store.settlePendingMaterialization?.("vertical script"))
        .then(() =>
          executeVerticalScriptAction({
            action,
            rootDir: context.rootDir,
            commitSha: context.store.currentCommit().sha,
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
          async (error) => failAction(error, durable ? await authorizeAtCurrentCut()! : undefined),
        );
    const externalRead = readBeforeWriteQueue(context, action, binding);
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
        .catch(async (error) => failAction(error, durable ? await authorizeAtCurrentCut()! : undefined));
    return enqueuePublication((authorizationDecision) =>
      context.executeAction(action, authorizationDecision ? { ...binding, authorizationDecision } : binding),
    );
  };
  return run;
}

async function bindCurrentPersonIdentityWitnesses(
  action: RepoTaskAction,
  binding: RepoCellBinding,
  projection: RepoCellApiContext["projection"],
): Promise<RepoCellBinding> {
  const ids = new Set<string>();
  if (action.kind === "relation-relate" && typeof action.targetRef === "string") {
    const target = parseEntityRef(action.targetRef);
    if (target?.kind === "person") ids.add(target.id);
  }
  if (
    action.kind === "decision-review" &&
    action.verdict === "changes_requested" &&
    typeof action.decisionId === "string"
  ) {
    const proposer = projection.readDecision(action.decisionId).decision?.proposer.principal.personId;
    if (proposer) ids.add(proposer);
  }
  if (ids.size === 0) return binding;
  const credential = binding.keycloakAuthorization;
  if (!credential)
    throw Object.assign(new Error("Person identity references require Keycloak."), { code: "authentication_required" });
  const center = credential.center,
    adapter = center
      ? new KeycloakPolicyAdapter({ url: center.url, realm: center.realm, resourceServerClientId: center.clientId })
      : null,
    witnesses = new Map(binding.personIdentityWitnesses ?? []);
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
