export function isRendererRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function rendererErrorHint(value: unknown, fallback: string): string {
  return isRendererRecord(value) && isRendererRecord(value.error) && typeof value.error.hint === "string"
    ? value.error.hint
    : fallback;
}

export interface FactDomainTypeSummaryRow {
  readonly domainType: string;
  readonly registeredByFactId: string;
  readonly workspaceRevision: number;
}

export function isFactDomainTypeSummaryRow(value: unknown): value is FactDomainTypeSummaryRow {
  return (
    isRendererRecord(value) &&
    typeof value.domainType === "string" &&
    typeof value.registeredByFactId === "string" &&
    Number.isSafeInteger(value.workspaceRevision)
  );
}
