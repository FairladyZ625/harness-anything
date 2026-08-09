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

/**
 * Task package artifacts are free-form authored files, so no preset template declares a
 * managed section policy for them and the policy probe below can never admit them. They
 * are still the same governed task-document lane the self-hosted repo publishes them
 * through, so admit them by path instead of leaving consumer repos without a road.
 */
const consumerTaskArtifactPath = /^tasks\/[^/]+\/artifacts\/.+/u;

export function isConsumerGovernedTaskDocument(
  rootDir: string,
  authoredRoot: string,
  entry: ConsumerDirtyEntry,
  hostServices: DaemonDocSyncHostServices
): boolean {
  if (entry.status === "deleted" || !/^tasks\/[^/]+\/.+/u.test(entry.path)) return false;
  if (consumerTaskArtifactPath.test(entry.path)) return true;
  return hostServices.resolveDeclaredManagedSectionPolicy({
    rootDir,
    layoutOverrides: { authoredRoot: path.relative(rootDir, authoredRoot) }
  }, entry.path) !== null;
}
