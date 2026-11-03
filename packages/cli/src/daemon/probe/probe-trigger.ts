// Trigger state is per reason and deliberately sticky: once a condition produces a capture, the same
// ongoing event never produces a second one. Re-arming requires the condition to clear; the cooldown
// then covers a rapid clear/re-fire cycle, which would otherwise flood the capture directory.
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
  readonly armedReasons: () => readonly TriggerReason[];
}

export function createTriggerTracker(options: TriggerOptions): TriggerTracker {
  const armed = new Set<TriggerReason>(),
    lastCaptureAt = new Map<TriggerReason, number>();
  let downSince: number | null = null,
    cpuSince: number | null = null;
  return {
    evaluate: (sample) => {
      let fired: TriggerReason | null = null;
      if (sample.state === "down") {
        downSince ??= sample.at;
        if (sample.at - downSince >= options.unresponsiveMs)
          fired = fire("unresponsive", sample.at, armed, lastCaptureAt, options.cooldownMs);
      } else {
        downSince = null;
        armed.delete("unresponsive");
      }
      if (!fired) {
        if (sample.cpuPercent !== null && sample.cpuPercent >= options.cpuPercent) {
          cpuSince ??= sample.at;
          if (sample.at - cpuSince >= options.cpuSustainMs)
            fired = fire("high-cpu", sample.at, armed, lastCaptureAt, options.cooldownMs);
        } else {
          cpuSince = null;
          armed.delete("high-cpu");
        }
      }
      if (!fired) {
        if (sample.rssBytes !== null && sample.rssBytes >= options.rssBytes)
          fired = fire("rss", sample.at, armed, lastCaptureAt, options.cooldownMs);
        else armed.delete("rss");
      }
      return fired;
    },
    armedReasons: () => [...armed],
  };
}

function fire(
  reason: TriggerReason,
  at: number,
  armed: Set<TriggerReason>,
  lastCaptureAt: Map<TriggerReason, number>,
  cooldownMs: number,
): TriggerReason | null {
  if (armed.has(reason)) return null;
  const last = lastCaptureAt.get(reason);
  // Arm even when the cooldown suppresses the capture: the event was already answered by the
  // previous capture, so waiting out the cooldown must not turn one event into two scenes.
  armed.add(reason);
  if (last !== undefined && at - last < cooldownMs) return null;
  lastCaptureAt.set(reason, at);
  return reason;
}
