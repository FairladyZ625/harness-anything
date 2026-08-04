import type { HarnessLayoutInput } from "../../layout/index.ts";
import type { VersionControlSystem } from "../../ports/version-control-system.ts";
import type { ReadableJournalRecord } from "./types.ts";
import { durableFileExists, readFileBytes } from "./durable.ts";
import {
  createAttributionEvent,
  planAttributionEventCommit,
  type AttributionEventStore
} from "../attribution/inline-attribution-event-store.ts";
import { WriteRejectedError } from "./rejection.ts";

export function assertCodeDocReplacementHasAuthoredChange(input: {
  readonly rootDir: string;
  readonly rootInput: HarnessLayoutInput;
  readonly plannedRecords: ReadonlyArray<{
    readonly record: ReadableJournalRecord;
    readonly touchedPaths: ReadonlyArray<string>;
  }>;
  readonly publicationVcs: VersionControlSystem;
  readonly attributionEventStore: AttributionEventStore;
  readonly readPayload: (record: ReadableJournalRecord) => Record<string, unknown>;
}): void {
  for (const entry of input.plannedRecords) {
    if (entry.record.schema !== "write-journal/v2" || entry.record.kind !== "code_doc_reconcile") continue;
    const eventPlan = planAttributionEventCommit(
      input.rootDir,
      input.rootInput,
      entry.touchedPaths,
      input.publicationVcs
    );
    const payload = input.readPayload(entry.record);
    const targetPath = entry.touchedPaths[0];
    const bodyIsAlreadyApplied = typeof payload.body === "string"
      && typeof targetPath === "string"
      && durableFileExists(targetPath)
      && new TextDecoder().decode(readFileBytes(targetPath)) === payload.body;
    if (!bodyIsAlreadyApplied) continue;
    const event = createAttributionEvent(entry.record);
    const alreadyPublished = input.attributionEventStore.confirms(event, {
      rootDir: input.rootDir,
      rootInput: input.rootInput,
      commitSha: eventPlan.preCommitSha,
      versionControlSystem: input.publicationVcs
    });
    if (alreadyPublished) continue;
    throw new WriteRejectedError(
      "code_doc_reconcile produced no authored change; update closeout/review or anchors before retrying --force",
      entry.record.entityId,
      {
        code: "code_doc_reconcile_noop",
        retryable: false
      }
    );
  }
}
