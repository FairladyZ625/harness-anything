export interface DispatchRecordLeaseSettlement {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly leaseVersion: number;
  readonly endedAt: string;
}
