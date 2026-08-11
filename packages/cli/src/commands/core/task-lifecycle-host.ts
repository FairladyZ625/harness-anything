import { createHash, randomBytes } from "node:crypto";
import { Effect } from "effect";
import { makeTaskLifecycleService } from "../../../../application/src/index.ts";
import {
  makeTaskEventStore,
  makeTaskLeaseStore,
  makeTaskProjection,
  type ActorAxes,
  type CompleteTaskCommand,
  type ProofFor,
  type TaskLifecycleCommand
} from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import type { CliResult, TaskLifecycleCliAction } from "../../cli/types.ts";
import {
  runTaskLifecycleFacade,
  type TaskLifecycleReceipt,
  type TaskLifecycleServiceInput,
  type TaskLifecycleServicePort
} from "./task-lifecycle.ts";

const leaseTtlMs = 30 * 60 * 1_000;

export const runTaskLifecycleFacadeCommand: CommandRunner = (context, command) => Effect.promise(async () => {
  if (!isTaskLifecycleAction(command.action)) throw new Error(`Unexpected lifecycle action ${command.action.kind}.`);
  const receipt = await runTaskLifecycleFacade(command.action, {
    actor: actorAxes(context),
    service: makeTaskLifecycleHost(context)
  });
  return cliResult(command.action, receipt);
});

export function makeTaskLifecycleHost(context: CommandRunnerContext): TaskLifecycleServicePort {
  const eventStore = makeTaskEventStore({
    rootInput: context.layoutInput,
    coordinator: context.makeWriteCoordinator(context.actorAttribution().actor)
  });
  const projection = makeTaskProjection({ rootDir: context.rootDir, eventStore });
  const leases = makeTaskLeaseStore({ rootDir: context.rootDir });
  const service = makeTaskLifecycleService({ eventStore, projection, leases });

  return {
    show: async ({ taskId }) => {
      const read = await service.read(taskId);
      return read.status === "ready"
        ? { outcome: "applied", revision: read.sourceRevision, evidence: JSON.stringify(read.snapshot) }
        : {
            outcome: "pending",
            revision: read.sourceRevision,
            evidence: JSON.stringify(read.snapshot),
            nextAction: `Retry \`ha task show ${taskId}\` after the projection catches up.`
          };
    },
    execute: async (input) => {
      const before = eventStore.read();
      const existing = before.events.find((event) => event.opId === input.command.opId);
      const command = withServerMeta(input.command, existing ?? null, before.revision);
      const read = await service.read(command.taskId);
      let issuedCredential: { readonly plaintext: string; readonly hash: string; readonly expiresAt: string } | undefined;
      if (command.type === "StartExecution" && existing === undefined) {
        const plaintext = randomBytes(32).toString("base64url");
        issuedCredential = {
          plaintext,
          hash: credentialHash(plaintext),
          expiresAt: new Date(Date.now() + leaseTtlMs).toISOString()
        };
      }
      const proof = proofFor(command, input, read.snapshot, read.sourceRevision, issuedCredential);
      const result = await service.execute(command, proof);
      const receipt = operationReceipt(command, result);
      if (command.type === "StartExecution" && existing !== undefined && result.status === "applied") {
        return {
          ...receipt,
          nextAction: "This start was already applied; the one-time lease credential is not reissued. Use the credential saved from the original receipt."
        };
      }
      if (command.type !== "StartExecution" || issuedCredential === undefined || result.status !== "applied") return receipt;
      if (result.snapshot.lease?.credentialHash !== issuedCredential.hash) {
        return {
          outcome: "indeterminate",
          opId: command.opId,
          code: "lease_publication_unknown",
          origin: "task-lifecycle-host",
          nextAction: `Run \`ha task show ${command.taskId}\`; the lease credential was not issued because its active reservation could not be proven.`
        };
      }
      return {
        ...receipt,
        leaseCredential: issuedCredential.plaintext,
        leaseExpiry: issuedCredential.expiresAt,
        nextAction: "Save leaseCredential now; it is shown once and `ha task submit --lease-credential <credential>` requires it. Lost credentials are not reissued."
      };
    }
  };
}

function withServerMeta(
  command: TaskLifecycleServiceInput["command"],
  existing: { readonly eventId: string; readonly workspaceRevision: number; readonly occurredAt: string } | null,
  revision: number
): TaskLifecycleCommand {
  return {
    ...command,
    eventId: existing?.eventId ?? `event-${createHash("sha256").update(command.opId).digest("hex")}`,
    workspaceRevision: existing?.workspaceRevision ?? revision + 1,
    occurredAt: existing?.occurredAt ?? new Date().toISOString()
  } as TaskLifecycleCommand;
}

function proofFor(
  command: TaskLifecycleCommand,
  input: TaskLifecycleServiceInput,
  snapshot: Awaited<ReturnType<ReturnType<typeof makeTaskLifecycleService>["read"]>>["snapshot"],
  expectedRevision: number,
  issuedCredential: { readonly hash: string; readonly expiresAt: string } | undefined
): ProofFor<typeof command> {
  if (command.type === "CreateReplayTask") return { taskIdUnique: true, actorBinding: command.actor };
  if (command.type === "StartExecution") {
    const reservation = issuedCredential ?? { hash: "already-issued", expiresAt: new Date().toISOString() };
    return {
      actorBinding: command.actor,
      expectedRevision,
      reservation: {
        taskId: command.taskId,
        executionId: command.executionId,
        credentialHash: reservation.hash,
        expiresAt: reservation.expiresAt,
        version: 0
      }
    };
  }
  if (command.type === "SubmitExecution") {
    if (!input.credential) throw hostError("missing_lease_credential", "Submit requires the one-time --lease-credential returned by task start.");
    return { expectedRevision, credentialHash: credentialHash(input.credential), sessionDisposition: "unavailable" };
  }
  if (command.type === "RecordReview") {
    return {
      expectedRevision,
      actorBinding: command.actor,
      capability: command.kind === "anti_entropy" ? "anti-entropy@v1" : "acceptance-review@v1",
      capabilityRef: input.capabilityRef ?? `cli-${command.kind}:${command.opId}`,
      archiveWarningsPresent: false
    };
  }
  return completeProof(command, input, snapshot, expectedRevision);
}

function completeProof(
  command: CompleteTaskCommand,
  input: TaskLifecycleServiceInput,
  snapshot: Awaited<ReturnType<ReturnType<typeof makeTaskLifecycleService>["read"]>>["snapshot"],
  expectedRevision: number
): ProofFor<CompleteTaskCommand> {
  const declared = snapshot.task?.completionGateIds ?? [];
  const supplied = validateGateReceiptSet(declared, input.gateReceipts ?? []);
  const execution = snapshot.executions.find((candidate) => candidate.executionId === command.executionId && candidate.submission !== null);
  if (execution?.submission === null || execution === undefined) {
    throw hostError("invalid_transition", `Run \`ha task show ${command.taskId}\`; complete requires the current submitted Execution.`);
  }
  return {
    expectedRevision,
    capability: "task-complete@v1",
    capabilityRef: `cli-task-complete:${command.opId}`,
    actorRole: "owner",
    noActiveLease: true,
    gateReceipts: supplied.map((receipt) => ({
      gateId: receipt.gateId,
      receiptRef: receipt.receiptRef,
      result: "pass" as const,
      executionId: execution.executionId,
      commitSha: execution.submission!.commitSha,
      iteration: execution.iteration
    }))
  };
}

export function validateGateReceiptSet(
  declared: readonly string[],
  supplied: readonly { readonly gateId: string; readonly receiptRef: string }[]
): readonly { readonly gateId: string; readonly receiptRef: string }[] {
  const counts = new Map<string, number>();
  for (const receipt of supplied) counts.set(receipt.gateId, (counts.get(receipt.gateId) ?? 0) + 1);
  const declaredSet = new Set(declared);
  const missing = declared.filter((gateId) => !counts.has(gateId));
  const unknown = [...counts.keys()].filter((gateId) => !declaredSet.has(gateId));
  const duplicate = [...counts].filter(([, count]) => count !== 1).map(([gateId]) => gateId);
  const emptyRefs = supplied.filter((receipt) => receipt.receiptRef.trim().length === 0).map((receipt) => receipt.gateId);
  if (missing.length > 0 || unknown.length > 0 || duplicate.length > 0 || emptyRefs.length > 0) {
    throw hostError(
      "gate_receipt_mismatch",
      `Gate receipt set must match declared gates exactly; missing=[${missing.join(",")}], unknown=[${unknown.join(",")}], duplicate=[${duplicate.join(",")}], emptyRef=[${emptyRefs.join(",")}]. Supply one --gate-receipt <gate-id>:<receipt-ref> for each declared gate.`
    );
  }
  return supplied;
}

function operationReceipt(
  command: TaskLifecycleCommand,
  result: Awaited<ReturnType<ReturnType<typeof makeTaskLifecycleService>["execute"]>>
): TaskLifecycleReceipt {
  if (result.status === "applied") {
    return {
      outcome: "applied",
      opId: command.opId,
      revision: result.revision,
      evidence: result.event ? `task-event:${result.event.eventId}` : `task-revision:${result.revision}`,
    };
  }
  if (result.status === "pending") {
    return {
      outcome: "pending",
      opId: command.opId,
      revision: result.revision,
      nextAction: result.query ?? `Retry \`ha task show ${command.taskId}\` after projection catch-up.`
    };
  }
  return {
    outcome: "indeterminate",
    opId: command.opId,
    revision: result.revision,
    code: "publication_unknown",
    origin: "task-event-store",
    nextAction: result.query ?? `Run \`ha task show ${command.taskId}\` before retrying.`
  };
}

function credentialHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function actorAxes(context: CommandRunnerContext): ActorAxes {
  const principal = context.taskHolderPrincipal();
  return {
    principal: { personId: principal.principal.personId },
    executor: principal.executor
  };
}

function isTaskLifecycleAction(action: { readonly kind: string }): action is TaskLifecycleCliAction {
  return ["task-create", "task-start", "task-submit", "task-review-execution", "task-complete", "task-show"].includes(action.kind);
}

function cliResult(action: TaskLifecycleCliAction, receipt: TaskLifecycleReceipt): CliResult {
  const { leaseCredential: _leaseCredential, ...publicReport } = receipt;
  const common = {
    command: action.kind,
    taskId: action.taskId,
    ...(action.verb !== "create" && action.verb !== "show" ? { executionId: action.executionId } : {}),
    ...receipt,
    report: publicReport
  };
  if (receipt.outcome === "applied" || receipt.outcome === "pending") return { ok: true, ...common };
  return {
    ok: false,
    ...common,
    error: cliError(CliErrorCode.WriteRejected, receipt.nextAction)
  };
}

function hostError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, origin: "task-lifecycle-host" });
}
