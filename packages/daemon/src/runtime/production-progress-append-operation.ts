import { randomUUID } from "node:crypto";
import {
  type AuthorityOperationReceipt,
  type CommandReceiptEnvelope,
  type DaemonCommandHostServices,
  type DaemonHostCommand,
  type DaemonHostCommandResult
} from "@harness-anything/application";
import { taskEntityId } from "@harness-anything/kernel";
import type {
  AuthorityRepoComponent,
  AuthorityRepoConnectionBinding
} from "../authority/authority-lifecycle.ts";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import { createDaemonCommandService } from "../service/command-service.ts";
import type { HarnessDaemonRuntime } from "./repo-runtime.ts";
import {
  RepoWriteAuthorityRecoveryGate
} from "./repo-write-authority-recovery-gate.ts";
import {
  RepoWriteDurableOperationController,
  type RepoWriteDurableExecutionResult
} from "./repo-write-durable-operation-controller.ts";
import type { RepoWriteCanonicalLookupResult } from "./repo-write-child-lookup.ts";
import type {
  RepoWriteLookupInput,
  RepoWritePrepareInput,
  RepoWritePreparedOperation
} from "./repo-write-child-host.ts";
import type { RepoWriteCommandDto } from "./repo-write-protocol.ts";
import {
  decodeRepoWriteProgressCommand
} from "./repo-write-progress-command.ts";
import {
  repoWriteActorStampDigestV1,
  repoWriteReceiptSeedSchema,
  type RepoWriteProceedingOutcomeV1,
  type RepoWriteTerminalEvidenceV1
} from "./repo-write-outcome-schema.ts";
import { DurableRepoWriteOutcomeStoreV1 } from "./durable-repo-write-outcome-store.ts";
import type {
  ProductionAuthorityProgressAppendPlanV1
} from "../authority/production/production-authority-attempt-compiler.ts";
import {
  guardProgressAppendRecoveryEffect
} from "./repo-write-progress-recovery-guard.ts";

export class ProductionProgressAppendOperationHost<
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
      assertCurrentWriterFence: options.runtime.assertWriteFenceHeld
    });
    this.operations = new RepoWriteDurableOperationController({
      repoId: options.repoId,
      workspaceId: options.workspaceId,
      generation: options.generation,
      store: options.outcomeStore,
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
        command: "progress append",
        action: "append",
        actorStampDigest: repoWriteActorStampDigestV1(input.command.actor)
      },
      recoveryContext: prepared.plan as unknown as import("./repo-write-protocol.ts").RepoWriteJsonObject
    };
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

  async lookup(input: RepoWriteLookupInput): Promise<RepoWriteCanonicalLookupResult> {
    const current = this.options.outcomeStore.lookup(input.opId);
    if (current.state === "not-found") return { state: "not-found" };
    if (current.state === "terminal") {
      return { state: "terminal", outcome: current.outcome };
    }
    if (current.state === "outcome-unknown") return { state: "unknown" };
    return {
      state: "terminal",
      outcome: await this.operations.resume(input.opId)
    };
  }

  private async prepareCommand(dto: RepoWriteCommandDto) {
    const decoded = decodeRepoWriteProgressCommand(dto);
    const binding = this.options.authorityComponent.bindConnection(
      decoded.authorityConnection
    );
    if (!binding.planProgressAppend || !binding.plannedProgressAppendSubmission) {
      throw new Error("AUTHORITY_PROGRESS_APPEND_PLANNING_UNAVAILABLE");
    }
    const command = await this.options.hostServices.normalizeCommand(
      this.options.hostServices.parseCommandPayload(dto.payload),
      decoded.currentSession
    );
    if (command.action.kind !== "progress-append" || command.action.dryRun === true) {
      throw new Error(`REPO_WRITE_COMMAND_NOT_ALLOWLISTED:${command.action.kind}`);
    }
    const authorityCommand = this.options.hostServices.authorityCommand(command);
    if (!authorityCommand || authorityCommand.action.kind !== "progress-append") {
      throw new Error("AUTHORITY_PROGRESS_APPEND_COMMAND_REQUIRED");
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
      ),
      canonicalEntityId: taskEntityId(authorityCommand.action.taskId)
    };
    return {
      binding,
      expected,
      plan: await binding.planProgressAppend(expected)
    };
  }

  private async execute(
    proceeding: RepoWriteProceedingOutcomeV1,
    recovery: boolean
  ): Promise<RepoWriteDurableExecutionResult> {
    const prepared = await this.prepareFixedCommand(proceeding.canonicalCommand);
    const plan = proceeding.recoveryContext as unknown as ProductionAuthorityProgressAppendPlanV1;
    return this.executePrepared(
      proceeding,
      prepared.binding,
      prepared.expected,
      plan,
      recovery
    );
  }

  private async prepareFixedCommand(dto: RepoWriteCommandDto) {
    const decoded = decodeRepoWriteProgressCommand(dto);
    const binding = this.options.authorityComponent.bindConnection(
      decoded.authorityConnection
    );
    if (!binding.plannedProgressAppendSubmission) {
      throw new Error("AUTHORITY_PROGRESS_APPEND_PLANNING_UNAVAILABLE");
    }
    const command = await this.options.hostServices.normalizeCommand(
      this.options.hostServices.parseCommandPayload(dto.payload),
      decoded.currentSession
    );
    const authorityCommand = this.options.hostServices.authorityCommand(command);
    if (!authorityCommand || authorityCommand.action.kind !== "progress-append") {
      throw new Error("AUTHORITY_PROGRESS_APPEND_COMMAND_REQUIRED");
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
        ),
        canonicalEntityId: taskEntityId(authorityCommand.action.taskId)
      }
    };
  }

  private async executePrepared(
    proceeding: RepoWriteProceedingOutcomeV1,
    binding: AuthorityRepoConnectionBinding,
    expected: Parameters<NonNullable<AuthorityRepoConnectionBinding["planProgressAppend"]>>[0],
    plan: ProductionAuthorityProgressAppendPlanV1,
    recovery = false
  ): Promise<RepoWriteDurableExecutionResult> {
    const decoded = decodeRepoWriteProgressCommand(proceeding.canonicalCommand);
    if (recovery) {
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
    const submission = binding.plannedProgressAppendSubmission!({
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
    const capturingSubmission = {
      submit: async (input: Parameters<typeof submission.submit>[0]) => {
        authorityEvidence = await submission.submit(input);
        return authorityEvidence;
      }
    };
    const commandService = createDaemonCommandService(
      this.options.runtime,
      this.options.hostServices,
      {
        taskLeaseGuardMode: "read-only",
        resolveAuthoritySubmissionV2: () => capturingSubmission
      }
    );
    const receipt = exactReceipt(await commandService.runCommand(
      proceeding.canonicalCommand.payload as unknown as JsonObject,
      {
        actor: decoded.actor,
        executor: decoded.executor,
        authorityConnection: {
          available: true,
          context: decoded.authorityConnection,
          assertActive: () => undefined
        }
      }
    ), proceeding);
    const evidence = terminalEvidence(authorityEvidence, receipt, proceeding);
    return { receipt, authorityEvidence: evidence };
  }
}

function exactReceipt(
  receipt: CommandReceiptEnvelope,
  proceeding: RepoWriteProceedingOutcomeV1
): CommandReceiptEnvelope {
  return {
    ...receipt,
    command: proceeding.receiptSeed.command,
    action: proceeding.receiptSeed.action,
    details: {
      ...(receipt.details ?? {}),
      data: {
        ...receiptDetailsData(receipt),
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
