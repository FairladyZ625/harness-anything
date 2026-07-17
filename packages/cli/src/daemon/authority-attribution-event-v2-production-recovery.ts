import {
  completeAuthorityCommittedReceiptV2,
  decodeSemanticMutationEnvelopeV2,
  type AuthorityCommittedEventPublisherV2,
  type AuthorityCommittedReceipt,
  type AuthorityStoredOperationRecord
} from "../../../application/src/index.ts";
import {
  actorAxesBindingCoreDigestV2,
  makeLocalAuthorityAttributionEventV2Log,
  type ActorAxesBindingCoreV2
} from "../../../kernel/src/index.ts";
import type { DurableAuthorityBindingRuntimeV2 } from "./authority-production-state.ts";
import type { DurableAuthorityServiceState } from "./authority-service-state.ts";

export async function recoverProductionAuthorityCommittedReceiptV2(input: {
  readonly record: AuthorityStoredOperationRecord;
  readonly replicaChangeLog: DurableAuthorityServiceState["replicaChangeLog"];
  readonly operationRegistry: DurableAuthorityServiceState["operationRegistry"];
  readonly bindingRuntime: DurableAuthorityBindingRuntimeV2;
  readonly eventLog: ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>;
  readonly publisher: AuthorityCommittedEventPublisherV2;
}): Promise<AuthorityCommittedReceipt> {
  const { record } = input;
  const change = await input.replicaChangeLog.getByOperation(record.workspaceId, record.opId);
  if (!change || !record.authorityIntegrity || !record.commitSha
    || change.commitSha !== record.commitSha
    || change.semanticDigest !== record.semanticDigest
    || change.authorityIntegrity?.semanticMutationSetDigest !== record.authorityIntegrity.semanticMutationSetDigest) {
    throw new Error("AUTHORITY_V2_RECOVERY_CHANGE_MISMATCH");
  }
  if (!record.canonicalRequestEnvelope) throw new Error("AUTHORITY_V2_RECOVERY_ENVELOPE_REQUIRED");
  const envelope = decodeSemanticMutationEnvelopeV2(Buffer.from(record.canonicalRequestEnvelope, "base64url"));
  const binding = await input.bindingRuntime.getBinding(envelope.binding.bindingId);
  if (!binding) throw new Error("AUTHORITY_V2_RECOVERY_BINDING_REQUIRED");
  const actorAxesBinding: ActorAxesBindingCoreV2 = {
    bindingId: binding.bindingId,
    principalPersonId: binding.principalPersonId,
    executorAgentId: binding.executorAgentId,
    workspaceId: binding.workspaceId,
    deviceId: binding.deviceId,
    viewId: binding.viewId,
    sessionId: binding.sessionId,
    schemaTuple: envelope.schemaTuple
  };
  if (hex(actorAxesBindingCoreDigestV2(actorAxesBinding)) !== record.authorityIntegrity.actorAxesBindingDigest) {
    throw new Error("AUTHORITY_V2_RECOVERY_ACTOR_BINDING_MISMATCH");
  }
  const baseReceipt: AuthorityCommittedReceipt = {
    tag: "COMMITTED",
    workspaceId: record.workspaceId,
    opId: record.opId,
    semanticDigest: record.semanticDigest,
    revision: change.revision,
    commitSha: change.commitSha,
    previousCommit: change.previousCommit,
    authorityIntegrity: record.authorityIntegrity
  };
  await input.eventLog.recoverFromOperationRecord({
    workspaceId: record.workspaceId,
    opId: record.opId,
    operationRecords: input.operationRegistry,
    materializeExactEvent: async () => input.publisher.publish({
      receipt: baseReceipt,
      actorAxesBinding,
      occurredAt: change.changedAt
    })
  });
  return completeAuthorityCommittedReceiptV2({
    publisher: input.publisher,
    receipt: baseReceipt,
    actorAxesBinding,
    occurredAt: change.changedAt
  });
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function withProductionRecoveryV2(input: {
  readonly publisher: AuthorityCommittedEventPublisherV2;
  readonly replicaChangeLog: DurableAuthorityServiceState["replicaChangeLog"];
  readonly operationRegistry: DurableAuthorityServiceState["operationRegistry"];
  readonly bindingRuntime: DurableAuthorityBindingRuntimeV2;
  readonly eventLog: ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>;
}): AuthorityCommittedEventPublisherV2 & {
  recoverCommittedReceipt: (record: AuthorityStoredOperationRecord) => Promise<AuthorityCommittedReceipt>;
} {
  return {
    ...input.publisher,
    recoverCommittedReceipt: (record) => recoverProductionAuthorityCommittedReceiptV2({
      record,
      replicaChangeLog: input.replicaChangeLog,
      operationRegistry: input.operationRegistry,
      bindingRuntime: input.bindingRuntime,
      eventLog: input.eventLog,
      publisher: input.publisher
    })
  };
}
