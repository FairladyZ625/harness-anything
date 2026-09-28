import type { EngineId, ExternalRef, IsoTimestamp, Sha256Fingerprint } from "./task.js";
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
