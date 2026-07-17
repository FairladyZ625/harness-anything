import type { WriteError } from "../domain/errors.ts";

export type DaemonAdmissionPlane = "authority" | "json-rpc";

export interface DaemonAdmissionBudgetLimits {
  readonly maxOperations: number;
  readonly maxBytes: number;
  readonly reservedOperationsPerPlane: number;
  readonly reservedBytesPerPlane: number;
}

export interface DaemonAdmissionBudgetSnapshot {
  readonly limits: DaemonAdmissionBudgetLimits;
  readonly used: {
    readonly operations: number;
    readonly bytes: number;
    readonly authorityOperations: number;
    readonly authorityBytes: number;
    readonly jsonRpcOperations: number;
    readonly jsonRpcBytes: number;
  };
  readonly rejected: Record<DaemonAdmissionPlane, number>;
}

export interface DaemonAdmissionReservation {
  readonly release: () => void;
}

export type DaemonAdmissionResult =
  | { readonly ok: true; readonly reservation: DaemonAdmissionReservation }
  | { readonly ok: false; readonly error: WriteError };

export interface DaemonAdmissionBudget {
  readonly reserve: (input: {
    readonly plane: DaemonAdmissionPlane;
    readonly operations: number;
    readonly bytes: number;
  }) => DaemonAdmissionResult;
  readonly snapshot: () => DaemonAdmissionBudgetSnapshot;
}

const overloadError: WriteError = Object.freeze({
  _tag: "WriteRejected" as const,
  code: "admission_overloaded",
  reason: "Shared daemon admission budget is full. Run 'ha daemon status --json', wait for current writes to settle, then retry the exact command.",
  retryable: true
});

export function createDaemonAdmissionBudget(limits: DaemonAdmissionBudgetLimits): DaemonAdmissionBudget {
  assertLimits(limits);
  const used = {
    operations: 0,
    bytes: 0,
    authorityOperations: 0,
    authorityBytes: 0,
    jsonRpcOperations: 0,
    jsonRpcBytes: 0
  };
  const rejected: Record<DaemonAdmissionPlane, number> = { authority: 0, "json-rpc": 0 };

  return {
    reserve: (input) => {
      assertNonNegativeInteger(input.operations, "operations");
      assertNonNegativeInteger(input.bytes, "bytes");
      const otherOperations = input.plane === "authority" ? used.jsonRpcOperations : used.authorityOperations;
      const otherBytes = input.plane === "authority" ? used.jsonRpcBytes : used.authorityBytes;
      const protectedOperations = Math.max(0, limits.reservedOperationsPerPlane - otherOperations);
      const protectedBytes = Math.max(0, limits.reservedBytesPerPlane - otherBytes);
      const exceedsOperations = used.operations + input.operations > limits.maxOperations - protectedOperations;
      const exceedsBytes = used.bytes + input.bytes > limits.maxBytes - protectedBytes;
      if (exceedsOperations || exceedsBytes) {
        rejected[input.plane] += 1;
        return { ok: false, error: overloadError };
      }

      used.operations += input.operations;
      used.bytes += input.bytes;
      if (input.plane === "authority") {
        used.authorityOperations += input.operations;
        used.authorityBytes += input.bytes;
      } else {
        used.jsonRpcOperations += input.operations;
        used.jsonRpcBytes += input.bytes;
      }
      let released = false;
      return {
        ok: true,
        reservation: {
          release: () => {
            if (released) return;
            released = true;
            used.operations -= input.operations;
            used.bytes -= input.bytes;
            if (input.plane === "authority") {
              used.authorityOperations -= input.operations;
              used.authorityBytes -= input.bytes;
            } else {
              used.jsonRpcOperations -= input.operations;
              used.jsonRpcBytes -= input.bytes;
            }
          }
        }
      };
    },
    snapshot: () => ({ limits: { ...limits }, used: { ...used }, rejected: { ...rejected } })
  };
}

export function daemonAdmissionBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function assertLimits(limits: DaemonAdmissionBudgetLimits): void {
  for (const [name, value] of Object.entries(limits)) assertNonNegativeInteger(value, name);
  if (limits.maxOperations === 0 || limits.maxBytes === 0) throw new Error("daemon admission maxima must be positive");
  if (limits.reservedOperationsPerPlane * 2 > limits.maxOperations) throw new Error("daemon admission operation reserves exceed maximum");
  if (limits.reservedBytesPerPlane * 2 > limits.maxBytes) throw new Error("daemon admission byte reserves exceed maximum");
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`daemon admission ${name} must be a non-negative safe integer`);
}
