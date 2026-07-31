import { execFileSync } from "node:child_process";
import type {
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1,
  TaskHolderExecutor
} from "@harness-anything/application";
import {
  resolveHarnessLayout,
  sha256Text,
  type CurrentSessionRef,
  type HarnessLayoutOverrides
} from "@harness-anything/kernel";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { AuthorityConnectionDispatch } from "../protocol/connection-context.ts";
import { encodeRepoWriteCommand } from "../runtime/repo-write-progress-command.ts";
import type { RepoWriteProcessSupervisor } from "../runtime/repo-write-process-supervisor.ts";
import { RepoWriteIpcPayloadTooLargeError } from "../runtime/repo-write-client-errors.ts";
import { docSyncJournalUnavailable } from "./doc-sync-journal-failure.ts";
import {
  ExternalDocSyncWorkingTreeReferenceError,
  referenceDocSyncWriterWorkingTree
} from "./doc-sync-writer-working-tree.ts";

export async function dispatchDocSyncSubmitToWriter(input: {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
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
        request: referenceDocSyncWriterWorkingTree(
          input.layoutOverrides
            ? { rootDir: input.rootDir, layoutOverrides: input.layoutOverrides }
            : input.rootDir,
          input.request
        )
      },
      context: {
        actor: input.actor,
        authorityConnection: input.authority.context,
        currentSession,
        executor: input.executor ?? null
      }
    }));
    const report = receipt.details?.data;
    if (!isDocSyncSubmitResult(report)) {
      return docSyncJournalUnavailable(input.request, "The doc-sync writer child returned no typed report.");
    }
    if (report.ok) {
      const missing = firstUnmaterializedChange(input, report);
      if (missing) {
        return writerRejection(
          input.request,
          "doc_sync_invalid_payload",
          `The doc-sync writer reported accepted but did not materialize ${missing} in ledger ${report.appliedLedgerSha}.`
        );
      }
    }
    return report;
  } catch (error) {
    if (error instanceof RepoWriteIpcPayloadTooLargeError) {
      return writerRejection(
        input.request,
        "doc_sync_invalid_payload",
        `Repo writer ${error.sender} IPC payload cannot be sent because it is too large at ${error.path}: ${error.boundary} is `
          + `${error.actualBytes} bytes, limit ${error.maximumBytes} bytes, over by ${error.excessBytes} bytes. `
          + "Next: split the request or send large content by working-tree path or attachment reference.",
        {
          ipcError: {
            name: "RepoWriteIpcPayloadTooLargeError",
            code: error.code,
            delivery: "definitely-not-sent",
            sender: error.sender,
            path: error.path,
            boundary: error.boundary,
            actualBytes: error.actualBytes,
            maximumBytes: error.maximumBytes,
            excessBytes: error.excessBytes
          }
        }
      );
    }
    if (error instanceof ExternalDocSyncWorkingTreeReferenceError) {
      return writerRejection(
        input.request,
        "doc_sync_invalid_payload",
        "The internal writer-working-tree content kind cannot be supplied at the doc-sync wire boundary. "
          + "Run 'ha doc status --json', rebuild the request with inline content, then retry 'ha doc sync --submit'."
      );
    }
    return docSyncJournalUnavailable(
      input.request,
      error instanceof Error ? error.stack ?? error.message : String(error)
    );
  }
}

function firstUnmaterializedChange(
  input: Pick<Parameters<typeof dispatchDocSyncSubmitToWriter>[0], "rootDir" | "layoutOverrides">,
  report: Extract<DocSyncSubmitResultV1, { readonly ok: true }>
): string | null {
  const layout = resolveHarnessLayout(input.layoutOverrides
    ? { rootDir: input.rootDir, layoutOverrides: input.layoutOverrides }
    : input.rootDir);
  for (const change of report.appliedChanges) {
    try {
      const body = execFileSync(
        "git",
        ["-C", layout.authoredRoot, "show", `${report.appliedLedgerSha}:${change.path}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
      );
      if (sha256Text(body) !== change.newBlobSha256) return change.path;
    } catch {
      return change.path;
    }
  }
  return null;
}

function writerRejection(
  request: DocSyncSubmitRequestV1,
  code: Extract<DocSyncSubmitResultV1, { readonly ok: false }>["code"],
  reason: string,
  extra: Partial<Extract<DocSyncSubmitResultV1, { readonly ok: false }>> = {}
): DocSyncSubmitResultV1 {
  return {
    ok: false,
    _tag: "WriteRejected",
    schema: "daemon.doc-sync-submit-result/v1",
    status: "rejected",
    intentId: request.payload.intentId,
    code,
    reason,
    retryable: false,
    ...extra
  };
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
