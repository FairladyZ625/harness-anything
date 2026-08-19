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
  let auditFailure: Error | null = null;
  const checkAudit = (): void => {
    if (auditFailure !== null) throw auditFailure;
  };
  const scheduleAudit = (): void => {
    if (auditScheduled) return;
    auditScheduled = true;
    const pending = setImmediate(() => {
      auditScheduled = false;
      try {
        const stream = git.read();
        const audit = wal.audit(stream.events, stream.revision);
        if (audit.status !== "equivalent")
          throw new TaskEventStoreError(
            "invalid_store",
            `WAL shadow diverged from Git: ${audit.divergence ?? "unknown difference"}`,
          );
      } catch (error) {
        consumeKnownError(error);
        auditFailure =
          error instanceof Error ? error : new Error(String(error));
      }
    });
    pending.unref();
  };
  return {
    ...git,
    append: (bundle) => {
      checkAudit();
      const receipt = git.append(bundle);
      wal.append({ event: bundle.event, blobs: bundle.blobs });
      scheduleAudit();
      return receipt;
    },
  };
}
