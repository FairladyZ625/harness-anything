import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import {
  legacyGenerationSnapshotPath,
  openSqliteEventStore,
  reconcileSqliteEvents,
  sqliteLedgerPath,
} from "../../kernel/src/index.ts";

function retired(cell: RepoCellOperationalContext): never {
  throw cell.cellCodedError(
    "invalid_command",
    "in-place historical migration is retired; convert an immutable generation snapshot before activation",
  );
}

export function runEventShapeMigrationAction(cell: RepoCellOperationalContext, ..._ignored: readonly unknown[]): never {
  return retired(cell);
}

export function runDispatchRecordMigrationAction(
  cell: RepoCellOperationalContext,
  ..._ignored: readonly unknown[]
): never {
  return retired(cell);
}

export function runLedgerMigrateAction(cell: RepoCellOperationalContext, ..._ignored: readonly unknown[]): never {
  return retired(cell);
}

export async function runLedgerReconcileAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
) {
  const revision = cell.store.readHead()?.revision ?? 0,
    sqlite = openSqliteEventStore({
      repoId: cell.input.repoId,
      databasePath: sqliteLedgerPath(cell.rootDir, 1),
      generation: 1,
      readOnly: true,
    });
  try {
    const kernel = (await import("../../kernel/src/index.ts")) as typeof import("../../kernel/src/index.ts") & {
        readCertifiedGitFollower: (input: {
          readonly rootInput: string;
          readonly repoId: string;
          readonly store: typeof sqlite;
        }) => Parameters<typeof reconcileSqliteEvents>[0]["gitReadback"];
      },
      gitReadback = kernel.readCertifiedGitFollower({
        rootInput: cell.rootDir,
        repoId: cell.input.repoId,
        store: sqlite,
      }),
      report = reconcileSqliteEvents({
        repoId: cell.input.repoId,
        rootDir: cell.rootDir,
        snapshotPath: legacyGenerationSnapshotPath(cell.rootDir),
        gitReadback,
      });
    return cell.readResult(
      cell.operationId(action, binding, cell.input.repoId, revision),
      report,
      revision,
      report.gitReadbackMatches,
    );
  } finally {
    sqlite.close();
  }
}
