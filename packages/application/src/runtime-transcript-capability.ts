export type RuntimeTranscriptInspection =
  | { readonly status: "available"; readonly logPath: string }
  | { readonly status: "unavailable"; readonly reason: string; readonly searched: boolean }
  | { readonly status: "indeterminate"; readonly reason: string };

export function unavailableDefaultRuntimeCapture(
  runtime: string,
  defaultRootState: "undefined" | "missing"
): RuntimeTranscriptInspection {
  const rootDescription = defaultRootState === "undefined"
    ? "roots are defined"
    : "root exists";
  return {
    status: "unavailable",
    reason: `No default runtime JSONL log ${rootDescription} for ${runtime}; provenance transcript capture is unavailable in this environment.`,
    searched: false
  };
}
