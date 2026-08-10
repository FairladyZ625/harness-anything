import { randomUUID } from "node:crypto";
import {
  type AuthorityOperationReceipt,
  type CommandReceiptEnvelope,
  type DaemonHostCommand,
  type DaemonHostCommandResult
} from "@harness-anything/application";
import type {
  AuthorityRepoConnectionBinding
} from "../authority/authority-lifecycle.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import { createDaemonCommandService } from "../service/command-service.ts";
import { RepoWriteAuthorityRecoveryGate } from "./repo-write-authority-recovery-gate.ts";
import {
  RepoWriteDurableOperationController,
  type RepoWriteDurableExecutionResult
} from "./repo-write-durable-operation-controller.ts";
import type { RepoWriteCanonicalLookupResult } from "./repo-write-child-lookup.ts";
import type {
  RepoWriteLookupInput,
  RepoWriteDirectInput,
  RepoWritePrepareInput,
  RepoWritePreparedOperation
} from "./repo-write-child-host.ts";
import type { RepoWriteCommandDto } from "./repo-write-protocol.ts";
import {
  decodeRepoWriteCommand
} from "./repo-write-progress-command.ts";
import {
  repoWriteCurrentCommandForExecution,
  repoWriteActorStampDigestV1,
  repoWriteReceiptSeedSchema,
  type RepoWriteCanonicalCommandDto,
  type RepoWriteProceedingOutcomeV1,
  type RepoWriteTerminalEvidenceV1
} from "./repo-write-outcome-schema.ts";
import {
  holdBackgroundAuthoritySettlement,
  type AuthorityDurableAcceptance
} from "./authority-durable-acceptance-context.ts";
import {
  repoWriteDirectResponseDelivery,
  type RepoWriteDirectExecutionResult
} from "./repo-write-child-direct.ts";
import type {
  ProductionAuthorityAttemptPlanV1,
  ProductionAuthorityCommandPlanInput
} from "../authority/production/production-authority-attempt-compiler.ts";
import {
  settleDirectAuthorityCommandReceipt,
  type CapturedAuthorityDurableSubmission
} from "./direct-command-receipt-settlement.ts";
import {
  guardProgressAppendRecoveryEffect
} from "./repo-write-progress-recovery-guard.ts";
import {
  reportCurrentRepoWriteTelemetry
} from "./repo-write-telemetry-context.ts";
import {
  executeRepoWriteDocSyncOperation,
  prepareRepoWriteDocSyncOperation
} from "./repo-write-doc-sync-operation.ts";
import { exactRepoWriteReceipt } from "./repo-write-exact-receipt.ts";
import { repoWriteCommandReceiptJsonObject } from "./repo-write-command-receipt.ts";
import {
  BackgroundCommandRuntimeEventDrain,
  type DeferredCommandRuntimeEventAppend
} from "./background-command-runtime-event.ts";
import type {
  ProductionRepoWriteOperationHostOptions,
  ResolvedProductionRepoWriteOperationHostOptions
} from "./production-repo-write-operation-options.ts";

export type { RepoWriteDocSyncExecution } from "./repo-write-doc-sync-operation.ts";
export type { BackgroundRuntimeEventFailure } from "./background-command-runtime-event.ts";

export class ProductionRepoWriteOperationHost<
  Command extends DaemonHostCommand,
  Result extends DaemonHostCommandResult
> {
  private readonly options: ResolvedProductionRepoWriteOperationHostOptions<Command, Result>;
  private readonly recoveryGate: RepoWriteAuthorityRecoveryGate;
  private readonly operations: RepoWriteDurableOperationController;
  private readonly runtimeEventDrain: BackgroundCommandRuntimeEventDrain;

  constructor(options: ProductionRepoWriteOperationHostOptions<Command, Result>) {
    this.options = {
      ...options,
      now: options.now ?? (() => new Date()),
      newOuterOpId: options.newOuterOpId ?? (() => `repo-write:${randomUUID()}`)
    };
    this.recoveryGate = new RepoWriteAuthorityRecoveryGate({
      repoId: options.repoId,
      workspaceId: options.workspaceId,
      generation: options.generation,
      store: options.outcomeStore,
      assertCurrentWriterFence: options.runtime.assertWriteFenceHeld,
      ...(options.resolveHistoricalPublication ? {
        resolveHistoricalPublication: options.resolveHistoricalPublication
      } : {}),
      ...(options.recoverHistoricalCommittedReceipt ? {
        recoverHistoricalCommittedReceipt: options.recoverHistoricalCommittedReceipt
      } : {})
    });
    this.operations = new RepoWriteDurableOperationController({
      repoId: options.repoId,
      workspaceId: options.workspaceId,
      generation: options.generation,
      store: options.outcomeStore,
      settlements: options.settlementStore,
      now: this.options.now,
      recover: (proceeding) => this.execute(proceeding, true)
    });
    this.runtimeEventDrain = new BackgroundCommandRuntimeEventDrain({
      ...(options.onBackgroundRuntimeEventFailure ? {
        onFailure: options.onBackgroundRuntimeEventFailure
      } : {})
    });
  }

  readonly runAuthorizedRecoveryPlan: RepoWriteAuthorityRecoveryGate["runPlannedRecovery"] =
    (witness, useDurableProceeding) =>
      this.recoveryGate.runPlannedRecovery(witness, useDurableProceeding);

  readonly runAuthorizedRecoveryAttempt: RepoWriteAuthorityRecoveryGate["runAttemptRecovery"] =
    (recovery, useDurableProceeding) =>
      this.recoveryGate.runAttemptRecovery(recovery, useDurableProceeding);

  readonly settlementIdle = async (): Promise<void> => {
    await this.operations.settlementIdle();
    await this.runtimeEventDrain.idle();
  };

  readonly recoverCanonicalPublicationSettlement = (input: {
    readonly outerOpId: string;
    readonly canonicalCommitSha: string;
  }): Promise<"live-owner" | "recovered" | "terminal" | "blocked"> =>
    this.operations.recoverCanonicalPublicationSettlement(input);

  async prepare(input: RepoWritePrepareInput): Promise<RepoWritePreparedOperation> {
    if (input.command.commandName === "doc-sync-submit") {
      return this.prepareDocSync(input);
    }
    const prepared = await this.prepareCommand(input.command);
    const generatedAt = this.options.now().toISOString();
    const proceeding = {
      repoId: this.options.repoId,
      workspaceId: this.options.workspaceId,
      generation: this.options.generation,
      outerOpId: this.options.newOuterOpId(),
      innerOpId: prepared.plan.innerOpId,
      authoritySemanticDigest: prepared.plan.semanticDigest,
      canonicalCommand: input.command,
      authenticatedContext: { actor: input.command.actor },
      receiptSeed: {
        schema: repoWriteReceiptSeedSchema,
        renderer: "cli-command-receipt/v2@1" as const,
        generatedAt,
        ...prepared.receiptSeed,
        actorStampDigest: repoWriteActorStampDigestV1(input.command.actor)
      },
      recoveryContext: prepared.plan as unknown as import("./repo-write-protocol.ts").RepoWriteJsonObject
    };
    reportCurrentRepoWriteTelemetry("compile-outcome");
    return this.operations.prepare({
      proceeding,
      executeFresh: (durable) => this.executePrepared(
        durable,
        prepared.binding,
        prepared.expected,
        prepared.plan
      )
    });
  }

  async direct(input: RepoWriteDirectInput): Promise<RepoWriteDirectExecutionResult> {
    const decoded = decodeRepoWriteCommand(input.command);
    const binding = this.options.authorityComponent.bindConnection(
      decoded.authorityConnection
    );
    const directExecution = input.command.commandName === "doc-sync-submit"
      ? await this.options.executeDocSyncSubmit?.({ command: input.command, decoded })
      : undefined;
    if (directExecution) {
      if (directExecution.durable) {
        throw new Error("DOC_SYNC_DURABLE_WRITE_REQUIRES_DURABLE_LANE");
      }
      return repoWriteCommandReceiptJsonObject(directExecution.receipt);
    }
    reportCurrentRepoWriteTelemetry("compile-command-normalize");
    const command = await this.options.hostServices.normalizeCommand(
      this.options.hostServices.parseCommandPayload(input.command.payload),
      decoded.currentSession
    );
    const taskCompleteDryRun = command.action.kind === "task-complete"
      && command.action.dryRun === true;
    if (!taskCompleteDryRun
      && this.options.hostServices.repoWriteChildExecutionMode(command) !== "direct") {
      throw new Error(`REPO_WRITE_DIRECT_MODE_REQUIRED:${command.action.kind}`);
    }
    const durableSubmissions: CapturedAuthorityDurableSubmission[] = [];
    const capturingBinding: AuthorityRepoConnectionBinding = {
      ...binding,
      submitDurable: async (submissionInput) => {
        const durable = await binding.submitDurable(submissionInput);
        const captured: CapturedAuthorityDurableSubmission = {
          settlement: durable.settlement
        };
        durableSubmissions.push(captured);
        return {
          admission: durable.admission.then((admission) => {
            if (admission.kind === "accepted") captured.acceptance = admission.acceptance;
            return admission;
          }),
          settlement: durable.settlement
        };
      }
    };
    const deferredRuntimeEvents: DeferredCommandRuntimeEventAppend[] = [];
    const commandService = createDaemonCommandService(
      this.options.runtime,
      this.options.hostServices,
      {
        deferCommandRuntimeEvent: (append) => deferredRuntimeEvents.push(append),
        resolveAuthoritySubmissionV2: () => capturingBinding,
        authorityCutoverControl: this.options.authorityComponent.cutoverControl,
        ...(this.options.conflictMarkerPreflight ? {
          conflictMarkerPreflight: this.options.conflictMarkerPreflight
        } : {})
      }
    );
    const held = await holdBackgroundAuthoritySettlement(() => commandService.runCommand(
      input.command.payload as unknown as JsonObject,
      {
        actor: decoded.actor,
        executor: decoded.executor,
        authorityConnection: {
          available: true,
          context: decoded.authorityConnection,
          assertActive: () => undefined
        }
      }
    ));
    const releaseAfterResponse = this.runtimeEventDrain.responseRelease({
      requestId: input.requestId,
      command: command.action.kind,
      releaseAuthoritySettlement: held.releaseAfterResponse,
      appends: deferredRuntimeEvents
    });
    try {
      if (command.action.kind === "materializer-run") {
        await this.options.recoverSettlements?.();
      }
      return repoWriteDirectResponseDelivery(
        repoWriteCommandReceiptJsonObject(settleDirectAuthorityCommandReceipt({
          receipt: held.result,
          submissions: durableSubmissions,
          store: this.options.settlementStore,
          now: this.options.now
        })),
        releaseAfterResponse
      );
    } catch (error) {
      releaseAfterResponse();
      throw error;
    }
  }

  async lookup(input: RepoWriteLookupInput): Promise<RepoWriteCanonicalLookupResult> {
    const settlement = this.options.settlementStore.lookup(input.opId);
    if (settlement?.state === "canonical-visible") {
      const current = this.options.outcomeStore.lookup(input.opId);
      return current.state === "terminal"
        ? { state: "terminal", outcome: current.outcome }
        : { state: "canonical-visible", receipt: repoWriteCommandReceiptJsonObject(settlement.receipt) };
    }
    if (settlement?.state === "pending") {
      const current = this.options.outcomeStore.lookup(input.opId);
      if (current.state === "terminal") {
        return { state: "terminal", outcome: current.outcome };
      }
      return { state: "accepted", receipt: repoWriteCommandReceiptJsonObject(settlement.receipt) };
    }
    if (settlement?.state === "failed") {
      return { state: "settlement-failed", receipt: repoWriteCommandReceiptJsonObject(settlement.receipt) };
    }
    const current = this.options.outcomeStore.lookup(input.opId);
    if (current.state === "not-found") return { state: "not-found" };
    if (current.state === "terminal") {
      return { state: "terminal", outcome: current.outcome };
    }
    if (current.state === "outcome-unknown") return { state: "unknown" };
    const resumed = await this.operations.resume(input.opId);
    if ("kind" in resumed && resumed.kind === "accepted") {
      return { state: "accepted", receipt: repoWriteCommandReceiptJsonObject(resumed.receipt) };
    }
    if ("phase" in resumed && resumed.phase === "TERMINAL") {
      return { state: "terminal", outcome: resumed };
    }
    throw new Error(`REPO_WRITE_RESUME_DID_NOT_SETTLE:${input.opId}`);
  }

  private async prepareCommand(dto: RepoWriteCommandDto) {
    const decoded = decodeRepoWriteCommand(dto);
    const binding = this.options.authorityComponent.bindConnection(
      decoded.authorityConnection
    );
    if (!binding.planCommand || !binding.plannedCommandSubmission) {
      throw new Error("AUTHORITY_COMMAND_PLANNING_UNAVAILABLE");
    }
    reportCurrentRepoWriteTelemetry("compile-command-normalize");
    const command = await this.options.hostServices.normalizeCommand(
      this.options.hostServices.parseCommandPayload(dto.payload),
      decoded.currentSession
    );
    if (command.action.dryRun === true
      || this.options.hostServices.repoWriteChildExecutionMode(command) !== "durable") {
      throw new Error(`REPO_WRITE_DURABLE_MODE_REQUIRED:${command.action.kind}`);
    }
    const authorityCommand = this.options.hostServices.authorityCommand(command);
    if (!authorityCommand) {
      throw new Error(`AUTHORITY_COMMAND_REQUIRED:${command.action.kind}`);
    }
    const attribution = this.options.hostServices.actorAttribution(
      decoded.actor,
      command,
      decoded.executor
    );
    const expected = {
      command: authorityCommand,
      attribution,
      currentSession: decoded.currentSession,
      ingressAdapter: this.options.hostServices.authorityIngressFor(
        authorityCommand.action.kind
      )
    };
    reportCurrentRepoWriteTelemetry("compile-authority-plan");
    const plan = await binding.planCommand(expected);
    return {
      binding,
      expected,
      receiptSeed: this.options.hostServices.receiptSeed(command),
      plan
    };
  }

  private async execute(
    proceeding: RepoWriteProceedingOutcomeV1,
    recovery: boolean
  ): Promise<RepoWriteDurableExecutionResult> {
    if (proceeding.canonicalCommand.commandName === "doc-sync-submit") {
      return this.executeDocSync(proceeding);
    }
    const prepared = await this.prepareFixedCommand(proceeding.canonicalCommand);
    const plan = proceeding.recoveryContext as unknown as ProductionAuthorityAttemptPlanV1;
    return this.executePrepared(
      proceeding,
      prepared.binding,
      prepared.expected,
      plan,
      recovery
    );
  }

  private async prepareDocSync(input: RepoWritePrepareInput): Promise<RepoWritePreparedOperation> {
    return prepareRepoWriteDocSyncOperation({
      request: input,
      repoId: this.options.repoId,
      workspaceId: this.options.workspaceId,
      generation: this.options.generation,
      authorityComponent: this.options.authorityComponent,
      operations: this.operations,
      now: this.options.now,
      newOuterOpId: this.options.newOuterOpId,
      execute: (proceeding) => this.executeDocSync(proceeding)
    });
  }

  private async executeDocSync(
    proceeding: RepoWriteProceedingOutcomeV1
  ): Promise<RepoWriteDurableExecutionResult> {
    return executeRepoWriteDocSyncOperation({
      proceeding,
      ...(this.options.executeDocSyncSubmit
        ? { executeDocSyncSubmit: this.options.executeDocSyncSubmit }
        : {}),
      exactReceipt: (receipt) => exactRepoWriteReceipt(receipt, proceeding, undefined)
    });
  }

  private async prepareFixedCommand(dto: RepoWriteCanonicalCommandDto) {
    const currentCommand = repoWriteCurrentCommandForExecution(dto);
    const decoded = decodeRepoWriteCommand(currentCommand);
    const binding = this.options.authorityComponent.bindConnection(
      decoded.authorityConnection
    );
    if (!binding.plannedCommandSubmission) {
      throw new Error("AUTHORITY_COMMAND_PLANNING_UNAVAILABLE");
    }
    reportCurrentRepoWriteTelemetry("compile-command-normalize");
    const command = await this.options.hostServices.normalizeCommand(
      this.options.hostServices.parseCommandPayload(currentCommand.payload),
      decoded.currentSession
    );
    const authorityCommand = this.options.hostServices.authorityCommand(command);
    if (!authorityCommand
      || this.options.hostServices.repoWriteChildExecutionMode(command) !== "durable") {
      throw new Error(`AUTHORITY_DURABLE_COMMAND_REQUIRED:${command.action.kind}`);
    }
    return {
      binding,
      expected: {
        command: authorityCommand,
        attribution: this.options.hostServices.actorAttribution(
          decoded.actor,
          command,
          decoded.executor
        ),
        currentSession: decoded.currentSession,
        ingressAdapter: this.options.hostServices.authorityIngressFor(
          authorityCommand.action.kind
        )
      }
    };
  }

  private async executePrepared(
    proceeding: RepoWriteProceedingOutcomeV1,
    binding: AuthorityRepoConnectionBinding,
    expected: ProductionAuthorityCommandPlanInput,
    plan: ProductionAuthorityAttemptPlanV1,
    recovery = false
  ): Promise<RepoWriteDurableExecutionResult> {
    const currentCommand = repoWriteCurrentCommandForExecution(
      proceeding.canonicalCommand
    );
    const decoded = decodeRepoWriteCommand(currentCommand);
    if (recovery && plan.commandKind === "progress-append") {
      guardProgressAppendRecoveryEffect({
        rootInput: {
          rootDir: expected.command.rootDir,
          ...(expected.command.layoutOverrides ? {
            layoutOverrides: expected.command.layoutOverrides
          } : {})
        },
        opId: proceeding.innerOpId,
        now: this.options.now
      });
    }
    const submission = binding.plannedCommandSubmission!({
      expected,
      plan,
      ...(recovery ? {
        recovery: {
          outerOpId: proceeding.outerOpId,
          outerRequestDigest: proceeding.requestDigest,
          outerGeneration: proceeding.generation
        }
      } : {})
    });
    let authorityEvidence: AuthorityOperationReceipt | undefined;
    const durableSubmissions: Array<{
      acceptance?: AuthorityDurableAcceptance;
      readonly settlement: Promise<AuthorityOperationReceipt>;
    }> = [];
    const capturingSubmission = {
      submit: async (input: Parameters<typeof submission.submit>[0]) => {
        authorityEvidence = await submission.submit(input);
        return authorityEvidence;
      },
      submitDurable: async (input: Parameters<typeof submission.submitDurable>[0]) => {
        const durable = await submission.submitDurable(input);
        const settlement = durable.settlement.then((evidence) => {
          authorityEvidence = evidence;
          return evidence;
        });
        const captured: {
          acceptance?: AuthorityDurableAcceptance;
          readonly settlement: Promise<AuthorityOperationReceipt>;
        } = { settlement };
        durableSubmissions.push(captured);
        return {
          admission: durable.admission.then((admission) => {
            if (admission.kind === "accepted") captured.acceptance = admission.acceptance;
            else authorityEvidence = admission.receipt;
            return admission;
          }),
          settlement
        };
      }
    };
    const deferredRuntimeEvents: DeferredCommandRuntimeEventAppend[] = [];
    const commandService = createDaemonCommandService(
      this.options.runtime,
      this.options.hostServices,
      {
        taskLeaseGuardMode: "read-only",
        deferCommandRuntimeEvent: (append) => deferredRuntimeEvents.push(append),
        ...(recovery ? { outerProceedingRecovery: true as const } : {}),
        resolveAuthoritySubmissionV2: () => capturingSubmission,
        ...(this.options.conflictMarkerPreflight ? {
          conflictMarkerPreflight: this.options.conflictMarkerPreflight
        } : {})
      }
    );
    const held = await holdBackgroundAuthoritySettlement(() => commandService.runCommand(
      currentCommand.payload as unknown as JsonObject,
      {
        actor: decoded.actor,
        executor: decoded.executor,
        authorityConnection: {
          available: true,
          context: decoded.authorityConnection,
          assertActive: () => undefined
        }
      }
    ));
    const releaseAfterResponse = this.runtimeEventDrain.responseRelease({
      requestId: proceeding.outerOpId,
      command: currentCommand.commandName,
      releaseAuthoritySettlement: held.releaseAfterResponse,
      appends: deferredRuntimeEvents
    });
    try {
      const receipt = exactRepoWriteReceipt(held.result, proceeding, authorityEvidence);
      const accepted = durableSubmissions
        .map((entry) => entry.acceptance)
        .find((entry) => entry?.flush.watermark === proceeding.innerOpId)
        ?? durableSubmissions.at(-1)?.acceptance;
      if (accepted) {
        return {
          kind: "accepted",
          receipt,
          acceptance: accepted,
          acceptedCommitSha: accepted.acceptedCommitSha,
          settlement: Promise.all(durableSubmissions.map((entry) => entry.settlement)).then((evidence) => {
            const exact = evidence.find((entry) => entry.opId === proceeding.innerOpId) ?? evidence.at(-1);
            if (!exact || exact.tag === "INDETERMINATE") {
              throw new Error(`AUTHORITY_SETTLEMENT_INDETERMINATE:${exact?.tag === "INDETERMINATE" ? exact.reason : "terminal evidence missing"}`);
            }
            return exact;
          }),
          releaseSettlement: releaseAfterResponse
        };
      }
      releaseAfterResponse();
      const evidence = terminalEvidence(authorityEvidence, receipt, proceeding);
      return { kind: "terminal", receipt, authorityEvidence: evidence };
    } catch (error) {
      releaseAfterResponse();
      throw error;
    }
  }

}

export {
  ProductionRepoWriteOperationHost as ProductionProgressAppendOperationHost
};

function terminalEvidence(
  evidence: AuthorityOperationReceipt | undefined,
  receipt: CommandReceiptEnvelope,
  proceeding: RepoWriteProceedingOutcomeV1
): RepoWriteTerminalEvidenceV1 {
  if (evidence?.tag === "INDETERMINATE") {
    throw new Error(`AUTHORITY_INDETERMINATE:${evidence.reason}`);
  }
  if (evidence) return evidence;
  if (receipt.ok) {
    throw new Error("AUTHORITY_PROGRESS_APPEND_TERMINAL_EVIDENCE_MISSING");
  }
  return {
    tag: "REJECTED",
    workspaceId: proceeding.workspaceId,
    opId: proceeding.innerOpId,
    semanticDigest: proceeding.authoritySemanticDigest,
    reason: JSON.stringify(receipt.error ?? { code: "command_rejected" })
  };
}
