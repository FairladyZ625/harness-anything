import type {
  CanonicalEventStore,
  CanonicalEventV1,
  ReceiptDiagnostic,
  WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import type { EventListQuery, TaskProjectionQueries } from "@harness-anything/kernel";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export const DEFAULT_EVENT_LIST_LIMIT = 50;
export const EVENT_LIST_LIMIT_MAX = 500;

export interface EventQueryCell {
  readonly input: { readonly repoId: string };
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjectionQueries;
  readonly operationId: (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    workspaceId: string,
    expectedRevision: number,
  ) => string;
  readonly readResult: (opId: string, value: object, revision: number, worktreeVisible: boolean | null) => WriteReceipt;
  readonly cellCodedError: (code: string, message: string, diagnostic?: ReceiptDiagnostic) => Error;
  readonly requiredCellText: (value: unknown, name: string) => string;
}

export function eventListQueryFromAction(
  cell: Pick<EventQueryCell, "cellCodedError">,
  action: RepoTaskAction,
): EventListQuery {
  const limit = action.limit === undefined ? DEFAULT_EVENT_LIST_LIMIT : Number(action.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENT_LIST_LIMIT_MAX)
    throw cell.cellCodedError(
      "invalid_command",
      `Event list --limit must be an integer between 1 and ${EVENT_LIST_LIMIT_MAX}.`,
    );
  const cursor = optionalText(action.cursor);
  let revisionBound: number | undefined;
  if (cursor !== undefined) {
    if (!/^[0-9]+$/u.test(cursor))
      throw cell.cellCodedError(
        "invalid_command",
        "Event list --cursor must be a revision boundary returned as nextCursor by an earlier page.",
      );
    revisionBound = Number(cursor);
  }
  for (const [name, value] of [
    ["--after", optionalText(action.after)],
    ["--before", optionalText(action.before)],
  ] as const)
    if (value !== undefined && Number.isNaN(Date.parse(value)))
      throw cell.cellCodedError("invalid_command", `Event list ${name} must be an ISO-8601 timestamp.`);
  const afterText = optionalText(action.after),
    beforeText = optionalText(action.before),
    after = afterText === undefined ? undefined : new Date(afterText).toISOString(),
    before = beforeText === undefined ? undefined : new Date(beforeText).toISOString();
  if (after !== undefined && before !== undefined && after > before)
    throw cell.cellCodedError("invalid_command", "Event list --after must not be later than --before.");
  return {
    ...(optionalText(action.type) !== undefined ? { type: optionalText(action.type) } : {}),
    ...(optionalText(action.entity) !== undefined ? { entity: optionalText(action.entity) } : {}),
    ...(optionalText(action.actor) !== undefined ? { actor: optionalText(action.actor) } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    limit,
    ...(revisionBound !== undefined ? { revisionBound } : {}),
  };
}

export function findLedgerEvent(
  store: Pick<CanonicalEventStore, "readEvent" | "readEventById">,
  id: string,
): CanonicalEventV1 | null {
  const byOpId = store.readEvent(id);
  if (byOpId !== null) return byOpId;
  if (!store.readEventById) throw new Error("canonical event store does not support event-id lookup");
  return store.readEventById(id);
}

export function listEvents(cell: EventQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const query = eventListQueryFromAction(cell, action),
    revision = cell.projection.readCut().sourceRevision,
    page = cell.projection.readEventList(query);
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, revision),
    {
      schema: "event-list/v1",
      rows: page.rows,
      count: page.rows.length,
      hasMore: page.hasMore,
      page: {
        limit: query.limit,
        cursor: optionalText(action.cursor) ?? null,
        nextCursor: page.nextCursor,
      },
      filters: Object.fromEntries(
        Object.entries({
          type: query.type,
          entity: query.entity,
          actor: query.actor,
          after: query.after,
          before: query.before,
        }).filter(([, value]) => value !== undefined),
      ),
    },
    revision,
    null,
  );
}

export function showEvent(cell: EventQueryCell, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const id = cell.requiredCellText(action.opId ?? action.eventId ?? action.id, "opId"),
    event = findLedgerEvent(cell.store, id);
  if (event === null)
    throw cell.cellCodedError("entity_not_found", `No canonical event exists for op id or event id ${id}.`);
  const revision = cell.store.readHead()?.revision ?? 0;
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, revision),
    { schema: "event-show/v1", event },
    revision,
    null,
  );
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
