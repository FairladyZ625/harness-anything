import {
  isReceiptDiagnostic,
  taskLifecycleReturnsForCommand,
  type ReceiptGuidanceArgument,
  type ReceiptGuidanceContractEntry,
  type ReceiptDiagnostic,
} from "../../kernel/src/index.ts";

export function taskCreateGuidance(values: Readonly<Record<string, string | number | boolean>>) {
  const returns = taskLifecycleReturnsForCommand("CreateReplayTask");
  if (!returns) throw new Error("CreateReplayTask has no declared return contract.");
  return Object.freeze(returns.guidance.map((entry) => resolveGuidanceEntry(entry, values)));
}

export function diagnosticForError(error: unknown): ReceiptDiagnostic | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("diagnostic" in error && isReceiptDiagnostic(error.diagnostic)) return error.diagnostic;
  if (
    "documentPath" in error &&
    typeof error.documentPath === "string" &&
    "diskDiffers" in error &&
    typeof error.diskDiffers === "boolean" &&
    "missingSections" in error &&
    Array.isArray(error.missingSections)
  )
    return {
      kind: "missing-sections",
      documentPath: error.documentPath,
      diskDiffers: error.diskDiffers,
      missingSections: error.missingSections as Extract<
        ReceiptDiagnostic,
        { readonly kind: "missing-sections" }
      >["missingSections"],
    };
  if (
    "field" in error &&
    typeof error.field === "string" &&
    "workspaceRoot" in error &&
    typeof error.workspaceRoot === "string"
  )
    return { kind: "workspace-boundary", field: error.field, workspaceRoot: error.workspaceRoot };
  return undefined;
}

function resolveGuidanceEntry(
  entry: ReceiptGuidanceContractEntry,
  values: Readonly<Record<string, string | number | boolean>>,
): ReceiptGuidanceContractEntry {
  return Object.freeze({
    kind: entry.kind,
    args: Object.freeze(
      Object.fromEntries(Object.entries(entry.args).map(([field, value]) => [field, resolveArgument(value, values)])),
    ),
    ...(entry.when ? { when: entry.when } : {}),
  });
}

function resolveArgument(
  argument: ReceiptGuidanceArgument,
  values: Readonly<Record<string, string | number | boolean>>,
): ReceiptGuidanceArgument {
  if (typeof argument !== "string") return argument;
  return argument.replaceAll(/\{([^{}]+)\}/gu, (_match, field: string) => {
    const value = values[field];
    if (value === undefined) throw new Error(`Receipt guidance placeholder ${field} is not available.`);
    return String(value);
  });
}
