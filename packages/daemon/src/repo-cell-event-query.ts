import type {
  CanonicalEventStore,
  CanonicalEventV1,
  ReceiptDiagnostic,
  WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import type { EventListQuery, TaskProjectionQueries } from "@harness-anything/kernel";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export const DEFAULT_EVENT_LIST_LIMIT = storageReadPolicy.defaultValue.listDefaults.eventLimit;
export const EVENT_LIST_LIMIT_MAX = storageReadPolicy.defaultValue.pageSizes.standard;

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
  if (
    !Number.isSafeInteger(limit) ||
    limit < storageReadPolicy.defaultValue.minimumRows ||
    limit > EVENT_LIST_LIMIT_MAX
  )
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

type EventSliceFilter = {
  readonly eventType?: CanonicalEventV1["type"];
  readonly entity?: string;
  readonly actor?: string;
};

function forEachQueryEventPage(
  store: Pick<CanonicalEventStore, "queryEvents">,
  filter: EventSliceFilter,
  pageSize: number,
  onPage: (page: readonly CanonicalEventV1[]) => boolean | void,
): void {
  const queryEvents = store.queryEvents;
  if (!queryEvents) {
    throw new Error("CanonicalEventStore.queryEvents is required for bounded event queries.");
  }
  let revisionBound: number | undefined;
  for (;;) {
    const page = queryEvents({
      ...(filter.eventType === undefined ? {} : { type: filter.eventType }),
      ...(filter.entity === undefined ? {} : { entity: filter.entity }),
      ...(filter.actor === undefined ? {} : { actor: filter.actor }),
      ...(revisionBound === undefined ? {} : { revisionBound }),
      limit: pageSize,
    });
    if (onPage(page) === false || page.length < pageSize) return;
    const nextBound = page[page.length - 1]!.workspaceRevision;
    if (revisionBound !== undefined && nextBound >= revisionBound) return;
    revisionBound = nextBound;
  }
}

/**
 * Scan indexed `queryEvents` pages backwards until `predicate` matches or history ends.
 */
export function someQueryEvent(
  store: Pick<CanonicalEventStore, "queryEvents">,
  filter: EventSliceFilter,
  predicate: (event: CanonicalEventV1) => boolean,
  pageSize = EVENT_LIST_LIMIT_MAX,
): boolean {
  let matched = false;
  forEachQueryEventPage(store, filter, pageSize, (page) => {
    if (page.some(predicate)) {
      matched = true;
      return false;
    }
  });
  return matched;
}

/**
 * Collect matching events across bounded `queryEvents` pages in ascending `workspaceRevision` order.
 */
export function collectQueryEvents(
  store: Pick<CanonicalEventStore, "queryEvents">,
  filters: readonly EventSliceFilter[],
  pageSize = EVENT_LIST_LIMIT_MAX,
): CanonicalEventV1[] {
  const collected: CanonicalEventV1[] = [];
  for (const filter of filters) {
    forEachQueryEventPage(store, filter, pageSize, (page) => {
      collected.push(...page);
    });
  }
  return collected.sort((left, right) => left.workspaceRevision - right.workspaceRevision);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
