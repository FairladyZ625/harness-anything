import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FleetFrameV1 } from "./contract.ts";
import { readEdgeManifestEntries } from "./edge-manifest.ts";

/** Read the durable manifests and staging pages that pin shared edge CAS blobs. */
export function referencedEdgeBlobs(viewsRoot: string, views: readonly string[]): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const view of views) {
    // Receiving views have already verified some blobs into the shared CAS.
    // Their durable pages pin those blobs until publication or staging eviction.
    const stagingRoot = path.join(viewsRoot, view, ".staging");
    if (existsSync(stagingRoot))
      for (const transfer of readdirSync(stagingRoot)) {
        const transferRoot = path.join(stagingRoot, transfer);
        for (const name of readdirSync(transferRoot).filter((name) => /^page-\d+\.json$/u.test(name))) {
          const page = JSON.parse(readFileSync(path.join(transferRoot, name), "utf8")) as Extract<
            FleetFrameV1,
            { schema: "fleet.snapshot.page/v1" | "fleet.delta.page/v1" }
          >;
          for (const entry of page.schema === "fleet.snapshot.page/v1" ? page.entries : page.changes)
            if ("blob" in entry) referenced.add(entry.blob.sha256);
        }
      }
    const root = path.join(viewsRoot, view, "cuts");
    if (!existsSync(root)) continue;
    for (const revision of readdirSync(root)
      .filter((name) => /^\d+-g\d+$/u.test(name))
      .slice(0, 2)) {
      const file = path.join(root, revision, "manifest.json");
      if (existsSync(file)) for (const entry of readEdgeManifestEntries(file)) referenced.add(entry.blob.sha256);
    }
  }
  return referenced;
}
