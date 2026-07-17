import { createDaemonAdmissionBudget, type DaemonAdmissionBudget } from "./admission-budget.ts";

const defaultAdmissionMaxOperations = 1_024;
const defaultAdmissionMaxBytes = 1024 * 1024;
const defaultAdmissionReservedOperationsPerPlane = 32;
const defaultAdmissionReservedBytesPerPlane = 64 * 1024;

export function createRuntimeAdmissionBudget(options: {
  readonly admissionMaxOperations?: number;
  readonly admissionMaxBytes?: number;
  readonly admissionReservedOperationsPerPlane?: number;
  readonly admissionReservedBytesPerPlane?: number;
}): DaemonAdmissionBudget {
  return createDaemonAdmissionBudget({
    maxOperations: options.admissionMaxOperations ?? defaultAdmissionMaxOperations,
    maxBytes: options.admissionMaxBytes ?? defaultAdmissionMaxBytes,
    reservedOperationsPerPlane: options.admissionReservedOperationsPerPlane ?? defaultAdmissionReservedOperationsPerPlane,
    reservedBytesPerPlane: options.admissionReservedBytesPerPlane ?? defaultAdmissionReservedBytesPerPlane
  });
}
