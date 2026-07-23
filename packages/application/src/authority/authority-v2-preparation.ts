import {
  createWritableEntityRegistry,
  stableStringify,
  type AuthorityOperationIntegrity,
  type WriteOp
} from "@harness-anything/kernel";
import {
  actorAxesBindingCoreFromVerifiedV2
} from "./committed-event-publication-v2.ts";
import {
  recoverKnownAuthorityOperationV2
} from "./authority-attribution-event-v2-operation-recovery.ts";
import {
  generationFencedReceipt,
  isDaemonGenerationFenced,
  rejectStaleGeneration
} from "./generation-fence-enforcement.ts";
import {
  indeterminate,
  rejected,
  terminal
} from "./receipt-builders.ts";
import {
  operationIdDiagnosticV2,
  semanticRequestDigestV2,
  SemanticAdmissionErrorV2,
  type SemanticMutationEnvelopeV2
} from "./semantic-mutation-envelope-v2.ts";
import {
  consumeAuthorityOperationForModeV2,
  type AuthorityV2AdmissionMode
} from "./authority-recovery-submission-v2.ts";
import { compileAuthorityV2Admission } from "./authority-v2-compilation.ts";
import { persistAuthorityIntentWhileGenerationCurrent } from "./intent-record-persistence.ts";
import type { createAuthorityOperationRecordPersistence } from "./operation-record-persistence.ts";
import type { AuthorityAdmission } from "./service-admission-types.ts";
import type { AuthoritySubmissionServiceOptions } from "./service-options.ts";
import type { VerifiedActorAxesBindingV2 } from "./actor-axes-binding-v2.ts";
import type { AuthorityRecoveryPublicationPolicyV1 } from "./types.ts";

type Persistence = ReturnType<typeof createAuthorityOperationRecordPersistence>;

export async function prepareAuthorityV2(input: {
  readonly envelope: SemanticMutationEnvelopeV2;
  readonly verified: VerifiedActorAxesBindingV2;
  readonly canonicalRequestEnvelope: string;
  readonly mode: AuthorityV2AdmissionMode;
  readonly options: AuthoritySubmissionServiceOptions;
  readonly writableEntityRegistry: ReturnType<typeof createWritableEntityRegistry>;
  readonly put: Persistence["put"];
  readonly persistTerminal: Persistence["persistTerminal"];
}): Promise<AuthorityAdmission> {
  const { envelope, verified, canonicalRequestEnvelope, mode, options } = input;
  const v2 = options.v2!;
  const opId = operationIdDiagnosticV2(envelope.operationId);
  const recordedProtocol = {
    kind: "semantic-mutation-envelope/v2" as const,
    schemaTuple: envelope.schemaTuple
  };
  const identity = { workspaceId: envelope.workspaceId, opId, recordedProtocol };
  const semanticDigest = Buffer.from(semanticRequestDigestV2(envelope)).toString("hex");
  const generationRejection = await rejectStaleGeneration(
    options.generationFenceWitness,
    identity,
    semanticDigest
  );
  if (generationRejection) return terminal(generationRejection);

  const known = await options.operationRegistry.get(envelope.workspaceId, opId);
  let fixedOperation: WriteOp | undefined;
  let computedIntegrity: AuthorityOperationIntegrity | undefined;
  let publicationRevalidation: (() => Promise<void>) | undefined;
  let recoveryPublicationPolicy: AuthorityRecoveryPublicationPolicyV1 | undefined;
  if (known) {
    if (known.semanticDigest !== semanticDigest) {
      return terminal(rejected(identity, semanticDigest, "OP_ID_REUSE"));
    }
    if (known.canonicalRequestEnvelope !== canonicalRequestEnvelope) {
      return terminal(rejected(identity, semanticDigest, "OP_ID_CANONICAL_ENVELOPE_MISMATCH"));
    }
    if (v2.recoverCommittedReceipt
      && (known.state === "INDEXED" || known.state === "INDETERMINATE")
      && known.recordedProtocol?.kind === "semantic-mutation-envelope/v2") {
      const recover = () => recoverKnownAuthorityOperationV2({
        known,
        semanticDigest,
        canonicalRequestEnvelope,
        verified,
        recover: v2.recoverCommittedReceipt!,
        ...(options.generationFenceWitness ? {
          assertCurrent: () => options.generationFenceWitness!.assertHeld(
            "before-terminal-journal",
            identity
          )
        } : {}),
        persist: (receipt) => input.put(
          identity,
          semanticDigest,
          "COMMITTED",
          receipt,
          known.commitSha,
          known.authorityIntegrity,
          known.canonicalRequestEnvelope,
          known.canonicalOperation,
          known.recoveryPublicationPolicy
        )
      });
      try {
        const recovered = options.generationFenceWitness
          ? await options.generationFenceWitness.runExclusive(
            "before-terminal-journal",
            identity,
            recover
          )
          : await recover();
        if (recovered) return terminal(recovered);
      } catch (error) {
        if (!isDaemonGenerationFenced(error)) throw error;
        return terminal(generationFencedReceipt(identity, semanticDigest, error));
      }
    }
    if (known.receipt) return terminal(known.receipt);
    if (mode !== "outer-proceeding-recovery"
      || (known.state !== "RECEIVED" && known.state !== "PREPARED")) {
      return terminal(indeterminate(identity, semanticDigest, `operation remains ${known.state}`));
    }
    if (!known.canonicalOperation || !known.authorityIntegrity) {
      return terminal(await input.persistTerminal(
        identity,
        semanticDigest,
        "INDETERMINATE",
        indeterminate(identity, semanticDigest, "AUTHORITY_RECOVERY_FIXED_OPERATION_MISSING"),
        known.authorityIntegrity,
        canonicalRequestEnvelope,
        known.canonicalOperation,
        known.recoveryPublicationPolicy
      ));
    }
    if (known.recoveryPublicationPolicy !== "EXACT_FIXED_OPERATION") {
      return terminal(indeterminate(
        identity,
        semanticDigest,
        "AUTHORITY_RECOVERY_PUBLICATION_REVALIDATION_UNAVAILABLE"
      ));
    }
    if (known.canonicalOperation.opId !== opId
      || known.authorityIntegrity.semanticRequestDigest !== semanticDigest
      || stableStringify(known.canonicalOperation.authorityIntegrity)
        !== stableStringify(known.authorityIntegrity)) {
      return terminal(indeterminate(
        identity,
        semanticDigest,
        "AUTHORITY_RECOVERY_FIXED_OPERATION_MISMATCH"
      ));
    }
    fixedOperation = known.canonicalOperation;
    computedIntegrity = known.authorityIntegrity;
    recoveryPublicationPolicy = known.recoveryPublicationPolicy;
  }

  try {
    if (!fixedOperation) {
      const compilation = await compileAuthorityV2Admission({
        envelope,
        verified,
        options: v2,
        writableEntityRegistry: input.writableEntityRegistry,
        opId,
        semanticDigest,
        mode
      });
      fixedOperation = compilation.operation;
      computedIntegrity = compilation.authorityIntegrity;
      publicationRevalidation = compilation.publicationRevalidation;
      recoveryPublicationPolicy = publicationRevalidation
        ? "REVALIDATION_REQUIRED"
        : "EXACT_FIXED_OPERATION";
      const intentRejection = await persistAuthorityIntentWhileGenerationCurrent({
        generationFence: options.generationFenceWitness,
        identity,
        persist: () => input.put(
          identity,
          semanticDigest,
          "RECEIVED",
          undefined,
          undefined,
          computedIntegrity,
          canonicalRequestEnvelope,
          fixedOperation,
          recoveryPublicationPolicy
        )
      });
      if (intentRejection) {
        return terminal(generationFencedReceipt(identity, semanticDigest, intentRejection));
      }
    }
    try {
      await options.fenceWitness.assertHeld("before-prepare", identity);
    } catch (error) {
      return terminal(await input.persistTerminal(
        identity,
        semanticDigest,
        "INDETERMINATE",
        indeterminate(identity, semanticDigest, `AUTHORITY_FENCE_LOST:${describe(error)}`),
        computedIntegrity,
        canonicalRequestEnvelope,
        fixedOperation,
        recoveryPublicationPolicy
      ));
    }
    await consumeAuthorityOperationForModeV2({ mode, verified, opId, options: v2 });
    const coordinator = options.coordinatorFactory.create({
      attribution: verified.attribution,
      sessionId: verified.token.claims.sessionId
    });
    return {
      kind: "prepared",
      workspaceId: envelope.workspaceId,
      opId,
      operation: fixedOperation,
      semanticDigest,
      coordinator,
      authorityIntegrity: computedIntegrity,
      actorAxesBinding: actorAxesBindingCoreFromVerifiedV2(verified),
      canonicalRequestEnvelope,
      recoveryPublicationPolicy,
      ...(mode === "outer-proceeding-recovery"
        ? { recoveryMode: "outer-proceeding" as const }
        : {}),
      ...(publicationRevalidation ? { publicationRevalidation } : {}),
      recordedProtocol
    };
  } catch (error) {
    const reason = error instanceof SemanticAdmissionErrorV2
      ? error.code
      : `ADMISSION_REJECTED:${describe(error)}`;
    return terminal(await input.persistTerminal(
      identity,
      semanticDigest,
      "REJECTED",
      rejected(identity, semanticDigest, reason),
      computedIntegrity,
      canonicalRequestEnvelope,
      fixedOperation,
      recoveryPublicationPolicy
    ));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
