import type { AuthorityOperationIntegrity } from "../../../kernel/src/index.ts";
import type {
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityOperationRegistry,
  AuthorityOperationState,
  RecordedAuthorityProtocol
} from "./types.ts";

type OperationIdentity = Pick<AuthorityOperationEnvelope, "workspaceId" | "opId"> & {
  readonly protocol?: AuthorityOperationEnvelope["protocol"];
  readonly recordedProtocol?: RecordedAuthorityProtocol;
};

export function createAuthorityOperationRecordPersistence(operationRegistry: AuthorityOperationRegistry): {
  readonly put: (
    envelope: OperationIdentity,
    semanticDigest: string,
    state: AuthorityOperationState,
    receipt?: AuthorityOperationReceipt,
    commitSha?: string,
    authorityIntegrity?: AuthorityOperationIntegrity,
    canonicalRequestEnvelope?: string
  ) => Promise<void>;
  readonly persistTerminal: (
    envelope: OperationIdentity,
    digest: string,
    state: Extract<AuthorityOperationState, "REJECTED" | "RETRYABLE_NOT_COMMITTED" | "INDETERMINATE">,
    receipt: AuthorityOperationReceipt,
    authorityIntegrity?: AuthorityOperationIntegrity,
    canonicalRequestEnvelope?: string
  ) => Promise<AuthorityOperationReceipt>;
} {
  const put = (
    envelope: OperationIdentity,
    semanticDigest: string,
    state: AuthorityOperationState,
    receipt?: AuthorityOperationReceipt,
    commitSha?: string,
    authorityIntegrity?: AuthorityOperationIntegrity,
    canonicalRequestEnvelope?: string
  ): Promise<void> => operationRegistry.put({
    workspaceId: envelope.workspaceId,
    opId: envelope.opId,
    semanticDigest,
    state,
    ...(receipt ? { receipt } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(authorityIntegrity ? { authorityIntegrity } : {}),
    ...(canonicalRequestEnvelope ? { canonicalRequestEnvelope } : {}),
    ...("recordedProtocol" in envelope && envelope.recordedProtocol
      ? { recordedProtocol: envelope.recordedProtocol }
      : "protocol" in envelope && envelope.protocol
        ? { recordedProtocol: { kind: "authority-operation/v1" as const, schemaTuple: envelope.protocol } }
        : {})
  });
  return {
    put,
    persistTerminal: async (envelope, digest, state, receipt, authorityIntegrity, canonicalRequestEnvelope) => {
      await put(envelope, digest, state, receipt, "commitSha" in receipt ? receipt.commitSha : undefined, authorityIntegrity, canonicalRequestEnvelope);
      return receipt;
    }
  };
}
