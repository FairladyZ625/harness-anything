import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { fleetBaseBackupTrace } from "@harness-anything/storage";
import type { JsonRpcRequest } from "./protocol/json-rpc-types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

/** One closed request stage, measured on the process monotonic clock (milliseconds). */
export interface DaemonOperationPhaseSpan {
  readonly name: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}
/** A stage boundary emitted while the request is still in flight; `endedAtMs` closes an explicit window. */
export interface DaemonOperationPhaseMark {
  readonly name: string;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
}
export interface DaemonOperation {
  readonly id: string;
  readonly method: string;
  readonly repoId: string | null;
  readonly actor: string | null;
  readonly startedAt: string;
  readonly phase: string;
  /** OpenTelemetry-compatible 16-byte hex trace id; generated once per request, never from payload. */
  readonly traceId: string;
  /** OpenTelemetry-compatible 8-byte hex span id. */
  readonly spanId: string;
  /** Source fleet node, established by transport admission; null for local CLI/GUI calls. */
  readonly nodeId: string | null;
  readonly requestBytes: number;
  readonly replyBytes: number;
  readonly outcome: "ok" | "error" | null;
}
export type DaemonOperationUpdate = Partial<
  Pick<DaemonOperation, "phase" | "actor" | "repoId" | "nodeId" | "requestBytes" | "replyBytes" | "outcome">
> & {
  readonly phaseMark?: DaemonOperationPhaseMark;
  readonly endedAtMs?: number;
};
export type DaemonOperationBeginFields = Pick<DaemonOperation, "method" | "traceId" | "spanId"> &
  DaemonOperationUpdate & {
    readonly startedAt: string;
    readonly startedAtMs: number;
    readonly phases?: readonly DaemonOperationPhaseSpan[];
  };
/** The closed/observed part of one request. Written to the conn log and the diagnostics worker. */
export interface DaemonOperationTrace {
  readonly method: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly nodeId: string | null;
  readonly requestBytes: number;
  readonly replyBytes: number;
  readonly outcome: "ok" | "error" | null;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly phases: readonly DaemonOperationPhaseSpan[];
}
export interface DaemonOperationObserver {
  readonly begin: (fields: DaemonOperationBeginFields) => {
    readonly update: (fields: DaemonOperationUpdate) => void;
    readonly end: (trace?: DaemonOperationTrace) => void;
  };
}
/** A stable handle to one operation; safe to call from a callback that runs outside its ALS context. */
export interface DaemonOperationHandle {
  readonly traceId: string;
  readonly spanId: string;
  readonly markPhase: (name: string) => void;
  readonly markPhaseAt: (name: string, atMs: number) => void;
  readonly phaseSpan: (name: string, startedAtMs: number, endedAtMs: number) => void;
  readonly update: (fields: DaemonOperationUpdate) => void;
  readonly trace: () => DaemonOperationTrace;
}
interface OperationTracker extends DaemonOperationHandle {
  readonly end: () => void;
}
interface MutablePhase {
  readonly name: string;
  readonly startedAtMs: number;
  endedAtMs?: number;
}
const current = new AsyncLocalStorage<{
  readonly observer: DaemonOperationObserver;
  readonly operation?: OperationTracker;
}>();
const backups = new WeakMap<object, ReturnType<DaemonOperationObserver["begin"]>>();
const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
fleetBaseBackupTrace.start.subscribe((message) => {
  const span = message as { repoId: string | null },
    observer = current.getStore()?.observer;
  if (observer)
    backups.set(
      span,
      observer.begin({
        method: "fleet.basebackup",
        repoId: span.repoId,
        actor: "daemon",
        phase: "snapshot",
        traceId: newTraceId(),
        spanId: newSpanId(),
        startedAt: new Date().toISOString(),
        startedAtMs: monotonicMs(),
      }),
    );
});
fleetBaseBackupTrace.asyncStart.subscribe((message) => {
  const span = message as { repoId: string | null };
  backups.get(span)?.update({ repoId: span.repoId, phase: "archive" });
});
fleetBaseBackupTrace.end.subscribe((message) => {
  const span = message as object;
  backups.get(span)?.end();
  backups.delete(span);
});

/** Bind at the daemon composition root. Async resources inherit the observer, never a global daemon. */
export function withDaemonObservation<T>(observer: DaemonOperationObserver, body: () => T): T {
  return current.run({ observer }, body);
}

/** A scope the caller ends explicitly, for a delivery that outlives the handler (for example Fleet send). */
export interface DaemonOperationScope {
  readonly handle: DaemonOperationHandle;
  readonly run: <T>(body: () => T) => T;
  readonly end: () => void;
}

/** Begin an operation without auto-ending it; the caller must call `end` on every path. */
export function beginDaemonOperation(
  fields: Pick<DaemonOperation, "method"> & DaemonOperationUpdate,
): DaemonOperationScope | null {
  const context = current.getStore();
  if (!context) return null;
  const operation = startOperation(context.observer, fields);
  return {
    handle: operation,
    run: (body) => current.run({ observer: context.observer, operation }, body),
    end: operation.end,
  };
}

/** O(1) incremental registration; synchronous bodies remain synchronous. Always removes on settlement. */
export function observeDaemonOperation<T>(
  fields: Pick<DaemonOperation, "method"> & DaemonOperationUpdate,
  body: () => T,
): T {
  const context = current.getStore();
  if (!context) return body();
  const operation = startOperation(context.observer, fields);
  return current.run({ observer: context.observer, operation }, () => settleOperation(operation, body));
}

function settleOperation<T>(operation: OperationTracker, body: () => T): T {
  try {
    const result = body();
    if (result instanceof Promise) return result.finally(operation.end) as T;
    operation.end();
    return result;
  } catch (error) {
    operation.end();
    throw error;
  }
}

/** Single phase port for request tracing (including synchronous reads); no payloads or credentials. */
export function markDaemonOperationPhase(phase: string): void {
  current.getStore()?.operation?.markPhase(phase);
}

/** Close the previous stage and open `phase` at a monotonic timestamp measured by the caller. */
export function markDaemonOperationPhaseAt(phase: string, atMs: number): void {
  current.getStore()?.operation?.markPhaseAt(phase, atMs);
}

/** Record a completed stage window measured outside the main dispatch (for example the writer worker). */
export function recordDaemonOperationPhaseSpan(phase: string, startedAtMs: number, endedAtMs: number): void {
  current.getStore()?.operation?.phaseSpan(phase, startedAtMs, endedAtMs);
}

/** Bind the current operation's phase port so a later transport callback can mark without ALS. */
export function bindDaemonOperationPhase(): (phase: string) => void {
  if (!current.getStore()?.operation) return () => undefined;
  const snapshot = AsyncLocalStorage.snapshot();
  return (phase: string) => snapshot(() => markDaemonOperationPhase(phase));
}

/** Capture the current operation so a later callback can mark phases without re-entering ALS. */
export function captureDaemonOperation(): DaemonOperationHandle | null {
  const operation = current.getStore()?.operation;
  return operation ?? null;
}

/** The current request's OpenTelemetry-compatible trace snapshot, if a request is being observed. */
export function currentDaemonOperationTrace(): DaemonOperationTrace | null {
  return current.getStore()?.operation?.trace() ?? null;
}

export function updateDaemonOperation(fields: DaemonOperationUpdate): void {
  current.getStore()?.operation?.update(fields);
}

export function observeDaemonRequest<T>(
  request: JsonRpcRequest,
  auth: DaemonAuthenticationContext,
  body: () => T,
  observer?: DaemonOperationObserver,
): T {
  const params = request.params as Record<string, unknown> | undefined,
    repo = params?.repo as { repoId?: unknown } | undefined;
  const fields = {
      method: String(request.method),
      phase: "authentication",
      repoId:
        typeof repo?.repoId === "string" ? repo.repoId : typeof params?.repoId === "string" ? params.repoId : null,
      actor:
        auth.executionPrincipal?.personId ??
        auth.oidcPrincipal?.personId ??
        auth.nodePrincipal?.personId ??
        (auth.unixSocketOwnerBoundary ? `local-user-${auth.unixSocketOwnerBoundary.ownerUid}` : null),
      nodeId: auth.nodePrincipal?.nodeId ?? null,
    },
    context = current.getStore(),
    activeObserver = observer ?? context?.observer;
  if (!activeObserver) return body();
  const operation = startOperation(activeObserver, fields);
  return current.run({ observer: activeObserver, operation }, () => settleOperation(operation, body));
}

function startOperation(
  observer: DaemonOperationObserver,
  fields: Pick<DaemonOperation, "method"> & DaemonOperationUpdate,
): OperationTracker {
  return new OperationTrackerImpl(observer, fields);
}

class OperationTrackerImpl implements OperationTracker {
  readonly traceId = newTraceId();
  readonly spanId = newSpanId();
  private readonly startedAtMs = monotonicMs();
  private readonly phases: MutablePhase[];
  private readonly raw: ReturnType<DaemonOperationObserver["begin"]>;
  private nodeId: string | null;
  private requestBytes: number;
  private replyBytes: number;
  private outcome: "ok" | "error" | null;
  private endedAtMs: number | null = null;
  private ended = false;
  private readonly fields: Pick<DaemonOperation, "method"> & DaemonOperationUpdate;

  constructor(observer: DaemonOperationObserver, fields: Pick<DaemonOperation, "method"> & DaemonOperationUpdate) {
    this.fields = fields;
    const initialPhase = fields.phase ?? "started";
    this.phases = [{ name: initialPhase, startedAtMs: this.startedAtMs }];
    this.nodeId = fields.nodeId ?? null;
    this.requestBytes = fields.requestBytes ?? 0;
    this.replyBytes = fields.replyBytes ?? 0;
    this.outcome = fields.outcome ?? null;
    this.raw = observer.begin({
      ...fields,
      phase: initialPhase,
      traceId: this.traceId,
      spanId: this.spanId,
      startedAt: new Date().toISOString(),
      startedAtMs: this.startedAtMs,
    });
  }

  markPhase(name: string): void {
    this.openPhase(name, monotonicMs());
  }
  markPhaseAt(name: string, atMs: number): void {
    this.openPhase(name, atMs);
  }
  phaseSpan(name: string, startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const start = Math.max(0, Math.min(startMs, endMs)),
      end = Math.max(start, endMs);
    this.closeOpen(start);
    this.phases.push({ name, startedAtMs: start, endedAtMs: end });
    this.raw.update({ phase: name, phaseMark: { name, startedAtMs: start, endedAtMs: end } });
  }
  update(update: DaemonOperationUpdate): void {
    if (update.nodeId !== undefined) this.nodeId = update.nodeId;
    if (update.requestBytes !== undefined) this.requestBytes = Math.max(0, update.requestBytes);
    if (update.replyBytes !== undefined) this.replyBytes = Math.max(0, update.replyBytes);
    if (update.outcome !== undefined) this.outcome = update.outcome;
    if (update.phaseMark) {
      if (update.phaseMark.endedAtMs === undefined) this.openPhase(update.phaseMark.name, update.phaseMark.startedAtMs);
      else this.phaseSpan(update.phaseMark.name, update.phaseMark.startedAtMs, update.phaseMark.endedAtMs);
      return;
    }
    if (update.phase !== undefined) this.openPhase(update.phase, monotonicMs());
    else this.raw.update(update);
  }
  trace = (): DaemonOperationTrace => this.snapshot();
  end = (): void => {
    if (this.ended) return;
    this.ended = true;
    this.endedAtMs = monotonicMs();
    this.closeOpen(this.endedAtMs);
    const trace = this.snapshot();
    this.raw.end(trace);
  };

  private closeOpen(atMs: number): void {
    const open = this.phases.at(-1);
    if (open && open.endedAtMs === undefined) open.endedAtMs = Math.max(open.startedAtMs, atMs);
  }
  private openPhase(name: string, atMs: number): void {
    const open = this.phases.at(-1);
    if (open?.endedAtMs === undefined && open?.name === name) {
      this.raw.update({ phase: name });
      return;
    }
    const start = Math.max(0, Number.isFinite(atMs) ? atMs : monotonicMs());
    this.closeOpen(start);
    this.phases.push({ name, startedAtMs: start });
    this.raw.update({ phase: name, phaseMark: { name, startedAtMs: start } });
  }
  private snapshot(): DaemonOperationTrace {
    const open = this.phases.at(-1),
      observedEnd = this.endedAtMs ?? (open?.endedAtMs === undefined ? monotonicMs() : open.endedAtMs);
    return {
      method: this.fields.method,
      traceId: this.traceId,
      spanId: this.spanId,
      nodeId: this.nodeId,
      requestBytes: this.requestBytes,
      replyBytes: this.replyBytes,
      outcome: this.outcome,
      startedAtMs: this.startedAtMs,
      endedAtMs: this.endedAtMs,
      phases: this.phases.map((phase) => ({
        name: phase.name,
        startedAtMs: phase.startedAtMs,
        endedAtMs: phase.endedAtMs ?? observedEnd,
      })),
    };
  }
}

const tracePrefix = randomUUID().replaceAll("-", "").slice(0, 8);
let traceCounter = 0;
function nextCounter(): number {
  traceCounter = (traceCounter + 1) % 0x1_0000_0000;
  return traceCounter;
}
function newTraceId(): string {
  const counter = nextCounter();
  return `${tracePrefix}${counter.toString(16).padStart(8, "0")}${Date.now().toString(16).slice(-8).padStart(8, "0")}${((counter * 0x9e3779b1) >>> 0).toString(16).padStart(8, "0")}`;
}
function newSpanId(): string {
  const counter = nextCounter();
  return `${counter.toString(16).padStart(8, "0")}${(((Date.now() & 0xffffffff) ^ counter) >>> 0).toString(16).padStart(8, "0")}`;
}
