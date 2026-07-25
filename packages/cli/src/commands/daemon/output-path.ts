import { resolveHarnessLayout } from "@harness-anything/kernel";
import { resolveContainedOutputPath } from "../../cli/output-path.ts";

export function requireDaemonProductOutputPath(options: {
  readonly requestedPath: string;
  readonly rootDir: string;
  readonly canonicalRoot?: string;
  readonly label: string;
}): string {
  const canonicalRoot = options.canonicalRoot ?? options.rootDir;
  const layout = resolveHarnessLayout({ rootDir: canonicalRoot });
  const resolved = resolveContainedOutputPath({
    requestedPath: options.requestedPath,
    containerRoots: [...new Set([options.rootDir, canonicalRoot])],
    canonicalRoots: [layout.authoredRoot],
    relativeTo: options.rootDir
  });
  if (!resolved.ok) {
    throw new Error(`${options.label} rejected (${resolved.reason}): output must remain in an allowed repository, outside canonical authored paths, without symlinks.`);
  }
  return resolved.path;
}
