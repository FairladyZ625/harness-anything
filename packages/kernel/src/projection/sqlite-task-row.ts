import path from "node:path";
import type { CloseoutReadiness } from "../domain/index.ts";
import { isDomainStatus, isPackageDisposition, isPriorityTier, isTaskWorkKind, isTerminalStatus } from "../domain/index.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveHarnessLayout } from "../layout/index.ts";
import { readScalar } from "../markdown/frontmatter.ts";
import { unresolvedEntityAttribution } from "./entity-attribution-projection.ts";
import { readTextFileIfPresent, statPathIfPresent } from "./toctou-safe-fs.ts";
import type {
  CoordinationStatus,
  ProjectionCanonicalStatus,
  TaskFieldExtensionProjection,
  TaskProjectionRow
} from "./types.ts";

export interface TaskSourceEntry {
  readonly taskId: string;
  readonly indexPath: string;
  readonly body: string;
  readonly frontmatter: string;
  readonly statSignature: string;
}

export function taskEntryToRow(
  rootInput: HarnessLayoutInput,
  entry: TaskSourceEntry,
  fieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): TaskProjectionRow {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const rawStatus = readScalar(entry.frontmatter, "  status") || "unknown";
  const canonicalStatus = isDomainStatus(rawStatus) ? rawStatus : "unknown";
  const rawDisposition = readScalar(entry.frontmatter, "packageDisposition") || "active";
  const packageDisposition = isPackageDisposition(rawDisposition) ? rawDisposition : "active";
  const lifecycleEngine = readScalar(entry.frontmatter, "  engine") || "local";
  const taskDir = path.dirname(entry.indexPath);
  return {
    schema: "sqlite-task-row/v1",
    taskId: readScalar(entry.frontmatter, "task_id") || entry.taskId,
    title: readScalar(entry.frontmatter, "title") || entry.taskId,
    ...readParent(entry.frontmatter),
    canonicalStatus,
    coordinationStatus: coordinationStatus(canonicalStatus),
    rawStatus,
    packageDisposition,
    closeoutReadiness: closeoutReadiness(rootInput, entry.taskId, canonicalStatus),
    lifecycleEngine,
    freshness: canonicalStatus === "unknown" || !isPackageDisposition(rawDisposition) ? "stale-but-usable" : "fresh",
    updatedAt: (statPathIfPresent(entry.indexPath)?.mtime ?? new Date(0)).toISOString(),
    source: lifecycleEngine === "local" ? "local-document" : "external-engine",
    sourcePath: sourcePath(rootDir, entry.indexPath),
    ...readExtensionMetadata(entry.frontmatter),
    ...readFieldExtensions(entry.frontmatter, fieldExtensions),
    ...readTaskMetadata(entry.frontmatter),
    ...readModuleMetadata(taskDir),
    hasLessonCandidates: statPathIfPresent(path.join(taskDir, "lesson_candidates.md")) !== null,
    attribution: unresolvedEntityAttribution()
  };
}

export function sourcePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function readParent(frontmatter: string): { readonly parentTaskId?: string } {
  const parentTaskId = readScalar(frontmatter, "parent");
  return parentTaskId ? { parentTaskId } : {};
}

function readExtensionMetadata(frontmatter: string): { readonly vertical?: string; readonly preset?: string; readonly profile?: string } {
  const vertical = readScalar(frontmatter, "vertical");
  const preset = readScalar(frontmatter, "preset");
  const profile = readScalar(frontmatter, "profile");
  return {
    ...(vertical ? { vertical } : {}),
    ...(preset ? { preset } : {}),
    ...(profile ? { profile } : {})
  };
}

function readFieldExtensions(
  frontmatter: string,
  extensions: ReadonlyArray<TaskFieldExtensionProjection>
): { readonly fieldExtensions?: Readonly<Record<string, string | null>> } {
  if (extensions.length === 0) return {};
  const values = Object.fromEntries(extensions.map((extension) => {
    const rawValue = readScalar(frontmatter, extension.field);
    return [extension.field, extension.values.includes(rawValue) ? rawValue : extension.default];
  }));
  return Object.values(values).some((value) => value !== null) ? { fieldExtensions: values } : {};
}

function readTaskMetadata(frontmatter: string): Pick<TaskProjectionRow, "workKind" | "riskTier" | "urgency"> {
  const workKind = readScalar(frontmatter, "workKind");
  const riskTier = readScalar(frontmatter, "riskTier");
  const urgency = readScalar(frontmatter, "urgency");
  return {
    ...(isTaskWorkKind(workKind) ? { workKind } : {}),
    ...(isPriorityTier(riskTier) ? { riskTier } : {}),
    ...(isPriorityTier(urgency) ? { urgency } : {})
  };
}

function readModuleMetadata(taskDir: string): { readonly moduleKey?: string; readonly moduleTitle?: string } {
  const body = readTextFileIfPresent(path.join(taskDir, "module.md"));
  if (body === null) return {};
  const moduleKey = body.match(/^Module key:[ \t]*(.+)$/mu)?.[1]?.trim() ?? "";
  const moduleTitle = body.match(/^Module title:[ \t]*(.+)$/mu)?.[1]?.trim() ?? "";
  return {
    ...(moduleKey ? { moduleKey } : {}),
    ...(moduleTitle ? { moduleTitle } : {})
  };
}

function coordinationStatus(status: ProjectionCanonicalStatus): CoordinationStatus {
  if (status === "unknown") return "unknown";
  if (status === "blocked") return "blocked";
  if (status === "in_review") return "in_review";
  return isTerminalStatus(status) ? "terminal" : "open";
}

function closeoutReadiness(rootInput: HarnessLayoutInput, taskId: string, status: ProjectionCanonicalStatus): CloseoutReadiness {
  if (status === "unknown") return "missing";
  if (!isTerminalStatus(status) && status !== "in_review") return "not_required";
  const closeoutPath = path.join(resolveHarnessLayout(rootInput).tasksRoot, taskId, "closeout.md");
  return statPathIfPresent(closeoutPath) === null ? "missing" : "ready";
}
