import { normalizeHistoricalVerticalDocument } from "@harness-anything/kernel";
import {
  decodeVerticalDefinition,
  isRetiredCodeDocRequirement,
  parseVerticalDeclarationDocument,
} from "@harness-anything/kernel";
import { isPresetResolutionRecord as record } from "./preset-resolver-common.ts";

// Frozen conversion of software-coding-standard, not the installed version's evolving defaults.
const standardCompletion = {
  sources: {
    "manual-attest": {
      kind: "manual",
      predicateType: "harness/attestation/v1",
      resultSchema: { type: "object", additionalProperties: false },
    },
  },
  gates: {},
  closeoutDefaults: { review: false, consent: false, factDisposition: false },
};

/** Explicit conversion only. Readers continue rejecting retired fields. */
export function convertCompletionDeclaration(value: unknown): unknown {
  if (!record(value)) throw new Error("Completion migration requires a JSON object.");
  const historical = normalizeHistoricalVerticalDocument(
    value.schema === "vertical-definition/v1" ? { definition: value } : value,
  ) as Record<string, unknown>;
  const current = value.schema === "vertical-definition/v1" ? historical.definition : historical;
  if (!record(current)) throw new Error("Completion migration requires a JSON object.");
  if (current.schema === "repository-vertical-declaration/v1") {
    const converted = { ...current, definition: convertCompletionDeclaration(current.definition) };
    parseVerticalDeclarationDocument(converted);
    return converted;
  }
  if (current.schema !== "vertical-definition/v1") throw new Error("Unsupported completion declaration schema.");
  const { checkerProfile, ...converted } = current;
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
      // Both hosted CI and code/doc requirements are retired; conversion drops each so the result
      // resolves without a gate that no longer exists.
      if (value.vertical === "software/coding" && Array.isArray(current.completionGates))
        current.completionGates = current.completionGates.filter(
          (gate) => gate !== "ci" && !isRetiredCodeDocRequirement(String(gate)),
        );
      // The same retirement removed `codeDoc` from the profile override vocabulary; an installed
      // object still carries it, so conversion removes the key instead of handing it to the reader.
      if (record(current.closeoutOverrides) && Object.hasOwn(current.closeoutOverrides, "codeDoc")) {
        const { codeDoc: _retired, ...overrides } = current.closeoutOverrides;
        if (Object.keys(overrides).length > 0) current.closeoutOverrides = overrides;
        else delete current.closeoutOverrides;
      }
      return current;
    }),
  };
  return converted;
}
