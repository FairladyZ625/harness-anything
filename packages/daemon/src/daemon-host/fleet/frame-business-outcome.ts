/** A delivered Fleet frame can carry a business rejection even though transport completion is ok. */
export function fleetFrameBusinessOutcome(frame: {
  readonly schema: string;
  readonly code?: string | null;
  readonly outcome?: string;
}): { readonly ok: boolean; readonly code: string | null } {
  if (frame.schema === "fleet.error/v1") return { ok: false, code: frame.code ?? "error" };
  if (frame.outcome === "op_rejected") return { ok: false, code: "op_rejected" };
  return { ok: true, code: null };
}
