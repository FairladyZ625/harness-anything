import {
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  dispatchAdmissionRefusal,
  type DispatchLifecycleQuery,
  type DispatchLifecycleRead,
  type DispatchLifecycleView,
} from "@harness-anything/kernel";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";

type CodedError = (code: string, message: string) => Error;

export type DispatchLifecycleReader = (
  query: DispatchLifecycleQuery,
) => DispatchLifecycleRead | Promise<DispatchLifecycleRead>;

export function readyDispatchLifecycle(
  page: DispatchLifecycleRead,
  error: CodedError,
): readonly DispatchLifecycleView[] {
  if (page.status !== "ready") throw dispatchLifecyclePendingError(page, error);
  return page.rows;
}

/** Synchronous writer/read sessions use the same bounded active index as remote consumers. */
export function readActiveDispatchLifecycleSync(
  read: (query: DispatchLifecycleQuery) => DispatchLifecycleRead,
  error: CodedError,
  instanceId?: string,
): DispatchLifecycleView[] {
  const rows: DispatchLifecycleView[] = [];
  let cursor: string | null = null;
  do {
    const page = read(activePage(instanceId, cursor));
    rows.push(...readyDispatchLifecycle(page, error));
    cursor = page.status === "ready" ? page.nextCursor : null;
  } while (cursor !== null);
  return rows;
}

export function readDispatchLifecycle(context: RuntimeSpawnerContext, query: DispatchLifecycleQuery) {
  return (
    context.input.remote?.readDispatchLifecycle(query) ??
    context.requiredRuntimeProjection(context.input).readDispatchLifecycle(query)
  );
}

export function dispatchLifecyclePendingError(
  page: Extract<DispatchLifecycleRead, { status: "pending" }>,
  error: CodedError,
): Error {
  return error(
    "dispatch_lifecycle_pending",
    `The dispatch lifecycle read model is at revision ${page.watermark} of ${page.sourceRevision}; retry the dispatch.`,
  );
}

export async function readActiveDispatchLifecycle(
  read: (query: DispatchLifecycleQuery) => DispatchLifecycleRead | Promise<DispatchLifecycleRead>,
  error: CodedError,
  instanceId?: string,
): Promise<DispatchLifecycleView[]> {
  const rows: DispatchLifecycleView[] = [];
  let cursor: string | null = null;
  while (true) {
    const page: DispatchLifecycleRead = await read(activePage(instanceId, cursor));
    if (page.status !== "ready") throw dispatchLifecyclePendingError(page, error);
    rows.push(...page.rows);
    if (page.nextCursor === null) return rows;
    cursor = page.nextCursor;
  }
}

/** Admission and append run inside the same center writer turn. */
export function requireDispatchLifecycleAdmission(
  read: (query: DispatchLifecycleQuery) => DispatchLifecycleRead,
  input: Omit<Parameters<typeof dispatchAdmissionRefusal>[0], "group" | "instance"> & {
    readonly attemptGroupId: string;
  },
  error: CodedError,
): void {
  const groupRead = read({ by: "group", attemptGroupId: input.attemptGroupId });
  if (groupRead.status !== "ready") throw dispatchLifecyclePendingError(groupRead, error);
  const refusal = dispatchAdmissionRefusal({
    group: groupRead.rows[0] ?? null,
    instance: readActiveDispatchLifecycleSync(read, error, input.instanceId),
    ...input,
  });
  if (refusal) throw error(refusal.code, refusal.message);
}

function activePage(instanceId: string | undefined, cursor: string | null): DispatchLifecycleQuery {
  return {
    by: "active",
    limit: DISPATCH_LIFECYCLE_PAGE_LIMIT,
    ...(instanceId ? { instanceId } : {}),
    ...(cursor === null ? {} : { cursor }),
  };
}

/** Wire validation belongs at the Fleet ingress; internal readers pass the typed query. */
export function validDispatchLifecycleQuery(query: DispatchLifecycleQuery): boolean {
  const text = (value: unknown) => typeof value === "string" && value.length > 0;
  const keys = new Map<string, readonly string[]>([
    ["dispatch", ["by", "dispatchIds"]],
    ["session", ["by", "runtimeSessionId"]],
    ["group", ["by", "attemptGroupId"]],
    ["active", ["by", "instanceId", "cursor", "limit"]],
  ]).get(query.by);
  if (!keys || Object.keys(query).some((key) => !keys.includes(key))) return false;
  if (query.by === "active")
    return (
      Number.isSafeInteger(query.limit) &&
      query.limit > 0 &&
      query.limit <= DISPATCH_LIFECYCLE_PAGE_LIMIT &&
      (query.instanceId === undefined || text(query.instanceId)) &&
      (query.cursor === undefined || text(query.cursor))
    );
  if (query.by === "dispatch")
    return (
      Array.isArray(query.dispatchIds) &&
      query.dispatchIds.length > 0 &&
      query.dispatchIds.length <= DISPATCH_LIFECYCLE_PAGE_LIMIT &&
      query.dispatchIds.every(text)
    );
  return text(query.by === "session" ? query.runtimeSessionId : query.attemptGroupId);
}
