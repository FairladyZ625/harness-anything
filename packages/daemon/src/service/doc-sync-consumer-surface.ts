import path from "node:path";
import type { DaemonDocSyncHostServices } from "@harness-anything/application";
import type { DirtyEntry, RegistryRow } from "@harness-anything/application/doc-sync";

export const consumerDocSyncRows: ReadonlyArray<RegistryRow> = [{
  id: "task.document.write-stage",
  bearing: "task-document",
  channel: {
    pathClass: "doc-sync-allowed",
    zoneClass: "task-authored-prose-or-stage"
  }
}];

export function isConsumerGovernedTaskDocument(
  rootDir: string,
  authoredRoot: string,
  entry: DirtyEntry,
  hostServices: DaemonDocSyncHostServices
): boolean {
  if (entry.status === "deleted" || !/^tasks\/[^/]+\/.+/u.test(entry.path)) return false;
  return hostServices.resolveManagedSectionPolicy({
    rootDir,
    layoutOverrides: { authoredRoot: path.relative(rootDir, authoredRoot) }
  }, entry.path) !== null;
}
