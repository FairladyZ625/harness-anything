import type { TaskProjection } from "@harness-anything/kernel";

/** The repository a command resolved its task id against; a not-found answer names it so a
 * wrong-directory invocation sees which repository was actually searched. */
export interface TaskRepositoryScope {
  readonly repoId?: string;
  readonly rootDir?: string;
}

/** The one error mapping for "this task id resolves to no entity" (dec_66CE6F92): one code, one
 * sentence. Read faces and task-id write commands throw or settle it; callers never re-compose it. */
export function taskNotFoundCodedError(
  taskId: string,
  scope?: TaskRepositoryScope,
): Error & { readonly code: "task_not_found" } {
  const of = scope?.repoId === undefined ? "" : ` of repository ${scope.repoId}`;
  const at = scope?.rootDir === undefined ? "" : ` at ${scope.rootDir}`;
  return Object.assign(new Error(`Task ${taskId} does not exist in the canonical event stream${of}${at}.`), {
    code: "task_not_found",
  } as const);
}

// Task-gated commands (fact record, runtime.run) execute inside the RepoCell write queue. Every writer
// applies its projection in the same synchronous turn as its SQLite append, and nothing else advances
// the projection while the queue is held, so a lagging cut cannot catch up by waiting: check it once.
export function requireCurrentTaskProjection(
  projection: Pick<TaskProjection, "read">,
  taskId: string,
  purpose: string,
): ReturnType<TaskProjection["read"]> & { readonly packagePath: string } {
  const read = projection.read(taskId);
  if (read.watermark < read.sourceRevision)
    throw projectionNotReady(
      `Task ${taskId} package projection for ${purpose} is behind the canonical event stream`,
      read,
    );
  if (!read.snapshot.task) throw taskNotFoundCodedError(taskId);
  if (!read.packagePath)
    throw projectionNotReady(`Task ${taskId} has a canonical event but no projected package for ${purpose}`, read);
  return read as ReturnType<TaskProjection["read"]> & { readonly packagePath: string };
}

// Serving read faces (task show, task dispatches) resolve one requested id against the applied
// cut: a current projection without that task is a not-found answer naming the id, never an
// empty success. A lagging cut stays the caller's pending case — not-found must not race a
// projection that could still apply the task. Callers throw it or settle it into a receipt
// per their channel; the judgment and its wording live only here.
export function projectedTaskNotFound(
  read: Pick<ReturnType<TaskProjection["read"]>, "watermark" | "sourceRevision" | "snapshot">,
  taskId: string,
): (Error & { readonly code: "task_not_found" }) | null {
  if (read.watermark < read.sourceRevision) return null;
  return read.snapshot.task ? null : taskNotFoundCodedError(taskId);
}

function projectionNotReady(
  label: string,
  cut: { readonly watermark: number; readonly sourceRevision: number },
): Error {
  return Object.assign(
    new Error(`${label}: watermark ${String(cut.watermark)}, source revision ${String(cut.sourceRevision)}.`),
    { code: "content_not_ready", watermark: cut.watermark, sourceRevision: cut.sourceRevision },
  );
}
