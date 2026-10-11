import { decodeVerticalDefinition, parseVerticalDeclarationDocument } from "@harness-anything/kernel";
import { isPresetResolutionRecord as record } from "./preset-resolver-common.ts";

// Frozen conversion of software-coding-standard, not the installed version's evolving defaults.
const standardCompletion = {
  sources: {
    "github-actions": {
      kind: "github-actions",
      predicateType: "harness/ci/v1",
      resultSchema: { type: "object", additionalProperties: false },
    },
    "manual-attest": {
      kind: "manual",
      predicateType: "harness/attestation/v1",
      resultSchema: { type: "object", additionalProperties: false },
    },
  },
  gates: { ci: { source: "github-actions", appliesTo: "code" } },
  closeoutDefaults: { review: false, consent: false, factDisposition: false, codeDoc: true },
};

/** Explicit conversion only. Readers continue rejecting retired fields. */
export function convertCompletionDeclaration(value: unknown): unknown {
  if (!record(value)) throw new Error("Completion migration requires a JSON object.");
  if (value.schema === "repository-vertical-declaration/v1") {
    const converted = { ...value, definition: convertCompletionDeclaration(value.definition) };
    parseVerticalDeclarationDocument(converted);
    return converted;
  }
  if (value.schema !== "vertical-definition/v1") throw new Error("Unsupported completion declaration schema.");
  const { checkerProfile, ...converted } = value;
  if (checkerProfile !== undefined && checkerProfile !== "software-coding-standard")
    throw new Error(`No completion migration mapping for checkerProfile ${String(checkerProfile)}.`);
  if (converted.completion === undefined) {
    if (converted.id !== "software/coding" || checkerProfile !== "software-coding-standard")
      throw new Error("Missing completion has no historical software-coding-standard mapping.");
    converted.completion = structuredClone(standardCompletion);
  }
  decodeVerticalDefinition(converted);
  return converted;
}

export function convertCompletionManifest(value: unknown) {
  if (!record(value) || value.schema !== "preset-manifest/v3" || !Array.isArray(value.profiles))
    throw new Error("Unsupported completion preset schema.");
  const converted = {
    ...value,
    profiles: value.profiles.map((profile: unknown) => {
      if (!record(profile)) throw new Error("Invalid historical preset profile.");
      const { checkerProfile, ...current } = profile;
      if (checkerProfile !== undefined && value.vertical !== "software/coding")
        throw new Error("Historical checkerProfile mapping requires the software/coding vertical.");
      if (
        checkerProfile !== undefined &&
        checkerProfile !== "standard" &&
        checkerProfile !== "software-coding-standard"
      )
        throw new Error(`No completion migration mapping for checkerProfile ${String(checkerProfile)}.`);
      return current;
    }),
  };
  return converted;
}
