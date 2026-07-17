import type { AttributionEventV2 } from "../schemas/attribution-event-union.ts";
import type {
  AuthorityAttributionEventV2AppendResult,
  AuthorityAttributionEventV2Log
} from "./authority-attribution-event-v2-log.ts";

export interface RecoverableAuthorityOperationRecordV2 {
  readonly workspaceId: string;
  readonly opId: string;
  readonly state: string;
  readonly commitSha?: string;
  readonly receipt?: {
    readonly tag: string;
    readonly workspaceId: string;
    readonly opId: string;
    readonly commitSha?: string;
  };
}

export interface DurableAuthorityOperationRecordSourceV2<
  RecordType extends RecoverableAuthorityOperationRecordV2 = RecoverableAuthorityOperationRecordV2
> {
  readonly get: (workspaceId: string, opId: string) => Promise<RecordType | undefined>;
}

export interface RecoverAuthorityAttributionEventV2Input<
  RecordType extends RecoverableAuthorityOperationRecordV2
> {
  readonly workspaceId: string;
  readonly opId: string;
  readonly operationRecords: DurableAuthorityOperationRecordSourceV2<RecordType>;
  readonly materializeExactEvent: (record: RecordType) => Promise<AttributionEventV2>;
  readonly log: AuthorityAttributionEventV2Log;
}

export async function recoverAuthorityAttributionEventV2FromOperationRecord<
  RecordType extends RecoverableAuthorityOperationRecordV2
>(input: RecoverAuthorityAttributionEventV2Input<RecordType>): Promise<AuthorityAttributionEventV2AppendResult> {
  const record = await input.operationRecords.get(input.workspaceId, input.opId);
  if (!record) throw new Error(`AUTHORITY_OPERATION_RECORD_MISSING:${input.workspaceId}:${input.opId}`);
  assertRecordIdentity(record, input.workspaceId, input.opId);
  if (!recoverableStates.has(record.state)) {
    throw new Error(`AUTHORITY_OPERATION_RECORD_NOT_RECOVERABLE:${record.state}`);
  }
  const commitSha = record.commitSha ?? record.receipt?.commitSha;
  if (!commitSha) throw new Error("AUTHORITY_OPERATION_RECORD_COMMIT_REQUIRED");
  const event = await input.materializeExactEvent(record);
  if (event.workspaceId !== record.workspaceId || event.opId !== record.opId) {
    throw new Error("AUTHORITY_OPERATION_EVENT_KEY_MISMATCH");
  }
  if (event.commitSha !== commitSha) {
    throw new Error("AUTHORITY_OPERATION_EVENT_COMMIT_MISMATCH");
  }
  return input.log.ensure(event);
}

const recoverableStates = new Set(["INDEXED", "COMMITTED", "INDETERMINATE"]);

function assertRecordIdentity(
  record: RecoverableAuthorityOperationRecordV2,
  workspaceId: string,
  opId: string
): void {
  if (record.workspaceId !== workspaceId || record.opId !== opId) {
    throw new Error("AUTHORITY_OPERATION_RECORD_KEY_MISMATCH");
  }
  if (record.receipt && (
    record.receipt.workspaceId !== workspaceId
      || record.receipt.opId !== opId
      || (record.commitSha !== undefined
        && record.receipt.commitSha !== undefined
        && record.receipt.commitSha !== record.commitSha)
  )) {
    throw new Error("AUTHORITY_OPERATION_RECORD_RECEIPT_MISMATCH");
  }
}
