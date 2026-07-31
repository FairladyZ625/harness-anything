import type {
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1,
  TaskHolderExecutor
} from "@harness-anything/application";
import type { CurrentSessionRef } from "@harness-anything/kernel";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { AuthorityConnectionDispatch } from "../protocol/connection-context.ts";
import { encodeRepoWriteCommand } from "../runtime/repo-write-progress-command.ts";
import type { RepoWriteProcessSupervisor } from "../runtime/repo-write-process-supervisor.ts";
import { docSyncJournalUnavailable } from "./doc-sync-journal-failure.ts";
import { referenceDocSyncWriterWorkingTree } from "./doc-sync-writer-working-tree.ts";

export async function dispatchDocSyncSubmitToWriter(input: {
  readonly rootDir: string;
  readonly request: DocSyncSubmitRequestV1;
  readonly actor?: AuthenticatedActor;
  readonly executor?: TaskHolderExecutor | null;
  readonly authority?: AuthorityConnectionDispatch;
  readonly supervisor: RepoWriteProcessSupervisor;
}): Promise<DocSyncSubmitResultV1> {
  const currentSession = docSyncCurrentSession(input.request);
  if (!input.actor || !input.authority?.available || !currentSession) {
    return docSyncJournalUnavailable(
      input.request,
      "The doc-sync writer child requires an active authenticated authority connection and current session."
    );
  }
  try {
    input.authority.assertActive();
    const receipt = await input.supervisor.direct(encodeRepoWriteCommand({
      command: {
        rootDir: input.rootDir,
        action: { kind: "doc-sync-submit" },
        request: referenceDocSyncWriterWorkingTree(input.rootDir, input.request)
      },
      context: {
        actor: input.actor,
        authorityConnection: input.authority.context,
        currentSession,
        executor: input.executor ?? null
      }
    }));
    const report = receipt.details?.data;
    return isDocSyncSubmitResult(report)
      ? report
      : docSyncJournalUnavailable(input.request, "The doc-sync writer child returned no typed report.");
  } catch (error) {
    return docSyncJournalUnavailable(
      input.request,
      error instanceof Error ? error.stack ?? error.message : String(error)
    );
  }
}

function docSyncCurrentSession(request: DocSyncSubmitRequestV1): CurrentSessionRef | undefined {
  const session = request.session;
  if (!session?.sessionId || !session.runtime || session.runtime === "unknown"
    || !session.source || !session.detectedAt) return undefined;
  return {
    runtime: session.runtime,
    sessionId: session.sessionId,
    source: session.source,
    detectedAt: session.detectedAt,
    ...(session.user ? { user: session.user } : {})
  };
}

function isDocSyncSubmitResult(value: unknown): value is DocSyncSubmitResultV1 {
  return typeof value === "object" && value !== null
    && "schema" in value
    && value.schema === "daemon.doc-sync-submit-result/v1"
    && "ok" in value
    && typeof value.ok === "boolean";
}
