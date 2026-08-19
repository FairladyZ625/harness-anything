import { resolveHarnessLayout } from "../layout/index.ts";
import { consumeKnownError } from "../error-consumption.ts";
import {
  canonicalDocumentClaims,
  canonicalEventWritePlan,
  makeTaskEventStore as makeGitEventStore,
  TaskEventStoreError,
  type CanonicalEventStore,
} from "./task-event-store.ts";
import { openWalEventLog } from "./wal-event-log.ts";

export { canonicalDocumentClaims, canonicalEventWritePlan, TaskEventStoreError };

export function makeWalShadowEventStore(
  options: Parameters<typeof makeGitEventStore>[0],
): CanonicalEventStore {
  const git = makeGitEventStore(options);
  const input = options.rootInput ?? options.rootDir;
  if (input === undefined)
    throw new Error("canonical event store requires rootInput or rootDir");
  const wal = openWalEventLog(resolveHarnessLayout(input).rootDir);
  let auditScheduled = false;
  const warn = (context: string, error: unknown): void => {
    console.warn(
      `[wal-shadow] ${context}; Git remains authoritative: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };
  const reseed = (
    stream: ReturnType<CanonicalEventStore["read"]>,
    context: string,
    cause: unknown,
  ): void => {
    warn(`${context}; reseeding WAL from Git`, cause);
    try {
      wal.reseed(stream.events);
      console.warn(
        `[wal-shadow] reseed complete at Git revision ${stream.revision}`,
      );
    } catch (error) {
      consumeKnownError(error);
      warn("WAL shadow reseed failed", error);
    }
  };
  const align = (context: string): void => {
    let stream: ReturnType<CanonicalEventStore["read"]>;
    try {
      stream = git.read();
      const audit = wal.audit(stream.events, stream.revision);
      if (audit.status === "equivalent") return;
      reseed(stream, `${context}: ${audit.divergence ?? "WAL differs"}`, new TaskEventStoreError(
        "invalid_store",
        audit.divergence ?? "WAL shadow differs from Git",
      ));
    } catch (error) {
      consumeKnownError(error);
      try {
        stream = git.read();
        reseed(stream, context, error);
      } catch (readError) {
        consumeKnownError(readError);
        warn(`${context}; Git stream could not be read for reseed`, readError);
      }
    }
  };
  const appendShadow = (
    bundle: Parameters<CanonicalEventStore["append"]>[0],
  ): void => {
    try {
      wal.append({ event: bundle.event, blobs: bundle.blobs });
    } catch (error) {
      consumeKnownError(error);
      let stream: ReturnType<CanonicalEventStore["read"]>;
      try {
        stream = git.read();
        reseed(stream, "WAL append failed", error);
      } catch (readError) {
        consumeKnownError(readError);
        warn("WAL append failed and Git stream could not be read", readError);
      }
    }
  };
  const scheduleAudit = (): void => {
    if (auditScheduled) return;
    auditScheduled = true;
    const pending = setImmediate(() => {
      try {
        align("WAL audit failed");
      } finally {
        auditScheduled = false;
      }
    });
    pending.unref();
  };
  return {
    ...git,
    append: (bundle) => {
      const receipt = git.append(bundle);
      appendShadow(bundle);
      scheduleAudit();
      return receipt;
    },
    migrateLayout: (migration) => {
      const receipt = git.migrateLayout(migration);
      align("WAL layout migration alignment");
      return receipt;
    },
    recover: () => {
      const receipt = git.recover();
      align("WAL recovery alignment");
      return receipt;
    },
  };
}
