import { timingSafeEqual } from "node:crypto";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import {
  agentRuntimeTokenUsageRangeWords,
  tokenUsageOutcomeWords,
  type AgentRuntimeTokenUsageOutcome,
  type AgentRuntimeTokenUsageRange,
} from "@harness-anything/kernel/internal/domain/client-view-status.ts";
import {
  isDispatchLifecycleInput,
  type DispatchLifecycleInput,
} from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import { runtimeDispatchPageTimeKey } from "@harness-anything/kernel/internal/domain/runtime-public-query.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import {
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  dispatchLifecycleSummary,
  dispatchLifecycleView,
  reduceDispatchLifecycle,
  sha256Bytes,
  type DispatchLifecycleGroup,
  type DispatchLifecycleView,
  type TaskProjection,
} from "@harness-anything/kernel";

export type { AgentRuntimeTokenUsageOutcome, AgentRuntimeTokenUsageRange };
export const agentRuntimeTokenUsageRanges: readonly AgentRuntimeTokenUsageRange[] = agentRuntimeTokenUsageRangeWords;

export interface AgentRuntimeTokenUsageCounters {
  readonly sessionCount: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
}
export interface AgentRuntimeTokenUsageReporting {
  readonly usageReportedDispatches: number;
  readonly usageUnavailableDispatches: number;
}
export interface AgentRuntimeTokenUsageCost {
  readonly costUsd: number;
  readonly unpricedTokens: number;
}
export interface AgentRuntimeTokenUsageCacheWriteProvenance {
  readonly cacheWriteUnreportedDispatches: number;
  readonly cacheWriteUnitemizedDispatches: number;
}
export type AgentRuntimeTokenUsageTotals = AgentRuntimeTokenUsageCounters &
  AgentRuntimeTokenUsageReporting &
  AgentRuntimeTokenUsageCost &
  AgentRuntimeTokenUsageCacheWriteProvenance;

export interface AgentRuntimeTokenUsageBucket
  extends AgentRuntimeTokenUsageReporting,
    AgentRuntimeTokenUsageCacheWriteProvenance {
  readonly bucketStart: string;
  readonly dispatchCount: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
  readonly costUsd: number;
}

export type AgentRuntimeTokenUsageMember =
  | { readonly kind: "agent"; readonly agentId: string; readonly agentName: string }
  | { readonly kind: "squad"; readonly squadId: string; readonly squadName: string };

export type AgentRuntimeTokenUsageMemberIdentity =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "squad"; readonly squadId: string };

export interface AgentRuntimeTokenUsageSessionRow {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly taskId: string | null;
  readonly model: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly outcome: AgentRuntimeTokenUsageOutcome;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
  readonly usage: "reported" | "unavailable" | "pending";
}

export interface AgentRuntimeTokenUsageDetailPage {
  readonly limit: number;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}

export type AgentRuntimeTokenUsageDetailResult = {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly range: AgentRuntimeTokenUsageRange;
  readonly since: string;
  readonly bucketMs: number;
  readonly member: AgentRuntimeTokenUsageMember;
  readonly totals: AgentRuntimeTokenUsageTotals;
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
  readonly sessions: readonly AgentRuntimeTokenUsageSessionRow[];
  readonly page?: AgentRuntimeTokenUsageDetailPage;
  readonly pricing: { readonly version: string };
  readonly watermark: number;
  readonly sourceRevision: number;
};

export interface TokenUsagePricingContext {
  readonly version: string;
  readonly fingerprint: string;
  readonly costOf: (
    model: string | null,
    metrics: {
      readonly inputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens?: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    } | null,
  ) => { readonly costUsd: number; readonly unpricedTokens: number };
}

export type TokenUsageDetailProjection = Pick<TaskProjection, "readRuntimeDispatchPage" | "readDispatchLifecycle"> &
  Partial<
    Pick<
      TaskProjection,
      | "readRuntimeSessionEventsByType"
      | "readTaskSubmissionOperation"
      | "readTaskOperation"
      | "readTaskCompletion"
      | "readEventList"
      | "readRuntimeDispatchById"
    >
  >;

type DispatchProjectionRow = ReturnType<TaskProjection["readRuntimeDispatchPage"]>["rows"][number];

type MutableBucket = {
  cacheWriteUnreportedDispatches: number;
  cacheWriteUnitemizedDispatches: number;
  bucketStart: string;
  dispatchCount: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCallCount: number;
  usageReportedDispatches: number;
  usageUnavailableDispatches: number;
  costUsd: number;
};

type DetailWindowSnapshot = {
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly memberName: string | null;
  readonly totals: AgentRuntimeTokenUsageTotals;
  readonly buckets: readonly AgentRuntimeTokenUsageBucket[];
};

type DetailCursor = {
  readonly startedAt: string;
  readonly dispatchId: string;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly memberKind: "agent" | "squad";
  readonly memberId: string;
  readonly personId: string | null;
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly pricingVersion: string;
  readonly pricingFingerprint: string;
  readonly snapshot: DetailWindowSnapshot;
};

class TokenUsageDetailError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function coded(code: string, message: string): Error {
  return new TokenUsageDetailError(code, message);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const isoTimestamp = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableNonEmptyString = (value: unknown): value is string | null => value === null || nonEmptyString(value);

const totalsFields = [
  "sessionCount",
  "inputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "totalTokens",
  "toolCallCount",
  "usageReportedDispatches",
  "usageUnavailableDispatches",
  "cacheWriteUnreportedDispatches",
  "cacheWriteUnitemizedDispatches",
  "unpricedTokens",
] as const;

function validTotals(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 13 &&
    totalsFields.every((field) => nonNegativeInteger(value[field])) &&
    nonNegativeNumber(value.costUsd)
  );
}

function validBucket(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 13 &&
    isoTimestamp(value.bucketStart) &&
    nonNegativeInteger(value.dispatchCount) &&
    ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "totalTokens", "toolCallCount"].every(
      (field) => nonNegativeInteger(value[field]),
    ) &&
    [
      "usageReportedDispatches",
      "usageUnavailableDispatches",
      "cacheWriteUnreportedDispatches",
      "cacheWriteUnitemizedDispatches",
    ].every((field) => nonNegativeInteger(value[field])) &&
    nonNegativeNumber(value.costUsd)
  );
}

/** Local calendar days in the window (inclusive of today): today keeps hour buckets, the
 * multi-day ranges one bucket per local day. The ladder stops at `now` — no future zeros. */
export function planTokenUsageWindow(
  now: Date,
  range: AgentRuntimeTokenUsageRange,
): {
  readonly sinceMs: number;
  readonly bucketMs: number;
  readonly previousSinceMs: number;
  readonly previousUntilMs: number;
} {
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30,
    previousUntil = new Date(now);
  previousUntil.setDate(now.getDate() - days);
  return {
    sinceMs: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime(),
    bucketMs: range === "today" ? 3_600_000 : 86_400_000,
    previousSinceMs: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (2 * days - 1)).getTime(),
    previousUntilMs: previousUntil.getTime(),
  };
}

export function buildTokenUsageBucketLadder(sinceMs: number, nowMs: number, bucketMs: number): MutableBucket[] {
  const buckets: MutableBucket[] = [];
  for (let start = sinceMs; start <= nowMs; start += bucketMs)
    buckets.push({
      bucketStart: new Date(start).toISOString(),
      cacheWriteUnreportedDispatches: 0,
      cacheWriteUnitemizedDispatches: 0,
      dispatchCount: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallCount: 0,
      usageReportedDispatches: 0,
      usageUnavailableDispatches: 0,
      costUsd: 0,
    });
  return buckets;
}

export function tokenUsageBucketIndexOf(
  bucketCount: number,
  startedAt: string,
  sinceMs: number,
  bucketMs: number,
): number {
  const at = Date.parse(startedAt),
    index = Number.isFinite(at) ? Math.floor((at - sinceMs) / bucketMs) : -1;
  return index >= 0 && index < bucketCount ? index : -1;
}

function hmacSha256(keyBytes: Buffer, message: string): Buffer {
  const blockSize = storageReadPolicy.defaultValue.pageSizes.sessions,
    normalizedKey = keyBytes.byteLength > blockSize ? Buffer.from(sha256Bytes(keyBytes), "hex") : Buffer.from(keyBytes),
    paddedKey = Buffer.alloc(blockSize);
  normalizedKey.copy(paddedKey);
  const ipad = Buffer.alloc(blockSize),
    opad = Buffer.alloc(blockSize);
  for (let index = 0; index < blockSize; index += 1) {
    const byte = paddedKey[index]!;
    ipad[index] = byte ^ 0x36;
    opad[index] = byte ^ 0x5c;
  }
  const innerDigest = Buffer.from(sha256Bytes(Buffer.concat([ipad, Buffer.from(message, "utf8")])), "hex");
  return Buffer.from(sha256Bytes(Buffer.concat([opad, innerDigest])), "hex");
}

/** Canonical cursor HMAC key derived solely from repository identity and optional cluster secret —
 * independent of local mount path (`rootDir`) and ephemeral TLS listener private keys (F18). */
function detailCursorKey(repoId: string, cursorSecret?: string | Buffer): Buffer {
  const secretBytes =
    cursorSecret === undefined
      ? Buffer.alloc(0)
      : typeof cursorSecret === "string"
        ? Buffer.from(cursorSecret, "utf8")
        : Buffer.from(cursorSecret);
  return Buffer.from(
    sha256Bytes(
      Buffer.concat([
        Buffer.from("ha-token-usage-detail-cursor/v3\0", "utf8"),
        Buffer.from(repoId, "utf8"),
        Buffer.from("\0", "utf8"),
        secretBytes,
      ]),
    ),
    "hex",
  );
}

export function fleetTokenUsageDetailCursorKey(repoId: string, cursorSecret?: string | Buffer): Buffer {
  const secretBytes =
    cursorSecret === undefined
      ? Buffer.alloc(0)
      : typeof cursorSecret === "string"
        ? Buffer.from(cursorSecret, "utf8")
        : Buffer.from(cursorSecret);
  return Buffer.from(
    sha256Bytes(
      Buffer.concat([
        Buffer.from("fleet-token-usage-detail-cursor/v3\0", "utf8"),
        Buffer.from(repoId, "utf8"),
        Buffer.from("\0", "utf8"),
        secretBytes,
      ]),
    ),
    "hex",
  );
}

export function wrapFleetTokenUsageDetailCursor(secretKey: Buffer, repoId: string, innerCursor: string): string {
  const sig = hmacSha256(secretKey, `f3\0${repoId}\0${innerCursor}`).toString("base64url");
  return `f3.${sig}.${innerCursor}`;
}

export function unwrapFleetTokenUsageDetailCursor(
  secretKey: Buffer,
  repoId: string,
  outerCursor: string,
): string | null {
  const maxCursorChars = storageReadPolicy.defaultValue.pageSizes.progress * 2;
  if (!outerCursor || outerCursor.length > maxCursorChars) return null;
  const firstDot = outerCursor.indexOf("."),
    secondDot = firstDot < 0 ? -1 : outerCursor.indexOf(".", firstDot + 1);
  if (firstDot !== 2 || secondDot <= firstDot + 1 || outerCursor.slice(0, 2) !== "f3") return null;
  const sig = outerCursor.slice(firstDot + 1, secondDot),
    innerCursor = outerCursor.slice(secondDot + 1);
  if (!/^[A-Za-z0-9_-]+$/u.test(sig) || !innerCursor) return null;
  const expected = hmacSha256(secretKey, `f3\0${repoId}\0${innerCursor}`),
    actual = Buffer.from(sig, "base64url");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return null;
  return innerCursor;
}

export function finalizeFleetTokenUsageDetailResult(
  secretKey: Buffer,
  repoId: string,
  outerCursor: string | null,
  result: unknown,
): unknown {
  if (!isRecord(result)) return result;
  const maxUnpaginated = storageReadPolicy.defaultValue.pageSizes.standard;
  if (result.page === undefined) {
    const sessions = Array.isArray(result.sessions) ? result.sessions : null;
    if (sessions !== null && sessions.length > maxUnpaginated)
      throw coded(
        "resource_exhausted",
        `Unpaginated Fleet token usage detail exceeds ${maxUnpaginated} sessions; request paged results with limit and cursor.`,
      );
    return result;
  }
  if (!isRecord(result.page)) return result;
  const wrappedNext =
    typeof result.page.nextCursor === "string"
      ? wrapFleetTokenUsageDetailCursor(secretKey, repoId, result.page.nextCursor)
      : null;
  return {
    ...result,
    page: { ...result.page, cursor: outerCursor, nextCursor: wrappedNext },
  };
}

function encodeDetailCursor(cursor: DetailCursor, repoId: string, cursorSecret?: string | Buffer): string {
  const totals = cursor.snapshot.totals,
    totalsTuple = [
      totals.sessionCount,
      totals.inputTokens,
      totals.cacheReadTokens,
      totals.cacheWriteTokens,
      totals.outputTokens,
      totals.totalTokens,
      totals.toolCallCount,
      totals.usageReportedDispatches,
      totals.usageUnavailableDispatches,
      totals.cacheWriteUnreportedDispatches,
      totals.cacheWriteUnitemizedDispatches,
      totals.costUsd,
      totals.unpricedTokens,
    ],
    sparseBuckets = cursor.snapshot.buckets.flatMap((bucket, index) =>
      bucket.dispatchCount === 0 &&
      bucket.usageReportedDispatches === 0 &&
      bucket.usageUnavailableDispatches === 0 &&
      bucket.cacheWriteUnreportedDispatches === 0 &&
      bucket.cacheWriteUnitemizedDispatches === 0
        ? []
        : [
            [
              index,
              bucket.dispatchCount,
              bucket.inputTokens,
              bucket.cacheReadTokens,
              bucket.cacheWriteTokens,
              bucket.outputTokens,
              bucket.totalTokens,
              bucket.toolCallCount,
              bucket.usageReportedDispatches,
              bucket.usageUnavailableDispatches,
              bucket.cacheWriteUnreportedDispatches,
              bucket.cacheWriteUnitemizedDispatches,
              bucket.costUsd,
            ],
          ],
    ),
    raw = [
      cursor.startedAt,
      Buffer.from(cursor.dispatchId, "utf8").toString("base64url"),
      cursor.range,
      cursor.memberKind,
      Buffer.from(cursor.memberId, "utf8").toString("base64url"),
      cursor.personId === null ? "" : Buffer.from(cursor.personId, "utf8").toString("base64url"),
      String(cursor.sinceMs),
      String(cursor.untilMs),
      String(cursor.watermark),
      String(cursor.sourceRevision),
      Buffer.from(cursor.pricingVersion, "utf8").toString("base64url"),
      cursor.pricingFingerprint,
      cursor.snapshot.status,
      cursor.snapshot.memberName === null ? "" : Buffer.from(cursor.snapshot.memberName, "utf8").toString("base64url"),
      totalsTuple.join(","),
      sparseBuckets.map((entry) => entry.join(",")).join(";"),
    ].join("\0"),
    body = Buffer.from(raw, "utf8").toString("base64url"),
    sig = hmacSha256(detailCursorKey(repoId, cursorSecret), `v3.${body}`).toString("base64url");
  return `v3.${sig}.${body}`;
}

function parseCursorNumber(text: string): number {
  return text.length > 0 ? Number(text) : Number.NaN;
}

function decodeDetailCursor(
  value: string,
  options: {
    readonly repoId: string;
    readonly nowMs: number;
    readonly cursorSecret?: string | Buffer;
  },
): DetailCursor | null {
  const maxCursorChars = storageReadPolicy.defaultValue.pageSizes.progress * 2;
  if (!value || value.length > maxCursorChars) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v3") return null;
  const [, sig, body] = parts;
  if (!sig || !body || !/^[A-Za-z0-9_-]+$/u.test(sig) || !/^[A-Za-z0-9_-]+$/u.test(body)) return null;
  const expectedSig = hmacSha256(detailCursorKey(options.repoId, options.cursorSecret), `v3.${body}`),
    actualSig = Buffer.from(sig, "base64url");
  if (
    actualSig.toString("base64url") !== sig ||
    actualSig.byteLength !== expectedSig.byteLength ||
    !timingSafeEqual(actualSig, expectedSig)
  )
    return null;
  const segments = Buffer.from(body, "base64url").toString("utf8").split("\0");
  if (segments.length !== 16) return null;
  const startedAt = segments[0]!,
    dispatchId = segments[1] ? Buffer.from(segments[1], "base64url").toString("utf8") : "",
    range = segments[2]!,
    memberKind = segments[3]!,
    memberId = segments[4] ? Buffer.from(segments[4], "base64url").toString("utf8") : "",
    personId = segments[5] === "" ? null : Buffer.from(segments[5]!, "base64url").toString("utf8"),
    sinceMs = parseCursorNumber(segments[6]!),
    untilMs = parseCursorNumber(segments[7]!),
    watermark = parseCursorNumber(segments[8]!),
    sourceRevision = parseCursorNumber(segments[9]!),
    pricingVersion = segments[10] ? Buffer.from(segments[10], "base64url").toString("utf8") : "",
    pricingFingerprint = segments[11]!,
    status = segments[12]!,
    memberName = segments[13] === "" ? null : Buffer.from(segments[13]!, "base64url").toString("utf8"),
    totalsTuple = segments[14]!.split(",").map(parseCursorNumber),
    sparseBuckets =
      segments[15] === "" ? [] : segments[15]!.split(";").map((entry) => entry.split(",").map(parseCursorNumber));
  if (
    !isoTimestamp(startedAt) ||
    !nonEmptyString(dispatchId) ||
    !agentRuntimeTokenUsageRanges.includes(range as AgentRuntimeTokenUsageRange) ||
    (memberKind !== "agent" && memberKind !== "squad") ||
    !nonEmptyString(memberId) ||
    !nullableNonEmptyString(personId) ||
    !Number.isSafeInteger(sinceMs) ||
    !Number.isSafeInteger(untilMs) ||
    !nonNegativeInteger(watermark) ||
    !nonNegativeInteger(sourceRevision) ||
    !nonEmptyString(pricingVersion) ||
    !/^[a-f0-9]{16}$/u.test(pricingFingerprint) ||
    (status !== "ready" && status !== "pending") ||
    !nullableNonEmptyString(memberName) ||
    totalsTuple.length !== 13
  )
    return null;
  const typedSinceMs = sinceMs as number,
    typedUntilMs = untilMs as number,
    typedRange = range as AgentRuntimeTokenUsageRange,
    clockSkewAllowanceMs = storageReadPolicy.defaultValue.deadlines.query * 2,
    oldestAllowedMs = planTokenUsageWindow(new Date(options.nowMs), "30d").previousSinceMs;
  if (
    typedSinceMs > typedUntilMs ||
    typedUntilMs > options.nowMs + clockSkewAllowanceMs ||
    typedUntilMs < oldestAllowedMs
  )
    return null;
  const expectedWindow = planTokenUsageWindow(new Date(typedUntilMs), typedRange),
    startedAtMs = Date.parse(startedAt);
  if (
    typedSinceMs !== expectedWindow.sinceMs ||
    !Number.isFinite(startedAtMs) ||
    startedAtMs < typedSinceMs ||
    startedAtMs > typedUntilMs
  )
    return null;
  const totals: AgentRuntimeTokenUsageTotals = {
    sessionCount: totalsTuple[0] as number,
    inputTokens: totalsTuple[1] as number,
    cacheReadTokens: totalsTuple[2] as number,
    cacheWriteTokens: totalsTuple[3] as number,
    outputTokens: totalsTuple[4] as number,
    totalTokens: totalsTuple[5] as number,
    toolCallCount: totalsTuple[6] as number,
    usageReportedDispatches: totalsTuple[7] as number,
    usageUnavailableDispatches: totalsTuple[8] as number,
    cacheWriteUnreportedDispatches: totalsTuple[9] as number,
    cacheWriteUnitemizedDispatches: totalsTuple[10] as number,
    costUsd: totalsTuple[11] as number,
    unpricedTokens: totalsTuple[12] as number,
  };
  if (!validTotals(totals)) return null;
  const buckets = buildTokenUsageBucketLadder(typedSinceMs, typedUntilMs, expectedWindow.bucketMs),
    seenBucketIndexes = new Set<number>();
  if (sparseBuckets.length > buckets.length) return null;
  for (const item of sparseBuckets) {
    if (!Array.isArray(item) || item.length !== 13 || !nonNegativeInteger(item[0])) return null;
    const bucketIndex = item[0] as number,
      target = buckets[bucketIndex];
    if (target === undefined || seenBucketIndexes.has(bucketIndex)) return null;
    seenBucketIndexes.add(bucketIndex);
    target.dispatchCount = item[1] as number;
    target.inputTokens = item[2] as number;
    target.cacheReadTokens = item[3] as number;
    target.cacheWriteTokens = item[4] as number;
    target.outputTokens = item[5] as number;
    target.totalTokens = item[6] as number;
    target.toolCallCount = item[7] as number;
    target.usageReportedDispatches = item[8] as number;
    target.usageUnavailableDispatches = item[9] as number;
    target.cacheWriteUnreportedDispatches = item[10] as number;
    target.cacheWriteUnitemizedDispatches = item[11] as number;
    target.costUsd = item[12] as number;
    if (!validBucket(target)) return null;
  }
  return {
    startedAt,
    dispatchId,
    range: typedRange,
    memberKind,
    memberId,
    personId,
    sinceMs: typedSinceMs,
    untilMs: typedUntilMs,
    watermark,
    sourceRevision,
    pricingVersion,
    pricingFingerprint,
    snapshot: {
      status,
      memberName,
      totals,
      buckets,
    },
  };
}

export function isValidTokenUsageDetailCursor(
  value: string,
  options: {
    readonly repoId: string;
    readonly nowMs: number;
    readonly cursorSecret?: string | Buffer;
    readonly pricingVersion?: string;
    readonly pricingFingerprint?: string;
  },
): boolean {
  const decoded = decodeDetailCursor(value, options);
  return (
    decoded !== null &&
    (options.pricingVersion === undefined || decoded.pricingVersion === options.pricingVersion) &&
    (options.pricingFingerprint === undefined || decoded.pricingFingerprint === options.pricingFingerprint)
  );
}

function canonicalUsageOf(
  metrics: DispatchProjectionRow["metrics"],
  settled: boolean,
): AgentRuntimeTokenUsageSessionRow["usage"] {
  if (metrics) return metrics.usageUnavailable === true ? "unavailable" : "reported";
  return settled ? "unavailable" : "pending";
}

function canonicalCacheWriteProvenance(metrics: DispatchProjectionRow["metrics"]): "unreported" | null {
  if (metrics === null || metrics.usageUnavailable === true) return null;
  return metrics.cacheWriteTokens === undefined ? "unreported" : null;
}

/** Reconstruct authoritative dispatch+task lifecycle at `<= pinnedWatermark` in O(1) bounded reads:
 * session events use SQL `maxRevision` + `DESC LIMIT` so post-watermark events and heartbeat floods
 * never increase query work; task delivery (`execution_submitted`/`review_recorded`) and completion
 * events at `<= pinnedWatermark` are folded through the kernel reducer so delivered stopped attempts
 * preserve `displayStatus = "succeeded"` (F11 + F13). */
function reconstructPinnedDispatchOutcome(
  projection: TokenUsageDetailProjection,
  row: DispatchProjectionRow,
  currentView: DispatchLifecycleView | undefined,
  pinnedWatermark: number,
  pinnedSourceRevision: number,
): AgentRuntimeTokenUsageOutcome {
  if (!projection.readRuntimeSessionEventsByType) {
    return row.outcome !== null && tokenUsageOutcomeWords.includes(row.outcome as AgentRuntimeTokenUsageOutcome)
      ? (row.outcome as AgentRuntimeTokenUsageOutcome)
      : "unknown";
  }
  const payload = row.event.payload,
    sessionBound = storageReadPolicy.defaultValue.pageSizes.sessions,
    inputs: DispatchLifecycleInput[] = [];
  if (isDispatchLifecycleInput(row.event)) inputs.push(row.event);

  const coreSessionEvents = projection.readRuntimeSessionEventsByType(
      payload.runtimeSessionId,
      ["runtime_session_started", "runtime_session_exited", "runtime_session_outcome_observed"],
      { maxRevision: pinnedWatermark, order: "desc", limit: sessionBound },
    ),
    latestLiveness = projection.readRuntimeSessionEventsByType(
      payload.runtimeSessionId,
      ["runtime_session_liveness_changed"],
      { maxRevision: pinnedWatermark, order: "desc", limit: storageReadPolicy.defaultValue.pageSizes.one },
    );
  for (const event of [...coreSessionEvents, ...latestLiveness]) {
    if (event.workspaceRevision <= pinnedWatermark && isDispatchLifecycleInput(event)) inputs.push(event);
  }

  if (payload.taskId !== undefined) {
    const role = payload.role === "reviewer" ? "reviewer" : "implementer",
      executionId = payload.executionId ?? null;
    if (role === "implementer" && executionId !== null) {
      const submissionOpId = projection.readTaskSubmissionOperation?.(payload.taskId, executionId) ?? null,
        submissionOp = submissionOpId === null ? null : (projection.readTaskOperation?.(submissionOpId) ?? null);
      if (
        submissionOp !== null &&
        submissionOp.event.workspaceRevision <= pinnedWatermark &&
        isDispatchLifecycleInput(submissionOp.event)
      )
        inputs.push(submissionOp.event);
    } else if (
      role === "reviewer" &&
      executionId !== null &&
      projection.readEventList &&
      projection.readTaskOperation
    ) {
      const reviewRows = projection.readEventList({
        entity: `task/${payload.taskId}`,
        type: "review_recorded",
        revisionBound: pinnedWatermark + 1,
        limit: sessionBound,
      });
      for (const entry of reviewRows.rows) {
        const reviewOp = projection.readTaskOperation(entry.opId);
        if (
          reviewOp !== null &&
          reviewOp.event.workspaceRevision <= pinnedWatermark &&
          isDispatchLifecycleInput(reviewOp.event)
        )
          inputs.push(reviewOp.event);
      }
    }
    const completion =
      projection.readTaskCompletion?.(payload.taskId, executionId) ??
      (executionId === null ? null : (projection.readTaskCompletion?.(payload.taskId, null) ?? null));
    if (completion !== null && completion.workspaceRevision <= pinnedWatermark && isDispatchLifecycleInput(completion))
      inputs.push(completion);
  }

  if (currentView !== undefined && projection.readRuntimeDispatchById) {
    const position = currentView.groupDispatchIds.indexOf(payload.dispatchId),
      nextDispatchId = position >= 0 ? currentView.groupDispatchIds[position + 1] : undefined;
    if (nextDispatchId !== undefined) {
      const nextRow = projection.readRuntimeDispatchById(nextDispatchId);
      if (
        nextRow !== null &&
        nextRow.event.workspaceRevision <= pinnedWatermark &&
        isDispatchLifecycleInput(nextRow.event)
      )
        inputs.push(nextRow.event);
    }
  }

  const byRevision = new Map<number, DispatchLifecycleInput>();
  for (const event of inputs) {
    if (event.workspaceRevision <= pinnedWatermark) byRevision.set(event.workspaceRevision, event);
  }
  const ordered = [...byRevision.values()].sort((left, right) => left.workspaceRevision - right.workspaceRevision);
  let group: DispatchLifecycleGroup | null = null;
  for (const event of ordered) {
    const step = reduceDispatchLifecycle(group, event);
    if (step.kind === "applied") group = step.group;
  }
  const summary = dispatchLifecycleSummary({
    status: "ready",
    watermark: pinnedWatermark,
    sourceRevision: pinnedSourceRevision,
    rows: group === null ? [] : [dispatchLifecycleView(group, payload.dispatchId)],
    nextCursor: null,
  });
  return tokenUsageOutcomeWords.includes(summary.displayStatus as AgentRuntimeTokenUsageOutcome)
    ? (summary.displayStatus as AgentRuntimeTokenUsageOutcome)
    : "unknown";
}

function resolvePinnedPageSessions(
  projection: TokenUsageDetailProjection,
  rows: readonly DispatchProjectionRow[],
  pinnedWatermark: number,
  pinnedSourceRevision: number,
): {
  readonly pending: boolean;
  readonly sessions: readonly AgentRuntimeTokenUsageSessionRow[];
} {
  if (rows.length === 0) return { pending: false, sessions: [] };
  const dispatchIds = rows.map((row) => row.event.payload.dispatchId),
    viewsByDispatch = new Map<string, DispatchLifecycleView>();
  let pending = false;
  for (let offset = 0; offset < dispatchIds.length; offset += DISPATCH_LIFECYCLE_PAGE_LIMIT) {
    const chunk = dispatchIds.slice(offset, offset + DISPATCH_LIFECYCLE_PAGE_LIMIT),
      lifecycleRead = projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: chunk });
    if (lifecycleRead.status === "pending") {
      pending = true;
      continue;
    }
    for (const view of lifecycleRead.rows) viewsByDispatch.set(view.attempt.dispatchId, view);
  }
  const sessions = rows.map((row): AgentRuntimeTokenUsageSessionRow => {
    const payload = row.event.payload,
      startedAt = payload.startedAt ?? row.event.occurredAt,
      metrics = row.metrics,
      settled = row.outcome !== null,
      view = viewsByDispatch.get(payload.dispatchId);
    let outcome: AgentRuntimeTokenUsageOutcome = "unknown";
    if (!pending) {
      if (view !== undefined && view.revision <= pinnedWatermark) {
        const summary = dispatchLifecycleSummary({
          status: "ready",
          watermark: pinnedWatermark,
          sourceRevision: pinnedSourceRevision,
          rows: [view],
          nextCursor: null,
        });
        if (tokenUsageOutcomeWords.includes(summary.displayStatus as AgentRuntimeTokenUsageOutcome))
          outcome = summary.displayStatus as AgentRuntimeTokenUsageOutcome;
      } else {
        outcome = reconstructPinnedDispatchOutcome(projection, row, view, pinnedWatermark, pinnedSourceRevision);
      }
    }
    const startedMs = Date.parse(startedAt),
      endedMs = row.endedAt === null ? Number.NaN : Date.parse(row.endedAt),
      durationMs = Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : null;
    return {
      dispatchId: payload.dispatchId,
      runtimeSessionId: payload.runtimeSessionId,
      taskId: payload.taskId ?? null,
      model: payload.definitionSnapshot.model ?? null,
      startedAt,
      endedAt: row.endedAt,
      durationMs,
      outcome,
      inputTokens: metrics?.inputTokens ?? 0,
      cacheReadTokens: metrics?.cacheReadTokens ?? 0,
      cacheWriteTokens: metrics?.cacheWriteTokens ?? 0,
      outputTokens: metrics?.outputTokens ?? 0,
      totalTokens: metrics?.totalTokens ?? 0,
      toolCallCount: metrics?.toolCallCount ?? 0,
      usage: canonicalUsageOf(metrics, settled),
    };
  });
  return { pending, sessions };
}

function compareDescDispatchKey(
  left: { readonly startedAt: string; readonly dispatchId: string },
  right: { readonly startedAt: string; readonly dispatchId: string },
): number {
  return (
    runtimeDispatchPageTimeKey(right.startedAt) - runtimeDispatchPageTimeKey(left.startedAt) ||
    Buffer.compare(Buffer.from(left.dispatchId), Buffer.from(right.dispatchId))
  );
}

/** Pure cross-projection paginated token-usage detail query (dec_7C93DEBCFB2D1A94C6FA07AAAD/CH1,CH3).
 * Owns window planning, HMAC cursor snapshot pinning, pricing-version consistency, bounded Page-1
 * aggregation, and watermark-pinned authoritative lifecycle folding without any host I/O or streams. */
export function readTokenUsageDetailPage(input: {
  readonly repoId: string;
  readonly now: string;
  readonly range: AgentRuntimeTokenUsageRange;
  readonly member: AgentRuntimeTokenUsageMemberIdentity;
  readonly personId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly cursorSecret?: string | Buffer;
  readonly maxWindowSessions?: number;
  readonly pricing: TokenUsagePricingContext;
  readonly entityLabel: (squadId: string) => string | null;
  readonly projection: TokenUsageDetailProjection;
  readonly cut: {
    readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
}): AgentRuntimeTokenUsageDetailResult {
  const now = new Date(input.now),
    nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error(`Agent runtime token usage now is invalid: ${input.now}.`);
  const maxLimit = storageReadPolicy.defaultValue.pageSizes.standard,
    limit = input.limit ?? maxLimit;
  if (input.limit !== undefined && (!positiveInteger(input.limit) || input.limit > maxLimit))
    throw coded("invalid_command", `Token usage detail limit must be an integer from 1 to ${maxLimit}.`);
  const decodedCursor =
    input.cursor === undefined
      ? null
      : decodeDetailCursor(input.cursor, {
          repoId: input.repoId,
          nowMs,
          ...(input.cursorSecret === undefined ? {} : { cursorSecret: input.cursorSecret }),
        });
  if (input.cursor !== undefined && decodedCursor === null)
    throw coded("invalid_cursor", "Token usage detail cursor is invalid.");
  const member = input.member,
    memberId = member.kind === "agent" ? member.agentId : member.squadId,
    personId = input.personId ?? null;
  if (
    decodedCursor !== null &&
    (decodedCursor.range !== input.range ||
      decodedCursor.memberKind !== member.kind ||
      decodedCursor.memberId !== memberId ||
      decodedCursor.personId !== personId ||
      decodedCursor.watermark > input.cut.watermark ||
      decodedCursor.pricingVersion !== input.pricing.version ||
      decodedCursor.pricingFingerprint !== input.pricing.fingerprint)
  )
    throw coded("invalid_cursor", "Token usage detail cursor does not match the requested window, member, or pricing.");

  const initialWindow = planTokenUsageWindow(now, input.range),
    sinceMs = decodedCursor === null ? initialWindow.sinceMs : decodedCursor.sinceMs,
    untilMs = decodedCursor === null ? nowMs : decodedCursor.untilMs,
    bucketMs = initialWindow.bucketMs,
    pinnedWatermark = decodedCursor === null ? input.cut.watermark : decodedCursor.watermark,
    pinnedSourceRevision = decodedCursor === null ? input.cut.sourceRevision : decodedCursor.sourceRevision,
    startedAtGte = new Date(sinceMs).toISOString(),
    startedAtLte = new Date(untilMs).toISOString(),
    memberQuery = member.kind === "agent" ? { agentId: member.agentId } : { squadId: member.squadId },
    personQuery = personId === null ? {} : { personId },
    matchesMember = (row: DispatchProjectionRow): boolean =>
      member.kind === "agent"
        ? row.event.payload.agentId === member.agentId
        : row.event.payload.squadId === member.squadId,
    formatMember = (memberName: string | null): AgentRuntimeTokenUsageMember =>
      member.kind === "agent"
        ? { kind: "agent", agentId: member.agentId, agentName: memberName ?? member.agentId }
        : {
            kind: "squad",
            squadId: member.squadId,
            squadName: input.entityLabel(member.squadId) ?? member.squadId,
          },
    makeNextCursor = (
      row: AgentRuntimeTokenUsageSessionRow,
      snapshot: DetailWindowSnapshot,
      pricingVersion: string,
      pricingFingerprint: string,
    ): string =>
      encodeDetailCursor(
        {
          startedAt: row.startedAt,
          dispatchId: row.dispatchId,
          range: input.range,
          memberKind: member.kind,
          memberId,
          personId,
          sinceMs,
          untilMs,
          watermark: pinnedWatermark,
          sourceRevision: pinnedSourceRevision,
          pricingVersion,
          pricingFingerprint,
          snapshot,
        },
        input.repoId,
        input.cursorSecret,
      );

  if (decodedCursor !== null) {
    const page = input.projection.readRuntimeDispatchPage({
        ...memberQuery,
        ...personQuery,
        startedAtGte,
        startedAtLte,
        order: "desc",
        maxRevision: pinnedWatermark,
        cursor: { startedAt: decodedCursor.startedAt, dispatchId: decodedCursor.dispatchId },
        limit,
      }),
      matchedRows = page.rows.filter(matchesMember),
      resolved = resolvePinnedPageSessions(input.projection, matchedRows, pinnedWatermark, pinnedSourceRevision),
      pending = decodedCursor.snapshot.status === "pending" || resolved.pending,
      nextCursor =
        !page.done && resolved.sessions.length > 0
          ? makeNextCursor(
              resolved.sessions.at(-1)!,
              decodedCursor.snapshot,
              decodedCursor.pricingVersion,
              decodedCursor.pricingFingerprint,
            )
          : null;
    return {
      ok: true,
      status: pending ? "pending" : "ready",
      range: input.range,
      since: startedAtGte,
      bucketMs,
      member: formatMember(decodedCursor.snapshot.memberName),
      totals: decodedCursor.snapshot.totals,
      buckets: decodedCursor.snapshot.buckets,
      sessions: resolved.sessions,
      page: { limit, cursor: input.cursor ?? null, nextCursor },
      pricing: { version: decodedCursor.pricingVersion },
      watermark: pinnedWatermark,
      sourceRevision: pinnedSourceRevision,
    };
  }

  // Page 1: stream strictly keyset-ordered canonical pages at `revision <= pinnedWatermark`
  // with O(1) cursor progression (no unbounded `seen` set) and bounded distinct-session tracking.
  const buckets = buildTokenUsageBucketLadder(sinceMs, untilMs, bucketMs),
    maxWindowSessions = input.maxWindowSessions ?? storageReadPolicy.defaultValue.pageSizes.progress,
    trackedSessionIds = new Set<string>(),
    firstPageRows: DispatchProjectionRow[] = [],
    counters = {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCallCount: 0,
      costUsd: 0,
      unpricedTokens: 0,
    };
  let usageReportedDispatches = 0,
    usageUnavailableDispatches = 0,
    cacheWriteUnreportedDispatches = 0,
    hasMore = false,
    memberName: string | null = null,
    cursor: { readonly startedAt: string; readonly dispatchId: string } | undefined;

  for (;;) {
    const page = input.projection.readRuntimeDispatchPage({
      ...memberQuery,
      ...personQuery,
      startedAtGte,
      startedAtLte,
      order: "desc",
      maxRevision: pinnedWatermark,
      ...(cursor ? { cursor } : {}),
      limit: maxLimit,
    });
    for (const row of page.rows) {
      const payload = row.event.payload,
        startedAt = payload.startedAt ?? row.event.occurredAt,
        startedMs = Date.parse(startedAt);
      if (
        !Number.isFinite(startedMs) ||
        startedMs < sinceMs ||
        startedMs > untilMs ||
        (personId !== null && row.event.actor.principal.personId !== personId) ||
        !matchesMember(row)
      )
        continue;
      if (!trackedSessionIds.has(payload.runtimeSessionId)) {
        if (trackedSessionIds.size >= maxWindowSessions)
          throw coded(
            "resource_exhausted",
            `Token usage detail window exceeds ${maxWindowSessions} sessions; narrow the requested range.`,
          );
        trackedSessionIds.add(payload.runtimeSessionId);
      }
      if (memberName === null && member.kind === "agent") memberName = payload.agentName ?? member.agentId;
      const metrics = row.metrics,
        model = payload.definitionSnapshot.model ?? null,
        settled = row.outcome !== null,
        usage = canonicalUsageOf(metrics, settled),
        provenance = canonicalCacheWriteProvenance(metrics),
        cost = input.pricing.costOf(model, metrics);
      if (metrics) {
        counters.inputTokens += metrics.inputTokens;
        counters.cacheReadTokens += metrics.cacheReadTokens;
        counters.cacheWriteTokens += metrics.cacheWriteTokens ?? 0;
        counters.outputTokens += metrics.outputTokens;
        counters.totalTokens += metrics.totalTokens;
        counters.toolCallCount += metrics.toolCallCount;
        counters.costUsd += cost.costUsd;
        counters.unpricedTokens += cost.unpricedTokens;
      }
      if (usage === "unavailable") usageUnavailableDispatches += 1;
      else if (usage === "reported") usageReportedDispatches += 1;
      if (provenance === "unreported") cacheWriteUnreportedDispatches += 1;

      const bucket = buckets[tokenUsageBucketIndexOf(buckets.length, startedAt, sinceMs, bucketMs)];
      if (bucket !== undefined) {
        bucket.dispatchCount += 1;
        if (metrics) {
          bucket.inputTokens += metrics.inputTokens;
          bucket.cacheReadTokens += metrics.cacheReadTokens;
          bucket.cacheWriteTokens += metrics.cacheWriteTokens ?? 0;
          bucket.outputTokens += metrics.outputTokens;
          bucket.totalTokens += metrics.totalTokens;
          bucket.toolCallCount += metrics.toolCallCount;
          bucket.costUsd += cost.costUsd;
        }
        if (provenance === "unreported") bucket.cacheWriteUnreportedDispatches += 1;
        if (usage === "unavailable") bucket.usageUnavailableDispatches += 1;
        else if (usage === "reported") bucket.usageReportedDispatches += 1;
      }
      if (firstPageRows.length < limit) firstPageRows.push(row);
      else hasMore = true;
    }
    if (page.done) break;
    if (!page.nextCursor || (cursor !== undefined && compareDescDispatchKey(page.nextCursor, cursor) <= 0))
      throw new Error("runtime dispatch page cursor did not advance");
    cursor = page.nextCursor;
  }

  const resolved = resolvePinnedPageSessions(input.projection, firstPageRows, pinnedWatermark, pinnedSourceRevision),
    pending = input.cut.status === "pending" || resolved.pending,
    frozenTotals: AgentRuntimeTokenUsageTotals = {
      sessionCount: trackedSessionIds.size,
      ...counters,
      usageReportedDispatches,
      usageUnavailableDispatches,
      cacheWriteUnreportedDispatches,
      cacheWriteUnitemizedDispatches: 0,
    },
    snapshotStatus: ProjectionStatus.ReadSetProjectionCut["status"] = pending ? "pending" : "ready",
    snapshot: DetailWindowSnapshot = {
      status: snapshotStatus,
      memberName,
      totals: frozenTotals,
      buckets,
    },
    nextCursor =
      hasMore && resolved.sessions.length > 0
        ? makeNextCursor(resolved.sessions.at(-1)!, snapshot, input.pricing.version, input.pricing.fingerprint)
        : null;
  return {
    ok: true,
    status: snapshotStatus,
    range: input.range,
    since: startedAtGte,
    bucketMs,
    member: formatMember(memberName),
    totals: frozenTotals,
    buckets,
    sessions: resolved.sessions,
    page: { limit, cursor: input.cursor ?? null, nextCursor },
    pricing: { version: input.pricing.version },
    watermark: pinnedWatermark,
    sourceRevision: pinnedSourceRevision,
  };
}
