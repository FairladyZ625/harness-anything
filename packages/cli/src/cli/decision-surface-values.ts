export const decisionSurfaceMaxItems = 32;
export const decisionSurfaceMaxLength = 120;
export const decisionSurfaceMaxTotalBytes = 2048;

export type DecisionSurfaceValuesResult =
  | { readonly ok: true; readonly value: ReadonlyArray<string> }
  | { readonly ok: false; readonly code: "invalid_surface_payload"; readonly reason: string };

export function normalizeDecisionSurfaceValues(input: unknown): DecisionSurfaceValuesResult {
  if (!Array.isArray(input)) return invalidDecisionSurfaces("Decision surfaces must be an array of strings.");
  if (input.length > decisionSurfaceMaxItems) {
    return invalidDecisionSurfaces(`Decision surfaces accept at most ${decisionSurfaceMaxItems} entries.`);
  }
  const values: string[] = [];
  let totalBytes = 0;
  for (const [index, candidate] of input.entries()) {
    if (typeof candidate !== "string") return invalidDecisionSurfaces(`Decision surface at index ${index} must be a string.`);
    const value = candidate.trim();
    if (!value) return invalidDecisionSurfaces(`Decision surface at index ${index} must be non-empty.`);
    if (/[\u0000-\u001f\u007f]/u.test(value)) return invalidDecisionSurfaces(`Decision surface at index ${index} contains a control character.`);
    if ([...value].length > decisionSurfaceMaxLength) {
      return invalidDecisionSurfaces(`Decision surface at index ${index} exceeds ${decisionSurfaceMaxLength} characters.`);
    }
    totalBytes += Buffer.byteLength(value, "utf8");
    if (totalBytes > decisionSurfaceMaxTotalBytes) {
      return invalidDecisionSurfaces(`Decision surfaces exceed ${decisionSurfaceMaxTotalBytes} UTF-8 bytes in total.`);
    }
    values.push(value);
  }
  return {
    ok: true,
    value: [...new Map(values.map((value) => [value.toLowerCase(), value])).values()]
  };
}

function invalidDecisionSurfaces(reason: string): DecisionSurfaceValuesResult {
  return { ok: false, code: "invalid_surface_payload", reason };
}
