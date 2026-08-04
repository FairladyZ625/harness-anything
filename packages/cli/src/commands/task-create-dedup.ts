import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyTaskPlanAdmission,
  type TaskPlanAdmissionSnapshotV1
} from "@harness-anything/application";
import {
  isDomainStatus,
  listTaskIndexPaths,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  slugifyTaskTitle,
  type DomainStatus,
  type HarnessLayoutInput
} from "@harness-anything/kernel";
import { bundledTaskDocumentPlaceholderPolicy } from "./core/task-document-placeholders.ts";
import { profileIssue, type ProfileValidationIssue } from "./check-profile-types.ts";

export const TASK_CREATE_DUPLICATE_WINDOW_MS = 30_000;

export interface TaskCreateCandidate {
  readonly taskId: string;
  readonly title: string;
  readonly parent?: string;
  readonly status: DomainStatus;
  readonly packageDisposition: "active" | "archived" | "tombstoned";
  readonly bindingCreatedAt?: string;
  readonly packagePath: string;
  readonly packageSlug: string;
  readonly idempotencyKey?: string;
  readonly taskPlanAdmission: TaskPlanAdmissionSnapshotV1;
}

export interface TaskCreateWarning {
  readonly code: "task_create_duplicate_title" | "task_create_idempotency_reused";
  readonly severity: "warning";
  readonly message: string;
  readonly existingTaskId: string;
  readonly existingPackagePath: string;
  readonly nextCommand: string;
}

export interface TaskCreateOrphanDuplicate {
  readonly candidate: TaskCreateCandidate;
  readonly siblings: ReadonlyArray<TaskCreateCandidate>;
}

export function readTaskCreateCandidates(rootInput: HarnessLayoutInput): ReadonlyArray<TaskCreateCandidate> {
  const layout = resolveHarnessLayout(rootInput);
  const policy = bundledTaskDocumentPlaceholderPolicy();
  const candidates: TaskCreateCandidate[] = [];

  for (const indexPath of listTaskIndexPaths(rootInput)) {
    try {
      const indexBody = readFileSync(indexPath, "utf8");
      const frontmatter = readFrontmatter(indexBody);
      if (!frontmatter) continue;
      const taskId = readScalar(frontmatter, "task_id");
      const title = readScalar(frontmatter, "title");
      const status = readScalar(frontmatter, "  status");
      if (!taskId || !title || !isDomainStatus(status)) continue;

      const taskDir = path.dirname(indexPath);
      const taskPlanPath = path.join(taskDir, "task_plan.md");
      const taskPlan = existsSync(taskPlanPath) ? readFileSync(taskPlanPath, "utf8") : null;
      const taskPlanAdmission = classifyTaskPlanAdmission({
        taskId,
        taskRoot: taskDir,
        taskPlan,
        policy
      });
      const packageDisposition = readPackageDisposition(frontmatter);
      const packageName = path.basename(taskDir);
      const packagePrefix = `${taskId}-`;
      const packageSlug = packageName.startsWith(packagePrefix)
        ? packageName.slice(packagePrefix.length)
        : slugifyTaskTitle(title);
      const bindingCreatedAt = readScalar(frontmatter, "  bindingCreatedAt") || undefined;
      const idempotencyKey = readScalar(frontmatter, "idempotencyKey") || undefined;
      const parent = readScalar(frontmatter, "parent") || undefined;

      candidates.push({
        taskId,
        title,
        ...(parent ? { parent } : {}),
        status,
        packageDisposition,
        ...(bindingCreatedAt ? { bindingCreatedAt } : {}),
        packagePath: path.relative(layout.rootDir, taskDir).split(path.sep).join("/"),
        packageSlug,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        taskPlanAdmission
      });
    } catch {
      // Other check validators report malformed authored packages. Deduplication is advisory and skips them.
    }
  }

  return candidates.sort((left, right) => {
    const leftCreatedAt = Date.parse(left.bindingCreatedAt ?? "");
    const rightCreatedAt = Date.parse(right.bindingCreatedAt ?? "");
    if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt) && leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
    return left.taskId.localeCompare(right.taskId);
  });
}

export function findTaskCreateByIdempotencyKey(
  rootInput: HarnessLayoutInput,
  idempotencyKey: string
): TaskCreateCandidate | undefined {
  return readTaskCreateCandidates(rootInput).find((candidate) =>
    candidate.packageDisposition !== "tombstoned" && candidate.idempotencyKey === idempotencyKey
  );
}

export function findRecentTaskCreateDuplicate(
  rootInput: HarnessLayoutInput,
  input: { readonly title: string; readonly parent?: string; readonly createdAt?: string; readonly excludeTaskId?: string }
): TaskCreateCandidate | undefined {
  const createdAt = Date.parse(input.createdAt ?? new Date().toISOString());
  if (!Number.isFinite(createdAt)) return undefined;
  return readTaskCreateCandidates(rootInput).find((candidate) => {
    if (candidate.taskId === input.excludeTaskId || candidate.packageDisposition === "tombstoned") return false;
    if (candidate.title !== input.title || candidate.parent !== input.parent) return false;
    const candidateCreatedAt = Date.parse(candidate.bindingCreatedAt ?? "");
    return Number.isFinite(candidateCreatedAt)
      && Math.abs(createdAt - candidateCreatedAt) <= TASK_CREATE_DUPLICATE_WINDOW_MS;
  });
}

export function idempotencyReuseWarning(candidate: TaskCreateCandidate): TaskCreateWarning {
  return {
    code: "task_create_idempotency_reused",
    severity: "warning",
    message: `Idempotency key matched existing task ${candidate.taskId}; no new task was created.`,
    existingTaskId: candidate.taskId,
    existingPackagePath: candidate.packagePath,
    nextCommand: `ha task start ${candidate.taskId}`
  };
}

export function duplicateTitleWarning(candidate: TaskCreateCandidate): TaskCreateWarning {
  return {
    code: "task_create_duplicate_title",
    severity: "warning",
    message: `A task with the same title and parent was created within ${TASK_CREATE_DUPLICATE_WINDOW_MS / 1000}s (existing task ${candidate.taskId}). This create continued; inspect and reuse the existing task if the retry was unintentional.`,
    existingTaskId: candidate.taskId,
    existingPackagePath: candidate.packagePath,
    nextCommand: `ha task start ${candidate.taskId}`
  };
}

export function findOrphanTaskCreateDuplicates(
  rootInput: HarnessLayoutInput,
  taskDirs?: ReadonlyArray<string>
): ReadonlyArray<TaskCreateOrphanDuplicate> {
  const candidates = readTaskCreateCandidates(rootInput);
  const selectedDirs = taskDirs ? new Set(taskDirs.map((taskDir) => path.resolve(taskDir))) : undefined;
  const groups = new Map<string, TaskCreateCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.packageDisposition === "tombstoned") continue;
    const key = `${candidate.parent ?? ""}\u0000${candidate.title}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((siblings) => siblings.length >= 2)
    .flatMap((siblings) => siblings
      .filter((candidate) => candidate.status === "planned" && candidate.taskPlanAdmission.state !== "substantive")
      .filter((candidate) => !selectedDirs || selectedDirs.has(path.resolve(resolveHarnessLayout(rootInput).rootDir, candidate.packagePath)))
      .map((candidate) => ({
        candidate,
        siblings: siblings.filter((sibling) => sibling.taskId !== candidate.taskId)
      })))
    .sort((left, right) => left.candidate.taskId.localeCompare(right.candidate.taskId));
}

export function orphanTaskCreateProfileIssues(
  rootInput: HarnessLayoutInput,
  taskDirs?: ReadonlyArray<string>
): ReadonlyArray<ProfileValidationIssue> {
  return findOrphanTaskCreateDuplicates(rootInput, taskDirs).map(({ candidate, siblings }) => profileIssue(
    "task-create-dedup",
    "task_create_orphan_duplicate",
    "warning",
    `Task ${candidate.taskId} is planned with an untouched task scaffold at ${candidate.packagePath}, but has same-title sibling task(s): ${siblings.map((sibling) => sibling.taskId).join(", ")}.`,
    `Inspect ${candidate.packagePath} and the sibling package(s) before starting work; reuse the intended task or archive/supersede the orphan after confirming intent.`
  ));
}

export function taskCreateReuseResult(candidate: TaskCreateCandidate): {
  readonly taskId: string;
  readonly slug: string;
  readonly status: DomainStatus;
  readonly packagePath: string;
} {
  return {
    taskId: candidate.taskId,
    slug: candidate.packageSlug,
    status: candidate.status,
    packagePath: candidate.packagePath
  };
}

function readPackageDisposition(frontmatter: string): TaskCreateCandidate["packageDisposition"] {
  const value = readScalar(frontmatter, "packageDisposition");
  return value === "archived" || value === "tombstoned" ? value : "active";
}
