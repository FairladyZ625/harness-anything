import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { compactDispatchStreamArchive } from "./dispatch-stream-compaction.ts";

type Schedule = (work: () => void | Promise<void>) => void;

/** Move a terminal stream out of the directory enumerated by live-runtime reads. */
export function archiveDispatchStream(rootDir: string, dispatchId: string): void {
  const { live, archived } = streamPaths(rootDir, dispatchId);
  if (statSync(live, { throwIfNoEntry: false })?.isFile()) {
    mkdirSync(path.dirname(archived), { recursive: true, mode: 0o700 });
    renameSync(live, archived);
  } else if (!statSync(archived, { throwIfNoEntry: false })?.isFile()) return;
  compactDispatchStreamArchive(archived, dispatchId);
}

/** Queue one local terminal archive at a time so existing writer work can run between files. */
export function scheduleArchivedDispatchStreamCompaction(rootDir: string, schedule: Schedule): void {
  const root = dispatchRoot(rootDir),
    archive = path.join(root, "archive");
  if (!statSync(archive, { throwIfNoEntry: false })?.isDirectory()) return;
  const dispatchIds = readdirSync(archive)
    .filter((name) => /^dispatch_[a-f0-9]{24}\.jsonl$/u.test(name))
    .map((name) => name.slice(0, -6))
    .sort();
  let nextIndex = 0;
  const enqueueNext = (): void => {
    const dispatchId = dispatchIds[nextIndex++];
    if (!dispatchId) return;
    schedule(() => {
      try {
        const archived = path.join(archive, `${dispatchId}.jsonl`);
        if (statSync(archived, { throwIfNoEntry: false })?.isFile()) compactDispatchStreamArchive(archived, dispatchId);
      } finally {
        enqueueNext();
      }
    });
  };
  enqueueNext();
}

function streamPaths(rootDir: string, dispatchId: string): { readonly live: string; readonly archived: string } {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) throw new Error("dispatch id is invalid");
  const root = dispatchRoot(rootDir);
  return {
    live: path.join(root, `${dispatchId}.jsonl`),
    archived: path.join(root, "archive", `${dispatchId}.jsonl`),
  };
}

function dispatchRoot(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).localRoot, "runtime", "dispatches");
}
