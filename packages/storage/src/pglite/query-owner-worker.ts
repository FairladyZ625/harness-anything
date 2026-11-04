import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { createPGliteStorageBackend, type PGliteStorageBackend } from "./storage-backend.ts";
import { pgliteOwnerEpochs, type PGliteOwnerGroup } from "./query-owner-epochs.ts";
import { startPgQuerySession, serializePgQueryError, type PgQuerySessionInput } from "../pg/pg-task-query-worker.ts";
import { consumeKnownError } from "@harness-anything/kernel";
import type { PGliteStorageBackendConfig } from "../storage-backend.ts";
import type { PGliteOwnerServiceRequest } from "./owner-service.ts";
import { prepareSqlBaseBackup } from "../postgres/pg-basebackup.ts";
import { openPgMigrationEndpoint } from "../migration/postgres-endpoint.ts";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";

interface OwnerInput {
  readonly kind: "pglite-query-owner";
  readonly repoId: string;
  readonly storage: PGliteStorageBackendConfig;
  readonly ready: Int32Array;
  readonly responsePort: MessagePort;
}
interface Connect {
  readonly operation: "connect";
  readonly input: Omit<PgQuerySessionInput, "requestPort">;
}
type OwnerRequest =
  | Connect
  | PGliteOwnerServiceRequest
  | { readonly operation: "attach"; readonly port: MessagePort }
  | { readonly operation: "shutdown" };
const input = workerData as OwnerInput;
if (input?.kind === "pglite-query-owner" && parentPort) void startOwner(input);

async function startOwner(input: OwnerInput): Promise<void> {
  let backend: PGliteStorageBackend;
  try {
    backend = await createPGliteStorageBackend({ repoId: input.repoId, storage: input.storage });
  } catch (error) {
    input.responsePort.postMessage({ id: 0, error: serializePgQueryError(error) });
    Atomics.store(input.ready, 0, 1);
    Atomics.notify(input.ready, 0);
    input.responsePort.close();
    parentPort!.close();
    consumeKnownError(error);
    return;
  }
  const epochs = pgliteOwnerEpochs(backend.pool),
    groups = new Set<PGliteOwnerGroup>(),
    clients = new Map<
      MessagePort,
      { readonly session: ReturnType<typeof startPgQuerySession>; readonly owner: PGliteOwnerGroup }
    >(),
    controls = new Set<MessagePort>(),
    services = new Set<MessagePort>();
  let stopping = false,
    failed = false;
  const group = (): PGliteOwnerGroup => {
    const value = { active: true, writes: new Set<Promise<unknown>>() };
    groups.add(value);
    return value;
  };
  const connect = (request: Connect, owner: PGliteOwnerGroup) => {
    const port = request.input.responsePort;
    let active = owner.active && !stopping;
    const live = () => active && owner.active && !stopping,
      session = startPgQuerySession({ ...request.input, requestPort: port }, backend.pool, null, {
        ownsPools: false,
        epochs: epochs.client(owner, live),
        canonical: (value, operation) => epochs.canonical(owner, live, value, operation),
        onClose: () => clients.delete(port),
      });
    clients.set(port, { session, owner });
    port.once("close", () => {
      active = false;
      void session.close().catch((error: unknown) => {
        consumeKnownError(error);
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };
  const fail = (error: Error) => {
    if (failed) return;
    failed = true;
    stopping = true;
    for (const owner of groups) owner.active = false;
    for (const client of clients.values()) client.session.fail(error);
    input.responsePort.postMessage({ id: -1, fatal: true, error: serializePgQueryError(error) });
    Atomics.store(input.ready, 0, -1);
    Atomics.notify(input.ready, 0);
    for (const control of controls) control.close();
    for (const service of services) service.close();
    input.responsePort.close();
    parentPort!.close();
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const owner of groups) owner.active = false;
    await Promise.all([...clients.values()].map((client) => client.session.close()));
    for (const control of controls) control.close();
    await backend.close();
    input.responsePort.postMessage({ id: 1, result: null });
    Atomics.store(input.ready, 0, 1);
    Atomics.notify(input.ready, 0);
    input.responsePort.close();
    parentPort!.close();
  };
  const dispatch = (request: OwnerRequest, owner: PGliteOwnerGroup) => {
    if (request.operation === "connect") connect(request, owner);
    else if (request.operation === "service") {
      const port = request.responsePort;
      services.add(port);
      const run = async () => {
        if (request.service === "backup")
          return prepareSqlBaseBackup(
            request.input,
            (metadata) => port.postMessage({ kind: "pinned", metadata }),
            backend.pool,
          );
        const endpoint = await openPgMigrationEndpoint({
          pool: backend.pool,
          repoId: request.repoId,
          scope: resolvePostgresEventStoreScope(request.storage.scope),
          backend: "pglite",
          identity: request.storage.dataDir,
        });
        if (request.method === "open") return { id: endpoint.id, backend: endpoint.backend };
        const method = request.method;
        const execute = () => (endpoint[method] as (...args: readonly unknown[]) => Promise<unknown>)(...request.args);
        return request.method === "change" || request.method === "import"
          ? epochs.exclusive(owner, request.repoId, execute)
          : execute();
      };
      void run()
        .then(
          (result) => {
            port.postMessage({ result });
          },
          (error: unknown) => {
            port.postMessage({ error: serializePgQueryError(error) });
            consumeKnownError(error);
          },
        )
        .finally(() => {
          services.delete(port);
          port.close();
        });
    } else if (request.operation === "attach") {
      const child = group(),
        control = request.port;
      controls.add(control);
      control.on("message", (value: OwnerRequest) => dispatch(value, child));
      control.once("close", () => {
        child.active = false;
        controls.delete(control);
        void Promise.all(
          [...clients.values()].filter((client) => client.owner === child).map((client) => client.session.close()),
        )
          .then(() => groups.delete(child))
          .catch((error: unknown) => {
            consumeKnownError(error);
            fail(error instanceof Error ? error : new Error(String(error)));
          });
      });
    } else
      void stop().catch((error: unknown) => {
        consumeKnownError(error);
        fail(error instanceof Error ? error : new Error(String(error)));
      });
  };
  backend.pool.on("error", fail);
  process.on("uncaughtExceptionMonitor", fail);
  process.on("exit", () => {
    if (!stopping) fail(new Error("Embedded storage owner exited"));
  });
  const root = group();
  parentPort!.on("message", (request: OwnerRequest) => dispatch(request, root));
  input.responsePort.postMessage({ id: 0, result: null });
  Atomics.store(input.ready, 0, 1);
  Atomics.notify(input.ready, 0);
}
