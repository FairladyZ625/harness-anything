import { closeSync, readdirSync } from "node:fs";
import path from "node:path";
import type { CommandReceiptEnvelope } from "@harness-anything/application";
import { sha256Text, stableStringify } from "@harness-anything/kernel";
import { decodeRepoWriteCommandReceiptV2 } from "./repo-write-command-receipt.ts";
import {
  repoWriteOutcomeDurablePathExists,
  repoWriteOutcomeEnsurePrivateDirectory,
  repoWriteOutcomeFsyncOpened,
  repoWriteOutcomePublishOnce,
  repoWriteOutcomeReadPrivateText,
  type RepoWriteOutcomeDurabilityTestHooks
} from "./repo-write-outcome-durable-file.ts";

const prefix = "receipt-settlement-v1.";
const acceptedSuffix = ".accepted.json";
const visibleSuffix = ".visible.json";
const failureMarker = ".failure.";

interface ReceiptSettlementRecordBase {
  readonly schema: "receipt-settlement-record/v1";
  readonly receiptId: string;
  readonly repoId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly receipt: CommandReceiptEnvelope;
}

export interface ReceiptSettlementAcceptedRecord extends ReceiptSettlementRecordBase {
  readonly state: "pending";
}

export interface ReceiptSettlementVisibleRecord extends ReceiptSettlementRecordBase {
  readonly state: "canonical-visible";
}

export interface ReceiptSettlementFailedRecord extends ReceiptSettlementRecordBase {
  readonly state: "failed";
}

export type ReceiptSettlementSnapshot =
  | ReceiptSettlementAcceptedRecord
  | ReceiptSettlementVisibleRecord
  | ReceiptSettlementFailedRecord;

export interface ReceiptSettlementStoreOptions {
  readonly directory: string;
  readonly repoId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly __testOnlyDurabilityHooks?: RepoWriteOutcomeDurabilityTestHooks;
}

export class ReceiptSettlementStore {
  private readonly directory: string;
  private readonly axes: Pick<ReceiptSettlementRecordBase, "repoId" | "workspaceId" | "generation">;
  private readonly hooks: RepoWriteOutcomeDurabilityTestHooks | undefined;

  constructor(options: ReceiptSettlementStoreOptions) {
    this.directory = path.resolve(options.directory);
    this.axes = {
      repoId: options.repoId,
      workspaceId: options.workspaceId,
      generation: options.generation
    };
    this.hooks = options.__testOnlyDurabilityHooks;
    repoWriteOutcomeEnsurePrivateDirectory(this.directory);
  }

  accept(receipt: CommandReceiptEnvelope): ReceiptSettlementAcceptedRecord {
    const settlement = pendingSettlement(receipt);
    const record: ReceiptSettlementAcceptedRecord = {
      schema: "receipt-settlement-record/v1",
      ...this.axes,
      receiptId: settlement.receiptId,
      state: "pending",
      receipt
    };
    return this.publishOrRead(paths(this.directory, record.receiptId).accepted, record, "pending");
  }

  visible(receipt: CommandReceiptEnvelope): ReceiptSettlementVisibleRecord {
    const settlement = visibleSettlement(receipt);
    this.requireAccepted(settlement.receiptId);
    const record: ReceiptSettlementVisibleRecord = {
      schema: "receipt-settlement-record/v1",
      ...this.axes,
      receiptId: settlement.receiptId,
      state: "canonical-visible",
      receipt
    };
    return this.publishOrRead(paths(this.directory, record.receiptId).visible, record, "canonical-visible");
  }

  fail(receipt: CommandReceiptEnvelope): ReceiptSettlementFailedRecord {
    const settlement = failedSettlement(receipt);
    this.requireAccepted(settlement.receiptId);
    const record: ReceiptSettlementFailedRecord = {
      schema: "receipt-settlement-record/v1",
      ...this.axes,
      receiptId: settlement.receiptId,
      state: "failed",
      receipt
    };
    const text = recordText(record);
    const file = `${paths(this.directory, record.receiptId).failurePrefix}${sha256Text(text)}.json`;
    return this.publishOrRead(file, record, "failed");
  }

  lookup(receiptId: string): ReceiptSettlementSnapshot | undefined {
    const target = paths(this.directory, receiptId);
    if (repoWriteOutcomeDurablePathExists(target.visible)) {
      return readRecord(target.visible, this.hooks, "canonical-visible", receiptId);
    }
    const failures = readdirSync(this.directory)
      .filter((name) => name.startsWith(path.basename(target.failurePrefix)) && name.endsWith(".json"))
      .sort();
    const failureRecords = failures.map((name) =>
      readRecord(path.join(this.directory, name), this.hooks, "failed", receiptId) as ReceiptSettlementFailedRecord
    );
    if (failureRecords.length > 0) {
      return failureRecords.sort((left, right) =>
        failedSettlement(left.receipt).failedAt.localeCompare(failedSettlement(right.receipt).failedAt)
      ).at(-1);
    }
    if (!repoWriteOutcomeDurablePathExists(target.accepted)) return undefined;
    return readRecord(target.accepted, this.hooks, "pending", receiptId);
  }

  listUnsettled(): ReadonlyArray<ReceiptSettlementAcceptedRecord> {
    return readdirSync(this.directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith(acceptedSuffix))
      .sort()
      .map((name) => readRecord(
        path.join(this.directory, name),
        this.hooks,
        "pending"
      ) as ReceiptSettlementAcceptedRecord)
      .filter((record) => !repoWriteOutcomeDurablePathExists(paths(this.directory, record.receiptId).visible));
  }

  private requireAccepted(receiptId: string): void {
    if (!repoWriteOutcomeDurablePathExists(paths(this.directory, receiptId).accepted)) {
      throw new Error(`RECEIPT_SETTLEMENT_ACCEPTANCE_MISSING:${receiptId}`);
    }
  }

  private publishOrRead<State extends ReceiptSettlementSnapshot["state"]>(
    file: string,
    record: Extract<ReceiptSettlementSnapshot, { readonly state: State }>,
    expected: State
  ): Extract<ReceiptSettlementSnapshot, { readonly state: State }> {
    const text = recordText(record);
    if (repoWriteOutcomePublishOnce(this.directory, file, text, this.hooks)) return record;
    const current = readRecord(file, this.hooks, expected, record.receiptId) as Extract<ReceiptSettlementSnapshot, { readonly state: State }>;
    if (recordText(current) !== text) throw new Error(`RECEIPT_SETTLEMENT_IMMUTABLE_CONFLICT:${record.receiptId}`);
    return current;
  }
}

function paths(directory: string, receiptId: string) {
  const key = sha256Text(receiptId);
  const base = path.join(directory, `${prefix}${key}`);
  return {
    accepted: `${base}${acceptedSuffix}`,
    visible: `${base}${visibleSuffix}`,
    failurePrefix: `${base}${failureMarker}`
  };
}

function readRecord(
  file: string,
  hooks: RepoWriteOutcomeDurabilityTestHooks | undefined,
  expectedState: ReceiptSettlementSnapshot["state"],
  expectedReceiptId?: string
): ReceiptSettlementSnapshot {
  const { descriptor, text } = repoWriteOutcomeReadPrivateText(file);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.schema !== "receipt-settlement-record/v1"
      || parsed.state !== expectedState
      || typeof parsed.receiptId !== "string"
      || typeof parsed.repoId !== "string"
      || typeof parsed.workspaceId !== "string"
      || typeof parsed.generation !== "number") {
      throw new Error(`RECEIPT_SETTLEMENT_CORRUPT:${path.basename(file)}`);
    }
    if (expectedReceiptId && parsed.receiptId !== expectedReceiptId) {
      throw new Error(`RECEIPT_SETTLEMENT_ID_MISMATCH:${path.basename(file)}`);
    }
    const decoded = decodeRepoWriteCommandReceiptV2(parsed.receipt, "$.receipt");
    if (decoded.settlement?.receiptId !== parsed.receiptId) {
      throw new Error(`RECEIPT_SETTLEMENT_RECEIPT_INVALID:${path.basename(file)}`);
    }
    const record = { ...parsed, receipt: decoded } as unknown as ReceiptSettlementSnapshot;
    if (text !== recordText(record)) throw new Error(`RECEIPT_SETTLEMENT_NON_CANONICAL:${path.basename(file)}`);
    repoWriteOutcomeFsyncOpened(descriptor, file, hooks, "observe-existing");
    return record;
  } finally {
    closeSync(descriptor);
  }
}

function recordText(record: ReceiptSettlementSnapshot): string {
  return `${stableStringify(record)}\n`;
}

function pendingSettlement(receipt: CommandReceiptEnvelope) {
  if (receipt.settlement?.canonicalVisibility !== "pending") {
    throw new Error("RECEIPT_SETTLEMENT_PENDING_RECEIPT_REQUIRED");
  }
  return receipt.settlement;
}

function visibleSettlement(receipt: CommandReceiptEnvelope) {
  if (receipt.settlement?.canonicalVisibility !== "visible") {
    throw new Error("RECEIPT_SETTLEMENT_VISIBLE_RECEIPT_REQUIRED");
  }
  return receipt.settlement;
}

function failedSettlement(receipt: CommandReceiptEnvelope) {
  if (receipt.settlement?.canonicalVisibility !== "failed") {
    throw new Error("RECEIPT_SETTLEMENT_FAILED_RECEIPT_REQUIRED");
  }
  return receipt.settlement;
}
