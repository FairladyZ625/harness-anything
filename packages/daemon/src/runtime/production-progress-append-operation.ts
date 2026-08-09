import { randomUUID } from "node:crypto";
import {
  type AuthorityOperationReceipt,
  type CommandReceiptEnvelope,
  type DaemonCommandHostServices,
  type DaemonHostCommand,
  type DaemonHostCommandResult
} from "@harness-anything/application";
import type {
  AuthorityRepoComponent,
  AuthorityRepoConnectionBinding
} from "../authority/authority-lifecycle.ts";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import { createDaemonCommandService } from "../service/command-service.ts";
import type { HarnessDaemonRuntime } from "./repo-runtime.ts";
import {
  RepoWriteAuthorityRecoveryGate,
  type RepoWriteAuthorityRecoveryGateOptions
} from "./repo-write-authority-recovery-gate.ts";
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
import { DurableRepoWriteOutcomeStoreV1 } from "./durable-repo-write-outcome-store.ts";
import { ReceiptSettlementStore } from "./receipt-settlement-store.ts";
import {
  runBeforeBackgroundAuthoritySettlement,
  type AuthorityDurableAcceptance
} from "./authority-durable-acceptance-context.ts";
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

export class ProductionRepoWriteOperationHost<
  Command extends DaemonHostCommand,
  Result extends DaemonHostCommandResult
> {
  private readonly options: {
    readonly repoId: string;
    readonly workspaceId: string;
    readonly generation: number;
    readonly runtime: HarnessDaemonRuntime;
    readonly authorityComponent: AuthorityRepoComponent;
    readonly hostServices: DaemonCommandHostServices<Command, Result, AuthenticatedActor>;
    readonly outcomeStore: DurableRepoWriteOutcomeStoreV1;
    readonly settlementStore: ReceiptSettlementStore;
    readonly resolveHistoricalPublication?: RepoWriteAuthorityRecoveryGateOptions["resolveHistoricalPublication"];
    readonly recoverHistoricalCommittedReceipt?: RepoWriteAuthorityRecoveryGateOptions["recoverHistoricalCommittedReceipt"];
    readonly executeDocSyncSubmit?: (input: {
      readonly command: RepoWriteCommandDto;
      readonly decoded: ReturnType<typeof decodeRepoWriteCommand>;
    }) => Promise<CommandReceiptEnvelope | undefined>;
    readonly conflictMarkerPreflight?: () => import("@harness-anything/kernel").ProjectionWarning | undefined;
    readonly now: () => Date;
    readonly newOuterOpId: () => string;
  };
  private readonly recoveryGate: RepoWriteAuthorityRecoveryGate;
  private readonly operations: RepoWriteDurableOperationController;

  constructor(options: {
    readonly repoId: string;
    readonly workspaceId: string;
    readonly generation: number;
    readonly runtime: HarnessDaemonRuntime;
    readonly authorityComponent: AuthorityRepoComponent;
    readonly hostServices: DaemonCommandHostServices<Command, Result, AuthenticatedActor>;
    readonly outcomeStore: DurableRepoWriteOutcomeStoreV1;
    readonly settlementStore: ReceiptSettlementStore;
    readonly resolveHistoricalPublication?: RepoWriteAuthorityRecoveryGateOptions["resolveHistoricalPublication"];
    readonly recoverHistoricalCommittedReceipt?: RepoWriteAuthorityRecoveryGateOptions["recoverHistoricalCommittedReceipt"];
    readonly executeDocSyncSubmit?: (input: {
      readonly command: RepoWriteCommandDto;
      readonly decoded: ReturnType<typeof decodeRepoWriteCommand>;
    }) => Promise<CommandReceiptEnvelope | undefined>;
    readonly conflictMarkerPreflight?: () => import("@harness-anything/kernel").ProjectionWarning | undefined;
    readonly now?: () => Date;
    readonly newOuterOpId?: () => string;
  }) {
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
  }

  readonly runAuthorizedRecoveryPlan: RepoWriteAuthorityRecoveryGate["runPlannedRecovery"] =
    (witness, useDurableProceeding) =>
      this.recoveryGate.runPlannedRecovery(witness, useDurableProceeding);

  readonly runAuthorizedRecoveryAttempt: RepoWriteAuthorityRecoveryGate["runAttemptRecovery"] =
    (recovery, useDurableProceeding) =>
      this.recoveryGate.runAttemptRecovery(recovery, useDurableProceeding);

  async prepare(input: RepoWritePrepareInput): Promise<RepoWritePreparedOperation> {
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

  async direct(input: RepoWriteDirectInput): Promise<import("./repo-write-protocol.ts").RepoWriteJsonObject> {
    const decoded = decodeRepoWriteCommand(input.command);
    const binding = this.options.authorityComponent.bindConnection(
      decoded.authorityConnection
    );
    const directReceipt = input.command.commandName === "doc-sync-submit"
      ? await this.options.executeDocSyncSubmit?.({ command: input.command, decoded })
      : undefined;
    if (directReceipt) return commandReceiptJsonObject(directReceipt);
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
    const commandService = createDaemonCommandService(
      this.options.runtime,
      this.options.hostServices,
      {
        resolveAuthoritySubmissionV2: () => capturingBinding,
        authorityCutoverControl: this.options.authorityComponent.cutoverControl,
        ...(this.options.conflictMarkerPreflight ? {
          conflictMarkerPreflight: this.options.conflictMarkerPreflight
        } : {})
      }
    );
    const receipt = await runBeforeBackgroundAuthoritySettlement(() => commandService.runCommand(
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
    return commandReceiptJsonObject(settleDirectAuthorityCommandReceipt({
      receipt,
      submissions: durableSubmissions,
      store: this.options.settlementStore,
      now: this.options.now
    }));
  }

  async lookup(input: RepoWriteLookupInput): Promise<RepoWriteCanonicalLookupResult> {
    const settlement = this.options.settlementStore.lookup(input.opId);
    if (settlement?.state === "canonical-visible") {
      const current = this.options.outcomeStore.lookup(input.opId);
      return current.state === "terminal"
        ? { state: "terminal", outcome: current.outcome }
        : { state: "canonical-visible", receipt: commandReceiptJsonObject(settlement.receipt) };
    }
    if (settlement?.state === "pending") {
      return { state: "accepted", receipt: commandReceiptJsonObject(settlement.receipt) };
    }
    if (settlement?.state === "failed") {
      return { state: "settlement-failed", receipt: commandReceiptJsonObject(settlement.receipt) };
    }
    const current = this.options.outcomeStore.lookup(input.opId);
    if (current.state === "not-found") return { state: "not-found" };
    if (current.state === "terminal") {
      return { state: "terminal", outcome: current.outcome };
    }
    if (current.state === "outcome-unknown") return { state: "unknown" };
    const resumed = await this.operations.resume(input.opId);
    if ("kind" in resumed && resumed.kind === "accepted") {
      return { state: "accepted", receipt: commandReceiptJsonObject(resumed.receipt) };
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
        const captured: {
          acceptance?: AuthorityDurableAcceptance;
          readonly settlement: Promise<AuthorityOperationReceipt>;
        } = { settlement: durable.settlement };
        durableSubmissions.push(captured);
        return {
          admission: durable.admission.then((admission) => {
            if (admission.kind === "accepted") captured.acceptance = admission.acceptance;
            else authorityEvidence = admission.receipt;
            return admission;
          }),
          settlement: durable.settlement.then((evidence) => {
            authorityEvidence = evidence;
            return evidence;
          })
        };
      }
    };
    const commandService = createDaemonCommandService(
      this.options.runtime,
      this.options.hostServices,
      {
        taskLeaseGuardMode: "read-only",
        ...(recovery ? { outerProceedingRecovery: true as const } : {}),
        resolveAuthoritySubmissionV2: () => capturingSubmission,
        ...(this.options.conflictMarkerPreflight ? {
          conflictMarkerPreflight: this.options.conflictMarkerPreflight
        } : {})
      }
    );
    const receipt = exactReceipt(await runBeforeBackgroundAuthoritySettlement(() => commandService.runCommand(
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
    )), proceeding, authorityEvidence);
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
        })
      };
    }
    const evidence = terminalEvidence(authorityEvidence, receipt, proceeding);
    return { kind: "terminal", receipt, authorityEvidence: evidence };
  }
}

export {
  ProductionRepoWriteOperationHost as ProductionProgressAppendOperationHost
};

function commandReceiptJsonObject(
  value: unknown
): import("./repo-write-protocol.ts").RepoWriteJsonObject {
  return JSON.parse(JSON.stringify(value)) as import("./repo-write-protocol.ts").RepoWriteJsonObject;
}

function exactReceipt(
  receipt: CommandReceiptEnvelope,
  proceeding: RepoWriteProceedingOutcomeV1,
  authorityEvidence: AuthorityOperationReceipt | undefined
): CommandReceiptEnvelope {
  const alreadySatisfied = authorityEvidence?.tag === "ALREADY_SATISFIED"
    ? {
        kind: "already-satisfied",
        message: authorityEvidence.message
      }
    : undefined;
  return {
    ...receipt,
    ...(alreadySatisfied ? { summary: alreadySatisfied.message } : {}),
    command: proceeding.receiptSeed.command,
    action: proceeding.receiptSeed.action,
    details: {
      ...(receipt.details ?? {}),
      data: {
        ...receiptDetailsData(receipt),
        ...(alreadySatisfied ? { authorityOutcome: alreadySatisfied } : {}),
        repoWrite: {
          schema: "repo-write-recovery/v1",
          repoId: proceeding.repoId,
          generation: proceeding.generation,
          outerOpId: proceeding.outerOpId
        }
      },
      actor: proceeding.canonicalCommand.actor
    },
    meta: {
      ...receipt.meta,
      generatedAt: proceeding.receiptSeed.generatedAt
    }
  };
}

function receiptDetailsData(
  receipt: CommandReceiptEnvelope
): Record<string, import("./repo-write-protocol.ts").RepoWriteJsonValue> {
  const data = receipt.details?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, import("./repo-write-protocol.ts").RepoWriteJsonValue>
    : {};
}

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
