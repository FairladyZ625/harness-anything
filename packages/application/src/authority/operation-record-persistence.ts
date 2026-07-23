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

export type PersistAuthorityTerminal = (
  envelope: OperationIdentity,
  digest: string,
  state: Extract<AuthorityOperationState, "COMMITTED" | "REJECTED" | "RETRYABLE_NOT_COMMITTED" | "INDETERMINATE">,
  receipt: AuthorityOperationReceipt,
  authorityIntegrity?: AuthorityOperationIntegrity,
  canonicalRequestEnvelope?: string,
  canonicalOperation?: WriteOp,
  recoveryPublicationPolicy?: AuthorityRecoveryPublicationPolicyV1,
  fixedOperationBinding?: AuthorityFixedOperationBindingV1
) => Promise<AuthorityOperationReceipt>;

export function createAuthorityOperationRecordPersistence(
  operationRegistry: AuthorityOperationRegistry,
  generationFence?: AuthorityGenerationFence
): {
  readonly put: (
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
  ): Promise<void> => operationRegistry.put({
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
  });
  return {
    put,
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
