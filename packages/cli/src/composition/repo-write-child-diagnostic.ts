import { writeSync } from "node:fs";

/**
 * Writer-child diagnostics are best effort. A service launcher's stderr pipe
 * may close as soon as the daemon reaches READY, so an EPIPE must never alter
 * durable write or recovery behavior.
 */
export function writeRepoWriteChildDiagnostic(message: string): void {
  try {
    writeSync(process.stderr.fd, message);
  } catch {
    // Diagnostics must never take the writer child down.
  }
}
