import {
  compileRegistryMutationPlan,
  type AuthorityOperationIntegrity,
  type createWritableEntityRegistry,
  type WriteOp
} from "@harness-anything/kernel";
import {
  actorAxesBindingDigestV2,
  sameProtocolSchemaTupleV2,
  type VerifiedActorAxesBindingV2
} from "./actor-axes-binding-v2.ts";
import {
  assertMutationClaimMatchesV2,
  assertStoragePlanMatchesMutationSetV2,
  semanticMutationSetDigestV2,
  SemanticAdmissionErrorV2,
  validateEnvelopeBindingV2,
  type SemanticMutationEnvelopeV2
} from "./semantic-mutation-envelope-v2.ts";
import { authorizeSemanticCompilationV2 } from "./semantic-authorizer-v2.ts";
import type { AuthoritySubmissionV2Options } from "./service-options.ts";
import {
  validateAuthorityTokenRefAndNamespaceV2,
  type AuthorityV2AdmissionMode
} from "./authority-recovery-submission-v2.ts";

export async function compileAuthorityV2Admission(input: {
  readonly envelope: SemanticMutationEnvelopeV2;
  readonly verified: VerifiedActorAxesBindingV2;
  readonly options: AuthoritySubmissionV2Options;
  readonly writableEntityRegistry: ReturnType<typeof createWritableEntityRegistry>;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly mode: AuthorityV2AdmissionMode;
}): Promise<{
  readonly operation: WriteOp;
  readonly authorityIntegrity: AuthorityOperationIntegrity;
  readonly publicationRevalidation?: () => Promise<void>;
}> {
  const { envelope, verified, options } = input;
  if (!sameProtocolSchemaTupleV2(envelope.schemaTuple, options.schemaTuple)) {
    throw new SemanticAdmissionErrorV2("ENVELOPE_SCHEMA_TUPLE_MISMATCH");
  }
  validateEnvelopeBindingV2(envelope, verified.token.claims);
  if (envelope.operationId.namespace.authorityGeneration
    !== verified.token.claims.authorityGeneration) {
    throw new SemanticAdmissionErrorV2("OP_NAMESPACE_AUTHORITY_GENERATION_MISMATCH");
  }
  await validateAuthorityTokenRefAndNamespaceV2({
    mode: input.mode,
    options,
    envelope
  });
  const semanticCompilation = await options.semanticCompiler.compile(envelope, {
    actor: {
      principal: { personId: verified.token.claims.principalPersonId },
      executor: verified.token.claims.executorAgentId
        ? { kind: "agent", id: verified.token.claims.executorAgentId }
        : null,
      responsibleHuman: `person:${verified.token.claims.principalPersonId}`
    },
    sessionId: verified.token.claims.sessionId,
    nowMs: input.mode === "outer-proceeding-recovery"
      ? verified.token.claims.issuedAt
      : options.bindingRuntime.nowMs()
  });
  const compilation = compileRegistryMutationPlan(
    input.writableEntityRegistry,
    semanticCompilation.mutationPlan
  );
  assertStoragePlanMatchesMutationSetV2(
    compilation.mutationSet,
    compilation.storagePlan
  );
  assertMutationClaimMatchesV2(envelope, compilation.mutationSet);
  authorizeSemanticCompilationV2(
    envelope,
    compilation.storagePlan.touchedPaths,
    semanticCompilation.decodedBytes,
    verified,
    options.matchEntityRefPrefix
  );
  const authorityIntegrity: AuthorityOperationIntegrity = {
    schema: "authority-operation-integrity/v2",
    semanticRequestDigest: input.semanticDigest,
    semanticMutationSetDigest: Buffer.from(
      semanticMutationSetDigestV2(compilation.mutationSet)
    ).toString("hex"),
    mutationRegistryVersion: compilation.mutationSet.registryVersion,
    actorAxesBindingDigest: Buffer.from(
      actorAxesBindingDigestV2(verified.token.claims)
    ).toString("hex"),
    canonicalMutationSet: compilation.mutationSet
  };
  return {
    operation: {
      ...semanticCompilation.operation,
      opId: input.opId,
      authorityIntegrity
    },
    authorityIntegrity,
    ...(semanticCompilation.publicationRevalidation
      ? { publicationRevalidation: semanticCompilation.publicationRevalidation }
      : {})
  };
}
