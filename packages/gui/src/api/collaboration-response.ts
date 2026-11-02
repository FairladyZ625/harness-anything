/** All request channels preserve their failure; presentation observes this one domain code. */
export function reportCollaborationResponse(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const reply = value as { readonly code?: unknown; readonly error?: unknown };
  const error =
    typeof reply.error === "object" && reply.error !== null ? (reply.error as { readonly code?: unknown }) : reply;
  if (error.code === "identity_plugin_required") window.dispatchEvent(new Event("harness-collaboration-required"));
}
