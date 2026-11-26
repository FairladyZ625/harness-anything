import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { PgProjectionScope } from "../../../storage/src/pg/pg-task-event-materialize.ts";
import { createPgTaskQueryReader, type PgTaskQueryReader } from "../../../storage/src/pg/pg-task-query-reader.ts";
import { createCloudDomainRoutes } from "./cloud-domain-routes.ts";

export interface CloudQueryWorkerConfig {
  readonly maxReaders: number;
}

export type CloudQueryWorkerRequest =
  | {
      readonly id: number;
      readonly op: "query";
      readonly routeName: string;
      readonly repoId: string;
      readonly scope: PgProjectionScope;
      readonly connectionString: string;
      readonly search: string;
      readonly personId: string;
      readonly statelessRoot: string;
      readonly timeoutMs: number;
    }
  | {
      readonly id: number;
      readonly op: "close";
    };

export interface SerializedWorkerError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
}

export type CloudQueryWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: SerializedWorkerError };

class WorkerQueryFault extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

interface CachedReaderEntry {
  readonly key: string;
  readonly reader: PgTaskQueryReader;
}

const DEFAULT_MAX_READERS = 16;
const POISONED_READER_CODES = new Set([
  "pg_query_worker_timeout",
  "pg_query_worker_exited",
  "pg_query_worker_protocol_error",
]);

function closeReaderQuietly(reader: PgTaskQueryReader): { readonly closed: boolean; readonly error?: unknown } {
  try {
    reader.close();
    return { closed: true };
  } catch (error) {
    return { closed: false, error };
  }
}

function dropCachedReader(readers: Map<string, CachedReaderEntry>, repoId: string): void {
  readers.delete(repoId);
}

function isPoisonedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("code" in error && typeof error.code === "string" && POISONED_READER_CODES.has(error.code)) ||
      error.message.includes("PostgreSQL task query reader is closed"))
  );
}

function serializeWorkerError(error: unknown): SerializedWorkerError {
  if (error instanceof WorkerQueryFault) {
    return { name: error.name, message: error.message, code: error.code, status: error.status };
  }
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
  }
  return { name: "Error", message: String(error) };
}

function cacheKeyOf(connectionString: string, scope: PgProjectionScope, timeoutMs: number): string {
  return JSON.stringify([
    connectionString,
    scope.tenantId,
    scope.projectId,
    scope.policyEpoch,
    scope.readers ?? [],
    timeoutMs,
  ]);
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const config = workerData as Partial<CloudQueryWorkerConfig> | undefined;
  const maxReaders =
    typeof config?.maxReaders === "number" && Number.isSafeInteger(config.maxReaders) && config.maxReaders >= 1
      ? config.maxReaders
      : DEFAULT_MAX_READERS;
  const routes = createCloudDomainRoutes((status, code) => new WorkerQueryFault(status, code));
  const readers = new Map<string, CachedReaderEntry>();

  const evictReader = (repoId: string, expected?: PgTaskQueryReader): void => {
    const entry = readers.get(repoId);
    if (!entry) return;
    if (expected !== undefined && entry.reader !== expected) return;
    dropCachedReader(readers, repoId);
    void closeReaderQuietly(entry.reader);
  };

  const acquireReader = (request: Extract<CloudQueryWorkerRequest, { op: "query" }>): PgTaskQueryReader => {
    const clampedTimeout = Math.max(1, Math.min(300_000, Math.trunc(request.timeoutMs)));
    const key = cacheKeyOf(request.connectionString, request.scope, clampedTimeout);
    const cached = readers.get(request.repoId);
    if (cached) {
      if (cached.key === key && !cached.reader.isClosed()) {
        dropCachedReader(readers, request.repoId);
        readers.set(request.repoId, cached);
        return cached.reader;
      }
      dropCachedReader(readers, request.repoId);
      void closeReaderQuietly(cached.reader);
    }
    while (readers.size >= maxReaders) {
      const oldestKey = readers.keys().next().value;
      if (oldestKey === undefined) break;
      evictReader(oldestKey);
    }
    const reader = createPgTaskQueryReader({
      connectionString: request.connectionString,
      scope: request.scope,
      repoId: request.repoId,
      startupTimeoutMs: clampedTimeout,
      queryTimeoutMs: clampedTimeout,
    });
    readers.set(request.repoId, { key, reader });
    return reader;
  };

  const closeAllReaders = (): void => {
    const entries = [...readers.values()];
    readers.clear();
    for (const entry of entries) void closeReaderQuietly(entry.reader);
  };

  const handleRequest = (request: CloudQueryWorkerRequest): CloudQueryWorkerResponse => {
    if (request.op === "close") {
      closeAllReaders();
      return { id: request.id, ok: true, value: null };
    }
    const route = routes.get(request.routeName);
    if (!route) {
      return {
        id: request.id,
        ok: false,
        error: { name: "QueryFault", message: "route_not_found", code: "route_not_found", status: 404 },
      };
    }
    let reader: PgTaskQueryReader | undefined;
    try {
      reader = acquireReader(request);
      const value = route(reader, {
        repoId: request.repoId,
        statelessRoot: request.statelessRoot,
        search: new URLSearchParams(request.search),
        personId: request.personId,
      });
      if (reader.isClosed()) evictReader(request.repoId, reader);
      return { id: request.id, ok: true, value };
    } catch (error) {
      if (reader && (reader.isClosed() || isPoisonedError(error))) {
        evictReader(request.repoId, reader);
      }
      return { id: request.id, ok: false, error: serializeWorkerError(error) };
    }
  };

  port.on("message", (request: CloudQueryWorkerRequest) => {
    port.postMessage(handleRequest(request));
    if (request.op === "close") port.close();
  });
}
