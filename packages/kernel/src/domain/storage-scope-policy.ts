import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

export interface StorageScope {
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly readers?: readonly string[];
  readonly policyEpoch?: number;
}
export interface PostgresScopeClaims {
  readonly tenantId: string;
  readonly projectId: string;
  readonly policyEpoch: number;
}
export interface PostgresEventStoreScope extends PostgresScopeClaims {
  readonly readers: readonly string[];
}
type ScopeRow = Pick<PostgresEventStoreScope, "readers" | "policyEpoch">;
interface MigrationTuple {
  readonly scope: ScopeRow;
  readonly events: readonly ScopeRow[];
  readonly blobs: readonly ScopeRow[];
  readonly outcomes: readonly ScopeRow[];
  readonly documentHeads: readonly ScopeRow[];
}
export class StorageMigrationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "StorageMigrationError";
  }
}

export function resolvePostgresEventStoreScope(scope: StorageScope | undefined): PostgresEventStoreScope {
  if (
    typeof scope?.tenantId !== "string" ||
    !scope.tenantId ||
    typeof scope.projectId !== "string" ||
    !scope.projectId ||
    !Number.isSafeInteger(scope.policyEpoch) ||
    scope.policyEpoch! < 0
  )
    throw new TypeError("PostgreSQL storage requires tenant, project, and non-negative policy epoch scope");
  if (
    scope.readers !== undefined &&
    (!Array.isArray(scope.readers) || scope.readers.some((reader) => typeof reader !== "string" || !reader))
  )
    throw new TypeError("PostgreSQL readers must be an array of nonempty identities");
  return {
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    policyEpoch: scope.policyEpoch!,
    readers: scope.readers ?? [],
  };
}

export function assertPostgresClaims(claims: PostgresScopeClaims): void {
  if (!claims.tenantId || !claims.projectId || !Number.isSafeInteger(claims.policyEpoch) || claims.policyEpoch < 0)
    throw new TypeError("PostgreSQL scope claims require tenant, project, and a non-negative safe policy epoch.");
}

export function assertSqliteMigrationScope(tuples: readonly MigrationTuple[]): void {
  if (tuples.length !== 1)
    throw new StorageMigrationError(
      "storage_migration_multiple_tuples",
      "SQLite requires exactly one tenant/project tuple",
    );
  const tuple = tuples[0]!;
  if (
    [tuple.scope, ...tuple.events, ...tuple.blobs, ...tuple.outcomes, ...tuple.documentHeads].some(
      (row) => row.readers.length > 0,
    )
  )
    throw new StorageMigrationError("storage_migration_readers", "SQLite cannot enforce PostgreSQL readers");
  if (
    [tuple.scope, ...tuple.events, ...tuple.blobs, ...tuple.outcomes, ...tuple.documentHeads].some(
      (row) => row.policyEpoch !== 0,
    )
  )
    throw new StorageMigrationError("storage_migration_policy_epoch", "SQLite cannot enforce policy_epoch");
}

export function assertPostgresStoreScope(repoId: string, scope: PostgresEventStoreScope): void {
  if (
    !repoId ||
    !scope.tenantId ||
    !scope.projectId ||
    !Number.isSafeInteger(scope.policyEpoch) ||
    scope.policyEpoch < 0 ||
    scope.readers.some((reader) => !reader)
  )
    throw new TypeError(
      "PostgreSQL event store requires repoId, tenantId, projectId, readers, and a non-negative policyEpoch scope",
    );
}

export const storageScopePolicy = {
  id: "storage-scope",
  ownerRef: "host",
  unit: "admission constraints",
  bounds:
    "PostgreSQL scopes require tenant/project and a non-negative safe epoch; SQLite migration accepts one tuple with no readers and epoch zero.",
  defaultValue: null,
  version: 1,
  scope: "storage-scope",
  reason: "Keep the existing admission rule and its unique pure implementation together.",
  fixtures: ["packages/storage/test/migration/storage-migration-recovery.integration.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/storage-scope-policy.ts#resolvePostgresEventStoreScope:ba92d31e4752cfe77e5b624ae15c2bc8",
    "policy:packages/kernel:packages/kernel/src/domain/storage-scope-policy.ts#assertPostgresClaims:5312ed68cf1379a960ba250924adeb03",
    "policy:packages/kernel:packages/kernel/src/domain/storage-scope-policy.ts#assertSqliteMigrationScope:e9df009a089b3adb05b87c3d43c6a0a5",
    "policy:packages/kernel:packages/kernel/src/domain/storage-scope-policy.ts#assertPostgresStoreScope:65ffee98d53d13b57074855fe60cdec4",
  ].map((candidateId) => ({ candidateId, route: "storage-scope" })),
} as const satisfies OntologyPolicyDeclaration;
export const storageScopePolicyJudgments = [
  {
    id: "assertPostgresClaims",
    symbol: "packages/kernel/src/domain/storage-scope-policy.ts#assertPostgresClaims",
    inputs: ["PostgreSQL scope"],
    output: "void or original admission error",
    failureCodes: [],
    explain:
      "PostgreSQL scopes require tenant/project and a non-negative safe epoch; SQLite migration accepts one tuple with no readers and epoch zero.",
    consumers: ["packages/storage/src/postgres/transaction.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/storage-scope-policy.ts#assertPostgresClaims:f0ccffe0a96162939a9d97508986334d",
        route: "storage-scope",
      },
    ],
  },
  {
    id: "assertSqliteMigrationScope",
    symbol: "packages/kernel/src/domain/storage-scope-policy.ts#assertSqliteMigrationScope",
    inputs: ["readonly migration scope tuples"],
    output: "void or original admission error",
    failureCodes: ["storage_migration_multiple_tuples", "storage_migration_readers", "storage_migration_policy_epoch"],
    explain:
      "PostgreSQL scopes require tenant/project and a non-negative safe epoch; SQLite migration accepts one tuple with no readers and epoch zero.",
    consumers: ["packages/storage/src/migration/engine.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/storage-scope-policy.ts#assertSqliteMigrationScope:6502b8bec6d4fa49753bc330e176e8c7",
        route: "storage-scope",
      },
    ],
  },
  {
    id: "assertPostgresStoreScope",
    symbol: "packages/kernel/src/domain/storage-scope-policy.ts#assertPostgresStoreScope",
    inputs: ["PostgreSQL scope"],
    output: "void or original admission error",
    failureCodes: [],
    explain:
      "PostgreSQL scopes require tenant/project and a non-negative safe epoch; SQLite migration accepts one tuple with no readers and epoch zero.",
    consumers: ["packages/storage/src/postgres/pg-task-event-store.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/storage-scope-policy.ts#assertPostgresStoreScope:6958500735257de91121860ec1af2a86",
        route: "storage-scope",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];
