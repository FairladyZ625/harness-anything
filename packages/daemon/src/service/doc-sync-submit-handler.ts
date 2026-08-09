import type {
  AuthorityHostAttribution,
  DaemonDocSyncHostServices,
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1,
  TaskHolderExecutor
} from "@harness-anything/application";
import { execFileSync } from "node:child_process";
import { resolveHarnessLayout, type HarnessLayoutOverrides } from "@harness-anything/kernel";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { DocSyncServiceContext } from "../protocol/doc-sync-service-context.ts";
import type { HarnessDaemonRuntime } from "../runtime/repo-runtime.ts";
import type { RepoWriteProcessSupervisor } from "../runtime/repo-write-process-supervisor.ts";
import { makeDaemonQueuedWriteCoordinator } from "../lifecycle/queued-write-coordinator.ts";
import { makeDocSyncService } from "./doc-sync-service.ts";
import { dispatchDocSyncSubmitToWriter } from "./doc-sync-writer-dispatch.ts";

export function makeDocSyncSubmitHandler(options: {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly runtime: HarnessDaemonRuntime;
  readonly hostServices: DaemonDocSyncHostServices;
  readonly actorAttribution: (
    actor: AuthenticatedActor,
    executor: TaskHolderExecutor | null
  ) => AuthorityHostAttribution;
  readonly supervisor?: RepoWriteProcessSupervisor;
}): (
  request: DocSyncSubmitRequestV1,
  context?: DocSyncServiceContext
) => Promise<DocSyncSubmitResultV1> {
  return async (request, context) => {
    const actor = context?.actor;
    const attribution = actor
      ? options.actorAttribution(actor, context?.executor ?? null)
      : undefined;
    if (options.supervisor) {
      return dispatchDocSyncSubmitToWriter({
        rootDir: options.rootDir,
        ...(options.layoutOverrides ? { layoutOverrides: options.layoutOverrides } : {}),
        request,
        actor,
        executor: context?.executor,
        authority: context?.authorityConnection,
        supervisor: options.supervisor
      });
    }
    const result = await makeDocSyncService({
      rootDir: options.rootDir,
      layoutOverrides: options.layoutOverrides,
      hostServices: options.hostServices,
      ...(attribution ? {
        coordinator: makeDaemonQueuedWriteCoordinator(
          options.runtime,
          `doc-sync-submit:${request.payload.intentId}`,
          {
            attribution: attribution.writeAttribution,
            commitAuthor: attribution.commitAuthor,
            ...(request.session?.sessionId
              ? { sessionId: request.session.sessionId }
              : {})
          }
        )
      } : {})
    }).submit(request);
    if (!result.ok || result.appliedChanges.length === 0) {
      return result.ok
        ? { ...result, settlementMode: "synchronous-canonical-final/v1" }
        : result;
    }
    const sessionId = request.session?.sessionId;
    if (!sessionId) {
      throw new Error("Doc sync accepted a durable change without a queryable session id.");
    }
    const materialization = await options.runtime.enqueueMaterializerBatch({ sessionId });
    assertCanonicalContainsAcceptedCommit(
      resolveHarnessLayout(options.layoutOverrides
        ? { rootDir: options.rootDir, layoutOverrides: options.layoutOverrides }
        : options.rootDir).authoredRoot,
      result.appliedLedgerSha,
      materialization
    );
    return { ...result, settlementMode: "synchronous-canonical-final/v1" };
  };
}

function assertCanonicalContainsAcceptedCommit(
  authoredRoot: string,
  acceptedCommitSha: string,
  materialization: Awaited<ReturnType<HarnessDaemonRuntime["enqueueMaterializerBatch"]>>
): void {
  const head = execFileSync(
    "git",
    ["-C", authoredRoot, "rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  ).trim();
  try {
    execFileSync(
      "git",
      ["-C", authoredRoot, "merge-base", "--is-ancestor", acceptedCommitSha, head],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
    );
  } catch {
    throw new Error(
      `Doc sync durable commit ${acceptedCommitSha} is not an ancestor of canonical ${head}; materializer=${JSON.stringify(materialization)}`
    );
  }
}
