import type { VerticalCompletionDeclaration } from "../../src/domain/completion-source.ts";
import { effectiveCloseoutGates } from "../../src/domain/settings-closeout.ts";

export const completionSnapshot = {
  digest: `sha256:${"a".repeat(64)}`,
  completion: {
    sources: {
      "github-actions": { kind: "github-actions", predicateType: "ci/v1", resultSchema: { type: "object" } },
      "research/check": {
        kind: "command",
        entrypoint: "research/check",
        predicateType: "research/v1",
        resultSchema: { type: "object" },
      },
      "manual-attest": { kind: "manual", predicateType: "human/v1", resultSchema: { type: "object" } },
    },
    gates: {
      ci: { source: "github-actions", appliesTo: "code" },
      lint: { source: "research/check", appliesTo: "code" },
      signoff: { source: "manual-attest", appliesTo: "artifacts" },
      attest: { source: "manual-attest", appliesTo: "artifacts" },
      review: { source: "manual-attest", appliesTo: "artifacts" },
    },
    closeoutDefaults: {},
  } satisfies VerticalCompletionDeclaration,
};
export const emptyCompletionContract = {
  presetSnapshotDigest: completionSnapshot.digest,
  closeoutGates: effectiveCloseoutGates({}, []),
  gates: [],
};
