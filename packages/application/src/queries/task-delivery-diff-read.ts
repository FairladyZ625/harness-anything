import { currentExecutionCuts, type TaskProjection } from "@harness-anything/kernel";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import { requireCurrentTaskProjection } from "./projection-task-read.ts";
import { queryCodedError } from "./task-query-ports.ts";

export interface DaemonTaskDeliveryDiffLine {
  readonly kind: "context" | "add" | "remove";
  readonly oldLineNo?: number;
  readonly newLineNo?: number;
  readonly text: string;
}
export interface DaemonTaskDeliveryDiffFile {
  readonly filePath: string;
  readonly lines: readonly DaemonTaskDeliveryDiffLine[];
}
export type DaemonTaskDeliveryDiffResult = {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly taskId: string;
  readonly baseline: string | null;
  readonly commitSha: string | null;
  readonly files: readonly DaemonTaskDeliveryDiffFile[];
  readonly truncated: boolean;
  readonly watermark: number;
  readonly sourceRevision: number;
};

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const MAX_DIFF_LINES = 2_000;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** Parses the stable, no-color unified patch emitted by the daemon's Git read boundary. */
export function parseGitDiffPatch(
  patch: string,
  maxLines = MAX_DIFF_LINES,
): {
  readonly files: readonly DaemonTaskDeliveryDiffFile[];
  readonly truncated: boolean;
} {
  const files: DaemonTaskDeliveryDiffFile[] = [];
  let current: { readonly filePath: string; readonly lines: DaemonTaskDeliveryDiffLine[] } | null = null;
  let oldLine = 0;
  let newLine = 0;
  let emitted = 0;
  let truncated = false;

  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      if (!match) {
        current = null;
        continue;
      }
      current = { filePath: match[2]!, lines: [] };
      files.push(current);
      oldLine = 0;
      newLine = 0;
      continue;
    }
    if (current === null) continue;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      continue;
    }
    // File headers (`---`/`+++`) begin with a diff marker too, but they are
    // metadata rather than hunk lines. Only parse markers after a hunk header.
    if (oldLine === 0 && newLine === 0) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-") continue;
    if (emitted >= maxLines) {
      truncated = true;
      break;
    }
    const text = line.slice(1);
    if (marker === " ") {
      current.lines.push({ kind: "context", oldLineNo: oldLine, newLineNo: newLine, text });
      emitted += 1;
      oldLine += 1;
      newLine += 1;
    } else if (marker === "+") {
      current.lines.push({ kind: "add", newLineNo: newLine, text });
      emitted += 1;
      newLine += 1;
    } else {
      current.lines.push({ kind: "remove", oldLineNo: oldLine, text });
      emitted += 1;
      oldLine += 1;
    }
  }
  return { files: files.filter((file) => file.lines.length > 0), truncated };
}

/** Read the frozen delivery baseline to the submitted commit through the daemon Git boundary. */
export function readTaskDeliveryDiff(
  rootDir: string,
  projection: Pick<TaskProjection, "read">,
  taskId: string,
  gitDiff?: (rootDir: string, baselineRef: string, commitSha: string) => string,
): DaemonTaskDeliveryDiffResult {
  const read = requireCurrentTaskProjection(projection, taskId, "task delivery diff read");
  const cuts = currentExecutionCuts(read.snapshot);
  const execution = cuts.length === 1 ? cuts[0] : undefined;
  const commitSha = execution?.submission?.commitSha ?? null;
  const baseline = execution?.deliveryBaseline;
  const baselineRef =
    baseline === undefined ? null : baseline.kind === "empty-tree" ? EMPTY_TREE_SHA : baseline.commitSha;
  if (commitSha === null || baselineRef === null) {
    return {
      ok: true,
      status: "ready",
      taskId,
      baseline: baselineRef,
      commitSha,
      files: [],
      truncated: false,
      watermark: read.watermark,
      sourceRevision: read.sourceRevision,
    };
  }
  if (!gitDiff) throw queryCodedError("delivery_diff_unavailable", "Delivery diff requires a local git reader.");
  const patch = gitDiff(rootDir, baselineRef, commitSha);
  const parsed = parseGitDiffPatch(patch, MAX_DIFF_LINES);
  return {
    ok: true,
    status: "ready",
    taskId,
    baseline: baselineRef,
    commitSha,
    files: parsed.files,
    truncated: parsed.truncated || Buffer.byteLength(patch, "utf8") > MAX_DIFF_BYTES,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}
