#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitCliTimingOnExit, startCliTimingPhase } from "./cli/timing.ts";

const finishModuleLoad = startCliTimingPhase("module_load");
const slowLoadNotice = progressNotice("Loading CLI modules");
const { main } = await import("./main.ts");
clearTimeout(slowLoadNotice);
finishModuleLoad();

export { main };

function isCliEntrypoint(): boolean {
  const invokedPath = process.argv[1];
  if (!invokedPath) return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return invokedPath.endsWith("packages/cli/src/index.ts");
  }
}

function progressNotice(activity: string): NodeJS.Timeout {
  const timer = setTimeout(() => {
    console.error(`[ha] ${activity}; still working after 1s.`);
  }, 1_000);
  timer.unref();
  return timer;
}

if (isCliEntrypoint()) {
  const finishCommand = startCliTimingPhase("cli_command");
  const exitCode = await main();
  finishCommand();
  if (process.env.HARNESS_DAEMON_SERVER_HOST === "1") {
    process.exit(exitCode);
  }
  process.exitCode = exitCode;
  emitCliTimingOnExit(exitCode);
}
