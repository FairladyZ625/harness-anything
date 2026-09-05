#!/usr/bin/env node
// Rebuild a repository's task projection offline, from its ledger only, without any daemon.
// Run it against a COPY of the repository before a daemon generation change: a rebuild that throws here
// is exactly the data-shape latch the new daemon would raise on attach.
//   node --experimental-strip-types tools/offline-projection-rebuild.mjs <repo-root> [repo-id]
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , repoRootArg, repoId = "canonical"] = process.argv;
if (!repoRootArg) {
  console.error("usage: node --experimental-strip-types tools/offline-projection-rebuild.mjs <repo-root> [repo-id]");
  process.exit(2);
}
const repoRoot = path.resolve(repoRootArg),
  kernelRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
  kernel = await import(pathToFileURL(path.join(kernelRoot, "packages/kernel/src/index.ts")).href),
  eventStore = kernel.makeTaskEventReader({ repoId, rootDir: repoRoot }),
  head = eventStore.readHead(),
  projection = kernel.makeTaskProjection({ rootDir: repoRoot, eventStore });
try {
  const receipt = projection.rebuild();
  console.log(
    `offline-projection-rebuild: ok repo=${repoId} head=${head?.revision ?? 0} watermark=${receipt.watermark}`,
  );
} catch (error) {
  console.error(`offline-projection-rebuild: FAILED repo=${repoId} head=${head?.revision ?? 0}`);
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  projection.close();
}
