import { consumeKnownError } from "@harness-anything/kernel";

/** Decodes a receipt evidence string, accepting either a bare JSON body or a `tag:json` form. */
export function decodeEvidencePayload(evidence: string): unknown {
  const tag = evidence.indexOf(":");
  for (const candidate of tag > 0 ? [evidence, evidence.slice(tag + 1)] : [evidence]) {
    if (!/^[[{]/u.test(candidate)) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      consumeKnownError(error);
    }
  }
  return undefined;
}
