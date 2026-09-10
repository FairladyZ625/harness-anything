import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { existsSync } from "node:fs";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import {
  legacyGenerationSnapshotPath,
  openSqliteEventStore,
  readCertifiedGitFollower,
  reconcileSqliteEvents,
  sqliteLedgerPath,
} from "../../kernel/src/index.ts";

export async function runLedgerReconcileAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
) {
  const generation = Number(action.generation ?? 1);
  if (generation !== 1)
    throw cell.cellCodedError("invalid_command", "only canonical SQLite generation 1 can reconcile");
  const databasePath = sqliteLedgerPath(cell.rootDir, 1);
  if (!existsSync(databasePath))
    throw cell.cellCodedError(
      "legacy_source_missing",
      "This repository started at generation 2; there is no generation 1 import to reconcile.",
    );
  const revision = cell.store.readHead()?.revision ?? 0,
    sqlite = openSqliteEventStore({
      repoId: cell.input.repoId,
      databasePath,
      generation: 1,
      readOnly: true,
    });
  try {
    const gitReadback = readCertifiedGitFollower({
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
