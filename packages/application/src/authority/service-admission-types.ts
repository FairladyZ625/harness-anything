import type {
  ActorAxesBindingCoreV2,
  AuthorityOperationIntegrity,
  WriteCoordinator,
  WriteOp
} from "../../../kernel/src/index.ts";
import type { AuthorityOperationReceipt, RecordedAuthorityProtocol } from "./types.ts";

export const authorityPublicationBatchSize = 8;
export const authorityPublicationMaxWaitMs = 10;

export interface PreparedAuthoritySubmission {
  readonly kind: "prepared";
  readonly workspaceId: string;
  readonly opId: string;
  readonly operation: WriteOp;
  readonly semanticDigest: string;
  readonly coordinator: WriteCoordinator;
  readonly authorityIntegrity?: AuthorityOperationIntegrity;
  readonly actorAxesBinding?: ActorAxesBindingCoreV2;
  readonly canonicalRequestEnvelope?: string;
  readonly recordedProtocol: RecordedAuthorityProtocol;
}

export interface TerminalAuthoritySubmission {
  readonly kind: "terminal";
  readonly receipt: AuthorityOperationReceipt;
}

export type AuthorityAdmission = PreparedAuthoritySubmission | TerminalAuthoritySubmission;
