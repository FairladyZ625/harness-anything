import {
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  dispatchAdmissionBlocker,
  type DispatchLifecycleQuery,
  type DispatchLifecycleRead,
} from "@harness-anything/kernel";

/**
 * Admission reads the canonical dispatch lifecycle only (dec_AEB05951C69E47FCE53E53C341 CH2):
 * the kernel decides whether an earlier attempt on this instance still blocks this owner. Local
 * process tables, PID probes and stream summaries are observations, never admission predicates.
 */
export async function assertDispatchAdmission(
  read: (query: DispatchLifecycleQuery) => DispatchLifecycleRead | Promise<DispatchLifecycleRead>,
  input: { readonly instanceId: string; readonly owner: string },
  error: (code: string, message: string) => Error,
): Promise<void> {
  let cursor: string | null = null;
  do {
    const page: DispatchLifecycleRead = await read({
      by: "active",
      instanceId: input.instanceId,
      limit: DISPATCH_LIFECYCLE_PAGE_LIMIT,
      ...(cursor === null ? {} : { cursor }),
    });
    if (page.status !== "ready")
      throw error(
        "dispatch_lifecycle_pending",
        `The dispatch lifecycle read model is at revision ${page.watermark} of ${page.sourceRevision}; retry the dispatch.`,
      );
    const blocker = dispatchAdmissionBlocker(page.rows, input);
    if (blocker) throw error(blocker.code, blocker.message);
    cursor = page.nextCursor;
  } while (cursor !== null);
}
