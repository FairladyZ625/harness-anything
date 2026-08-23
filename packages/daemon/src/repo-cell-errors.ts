import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VcsCommandError } from "../../kernel/src/index.ts";

export function cellCodedError(code: string, text: string): Error {
  const error = new Error(text) as Error & { code: string };
  error.code = code;
  return error;
}

export function unavailableRuntimeInstanceStore(): never {
  throw cellCodedError("runtime_instance_store_unavailable", "The machine runtime instance store is unavailable.");
}

export function errorOperationId(error: unknown): string | null {
  return typeof error === "object" && error !== null && "opId" in error && typeof error.opId === "string"
    ? error.opId
    : null;
}

export function cellErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "service_rejected";
}

export function cellErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function publishGeneratedArtifact(input: {
  readonly outputPath: string;
  readonly relativePath: string;
  readonly body: string;
}): void {
  mkdirSync(path.dirname(input.outputPath), { recursive: true });
  if (existsSync(input.outputPath)) {
    if (readFileSync(input.outputPath, "utf8") !== input.body)
      throw cellCodedError(
        "op_conflict",
        `Generated artifact ${input.relativePath} conflicts with the existing operation output.`,
      );
    return;
  }
  writeFileSync(input.outputPath, input.body, { encoding: "utf8", flag: "wx" });
}

export function fatalCellError(error: unknown): boolean {
  if (error instanceof VcsCommandError) return true;
  if (!error || typeof error !== "object" || !("code" in error)) return true;
  return [
    "invalid_store",
    "legacy_shape",
    "op_conflict",
    "revision_conflict",
    "publication_indeterminate",
    "writer_rejected",
  ].includes(String(error.code));
}
