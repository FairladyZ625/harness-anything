import type {
  CanonicalEventStore,
  CanonicalEventV1,
  ReceiptDiagnostic,
  WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { canonicalEventEntityRefs } from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export const DEFAULT_EVENT_LIST_LIMIT = 50;
export const EVENT_LIST_LIMIT_MAX = 500;

export interface EventQueryCell {
  readonly input: { readonly repoId: string };
  readonly store: CanonicalEventStore;
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

export interface EventListQuery {
  readonly type?: string;
  readonly entity?: string;
  readonly actor?: string;
  readonly after?: string;
  readonly before?: string;
  readonly limit: number;
  /** Exclusive upper revision bound decoded from --cursor; absent means "newest page". */
  readonly revisionBound?: number;
}

export interface EventListRow {
  readonly revision: number;
  readonly opId: string;
  readonly eventId: string;
  readonly schema: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly actor: { readonly personId: string; readonly executorId: string | null };
  readonly entityRefs: readonly string[];
}

export interface EventListPage {
  readonly rows: readonly EventListRow[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
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

export const eventEntityRefs = canonicalEventEntityRefs;

export function eventMatches(event: CanonicalEventV1, query: EventListQuery): boolean {
  if (query.type !== undefined && event.type !== query.type) return false;
  if (query.after !== undefined && event.occurredAt < query.after) return false;
  if (query.before !== undefined && event.occurredAt > query.before) return false;
  if (query.actor !== undefined) {
    const actor = event.actor;
    if (actor.executor?.id !== query.actor && actor.principal.personId !== query.actor) return false;
  }
  if (query.entity !== undefined) {
    const refs = eventEntityRefs(event);
    if (!refs.includes(query.entity) && !refs.some((ref) => ref.split("/").at(-1) === query.entity)) return false;
  }
  return true;
}

/**
 * Pushes filtering into the canonical store and asks for one look-ahead match to prove another page exists.
 */
export function selectLedgerEvents(
  store: Pick<CanonicalEventStore, "queryEvents">,
  query: EventListQuery,
): EventListPage {
  if (!store.queryEvents) throw new Error("canonical event store does not support indexed event queries");
  const selected = store.queryEvents({ ...query, limit: query.limit + 1 });
  const rows = selected.slice(0, query.limit).map((event) => ({
    revision: event.workspaceRevision,
    opId: event.opId,
    eventId: event.eventId,
    schema: event.schema,
    type: event.type,
    occurredAt: event.occurredAt,
    actor: { personId: event.actor.principal.personId, executorId: event.actor.executor?.id ?? null },
    entityRefs: eventEntityRefs(event),
  }));
  return {
    rows,
    hasMore: selected.length > query.limit,
    nextCursor: selected.length > query.limit && rows.length ? String(rows.at(-1)!.revision) : null,
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
    revision = cell.store.readHead()?.revision ?? 0,
    page = selectLedgerEvents(cell.store, query);
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
