/** Request-log statistics shared by the native CLI and the usage audit. No IO or persistent state. */
export function requestWindowMetrics(
  records: readonly Readonly<Record<string, unknown>>[],
  sinceMs: number,
  untilMs: number,
) {
  const rows = records
    .flatMap((record) => {
      const atMs = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
      return record.schema === "daemon-request-log/v1" && atMs >= sinceMs && atMs <= untilMs ? [{ record, atMs }] : [];
    })
    .sort((left, right) => left.atMs - right.atMs);
  const eligible = rows.filter(({ record }) => record.method !== "repo.agentRuntime.sessions.await");
  const first = rows[0]?.atMs ?? null,
    last = rows.at(-1)?.atMs ?? null;
  const silentIntervals = rows.flatMap((row, index) => {
    const prior = rows[index - 1];
    return prior && row.atMs - prior.atMs > 3_600_000
      ? [{ from: iso(prior.atMs), to: iso(row.atMs), durationMs: row.atMs - prior.atMs }]
      : [];
  });
  return {
    since: iso(sinceMs),
    until: iso(untilMs),
    requestCount: rows.length,
    excludedAwaitRequests: rows.length - eligible.length,
    coverage: {
      firstObservedAt: iso(first),
      lastObservedAt: iso(last),
      observedSpanMs: first === null || last === null ? 0 : last - first,
      leadingUnobservedMs: first === null ? untilMs - sinceMs : first - sinceMs,
      trailingUnobservedMs: last === null ? untilMs - sinceMs : untilMs - last,
      continuity: "unknown" as const,
      silentIntervals,
      note: "Retained completed requests only. Silent intervals may be inactivity or lost retention; no full-window traffic estimate. CLI/GUI source and in-flight requests are unmeasured.",
    },
    latency: {
      durationMs: timing(eligible.map(({ record }) => record.durationMs)),
      serviceMs: timing(eligible.map(({ record }) => record.serviceMs)),
      dispatchDelayMs: timing(eligible.map(({ record }) => record.dispatchDelayMs)),
      note: "Daemon timings, not CLI end-to-end latency. Service includes handler-internal waiting; queue wait inside the handler is not separately measured. P95 uses nearest-rank; fewer than 20 samples is low sample.",
    },
  };
}

function timing(values: readonly unknown[]) {
  const sorted = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const percentile = (q: number) => (sorted.length === 0 ? null : sorted[Math.ceil(q * sorted.length) - 1]!);
  return {
    sampleCount: sorted.length,
    missingCount: values.length - sorted.length,
    lowSample: sorted.length < 20,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? null,
  };
}

function iso(atMs: number | null): string | null {
  return atMs === null ? null : new Date(atMs).toISOString();
}
