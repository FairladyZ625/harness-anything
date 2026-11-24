import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";

const dispatchIdPattern = /^dispatch_[a-f0-9]{24}$/u;

/** The stream's repository-relative path under this repository's own local root, in POSIX form. */
export function dispatchStreamRelativePath(rootDir: string, dispatchId: string): string {
  if (!dispatchIdPattern.test(dispatchId)) throw new Error("dispatch id is invalid");
  const layout = resolveHarnessLayout(rootDir),
    absolute = path.join(layout.localRoot, "runtime", "dispatches", `${dispatchId}.jsonl`);
  return path.relative(layout.rootDir, absolute).split(path.sep).join("/");
}
