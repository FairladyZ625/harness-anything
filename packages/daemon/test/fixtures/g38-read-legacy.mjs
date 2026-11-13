// The explicit generation-1 audit is a real history reader too. Prepare its immutable
// source outside the measurement and run the production CLI action, never its missing-source refusal.
import {
  createImmutableLegacyGenerationSnapshot,
  convertLegacyGeneration,
  preflightConvertedGenerationActivation,
  legacyGenerationSnapshotPath,
} from "../../../storage/src/store/legacy-generation-conversion.ts";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { initRepo } from "../../../storage/test/store/task-event-store.fixtures.ts";
import { runLedgerReconcileAction } from "../../src/repo-cell-migration-actions.ts";
import { eventAt } from "../../../storage/test/store/task-event-store.fixtures.ts";

export function prepareLegacyAudit(context, dimension, size) {
  const rootDir = path.join(context.rootDir, ".harness", "g38-legacy");
  mkdirSync(rootDir, { recursive: true });
  initRepo(rootDir);
  context.legacyRootDir = rootDir;
  const snapshotPath = legacyGenerationSnapshotPath(rootDir),
    // Only event volume is relevant to the legacy audit; other dimensions keep its source fixed.
    count = dimension === "source-events" ? size : 2,
    events = Array.from({ length: count }, (_, index) => eventAt(index + 1));
  createImmutableLegacyGenerationSnapshot({
    repoId: "g38-read",
    snapshotPath,
    source: {
      read: () => ({ events }),
      readBatch: () => ({
        sourceRevision: events.length,
        events,
        cursor: null,
        done: true,
        accessedItems: events.length,
        prefetchContent: () => new Map(),
      }),
      readContentBlob: () => null,
    },
  });
  convertLegacyGeneration({ rootDir, snapshotPath });
  preflightConvertedGenerationActivation({ repoId: "g38-read", rootDir, snapshotPath });
}

export function runLegacyAudit({ runtime, legacyRootDir }) {
  return runLedgerReconcileAction(
    Object.create(runtime.actionContext, { rootDir: { value: legacyRootDir } }),
    { kind: "ledger-reconcile", generation: 1 },
    runtime.binding,
  );
}
