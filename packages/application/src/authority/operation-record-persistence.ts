import type { AuthorityOperationIntegrity, WriteOp } from "@harness-anything/kernel";
import type {
  AuthorityOperationEnvelope,
  AuthorityGenerationFence,
  AuthorityOperationReceipt,
  AuthorityOperationRegistry,
  AuthorityOperationState,
  AuthorityFixedOperationBindingV1,
  AuthorityRecoveryPublicationPolicyV1,
  RecordedAuthorityProtocol
} from "./types.ts";

type OperationIdentity = Pick<AuthorityOperationEnvelope, "workspaceId" | "opId"> & {
  readonly protocol?: AuthorityOperationEnvelope["protocol"];
  readonly recordedProtocol?: RecordedAuthorityProtocol;
};

interface AuthorityOperationRecordTransition {
  readonly envelope: OperationIdentity;
  readonly semanticDigest: string;
  readonly state: AuthorityOperationState;
  readonly receipt?: AuthorityOperationReceipt;
  readonly commitSha?: string;
  readonly authorityIntegrity?: AuthorityOperationIntegrity;
  readonly canonicalRequestEnvelope?: string;
  readonly canonicalOperation?: WriteOp;
  readonly recoveryPublicationPolicy?: AuthorityRecoveryPublicationPolicyV1;
  readonly fixedOperationBinding?: AuthorityFixedOperationBindingV1;
}

export type PersistAuthorityTerminal = (
  envelope: OperationIdentity,
  digest: string,
  state: Extract<AuthorityOperationState, "COMMITTED" | "ALREADY_SATISFIED" | "REJECTED" | "RETRYABLE_NOT_COMMITTED" | "INDETERMINATE">,
  receipt: AuthorityOperationReceipt,
  authorityIntegrity?: AuthorityOperationIntegrity,
  canonicalRequestEnvelope?: string,
  canonicalOperation?: WriteOp,
  recoveryPublicationPolicy?: AuthorityRecoveryPublicationPolicyV1,
  fixedOperationBinding?: AuthorityFixedOperationBindingV1
) => Promise<AuthorityOperationReceipt>;

export type PutAuthorityOperationRecord = (
  envelope: OperationIdentity,
  semanticDigest: string,
  state: AuthorityOperationState,
  receipt?: AuthorityOperationReceipt,
  commitSha?: string,
  authorityIntegrity?: AuthorityOperationIntegrity,
  canonicalRequestEnvelope?: string,
  canonicalOperation?: WriteOp,
  recoveryPublicationPolicy?: AuthorityRecoveryPublicationPolicyV1,
  fixedOperationBinding?: AuthorityFixedOperationBindingV1
) => Promise<void>;

export function createAuthorityOperationRecordPersistence(
  operationRegistry: AuthorityOperationRegistry,
  generationFence?: AuthorityGenerationFence
): {
  readonly put: PutAuthorityOperationRecord;
  readonly putMany: (records: ReadonlyArray<AuthorityOperationRecordTransition>) => Promise<void>;
  readonly persistTerminal: PersistAuthorityTerminal;
} {
  const put = (
    envelope: OperationIdentity,
    semanticDigest: string,
    state: AuthorityOperationState,
    receipt?: AuthorityOperationReceipt,
    commitSha?: string,
    authorityIntegrity?: AuthorityOperationIntegrity,
    canonicalRequestEnvelope?: string,
    canonicalOperation?: WriteOp,
    recoveryPublicationPolicy?: AuthorityRecoveryPublicationPolicyV1,
    fixedOperationBinding?: AuthorityFixedOperationBindingV1
  ): Promise<void> => operationRegistry.put(operationRecord(
    envelope,
    semanticDigest,
    state,
    receipt,
    commitSha,
    authorityIntegrity,
    canonicalRequestEnvelope,
    canonicalOperation,
    recoveryPublicationPolicy,
    fixedOperationBinding
  ));
  const putMany = async (records: ReadonlyArray<AuthorityOperationRecordTransition>): Promise<void> => {
    const stored = records.map((record) => operationRecord(
      record.envelope,
      record.semanticDigest,
      record.state,
      record.receipt,
      record.commitSha,
      record.authorityIntegrity,
      record.canonicalRequestEnvelope,
      record.canonicalOperation,
      record.recoveryPublicationPolicy,
      record.fixedOperationBinding
    ));
    if (operationRegistry.putMany) await operationRegistry.putMany(stored);
    else for (const record of stored) await operationRegistry.put(record);
  };
  return {
    put,
    putMany,
    persistTerminal: async (
      envelope,
      digest,
      state,
      receipt,
      authorityIntegrity,
      canonicalRequestEnvelope,
      canonicalOperation,
      recoveryPublicationPolicy,
      fixedOperationBinding
    ) => {
      const persist = async () => {
        await put(
          envelope,
          digest,
          state,
          receipt,
          "commitSha" in receipt ? receipt.commitSha : undefined,
          authorityIntegrity,
          canonicalRequestEnvelope,
          canonicalOperation,
          recoveryPublicationPolicy,
          fixedOperationBinding
        );
        return receipt;
      };
      return generationFence
        ? generationFence.runExclusive("before-terminal-journal", envelope, persist)
        : persist();
    }
  };
}

function operationRecord(
  envelope: OperationIdentity,
  semanticDigest: string,
  state: AuthorityOperationState,
  receipt?: AuthorityOperationReceipt,
  commitSha?: string,
  authorityIntegrity?: AuthorityOperationIntegrity,
  canonicalRequestEnvelope?: string,
  canonicalOperation?: WriteOp,
  recoveryPublicationPolicy?: AuthorityRecoveryPublicationPolicyV1,
  fixedOperationBinding?: AuthorityFixedOperationBindingV1
): import("./types.ts").AuthorityStoredOperationRecord {
  return {
    workspaceId: envelope.workspaceId,
    opId: envelope.opId,
    semanticDigest,
    state,
    ...(receipt ? { receipt } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(authorityIntegrity ? { authorityIntegrity } : {}),
    ...(canonicalRequestEnvelope ? { canonicalRequestEnvelope } : {}),
    ...(canonicalOperation ? { canonicalOperation } : {}),
    ...(recoveryPublicationPolicy ? { recoveryPublicationPolicy } : {}),
    ...(fixedOperationBinding ? { fixedOperationBinding } : {}),
    ...("recordedProtocol" in envelope && envelope.recordedProtocol
      ? { recordedProtocol: envelope.recordedProtocol }
      : "protocol" in envelope && envelope.protocol
        ? { recordedProtocol: { kind: "authority-operation/v1" as const, schemaTuple: envelope.protocol } }
        : {})
  };
}
