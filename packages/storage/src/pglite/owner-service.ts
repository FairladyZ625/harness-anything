import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { PGliteStorageBackendConfig } from "../storage-backend.ts";
import type { MigrationEndpoint } from "../migration/types.ts";
import type { BaseBackupMetadata, PostgresBaseBackupInput } from "../fleet-basebackup.ts";
import { acquirePGliteOwnerTarget } from "./query-owner.ts";
import { restorePgQueryError } from "../pg/pg-task-query-reader.ts";

export type PGliteOwnerServiceRequest = {
  readonly operation: "service";
  readonly repoId: string;
  readonly storage: PGliteStorageBackendConfig;
  readonly responsePort: MessagePort;
} & (
  | { readonly service: "backup"; readonly input: PostgresBaseBackupInput }
  | {
      readonly service: "migration";
      readonly method: "open" | Exclude<keyof MigrationEndpoint, "id" | "backend" | "close">;
      readonly args: readonly unknown[];
    }
);

export function pgliteOwnerService(repoId: string, storage: PGliteStorageBackendConfig) {
  const lease = acquirePGliteOwnerTarget(repoId, storage);
  return {
    async call<Result>(
      request:
        | Omit<
            Extract<PGliteOwnerServiceRequest, { service: "backup" }>,
            "operation" | "repoId" | "storage" | "responsePort"
          >
        | Omit<
            Extract<PGliteOwnerServiceRequest, { service: "migration" }>,
            "operation" | "repoId" | "storage" | "responsePort"
          >,
      pinned?: (metadata: BaseBackupMetadata) => void,
    ): Promise<Result> {
      const { port1, port2 } = new MessageChannel();
      try {
        return await new Promise<Result>((resolve, reject) => {
          let complete = false;
          port1.on("message", (message) => {
            if (message.kind === "pinned") {
              pinned?.(message.metadata);
              return;
            }
            complete = true;
            if (message.error) reject(restorePgQueryError(message.error));
            else resolve(message.result as Result);
          });
          port1.once("close", () => {
            if (!complete)
              reject(
                Object.assign(new Error("Embedded service connection closed"), { code: "pglite_owner_unavailable" }),
              );
          });
          lease.target.postMessage({ ...request, operation: "service", repoId, storage, responsePort: port2 }, [port2]);
        });
      } finally {
        port1.close();
      }
    },
    close: lease.release,
  };
}

export async function openPGliteOwnerMigrationEndpoint(
  repoId: string,
  storage: PGliteStorageBackendConfig,
): Promise<MigrationEndpoint> {
  const service = pgliteOwnerService(repoId, storage);
  try {
    const identity = await service.call<Pick<MigrationEndpoint, "id" | "backend">>({
      service: "migration",
      method: "open",
      args: [],
    });
    return {
      ...identity,
      state: () => service.call({ service: "migration", method: "state", args: [] }),
      marker: (runId) => service.call({ service: "migration", method: "marker", args: [runId] }),
      change: (...args) => service.call({ service: "migration", method: "change", args }),
      export: (runId) => service.call({ service: "migration", method: "export", args: [runId] }),
      import: (manifest) => service.call({ service: "migration", method: "import", args: [manifest] }),
      epoch: () => service.call({ service: "migration", method: "epoch", args: [] }),
      close: async () => service.close(),
    };
  } catch (error) {
    service.close();
    throw error;
  }
}
