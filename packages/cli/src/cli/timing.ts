import { performance } from "node:perf_hooks";

export type CliTimingPhase =
  | "module_load"
  | "cli_command"
  | "parse"
  | "daemon_config"
  | "daemon_target"
  | "daemon_connect"
  | "daemon_launch_authority_ready"
  | "command_execute"
  | "process_exit_wait";

interface CliTimingState {
  readonly processStartMs: number;
  readonly phasesMs: Partial<Record<CliTimingPhase, number>>;
  activeResourcesAfterCommand?: ReadonlyArray<string>;
  activeHandlesAfterCommand?: ReadonlyArray<Record<string, unknown>>;
}

const state: CliTimingState = {
  processStartMs: performance.now(),
  phasesMs: {}
};

export function startCliTimingPhase(phase: CliTimingPhase): () => void {
  const startedAt = performance.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    state.phasesMs[phase] = (state.phasesMs[phase] ?? 0) + performance.now() - startedAt;
  };
}

export function emitCliTimingOnExit(exitCode: number): void {
  if (process.env.HA_TIMING !== "1") return;
  state.activeResourcesAfterCommand = process.getActiveResourcesInfo();
  state.activeHandlesAfterCommand = activeHandleSummaries();
  const finishExitWait = startCliTimingPhase("process_exit_wait");
  process.once("beforeExit", () => {
    finishExitWait();
    emitCliTiming(exitCode);
  });
}

function emitCliTiming(exitCode: number): void {
  const roundedPhases = Object.fromEntries(
    Object.entries(state.phasesMs).map(([phase, elapsed]) => [phase, round(elapsed)])
  );
  console.error(`[ha timing] ${JSON.stringify({
    schema: "ha-cli-timing/v1",
    pid: process.pid,
    exitCode,
    phasesMs: {
      process_start: round(state.processStartMs),
      ...roundedPhases
    },
    activeResourcesAfterCommand: state.activeResourcesAfterCommand,
    activeHandlesAfterCommand: state.activeHandlesAfterCommand,
    totalMs: round(performance.now())
  })}`);
}

function activeHandleSummaries(): ReadonlyArray<Record<string, unknown>> {
  const getActiveHandles = (process as unknown as { readonly _getActiveHandles?: () => ReadonlyArray<unknown> })._getActiveHandles;
  if (!getActiveHandles) return [];
  return getActiveHandles.call(process).map((handle) => {
    const candidate = handle as {
      readonly constructor?: { readonly name?: string };
      readonly fd?: unknown;
      readonly destroyed?: unknown;
      readonly readable?: unknown;
      readonly writable?: unknown;
    };
    return {
      type: candidate.constructor?.name ?? "unknown",
      ...(typeof candidate.fd === "number" ? { fd: candidate.fd } : {}),
      ...(typeof candidate.destroyed === "boolean" ? { destroyed: candidate.destroyed } : {}),
      ...(typeof candidate.readable === "boolean" ? { readable: candidate.readable } : {}),
      ...(typeof candidate.writable === "boolean" ? { writable: candidate.writable } : {})
    };
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
