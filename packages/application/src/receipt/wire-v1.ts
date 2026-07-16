import { isRecord } from "../record.ts";
import { preparedReceiptDigestV2 } from "./v2-integrity.ts";
import { isCompoundOperationReceiptV2 } from "./validation-v2.ts";
import { assertHistoricalExcludedSetWitnessV1, type HistoricalExcludedSetWitnessV1 } from "./witness-v1.ts";
import type {
  CompoundOperationReceiptV2,
  CompoundReceiptServiceV2,
  ReceiptIdentityV2
} from "./v2-types.ts";

export const compoundReceiptWireTypeV1 = "harness-compound-receipt-wire/v1" as const;

interface CompoundWireFrameV1 {
  readonly type: typeof compoundReceiptWireTypeV1;
}

export interface OpenWaiterFrameV1 extends CompoundWireFrameV1 {
  readonly kind: "OPEN_WAITER";
  readonly requestId: string;
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
}

export interface WaiterOpenedFrameV1 extends CompoundWireFrameV1 {
  readonly kind: "WAITER_OPENED";
  readonly requestId: string;
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
  readonly waiterId: string;
  readonly resultToken: string;
}

export interface ResultPreparedFrameV1 extends CompoundWireFrameV1 {
  readonly kind: "RESULT_PREPARED";
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
  readonly waiterId: string;
  readonly preparedSequence: number;
  readonly preparedReceiptDigest: string;
  readonly receipt: CompoundOperationReceiptV2;
  readonly historicalWitness: HistoricalExcludedSetWitnessV1;
}

export interface DeliveryAckFrameV1 extends CompoundWireFrameV1 {
  readonly kind: "DELIVERY_ACK";
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
  readonly waiterId: string;
  readonly resultToken: string;
  readonly preparedSequence: number;
  readonly preparedReceiptDigest: string;
}

export interface AckCommittedFrameV1 extends CompoundWireFrameV1 {
  readonly kind: "ACK_COMMITTED";
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
  readonly waiterId: string;
  readonly preparedSequence: number;
  readonly preparedReceiptDigest: string;
  readonly terminalLSN: number;
  readonly receipt: CompoundOperationReceiptV2;
}

export interface GetWaiterFrameV1 extends CompoundWireFrameV1 {
  readonly kind: "GET_WAITER";
  readonly requestId: string;
  readonly workspaceId: string;
  readonly viewId: string;
  readonly opId: string;
  readonly waiterId: string;
  readonly resultToken: string;
}

export interface WaiterStateFrameV1 extends CompoundWireFrameV1 {
  readonly kind: "WAITER_STATE";
  readonly requestId: string;
  readonly state: "NOT_FOUND" | "RECEIPT";
  readonly receipt?: CompoundOperationReceiptV2;
}

export type CompoundReceiptWireFrameV1 =
  | OpenWaiterFrameV1
  | WaiterOpenedFrameV1
  | ResultPreparedFrameV1
  | DeliveryAckFrameV1
  | AckCommittedFrameV1
  | GetWaiterFrameV1
  | WaiterStateFrameV1;

export interface CompoundReceiptWireBrokerV1 {
  readonly handle: (
    frame: OpenWaiterFrameV1 | DeliveryAckFrameV1 | GetWaiterFrameV1
  ) => Promise<WaiterOpenedFrameV1 | AckCommittedFrameV1 | WaiterStateFrameV1>;
  readonly resultPrepared: (receipt: CompoundOperationReceiptV2) => ResultPreparedFrameV1;
}

export function createCompoundReceiptWireBrokerV1(
  service: CompoundReceiptServiceV2
): CompoundReceiptWireBrokerV1 {
  return {
    handle: async (frame) => {
      if (frame.kind === "OPEN_WAITER") {
        const opened = await service.openWaiter({
          workspaceId: frame.workspaceId,
          viewId: frame.viewId,
          opId: frame.opId
        });
        return {
          type: compoundReceiptWireTypeV1,
          kind: "WAITER_OPENED",
          requestId: frame.requestId,
          ...opened.identity,
          resultToken: opened.resultToken
        };
      }
      if (frame.kind === "DELIVERY_ACK") {
        const receipt = await service.commitAcknowledgement(frame);
        const acknowledgement = receipt.acknowledgement;
        if (!acknowledgement || receipt.terminalLSN === undefined) throw new Error("COMPOUND_ACK_DURABILITY_INCOMPLETE");
        return {
          type: compoundReceiptWireTypeV1,
          kind: "ACK_COMMITTED",
          workspaceId: receipt.workspaceId,
          viewId: receipt.viewId,
          opId: receipt.opId,
          waiterId: receipt.waiterId,
          preparedSequence: acknowledgement.preparedSequence,
          preparedReceiptDigest: acknowledgement.preparedReceiptDigest,
          terminalLSN: receipt.terminalLSN,
          receipt
        };
      }
      const receipt = await service.getWaiter(frame);
      return {
        type: compoundReceiptWireTypeV1,
        kind: "WAITER_STATE",
        requestId: frame.requestId,
        state: receipt ? "RECEIPT" : "NOT_FOUND",
        ...(receipt ? { receipt } : {})
      };
    },
    resultPrepared: (receipt) => {
      if (receipt.delivery !== "RESULT_PREPARED" || receipt.origin?.tag !== "APPLIED_EXACT_AT_CUT") {
        throw new Error("COMPOUND_RESULT_NOT_PREPARED");
      }
      return {
        type: compoundReceiptWireTypeV1,
        kind: "RESULT_PREPARED",
        workspaceId: receipt.workspaceId,
        viewId: receipt.viewId,
        opId: receipt.opId,
        waiterId: receipt.waiterId,
        preparedSequence: receipt.sequence,
        preparedReceiptDigest: preparedReceiptDigestV2(receipt),
        receipt,
        historicalWitness: receipt.origin.witness
      };
    }
  };
}

export function encodeCompoundReceiptWireFrameV1(frame: CompoundReceiptWireFrameV1): Uint8Array {
  validateFrame(frame);
  return Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
}

export function decodeCompoundReceiptWireFrameV1(value: Uint8Array | string | unknown): CompoundReceiptWireFrameV1 {
  const parsed: unknown = value instanceof Uint8Array
    ? JSON.parse(Buffer.from(value).toString("utf8"))
    : typeof value === "string" ? JSON.parse(value) : value;
  validateFrame(parsed);
  return parsed;
}

function validateFrame(value: unknown): asserts value is CompoundReceiptWireFrameV1 {
  if (!isRecord(value) || value.type !== compoundReceiptWireTypeV1 || typeof value.kind !== "string") {
    throw new Error("COMPOUND_RECEIPT_WIRE_SCHEMA_INVALID");
  }
  if (value.kind === "OPEN_WAITER") {
    exact(value, ["type", "kind", "requestId", "workspaceId", "viewId", "opId"]);
    strings(value, ["requestId", "workspaceId", "viewId", "opId"]);
    return;
  }
  if (value.kind === "WAITER_OPENED") {
    exact(value, ["type", "kind", "requestId", "workspaceId", "viewId", "opId", "waiterId", "resultToken"]);
    strings(value, ["requestId", "workspaceId", "viewId", "opId", "waiterId", "resultToken"]);
    return;
  }
  if (value.kind === "RESULT_PREPARED") {
    exact(value, ["type", "kind", "workspaceId", "viewId", "opId", "waiterId", "preparedSequence", "preparedReceiptDigest", "receipt", "historicalWitness"]);
    strings(value, ["workspaceId", "viewId", "opId", "waiterId", "preparedReceiptDigest"]);
    compoundWireUint(value.preparedSequence, "preparedSequence");
    compoundWireDigest(value.preparedReceiptDigest, "preparedReceiptDigest");
    if (!isCompoundOperationReceiptV2(value.receipt) || value.receipt.delivery !== "RESULT_PREPARED"
      || value.receipt.sequence !== value.preparedSequence
      || preparedReceiptDigestV2(value.receipt) !== value.preparedReceiptDigest
      || value.receipt.origin?.tag !== "APPLIED_EXACT_AT_CUT"
      || !sameIdentity(value, value.receipt)) {
      throw new Error("COMPOUND_RECEIPT_WIRE_PREPARED_INVALID");
    }
    assertHistoricalExcludedSetWitnessV1(value.historicalWitness as HistoricalExcludedSetWitnessV1);
    if ((value.historicalWitness as HistoricalExcludedSetWitnessV1).canonicalWitnessDigest
      !== value.receipt.origin.witnessDigest) throw new Error("COMPOUND_RECEIPT_WIRE_PREPARED_INVALID");
    return;
  }
  if (value.kind === "DELIVERY_ACK") {
    exact(value, ["type", "kind", "workspaceId", "viewId", "opId", "waiterId", "resultToken", "preparedSequence", "preparedReceiptDigest"]);
    strings(value, ["workspaceId", "viewId", "opId", "waiterId", "resultToken", "preparedReceiptDigest"]);
    compoundWireUint(value.preparedSequence, "preparedSequence");
    compoundWireDigest(value.preparedReceiptDigest, "preparedReceiptDigest");
    return;
  }
  if (value.kind === "ACK_COMMITTED") {
    exact(value, ["type", "kind", "workspaceId", "viewId", "opId", "waiterId", "preparedSequence", "preparedReceiptDigest", "terminalLSN", "receipt"]);
    strings(value, ["workspaceId", "viewId", "opId", "waiterId", "preparedReceiptDigest"]);
    compoundWireUint(value.preparedSequence, "preparedSequence");
    compoundWireUint(value.terminalLSN, "terminalLSN");
    compoundWireDigest(value.preparedReceiptDigest, "preparedReceiptDigest");
    if (!isCompoundOperationReceiptV2(value.receipt) || value.receipt.delivery !== "ACK_COMMITTED"
      || value.receipt.terminalLSN !== value.terminalLSN || !sameIdentity(value, value.receipt)
      || value.receipt.acknowledgement?.preparedSequence !== value.preparedSequence
      || value.receipt.acknowledgement?.preparedReceiptDigest !== value.preparedReceiptDigest) {
      throw new Error("COMPOUND_RECEIPT_WIRE_ACK_INVALID");
    }
    return;
  }
  if (value.kind === "GET_WAITER") {
    exact(value, ["type", "kind", "requestId", "workspaceId", "viewId", "opId", "waiterId", "resultToken"]);
    strings(value, ["requestId", "workspaceId", "viewId", "opId", "waiterId", "resultToken"]);
    return;
  }
  if (value.kind === "WAITER_STATE") {
    exact(value, value.state === "RECEIPT" ? ["type", "kind", "requestId", "state", "receipt"] : ["type", "kind", "requestId", "state"]);
    strings(value, ["requestId", "state"]);
    if (value.state !== "NOT_FOUND" && value.state !== "RECEIPT") throw new Error("COMPOUND_RECEIPT_WIRE_STATE_INVALID");
    if ((value.state === "RECEIPT") !== isCompoundOperationReceiptV2(value.receipt)) {
      throw new Error("COMPOUND_RECEIPT_WIRE_STATE_INVALID");
    }
    return;
  }
  throw new Error(`COMPOUND_RECEIPT_WIRE_KIND_UNSUPPORTED:${value.kind}`);
}

function exact(value: Record<string, unknown>, keys: ReadonlyArray<string>): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("COMPOUND_RECEIPT_WIRE_FIELDS_INVALID");
}

function strings(value: Record<string, unknown>, keys: ReadonlyArray<string>): void {
  for (const key of keys) if (typeof value[key] !== "string" || value[key] === "") {
    throw new Error(`COMPOUND_RECEIPT_WIRE_FIELD_INVALID:${key}`);
  }
}

function compoundWireUint(value: unknown, key: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`COMPOUND_RECEIPT_WIRE_FIELD_INVALID:${key}`);
}

function compoundWireDigest(value: unknown, key: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`COMPOUND_RECEIPT_WIRE_FIELD_INVALID:${key}`);
}

function sameIdentity(
  left: { readonly workspaceId?: unknown; readonly viewId?: unknown; readonly opId?: unknown; readonly waiterId?: unknown },
  right: ReceiptIdentityV2
): boolean {
  return left.workspaceId === right.workspaceId && left.viewId === right.viewId
    && left.opId === right.opId && left.waiterId === right.waiterId;
}

export function receiptIdentityFromWireV1(frame: { readonly workspaceId: string; readonly viewId: string; readonly opId: string; readonly waiterId: string }): ReceiptIdentityV2 {
  return { workspaceId: frame.workspaceId, viewId: frame.viewId, opId: frame.opId, waiterId: frame.waiterId };
}
