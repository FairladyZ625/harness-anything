import { spawn } from "node:child_process";
import path from "node:path";
import { Effect } from "effect";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runGuiCommand: CommandRunner = (_context, command) =>
  Effect.sync(() => launchGui(command.rootDir, command.layoutOverrides?.authoredRoot));

function launchGui(rootDir: string, authoredRoot?: string): CliResult {
  const command = ["npm", "--workspace", "@harness-anything/gui", "run", "dev"] as const;
  const dryRun = process.env.HARNESS_GUI_DRY_RUN === "1";
  if (dryRun) {
    return {
      ok: true,
      command: "gui",
      launchPlan: {
        packageName: "@harness-anything/gui",
        mode: "local-desktop-controller",
        apiHost: "127.0.0.1",
        delegated: true,
        dryRun,
        command
      }
    };
  }

  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      HARNESS_GUI_ROOT: path.resolve(rootDir),
      ...(authoredRoot ? { HARNESS_AUTHORED_ROOT: authoredRoot } : {})
    }
  });
  child.unref();

  return {
    ok: true,
    command: "gui",
    launchPlan: {
      packageName: "@harness-anything/gui",
      mode: "local-desktop-controller",
      apiHost: "127.0.0.1",
      delegated: true,
      dryRun,
      command,
      pid: child.pid
    }
  };
}
