/**
 * One failure-isolated FIFO for every canonical mutation executed by a writer
 * generation. The same instance can be shared with replacement recovery so a
 * resumed durable attempt is ordered before newly admitted volatile work.
 */
export class RepoWriteExecutionSequencer {
  private tail: Promise<void> = Promise.resolve();

  run<T>(execute: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
