import type { CommandFailureReceipt } from "./receipt.ts";

type ParseFailureError = CommandFailureReceipt["error"];

interface ParseFailureRuntimeEventDependencies {
  readonly append?: (argv: ReadonlyArray<string>, error: ParseFailureError) => Promise<void>;
  readonly warn?: (message: string) => void;
}

export async function appendParseFailureRuntimeEvent(
  argv: ReadonlyArray<string>,
  error: ParseFailureError,
  dependencies: ParseFailureRuntimeEventDependencies = {}
): Promise<void> {
  try {
    // Parse failures occur before a command can be routed to the daemon. Until
    // the daemon exposes a dedicated operational diagnostic RPC, the primary
    // failure receipt is the diagnostic; the CLI must not become a second
    // canonical writer merely to persist best-effort telemetry.
    await (dependencies.append ?? noCanonicalParseFailureWrite)(argv, error);
  } catch (diagnosticError) {
    try {
      const detail = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
      (dependencies.warn ?? console.error)(
        `warning: unable to append CLI parse-failure diagnostic: ${detail}`
      );
    } catch {
      // A broken stderr must not turn best-effort diagnostics into the primary failure.
    }
  }
}

function noCanonicalParseFailureWrite(
  _argv: ReadonlyArray<string>,
  _error: ParseFailureError
): Promise<void> {
  // Intentionally empty. See the single-writer rationale above.
  return Promise.resolve();
}
