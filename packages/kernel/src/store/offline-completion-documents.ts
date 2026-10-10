import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import type { TaskEventV1 } from "../domain/task-lifecycle-event.ts";
import { emptyTaskLifecycleSnapshot, type TaskLifecycleSnapshot } from "../domain/task-lifecycle.contract.ts";
import { renderLifecycleDocument } from "../domain/task-lifecycle-publication.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { CanonicalContentBlob } from "./task-event-store-types.ts";

/** Render only owned machine documents whose completion inputs changed, preserving all authored prose. */
export function completionDocumentConverter(readContent: (sha256: string) => Uint8Array | null) {
  const snapshots = new Map<string, TaskLifecycleSnapshot>();
  return (event: CanonicalEventV1): { event: CanonicalEventV1; blobs: readonly CanonicalContentBlob[] } => {
    if (event.schema !== "task-event/v1") return { event, blobs: [] };
    const previous = snapshots.get(event.taskId) ?? emptyTaskLifecycleSnapshot(),
      payload = event.payload;
    const upsert = <T>(values: readonly T[], value: T, key: keyof T): readonly T[] => [
      ...values.filter((candidate) => candidate[key] !== value[key]),
      value,
    ];
    const snapshot: TaskLifecycleSnapshot = {
      ...previous,
      revision: event.workspaceRevision,
      ...("task" in payload ? { task: payload.task } : {}),
      ...("execution" in payload ? { executions: upsert(previous.executions, payload.execution, "executionId") } : {}),
      ...("review" in payload ? { reviews: upsert(previous.reviews, payload.review, "reviewId") } : {}),
      ...("consent" in payload ? { consents: upsert(previous.consents, payload.consent, "consentId") } : {}),
      ...("disposition" in payload
        ? { reviewDispositions: upsert(previous.reviewDispositions ?? [], payload.disposition, "dispositionId") }
        : {}),
      ...(event.type === "completion_gate_verified"
        ? { gateWitnesses: upsert(previous.gateWitnesses, event.payload.witness, "witnessId") }
        : {}),
      ...(event.type === "code_doc_reconciled"
        ? { codeDocWitnesses: [...previous.codeDocWitnesses, event.payload.witness] }
        : {}),
    };
    snapshots.set(event.taskId, snapshot);
    if (!("documentClaims" in payload) || !payload.documentClaims?.length) return { event, blobs: [] };
    const blobs: CanonicalContentBlob[] = [];
    const documentClaims = payload.documentClaims.map((claim) => {
      if (!claim.path.endsWith("/INDEX.md") && !/\/(executions|reviews)\/[^/]+\.md$/u.test(claim.path)) return claim;
      const bytes = readContent(claim.sha256);
      if (!bytes) throw new Error(`machine document ${claim.path} has no accepted bytes`);
      const base = new TextDecoder().decode(bytes);
      const body = renderLifecycleDocument(event as TaskEventV1, snapshot, claim.path, base);
      if (body === base) return claim;
      const sha256 = sha256Text(body),
        size = Buffer.byteLength(body);
      blobs.push({ sha256, size, mediaType: claim.mediaType, body });
      return { ...claim, sha256, size };
    });
    return { event: { ...event, payload: { ...payload, documentClaims } } as CanonicalEventV1, blobs };
  };
}
