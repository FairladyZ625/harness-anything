import type { MessagePort } from "node:worker_threads";
import { createPgTaskQueryReader } from "../pg/pg-task-query-reader.ts";
import { PortQueryEndpoint } from "../pg/port-query-endpoint.ts";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";
import { openPgWriterEpoch } from "../postgres/pg-writer-epoch.ts";
import { registerSqlBackendAdapters, type SqlTaskQueryReaderOpener } from "../sql-backend-adapters.ts";

export interface PGliteCommitContext {
  readonly key: string;
  readonly port: MessagePort;
  readonly state: Int32Array;
}

/** Borrow the existing embedded DB owner's physical port without loading the SDK or opening a second DB. */
export function bindPGliteCommitContext(context: PGliteCommitContext): SqlTaskQueryReaderOpener {
  const open: SqlTaskQueryReaderOpener = (options) => {
    if (options.storage.backend !== "pglite") throw new Error("Embedded commit port requires PGlite storage");
    if (Atomics.load(context.state, 0) === -1)
      throw Object.assign(new Error("Embedded storage owner exited"), { code: "pglite_owner_unavailable" });
    return createPgTaskQueryReader(
      {
        ...options,
        scope: resolvePostgresEventStoreScope(options.storage.scope),
        path: options.path ?? "pglite:canonical-writer",
      },
      (input) => {
        context.port.postMessage(
          {
            operation: "connect",
            input: {
              repoId: input.repoId,
              scope: input.scope,
              path: input.path,
              authoredRoot: input.authoredRoot,
              ready: input.ready,
              state: input.state,
              responsePort: input.responsePort,
            },
          },
          [input.responsePort],
        );
        return new PortQueryEndpoint(input.requestPort);
      },
    );
  };
  registerSqlBackendAdapters({ createSqlTaskQueryReader: open, openPgWriterEpoch }, "pglite");
  return open;
}
