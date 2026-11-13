import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

/** Bounds shared by SQLite and PostgreSQL readers, with the existing endpoint-specific ceilings. */
export const storageReadPolicy = {
  id: "storage-read",
  ownerRef: "host",
  unit: "rows / milliseconds / revisions",
  bounds: "Safe integer limits >=1 and revisions >=0; endpoint ceilings remain 64, 500 and 2048 rows.",
  defaultValue: {
    minimumRows: 1,
    minimumRevision: 0,
    pageSizes: { standard: 500, summaries: 2048, sessions: 64, progress: 4096, one: 1 },
    deadlines: {
      startup: 10_000,
      query: 30_000,
      projectionBusy: 250,
      openBusy: 5000,
      migrationConnect: 10000,
      migrationStatement: 30000,
    },
    backoff: { openBusy: 10, followerInitial: 25, followerMaximum: 2_000 },
    artifacts: { defaultLimit: 100 },
    listDefaults: {
      eventLimit: 50,
      taskLimit: 50,
      workspaceEventLimit: 120,
      dispatchLifecycleLimit: 100,
    },
    graph: { seedBudget: 128 },
    recovery: {
      coldAttachCatchUpLimit: 32,
      worktreeDocumentBatchLimit: 1_000,
    },
    reckoningWindowHours: 24,
    cachePurgeRetry: {
      maxRetries: 5,
      retryDelayMs: 20,
    },
  },
  version: 1,
  scope: "Canonical store and projection reads across SQLite, PostgreSQL and PGlite",
  reason: "Keep one definition of the existing read window and I/O budgets across storage implementations.",
  fixtures: ["packages/kernel/test/contracts/storage-read-policy.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.deadlines:9cc282e7e1557b13746f94046f6d8471",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.backoff:363471a61222366e81d60c1609b28ffc",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#canTruncateRelationNeighborhood:71e7fc70dba7394fc8c33ece3b96825c",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.artifacts.defaultLimit:c9c1b440bfca1f688680bf8f4f97911b",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.listDefaults.eventLimit:af131e9043c5798f551a336ac2ab3c41",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.listDefaults.taskLimit:fba3a69453c6aaaff069d04e069379a8",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.listDefaults.workspaceEventLimit:56495accb2eb1a690144572720e76f63",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.listDefaults.dispatchLifecycleLimit:c0bbc3d63d8e45893002246601583889",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.graph.seedBudget:dec368dbd6f01b4c82b66fd89af32274",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.recovery.coldAttachCatchUpLimit:e58d3fe7187c1a0c0dc8bf1b82dc2acc",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.recovery.worktreeDocumentBatchLimit:c6da8087a6c8f5df80dc91060f3a6976",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.cachePurgeRetry:57746726f7504c5d9f4ad2767a149e71",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.cachePurgeRetry.retryDelayMs:744254044a70bba9acf6abae0555428c",
    "policy:packages/daemon:packages/daemon/src/artifacts-gui-read.ts#readArtifactsGui.requested:c3b19c97fb9a2d6c51967ed9ddb6c71b",
    "policy:packages/daemon:packages/daemon/src/repo-cell-api.ts#createRepoCellApi.readHandlers.repo.reckoning.signals.read:05343817f7422dcd69b9d1e227424a91",
    "policy:packages/daemon:packages/daemon/src/repo-cell-graph-view.ts#graphView.neighborhood.allowTruncation:6052554b2fa22ca756cf496958282915",
    "policy:packages/daemon:packages/daemon/src/repo-cell-graph-view.ts#graphView.expandedDecisions:48427b12b21add9b36d7852eabb32bdd",
    "policy:packages/daemon:packages/daemon/src/repo-cell-graph-view.ts#graphView:22b28695f347aacab8c9d7f16a9cfe11",
    "policy:packages/daemon:packages/daemon/src/repo-cell-read-payloads.ts#agendaQueryFromPayload:10015b6d19caf66f27f6afb9f5793cbe",
    "policy:packages/daemon:packages/daemon/src/repo-cell-read-payloads.ts#taskDispatchesPayloadFromCell:1e410a47b8130f415656caf06dbafb0b",
    "policy:packages/daemon:packages/daemon/src/repo-cell-read-payloads.ts#taskDispatchesPayloadFromCell:a3a2f89ba4366a78072518509837feab",
    "policy:packages/daemon:packages/daemon/src/repo-cell-task-query.ts#taskListPayload.filters:0dc800d70d87d9bed556be8cc5352f37",
    "policy:packages/daemon:packages/daemon/src/repo-in-flight-work.ts#readRepoInFlightWork.leases.leaseOnly:7d0d008d737a90dacc53b3213c67778a",
    "policy:packages/daemon:packages/daemon/src/repo-in-flight-work.ts#readRepoInFlightWork.leases:695ebba4b9ab3fb8b008ea95e7ff5ab6",
    "policy:packages/daemon:packages/daemon/src/repo-query-payload.ts#queryPayloadFacets:19c0f6299471f260fbf794e097e5a2b3",
    "policy:packages/daemon:packages/daemon/src/repo-query-payload.ts#taskListQueryFromPayload.leaseOnly:7d0d008d737a90dacc53b3213c67778a",
    "policy:packages/daemon:packages/daemon/src/repo-query-payload.ts#taskListQueryFromPayload:51ec53e9b2dc1dc57430075914e024cf",
  ].map((candidateId) => ({ candidateId, route: "storageReadPolicy" })),
} as const satisfies OntologyPolicyDeclaration;

export function validateStorageReadWindow(
  limit: number,
  maximum: number = Number.MAX_SAFE_INTEGER,
  afterRevision: number = storageReadPolicy.defaultValue.minimumRevision,
): boolean {
  if (!Number.isSafeInteger(afterRevision) || afterRevision < storageReadPolicy.defaultValue.minimumRevision)
    return false;
  return Number.isSafeInteger(limit) && limit >= storageReadPolicy.defaultValue.minimumRows && limit <= maximum;
}

export const storageReadJudgment = {
  id: "storage-read-window",
  symbol: "packages/kernel/src/domain/storage-read-policy.ts#validateStorageReadWindow",
  inputs: ["limit", "endpoint ceiling", "afterRevision"],
  output: "boolean",
  failureCodes: [],
  explain: "A read window uses safe integer rows and revisions within the endpoint ceiling.",
  consumers: [
    "packages/storage/src/pg/pg-event-queries.ts",
    "packages/storage/src/pg/pg-runtime-dispatch-queries.ts",
    "packages/storage/src/pg/pg-runtime-session-queries.ts",
    "packages/storage/src/postgres/pg-event-store.ts",
    "packages/storage/src/projection/event-list-query.ts",
    "packages/storage/src/projection/rebuildable-task-projection-runtime.ts",
    "packages/storage/src/projection/rebuildable-task-projection-task-queries.ts",
    "packages/storage/src/projection/repository-event-queries.ts",
  ],
  sources: [
    {
      candidateId:
        "judgment:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#validateStorageReadWindow:6a8cdc60e632c4f815a114b3c3bede91",
      route: "storage bounded read validation",
    },
  ],
} as const satisfies OntologyJudgmentDeclaration;

/** Truncation is a caller-selected read mode and requires an explicit true flag. */
export function canTruncateRelationNeighborhood(allowTruncation: unknown): boolean {
  if (allowTruncation === true) return true;
  return false;
}

export const storageReadAdditionalJudgments = [
  {
    id: "canTruncateRelationNeighborhood",
    symbol: "packages/kernel/src/domain/storage-read-policy.ts#canTruncateRelationNeighborhood",
    inputs: ["allowTruncation"],
    output: "boolean",
    failureCodes: [],
    explain: "Preserve the existing canTruncateRelationNeighborhood verdict at one canonical definition.",
    consumers: [
      "packages/storage/src/pg/pg-graph-queries.ts",
      "packages/storage/src/projection/rebuildable-task-projection-task-queries.ts",
    ],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#canTruncateRelationNeighborhood:b40ea6c494f5b6857dc727d79ea947c6",
        route: "storage-read-policy",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];
