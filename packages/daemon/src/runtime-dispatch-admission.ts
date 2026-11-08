import {
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  dispatchAdmissionBlocker,
  dispatchAdmissionRefusal,
  type DispatchLifecycleQuery,
  type DispatchLifecycleRead,
  type DispatchLifecycleView,
} from "@harness-anything/kernel";

type CodedError = (code: string, message: string) => Error;

function pendingError(page: Extract<DispatchLifecycleRead, { status: "pending" }>, error: CodedError): Error {
  return error(
    "dispatch_lifecycle_pending",
    `The dispatch lifecycle read model is at revision ${page.watermark} of ${page.sourceRevision}; retry the dispatch.`,
  );
}

/**
 * Admission reads the canonical dispatch lifecycle only (dec_AEB05951C69E47FCE53E53C341 CH2):
 * the kernel decides whether an earlier attempt on this instance still blocks this owner. Local
 * process tables, PID probes and stream summaries are observations, never admission predicates.
 * A read that is not ready (pending, or a stale edge replica) fails closed.
 */
export async function assertDispatchAdmission(
  read: (query: DispatchLifecycleQuery) => DispatchLifecycleRead | Promise<DispatchLifecycleRead>,
  input: { readonly instanceId: string; readonly owner: string },
  error: CodedError,
): Promise<void> {
  let cursor: string | null = null;
  do {
    const page: DispatchLifecycleRead = await read(activePage(input.instanceId, cursor));
    if (page.status !== "ready") throw pendingError(page, error);
    const blocker = dispatchAdmissionBlocker(page.rows, input);
    if (blocker) throw error(blocker.code, blocker.message);
    cursor = page.nextCursor;
  } while (cursor !== null);
}

/**
 * The center writer's admission check for one `runtime_dispatch_requested`. It runs inside the
 * single writer before the append, so of two concurrent admissions into one group (or onto an
 * instance an unresolved attempt blocks) only the first is accepted; the other caller receives the
 * kernel's refusal code instead of an applied receipt.
 */
export function requireDispatchLifecycleAdmission(
  read: (query: DispatchLifecycleQuery) => DispatchLifecycleRead,
  input: { readonly attemptGroupId: string; readonly instanceId: string; readonly owner: string },
  error: CodedError,
): void {
  const groupRead = read({ by: "group", attemptGroupId: input.attemptGroupId });
  if (groupRead.status !== "ready") throw pendingError(groupRead, error);
  const instance: DispatchLifecycleView[] = [];
  let cursor: string | null = null;
  do {
    const page = read(activePage(input.instanceId, cursor));
    if (page.status !== "ready") throw pendingError(page, error);
    instance.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor !== null);
  const refusal = dispatchAdmissionRefusal({
    group: groupRead.rows[0] ?? null,
    instance,
    instanceId: input.instanceId,
    owner: input.owner,
  });
  if (refusal) throw error(refusal.code, refusal.message);
}

function activePage(instanceId: string, cursor: string | null): DispatchLifecycleQuery {
  return { by: "active", instanceId, limit: DISPATCH_LIFECYCLE_PAGE_LIMIT, ...(cursor === null ? {} : { cursor }) };
}
