import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isCloseoutPlaceholderMarkdown } from "@harness-anything/application";
import {
  isDomainStatus,
  isPackageDisposition,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  type HarnessLayoutInput
} from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CliResult } from "../cli/types.ts";
import { bundledTaskDocumentPlaceholderPolicy } from "./core/task-document-placeholders.ts";
import { parseSettingsDocument } from "./settings-document.ts";

export const DEFAULT_TASK_WIP_LIMIT = 30;

type TaskWipLimitResult =
  | { readonly ok: true; readonly limit: number }
  | { readonly ok: false; readonly result: CliResult };

export function resolveTaskWipLimit(
  rootInput: HarnessLayoutInput,
  command = "task-wip-limit"
): TaskWipLimitResult {
  const layout = resolveHarnessLayout(rootInput);
  const configPath = layout.configPath ?? path.join(layout.authoredRoot, "harness.yaml");
  if (!existsSync(configPath)) return { ok: true, limit: DEFAULT_TASK_WIP_LIMIT };
  try {
    const parsed = parseSettingsDocument(readFileSync(configPath, "utf8")).taskWipLimit;
    if (parsed === undefined) return { ok: true, limit: DEFAULT_TASK_WIP_LIMIT };
    const limit = parsePositiveWipLimit(parsed);
    return limit === undefined
      ? invalidWipLimit(command)
      : { ok: true, limit };
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        command,
        error: cliError(
          CliErrorCode.HarnessSettingsInvalid,
          error instanceof Error ? error.message : "Unable to read settings.tasks.wipLimit."
        )
      }
    };
  }
}

export function readTaskWipSnapshot(rootInput: HarnessLayoutInput) {
  const resolved = resolveTaskWipLimit(rootInput, "task-wip-admission");
  if (!resolved.ok) {
    throw new Error(resolved.result.error?.hint ?? "Unable to resolve settings.tasks.wipLimit.");
  }
  const layout = resolveHarnessLayout(rootInput);
  if (!existsSync(layout.tasksRoot)) return { limit: resolved.limit, tasks: [] };
  const taskRows = readdirSync(layout.tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const indexPath = path.join(layout.tasksRoot, entry.name, "INDEX.md");
      if (!existsSync(indexPath)) return [];
      const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
      if (!frontmatter || readScalar(frontmatter, "schema", { required: true }) !== "task-package/v2") {
        throw new Error(`Invalid task WIP source: ${indexPath}`);
      }
      const taskId = readScalar(frontmatter, "task_id", { required: true });
      const title = readScalar(frontmatter, "title", { required: true });
      const parent = readScalar(frontmatter, "parent");
      const status = readScalar(frontmatter, "  status", { required: true });
      const packageDisposition = readScalar(frontmatter, "packageDisposition", { required: true });
      if (!isDomainStatus(status) || !isPackageDisposition(packageDisposition)) {
        throw new Error(`Invalid task WIP axes: ${indexPath}`);
      }
      const hasCloseoutEvidence = taskHasCloseoutEvidence(path.dirname(indexPath));
      return [{
        taskId,
        title,
        parent,
        status,
        packageDisposition,
        ...(hasCloseoutEvidence ? { hasCloseoutEvidence: true } : {})
      }];
    });
  const parentTaskIds = new Set(taskRows.map((task) => task.parent).filter((parent) => parent.length > 0));
  const tasks = taskRows
    .map(({ parent: _parent, ...task }) => ({ ...task, isContainer: parentTaskIds.has(task.taskId) }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  return { limit: resolved.limit, tasks };
}

function taskHasCloseoutEvidence(taskRoot: string): boolean {
  const closeoutPath = path.join(taskRoot, "closeout.md");
  if (existsSync(closeoutPath)) {
    const closeout = readFileSync(closeoutPath, "utf8");
    const policy = bundledTaskDocumentPlaceholderPolicy();
    if (closeout.trim() && !isCloseoutPlaceholderMarkdown(closeout, policy.closeoutPlaceholderFingerprints)) return true;
  }
  return ["review.md", "code-doc-anchors.json"].some((document) => {
    const documentPath = path.join(taskRoot, document);
    return existsSync(documentPath) && readFileSync(documentPath, "utf8").trim().length > 0;
  });
}

function invalidWipLimit(command: string): Extract<TaskWipLimitResult, { readonly ok: false }> {
  return {
    ok: false,
    result: {
      ok: false,
      command,
      error: cliError(CliErrorCode.HarnessSettingsInvalid, "settings.tasks.wipLimit must be a positive integer.")
    }
  };
}

function parsePositiveWipLimit(value: unknown): number | undefined {
  if (typeof value === "string" && !/^[0-9]+$/u.test(value)) return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
