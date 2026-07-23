import {
  stablePayloadHash,
  stableStringify,
  type WriteOp
} from "@harness-anything/kernel";
import type { AuthorityFixedOperationBindingV1 } from "./types.ts";

interface FixedOperationBindingInput {
  readonly repoId: string;
  readonly workspaceId: string;
  readonly writerGeneration: number;
  readonly authorityGeneration: number;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly canonicalRequestEnvelope: string;
  readonly operation: WriteOp;
}

export function createAuthorityFixedOperationBindingV1(
  input: FixedOperationBindingInput
): AuthorityFixedOperationBindingV1 {
  const canonicalRequestEnvelopeDigest = stablePayloadHash(
    input.canonicalRequestEnvelope
  );
  const fixedAxes = {
    repoId: input.repoId,
    workspaceId: input.workspaceId,
    writerGeneration: input.writerGeneration,
    authorityGeneration: input.authorityGeneration,
    opId: input.opId,
    semanticDigest: input.semanticDigest,
    canonicalRequestEnvelopeDigest
  };
  return {
    schema: "authority-fixed-operation-binding/v1",
    ...fixedAxes,
    recordDigest: stablePayloadHash({
      schema: "authority-fixed-operation-record/v1",
      ...fixedAxes,
      operation: input.operation
    })
  };
}

export function authorityFixedOperationBindingMatchesV1(
  binding: AuthorityFixedOperationBindingV1,
  input: FixedOperationBindingInput
): boolean {
  return stableStringify(binding)
    === stableStringify(createAuthorityFixedOperationBindingV1(input));
}
