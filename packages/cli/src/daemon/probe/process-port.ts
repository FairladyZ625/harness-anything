import { execFile } from "node:child_process";

// One argv-based child-process seam for the probe. It lives in a *-process-port.ts file because a
// daemon-reachable source may not spawn directly (process-port-only gate), and every call declares
// windowsHide so a console-less parent never flashes a console on Windows.
export interface ProbeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /** Set when the process could not run or was killed by the timeout; stdout/stderr stay usable. */
  readonly error: string | null;
}

export function runProbeCommand(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  maxBuffer = 16 * 1024 * 1024,
): Promise<ProbeCommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          exitCode: typeof failure?.code === "number" ? failure.code : failure === null ? 0 : null,
          error:
            failure === null
              ? null
              : typeof failure.code === "string"
                ? `${failure.code}: ${failure.message}`
                : failure.message,
        });
      },
    );
  });
}
