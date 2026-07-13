export class KeyedSerialAuthorityExecutor {
  private readonly tails = new Map<string, Promise<void>>();

  run<Result>(key: string, work: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

interface AuthorityBatchItem<Input, Result> {
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
  outcome?: PromiseSettledResult<Input>;
}

export class BoundedAuthorityBatcher<Input, Result> {
  private readonly queue: AuthorityBatchItem<Input, Result>[] = [];
  private draining = false;
  private drainScheduled = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly runBatch: (inputs: ReadonlyArray<Input>) => Promise<ReadonlyArray<Result>>;
  private readonly maxBatchSize: number;
  private readonly maxWaitMs: number;

  constructor(
    runBatch: (inputs: ReadonlyArray<Input>) => Promise<ReadonlyArray<Result>>,
    maxBatchSize: number,
    maxWaitMs: number
  ) {
    this.runBatch = runBatch;
    this.maxBatchSize = maxBatchSize;
    this.maxWaitMs = maxWaitMs;
  }

  run(input: Promise<Input>): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      const item: AuthorityBatchItem<Input, Result> = { resolve, reject };
      this.queue.push(item);
      void input.then(
        (value) => {
          item.outcome = { status: "fulfilled", value };
          this.scheduleIfReady();
        },
        (reason) => {
          item.outcome = { status: "rejected", reason };
          this.scheduleIfReady();
        }
      );
      this.ensureTimer();
    });
  }

  private scheduleIfReady(): void {
    if (this.draining || this.drainScheduled || this.queue.length === 0) return;
    const readyPrefix = this.readyPrefixLength();
    if (readyPrefix === 0) return;
    if (readyPrefix >= this.maxBatchSize || readyPrefix === this.queue.length) this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining || this.queue.length === 0) return;
    const count = Math.min(this.readyPrefixLength(), this.maxBatchSize);
    if (count === 0) { this.ensureTimer(); return; }
    this.draining = true;
    this.clearTimer();
    const items = this.queue.splice(0, count);
    const fulfilled = items.filter((item): item is AuthorityBatchItem<Input, Result> & { outcome: PromiseFulfilledResult<Input> } =>
      item.outcome?.status === "fulfilled");
    for (const item of items) if (item.outcome?.status === "rejected") item.reject(item.outcome.reason);
    try {
      if (fulfilled.length > 0) {
        const results = await this.runBatch(fulfilled.map((item) => item.outcome.value));
        if (results.length !== fulfilled.length) throw new Error("authority batch result count mismatch");
        fulfilled.forEach((item, index) => item.resolve(results[index]!));
      }
    } catch (error) {
      for (const item of fulfilled) item.reject(error);
    } finally {
      this.draining = false;
      this.scheduleIfReady();
      this.ensureTimer();
    }
  }

  private readyPrefixLength(): number {
    let count = 0;
    while (count < this.queue.length && this.queue[count]?.outcome) count += 1;
    return count;
  }

  private ensureTimer(): void {
    if (this.timer || this.draining || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.readyPrefixLength() > 0) this.scheduleDrain();
      else this.ensureTimer();
    }, this.maxWaitMs);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
