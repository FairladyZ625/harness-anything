export class BrokerOperationLatch {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  run<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.pendingCount += 1;
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {
        this.pendingCount -= 1;
      },
      () => {
        this.pendingCount -= 1;
      }
    );
    return result;
  }

  get pending(): boolean {
    return this.pendingCount > 0;
  }
}
