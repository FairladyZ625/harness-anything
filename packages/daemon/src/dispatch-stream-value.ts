export function isFallbackProvider(value: unknown): value is { readonly instance: string; readonly model?: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { readonly instance?: unknown }).instance === "string" &&
    ((value as { readonly model?: unknown }).model === undefined ||
      typeof (value as { readonly model?: unknown }).model === "string")
  );
}
