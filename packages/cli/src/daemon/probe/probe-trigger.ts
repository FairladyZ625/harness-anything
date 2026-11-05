// One capture per ongoing event, not one per reason. Down, sustained CPU, and RSS may all be true
// for the same stall; they share one event latch and one global cooldown, otherwise a single stall
// would call the OS stack sampler three times. The latch clears only after every condition is gone.
export type TriggerReason = "unresponsive" | "high-cpu" | "rss";

export type ProbeState = "up" | "slow" | "down";

export interface TriggerSample {
  readonly at: number;
  readonly state: ProbeState;
  readonly cpuPercent: number | null;
  readonly rssBytes: number | null;
}

export interface TriggerOptions {
  readonly unresponsiveMs: number;
  readonly cpuPercent: number;
  readonly cpuSustainMs: number;
  readonly rssBytes: number;
  readonly cooldownMs: number;
}

export interface TriggerTracker {
  readonly evaluate: (sample: TriggerSample) => TriggerReason | null;
  readonly attempted: (at: number, captured: boolean) => void;
}

export function createTriggerTracker(options: TriggerOptions): TriggerTracker {
  let downSince: number | null = null,
    cpuSince: number | null = null,
    eventCaptured = false,
    lastAttemptAt: number | null = null;
  return {
    evaluate: (sample) => {
      const down = sample.state === "down",
        highCpu = sample.cpuPercent !== null && sample.cpuPercent >= options.cpuPercent,
        highRss = sample.rssBytes !== null && sample.rssBytes >= options.rssBytes;
      if (!down && !highCpu && !highRss) {
        downSince = null;
        cpuSince = null;
        eventCaptured = false;
        return null;
      }
      if (down) downSince ??= sample.at;
      else downSince = null;
      if (highCpu) cpuSince ??= sample.at;
      else cpuSince = null;
      // The event is already represented by a previous capture. It stays suppressed until every
      // condition clears, even after the cooldown has elapsed.
      if (eventCaptured) return null;
      const downDue = down && downSince !== null && sample.at - downSince >= options.unresponsiveMs,
        cpuDue = highCpu && cpuSince !== null && sample.at - cpuSince >= options.cpuSustainMs,
        reason: TriggerReason | null = downDue ? "unresponsive" : cpuDue ? "high-cpu" : highRss ? "rss" : null;
      if (reason === null) return null;
      // A cooldown does not discard the event: leave it uncaptured so the next sample after the
      // cooldown captures the still-running failure once.
      if (lastAttemptAt !== null && sample.at - lastAttemptAt < options.cooldownMs) return null;
      return reason;
    },
    attempted: (at, captured) => {
      eventCaptured = captured;
      lastAttemptAt = at;
    },
  };
}
