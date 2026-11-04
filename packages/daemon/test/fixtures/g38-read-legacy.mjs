// The explicit generation-1 audit is a real history reader too. Prepare its immutable
// source outside the measurement and run the production CLI action, never its missing-source refusal.
import {
  createImmutableLegacyGenerationSnapshot,
  convertLegacyGeneration,
  preflightConvertedGenerationActivation,
  legacyGenerationSnapshotPath,
} from "../../../storage/src/store/legacy-generation-conversion.ts";
import { eventAt } from "../../../storage/test/store/task-event-store.fixtures.ts";

export function prepareLegacyAudit({ rootDir }, dimension, size) {
  const snapshotPath = legacyGenerationSnapshotPath(rootDir),
    // Only event volume is relevant to the legacy audit; other dimensions keep its source fixed.
    count = dimension === "event-bytes" ? size : 2,
    events = Array.from({ length: count }, (_, index) => eventAt(index + 1));
  createImmutableLegacyGenerationSnapshot({
    repoId: "g38-read",
    snapshotPath,
    source: { read: () => ({ events }), readContentBlob: () => null },
  });
  convertLegacyGeneration({ rootDir, snapshotPath });
  preflightConvertedGenerationActivation({ repoId: "g38-read", rootDir, snapshotPath });
}
