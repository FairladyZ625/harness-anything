import path from "node:path";
import { completionRetirementExecutions } from "../domain/task-completion-generation-retirement.ts";
import { applyTransition, normalizeTaskLifecycleCommand } from "../domain/task-lifecycle.contract.ts";
import { compileTaskLifecycleWrite, lifecycleDocumentFetchPaths } from "../domain/task-lifecycle-publication.ts";
import { makeTaskProjection } from "../projection/rebuildable-task-projection-factory.ts";
import type { SqliteEventStore, SqliteWriterFence } from "./sqlite-event-store.ts";
import type { CompletionGenerationPlan } from "./completion-generation-plan.ts";
import { completionConversionStream } from "./completion-generation-target.ts";

/** Append after the one-to-one imported prefix. Historical accepted executions are untouched. */
export function retireCompletionExecutions(
  store: SqliteEventStore,
  root: string,
  plan: CompletionGenerationPlan,
  fence: SqliteWriterFence,
): void {
  const projection = makeTaskProjection({
    rootDir: root,
    projectionPath: path.join(root, ".harness", "cache", "completion-conversion-retirement.sqlite"),
    eventStore: completionConversionStream(store),
  });
  try {
    projection.rebuild();
    let cursor: string | null = null;
    do {
      const page = projection.list({ limit: 500, ...(cursor === null ? {} : { cursor }) });
      for (const row of page.rows) {
        let snapshot = projection.read(row.taskId).snapshot;
        for (const execution of completionRetirementExecutions(snapshot)) {
          const command = {
            ...normalizeTaskLifecycleCommand(
              {
                workspaceId: plan.sourceCut.repoId,
                actor: snapshot.task!.createdBy,
                source: "migration-import/v1",
                expectedRevision: snapshot.revision,
              },
              {
                type: "RetireCompletionGeneration",
                taskId: row.taskId,
                executionId: execution.executionId,
                sourceGeneration: plan.sourceCut.generation,
              } as const,
            ),
            workspaceRevision: store.revision() + 1,
            eventId: `completion-retirement-${execution.executionId}`,
            occurredAt: new Date().toISOString(),
          };
          const changed = applyTransition(snapshot, command, {});
          const paths = row.packagePath ? lifecycleDocumentFetchPaths(changed.event, row.packagePath) : [];
          const currentDocuments = paths.flatMap((documentPath) => {
            const head = store.documentHead(documentPath);
            if (!head || head === "retired") return [];
            const bytes = store.readContentObject(head.sha256)!;
            return [{ path: documentPath, body: Buffer.from(bytes).toString("utf8"), blobSha256: head.sha256 }];
          });
          const written = compileTaskLifecycleWrite({
            event: changed.event,
            snapshot: changed.snapshot,
            packagePath: row.packagePath,
            currentDocuments,
          });
          store.appendCommand({
            fence,
            intent: {
              opId: command.opId,
              intentDigest: command.commandDigest,
              summary: "Offline completion generation retirement",
            },
            events: [written.event],
            blobs: written.blobs,
          });
          snapshot = changed.snapshot;
        }
      }
      cursor = page.page!.nextCursor;
    } while (cursor !== null);
  } finally {
    projection.close();
  }
}
