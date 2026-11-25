import type { DocWriteIntent } from "@harness-anything/kernel";
import { parseNodeDocIntent } from "@harness-anything/application/internal/queries/doc-sync-adjudication.ts";
import { scanDocCandidates, type DocCandidateScan, validateSelectedDocPaths } from "./doc-sync-candidate-scanner.ts";
import type { Input } from "./doc-sync-command-actions.ts";
import { directPaths } from "./doc-sync-details.ts";
import { docSyncError, hasExactDocSyncActionFields } from "./doc-sync-files.ts";
import { workspacePathOf } from "./doc-sync-settlement.ts";

export {
  adjudicateDocIntent,
  type DocIntentAdjudication,
  type DocIntentChannel,
} from "@harness-anything/application/internal/queries/doc-sync-adjudication.ts";

export function nodeIntent(input: Input): DocWriteIntent {
  return parseNodeDocIntent(input, (paths) => directPaths(input.rootDir, paths));
}

export function scannerRead(input: Input): DocCandidateScan {
  const taskScoped = Object.hasOwn(input.action, "taskId"),
    fields = taskScoped ? ["kind", "taskId"] : ["kind", "paths"];
  if (
    !hasExactDocSyncActionFields(input.action, fields) ||
    (taskScoped
      ? typeof input.action.taskId !== "string"
      : !Array.isArray(input.action.paths) || input.action.paths.some((item) => typeof item !== "string"))
  )
    throw docSyncError("invalid_command", `${input.action.kind} requires authored-root-relative paths or a task id`);
  const executionId = docScanExecutionId(input);
  const scan = scanDocCandidates({
    rootDir: input.rootDir,
    workspaceId: input.workspaceId,
    store: input.store,
    projection: input.projection,
    actor: input.binding.actor,
    source: input.binding.source,
    now: input.now(),
    nodeTaskMaterializationPolicy: input.nodeTaskMaterializationPolicy,
    ...(!taskScoped ? { selection: input.action.paths as string[] } : {}),
    ...(typeof input.action.taskId === "string" ? { taskId: input.action.taskId } : {}),
    ...(executionId === null ? {} : { executionId }),
    ...(input.authoredCandidateInventory ? { inventory: input.authoredCandidateInventory } : {}),
  });
  if (!taskScoped) validateSelectedDocPaths(input.action.paths as string[], scan, workspacePathOf(input));
  return scan;
}

export function scannerSubmit(input: Input): DocCandidateScan {
  const taskScoped = Object.hasOwn(input.action, "taskId"),
    fields = taskScoped
      ? ["kind", "taskId"]
      : Object.hasOwn(input.action, "executionId")
        ? ["kind", "executionId", "paths"]
        : Object.hasOwn(input.action, "all")
          ? ["kind", "paths", "all"]
          : ["kind", "paths"];
  if (
    !hasExactDocSyncActionFields(input.action, fields) ||
    (taskScoped
      ? typeof input.action.taskId !== "string"
      : !Array.isArray(input.action.paths) || input.action.paths.some((item) => typeof item !== "string")) ||
    (Object.hasOwn(input.action, "executionId") && typeof input.action.executionId !== "string") ||
    (Object.hasOwn(input.action, "all") && input.action.all !== true)
  )
    throw docSyncError("invalid_command", "local doc submit requires scanner paths or a task id");
  const executionId = docScanExecutionId(input);
  const scan = scanDocCandidates({
    rootDir: input.rootDir,
    workspaceId: input.workspaceId,
    store: input.store,
    projection: input.projection,
    actor: input.binding.actor,
    source: input.binding.source,
    now: input.now(),
    worktreeRevision: input.store.followerStatus().worktree.cut?.revision ?? 0,
    ...(input.binding.observedDocGitPaths === undefined ? {} : { observedGitPaths: input.binding.observedDocGitPaths }),
    nodeTaskMaterializationPolicy: input.nodeTaskMaterializationPolicy,
    ...(!taskScoped ? { selection: input.action.paths as string[] } : {}),
    ...(typeof input.action.taskId === "string" ? { taskId: input.action.taskId } : {}),
    ...(executionId === null ? {} : { executionId }),
    ...(input.authoredCandidateInventory ? { inventory: input.authoredCandidateInventory } : {}),
  });
  if (!taskScoped) validateSelectedDocPaths(input.action.paths as string[], scan, workspacePathOf(input));
  return scan;
}

function docScanExecutionId(input: Input): string | null {
  if (typeof input.action.executionId === "string") return input.action.executionId;
  const principal = input.binding.executionPrincipal;
  return principal?.role === "implementation" && principal.taskId !== null ? principal.executionId : null;
}
