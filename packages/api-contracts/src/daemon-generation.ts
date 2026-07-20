export type MachineId = string & { readonly __brand: "machine-id" };
export type DaemonGeneration = number & { readonly __brand: "daemon-generation" };
export type RuntimeRegistrationId = string & { readonly __brand: "runtime-registration-id" };
export type ConnectionId = string & { readonly __brand: "connection-id" };
export type LeaseGeneration = number & { readonly __brand: "lease-generation" };

export interface DaemonGenerationAxesV1 {
  readonly machineId?: MachineId;
  readonly daemonGeneration?: DaemonGeneration;
  readonly runtimeRegistrationId?: RuntimeRegistrationId;
  readonly connectionId?: ConnectionId;
}

export interface DaemonTerminalGenerationAxesV1 extends DaemonGenerationAxesV1 {
  /** Reserved for S4. S1 does not generate or enforce this value. */
  readonly leaseGeneration?: LeaseGeneration;
}

export class DaemonGenerationAxesContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonGenerationAxesContractError";
  }
}

/** Decode an additive projection from a containing JSON object. Unrelated keys are left untouched. */
export function decodeDaemonGenerationAxesV1(value: unknown): DaemonGenerationAxesV1 {
  const record = object(value);
  const machineId = optionalIdentifier(record.machineId, "machineId");
  const daemonGeneration = optionalPositiveSafeInteger(record.daemonGeneration, "daemonGeneration");
  const runtimeRegistrationId = optionalIdentifier(record.runtimeRegistrationId, "runtimeRegistrationId");
  const connectionId = optionalIdentifier(record.connectionId, "connectionId");
  return {
    ...(machineId !== undefined ? { machineId: machineId as MachineId } : {}),
    ...(daemonGeneration !== undefined ? { daemonGeneration: daemonGeneration as DaemonGeneration } : {}),
    ...(runtimeRegistrationId !== undefined ? { runtimeRegistrationId: runtimeRegistrationId as RuntimeRegistrationId } : {}),
    ...(connectionId !== undefined ? { connectionId: connectionId as ConnectionId } : {})
  };
}

export function decodeDaemonTerminalGenerationAxesV1(value: unknown): DaemonTerminalGenerationAxesV1 {
  const record = object(value);
  const axes = decodeDaemonGenerationAxesV1(record);
  const leaseGeneration = optionalPositiveSafeInteger(record.leaseGeneration, "leaseGeneration");
  return {
    ...axes,
    ...(leaseGeneration !== undefined ? { leaseGeneration: leaseGeneration as LeaseGeneration } : {})
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DaemonGenerationAxesContractError("daemon generation axes must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DaemonGenerationAxesContractError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalPositiveSafeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new DaemonGenerationAxesContractError(`${field} must be a positive safe integer`);
  }
  return value;
}
