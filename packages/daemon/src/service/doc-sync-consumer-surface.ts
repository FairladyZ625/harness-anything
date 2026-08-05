import path from "node:path";
import type { DaemonDocSyncHostServices } from "@harness-anything/application";

/**
 * The fields this surface actually reads. Declaring them structurally keeps the check off
 * the deep `application/doc-sync` subpath, which is under a sunset ratchet; the row shape
 * is validated where doc-sync-service assigns it to its registry contract.
 */
interface ConsumerDirtyEntry {
  readonly status: string;
  readonly path: string;
}

export const consumerDocSyncRows = [{
  id: "task.document.write-stage",
  bearing: "task-document",
  channel: {
    pathClass: "doc-sync-allowed",
    zoneClass: "task-authored-prose-or-stage"
  }
}] as const;

export function isConsumerGovernedTaskDocument(
  rootDir: string,
  authoredRoot: string,
  entry: ConsumerDirtyEntry,
  hostServices: DaemonDocSyncHostServices
): boolean {
  if (entry.status === "deleted" || !/^tasks\/[^/]+\/.+/u.test(entry.path)) return false;
  return hostServices.resolveDeclaredManagedSectionPolicy({
    rootDir,
    layoutOverrides: { authoredRoot: path.relative(rootDir, authoredRoot) }
  }, entry.path) !== null;
}
