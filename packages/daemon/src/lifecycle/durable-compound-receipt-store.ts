import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  compoundTerminalJournalSchema,
  isCompoundOperationReceiptV2,
  type CompoundOperationReceiptV2,
  type CompoundReceiptStoreV2,
  type CompoundTerminalJournalEntry,
  type ReceiptIdentityV2
} from "@harness-anything/application";

const durableStateSchema = "compound-receipt-broker-state/v2" as const;
const durableStateFile = "compound-receipt-broker-state-v2.json";
const durableTerminalStatePrefix = "compound-receipt-terminal-state-v2";

class CompoundTerminalSequenceConflictError extends Error {
  readonly code = "COMPOUND_TERMINAL_SEQUENCE_CONFLICT";

  constructor(terminalLSN: number) {
    super(`compound terminal sequence ${terminalLSN} was already published`);
    this.name = "CompoundTerminalSequenceConflictError";
  }
}

interface DurableCompoundReceiptStateV2 {
  readonly schema: typeof durableStateSchema;
  readonly nextTerminalLSN: number;
  readonly receipts: Readonly<Record<string, CompoundOperationReceiptV2>>;
  readonly terminalJournal: ReadonlyArray<CompoundTerminalJournalEntry>;
}

export interface DurableCompoundReceiptStoreV2Options {
  readonly directory: string;
  readonly generationFence?: {
    readonly runExclusive: <Result>(
      input: { readonly workspaceId: string; readonly opId: string },
      operation: () => Promise<Result>
    ) => Promise<Result>;
    readonly assertCurrent: (input: { readonly workspaceId: string; readonly opId: string }) => Promise<void>;
    readonly axes: {
      readonly machineId: string;
      readonly daemonGeneration: number;
      readonly runtimeRegistrationId?: string;
      readonly connectionId?: string;
    };
  };
}

/**
 * Broker-singleton store. A terminal commit replaces one state snapshot so the
 * receipt CAS, terminal journal, and terminalLSN allocator share one fsync boundary.
 */
export function createDurableCompoundReceiptStoreV2(
  options: DurableCompoundReceiptStoreV2Options
): CompoundReceiptStoreV2 {
  const statePath = path.join(options.directory, durableStateFile);
  let serial = Promise.resolve();

  return {
    get: (identity) => serialized(() => readState(statePath).receipts[receiptIdentityKeyV2(identity)]),
    create: (receipt) => serialized(() => guarded(receipt, async () => {
      const state = readState(statePath);
      const key = receiptIdentityKeyV2(receipt);
      const current = state.receipts[key];
      if (current) {
        assertSameReceiptIdentityV2(current, receipt);
        return current;
      }
      assertReceipt(receipt);
      await options.generationFence?.assertCurrent(receipt);
      writeState(options.directory, statePath, {
        ...state,
        receipts: { ...state.receipts, [key]: receipt }
      });
      return receipt;
    })),
    compareAndSet: (identity, expectedSequence, receipt) => serialized(() => guarded(identity, async () => {
      const state = readState(statePath);
      const key = receiptIdentityKeyV2(identity);
      const current = state.receipts[key];
      if (!current || current.sequence !== expectedSequence) return false;
      assertSameReceiptIdentityV2(current, receipt);
      if (receipt.sequence !== expectedSequence + 1) throw new Error("compound receipt sequence must advance exactly once");
      assertReceipt(receipt);
      await options.generationFence?.assertCurrent(identity);
      writeState(options.directory, statePath, {
        ...state,
        receipts: { ...state.receipts, [key]: receipt }
      });
      return true;
    })),
    commitTerminal: (identity, expectedSequence, draft, buildReceipt) => serialized(() => guarded(draft, async () => {
        const state = readState(statePath);
        const key = receiptIdentityKeyV2(identity);
        const current = state.receipts[key];
        if (!current || current.sequence !== expectedSequence) return undefined;
        assertDraftIdentity(draft, identity);
        const terminalLSN = state.nextTerminalLSN;
        if (terminalLSN >= Number.MAX_SAFE_INTEGER) throw new Error("compound terminalLSN space exhausted");
        const receipt = {
          ...buildReceipt(terminalLSN),
          ...(options.generationFence ? options.generationFence.axes : {})
        };
        assertSameReceiptIdentityV2(current, receipt);
        if (receipt.sequence !== expectedSequence + 1 || receipt.terminalLSN !== terminalLSN) {
          throw new Error("terminal receipt sequence/LSN is inconsistent");
        }
        assertReceipt(receipt);
        const entry: CompoundTerminalJournalEntry = {
          ...draft,
          ...(options.generationFence ? options.generationFence.axes : {}),
          terminalLSN,
          receiptSequence: receipt.sequence
        };
        await publishTerminalState(options.directory, terminalLSN, {
          ...state,
          nextTerminalLSN: terminalLSN + 1,
          receipts: { ...state.receipts, [key]: receipt },
          terminalJournal: [...state.terminalJournal, entry]
        }, options.generationFence ? () => options.generationFence!.assertCurrent(draft) : undefined);
        return receipt;
      }))
  };

  function guarded<Result>(
    identity: { readonly workspaceId: string; readonly opId: string },
    operation: () => Promise<Result>
  ): Promise<Result> {
    return options.generationFence
      ? options.generationFence.runExclusive(identity, operation)
      : operation();
  }

  function serialized<Result>(operation: () => Result): Promise<Awaited<Result>> {
    const result = serial.then(operation, operation);
    serial = result.then(() => undefined, () => undefined);
    return result as Promise<Awaited<Result>>;
  }
}

function readState(statePath: string): DurableCompoundReceiptStateV2 {
  let state = existsSync(statePath) ? readStateFile(statePath) : {
    schema: durableStateSchema,
    nextTerminalLSN: 1,
    receipts: {},
    terminalJournal: []
  };
  while (true) {
    const terminalStatePath = durableTerminalStatePath(path.dirname(statePath), state.nextTerminalLSN);
    if (!existsSync(terminalStatePath)) return state;
    const successor = readStateFile(terminalStatePath);
    assertTerminalStateSuccessor(state, successor, state.nextTerminalLSN);
    state = successor;
  }
}

function readStateFile(statePath: string): DurableCompoundReceiptStateV2 {
  const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  if (!isState(parsed)) throw new Error(`invalid durable compound receipt state: ${statePath}`);
  return parsed;
}

function assertTerminalStateSuccessor(
  current: DurableCompoundReceiptStateV2,
  successor: DurableCompoundReceiptStateV2,
  terminalLSN: number
): void {
  const entry = successor.terminalJournal.at(-1);
  if (successor.nextTerminalLSN !== terminalLSN + 1
    || successor.terminalJournal.length !== current.terminalJournal.length + 1
    || entry?.terminalLSN !== terminalLSN
    || JSON.stringify(successor.terminalJournal.slice(0, -1)) !== JSON.stringify(current.terminalJournal)) {
    throw new Error(`invalid durable compound terminal successor: ${terminalLSN}`);
  }
  const key = receiptIdentityKeyV2(entry);
  const priorReceipt = current.receipts[key];
  const terminalReceipt = successor.receipts[key];
  if (!priorReceipt || !terminalReceipt
    || terminalReceipt.sequence !== priorReceipt.sequence + 1
    || terminalReceipt.terminalLSN !== terminalLSN
    || Object.keys(successor.receipts).length !== Object.keys(current.receipts).length
    || Object.entries(current.receipts).some(([receiptKey, receipt]) => receiptKey !== key
      && JSON.stringify(successor.receipts[receiptKey]) !== JSON.stringify(receipt))) {
    throw new Error(`invalid durable compound terminal receipt successor: ${terminalLSN}`);
  }
}

function isState(value: unknown): value is DurableCompoundReceiptStateV2 {
  if (!record(value) || !exactKeys(value, ["schema", "nextTerminalLSN", "receipts", "terminalJournal"], [])
    || value.schema !== durableStateSchema || !uint(value.nextTerminalLSN) || value.nextTerminalLSN < 1
    || !record(value.receipts) || !Array.isArray(value.terminalJournal)) return false;
  if (!Object.entries(value.receipts).every(([key, receipt]) =>
    /^[a-f0-9]{64}$/u.test(key) && isCompoundOperationReceiptV2(receipt) && receiptIdentityKeyV2(receipt) === key)) return false;
  let priorLSN = 0;
  for (const entry of value.terminalJournal) {
    if (!record(entry) || !exactKeys(entry, [
      "schema", "terminalLSN", "workspaceId", "viewId", "opId", "waiterId", "kind",
      "pinReleaseEligible", "receiptSequence", "recordedAt"
    ], [
      "preparedSequence", "preparedReceiptDigest", "reason", "machineId", "daemonGeneration",
      "runtimeRegistrationId", "connectionId", "leaseGeneration"
    ])
      || entry.schema !== compoundTerminalJournalSchema || !uint(entry.terminalLSN)
      || entry.terminalLSN <= priorLSN || !uint(entry.receiptSequence)
      || entry.pinReleaseEligible !== true
      || !strings(entry, ["workspaceId", "viewId", "opId", "waiterId", "recordedAt"])
      || (entry.kind !== "ACK_COMMITTED" && entry.kind !== "DETACHED")
      || !validTerminalGenerationAxes(entry)) return false;
    if (entry.kind === "ACK_COMMITTED") {
      if (!uint(entry.preparedSequence) || typeof entry.preparedReceiptDigest !== "string"
        || !/^[a-f0-9]{64}$/u.test(entry.preparedReceiptDigest) || entry.reason !== undefined) return false;
    } else if (typeof entry.reason !== "string" || entry.reason.length === 0
      || entry.preparedSequence !== undefined || entry.preparedReceiptDigest !== undefined) return false;
    priorLSN = entry.terminalLSN;
  }
  return value.nextTerminalLSN > priorLSN;
}

function writeState(directory: string, target: string, state: DurableCompoundReceiptStateV2): void {
  if (!isState(state)) throw new Error("refusing to persist invalid compound receipt state");
  const temporary = writeStateTemporary(directory, target, state);
  renameSync(temporary, target);
  fsyncReceiptStateDirectoryV2(directory);
}

async function publishTerminalState(
  directory: string,
  terminalLSN: number,
  state: DurableCompoundReceiptStateV2,
  assertCurrent?: () => Promise<void>
): Promise<void> {
  if (!isState(state)) throw new Error("refusing to persist invalid compound terminal state");
  const target = durableTerminalStatePath(directory, terminalLSN);
  const temporary = writeStateTemporary(directory, target, state);
  try {
    await assertCurrent?.();
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
      throw new CompoundTerminalSequenceConflictError(terminalLSN);
    }
    fsyncReceiptStateDirectoryV2(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeStateTemporary(
  directory: string,
  target: string,
  state: DurableCompoundReceiptStateV2
): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(state)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function durableTerminalStatePath(directory: string, terminalLSN: number): string {
  return path.join(directory, `${durableTerminalStatePrefix}.${terminalLSN}.json`);
}

function receiptIdentityKeyV2(identity: ReceiptIdentityV2): string {
  return createHash("sha256")
    .update([identity.workspaceId, identity.viewId, identity.opId, identity.waiterId].join("\0"))
    .digest("hex");
}

function assertSameReceiptIdentityV2(left: ReceiptIdentityV2, right: ReceiptIdentityV2): void {
  if (receiptIdentityKeyV2(left) !== receiptIdentityKeyV2(right)) throw new Error("compound receipt identity is immutable");
}

function assertReceipt(receipt: CompoundOperationReceiptV2): void {
  if (!isCompoundOperationReceiptV2(receipt)) throw new Error("invalid compound-operation-receipt/v2");
  if ("resultToken" in receipt) throw new Error("raw result token must not enter durable receipt state");
}

function assertDraftIdentity(
  draft: { readonly workspaceId: string; readonly viewId: string; readonly opId: string; readonly waiterId: string },
  identity: ReceiptIdentityV2
): void {
  if (draft.workspaceId !== identity.workspaceId || draft.viewId !== identity.viewId
    || draft.opId !== identity.opId || draft.waiterId !== identity.waiterId) {
    throw new Error("terminal journal identity mismatch");
  }
}

function fsyncReceiptStateDirectoryV2(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function strings(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  return keys.every((key) => typeof value[key] === "string" && (value[key] as string).length > 0);
}

function validTerminalGenerationAxes(value: Record<string, unknown>): boolean {
  for (const field of ["machineId", "runtimeRegistrationId", "connectionId"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field].length === 0)) return false;
  }
  for (const field of ["daemonGeneration", "leaseGeneration"] as const) {
    if (value[field] !== undefined && (!uint(value[field]) || Number(value[field]) < 1)) return false;
  }
  return true;
}
