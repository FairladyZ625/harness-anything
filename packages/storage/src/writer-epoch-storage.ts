import type { StorageBackendConfig } from "./storage-backend.ts";
import type { WriterEpochFenceDescriptor } from "./writer-epoch-contract.ts";

// Deployment credentials stay in the owning daemon/worker; fence values contain only identity.
const configurations = new Map<string, StorageBackendConfig>();
const key = (input: Pick<WriterEpochFenceDescriptor, "stateRoot" | "repoId">) => `${input.stateRoot}\0${input.repoId}`;
export function configureWriterEpochStorage(
  input: Pick<WriterEpochFenceDescriptor, "stateRoot" | "repoId">,
  storage: StorageBackendConfig | undefined,
): void {
  if (storage) configurations.set(key(input), storage);
}
export function writerEpochStorage(input: WriterEpochFenceDescriptor): StorageBackendConfig | undefined {
  return configurations.get(key(input));
}
