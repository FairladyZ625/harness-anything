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

const capacityExceededError: WriteError = Object.freeze({
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
      const operationLimit = limits.maxOperations - limits.reservedOperationsPerPlane;
      const byteLimit = limits.maxBytes - limits.reservedBytesPerPlane;
      if (input.operations > operationLimit || input.bytes > byteLimit) {
        rejected[input.plane] += 1;
        return {
          ok: false,
          error: payloadExceedsLimitError(input.operations, operationLimit, input.bytes, byteLimit)
        };
      }
      const otherOperations = input.plane === "authority" ? used.jsonRpcOperations : used.authorityOperations;
      const otherBytes = input.plane === "authority" ? used.jsonRpcBytes : used.authorityBytes;
      const protectedOperations = Math.max(0, limits.reservedOperationsPerPlane - otherOperations);
      const protectedBytes = Math.max(0, limits.reservedBytesPerPlane - otherBytes);
      const exceedsOperations = used.operations + input.operations > limits.maxOperations - protectedOperations;
      const exceedsBytes = used.bytes + input.bytes > limits.maxBytes - protectedBytes;
      if (exceedsOperations || exceedsBytes) {
        rejected[input.plane] += 1;
        return { ok: false, error: capacityExceededError };
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

function payloadExceedsLimitError(operations: number, operationLimit: number, bytes: number, byteLimit: number): WriteError {
  return {
    _tag: "WriteRejected",
    code: "admission_payload_exceeds_limit",
    reason: `Shared daemon admission payload exceeds the per-request limit (operations: requested ${operations}, limit ${operationLimit}; bytes: requested ${bytes}, limit ${byteLimit}). Split the batch or reduce the payload, then submit each smaller request. A single payload that cannot be split needs a larger 'settings.daemon.admission.maxBytes'.`,
    retryable: false
  };
}

const jsonNullBytes = 4;

/**
 * Charges a request the bytes it actually occupies.
 *
 * Binary payloads are charged their real `byteLength`. Measuring them with
 * `JSON.stringify` inflates the charge several fold — a `Buffer` renders as
 * `{"type":"Buffer","data":[12,34,...]}` (~3.6x) and a bare `Uint8Array` as
 * `{"0":12,"1":34,...}` (~11.5x) — which both reserves capacity that is not
 * needed and makes the `admission_payload_exceeds_limit` message untrue about
 * how large the request was. Everything else is charged its exact JSON
 * encoding, so non-binary payloads keep the meaning they already had.
 */
export function daemonAdmissionBytes(value: unknown): number {
  return admissionValueBytes(value) ?? jsonNullBytes;
}

function admissionValueBytes(value: unknown): number | undefined {
  // Only objects can be binary, so primitives take the cheap path first.
  if (value === null || typeof value !== "object") return admissionJsonBytes(value);
  const binary = admissionBinaryBytes(value);
  if (binary !== undefined) return binary;
  // `toJSON` owners (Date, and anything else that renders itself) are charged
  // the encoding they actually produce rather than their internal slots.
  if (typeof (value as { readonly toJSON?: unknown }).toJSON === "function") return admissionJsonBytes(value);
  if (Array.isArray(value)) {
    let total = 2;
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) total += 1;
      total += admissionValueBytes(value[index]) ?? jsonNullBytes;
    }
    return total;
  }
  let total = 2;
  let separators = -1;
  for (const [key, entry] of Object.entries(value)) {
    const measured = admissionValueBytes(entry);
    if (measured === undefined) continue;
    separators += 1;
    total += Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + measured;
  }
  return total + Math.max(0, separators);
}

function admissionBinaryBytes(value: object): number | undefined {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return undefined;
}

function admissionJsonBytes(value: unknown): number | undefined {
  const json = JSON.stringify(value);
  return json === undefined ? undefined : Buffer.byteLength(json, "utf8");
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
