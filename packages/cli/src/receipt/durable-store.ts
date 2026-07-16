import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  isCompoundOperationReceipt,
  type CompoundOperationReceipt,
  type CompoundReceiptStore,
  type ReceiptIdentity
} from "../../../application/src/index.ts";

export interface DurableCompoundReceiptStoreOptions {
  readonly directory: string;
}

export function createDurableCompoundReceiptStore(options: DurableCompoundReceiptStoreOptions): CompoundReceiptStore {
  const serialByKey = new Map<string, Promise<void>>();

  return {
    get: async (identity) => readReceipt(receiptPath(options.directory, identity)),
    create: (receipt) => serialized(receipt, async () => {
      const target = receiptPath(options.directory, receipt);
      const existing = readReceipt(target);
      if (existing) {
        assertSameIdentity(existing, receipt);
        return existing;
      }
      durableReplace(options.directory, target, receipt);
      return receipt;
    }),
    compareAndSet: (identity, expectedSequence, receipt) => serialized(identity, async () => {
      const target = receiptPath(options.directory, identity);
      const current = readReceipt(target);
      if (!current || current.sequence !== expectedSequence) return false;
      assertSameIdentity(current, receipt);
      if (receipt.sequence !== expectedSequence + 1) throw new Error("compound receipt sequence must advance exactly once");
      durableReplace(options.directory, target, receipt);
      return true;
    })
  };

  function serialized<Result>(identity: ReceiptIdentity, operation: () => Promise<Result>): Promise<Result> {
    const key = identityKey(identity);
    const previous = serialByKey.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    serialByKey.set(key, settled);
    void settled.finally(() => {
      if (serialByKey.get(key) === settled) serialByKey.delete(key);
    });
    return result;
  }
}

function durableReplace(directory: string, target: string, receipt: CompoundOperationReceipt): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(fileDescriptor, `${JSON.stringify(receipt)}\n`, "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporary, target);
    fsyncDirectory(directory);
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readReceipt(filePath: string): CompoundOperationReceipt | undefined {
  if (!existsSync(filePath)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isCompoundOperationReceipt(parsed)) throw new Error(`invalid durable compound receipt: ${filePath}`);
  return parsed;
}

function receiptPath(directory: string, identity: ReceiptIdentity): string {
  return path.join(directory, `${identityKey(identity)}.json`);
}

function identityKey(identity: ReceiptIdentity): string {
  return createHash("sha256")
    .update([identity.workspaceId, identity.viewId, identity.opId, identity.waiterId, identity.resultToken].join("\0"))
    .digest("hex");
}

function assertSameIdentity(left: ReceiptIdentity, right: ReceiptIdentity): void {
  if (identityKey(left) !== identityKey(right)) throw new Error("compound receipt identity is immutable");
}
