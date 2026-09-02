// Phase-resolved timing for one CLI invocation, rebuilt from zero after the reset removed the
// previous HA_TIMING surface. Off unless HA_CLI_TIMING=1, and off is the path every ordinary
// invocation takes: each entry point below returns after reading one module-level boolean, so a
// disabled run allocates nothing, opens nothing, and writes nothing. process.env is read exactly
// once, while the module graph loads, and never again.
//
// Every boundary is anchored on an action the measured process itself takes -- entry into main,
// return from the parser, return from the transport, return from the renderer. Nothing here
// schedules a timer or waits for a wall-clock instant, which is what
// dec_9B75595FC45E01DDFD0938FE95 forbids for observed intermediate state.
//
// The record leaves on stderr (or HA_CLI_TIMING_FILE), never stdout, so a --json invocation still
// prints exactly one receipt line whether timing is on or off.
import { appendFileSync } from "node:fs";
import { firstCliCommandIndex } from "./thin-command-help.ts";

export type CliTimingPhase = "spawn" | "parse" | "dispatch" | "daemonRoundTrip" | "render";

export type CliDaemonRoundTrip = {
  readonly method: string;
  readonly startedAtEpochMs: number;
  readonly endedAtEpochMs: number;
  readonly roundTripMs: number;
};

const enabled = process.env.HA_CLI_TIMING === "1",
  sinkPath = enabled ? (process.env.HA_CLI_TIMING_FILE ?? null) : null,
  sha = enabled ? (process.env.HA_CLI_TIMING_SHA ?? null) : null,
  phases = enabled ? { spawn: 0, parse: 0, dispatch: 0, daemonRoundTrip: 0, render: 0 } : null,
  roundTrips: CliDaemonRoundTrip[] | null = enabled ? [] : null;
let startedAtEpochMs = 0;

export function cliTimingEnabled(): boolean {
  return enabled;
}

// performance.now() is measured from process start, so the value read on entry to main IS the
// spawn phase: interpreter boot plus the thin entry's static module graph. It is read, not
// scheduled.
export function beginCliTiming(): void {
  if (phases === null) return;
  phases.spawn = performance.now();
  startedAtEpochMs = Date.now();
}

export function cliPhaseStart(): number {
  return enabled ? performance.now() : 0;
}

export function cliPhaseEnd(phase: CliTimingPhase, startedAt: number): void {
  if (phases === null) return;
  phases[phase] += performance.now() - startedAt;
}

// Returns the transport function itself when timing is off, so a disabled run pays one call and
// one boolean read at dispatch time and carries no wrapper on the hot path at all. Every daemon
// branch of runCommandThroughDaemon goes through the single returned reference, so a command that
// makes three round trips accumulates three, and the polling loop of a preset run accumulates one
// per poll.
export function timedDaemonRequest<Args extends unknown[], Result>(
  request: (...args: Args) => Promise<Result>,
  methodOf: (args: Args) => string,
): (...args: Args) => Promise<Result> {
  if (roundTrips === null || phases === null) return request;
  return async (...args: Args): Promise<Result> => {
    const startedAt = performance.now(),
      startedAtEpoch = Date.now();
    try {
      return await request(...args);
    } finally {
      const roundTripMs = performance.now() - startedAt;
      phases.daemonRoundTrip += roundTripMs;
      roundTrips.push({
        method: methodOf(args),
        startedAtEpochMs: startedAtEpoch,
        endedAtEpochMs: Date.now(),
        roundTripMs: round(roundTripMs),
      });
    }
  };
}

// `ha task show task-1 --json` is the same measured command as `ha task show task-2 --json`; the
// label is the command surface, not the arguments, so a measurement can group samples. The domain
// comes from the same scanner the dispatcher uses, so `--root <path>` contributes its path to
// neither.
export function cliCommandLabel(argv: readonly string[]): string {
  const index = firstCliCommandIndex(argv);
  if (index < 0) return argv.includes("--help") ? "--help" : "(none)";
  const domain = argv[index] ?? "(none)",
    verb = argv[index + 1];
  return verb === undefined || verb.startsWith("-") ? domain : `${domain} ${verb}`;
}

// dispatch is reported with the daemon round trip removed, so the five phases partition the
// invocation instead of counting the wire time twice. unattributedMs is the remainder that no
// instrumented boundary claims -- it is reported rather than hidden, because a large remainder is
// itself the finding when a production trace and a microbenchmark disagree by an order of
// magnitude.
export function finishCliTiming(argv: readonly string[], exitCode: number): void {
  if (phases === null || roundTrips === null) return;
  const totalMs = performance.now(),
    dispatchMs = Math.max(0, phases.dispatch - phases.daemonRoundTrip),
    attributed = phases.spawn + phases.parse + dispatchMs + phases.daemonRoundTrip + phases.render,
    record = {
      schema: "ha-cli-timing/v2",
      command: cliCommandLabel(argv),
      totalMs: round(totalMs),
      phases: {
        spawn: round(phases.spawn),
        parse: round(phases.parse),
        dispatch: round(dispatchMs),
        daemonRoundTrip: round(phases.daemonRoundTrip),
        render: round(phases.render),
      },
      unattributedMs: round(Math.max(0, totalMs - attributed)),
      // The daemon reply carries no server-side service time, so a CLI process cannot observe the
      // handler split in band. It stays null here and the measurer joins daemonRequests against
      // the daemon connection log, which is the same source tools/measure-gui-read-baseline.mjs
      // uses for handler duration. When the reply gains a service-time field this becomes a
      // populated number and no consumer schema changes.
      daemonHandlerMs: null,
      daemonRequests: roundTrips,
      exitCode,
      sha,
      pid: process.pid,
      node: process.version,
      startedAtEpochMs,
      endedAtEpochMs: Date.now(),
    },
    line = `${JSON.stringify(record)}\n`;
  if (sinkPath === null) process.stderr.write(line);
  else appendFileSync(sinkPath, line);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
