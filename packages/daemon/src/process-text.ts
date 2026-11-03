import {
  /* @gate-identity check-sync-subprocess/sync-subprocess-008 */
  execFileSync,
} from "node:child_process";

// Kept separate from daemon lifecycle/signal handling: build identity is on every CLI handshake.
export function runProcessText(
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): string {
  return (
    /* @gate-identity check-sync-subprocess/sync-subprocess-009 */
    execFileSync(command, [...args], {
      cwd,
      ...(env ? { env } : {}),
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  );
}
