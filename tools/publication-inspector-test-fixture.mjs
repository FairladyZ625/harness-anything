import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGitCanonicalPublicationInspector } from "../packages/daemon/src/authority/production/publication-evidence.ts";
import { removeTemporaryTestRoot } from "./test-temp-root-cleanup.mjs";

export function useGitCanonicalPublicationInspector(context, options) {
  const inspector = createGitCanonicalPublicationInspector(options.rootDir);
  const removeRoot = options.removeRoot
    ?? (() => removeTemporaryTestRoot(options.rootDir));

  context.after(async () => {
    await inspector.shutdown();
    await removeRoot();
  });

  return inspector;
}

export async function withTemporaryGitCanonicalPublicationInspector(context, options, run) {
  const containerRoot = mkdtempSync(path.join(tmpdir(), options.prefix));
  const rootDir = options.relativeRoot === undefined
    ? containerRoot
    : path.join(containerRoot, options.relativeRoot);
  mkdirSync(rootDir, { recursive: true });
  const inspector = useGitCanonicalPublicationInspector(context, {
    rootDir,
    removeRoot: async () => await removeTemporaryTestRoot(containerRoot)
  });
  await run({ rootDir, inspector });
}
