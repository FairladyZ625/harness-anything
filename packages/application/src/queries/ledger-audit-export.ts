import {
  auditGenesisChainHash,
  createAuditChainAccumulator,
  DEFAULT_AUDIT_ENTRIES_FILE,
  EVENT_LIST_LIMIT_MAX,
  isAuditDigest,
  isAuditHashAlgorithm,
  type AuditDigest,
  type AuditExportEntryV1,
  type AuditExportManifestV1,
  type AuditExportWindowV1,
  type AuditHashAlgorithm,
  type CanonicalEventStore,
  type PersistedCanonicalEventV1,
  type ReceiptDiagnostic,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { QueryAction, QueryBinding } from "./query-ports.ts";

export const AUDIT_EXPORT_PAGE_SCHEMA = "audit-export-page/v1" as const;

export interface AuditExportPageCell {
  readonly input: { readonly repoId: string };
  readonly store: CanonicalEventStore;
  readonly operationId: (
    action: QueryAction,
    binding: QueryBinding,
    workspaceId: string,
    expectedRevision: number,
  ) => string;
  readonly readResult: (opId: string, value: object, revision: number, worktreeVisible: boolean | null) => WriteReceipt;
  readonly cellCodedError: (code: string, message: string, diagnostic?: ReceiptDiagnostic) => Error;
}

export interface ParsedAuditExportQuery {
  readonly algorithm: AuditHashAlgorithm;
  readonly limit: number;
  readonly cursor: string | null;
  readonly startAfterRevision: number;
  readonly prevRootHash: AuditDigest;
  readonly window: AuditExportWindowV1;
  readonly afterMs: number | null;
  readonly beforeMs: number | null;
}

export function parseAuditExportQuery(
  cell: Pick<AuditExportPageCell, "cellCodedError">,
  action: QueryAction,
): ParsedAuditExportQuery {
  const rawAlgorithm = optionalText(action.algorithm) ?? "sha256";
  if (!isAuditHashAlgorithm(rawAlgorithm)) {
    throw cell.cellCodedError("audit_algorithm_unsupported", "Audit export --algorithm must be sha256 or sm3.");
  }
  const algorithm = rawAlgorithm;
  const limit = action.limit === undefined ? EVENT_LIST_LIMIT_MAX : Number(action.limit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < storageReadPolicy.defaultValue.minimumRows ||
    limit > EVENT_LIST_LIMIT_MAX
  ) {
    throw cell.cellCodedError(
      "invalid_command",
      `Audit export --limit must be an integer between 1 and ${EVENT_LIST_LIMIT_MAX}.`,
    );
  }
  const fromRevision = parseOptionalPositiveRevision(cell, action.fromRevision, "--from-revision");
  const toRevision = parseOptionalPositiveRevision(cell, action.toRevision, "--to-revision");
  if (fromRevision !== null && toRevision !== null && fromRevision > toRevision) {
    throw cell.cellCodedError("invalid_command", "Audit export --from-revision must not exceed --to-revision.");
  }
  const cursorText = optionalText(action.cursor);
  let cursorRevision: number | null = null;
  if (cursorText !== undefined) {
    if (!/^[0-9]+$/u.test(cursorText)) {
      throw cell.cellCodedError("invalid_command", "Audit export --cursor must be a non-negative revision number.");
    }
    cursorRevision = Number(cursorText);
  }
  const utcDate = optionalText(action.date) ?? null;
  const rawAfter = optionalText(action.after) ?? null;
  const rawBefore = optionalText(action.before) ?? null;
  if (utcDate !== null && (rawAfter !== null || rawBefore !== null)) {
    throw cell.cellCodedError("invalid_command", "Audit export --date cannot be combined with --after or --before.");
  }
  let after: string | null = null;
  let before: string | null = null;
  if (utcDate !== null) {
    const parsedDate = parseUtcDate(utcDate);
    if (parsedDate === null) {
      throw cell.cellCodedError("invalid_command", "Audit export --date must be a valid UTC date YYYY-MM-DD.");
    }
    after = `${parsedDate}T00:00:00.000Z`;
    before = `${parsedDate}T23:59:59.999Z`;
  } else {
    if (rawAfter !== null) {
      if (Number.isNaN(Date.parse(rawAfter))) {
        throw cell.cellCodedError("invalid_command", "Audit export --after must be an ISO-8601 timestamp.");
      }
      after = new Date(rawAfter).toISOString();
    }
    if (rawBefore !== null) {
      if (Number.isNaN(Date.parse(rawBefore))) {
        throw cell.cellCodedError("invalid_command", "Audit export --before must be an ISO-8601 timestamp.");
      }
      before = new Date(rawBefore).toISOString();
    }
    if (after !== null && before !== null && Date.parse(after) > Date.parse(before)) {
      throw cell.cellCodedError("invalid_command", "Audit export --after must not be later than --before.");
    }
  }
  const rawPrevRootHash = optionalText(action.prevRootHash);
  const prevRootHash = rawPrevRootHash ?? auditGenesisChainHash(algorithm);
  if (!isAuditDigest(prevRootHash, algorithm)) {
    throw cell.cellCodedError(
      "invalid_command",
      `Audit export --prev-root-hash must be a valid ${algorithm}:<64-hex> digest.`,
    );
  }
  const startAfterRevision = cursorRevision !== null ? cursorRevision : fromRevision !== null ? fromRevision - 1 : 0;

  return {
    algorithm,
    limit,
    cursor: cursorText ?? null,
    startAfterRevision,
    prevRootHash,
    window: {
      fromRevision,
      toRevision,
      utcDate,
      after,
      before,
    },
    afterMs: after === null ? null : Date.parse(after),
    beforeMs: before === null ? null : Date.parse(before),
  };
}

export function readAuditExportPage(
  cell: AuditExportPageCell,
  action: QueryAction,
  binding: QueryBinding,
): WriteReceipt {
  const query = parseAuditExportQuery(cell, action);
  const batch = cell.store.readBatch(String(query.startAfterRevision), query.limit);
  const sourceRevision = batch.sourceRevision;
  const effectiveToRevision =
    query.window.toRevision === null ? sourceRevision : Math.min(query.window.toRevision, sourceRevision);
  const inRange = batch.events.filter((event) => event.workspaceRevision <= effectiveToRevision);
  const matched = inRange.filter((event) => eventMatchesTimeWindow(event, query.afterMs, query.beforeMs));
  const lastScanned = inRange.at(-1)?.workspaceRevision ?? query.startAfterRevision;
  const exhausted =
    batch.done ||
    batch.events.length < query.limit ||
    lastScanned >= effectiveToRevision ||
    (batch.events.at(-1)?.workspaceRevision ?? 0) >= effectiveToRevision;
  const nextCursor = exhausted ? null : String(lastScanned);
  const hasMore = nextCursor !== null;

  let singlePageSlice:
    | { readonly entries: readonly AuditExportEntryV1[]; readonly manifest: AuditExportManifestV1 }
    | undefined;
  if (!hasMore && query.cursor === null) {
    const accumulator = createAuditChainAccumulator({
      repoId: cell.input.repoId,
      algorithm: query.algorithm,
      prevRootHash: query.prevRootHash,
      window: {
        ...query.window,
        toRevision: query.window.toRevision ?? effectiveToRevision,
      },
      entriesFile: DEFAULT_AUDIT_ENTRIES_FILE,
    });
    const entries: AuditExportEntryV1[] = [];
    for (const event of matched) {
      entries.push(accumulator.addEvent(event).entry);
    }
    singlePageSlice = { entries, manifest: accumulator.finalize() };
  }

  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, sourceRevision),
    {
      schema: AUDIT_EXPORT_PAGE_SCHEMA,
      repoId: cell.input.repoId,
      sourceRevision,
      effectiveToRevision,
      algorithm: query.algorithm,
      prevRootHash: query.prevRootHash,
      window: query.window,
      events: matched,
      count: matched.length,
      scannedCount: inRange.length,
      hasMore,
      page: {
        limit: query.limit,
        cursor: query.cursor,
        nextCursor,
      },
      ...(singlePageSlice === undefined ? {} : singlePageSlice),
    },
    sourceRevision,
    null,
  );
}

function eventMatchesTimeWindow(
  event: PersistedCanonicalEventV1,
  afterMs: number | null,
  beforeMs: number | null,
): boolean {
  if (afterMs === null && beforeMs === null) return true;
  const occurredMs = Date.parse(event.occurredAt);
  if (Number.isNaN(occurredMs)) return false;
  if (afterMs !== null && occurredMs < afterMs) return false;
  if (beforeMs !== null && occurredMs > beforeMs) return false;
  return true;
}

function parseOptionalPositiveRevision(
  cell: Pick<AuditExportPageCell, "cellCodedError">,
  value: unknown,
  flagName: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw cell.cellCodedError("invalid_command", `Audit export ${flagName} must be a positive integer.`);
  }
  return numeric;
}

function parseUtcDate(value: string): string | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
