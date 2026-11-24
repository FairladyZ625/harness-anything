import {
  deriveTaskRoot,
  documentWorkspacePath,
  resolveHarnessLayout,
  type TaskProjection,
  type TaskProjectionListQuery,
} from "@harness-anything/kernel";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { selectTaskIndex } from "./task-index-query.ts";

export type TaskListAction = Readonly<Record<string, unknown>>;

export const DEFAULT_TASK_LIST_LIMIT = storageReadPolicy.defaultValue.listDefaults.taskLimit;

/** The reads `task list` needs; the center projection and an edge task read model both provide them. */
export interface TaskListReads {
  readonly readTaskIndex: TaskProjection["readTaskIndex"];
  readonly readTaskChildCounts: TaskProjection["readTaskChildCounts"];
  readonly rootThreshold: number;
}

/** The read model keeps the ledger key; a caller-facing row carries both spellings so the CLI
 * boundary can print the workspace one without inventing it. */
export function withWorkspacePackagePaths(
  rootDir: string,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rows = payload.rows;
  if (!Array.isArray(rows) || typeof rootDir !== "string" || rootDir === "") return payload;
  const layout = resolveHarnessLayout(rootDir);
  return {
    ...payload,
    rows: rows.map((row) => {
      const packagePath =
        row !== null && typeof row === "object" ? (row as { packagePath?: unknown }).packagePath : null;
      return typeof packagePath === "string"
        ? { ...(row as object), workspacePackagePath: documentWorkspacePath(rootDir, packagePath, layout) }
        : row;
    }),
  };
}

/** One `task list` answer computed from `reads`; presentation status is the caller's read choice. */
export function taskListPayload(
  reads: TaskListReads,
  query: TaskProjectionListQuery,
  action: TaskListAction,
  codedError: (code: string, message: string) => Error,
): {
  readonly read: ReturnType<TaskProjection["readTaskIndex"]>;
  readonly payload: Readonly<Record<string, unknown>> & { readonly sourceRevision: number };
} {
  const depth = taskListDepth(action.depth);
  if (depth === null)
    throw codedError(
      "invalid_command",
      "Task list depth must be a positive integer or all; use it with --parent <task-id>.",
    );
  if (depth !== undefined && typeof action.parentTaskId !== "string")
    throw codedError(
      "invalid_command",
      "Task list --depth requires --parent <task-id> so the recursive subtree has one root.",
    );
  const filters = {
      ...(query.status ? { status: query.status } : {}),
      ...(typeof action.workKind === "string" ? { workKind: action.workKind } : {}),
      ...(typeof action.riskTier === "string" ? { riskTier: action.riskTier } : {}),
      ...(typeof action.urgency === "string" ? { urgency: action.urgency } : {}),
      ...(typeof action.search === "string" ? { search: action.search } : {}),
      ...(query.updatedAfter ? { updatedAfter: query.updatedAfter } : {}),
      ...(query.updatedBefore ? { updatedBefore: query.updatedBefore } : {}),
    },
    flat = depth === undefined,
    effectiveLimit = flat && query.limit === undefined ? DEFAULT_TASK_LIST_LIMIT : query.limit,
    read = reads.readTaskIndex(
      flat
        ? {
            ...filters,
            ...(typeof action.parentTaskId === "string" ? { parentTaskId: action.parentTaskId } : {}),
            ...(effectiveLimit === undefined ? {} : { limit: effectiveLimit }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            activePackagesOnly: true,
          }
        : { activePackagesOnly: true },
    );
  let selected: ReturnType<typeof selectTaskIndex>;
  try {
    selected = selectTaskIndex(
      read.rows.filter((row) => row.packageDisposition === "active"),
      {
        ...(typeof action.parentTaskId === "string" ? { parentTaskId: action.parentTaskId } : {}),
        ...(depth === undefined ? {} : { depth }),
        ...(flat
          ? {}
          : {
              filters,
              ...(query.limit === undefined ? {} : { limit: query.limit }),
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            }),
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "task list cursor is invalid")
      throw codedError("invalid_command", "Task list cursor is invalid; restart the filtered query.");
    throw error;
  }
  // Filters and pages narrow the rows; a row's children are still counted across the whole ledger.
  const childCounts = selected.mode === "flat" ? reads.readTaskChildCounts(selected.rows.map((row) => row.taskId)) : {},
    value =
      selected.mode === "tree"
        ? {
            schema: "task-list/v2" as const,
            mode: "tree" as const,
            parentTaskId: action.parentTaskId,
            depth,
            rows: selected.rows,
            count: selected.count,
            warnings: read.warnings,
            ...(selected.page ? { page: selected.page } : {}),
          }
        : {
            schema: "task-list/v2" as const,
            mode: "flat" as const,
            rows: selected.rows.map((row) => {
              const directChildCount = childCounts[row.taskId] ?? 0;
              return {
                taskId: row.taskId,
                status: row.status,
                title: row.title,
                pinned: row.pinned,
                updatedAt: row.updatedAt,
                packagePath: row.packagePath,
                packageDisposition: row.packageDisposition,
                taskClass: row.taskClass,
                rootAssessment: deriveTaskRoot(
                  {
                    taskId: row.taskId,
                    title: row.title,
                    status: row.status,
                    taskClass: row.taskClass,
                    packageDisposition: row.packageDisposition,
                    hasCloseoutEvidence: false,
                    hasOwnExecution: false,
                    directChildCount,
                  },
                  reads.rootThreshold,
                ),
              };
            }),
            count: selected.rows.length,
            warnings: read.warnings,
            ...(read.page ? { page: read.page } : {}),
          };
  return {
    read,
    payload: {
      ...value,
      status: read.status,
      watermark: read.watermark,
      sourceRevision: read.sourceRevision,
    },
  };
}

function taskListDepth(value: unknown): number | "all" | undefined | null {
  if (value === undefined) return undefined;
  if (value === "all") return value;
  const depth = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(depth) || depth < 1) return null;
  return depth;
}
