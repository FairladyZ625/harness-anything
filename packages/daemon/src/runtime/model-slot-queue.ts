/**
 * Fair admission for local model generations.
 *
 * A queue entry is a request to start a generation, not a running generation.
 * The caller starts its execution timeout after `acquire` resolves; time spent
 * waiting here is therefore deliberately outside that timeout.
 */

export type SlotErrorCode =
  | "RUNTIME_CLOSING"
  | "SLOT_DUPLICATE"
  | "SLOT_CANCELLED"
  | "SLOT_QUEUE_TIMEOUT"
  | "INVALID_CONFIG"
  | "INVALID_SLOT_REQUEST"
  | "CONTEXT_BUDGET_EXCEEDED"
  | "RELAY_REFUSED"
  | "MODEL_UNPRICED"
  | "BUDGET_EXCEEDED"
  | "GENERATION_LIMIT";

/** Errors from this runtime boundary retain a machine-readable code for RPC callers. */
export class RuntimeBoundaryError extends Error {
  readonly name = "RuntimeBoundaryError";
  readonly code: SlotErrorCode;
  readonly status: number;
  constructor(code: SlotErrorCode, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface SlotRequest {
  readonly attemptId: string;
  readonly ownerKey: string;
  readonly flowKey: string;
}

export interface SlotQueueOptions {
  readonly globalCapacity?: number;
  readonly perOwnerCapacity?: number;
  readonly maxWaitMs?: number;
  /** Injectable clock for deterministic callers and tests. */
  readonly now?: () => number;
  /** Injectable timeout scheduler; production defaults to setTimeout. */
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimeout?: (timer: NodeJS.Timeout) => void;
}

interface Waiter extends SlotRequest {
  readonly enqueuedAt: number;
  readonly sequence: number;
  readonly grant: () => void;
  readonly refuse: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

export const DEFAULT_SLOT_WAIT_MS = 30 * 60 * 1000;

const positiveInteger = (value: number, name: string, max: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new RuntimeBoundaryError("INVALID_CONFIG", `${name} must be an integer from 1 to ${max}.`, 500);
  return value;
};

export class ModelSlotQueue {
  readonly globalCapacity: number;
  readonly perOwnerCapacity: number;
  readonly maxWaitMs: number;
  private readonly running = new Map<string, SlotRequest>();
  private readonly flows = new Map<string, Waiter[]>();
  private readonly servedAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private sequence = 0;
  private serviceTick = 0;
  private closed = false;

  constructor(options: SlotQueueOptions = {}) {
    this.globalCapacity = positiveInteger(options.globalCapacity ?? 1, "globalCapacity", 64);
    this.perOwnerCapacity = positiveInteger(options.perOwnerCapacity ?? 1, "perOwnerCapacity", 64);
    this.maxWaitMs = positiveInteger(options.maxWaitMs ?? DEFAULT_SLOT_WAIT_MS, "maxWaitMs", 24 * 3600 * 1000);
    this.now = options.now ?? Date.now;
    this.scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  }

  /** Admit immediately when possible, otherwise append to the flow's FIFO queue. */
  acquire(request: SlotRequest): Promise<void> {
    this.validateRequest(request);
    if (this.closed)
      return Promise.reject(
        new RuntimeBoundaryError("RUNTIME_CLOSING", "runtime is closing; no new slot waits are accepted", 503),
      );
    if (this.running.has(request.attemptId) || this.findWaiter(request.attemptId))
      return Promise.reject(
        new RuntimeBoundaryError("SLOT_DUPLICATE", "the attempt already owns or waits for a model slot"),
      );

    return new Promise<void>((grant, refuse) => {
      const waiter: Waiter = {
        ...request,
        enqueuedAt: this.now(),
        sequence: this.sequence++,
        grant,
        refuse,
        timer: null,
      };
      waiter.timer = this.scheduleTimeout(() => this.expire(request.attemptId), this.maxWaitMs);
      waiter.timer.unref?.();
      const flow = this.flows.get(request.flowKey);
      if (flow) flow.push(waiter);
      else this.flows.set(request.flowKey, [waiter]);
      this.pump();
    });
  }

  /** Release a running attempt or cancel a queued one. Safe to call repeatedly. */
  release(attemptId: string): void {
    const waiting = this.findWaiter(attemptId);
    if (waiting) {
      this.remove(waiting);
      waiting.refuse(new RuntimeBoundaryError("SLOT_CANCELLED", "slot wait cancelled"));
      this.pump();
    }
    if (this.running.delete(attemptId)) this.pump();
  }

  /** Zero for a running attempt, one-based queue position for a waiter, null otherwise. */
  position(attemptId: string): number | null {
    if (this.running.has(attemptId)) return 0;
    const position = this.projectedOrder().findIndex((waiter) => waiter.attemptId === attemptId);
    return position < 0 ? null : position + 1;
  }

  snapshot(): {
    readonly running: SlotRequest[];
    readonly waiting: (SlotRequest & { readonly position: number; readonly waitedMs: number })[];
  } {
    const now = this.now();
    return {
      running: [...this.running.values()].map((request) => ({ ...request })),
      waiting: this.projectedOrder().map((waiter, index) => ({
        attemptId: waiter.attemptId,
        ownerKey: waiter.ownerKey,
        flowKey: waiter.flowKey,
        position: index + 1,
        waitedMs: Math.max(0, now - waiter.enqueuedAt),
      })),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.flows.values()) {
      for (const waiter of queue) {
        this.clearWaiterTimer(waiter);
        waiter.refuse(
          new RuntimeBoundaryError("RUNTIME_CLOSING", "runtime is closing; queued slot waits were cancelled", 503),
        );
      }
    }
    this.flows.clear();
  }

  private validateRequest(request: SlotRequest): void {
    for (const [name, value] of Object.entries(request)) {
      if (typeof value !== "string" || value.length === 0 || value.length > 256)
        throw new RuntimeBoundaryError(
          "INVALID_SLOT_REQUEST",
          `${name} must be a non-empty string of at most 256 characters.`,
          400,
        );
    }
  }

  private ownerLoad(ownerKey: string): number {
    let load = 0;
    for (const request of this.running.values()) if (request.ownerKey === ownerKey) load++;
    return load;
  }

  private pump(): void {
    while (this.running.size < this.globalCapacity) {
      const waiter = this.nextEligible();
      if (!waiter) return;
      this.remove(waiter);
      this.servedAt.set(waiter.flowKey, ++this.serviceTick);
      this.running.set(waiter.attemptId, {
        attemptId: waiter.attemptId,
        ownerKey: waiter.ownerKey,
        flowKey: waiter.flowKey,
      });
      waiter.grant();
    }
  }

  private flowHeads(flows: Map<string, Waiter[]>, servedAt: Map<string, number>): Waiter[] {
    return [...flows.values()]
      .map((queue) => queue[0]!)
      .sort(
        (left, right) =>
          (servedAt.get(left.flowKey) ?? 0) - (servedAt.get(right.flowKey) ?? 0) || left.sequence - right.sequence,
      );
  }

  private nextEligible(): Waiter | undefined {
    return this.flowHeads(this.flows, this.servedAt).find(
      (waiter) => this.ownerLoad(waiter.ownerKey) < this.perOwnerCapacity,
    );
  }

  /** Display-only grant order. It applies LRS/FIFO and intentionally ignores owner capacity. */
  private projectedOrder(): Waiter[] {
    const flows = new Map([...this.flows].map(([flowKey, queue]) => [flowKey, [...queue]]));
    const servedAt = new Map(this.servedAt);
    const result: Waiter[] = [];
    let tick = this.serviceTick;
    while (flows.size > 0) {
      const head = this.flowHeads(flows, servedAt)[0]!;
      const queue = flows.get(head.flowKey)!;
      result.push(queue.shift()!);
      servedAt.set(head.flowKey, ++tick);
      if (queue.length === 0) flows.delete(head.flowKey);
    }
    return result;
  }

  private findWaiter(attemptId: string): Waiter | undefined {
    for (const queue of this.flows.values()) {
      const waiter = queue.find((candidate) => candidate.attemptId === attemptId);
      if (waiter) return waiter;
    }
    return undefined;
  }

  private clearWaiterTimer(waiter: Waiter): void {
    if (waiter.timer !== null) {
      this.clearTimer(waiter.timer);
      waiter.timer = null;
    }
  }

  private remove(waiter: Waiter): void {
    this.clearWaiterTimer(waiter);
    const queue = this.flows.get(waiter.flowKey);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.flows.delete(waiter.flowKey);
  }

  private expire(attemptId: string): void {
    const waiter = this.findWaiter(attemptId);
    if (!waiter) return;
    this.remove(waiter);
    waiter.refuse(new RuntimeBoundaryError("SLOT_QUEUE_TIMEOUT", "model slot queue wait exceeded its limit", 503));
    this.pump();
  }
}

export const LOCAL_CONTEXT_WINDOW = Object.freeze({ nCtx: 40_960, outputReserve: 4_096 });

/** Conservative token estimate without requiring a provider-specific tokenizer. */
export function estimateInputTokens(text: string): number {
  let wide = 0;
  let other = 0;
  for (const character of text) {
    if (/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/u.test(character)) wide++;
    else other++;
  }
  return wide + Math.ceil(other / 3);
}

export function assertContextBudget(
  text: string,
  window: { readonly nCtx: number; readonly outputReserve: number } = LOCAL_CONTEXT_WINDOW,
): number {
  if (
    !Number.isSafeInteger(window.nCtx) ||
    !Number.isSafeInteger(window.outputReserve) ||
    window.nCtx < 1 ||
    window.outputReserve < 0
  )
    throw new RuntimeBoundaryError("INVALID_CONFIG", "context window values are invalid", 500);
  const estimated = estimateInputTokens(text);
  const limit = window.nCtx - window.outputReserve;
  if (estimated > limit)
    throw new RuntimeBoundaryError(
      "CONTEXT_BUDGET_EXCEEDED",
      `estimated input ${estimated} tokens exceeds context budget ${limit} (n_ctx ${window.nCtx} minus output reserve ${window.outputReserve})`,
      413,
    );
  return estimated;
}
