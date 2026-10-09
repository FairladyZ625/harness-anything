/** One consumption settle per dispatch, persisted as the `runtime_metrics` stream kind. */
export type RuntimeMetrics = {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly toolCallCount: number;
  readonly compacted: boolean;
  readonly raw: Record<string, unknown>;
  /** True when the provider reported no usage, so the zero counters are absence, not consumption.
   * Absent on records written before the field existed; readers treat absence as false. */
  readonly usageUnavailable?: boolean;
  /** Cache-write tokens the provider reported (inputTokens keeps including them). Zero-equivalent
   * absence: records written before the field existed, and providers whose usage reports carry no
   * cache-write field, both price their writes inside the input remainder — never as an estimate. */
  readonly cacheWriteTokens?: number;
};
