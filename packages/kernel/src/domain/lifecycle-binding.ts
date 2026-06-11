import type { BindingInvariantError } from "./errors.js";
import type { EngineId, ExternalRef, IsoTimestamp, Sha256Fingerprint, TaskId } from "./task.js";
import type { DomainStatus } from "./lifecycle-status.js";

export interface LifecycleBinding {
  readonly bindingSchema: "lifecycle-binding/v1";
  readonly engine: EngineId;
  readonly status?: DomainStatus;
  readonly ref: ExternalRef | null;
  readonly titleSnapshot: string | null;
  readonly url: string | null;
  readonly bindingCreatedAt: IsoTimestamp;
  readonly bindingFingerprint: Sha256Fingerprint;
}

export type BindingInvariantResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: BindingInvariantError };

export function validateLifecycleBindingInvariant(
  taskId: TaskId,
  previous: LifecycleBinding,
  next: LifecycleBinding
): BindingInvariantResult {
  for (const field of ["engine", "ref", "bindingCreatedAt", "bindingFingerprint"] as const) {
    if (previous[field] !== next[field]) {
      return {
        ok: false,
        error: {
          _tag: "BindingInvariantViolation",
          taskId,
          field,
          expected: previous[field],
          actual: next[field]
        }
      };
    }
  }

  return { ok: true };
}
