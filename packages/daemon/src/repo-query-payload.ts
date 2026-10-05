import { isDomainStatus, relationStates, timestamp, type TaskProjectionListQuery } from "@harness-anything/kernel";

type CodedError = (code: string, message: string) => Error;

/** The shared query facets of the task-list and relation-graph reads, validated once for every reader. */
export function queryPayloadFacets(
  payload: Readonly<Record<string, unknown>>,
  method: "repo.tasks.list" | "repo.triadic.relationGraph",
  codedError: CodedError,
) {
  const status = typeof payload.status === "string" ? payload.status : undefined,
    changedAfterRevision =
      payload.changedAfterRevision === undefined ? undefined : Number(payload.changedAfterRevision),
    updatedAfter = typeof payload.updatedAfter === "string" ? payload.updatedAfter : undefined,
    updatedBefore = typeof payload.updatedBefore === "string" ? payload.updatedBefore : undefined,
    limit = payload.limit === undefined ? undefined : Number(payload.limit),
    cursor = typeof payload.cursor === "string" ? payload.cursor : undefined;
  if (
    changedAfterRevision !== undefined &&
    (method !== "repo.tasks.list" || !Number.isSafeInteger(changedAfterRevision) || changedAfterRevision < 0)
  )
    throw codedError("invalid_command", "Task changedAfterRevision must be a non-negative integer.");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
    throw codedError("invalid_command", "Query limit must be an integer between 1 and 500.");
  if (
    [updatedAfter, updatedBefore].some((value) => value !== undefined && !timestamp(value)) ||
    (updatedAfter && updatedBefore && updatedAfter > updatedBefore)
  )
    throw codedError("invalid_command", "Query time window must use ordered ISO-8601 timestamps.");
  if (cursor !== undefined && !cursor) throw codedError("invalid_command", "Query cursor is invalid.");
  const stateInvalid =
    status !== undefined &&
    (method === "repo.tasks.list" ? !isDomainStatus(status) : !(relationStates as readonly string[]).includes(status));
  if (stateInvalid) throw codedError("invalid_command", "Query status is invalid for this read.");
  return {
    explicit:
      status !== undefined ||
      changedAfterRevision !== undefined ||
      updatedAfter !== undefined ||
      updatedBefore !== undefined ||
      limit !== undefined ||
      cursor !== undefined,
    status,
    changedAfterRevision,
    updatedAfter,
    updatedBefore,
    limit,
    cursor,
  };
}

// Narrow/paged query payload for the task list read: an empty payload keeps one default-bounded
// page (guiTasks defaults `limit` to 500, the GUI page width); any explicit facet passes through as given.
export function taskListQueryFromPayload(
  payload: Readonly<Record<string, unknown>>,
  codedError: CodedError,
): TaskProjectionListQuery {
  const common = queryPayloadFacets(payload, "repo.tasks.list", codedError);
  return {
    ...(common.status ? { status: common.status as TaskProjectionListQuery["status"] } : {}),
    ...(common.changedAfterRevision === undefined ? {} : { changedAfterRevision: common.changedAfterRevision }),
    ...(common.updatedAfter ? { updatedAfter: common.updatedAfter } : {}),
    ...(common.updatedBefore ? { updatedBefore: common.updatedBefore } : {}),
    ...(common.limit === undefined ? {} : { limit: common.limit }),
    ...(common.cursor ? { cursor: common.cursor } : {}),
  };
}
