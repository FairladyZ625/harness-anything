import { VcsCommandError } from "../../ports/version-control-system.ts";

export function vcsCommandError(repoRoot: string, args: ReadonlyArray<string>, error: unknown): VcsCommandError {
  return new VcsCommandError({
    command: args[0] ?? "command",
    cwd: repoRoot,
    exitCode: commandErrorCode(error),
    signal: commandErrorSignal(error),
    stderrSummary: commandErrorSummary(error)
  });
}

function commandErrorCode(error: unknown): string | number | undefined {
  if (typeof error === "object" && error && "status" in error) {
    const status = (error as { readonly status?: unknown }).status;
    if (typeof status === "number" || typeof status === "string") return status;
  }
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") return code;
  }
  return undefined;
}

function commandErrorSignal(error: unknown): string | undefined {
  if (typeof error === "object" && error && "signal" in error) {
    const signal = (error as { readonly signal?: unknown }).signal;
    if (typeof signal === "string" && signal.length > 0) return signal;
  }
  return undefined;
}

function commandErrorSummary(error: unknown): string | undefined {
  if (typeof error === "object" && error && "stderr" in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
    const firstLine = text.trim().split(/\r?\n/u).find((line) => line.trim().length > 0);
    if (firstLine) return firstLine;
  }
  if (error instanceof Error) return error.message.split(/\r?\n/u)[0] ?? error.message;
  return String(error);
}
