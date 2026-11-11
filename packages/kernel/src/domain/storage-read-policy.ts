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
  },
  version: 1,
  scope: "Canonical store and projection reads across SQLite, PostgreSQL and PGlite",
  reason: "Keep one definition of the existing read window and I/O budgets across storage implementations.",
  fixtures: ["packages/kernel/test/contracts/storage-read-policy.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.deadlines:9cc282e7e1557b13746f94046f6d8471",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#storageReadPolicy.defaultValue.backoff:363471a61222366e81d60c1609b28ffc",
    "policy:packages/kernel:packages/kernel/src/domain/storage-read-policy.ts#canTruncateRelationNeighborhood:71e7fc70dba7394fc8c33ece3b96825c",
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
