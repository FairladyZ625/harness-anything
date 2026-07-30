import path from "node:path";
import { buildDocSyncReport } from "@harness-anything/daemon";
import { resolveManagedSectionPolicy } from "../extensions/managed-section-policy.ts";

const docSyncHostServices = { resolveManagedSectionPolicy };
import { resolveHarnessLayout, taskPackagePath, type HarnessLayoutInput, type TaskId } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";

export function buildDocSyncStatusResult(rootInput: HarnessLayoutInput): CliResult {
  const report = buildDocSyncReport(rootInput, docSyncHostServices);
  return {
    ok: true,
    command: "doc-status",
    rows: report.dirtyFiles.length,
    path: report.authoredRoot,
    report
  };
}

export function buildDocSyncDryRunResult(rootInput: HarnessLayoutInput): CliResult {
  const report = buildDocSyncReport(rootInput, docSyncHostServices);
  return {
    ok: true,
    command: "doc-sync-dry-run",
    rows: report.writeIntentPreview.changes.length,
    path: report.authoredRoot,
    report
  };
}

export function docSyncDirtyWarnings(rootInput: HarnessLayoutInput): ReadonlyArray<Record<string, unknown>> | undefined {
  const report = buildDocSyncReport(rootInput, docSyncHostServices);
  if (report.dirtyFiles.length === 0) return undefined;
  return [{
    severity: "warning",
    code: "doc_sync_dirty",
    message: `Doc sync has ${report.dirtyFiles.length} dirty file(s); run ha doc status before task closeout or decision propose.`,
    dirtyCount: report.dirtyFiles.length,
    forbiddenTouchCount: report.forbiddenTouches.length,
    unresolvedCount: report.unresolvedTouches.length,
    deletionCount: report.deletions.length
  }];
}

export function taskDocSyncPaths(rootInput: HarnessLayoutInput, taskId: string): ReadonlyArray<string> {
  const layout = resolveHarnessLayout(rootInput);
  const packageRoot = path.relative(
    layout.authoredRoot,
    taskPackagePath(rootInput, taskId as TaskId)
  ).split(path.sep).join("/");
  return buildDocSyncReport(rootInput, docSyncHostServices).dirtyFiles
    .map((entry) => entry.path)
    .filter((entryPath) => entryPath === packageRoot || entryPath.startsWith(`${packageRoot}/`));
}

export function resolveTaskDocSyncPaths(
  rootInput: HarnessLayoutInput,
  taskId: string,
  command: "task-closeout" | "task-complete"
): { readonly ok: true; readonly paths: ReadonlyArray<string> } | { readonly ok: false; readonly result: CliResult } {
  try {
    return { ok: true, paths: taskDocSyncPaths(rootInput, taskId) };
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        command,
        taskId,
        error: cliError(
          CliErrorCode.WriteRejected,
          `Task document sync preflight failed: ${error instanceof Error ? error.message : String(error)}. Next: run \`ha doc status\`, repair the reported task prose, then retry the same owner approval.`
        )
      }
    };
  }
}
