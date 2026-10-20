import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import type { PresetSnapshotClaim } from "../domain/task-bootstrap-event.ts";
import type { VerticalCompletionDeclaration } from "../domain/completion-source.ts";
import type { CanonicalContentBlob } from "./task-event-store-types.ts";

interface HistoricalSnapshot extends Record<string, unknown> {
  readonly digest: string;
  readonly profile: Record<string, unknown> & { readonly completionGateIds: readonly string[] };
}

export interface ConvertedCompletionSnapshot {
  readonly claim: PresetSnapshotClaim;
  readonly blob: CanonicalContentBlob;
  readonly value: HistoricalSnapshot & { readonly completion: VerticalCompletionDeclaration };
}

/** Only the offline writer reads the retired snapshot format. No installed package participates. */
export function convertCompletionSnapshot(claim: PresetSnapshotClaim, bytes: Uint8Array): ConvertedCompletionSnapshot {
  const original = JSON.parse(new TextDecoder().decode(bytes)) as HistoricalSnapshot,
    { digest: _oldDigest, ...body } = original,
    { checkerProfile: _retired, ...profile } = original.profile;
  if (original.digest !== claim.digest)
    throw new Error(`snapshot claim does not name its logical digest: ${claim.digest}`);
  const sources: Record<string, VerticalCompletionDeclaration["sources"][string]> = {},
    gates: Record<string, VerticalCompletionDeclaration["gates"][string]> = {};
  for (const gateId of original.profile.completionGateIds) {
    if (gateId === "code-doc-reconciliation") continue;
    // Retired from live contracts. Keep the historical gate id in its profile snapshot, while
    // leaving the converted declaration free of a hosted source and execution mapping.
    if (gateId === "ci") continue;
    throw new Error(`historical snapshot ${claim.digest} has no accepted declaration for gate ${gateId}`);
  }
  const completion: VerticalCompletionDeclaration = {
      sources,
      gates,
      closeoutDefaults: { review: false, consent: false, factDisposition: false, codeDoc: false },
    },
    current = { ...body, profile, completion, completionPackages: {} },
    digest = `sha256:${sha256Text(stableStringify(current))}` as const,
    value = { ...current, digest } as ConvertedCompletionSnapshot["value"],
    serialized = `${stableStringify(value)}\n`,
    sha256 = sha256Text(serialized),
    size = Buffer.byteLength(serialized);
  return {
    value,
    claim: { ...claim, digest, sha256, size },
    blob: { sha256, size, mediaType: "application/json", body: serialized },
  };
}
