import type {
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt
} from "@harness-anything/application";
import { ReplicaBroker } from "./replica-broker.ts";
import type { AuthoritySubmissionClient } from "./types.ts";

export interface AuthoredSubmissionResult {
  readonly receipt: AuthorityOperationReceipt;
  readonly conflictId?: string;
}

export class BrokerSubmissionCoordinator {
  private readonly broker: ReplicaBroker;
  private readonly authority: AuthoritySubmissionClient;

  constructor(options: { readonly broker: ReplicaBroker; readonly authority: AuthoritySubmissionClient }) {
    this.broker = options.broker;
    this.authority = options.authority;
  }

  async submitAuthored(pathName: string, envelope: AuthorityOperationEnvelope): Promise<AuthoredSubmissionResult> {
    await this.broker.prepareSubmission(pathName, envelope.opId);
    let receipt: AuthorityOperationReceipt;
    try {
      receipt = await this.authority.submit(envelope);
    } catch (error) {
      await this.broker.markSubmissionUnknown(pathName, envelope.opId);
      throw error;
    }
    if (receipt.tag === "REJECTED") {
      const conflictId = await this.broker.returnRejectedSubmission(pathName, envelope.opId, receipt.reason);
      return { receipt, conflictId };
    }
    if (receipt.tag === "INDETERMINATE") await this.broker.markSubmissionUnknown(pathName, envelope.opId);
    if (receipt.tag === "RETRYABLE_NOT_COMMITTED") await this.broker.markSubmissionRetryable(pathName, envelope.opId);
    return { receipt };
  }

  async reconcileUnknown(pathName: string, opId: string): Promise<AuthoredSubmissionResult | undefined> {
    const record = await this.authority.getOperation(opId);
    if (!record?.receipt) return undefined;
    const receipt = record.receipt;
    if (receipt.tag === "REJECTED") {
      const conflictId = await this.broker.returnRejectedSubmission(pathName, opId, receipt.reason);
      return { receipt, conflictId };
    }
    if (receipt.tag === "RETRYABLE_NOT_COMMITTED") {
      await this.broker.markSubmissionRetryable(pathName, opId);
    }
    return { receipt };
  }
}
