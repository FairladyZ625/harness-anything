import { buildDocSyncReport } from "../../daemon/doc-sync-service.ts";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import type { CliResult } from "../../cli/types.ts";

export function buildDocSyncStatusResult(rootInput: HarnessLayoutInput): CliResult {
  const report = buildDocSyncReport(rootInput);
  return {
    ok: true,
    command: "doc-status",
    rows: report.dirtyFiles.length,
    path: report.authoredRoot,
    report
  };
}

export function buildDocSyncDryRunResult(rootInput: HarnessLayoutInput): CliResult {
  const report = buildDocSyncReport(rootInput);
  return {
    ok: true,
    command: "doc-sync-dry-run",
    rows: report.writeIntentPreview.changes.length,
    path: report.authoredRoot,
    report
  };
}

export function docSyncDirtyWarnings(rootInput: HarnessLayoutInput): ReadonlyArray<Record<string, unknown>> | undefined {
  const report = buildDocSyncReport(rootInput);
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
